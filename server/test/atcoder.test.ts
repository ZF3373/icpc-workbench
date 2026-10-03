import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAtcoderAdapter } from '../src/adapters/atcoder.ts';
import { ascendingSinceWithLookback } from '../src/adapters/sync.ts';

function router(
  handlers: Record<string, (url: string) => unknown>,
): typeof fetch {
  return async (input: string | URL | Request) => {
    const u = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (u.includes(prefix)) {
        return new Response(JSON.stringify(handler(u)), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

const PROBLEMS = [
  { id: 'abc321_a', contest_id: 'abc321', title: '321-like Checker' },
  { id: 'abc321_b', contest_id: 'abc321', title: 'Cutoff' },
  { id: 'abc321_c', contest_id: 'abc321', title: '321-like Checker (Easy)' },
  { id: 'abc321_d', contest_id: 'abc321', title: 'Polygon' },
];

const MODELS = {
  abc321_a: { difficulty: 125 },
  abc321_b: { difficulty: null },
  abc321_c: { difficulty: -1152 }, // kenkoooo 对极简题给出负值
  abc321_d: { difficulty: 926.4 }, // 非整数难度（四舍五入）
};

function submission(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1001,
    epoch_second: 1700000000,
    problem_id: 'abc321_a',
    contest_id: 'abc321',
    user_id: 'u',
    language: 'C++ 23 (gcc 12.2)',
    result: 'AC',
    ...over,
  };
}

function makeAdapter(
  subHandler: (url: string) => unknown,
  cacheDir?: string,
) {
  const fetchFn = router({
    'atcoder-api/v3/user/submissions': subHandler,
    'resources/problems.json': () => PROBLEMS,
    'resources/problem-models.json': () => MODELS,
  });
  return createAtcoderAdapter(cacheDir, fetchFn);
}

/**
 * 忠实模拟 kenkoooo `/user/submissions` 的**真实语义**（实测确认，见 adapters/atcoder.ts 的翻页注释）：
 * 响应是**至多 500 行**的一个窗口 —— 从「第一条 epoch_second >= from_second 的提交」开始、
 * 按 id 升序连续截取 500 行。`from_second` 是下界，不是「从这里到最新全部」。
 *
 * 旧适配器把光标推进到 `maxSecond + 1`，而真实上游会在某一秒中间截断窗口 ——
 * 该秒剩余的同秒提交（一次比赛里连续提交的真实形态）从此永远查不到，是数据丢失。
 * 这个 shim 让回归测试能够复现该语义，而不是用「忽略 from_second、固定返回一批」的假 mock 掩盖它。
 */
function windowedApi(history: Array<Record<string, unknown>>) {
  const sorted = [...history].sort(
    (a, b) => (a.epoch_second as number) - (b.epoch_second as number) || (a.id as number) - (b.id as number),
  );
  return (url: string): unknown => {
    const from = Number(new URL(url).searchParams.get('from_second'));
    const start = sorted.findIndex((r) => (r.epoch_second as number) >= from);
    return start < 0 ? [] : sorted.slice(start, start + 500);
  };
}

/**
 * 复刻同步层对升序平台（AtCoder）的 last_sync_at 推进规则（见 adapters/sync.ts）：
 * 截断时推进到**本批最新一条提交的时间**（适配器保证本批是连续前缀、砍点之外的行不会被返回），
 * 否则推进到「当前时刻」。返回下一轮要用的 since（首轮为 undefined = 全量）。
 */
function advanceCursor(
  opts: { truncated?: boolean },
  rows: NormalizedSubmissionLike[],
  nowIso: string,
): string {
  if (opts.truncated && rows.length > 0) {
    return rows.reduce((m, x) => (x.submittedAt > m ? x.submittedAt : m), rows[0]!.submittedAt);
  }
  return nowIso;
}

interface NormalizedSubmissionLike {
  externalId: string;
  submittedAt: string;
}

test('normalizes AtCoder submissions with title/difficulty/link', async () => {
  const adapter = makeAdapter(() => [
    submission({}),
    submission({ id: 1002, problem_id: 'abc321_b', result: 'WA' }),
  ]);
  const rows = await adapter.fetchUserSubmissions('u');
  assert.equal(rows.length, 2);
  const r = rows[0];
  assert.equal(r.verdict, 'AC');
  assert.equal(r.problem.problemKey, 'abc321_a');
  assert.equal(r.problem.title, '321-like Checker');
  // 难度改由 shared/src/difficulty.ts 的实测锚点分段映射：θ=125 落在 [-386,451] 段 → 约 922
  assert.equal(r.problem.difficulty, 922);
  assert.equal(r.problem.nativeDifficulty, '125'); // 原生 θ 原文（钳位不再改写原生值）
  assert.equal(r.problem.difficultyScale, 'atcoder-kenkoooo-irt');
  assert.equal(r.problem.url, 'https://atcoder.jp/contests/abc321/tasks/abc321_a');
  assert.equal(new Date(r.submittedAt).toISOString(), new Date(1700000000 * 1000).toISOString());
  assert.equal(rows[1].verdict, 'WA');
  assert.equal('difficulty' in rows[1].problem, false); // null 难度省略
});

test('AtCoder 难度按实测锚点分段映射（极低 θ 钳到 CF 下限并保留原生 θ）', async () => {
  const adapter = makeAdapter(() => [
    submission({ id: 1003, problem_id: 'abc321_c' }),
    submission({ id: 1004, problem_id: 'abc321_d' }),
  ]);
  const rows = await adapter.fetchUserSubmissions('u');
  assert.equal(rows[0].problem.difficulty, 800); // -1152：低于首锚点 -386 → 钳到 CF 下限
  assert.equal(rows[0].problem.nativeDifficulty, '-1152'); // 原生 θ 原文（不被钳位改写）
  assert.equal(rows[1].problem.difficulty, 1455); // 926.4：仍在中低段（451..973 锚点之间）
  assert.equal(rows[1].problem.nativeDifficulty, '926.4'); // 原生值保留小数原文
});

test('pages through 500-per-page until short page, dedupes by id', async () => {
  const calls: string[] = [];
  // 500 条（id 1..500，逐秒递增）填满首个窗口 + 末尾多一条，模拟「满页 → 续拉 → 短页」
  const history = Array.from({ length: 500 }, (_, i) =>
    submission({ id: i + 1, epoch_second: 1700000000 + i }),
  );
  history.push(submission({ id: 501, epoch_second: 1700001000 }));
  const adapter = makeAdapter((url) => {
    calls.push(url);
    return windowedApi(history)(url);
  });
  const rows = await adapter.fetchUserSubmissions('u');
  assert.equal(rows.length, 501);
  assert.equal(new Set(rows.map((r) => r.externalId)).size, 501);
  assert.equal(calls.length, 2, '满页后应续拉一次，短页即自然结束');
  // 续拉游标 = 本页末行的秒 + 1（窗口从该秒的头一行开始，故该秒已整段覆盖）
  assert.match(calls[1]!, /from_second=1700000500/);
});

test('窗口边界切在同一秒中间时，该秒剩余的同秒行与更晚的提交都不丢失（回归）', async () => {
  // 上游语义：每次请求返回「从第一条 epoch >= from_second 开始」的至多 500 行窗口。
  // 实测 abc478 就存在多条提交落在同一秒的真实形态；旧实现把游标推到「末行秒 + 1」，
  // 一旦窗口正好切在某一秒中间，该秒剩余的行与更晚的提交都会被永久跳过。
  const T = 1791000000;
  // 460 条各占一秒 + 边界秒（T+459）上 40 条同秒行 + 1 条更晚提交：
  // 首窗 500 行会在 T+459 那一秒中间截断。
  const history = [
    ...Array.from({ length: 460 }, (_, i) => submission({ id: 1000 + i, epoch_second: T + i, problem_id: 'abc478_a' })),
    ...Array.from({ length: 40 }, (_, i) => submission({ id: 1700 + i, epoch_second: T + 459, problem_id: 'abc478_b' })),
    submission({ id: 2000, epoch_second: T + 900, problem_id: 'abc478_c' }),
  ];
  const fetchFn = router({
    'atcoder-api/v3/user/submissions': windowedApi(history),
    'resources/problems.json': () => PROBLEMS,
    'resources/problem-models.json': () => MODELS,
  });
  const adapter = createAtcoderAdapter(undefined, fetchFn);
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 1500 };
  const rows = await adapter.fetchUserSubmissions('u', opts);

  const ids = new Set(rows.map((r) => r.externalId));
  for (const s of history) {
    assert.ok(ids.has(String(s.id)), `提交 ${s.id} 不应丢失`);
  }
  assert.equal(rows.length, history.length);
  assert.equal(new Set(rows.map((r) => r.externalId)).size, history.length, '不得重复导出');
  assert.ok(
    rows.every((r, i) => i === 0 || rows[i - 1]!.submittedAt <= r.submittedAt),
    '按提交时间升序输出（AtCoder 续拉语义）',
  );
  assert.equal(opts.truncated, undefined, '已拉全上游 → 不截断');
});

test('触及单次上限：返回的一定是连续前缀，续拉光标可安全推进（回归）', async () => {
  const T = 1791000000;
  // 600 条逐秒 + 1 条更晚提交；单次上限 250 → 需要多轮。
  // 旧实现把光标推到本批**最新**提交时间，会跨过未覆盖的区间（含那条更晚提交）。
  const history = [
    ...Array.from({ length: 600 }, (_, i) => submission({ id: 1000 + i, epoch_second: T + i, problem_id: 'abc478_a' })),
    submission({ id: 2000, epoch_second: T + 900, problem_id: 'abc478_c' }),
  ];
  const make = () => {
    const fetchFn = router({
      'atcoder-api/v3/user/submissions': windowedApi(history),
      'resources/problems.json': () => PROBLEMS,
      'resources/problem-models.json': () => MODELS,
    });
    return createAtcoderAdapter(undefined, fetchFn);
  };

  const collected = new Set<number>();
  let since: string | undefined;
  let rounds = 0;
  let truncated = true;
  while (truncated && rounds < 12) {
    const opts: { maxSubmissions?: number; truncated?: boolean; since?: string } = { maxSubmissions: 250 };
    if (since) opts.since = since;
    const rows = await make().fetchUserSubmissions('u', opts);
    assert.ok(rows.length <= 250, '单批不得超过单次上限');
    // 本批必须是按提交时间升序的连续前缀（无空洞），否则同步层的光标推进会跳过数据
    assert.ok(
      rows.every((r, i) => i === 0 || rows[i - 1]!.submittedAt <= r.submittedAt),
      '单批内必须按提交时间升序（连续前缀）',
    );
    for (const r of rows) collected.add(Number(r.externalId));
    const next = advanceCursor(opts, rows, '2099-01-01T00:00:00.000Z');
    if (since !== undefined) assert.ok(next >= since, '续拉光标不得回退');
    since = next;
    truncated = opts.truncated === true;
    rounds += 1;
  }

  assert.ok(rounds < 12, '续拉必须收敛');
  assert.ok(collected.has(2000), `更晚的提交必须被后续轮次拉到（实际收集 ${collected.size} 条，${rounds} 轮）`);
  assert.equal(collected.size, history.length, '最终应收全全部提交（无重复计入）');
});

test('升序平台增量同步带回看窗口：光标漂到最新提交之后也能把漏掉的提交拉回来（回归）', async () => {
  // 这是线报「AtCoder 最新提交同步不进来」的核心成因：窗口式上游 + 只按秒定位的游标，
  // 一旦 last_sync_at 因为瞬时上游空响应/时钟偏差落到最新提交之后，之间的提交永久拉不回来。
  // 修复：升序平台的增量起点固定回看 12 小时（重复提交由唯一键去重）。
  const lastSyncAt = '2026-10-03T14:34:07.854Z';
  const effective = ascendingSinceWithLookback(lastSyncAt);
  assert.ok(effective, '有 last_sync_at 时必须算出回看后的起点');
  assert.equal(
    new Date(Date.parse(effective!)).toISOString(),
    '2026-10-03T02:34:07.854Z',
    '起点必须比 last_sync_at 早 12 小时，才能覆盖被跳过的 12:05–12:46 提交',
  );
  // 漏掉的提交确实落在回看窗口内 → 会被重新拉到
  assert.ok(Date.parse(effective!) < Date.parse('2026-10-03T12:05:16.000Z'));
  // 无起点（全量首刷）时保持 undefined，不能凭空造出一个时间点
  assert.equal(ascendingSinceWithLookback(undefined), undefined);
});

test('passes since as from_second for incremental sync', async () => {
  let requested = '';
  const adapter = makeAdapter((url) => {
    requested = url;
    return [];
  });
  await adapter.fetchUserSubmissions('u', { since: '2024-01-01T00:00:00.000Z' });
  assert.ok(requested.includes('from_second=1704067200'), requested);
});

test('caches resources to disk and skips refetch within TTL', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atcoder-cache-'));
  try {
    const adapter = makeAdapter(() => [submission({})], cacheDir);
    await adapter.fetchUserSubmissions('u');
    assert.ok(fs.existsSync(path.join(cacheDir, 'atcoder-problems.json')));
    // 再次调用：资源命中缓存，仅 user/submissions 请求发生
    let statusCalls = 0;
    const fetchFn = async (input: string | URL | Request) => {
      if (String(input).includes('user/submissions')) statusCalls += 1;
      throw new Error(`unexpected fetch: ${String(input)}`);
    };
    const adapter2 = createAtcoderAdapter(cacheDir, fetchFn);
    await assert.rejects(() => adapter2.fetchUserSubmissions('u'), /unexpected fetch: .*user\/submissions/);
    assert.equal(statusCalls, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('throws on API error object', async () => {
  const adapter = makeAdapter(() => ({ message: 'user not found' }));
  await assert.rejects(() => adapter.fetchUserSubmissions('ghost'), /user not found/);
});

test('problemUrl uses /tasks/ shortcut', () => {
  const adapter = makeAdapter(() => []);
  assert.equal(
    adapter.problemUrl({ problemKey: 'abc321_a' }),
    'https://atcoder.jp/tasks/abc321_a',
  );
});

test('maxSubmissions: stops at cap and sets opts.truncated (分批防封号)', async () => {
  // 700 条历史：首窗 500 条（epoch 每秒 +1），续窗 200 条。maxSubmissions=600 →
  // 收下 600 条即停（不再请求第 3 页），并把整批标记为截断供同步层安排续拉。
  const history = Array.from({ length: 700 }, (_, i) =>
    submission({ id: i + 1, epoch_second: 1700000000 + i }),
  );
  const calls: string[] = [];
  const adapter = makeAdapter((url) => {
    calls.push(url);
    return windowedApi(history)(url);
  });
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 600 };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 600); // 恰好到上限
  assert.equal(opts.truncated, true);
  assert.equal(calls.length, 2); // 达上限即停，第 3 页不应被请求
  // 续拉游标 = 本页末行的秒 + 1（该秒已整段收下）
  assert.match(calls[1]!, /from_second=1700000500/);
  assert.equal(rows[0]!.externalId, '1');
  assert.equal(rows.at(-1)!.externalId, '600');
});

test('maxSubmissions: empty result before cap does NOT truncate (natural end)', async () => {
  const adapter = makeAdapter(() => [submission({ id: 1 })]);
  const opts: { maxSubmissions?: number; truncated?: boolean } = { maxSubmissions: 500 };
  const rows = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(rows.length, 1);
  assert.equal(opts.truncated, undefined); // 第 2 页空 → 自然结束不截断
});

