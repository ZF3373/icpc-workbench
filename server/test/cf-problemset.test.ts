import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import {
  cfContestProblems,
  lookupCfProblems,
  __resetCfProblemsetForTest,
} from '../src/contests/cfProblemset.ts';

/**
 * CF 题目集官方标签缓存（cfProblemset.ts）。
 *
 * 背景：contest.standings 只给未提交题题号/题名/难度，没有 tags；官方知识点
 * 来自 problemset.problems 全集 API（一次全量）。这里验证：
 *   · 首查阻塞拉取并落库（重启后从库表恢复，零请求）；
 *   · 缓存缺题（新比赛的题）触发一次强刷，刷到即返回；
 *   · 失败静默 + 退避（复盘路径不能逐请求重试外网）。
 */

const PROBLEMSET_BODY = {
  status: 'OK',
  result: {
    problems: [
      { contestId: 1877, index: 'A', name: 'Rabbits', rating: 800, tags: ['math', 'greedy'] },
      { contestId: 1877, index: 'B', name: 'Imbalanced Arrays', rating: 1600, tags: ['constructive algorithms'] },
      { contestId: 2100, index: 'A', name: 'Brand New Problem', rating: 1200, tags: ['brute force'] },
    ],
    problemStatistics: [
      { contestId: 1877, index: 'A', solvedCount: 21000 },
      { contestId: 1877, index: 'B', solvedCount: 3200 },
    ],
  },
};

function jsonFetch(routes: Record<string, unknown>): { fetchFn: typeof fetch; calls: () => number } {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const u = String(input);
    calls.push(u);
    for (const [needle, body] of Object.entries(routes)) {
      if (u.includes(needle)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls.length };
}

beforeEach(() => {
  __resetCfProblemsetForTest();
});

test('首查阻塞拉取全集并落库；同进程再查零请求；重启（新实例+库）后零请求', async () => {
  const db = createDb(':memory:');
  const { fetchFn, calls } = jsonFetch({ 'problemset.problems': PROBLEMSET_BODY });

  const out = await lookupCfProblems(db, ['1877A', '1877B'], fetchFn);
  assert.equal(out.get('1877A')?.tags.join(','), 'math,greedy');
  assert.equal(out.get('1877A')?.solvedCount, 21000);
  assert.equal(out.get('1877B')?.rating, 1600);
  assert.equal(calls(), 1);

  // 内存热：再查不发请求；不在题目集里的键直接缺席（调用方按拿不到就不写）
  const again = await lookupCfProblems(db, ['1877A', '9999X'], fetchFn);
  assert.equal(again.size, 1);
  assert.equal(calls(), 1);

  // 落库可查（模拟重启后从库表恢复）
  const row = db.prepare('SELECT payload FROM cf_problemset_cache WHERE id = 1').get() as { payload: string };
  assert.ok(JSON.parse(row.payload)['1877A']);
});

test('缓存缺题（新比赛刚结束）触发一次强刷，刷到即返回', async () => {
  const db = createDb(':memory:');
  // 预置一份"2 小时前的旧缓存"：只有 1877 的题，缺 2100A
  db.prepare('INSERT INTO cf_problemset_cache (id, fetched_at, payload) VALUES (1, ?, ?)').run(
    new Date(Date.now() - 2 * 3600_000).toISOString(),
    JSON.stringify({ '1877A': { tags: ['math'], rating: 800, solvedCount: 21000 } }),
  );
  const { fetchFn, calls } = jsonFetch({ 'problemset.problems': PROBLEMSET_BODY });

  const out = await lookupCfProblems(db, ['2100A'], fetchFn);
  assert.equal(out.get('2100A')?.tags.join(','), 'brute force', '缺题强刷后拿到新题');
  assert.equal(calls(), 1);
  // 强刷后缓存整体已更新：紧接的查询不再发请求
  await lookupCfProblems(db, ['1877A'], fetchFn);
  assert.equal(calls(), 1);
});

test('拉取失败静默（旧缓存照常可用）且 1h 退避，不逐请求重试外网', async () => {
  const db = createDb(':memory:');
  db.prepare('INSERT INTO cf_problemset_cache (id, fetched_at, payload) VALUES (1, ?, ?)').run(
    new Date(Date.now() - 2 * 3600_000).toISOString(),
    JSON.stringify({ '1877A': { tags: ['math'], rating: 800, solvedCount: 21000 } }),
  );
  const { fetchFn, calls } = jsonFetch({ 'problemset.problems': { status: 'FAILED', comment: 'internal error' } });

  // 旧缓存里的键照常返回；缺的键强刷失败后缺席
  const out = await lookupCfProblems(db, ["1877A", "2100A"], fetchFn);
  assert.ok(out.get('1877A'), '旧缓存不受失败影响');
  assert.equal(out.has('2100A'), false);

  // 退避期内：即使还缺题也不再发请求
  const again = await lookupCfProblems(db, ["2100A"], fetchFn);
  assert.equal(again.size, 0);
  assert.equal(calls(), 1);});

test('cfContestProblems：从题目集全集缓存反查某场题目（零额外请求），含题号/题名/难度', async () => {
  const db = createDb(':memory:');
  const { fetchFn, calls } = jsonFetch({ 'problemset.problems': PROBLEMSET_BODY });

  const refs = await cfContestProblems(db, '1877', fetchFn);
  assert.equal(calls(), 1, '首次需要拉一次全集（此后 24h 内复用）');
  assert.deepEqual(refs, [
    { id: '1877A', index: 'A', title: 'Rabbits', rating: 800 },
    { id: '1877B', index: 'B', title: 'Imbalanced Arrays', rating: 1600 },
  ]);

  // 命中缓存：再查零请求（这正是「CF 题目集不再依赖 contest.standings」的关键）
  const again = await cfContestProblems(db, '1877', fetchFn);
  assert.equal(calls(), 1, '命中缓存不发请求');
  assert.equal(again?.length, 2);

  // 题目集里没有的场次 → null，由调用方决定是否退化到 standings
  assert.equal(await cfContestProblems(db, '99999', fetchFn), null);
  assert.equal(await cfContestProblems(db, 'abc', fetchFn), null, '非数字 contestId 直接返回 null');
});

test('cfContestProblems：老格式缓存（缺 contestId 字段）触发一次强刷后即可用', async () => {
  const db = createDb(':memory:');
  db.prepare('INSERT INTO cf_problemset_cache (id, fetched_at, payload) VALUES (1, ?, ?)').run(
    new Date().toISOString(),
    JSON.stringify({ '1877A': { tags: ['math'], rating: 800, solvedCount: 21000 } }),
  );
  const { fetchFn, calls } = jsonFetch({ 'problemset.problems': PROBLEMSET_BODY });

  const refs = await cfContestProblems(db, '1877', fetchFn);
  assert.equal(calls(), 1, '老缓存没有比赛号字段，需要升级一次');
  assert.deepEqual(refs?.map((r) => r.id), ['1877A', '1877B']);
});
