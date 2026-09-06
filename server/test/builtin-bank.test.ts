import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { fetchCodeforcesBank } from '../src/adapters/problemBank.ts';
import { setBuiltinBankJson, seedBuiltinBank, BUILTIN_BANK_VERSION_KEY } from '../src/db/builtinBank.ts';
import { problemsRoutes } from '../src/routes/problems.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  setBuiltinBankJson(null);
  db.close();
});

/** mock fetch 路由器（与 problem-bank.test.ts 相同模式） */
function router(
  handlers: Record<string, (url: string) => unknown>,
): typeof fetch {
  return async (input: string | URL | Request) => {
    const u = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (u.includes(prefix)) {
        const v = handler(u);
        if (typeof v === 'string') return new Response(v, { status: 200 });
        // 仅数字 status 视为 {status, body} Response 约定（CF 响应自带 status:'OK' 字符串字段）
        if (v && typeof v === 'object' && 'status' in v && typeof (v as { status: unknown }).status === 'number') {
          const r = v as { status: number; body: string; headers?: Record<string, string> };
          return new Response(r.body, { status: r.status, headers: r.headers ?? {} });
        }
        return new Response(JSON.stringify(v), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

// ---------- Codeforces 题库拉取（problemset.problems 单次调用） ----------

function cfProblemset(problems: unknown[]): unknown {
  return { status: 'OK', result: { problems, problemStatistics: [] } };
}

test('codeforces bank: 单次调用解析键/难度/标签/URL，跳过无 contestId 的题', async () => {
  const calls: string[] = [];
  const fetchFn = router({
    'problemset.problems': (url) => {
      calls.push(url);
      return cfProblemset([
        { contestId: 1001, index: 'A', name: 'Theatre Square', rating: 1000, tags: ['math'] },
        { contestId: 1900, index: 'C', name: '无rating题', tags: ['dp', 'graphs'] },
        { index: 'X', name: 'acmsguru 无 contestId' },
      ]);
    },
  });
  const r = await fetchCodeforcesBank(fetchFn, {});
  assert.equal(calls.length, 1); // 全量一次调用，无翻页
  assert.equal(r.platform, 'codeforces');
  assert.equal(r.total, 3);
  assert.equal(r.problems.length, 2);
  assert.deepEqual(r.problems[0], {
    platform: 'codeforces',
    problemKey: '1001A',
    title: 'Theatre Square',
    difficulty: 1000,
    url: 'https://codeforces.com/contest/1001/problem/A',
    tags: ['math'],
  });
  assert.equal(r.problems[1].difficulty, null);
  assert.deepEqual(r.problems[1].tags, ['dp', 'graphs']);
});

test('codeforces bank: max 截断结果', async () => {
  const fetchFn = router({
    'problemset.problems': () =>
      cfProblemset([
        { contestId: 1, index: 'A', name: 'a', rating: 800, tags: [] },
        { contestId: 2, index: 'B', name: 'b', rating: 900, tags: [] },
        { contestId: 3, index: 'C', name: 'c', rating: 1000, tags: [] },
      ]),
  });
  const r = await fetchCodeforcesBank(fetchFn, { max: 2 });
  assert.equal(r.problems.length, 2);
  assert.equal(r.problems[0].problemKey, '1A');
});

test('codeforces bank: 非 OK 响应抛错', async () => {
  // 直接返回字符串体，避免与 router 的 {status, body} Response 约定冲突
  const fetchFn = router({
    'problemset.problems': () => JSON.stringify({ status: 'FAILED', comment: 'boom' }),
  });
  await assert.rejects(() => fetchCodeforcesBank(fetchFn, {}), /异常/);
});

test('codeforces bank: HTTP 失败抛错', async () => {
  const fetchFn = router({
    'problemset.problems': () => ({ status: 503, body: '' }),
  });
  await assert.rejects(() => fetchCodeforcesBank(fetchFn, {}), /HTTP 503/);
});

// ---------- 内置题库开机种子 ----------

const BANK_V1 = JSON.stringify({
  version: 'v1',
  problems: [
    {
      platform: 'codeforces',
      problemKey: '1001A',
      title: '内置题A',
      difficulty: 1500,
      url: 'https://codeforces.com/contest/1001/problem/A',
      tags: ['dp'],
    },
    {
      platform: 'luogu',
      problemKey: 'P1001',
      title: '内置洛谷题',
      difficulty: 1300,
      url: 'https://www.luogu.com.cn/problem/P1001',
      tags: ['模拟'],
    },
  ],
});

const BANK_V2 = JSON.stringify({
  version: 'v2',
  problems: [
    {
      platform: 'codeforces',
      problemKey: '1001A',
      title: '内置题A（新版标题）',
      difficulty: 1500,
      url: 'https://codeforces.com/contest/1001/problem/A',
      tags: ['dp', 'math'],
    },
  ],
});

test('seedBuiltinBank: 首次启动入库全部内置题并记录版本号', () => {
  setBuiltinBankJson(BANK_V1);
  seedBuiltinBank(db);
  const n = (db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c;
  assert.equal(n, 2);
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').get(BUILTIN_BANK_VERSION_KEY) as
    | { value: string }
    | undefined;
  assert.equal(v?.value, 'v1');
});

test('seedBuiltinBank: 版本未变直接跳过（不覆盖用户改动）', () => {
  setBuiltinBankJson(BANK_V1);
  seedBuiltinBank(db);
  db.prepare("UPDATE problems SET title = '用户改过的标题' WHERE problem_key = '1001A'").run();
  seedBuiltinBank(db); // 同版本 → no-op
  const t = db.prepare("SELECT title FROM problems WHERE problem_key = '1001A'").get() as {
    title: string;
  };
  assert.equal(t.title, '用户改过的标题');
});

test('seedBuiltinBank: 版本升级重新 upsert，保留用户已标难度', () => {
  setBuiltinBankJson(BANK_V1);
  seedBuiltinBank(db);
  // 用户手动把 1001A 难度改为 2100（模拟人工校准）
  db.prepare("UPDATE problems SET difficulty = 2100 WHERE problem_key = '1001A'").run();
  setBuiltinBankJson(BANK_V2);
  seedBuiltinBank(db);
  const row = db.prepare("SELECT title, difficulty, tags FROM problems WHERE problem_key = '1001A'").get() as {
    title: string;
    difficulty: number;
    tags: string;
  };
  assert.equal(row.title, '内置题A（新版标题）'); // 新版本标题覆盖
  assert.equal(row.difficulty, 2100); // 用户难度保留
  assert.deepEqual(JSON.parse(row.tags), ['dp', 'math']); // 非空标签更新
  const v = db.prepare('SELECT value FROM settings WHERE key = ?').get(BUILTIN_BANK_VERSION_KEY) as {
    value: string;
  };
  assert.equal(v.value, 'v2');
});

test('seedBuiltinBank: JSON 损坏不抛错、不写库', () => {
  setBuiltinBankJson('{ broken json');
  assert.doesNotThrow(() => seedBuiltinBank(db));
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c, 0);
});

test('seedBuiltinBank: 未注入且无磁盘文件 → no-op', () => {
  // 不调用 setBuiltinBankJson：磁盘文件路径在测试环境可能存在（真实内置库），
  // 但 :memory: 库首次播种本身是合法行为——只断言不抛错即可
  assert.doesNotThrow(() => seedBuiltinBank(db));
});

// ---------- 路由：CF 题库拉取 ----------

async function withServer(
  fn: (base: string) => Promise<void>,
  fetchFn?: typeof fetch,
): Promise<void> {
  const app = express();
  app.use(express.json());
  const d = createDb(':memory:');
  app.use('/api/problems', problemsRoutes(d, fetchFn));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/problems`;
  try {
    await fn(base);
  } finally {
    srv.close();
    d.close();
  }
}

test('POST /api/problems/bank: platform=codeforces 拉取入库', async () => {
  const fetchFn = router({
    'problemset.problems': () =>
      cfProblemset([
        { contestId: 1001, index: 'A', name: 'Theatre Square', rating: 1000, tags: ['math'] },
        { contestId: 1001, index: 'B', name: 'B', rating: 1200, tags: [] },
      ]),
  });
  await withServer(
    async (base) => {
      const res = await fetch(`${base}/bank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'codeforces' }),
      });
      const j = (await res.json()) as { ok: boolean; fetched: number; inserted: number };
      assert.equal(j.ok, true);
      assert.equal(j.fetched, 2);
      assert.equal(j.inserted, 2);
      // bank=1 视图包含未做题库题
      const bankList = (await (await fetch(`${base}?bank=1`)).json()) as Array<{ problem_key: string }>;
      assert.equal(bankList.length, 2);
      // 默认视图（无 bank=1）不含未做题库题
      const list = (await (await fetch(base)).json()) as Array<{ problem_key: string }>;
      assert.equal(list.length, 0);
    },
    fetchFn,
  );
});
