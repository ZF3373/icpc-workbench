import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodeforcesAdapter } from '../src/adapters/codeforces.ts';

function cfRes(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
}

function submission(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    contestId: 1919,
    problem: {
      contestId: 1919,
      index: 'C',
      name: 'Grouping Increases',
      rating: 2000,
      tags: ['greedy', 'sortings'],
    },
    verdict: 'OK',
    programmingLanguage: 'GNU C++17',
    creationTimeSeconds: 1700000000,
    ...over,
  };
}

test('normalizes CF submission (OK -> AC, rating/tags/link)', async () => {
  const adapter = createCodeforcesAdapter(async () =>
    cfRes({ status: 'OK', result: [submission({})] }),
  );
  const rows = await adapter.fetchUserSubmissions('testuser');
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.verdict, 'AC');
  assert.equal(r.externalId, '1');
  assert.equal(r.problem.problemKey, '1919C');
  assert.equal(r.problem.difficulty, 2000);
  assert.deepEqual(r.problem.tags, ['greedy', 'sortings']);
  assert.equal(r.problem.url, 'https://codeforces.com/contest/1919/problem/C');
  assert.equal(new Date(r.submittedAt).toISOString(), new Date(1700000000 * 1000).toISOString());
});

test('maps non-AC verdicts and missing verdict', async () => {
  const adapter = createCodeforcesAdapter(async () =>
    cfRes({
      status: 'OK',
      result: [
        submission({ id: 2, verdict: 'WRONG_ANSWER' }),
        submission({ id: 3, verdict: 'TIME_LIMIT_EXCEEDED' }),
        submission({ id: 4, verdict: 'CHALLENGED' }),
        submission({ id: 5, verdict: undefined }),
      ],
    }),
  );
  const rows = await adapter.fetchUserSubmissions('u');
  assert.deepEqual(rows.map((r) => r.verdict), ['WA', 'TLE', 'SKIPPED', 'SKIPPED']);
});

test('gym contest uses gym link', async () => {
  const adapter = createCodeforcesAdapter(async () =>
    cfRes({ status: 'OK', result: [submission({ contestId: 100000, problem: { contestId: 100000, index: 'A', name: 'x' } })] }),
  );
  const rows = await adapter.fetchUserSubmissions('u');
  assert.equal(rows[0].problem.url, 'https://codeforces.com/gym/100000/problem/A');
  assert.equal(rows[0].problem.problemKey, '100000A');
});

test('pagination loops until page shorter than limit', async () => {
  let calls = 0;
  const adapter = createCodeforcesAdapter(async (input: string | URL | Request) => {
    calls += 1;
    const from = new URL(String(input)).searchParams.get('from');
    return cfRes({
      status: 'OK',
      result: from === '1'
        ? Array.from({ length: 1000 }, (_, i) => submission({ id: i + 1 }))
        : [submission({ id: 2000 })],
    });
  });
  const rows = await adapter.fetchUserSubmissions('u');
  assert.equal(calls, 2);
  assert.equal(rows.length, 1001);
});

test('throws on CF API failure', async () => {
  const adapter = createCodeforcesAdapter(async () => cfRes({ status: 'FAILED', comment: 'no such handle' }, true));
  await assert.rejects(() => adapter.fetchUserSubmissions('nope'), /no such handle/);
});

test('problemUrl splitKey behavior', () => {
  const adapter = createCodeforcesAdapter();
  assert.equal(adapter.problemUrl({ problemKey: '1919C' }), 'https://codeforces.com/contest/1919/problem/C');
  assert.equal(adapter.problemUrl({ problemKey: '100000A' }), 'https://codeforces.com/gym/100000/problem/A');
});

test('known ids: entire known page stops paging and skips known submissions', async () => {
  let calls = 0;
  const adapter = createCodeforcesAdapter(async () => {
    calls += 1;
    // 第一页 2 条（页小于 PAGE_SIZE 时本会自然终止，这里用固定小页模拟整页已知场景）
    return cfRes({
      status: 'OK',
      result: [submission({ id: 10 }), submission({ id: 9 })],
    });
  });
  const rows = await adapter.fetchUserSubmissions('u', {
    knownExternalIds: new Set(['9', '10']),
  });
  assert.equal(rows.length, 0); // 整页已知 → 全部跳过
  assert.equal(calls, 1);       // 不再请求第二页
});

test('known ids: mixed page keeps new ones and continues until a fully-known page', async () => {
  // 每页需凑满 PAGE_SIZE(1000) 条：用已知 id 填充尾部
  const filler = (base: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: base + i }));
  const known = new Set(['20', '12', '11', '4']);
  for (let i = 0; i < 998; i++) known.add(String(2_000_000 + i)); // 第 1 页填充
  for (let i = 0; i < 998; i++) known.add(String(3_000_000 + i)); // 第 2 页填充
  const pages = [
    [{ id: 30 }, { id: 29 }, ...filler(2_000_000, 998)], // 30/29 全新
    [{ id: 28 }, { id: 20 }, ...filler(3_000_000, 998)], // 28 新、20 已知（混页）
    [{ id: 12 }, { id: 11 }],                            // 整页已知 → 应在此终止
    [{ id: 5 }, { id: 4 }],                              // 不应被请求
  ]
  const requested: number[] = [];
  const adapter = createCodeforcesAdapter(async () => {
    requested.push(requested.length);
    return cfRes({ status: 'OK', result: pages[requested.length - 1].map((s) => submission(s)) });
  });
  const rows = await adapter.fetchUserSubmissions('u', { knownExternalIds: known });
  assert.equal(requested.length, 3); // 第三页整页已知后终止
  assert.deepEqual(rows.map((r) => r.externalId), ['30', '29', '28']);
});
