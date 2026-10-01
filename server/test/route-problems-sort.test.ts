import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';

/**
 * issue #38：题目管理页的排序。
 *
 * 页面是**服务端分页**（GET /api/problems/page，前端只持有当前页 50 行），
 * 所以排序必须下推到 SQL 的 ORDER BY —— 只排当前页是错的。
 * 本文件按 HTTP 契约断言：sort/order 参数、白名单回退、自然序、NULL 排最后、跨页一致。
 */

// ---------- 测试脚手架 ----------

async function withApp(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

function problemsApp(db: Db): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/problems', problemsRoutes(db));
  return app;
}

/** 造一行题目，返回 id（title/difficulty 可控） */
function seedProblem(
  db: Db,
  platform: string,
  key: string,
  opts: { title?: string; difficulty?: number | null } = {},
): number {
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, tags, difficulty_source)
     VALUES (?, ?, ?, ?, '[]', 'sync')`,
  ).run(platform, key, opts.title ?? `${key} 标题`, opts.difficulty ?? null);
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

function seedSubmission(
  db: Db,
  platform: string,
  problemId: number,
  verdict: string,
  submittedAt: string,
  externalId: string,
): void {
  db.prepare(
    'INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id) VALUES (1, ?, ?, ?, ?, ?)',
  ).run(platform, problemId, verdict, submittedAt, externalId);
}

interface PageBody {
  items: Array<{
    id: number;
    problem_key: string;
    title: string;
    difficulty: number | null;
    attempts: number;
    ac_count: number;
    last_ac_at: string | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** 取一页（默认 bank=1：不要求有提交记录，纯题库排序） */
async function page(base: string, qs: string): Promise<PageBody> {
  const res = await fetch(`${base}/api/problems/page?bank=1&${qs}`);
  assert.equal(res.status, 200);
  return (await res.json()) as PageBody;
}

const keysOf = (body: PageBody): string[] => body.items.map((r) => r.problem_key);
const idsOf = (body: PageBody): number[] => body.items.map((r) => r.id);

// ---------- A. 题号：自然序 ----------

test('sort=problem_key：题号按自然序（先长度再字典序），P2 排在 P1001 前面', async () => {
  const db = createDb(':memory:');
  for (const k of ['P1001', 'P2', 'P100', 'P1', 'P10']) seedProblem(db, 'luogu', k);
  await withApp(problemsApp(db), async (base) => {
    assert.deepEqual(keysOf(await page(base, 'sort=problem_key&order=asc')), ['P1', 'P2', 'P10', 'P100', 'P1001']);
    assert.deepEqual(keysOf(await page(base, 'sort=problem_key&order=desc')), ['P1001', 'P100', 'P10', 'P2', 'P1']);
  });
  db.close();
});

test('sort=problem_key 是全量排序：跨页拼起来恰好是全局有序，无重复无遗漏', async () => {
  const db = createDb(':memory:');
  const all = ['P1001', 'P2', 'P100', 'P1', 'P10'];
  for (const k of all) seedProblem(db, 'luogu', k);
  await withApp(problemsApp(db), async (base) => {
    const p1 = await page(base, 'sort=problem_key&order=asc&pageSize=2&page=1');
    const p2 = await page(base, 'sort=problem_key&order=asc&pageSize=2&page=2');
    const p3 = await page(base, 'sort=problem_key&order=asc&pageSize=2&page=3');
    assert.equal(p1.total, 5);
    assert.equal(p1.hasMore, true);
    assert.equal(p3.hasMore, false);
    assert.deepEqual([...keysOf(p1), ...keysOf(p2), ...keysOf(p3)], ['P1', 'P2', 'P10', 'P100', 'P1001']);
  });
  db.close();
});

test('排序键相同时用 id 兜底：同难度多行跨页不重复、不丢行', async () => {
  const db = createDb(':memory:');
  const ids: number[] = [];
  for (const k of ['P1', 'P2', 'P3', 'P4', 'P5']) ids.push(seedProblem(db, 'luogu', k, { difficulty: 1500 }));
  await withApp(problemsApp(db), async (base) => {
    const seen: number[] = [];
    for (const p of [1, 2, 3]) {
      const body = await page(base, `sort=difficulty&order=asc&pageSize=2&page=${p}`);
      seen.push(...idsOf(body));
    }
    assert.deepEqual([...seen].sort((a, b) => a - b), [...ids].sort((a, b) => a - b), '每行恰好出现一次');
  });
  db.close();
});

// ---------- B. 难度：NULL 恒排最后 ----------

test('sort=difficulty：升/降序都让未知难度（NULL）排在最后', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P1500', { difficulty: 1500 });
  const nullA = seedProblem(db, 'luogu', 'PNULL1', { difficulty: null });
  seedProblem(db, 'luogu', 'P1200', { difficulty: 1200 });
  const nullB = seedProblem(db, 'luogu', 'PNULL2', { difficulty: null });
  seedProblem(db, 'luogu', 'P2000', { difficulty: 2000 });
  await withApp(problemsApp(db), async (base) => {
    const asc = await page(base, 'sort=difficulty&order=asc');
    assert.deepEqual(asc.items.map((r) => r.difficulty), [1200, 1500, 2000, null, null]);
    assert.deepEqual(idsOf(asc).slice(3).sort((a, b) => a - b), [nullA, nullB].sort((a, b) => a - b));

    const desc = await page(base, 'sort=difficulty&order=desc');
    assert.deepEqual(desc.items.map((r) => r.difficulty), [2000, 1500, 1200, null, null]);
    assert.deepEqual(idsOf(desc).slice(3).sort((a, b) => a - b), [nullA, nullB].sort((a, b) => a - b));
  });
  db.close();
});

// ---------- C. 标题：ASCII 大小写不敏感 ----------

test('sort=title：按标题排序，ASCII 大小写不敏感（COLLATE NOCASE）', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P1', { title: 'banana' });
  seedProblem(db, 'luogu', 'P2', { title: 'Apple' });
  seedProblem(db, 'luogu', 'P3', { title: 'cherry' });
  await withApp(problemsApp(db), async (base) => {
    assert.deepEqual((await page(base, 'sort=title&order=asc')).items.map((r) => r.title), ['Apple', 'banana', 'cherry']);
    assert.deepEqual((await page(base, 'sort=title&order=desc')).items.map((r) => r.title), ['cherry', 'banana', 'Apple']);
  });
  db.close();
});

// ---------- D. 提交次数 / AC 数 / 最近 AC 时间（聚合列） ----------

test('sort=attempts/ac_count/last_ac_at：按聚合列排序，最近 AC 缺失（NULL）排最后', async () => {
  const db = createDb(':memory:');
  const a = seedProblem(db, 'luogu', 'P1');
  const b = seedProblem(db, 'luogu', 'P2');
  const c = seedProblem(db, 'luogu', 'P3'); // 无提交
  seedSubmission(db, 'luogu', a, 'AC', '2024-01-01T00:00:00.000Z', 's1');
  seedSubmission(db, 'luogu', a, 'WA', '2024-01-02T00:00:00.000Z', 's2');
  seedSubmission(db, 'luogu', a, 'WA', '2024-01-03T00:00:00.000Z', 's3');
  seedSubmission(db, 'luogu', b, 'AC', '2024-03-01T00:00:00.000Z', 's4');
  await withApp(problemsApp(db), async (base) => {
    const asc = await page(base, 'sort=attempts&order=asc');
    assert.deepEqual(asc.items.map((r) => r.attempts), [0, 1, 3]);
    assert.deepEqual(idsOf(asc), [c, b, a]);

    const desc = await page(base, 'sort=attempts&order=desc');
    assert.deepEqual(idsOf(desc), [a, b, c]);

    const acAsc = await page(base, 'sort=ac_count&order=asc');
    assert.deepEqual(acAsc.items.map((r) => r.ac_count), [0, 1, 1]);
    assert.equal(idsOf(acAsc)[0], c);

    const lastDesc = await page(base, 'sort=last_ac_at&order=desc');
    assert.deepEqual(idsOf(lastDesc), [b, a, c]);
    const lastAsc = await page(base, 'sort=last_ac_at&order=asc');
    assert.deepEqual(idsOf(lastAsc), [a, b, c], '无 AC 记录的题（NULL）恒在最后');

    // 排序不影响总数
    assert.equal(lastAsc.total, 3);
  });
  db.close();
});

// ---------- E. 非法参数：整组忽略，回退默认顺序 ----------

test('默认（不传 sort）：顺序与改动前逐字一致（难度降序，未知最后）', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P1200', { difficulty: 1200 });
  seedProblem(db, 'luogu', 'PNULL', { difficulty: null });
  seedProblem(db, 'luogu', 'P2000', { difficulty: 2000 });
  await withApp(problemsApp(db), async (base) => {
    assert.deepEqual(keysOf(await page(base, '')), ['P2000', 'P1200', 'PNULL']);
    assert.deepEqual(keysOf(await page(base, 'pageSize=50')), ['P2000', 'P1200', 'PNULL']);
  });
  db.close();
});

test('非法 sort/order 一律忽略并回退默认顺序（含注入尝试，绝不拼进 SQL）', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P1200', { difficulty: 1200 });
  seedProblem(db, 'luogu', 'PNULL', { difficulty: null });
  seedProblem(db, 'luogu', 'P2000', { difficulty: 2000 });
  const expected = ['P2000', 'P1200', 'PNULL'];
  await withApp(problemsApp(db), async (base) => {
    const cases = [
      'sort=nope&order=asc',
      'sort=title&order=sideways',
      'sort=title&order=',
      'sort=title', // 缺 order：整组忽略（前端两者总是成对下发）
      'sort=constructor&order=asc', // 原型链上的键不能当白名单命中
      'sort=__proto__&order=asc',
      'sort=title%3BDROP%20TABLE%20problems--&order=asc',
      `sort=${encodeURIComponent("title' OR 1=1 --")}&order=asc`,
      'sort=title&order=asc%20--%20',
      'sort=p.id&order=asc',
    ];
    for (const qs of cases) {
      assert.deepEqual(keysOf(await page(base, qs)), expected, `非法参数应回退默认顺序：${qs}`);
    }
    // 注入尝试后表还在、行数不变
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c, 3);
  });
  db.close();
});

// ---------- F. 与既有过滤/分页组合 ----------

test('排序与平台过滤、状态过滤、分页可组合', async () => {
  const db = createDb(':memory:');
  const l1 = seedProblem(db, 'luogu', 'P1', { difficulty: 1500 });
  seedProblem(db, 'luogu', 'P2', { difficulty: 1500 });
  const cf1 = seedProblem(db, 'codeforces', '1A', { difficulty: 1500 });
  seedSubmission(db, 'luogu', l1, 'AC', '2024-01-01T00:00:00.000Z', 's1');
  seedSubmission(db, 'codeforces', cf1, 'WA', '2024-01-01T00:00:00.000Z', 's2');
  await withApp(problemsApp(db), async (base) => {
    const luogu = await page(base, 'platform=luogu&sort=problem_key&order=asc');
    assert.deepEqual(keysOf(luogu), ['P1', 'P2']);
    assert.equal(luogu.total, 2);

    const tried = await page(base, 'status=tried&sort=problem_key&order=asc');
    assert.deepEqual(keysOf(tried), ['1A'], '状态过滤（已尝试未 AC）与排序同时生效');
  });
  db.close();
});

test('分页参数非法时仍按默认页码/页长返回（排序不改变既有钳制行为）', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P1', { difficulty: 1500 });
  await withApp(problemsApp(db), async (base) => {
    const body = await page(base, 'sort=problem_key&order=asc&page=0&pageSize=abc');
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 50);
  });
  db.close();
});
