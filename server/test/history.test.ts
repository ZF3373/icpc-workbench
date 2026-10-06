import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { historyRoutes } from '../src/routes/history.ts';

interface HistoryResp {
  view: string;
  items: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  platforms: Array<{ platform: string; platformName: string; submissions: number; problems: number }>;
}

function seed(
  db: Db,
  platform: string,
  key: string,
  title: string,
  verdict: string,
  submittedAt: string,
  externalId: string,
): void {
  const found = db
    .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
    .get(platform, key) as { id: number } | undefined;
  const pid = found?.id ?? Number(
    db
      .prepare('INSERT INTO problems (platform, problem_key, title) VALUES (?, ?, ?)')
      .run(platform, key, title).lastInsertRowid,
  );
  db.prepare(
    'INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id) VALUES (1, ?, ?, ?, ?, ?)',
  ).run(platform, pid, verdict, submittedAt, externalId);
}

async function withServer<T>(db: Db, run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use('/api/history', historyRoutes(db));
  const srv = await listenForTest(app);
  try {
    return await run(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/history`);
  } finally {
    srv.close();
  }
}

function seededDb(): Db {
  const db = createDb(':memory:');
  seed(db, 'luogu', 'P1001', '简单题一', 'AC', '2026-09-10T08:00:00.000Z', 'l1');
  seed(db, 'luogu', 'P1001', '简单题一', 'WA', '2026-09-09T08:00:00.000Z', 'l0');
  seed(db, 'codeforces', '1919C', ' bfs 论文题', 'AC', '2026-09-11T08:00:00.000Z', 'c1');
  seed(db, 'atcoder', 'abc321_a', 'AtCoder 题', 'TLE', '2026-08-01T08:00:00.000Z', 'a1');
  return db;
}

test('GET /api/history/submissions 默认按题聚合：新→旧 + 平台计数', async (t) => {
  const db = seededDb();
  t.after(() => db.close());
  await withServer(db, async (base) => {
    const res = await (await fetch(`${base}/submissions`)).json() as HistoryResp;
    assert.equal(res.view, 'problem');
    assert.equal(res.total, 3); // 3 道题（P1001 两次提交聚合为一条）
    assert.equal(res.items.length, 3);
    assert.equal(res.items[0].problemKey, '1919C'); // 最新提交 09-11
    assert.equal(res.items[0].acCount, 1);
    assert.equal(res.items[1].problemKey, 'P1001');
    assert.equal(res.items[1].attempts, 2);
    assert.equal(res.items[1].lastSubmittedAt, '2026-09-10T08:00:00.000Z');
    assert.deepEqual(
      res.platforms.map((p) => [p.platform, p.submissions, p.problems]),
      [['luogu', 2, 1], ['atcoder', 1, 1], ['codeforces', 1, 1]],
    );
    assert.equal(res.platforms[0].platformName, '洛谷');
  });
});

test('过滤：platform / result / 时间窗 / 关键词', async (t) => {
  const db = seededDb();
  t.after(() => db.close());
  await withServer(db, async (base) => {
    const q = async (qs: string) =>
      (await (await fetch(`${base}/submissions?${qs}`)).json()) as HistoryResp;

    assert.equal((await q('platform=luogu')).total, 1);
    assert.equal((await q('platform=nope')).total, 3); // 非法 platform 忽略而非报错
    assert.equal((await q('result=failed&view=submission')).total, 2); // WA + TLE
    assert.equal((await q('result=ac')).total, 2); // AC 的题：P1001、1919C
    assert.equal((await q('from=2026-09-10&to=2026-09-10')).total, 1); // 闭区间当天
    assert.equal((await q('from=2026-09-10&to=2026-09-10'))
      .items[0].problemKey, 'P1001');
    assert.equal((await q('q=论文')).total, 1);
    assert.equal((await q('q=1919')).total, 1);
    // 关键词字面量匹配：'%' 不当通配符（无题目含字面 %）
    assert.equal((await q('q=%')).total, 0);
    // 组合条件
    assert.equal((await q('platform=luogu&result=failed&view=submission')).total, 1);
  });
});

test('problem 视图 result 过滤走 HAVING：计数不被结果过滤切片', async (t) => {
  const db = seededDb();
  t.after(() => db.close());
  await withServer(db, async (base) => {
    const q = async (qs: string) =>
      (await (await fetch(`${base}/submissions?${qs}`)).json()) as HistoryResp;

    // P1001 共 2 次提交（1 AC + 1 WA）：筛「AC」后仍应显示 2/1，而不是误导性的 1/1
    const ac = await q('result=ac');
    const p1001 = ac.items.find((i) => i.problemKey === 'P1001');
    assert.deepEqual([p1001!.attempts, p1001!.acCount], [2, 1]);

    // 「未通过」= 窗口内一次都没 AC 的题（abc321_a 只有 TLE）
    const failed = await q('result=failed');
    assert.deepEqual(failed.items.map((i) => i.problemKey), ['abc321_a']);
    // 平台聚合与列表同口径
    assert.equal(failed.total, 1);
    assert.deepEqual(failed.platforms.map((p) => [p.platform, p.problems, p.submissions]), [['atcoder', 1, 1]]);
  });
});

test('时间界：接受完整 ISO 时刻；非法日期忽略而非 500', async (t) => {
  const db = seededDb();
  t.after(() => db.close());
  await withServer(db, async (base) => {
    // 前端按本地日界下发时刻：from 含、to 不含
    const from = (await (await fetch(`${base}/submissions?from=2026-09-10T00:00:00.000Z`)).json()) as HistoryResp;
    assert.deepEqual(from.items.map((i) => i.problemKey).sort(), ['1919C', 'P1001']);
    const to = (await (await fetch(`${base}/submissions?to=2026-09-10T08:00:00.000Z`)).json()) as HistoryResp;
    assert.deepEqual(to.items.map((i) => i.problemKey).sort(), ['P1001', 'abc321_a']);

    // 过正则但不存在的日历日：静默忽略该条件，不得抛 RangeError → 500
    const bad = await fetch(`${base}/submissions?to=2026-13-45`);
    assert.equal(bad.status, 200);
    assert.equal(((await bad.json()) as HistoryResp).total, 3);
    const badFrom = await fetch(`${base}/submissions?from=2026-02-30T00:00:00.000Z`);
    assert.equal(((await badFrom.json()) as HistoryResp).total, 3);
  });
});

test('「未通过」的口径包含 SKIPPED（跳过/未评测），钉住这一语义', async (t) => {
  const db = createDb(':memory:');
  t.after(() => db.close());
  seed(db, 'luogu', 'P2000', '跳过的题', 'SKIPPED', '2026-09-12T08:00:00.000Z', 'sk1');
  await withServer(db, async (base) => {
    const q = async (qs: string) =>
      (await (await fetch(`${base}/submissions?${qs}`)).json()) as HistoryResp;
    // 判定基于「有没有 AC」而非「verdict 是不是失败类」，因此 SKIPPED 归入未通过
    assert.deepEqual((await q('result=failed')).items.map((i) => i.problemKey), ['P2000']);
    assert.equal((await q('result=failed&view=submission')).total, 1);
    assert.equal((await q('result=ac')).total, 0);
  });
});

test('view=submission 逐条流水 + 分页', async (t) => {
  const db = seededDb();
  t.after(() => db.close());
  await withServer(db, async (base) => {
    const res = await (await fetch(`${base}/submissions?view=submission&pageSize=2`)).json() as HistoryResp;
    assert.equal(res.total, 4);
    assert.equal(res.items.length, 2);
    assert.equal(res.hasMore, true);
    assert.equal(res.items[0].verdict, 'AC');
    assert.equal(res.items[0].problemKey, '1919C');
    const page2 = await (await fetch(`${base}/submissions?view=submission&pageSize=2&page=2`)).json() as HistoryResp;
    assert.equal(page2.items.length, 2);
    assert.equal(page2.hasMore, false);
    assert.notEqual(page2.items[0].id, res.items[0].id);
  });
});

test('行内附带 tags 与卡点聚合（数据概览「卡在哪」入口依赖这两个字段）', async (t) => {
  const db = seededDb();
  t.after(() => db.close());
  // 给 1919C 记两条卡点：upsolved(0.45) + wrong_approach(0.7) → 最差 upsolved，共 2 条
  const pid = (db
    .prepare("SELECT id FROM problems WHERE platform = 'codeforces' AND problem_key = '1919C'")
    .get() as { id: number }).id;
  const ins = db.prepare('INSERT INTO submission_intents (user_id, problem_id, outcome) VALUES (1, ?, ?)');
  ins.run(pid, 'wrong_approach');
  ins.run(pid, 'upsolved');
  db.prepare("UPDATE problems SET tags = ? WHERE platform = 'luogu' AND problem_key = 'P1001'")
    .run(JSON.stringify(['贪心', '数学（综合）']));

  await withServer(db, async (base) => {
    const q = async (qs: string) =>
      (await (await fetch(`${base}/submissions?${qs}`)).json()) as HistoryResp;

    const problem = await q('');
    const c = problem.items.find((i) => i.problemKey === '1919C');
    assert.equal(c!.intentCount, 2);
    assert.equal(c!.worstIntent, 'upsolved', '最差卡点按 intentFactor 最小选取（与题目管理页同口径）');
    const p = problem.items.find((i) => i.problemKey === 'P1001');
    assert.equal(p!.intentCount, 0, '没记过的题计数为 0');
    assert.equal(p!.worstIntent, null);
    assert.deepEqual(p!.tags, ['贪心', '数学（综合）'], 'tags 随行下发（「卡在哪」的知识点候选）');

    const sub = await q('view=submission');
    const sc = sub.items.find((i) => i.problemKey === '1919C');
    assert.equal(sc!.intentCount, 2);
    assert.equal(sc!.worstIntent, 'upsolved');
    assert.equal(sc!.acCount, 1, '逐条视图带该题 AC 总数（操作列据此决定是否显示「标记 AC」）');
    const sa = sub.items.find((i) => i.problemKey === 'abc321_a');
    assert.equal(sa!.intentCount, 0);
    assert.equal(sa!.worstIntent, null);
  });
});
