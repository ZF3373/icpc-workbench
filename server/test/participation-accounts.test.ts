/**
 * 参赛记录逐账号回归（多账号）。
 *
 * 旧实现每平台只取「最近活跃的一个 handle」（latestAccounts 用 GROUP BY platform），
 * 于是主力号绑了练习小号后，小号的参赛历史**永远不会被拉取**；同一平台的第二个账号
 * 也没有自己的新鲜度与失败状态。这里钉住：每个绑定账号各拉一次、各自记状态，
 * 一个账号失败不掩盖另一个的成功，同一场比赛两个号都参加时列表只出一条并标明账号。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ContestInfo } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  loadParticipationSources,
  readParticipationSnapshot,
  __flushLuoguProblemSetPrefetchForTest,
} from '../src/contests/participationSources.ts';
import {
  deriveParticipatedContests,
  renderContestContext,
  resolveContestGroup,
} from '../src/contests/participated.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(async () => {
  await __flushLuoguProblemSetPrefetchForTest();
  db.close();
});

function bindAccount(platform: string, handle: string, enabled = 1): void {
  db.prepare(
    'INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (1, ?, ?, ?)',
  ).run(platform, handle, enabled);
}

/** 记一条提交（带账号），用于「有本地提交的账号优先承载成绩」的归因断言 */
function addSubmission(
  platform: string,
  account: string,
  problemKey: string,
  submittedAt: string,
  verdict = 'AC',
  context: string | null = null,
): void {
  // 同一题可能被两个账号都交过：problems 行按 (platform, problem_key) 唯一，复用已有行
  const found = db
    .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
    .get(platform, problemKey) as { id: number } | undefined;
  const pid =
    found?.id ??
    (db
      .prepare('INSERT INTO problems (platform, problem_key, title, tags) VALUES (?, ?, ?, ?)')
      .run(platform, problemKey, `题 ${problemKey}`, '[]').lastInsertRowid as number);
  db.prepare(
    'INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id, context) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    platform,
    account,
    pid,
    verdict,
    submittedAt,
    `${platform}-${account}-${problemKey}-${submittedAt}-${verdict}`,
    context,
  );
}

/** user.rating 的单场记录 */
function ratingRow(contestId: number, rank: number, name = `Round ${contestId}`) {
  return {
    contestId,
    contestName: name,
    contestType: 'DIV_2',
    handle: 'x',
    ratingUpdateTimeSeconds: Math.floor(Date.parse('2026-09-20T12:00:00Z') / 1000),
    oldRating: 1500,
    newRating: 1600,
    rank,
  };
}

type Call = { url: string; cookie?: string };

