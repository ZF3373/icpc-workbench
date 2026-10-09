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

test('problemUrl: 纯数字题号按「末 2 位是题号」拆分（92101 回归）', () => {
  /**
   * CF 实测存在 `92101`（= 比赛 921 + 题号 `01`）这类纯数字合法键，
   * 贪婪的 /^(\d+)(.+)$/ 会把比赛号错拆成 9210，拼出打不开的链接。
   * 口径与 contests/participated.ts 的 contestIdOf 一致。
   */
  const adapter = createCodeforcesAdapter();
  const url = (k: string): string => adapter.problemUrl({ problemKey: k } as never);
  assert.equal(url('92101'), 'https://codeforces.com/contest/921/problem/01');
  // 非纯数字键不受影响
  assert.equal(url('1A'), 'https://codeforces.com/contest/1/problem/A');
  assert.equal(url('921A'), 'https://codeforces.com/contest/921/problem/A');
  assert.equal(url('1234B2'), 'https://codeforces.com/contest/1234/problem/B2');
});

test('normalizes CF submission (OK -> AC, rating/tags/link)', async () => {  const adapter = createCodeforcesAdapter(async () =>
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

test('participantType maps to submission context (赛场/补题/虚拟赛)', async () => {
  const adapter = createCodeforcesAdapter(async () =>
    cfRes({
      status: 'OK',
      result: [
        submission({ id: 10, participantType: 'CONTESTED' }),
        submission({ id: 11, participantType: 'OUT_OF_COMPETITION' }),
        submission({ id: 12, participantType: 'VIRTUAL' }),
        submission({ id: 13, participantType: 'PRACTICE' }),
        submission({ id: 14, participantType: 'UNKNOWN_TYPE' }),
        submission({ id: 15 }),
      ],
    }),
  );
  const rows = await adapter.fetchUserSubmissions('u');
  assert.deepEqual(
    rows.map((r) => r.context ?? null),
    ['contest', 'contest', 'virtual', 'practice', null, null],
  );
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

test('maxSubmissions: stops at cap and sets opts.truncated (分批防封号)', async () => {
  // CF 每页 PAGE_SIZE=1000：凑满页，maxSubmissions=1500 → 第 2 页拉到 500 条达上限
  const fullPage = (base: number) =>
    Array.from({ length: 1000 }, (_, i) => ({ id: base + i }));
  const pages = [fullPage(1), fullPage(1001), fullPage(2001)]; // 第 3 页不应被请求
  let callCount = 0;
  const adapter = createCodeforcesAdapter(async () => {
    const idx = callCount;
    callCount += 1;
    return cfRes({ status: 'OK', result: pages[idx].map((s) => submission(s)) });
  });
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 1500 };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 1500); // 恰好到上限
  assert.equal(opts.truncated, true); // 回写截断信号
  assert.equal(callCount, 2); // 第 3 页不应被请求
});

test('maxSubmissions: short page before cap does NOT truncate (natural end)', async () => {
  // 不足一页（< PAGE_SIZE）= 最后一页 → 自然结束，不截断
  const adapter = createCodeforcesAdapter(async () =>
    cfRes({ status: 'OK', result: [submission({ id: 1 }), submission({ id: 2 })] }),
  );
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 5 };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 2);
  assert.equal(opts.truncated, undefined); // 自然结束不截断
});


test('backfill: 整页已知不得当作补全到头（否则更早的历史永远拉不到）', async () => {
  const known = new Set<string>();
  for (let i = 0; i < 1000; i++) known.add(String(2_000_000 + i)); // 第 1 页整页已知
  const pages = [
    Array.from({ length: 1000 }, (_, i) => ({ id: 2_000_000 + i })),
    [{ id: 30 }, { id: 29 }], // 更旧的历史：补全模式必须走到这一页
  ];
  const requested: number[] = [];
  const adapter = createCodeforcesAdapter(async () => {
    const page = pages[requested.length] ?? [];
    requested.push(requested.length);
    return cfRes({ status: 'OK', result: page.map((s) => submission(s)) });
  });
  const opts: { knownExternalIds?: Set<string>; backfill?: boolean; truncated?: boolean } = {
    knownExternalIds: known,
    backfill: true,
  };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(requested.length, 2, '补全模式要跳过整页已知的第 1 页继续向更旧');
  assert.deepEqual(rows.map((r) => r.externalId).sort(), ['29', '30']);
  assert.equal(opts.truncated, undefined, '走到最后一页（短页）= 自然结束，不该留补全标记');
});

test('backfill: 已知前缀 ≥ 2 整页也要穿过（旧「连续 2 页已知即收尾」会把重度用户锁死）', async () => {
  // 库已覆盖最新 2000 条（第 1、2 页整页已知），第 3 页还有更旧的历史：
  // 旧实现走完第 2 页就宣告 caughtUp 并清掉 sync_truncated，第 2001 条及更早的提交永久不可达
  const known = new Set<string>();
  for (let i = 0; i < 2000; i++) known.add(String(2_000_000 + i));
  const pages = [
    Array.from({ length: 1000 }, (_, i) => ({ id: 2_000_000 + i })),
    Array.from({ length: 1000 }, (_, i) => ({ id: 2_001_000 + i })),
    [{ id: 30 }, { id: 29 }], // 更旧的历史
  ];
  const requested: number[] = [];
  const adapter = createCodeforcesAdapter(async () => {
    const page = pages[requested.length] ?? [];
    requested.push(requested.length);
    return cfRes({ status: 'OK', result: page.map((s) => submission(s)) });
  });
  const opts: { knownExternalIds?: Set<string>; backfill?: boolean; truncated?: boolean } = {
    knownExternalIds: known,
    backfill: true,
  };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(requested.length, 3, '补全模式必须穿过已知前缀走到第 3 页');
  assert.deepEqual(rows.map((r) => r.externalId).sort(), ['29', '30']);
  assert.equal(opts.truncated, undefined);
});

test('backfill: 从 backfillFromPage 游标续拉，不再从头重扫', async () => {
  const froms: number[] = [];
  const adapter = createCodeforcesAdapter(async (input) => {
    froms.push(Number(new URL(String(input)).searchParams.get('from')));
    return cfRes({ status: 'OK', result: [submission({ id: 30 }), submission({ id: 29 })] }); // 短页 = 自然结束
  });
  const opts: { backfill?: boolean; backfillFromPage?: number } = { backfill: true, backfillFromPage: 5 };
  await adapter.fetchUserSubmissions('u', opts);
  assert.equal(froms[0], 2001, '游标页 5 回退 2 页重叠 → 从第 3 页起（from=(3-1)*1000+1）');
});

test('backfill: 预算耗尽在已知前缀内（0 新增）也要截断并回写游标，下一轮从更深处续拉', async () => {
  const known = new Set<string>();
  for (let i = 0; i < 2000; i++) known.add(String(2_000_000 + i)); // 前 2 整页已知
  const pages = [
    Array.from({ length: 1000 }, (_, i) => ({ id: 2_000_000 + i })),
    Array.from({ length: 1000 }, (_, i) => ({ id: 2_001_000 + i })),
    Array.from({ length: 1000 }, (_, i) => ({ id: 2_002_000 + i })), // 预算 2 页，走不到这里
  ];
  const requested: number[] = [];
  const adapter = createCodeforcesAdapter(async () => {
    const page = pages[requested.length] ?? [];
    requested.push(requested.length);
    return cfRes({ status: 'OK', result: page.map((s) => submission(s)) });
  });
  // maxSubmissions=100 → 页数预算 = ceil(100/1000)*2 = 2 页
  const opts: { knownExternalIds?: Set<string>; backfill?: boolean; maxSubmissions?: number; truncated?: boolean; backfillReachedPage?: number } = {
    knownExternalIds: known,
    backfill: true,
    maxSubmissions: 100,
  };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 0);
  assert.equal(opts.truncated, true, '0 新增也要截断：否则 sync_truncated 被清掉、更早历史永久放弃');
  assert.equal(opts.backfillReachedPage, 3, '游标停在已扫过的最深页之后');
});