/** stub Codeforces user.rating：按 handle 返回不同结果，并把每次请求记下来 */
function cfFetch(handlers: Record<string, unknown>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, cookie: String((init?.headers as Record<string, string> | undefined)?.cookie ?? '') });
    if (!url.includes('codeforces.com/api/user.rating')) return new Response('not found', { status: 404 });
    const handle = new URL(url).searchParams.get('handle') ?? '';
    const result = handlers[handle];
    if (result === undefined) return new Response(JSON.stringify({ status: 'FAILED', comment: 'no such user' }), { status: 200 });
    return new Response(JSON.stringify({ status: 'OK', result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function storedAccounts(platform: string): string[] {
  return (
    db
      .prepare(`SELECT DISTINCT account FROM participated_contests WHERE user_id = 1 AND platform = ? ORDER BY account`)
      .all(platform) as Array<{ account: string }>
  ).map((r) => r.account);
}

function syncStates(platform: string): Array<{ account: string; last_sync_at: string | null; last_error: string | null }> {
  return db
    .prepare('SELECT account, last_sync_at, last_error FROM participation_sync WHERE user_id = 1 AND platform = ? ORDER BY account')
    .all(platform) as Array<{ account: string; last_sync_at: string | null; last_error: string | null }>;
}

test('同平台每个绑定账号各拉一次（小号参赛记录不再永久缺失）', async () => {
  bindAccount('codeforces', 'main_handle');
  bindAccount('codeforces', 'alt_handle');
  const { fetchFn, calls } = cfFetch({
    main_handle: [ratingRow(2001, 120)],
    alt_handle: [ratingRow(2002, 880)],
  });
  const res = await loadParticipationSources(db, [], { force: true, fetchFn });

  assert.deepEqual(
    calls.map((c) => new URL(c.url).searchParams.get('handle')).sort(),
    ['alt_handle', 'main_handle'],
  );
  assert.deepEqual(storedAccounts('codeforces'), ['alt_handle', 'main_handle']);
  const contests = res.byPlatform.codeforces ?? [];
  assert.deepEqual(contests.map((c) => c.contestId).sort(), ['2001', '2002']);
  // 两个账号各自成行：成绩不同，不能互相覆盖
  assert.deepEqual(
    contests.map((c) => `${c.contestId}/${c.account}/${c.rank}`).sort(),
    ['2001/main_handle/120', '2002/alt_handle/880'],
  );
});

test('一个账号失败不掩盖另一个：全部失败才对该平台报失败', async () => {
  bindAccount('codeforces', 'main_handle');
  bindAccount('codeforces', 'broken_handle');
  const { fetchFn } = cfFetch({ main_handle: [ratingRow(2001, 120)] });
  const res = await loadParticipationSources(db, [], { force: true, fetchFn });
  assert.equal(res.failures.codeforces, undefined, '有账号成功就不该报平台失败');

  const states = syncStates('codeforces');
  assert.equal(states.length, 2);
  assert.equal(states.find((s) => s.account === 'broken_handle')?.last_error !== null, true, '失败账号要留错误');
  assert.equal(states.find((s) => s.account === 'main_handle')?.last_error, null);

  // 两个都失败 → 平台报失败
  const all = cfFetch({});
  bindAccount('codeforces', 'third_handle');
  const res2 = await loadParticipationSources(db, [], { force: true, fetchFn: all.fetchFn });
  assert.ok(res2.failures.codeforces, '全部账号失败时平台才算失败');
});

test('新鲜度按账号判定：新绑定账号不会被旧账号的同步时间挡住', async () => {
  bindAccount('codeforces', 'main_handle');
  const first = cfFetch({ main_handle: [ratingRow(2001, 120)] });
  await loadParticipationSources(db, [], { force: true, fetchFn: first.fetchFn });

  // 不 force 再进一次：main 刚拉过（30 分钟内新鲜），但 alt 从未拉过 → 只应打 alt
  bindAccount('codeforces', 'alt_handle');
  const second = cfFetch({ main_handle: [ratingRow(2001, 120)], alt_handle: [ratingRow(2002, 880)] });
  await loadParticipationSources(db, [], { fetchFn: second.fetchFn });
  assert.deepEqual(
    second.calls.map((c) => new URL(c.url).searchParams.get('handle')),
    ['alt_handle'],
  );
  assert.deepEqual(storedAccounts('codeforces'), ['alt_handle', 'main_handle']);
});

test('readParticipationSnapshot：任一账号过期即该平台需要后台刷新', () => {
  bindAccount('codeforces', 'main_handle');
  bindAccount('codeforces', 'alt_handle');
  const now = new Date().toISOString();
  const longAgo = new Date(Date.now() - 90 * 60_000).toISOString();
  db.prepare('INSERT INTO participation_sync (user_id, platform, account, last_sync_at, backlog_done) VALUES (1, ?, ?, ?, 1)').run('codeforces', 'main_handle', now);
  db.prepare('INSERT INTO participation_sync (user_id, platform, account, last_sync_at, backlog_done) VALUES (1, ?, ?, ?, 1)').run('codeforces', 'alt_handle', longAgo);
  db.prepare(
    'INSERT INTO participated_contests (user_id, platform, account, contest_id, name, url, fetched_at) VALUES (1, ?, ?, ?, ?, ?, ?)',
  ).run('codeforces', 'main_handle', '2001', 'Round 1', 'https://codeforces.com/contest/2001', now);

  const snap = readParticipationSnapshot(db);
  assert.equal((snap.byPlatform.codeforces ?? []).length, 1);
  assert.deepEqual(snap.stalePlatforms, ['codeforces'], '小号过期就要刷新，不能因为主力号新鲜而跳过');
});

test('未启用的绑定账号不拉取（用户已停用的账号不该继续打外网）', async () => {
  bindAccount('codeforces', 'main_handle');
  bindAccount('codeforces', 'off_handle', 0);
  const { fetchFn, calls } = cfFetch({ main_handle: [ratingRow(2001, 120)], off_handle: [ratingRow(2002, 10)] });
  await loadParticipationSources(db, [], { force: true, fetchFn });
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('handle')), ['main_handle']);
});

test('同一场比赛两个号都参加：列表只出一条，成绩取有本地提交的账号并标明跨账号', async () => {
  bindAccount('codeforces', 'main_handle');
  bindAccount('codeforces', 'alt_handle');
  const { fetchFn } = cfFetch({
    // 同一场 2001：主力号 rank 120、小号 rank 3000
    main_handle: [ratingRow(2001, 120)],
    alt_handle: [ratingRow(2001, 3000)],
  });
  const res = await loadParticipationSources(db, [], { force: true, fetchFn });
  assert.deepEqual(storedAccounts('codeforces'), ['alt_handle', 'main_handle']);
  assert.deepEqual(
    (res.byPlatform.codeforces ?? []).map((c) => `${c.account}:${c.rank}`).sort(),
    ['alt_handle:3000', 'main_handle:120'],
  );

  // 主力号有该场本地提交，小号在该场窗口内没有提交
  const start = '2026-09-20T10:30:00.000Z';
  addSubmission('codeforces', 'main_handle', '2001-A', start);
  addSubmission('codeforces', 'main_handle', '2001-B', '2026-09-20T11:00:00.000Z');

  const calendar: ContestInfo[] = [
    {
      platform: 'codeforces',
      id: 'codeforces:2001',
      name: 'Round 1',
      category: 'Div. 2',
      url: 'https://codeforces.com/contest/2001',
      startTimeIso: '2026-09-20T10:00:00.000Z',
      durationMinutes: 120,
      phase: 'BEFORE',
    },
  ];
  const list = deriveParticipatedContests(db, { calendar, sources: res.byPlatform });
  const one = list.filter((c) => c.key === 'codeforces:2001');
  assert.equal(one.length, 1, '同一场不该裂成两条');
  assert.equal(one[0].source?.rank, 120, '成绩取有本地提交的那个账号');
  assert.deepEqual([...(one[0].accounts ?? [])].sort(), ['alt_handle', 'main_handle']);
});

test('多账号同场的复盘上下文标注账号（否则 AI 把小号练手当成主力临场发挥）', async () => {
  bindAccount('codeforces', 'main_handle');
  bindAccount('codeforces', 'alt_handle');
  const { fetchFn } = cfFetch({
    main_handle: [ratingRow(2001, 120)],
    alt_handle: [ratingRow(2001, 3000)],
  });
  const res = await loadParticipationSources(db, [], { force: true, fetchFn });
  addSubmission('codeforces', 'main_handle', '2001-A', '2026-09-20T10:30:00.000Z', 'AC', 'contest');
  addSubmission('codeforces', 'alt_handle', '2001-A', '2026-09-20T10:40:00.000Z', 'WA', 'contest');
  addSubmission('codeforces', 'alt_handle', '2001-B', '2026-09-20T10:50:00.000Z', 'WA', 'contest');

  const calendar: ContestInfo[] = [
    {
      platform: 'codeforces',
      id: 'codeforces:2001',
      name: 'Round 1',
      category: 'Div. 2',
      url: 'https://codeforces.com/contest/2001',
      startTimeIso: '2026-09-20T10:00:00.000Z',
      durationMinutes: 120,
      phase: 'CODING',
    },
  ];
  const review = resolveContestGroup(db, 'codeforces:2001', { calendar, sources: res.byPlatform });
  assert.ok(review, '窗口内两个账号的提交都应归进这一场');
  assert.deepEqual([...(review!.contest.accounts ?? [])].sort(), ['alt_handle', 'main_handle']);
  const md = renderContestContext(review!);
  assert.match(md, /参赛账号：alt_handle、main_handle/, '必须显式告诉 AI 这是多账号同场');
  // 逐条时间线带账号前缀：同一题两个号都交过，不标注就分不出谁的卡点
  assert.match(md, /alt_handle \+40:00 WA/, '小号那条提交要带账号');
  assert.match(md, /main_handle \+30:00 AC/, '主力号那条也要带账号');

  // 单账号场景不加噪声
  const solo = resolveContestGroup(db, 'codeforces:2001', {
    calendar,
    sources: { codeforces: (res.byPlatform.codeforces ?? []).filter((c) => c.account === 'main_handle') },
  })!;
  assert.deepEqual([...(solo.contest.accounts ?? [])].sort(), ['alt_handle', 'main_handle']);
  assert.ok(solo.submissions.length > 0);
});

test('只有一个账号时复盘上下文不提账号（不给单账号用户添噪声）', () => {
  bindAccount('codeforces', 'only_handle');
  addSubmission('codeforces', 'only_handle', '2001-A', '2026-09-20T10:30:00.000Z', 'AC', 'contest');
  const review = resolveContestGroup(db, 'codeforces:2001', {
    calendar: [
      {
        platform: 'codeforces',
        id: 'codeforces:2001',
        name: 'Round 1',
        category: 'Div. 2',
        url: 'https://codeforces.com/contest/2001',
        startTimeIso: '2026-09-20T10:00:00.000Z',
        durationMinutes: 120,
        phase: 'CODING',
      },
    ],
  })!;
  assert.equal(review.contest.accounts, undefined);
  const md = renderContestContext(review);
  assert.doesNotMatch(md, /参赛账号/);
  assert.doesNotMatch(md, /only_handle \+/);
});