test('backfill: 逐轮续拉必须净推进（预算 2 页时重叠页不得吃掉全部预算、游标原地打转）', async () => {
  // 回归（2026-10 复审实测发现）：默认 maxSubmissions=300 → 页数预算 = ceil(300/1000)*2 = 2 页。
  // 若回退重叠同样取 2 页，「每轮净推进 = 预算 - 重叠 = 0」——每轮都只请求 from=1,1001，
  // 第 3 页（第 2001 条及更早的提交）永远拉不到：死端只是从「已知前缀收尾」换成了
  // 「游标原地打转」，修复并未生效。重叠页上限必须收敛到 预算-1。
  const known = new Set<string>();
  for (let i = 0; i < 2000; i++) known.add(String(2_000_000 + i)); // 库覆盖最新 2000 条（前 2 整页）
  const requestedFroms: number[] = [];
  const adapter = createCodeforcesAdapter(async (input) => {
    const from = Number(new URL(String(input)).searchParams.get('from'));
    requestedFroms.push(from);
    if (from <= 1000) {
      return cfRes({ status: 'OK', result: Array.from({ length: 1000 }, (_, i) => submission({ id: 2_000_000 + i })) });
    }
    if (from <= 2000) {
      return cfRes({ status: 'OK', result: Array.from({ length: 1000 }, (_, i) => submission({ id: 2_001_000 + i })) });
    }
    if (from <= 3000) {
      return cfRes({ status: 'OK', result: [submission({ id: 30 }), submission({ id: 29 })] }); // 短页 = 自然结束
    }
    return cfRes({ status: 'OK', result: [] });
  });

  const round1: {
    knownExternalIds?: Set<string>;
    backfill?: boolean;
    maxSubmissions?: number;
    truncated?: boolean;
    backfillReachedPage?: number;
  } = { knownExternalIds: known, backfill: true, maxSubmissions: 300 };
  assert.deepEqual(await adapter.fetchUserSubmissions('u', round1), [], '前两页整页已知 → 本轮 0 新增');
  assert.equal(round1.truncated, true, '预算耗尽在已知前缀内 → 如实截断，游标交给下一轮');
  const cursor = round1.backfillReachedPage;
  assert.equal(cursor, 3, '游标指向下一页起点（第 3 页）');

  const round2: {
    knownExternalIds?: Set<string>;
    backfill?: boolean;
    maxSubmissions?: number;
    truncated?: boolean;
    backfillFromPage?: number;
  } = { knownExternalIds: known, backfill: true, maxSubmissions: 300, backfillFromPage: cursor as number };
  const rows = await adapter.fetchUserSubmissions('u', round2);
  assert.ok(
    requestedFroms.includes(2001),
    `第二轮必须推进到第 3 页，实际请求 from=[${requestedFroms.join(',')}]`,
  );
  assert.deepEqual(rows.map((r) => r.externalId).sort(), ['29', '30'], '第 2001 条及更早的历史必须能拉到');
  assert.equal(round2.truncated, undefined, '走到短页 = 自然结束，补全收尾（同步层据此清空游标）');
});
