import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContestInfo } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import {
  calendarIndex,
  contestIdOf,
  contestUrl,
  deriveParticipatedContests,
  renderContestContext,
  resolveContestGroup,
  type ContestReviewData,
} from '../src/contests/participated.ts';
import {
  __flushLuoguProblemSetPrefetchForTest,
  __setLuoguProblemSetPrefetchForTest,
  fetchLuoguContestProblems,
} from '../src/contests/participationSources.ts';

/**
 * 赛后复盘推导：数据库没有比赛实体，「参加过的比赛」从 problemKey/url 结构与
 * 赛事日历时间窗反解（contests/participated.ts）。这里逐平台验证判定信号、
 * 时间窗匹配与复盘上下文渲染，全部走内存库，不访问网络。
 */

interface SeedRow {
  platform: string;
  problemKey: string;
  title?: string;
  verdict?: string;
  submittedAt: string;
  externalId: string;
  context?: string | null;
  url?: string | null;
  difficulty?: number | null;
  tags?: string[];
}

function seedAll(db: Db, rows: SeedRow[]): void {
  for (const r of rows) {
    const found = db
      .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
      .get(r.platform, r.problemKey) as { id: number } | undefined;
    const pid =
      found?.id ??
      Number(
        db
          .prepare(
            'INSERT INTO problems (platform, problem_key, title, url, difficulty, tags) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            r.platform,
            r.problemKey,
            r.title ?? `题 ${r.problemKey}`,
            r.url ?? null,
            r.difficulty ?? null,
            JSON.stringify(r.tags ?? []),
          ).lastInsertRowid,
      );
    db.prepare(
      'INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id, context) VALUES (1, ?, ?, ?, ?, ?, ?)',
    ).run(r.platform, pid, r.verdict ?? 'AC', r.submittedAt, r.externalId, r.context ?? null);
  }
}

const CAL: ContestInfo[] = [
  {
    id: 'cf-1877',
    platform: 'codeforces',
    name: 'Codeforces Round 900 (Div. 2)',
    category: 'Div. 2',
    startTimeIso: '2026-09-20T14:00:00.000Z',
    durationMinutes: 130,
    phase: 'FINISHED',
    url: 'https://codeforces.com/contest/1877',
  },
  {
    id: 'at-abc300',
    platform: 'atcoder',
    name: 'ABC300',
    category: 'ABC',
    startTimeIso: '2026-09-19T12:00:00.000Z',
    durationMinutes: 100,
    phase: 'FINISHED',
    url: 'https://atcoder.jp/contests/abc300',
  },
  {
    id: 'at-abc400',
    platform: 'atcoder',
    name: 'ABC400',
    category: 'ABC',
    startTimeIso: '2026-09-16T12:00:00.000Z',
    durationMinutes: 100,
    phase: 'FINISHED',
    url: 'https://atcoder.jp/contests/abc400',
  },
  {
    id: 'lg-353129',
    platform: 'luogu',
    name: '洛谷 9 月月赛',
    category: '月赛',
    startTimeIso: '2026-09-18T10:00:00.000Z',
    durationMinutes: 240,
    phase: 'FINISHED',
    url: 'https://www.luogu.com.cn/contest/353129',
  },
  {
    id: 'lg-353130',
    platform: 'luogu',
    name: '洛谷 某比赛',
    category: '比赛',
    startTimeIso: '2026-09-17T10:00:00.000Z',
    durationMinutes: 240,
    phase: 'FINISHED',
    url: 'https://www.luogu.com.cn/contest/353130',
  },
];

test('contestIdOf：各平台反解比赛标识，无信号的平台返回 null', () => {
  assert.equal(contestIdOf('codeforces', '1877A', null), '1877');
  assert.equal(contestIdOf('codeforces', '104821B', null), '104821');
  // 纯数字键（CF 实测存在，见 problemKey.ts 的取证记录）：贪婪 \d+ 曾把 92101 错拆成比赛 9210
  assert.equal(contestIdOf('codeforces', '92101', null), '921', '末 2 位是题号，比赛号取前段');
  assert.equal(contestIdOf('codeforces', '92101', 'https://codeforces.com/contest/1901/problem/01'), '1901', '有 url 时优先取 url');
  assert.equal(contestIdOf('atcoder', 'abc300_a', 'https://atcoder.jp/contests/abc300/tasks/abc300_a'), 'abc300');
  assert.equal(contestIdOf('atcoder', 'abc300_a', null), null, 'AtCoder 无 url 时不猜');
  assert.equal(contestIdOf('jisuanke', '12345-678', null), '12345');
  assert.equal(contestIdOf('jisuanke', 'T1001', null), null, '练习题键不命中');
  assert.equal(contestIdOf('qoj', '3588-17753', null), '3588');
  assert.equal(contestIdOf('qoj', '9242', null), null, 'QOJ 普通题键不命中');
  assert.equal(contestIdOf('luogu', 'P1001', 'https://www.luogu.com.cn/problem/P1001'), null, '洛谷无结构信号');
});

test('contestUrl：CF gym 走 /gym/，其余按平台规则拼接', () => {
  assert.equal(contestUrl('codeforces', '1877'), 'https://codeforces.com/contest/1877');
  assert.equal(contestUrl('codeforces', '104821'), 'https://codeforces.com/gym/104821');
  assert.equal(contestUrl('atcoder', 'abc300'), 'https://atcoder.jp/contests/abc300');
  assert.equal(contestUrl('jisuanke', '12345'), 'https://www.jisuanke.com/contest/12345');
  assert.equal(contestUrl('qoj', '3588'), 'https://qoj.ac/contest/3588');
});

test('calendarIndex：剥掉 id 平台前缀后按 platform:bare 匹配', () => {
  const cal = calendarIndex(CAL);
  assert.equal(cal.get('codeforces:1877')?.name, 'Codeforces Round 900 (Div. 2)');
  assert.equal(cal.get('atcoder:abc300')?.name, 'ABC300');
  assert.equal(cal.get('luogu:353129')?.name, '洛谷 9 月月赛');
  assert.equal(cal.get('codeforces:9999'), undefined);
  assert.equal(calendarIndex(undefined).size, 0);
});

test('CF：contest/virtual 判定，gym 需一次集中作答（≥3 题 ≤6h），补题并入原比赛', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      // 比赛 1877：赛时 3 发 + 次日补题 1 发，全部并进同一场
      { platform: 'codeforces', problemKey: '1877A', verdict: 'WA', submittedAt: '2026-09-20T14:10:00.000Z', externalId: 'c1', context: 'contest' },
      { platform: 'codeforces', problemKey: '1877A', verdict: 'AC', submittedAt: '2026-09-20T14:20:00.000Z', externalId: 'c2', context: 'contest' },
      { platform: 'codeforces', problemKey: '1877B', verdict: 'AC', submittedAt: '2026-09-20T14:40:00.000Z', externalId: 'c3', context: 'contest' },
      { platform: 'codeforces', problemKey: '1877C', verdict: 'AC', submittedAt: '2026-09-21T02:00:00.000Z', externalId: 'c4', context: 'practice' },
      // 虚拟赛
      { platform: 'codeforces', problemKey: '1900A', verdict: 'AC', submittedAt: '2026-09-10T03:00:00.000Z', externalId: 'v1', context: 'virtual' },
      // gym 训练赛（context 平台不下发）：3 题集中在 1 小时内 → 算
      { platform: 'codeforces', problemKey: '104821A', verdict: 'WA', submittedAt: '2026-09-05T08:00:00.000Z', externalId: 'g1', context: null },
      { platform: 'codeforces', problemKey: '104821B', verdict: 'AC', submittedAt: '2026-09-05T08:30:00.000Z', externalId: 'g2', context: null },
      { platform: 'codeforces', problemKey: '104821C', verdict: 'AC', submittedAt: '2026-09-05T08:50:00.000Z', externalId: 'g3', context: null },
      // gym 误判防线：单题散做（不论几发）不算
      { platform: 'codeforces', problemKey: '105847A', verdict: 'AC', submittedAt: '2026-05-25T08:51:05.000Z', externalId: 'g4', context: null },
      { platform: 'codeforces', problemKey: '105139A', verdict: 'AC', submittedAt: '2026-04-20T09:36:52.000Z', externalId: 'g5', context: null },
      // gym 误判防线：2 题跨越 9 天的零散补题不算
      { platform: 'codeforces', problemKey: '106701L', verdict: 'AC', submittedAt: '2026-09-15T03:45:28.000Z', externalId: 'g6', context: null },
      { platform: 'codeforces', problemKey: '106701K', verdict: 'MLE', submittedAt: '2026-09-24T09:21:07.000Z', externalId: 'g7', context: null },
      // 普通比赛的纯补题/练习：无参赛信号，不列入
      { platform: 'codeforces', problemKey: '1500A', verdict: 'AC', submittedAt: '2026-09-01T08:00:00.000Z', externalId: 'p1', context: 'practice' },
    ]);
    const contests = deriveParticipatedContests(db, { calendar: CAL });
    assert.deepEqual(
      contests.map((c) => c.key),
      ['codeforces:1877', 'codeforces:1900', 'codeforces:104821'],
      '按比赛开始时间倒序；纯练习组与零散 gym 被排除',
    );

    const cf1877 = contests[0]!;
    assert.equal(cf1877.evidence, 'contest');
    assert.equal(cf1877.name, 'Codeforces Round 900 (Div. 2)');
    assert.equal(cf1877.url, 'https://codeforces.com/contest/1877');
    assert.equal(cf1877.startTimeIso, '2026-09-20T14:00:00.000Z', '官方开始时间来自日历');
    assert.equal(cf1877.endTimeIso, '2026-09-20T16:10:00.000Z', '官方结束时间 = 开始 + 时长');
    assert.equal(cf1877.submissionCount, 4, '补题提交并入同一场');
    assert.equal(cf1877.problemCount, 3);
    assert.equal(cf1877.acProblemCount, 3);

    assert.equal(contests[1]!.evidence, 'virtual');
    assert.equal(contests[2]!.evidence, 'gym');
    assert.equal(contests[2]!.url, 'https://codeforces.com/gym/104821');
  } finally {
    db.close();
  }
});

test('列表排序按比赛开始时间倒序：补题不重排历史（2026-10 用户实测回归）', () => {
  // 旧口径按 lastSubmittedAt 倒序：比赛 A（8/1 开赛）最近补过题（9/1），
  // 会被排到比赛 B（8/20 开赛、无后续活动）前面——历史列表被补题活动打乱
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      { platform: 'codeforces', problemKey: '1878A', verdict: 'AC', submittedAt: '2026-08-01T14:10:00.000Z', externalId: 'a1', context: 'contest' },
      { platform: 'codeforces', problemKey: '1878B', verdict: 'AC', submittedAt: '2026-09-01T10:00:00.000Z', externalId: 'a2', context: 'practice' },
      { platform: 'codeforces', problemKey: '1900A', verdict: 'AC', submittedAt: '2026-08-20T14:10:00.000Z', externalId: 'b1', context: 'contest' },
    ]);
    const contests = deriveParticipatedContests(db, { calendar: [] });
    assert.deepEqual(
      contests.map((c) => c.key),
      ['codeforces:1900', 'codeforces:1878'],
      '8/20 的比赛在前；8/1 的比赛即使最近在补题（lastSubmittedAt=9/1）也排后面',
    );
  } finally {
    db.close();
  }
});

test('AtCoder：日历时间窗匹配参赛并取赛名；无日历时启发式（≥3 题 ≤6h）', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      // abc300：日历窗口内提交 → calendar-window
      { platform: 'atcoder', problemKey: 'abc300_a', verdict: 'AC', submittedAt: '2026-09-19T12:30:00.000Z', externalId: 'a1', url: 'https://atcoder.jp/contests/abc300/tasks/abc300_a' },
      { platform: 'atcoder', problemKey: 'abc300_b', verdict: 'AC', submittedAt: '2026-09-19T12:50:00.000Z', externalId: 'a2', url: 'https://atcoder.jp/contests/abc300/tasks/abc300_b' },
      // abc250：日历没有该场 → 启发式（3 题、跨度 1 小时）
      { platform: 'atcoder', problemKey: 'abc250_a', verdict: 'AC', submittedAt: '2026-09-15T02:00:00.000Z', externalId: 'a3', url: 'https://atcoder.jp/contests/abc250/tasks/abc250_a' },
      { platform: 'atcoder', problemKey: 'abc250_b', verdict: 'AC', submittedAt: '2026-09-15T02:40:00.000Z', externalId: 'a4', url: 'https://atcoder.jp/contests/abc250/tasks/abc250_b' },
      { platform: 'atcoder', problemKey: 'abc250_c', verdict: 'AC', submittedAt: '2026-09-15T03:00:00.000Z', externalId: 'a5', url: 'https://atcoder.jp/contests/abc250/tasks/abc250_c' },
      // abc400：日历有该场但提交全在结束后（赛后补题 3 题）→ 不算参赛
      { platform: 'atcoder', problemKey: 'abc400_a', verdict: 'AC', submittedAt: '2026-09-16T14:00:00.000Z', externalId: 'a6', url: 'https://atcoder.jp/contests/abc400/tasks/abc400_a' },
      { platform: 'atcoder', problemKey: 'abc400_b', verdict: 'AC', submittedAt: '2026-09-16T14:20:00.000Z', externalId: 'a7', url: 'https://atcoder.jp/contests/abc400/tasks/abc400_b' },
      { platform: 'atcoder', problemKey: 'abc400_c', verdict: 'AC', submittedAt: '2026-09-16T14:40:00.000Z', externalId: 'a8', url: 'https://atcoder.jp/contests/abc400/tasks/abc400_c' },
      // abc111：单题且无日历 → 不列入
      { platform: 'atcoder', problemKey: 'abc111_a', verdict: 'AC', submittedAt: '2026-09-14T02:00:00.000Z', externalId: 'a9', url: 'https://atcoder.jp/contests/abc111/tasks/abc111_a' },
      // abc222：3 题但跨度 7 小时 → 启发式不命中（不是一次作答）
      { platform: 'atcoder', problemKey: 'abc222_a', verdict: 'AC', submittedAt: '2026-09-13T02:00:00.000Z', externalId: 'a10', url: 'https://atcoder.jp/contests/abc222/tasks/abc222_a' },
      { platform: 'atcoder', problemKey: 'abc222_b', verdict: 'AC', submittedAt: '2026-09-13T05:00:00.000Z', externalId: 'a11', url: 'https://atcoder.jp/contests/abc222/tasks/abc222_b' },
      { platform: 'atcoder', problemKey: 'abc222_c', verdict: 'AC', submittedAt: '2026-09-13T09:00:00.000Z', externalId: 'a12', url: 'https://atcoder.jp/contests/abc222/tasks/abc222_c' },
    ]);
    const contests = deriveParticipatedContests(db, { calendar: CAL });
    assert.deepEqual(
      contests.map((c) => [c.key, c.evidence]),
      [
        ['atcoder:abc300', 'calendar-window'],
        ['atcoder:abc250', 'heuristic'],
      ],
      '赛后补题（abc400）、零散练习（abc111/abc222）均不列入',
    );
    assert.equal(contests[0]!.name, 'ABC300');
    assert.equal(contests[0]!.startTimeIso, '2026-09-19T12:00:00.000Z');
    assert.equal(contests[1]!.name, null, '日历没有的场次拿不到赛名');
    assert.equal(contests[1]!.url, 'https://atcoder.jp/contests/abc250');
    assert.equal(contests[1]!.startTimeIso, '2026-09-15T02:00:00.000Z', '无官方时间时用首条提交近似');
  } finally {
    db.close();
  }
});

test('计蒜客 / QOJ：比赛题键命中即参赛，练习题不产生场次', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      { platform: 'jisuanke', problemKey: '12345-678', verdict: 'AC', submittedAt: '2026-09-08T08:00:00.000Z', externalId: 'j1' },
      { platform: 'jisuanke', problemKey: '12345-679', verdict: 'WA', submittedAt: '2026-09-08T08:20:00.000Z', externalId: 'j2' },
      { platform: 'jisuanke', problemKey: 'T1001', verdict: 'AC', submittedAt: '2026-09-08T09:00:00.000Z', externalId: 'j3' },
      { platform: 'qoj', problemKey: '3588-17753', verdict: 'WA', submittedAt: '2026-09-07T12:00:00.000Z', externalId: 'q1' },
      { platform: 'qoj', problemKey: '9242', verdict: 'AC', submittedAt: '2026-09-07T13:00:00.000Z', externalId: 'q2' },
    ]);
    const contests = deriveParticipatedContests(db, { calendar: [] });
    assert.deepEqual(
      contests.map((c) => [c.key, c.evidence]),
      [
        ['jisuanke:12345', 'key-pattern'],
        ['qoj:3588', 'key-pattern'],
      ],
    );
    assert.equal(contests[0]!.url, 'https://www.jisuanke.com/contest/12345');
    assert.equal(contests[1]!.url, 'https://qoj.ac/contest/3588');
    assert.equal(contests[0]!.acProblemCount, 1);
  } finally {
    db.close();
  }
});

test('洛谷：窗口内 ≥2 道不同 T 号比赛题才算参赛；P 号练习题在窗口内不算', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      // 353129 窗口（10:00–14:00）内两道 T 号比赛题 → 参赛
      { platform: 'luogu', problemKey: 'T8801', verdict: 'AC', submittedAt: '2026-09-18T10:30:00.000Z', externalId: 'l1' },
      { platform: 'luogu', problemKey: 'T8802', verdict: 'WA', submittedAt: '2026-09-18T11:30:00.000Z', externalId: 'l2' },
      // 353130 窗口内只有一道 T 号题 → 不算
      { platform: 'luogu', problemKey: 'T8803', verdict: 'AC', submittedAt: '2026-09-17T11:00:00.000Z', externalId: 'l3' },
      // 353129 窗口内两道 P 号练习题（比赛进行时在线刷题）→ 不算
      { platform: 'luogu', problemKey: 'P8804', verdict: 'AC', submittedAt: '2026-09-18T12:00:00.000Z', externalId: 'l4' },
      { platform: 'luogu', problemKey: 'P8805', verdict: 'AC', submittedAt: '2026-09-18T12:30:00.000Z', externalId: 'l5' },
      // 窗口外的日常练习 → 不挂到任何比赛
      { platform: 'luogu', problemKey: 'P1001', verdict: 'AC', submittedAt: '2026-09-10T08:00:00.000Z', externalId: 'l6' },
    ]);
    const contests = deriveParticipatedContests(db, { calendar: CAL });
    assert.deepEqual(contests.map((c) => c.key), ['luogu:353129']);
    assert.equal(contests[0]!.name, '洛谷 9 月月赛');
    assert.equal(contests[0]!.url, 'https://www.luogu.com.cn/contest/353129');
    assert.equal(contests[0]!.problemCount, 2, '注入只含 T 号比赛题的提交');
    assert.equal(contests[0]!.submissionCount, 2);

    // 没有日历（赛事源全挂）→ 洛谷推导为空，不报错
    assert.deepEqual(deriveParticipatedContests(db, { calendar: [] }), []);
  } finally {
    db.close();
  }
});

test('resolveContestGroup：按 key 还原同一组数据；未知 key 返回 null', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      { platform: 'codeforces', problemKey: '1877A', verdict: 'WA', submittedAt: '2026-09-20T14:10:00.000Z', externalId: 'c1', context: 'contest' },
      { platform: 'codeforces', problemKey: '1877A', verdict: 'AC', submittedAt: '2026-09-20T14:20:00.000Z', externalId: 'c2', context: 'contest' },
      { platform: 'codeforces', problemKey: '1500A', verdict: 'AC', submittedAt: '2026-09-01T08:00:00.000Z', externalId: 'p1', context: 'practice' },
    ]);
    const review = resolveContestGroup(db, 'codeforces:1877', { calendar: CAL });
    assert.ok(review);
    assert.equal(review.contest.key, 'codeforces:1877');
    assert.equal(review.contest.evidence, 'contest');
    assert.equal(review.submissions.length, 2, '只携带该场比赛的提交');
    assert.equal(review.submissions[0]!.submittedAt < review.submissions[1]!.submittedAt, true, '提交按时间升序');

    // 未列入的比赛（无参赛信号）与非法 key 都解析不到
    assert.equal(resolveContestGroup(db, 'codeforces:1500', { calendar: CAL }), null);
    assert.equal(resolveContestGroup(db, 'codeforces:', { calendar: CAL }), null);
    assert.equal(resolveContestGroup(db, 'nowcoder:1', { calendar: CAL }), null, '不支持的平台直接拒绝');
    assert.equal(resolveContestGroup(db, 'garbage', { calendar: CAL }), null);
  } finally {
    db.close();
  }
});

test('renderContestContext：元信息 + 时间线偏移 + 赛时/补题标注', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      { platform: 'codeforces', problemKey: '1877A', title: 'Rabbits', verdict: 'WA', submittedAt: '2026-09-20T14:10:00.000Z', externalId: 'c1', context: 'contest', difficulty: 800, tags: ['math'], url: 'https://codeforces.com/contest/1877/problem/A' },
      { platform: 'codeforces', problemKey: '1877A', title: 'Rabbits', verdict: 'AC', submittedAt: '2026-09-20T14:20:00.000Z', externalId: 'c2', context: 'contest', difficulty: 800, tags: ['math'], url: 'https://codeforces.com/contest/1877/problem/A' },
      { platform: 'codeforces', problemKey: '1877B', title: 'B字标题', verdict: 'WA', submittedAt: '2026-09-20T14:40:00.000Z', externalId: 'c3', context: 'contest', difficulty: 1200, url: 'https://codeforces.com/contest/1877/problem/B' },
      { platform: 'codeforces', problemKey: '1877C', title: 'C题', verdict: 'AC', submittedAt: '2026-09-21T02:00:00.000Z', externalId: 'c4', context: 'practice', difficulty: 1600, url: 'https://codeforces.com/contest/1877/problem/C' },
    ]);
    const review = resolveContestGroup(db, 'codeforces:1877', { calendar: CAL })!;
    const md = renderContestContext(review);
    assert.match(md, /- 比赛：Codeforces Round 900 \(Div\. 2\)（Codeforces）/);
    assert.match(md, /- 比赛链接：https:\/\/codeforces\.com\/contest\/1877/);
    assert.match(md, /概况：3 题中出现 AC 2 题，共 4 次提交（现场参赛）/);
    assert.match(md, /#### 1877A Rabbits（难度 800｜官方 tags: math（Codeforces 官方标注））/);
    assert.match(md, /\+10:00 WA（赛时） → \+20:00 AC（赛时）/);
    assert.match(md, /\+12:00:00 AC（补题）/, '相对官方开始时间的偏移跨天也能算');
    assert.match(md, /#### 1877B[\s\S]*?- 结果：未通过/);
    assert.match(md, /- 题目链接：/);
  } finally {
    db.close();
  }
});

test('renderContestContext：题目数与单题时间线超限截断', () => {
  const row = (i: number, submittedAt: string): ContestReviewData['submissions'][number] => ({
    platform: 'codeforces',
    problemKey: `1${String(i).padStart(2, '0')}A`,
    title: `T${i}`,
    url: null,
    difficulty: null,
    tags: [],
    verdict: 'AC',
    submittedAt,
    context: 'contest',
  });
  // 45 题 × 1 发 → 题目数上限 24 截断（24 已覆盖 CF/ABC/ICPC 单场实际规模的上限）
  const manyProblems: ContestReviewData = {
    contest: {
      key: 'codeforces:1',
      platform: 'codeforces',
      contestId: '1',
      name: null,
      url: '',
      startTimeIso: '2026-09-20T14:00:00.000Z',
      endTimeIso: '2026-09-20T16:00:00.000Z',
      submissionCount: 45,
      problemCount: 45,
      acProblemCount: 45,
      lastSubmittedAt: '2026-09-20T16:00:00.000Z',
      evidence: 'contest',
      source: null,
    },
    submissions: Array.from({ length: 45 }, (_, i) => row(i, new Date(Date.parse('2026-09-20T14:00:00.000Z') + i * 60_000).toISOString())),
    problemSetKnown: false,
    unsubmittedProblems: [],
  };
  const md = renderContestContext(manyProblems);
  assert.match(md, /明细已截断：仅渲染前 24 题 \/ 24 次提交/);

  // 单题 15 发 → 保留首尾各 5 条，中间省略
  const single: ContestReviewData = {
    contest: { ...manyProblems.contest, problemCount: 1, submissionCount: 15 },
    submissions: Array.from({ length: 15 }, (_, i) => ({
      ...row(0, new Date(Date.parse('2026-09-20T14:00:00.000Z') + i * 60_000).toISOString()),
      verdict: i === 14 ? 'AC' : 'WA',
    })),
    problemSetKnown: false,
    unsubmittedProblems: [],
  };
  const md2 = renderContestContext(single);
  assert.match(md2, /中间省略 5 次/);
  assert.match(md2, /\+00:00 WA（赛时）/, '开头的时间线保留');
  assert.match(md2, /\+14:00 AC（赛时）/, '最终的 AC 保留在末尾');
});

test('renderContestContext：总量预算耗尽也不让后段题只剩空时间线（每题至少一条）', () => {
  const base = Date.parse('2026-09-20T14:00:00.000Z');
  const rowsOf = (key: string, n: number, verdict: string): ContestReviewData['submissions'] =>
    Array.from({ length: n }, (_, i) => ({
      platform: 'codeforces',
      problemKey: key,
      title: `T ${key}`,
      url: null,
      difficulty: 1800,
      tags: [],
      verdict,
      submittedAt: new Date(base + i * 60_000).toISOString(),
      context: 'contest',
    }));
  // 第一题 500 次 WA 吃满总量：预算是按渲染顺序消耗的，若不预留，
  // 后两题（往往是最该复盘的难题）会连一条时间线都分不到
  const data: ContestReviewData = {
    contest: {
      key: 'codeforces:1900',
      platform: 'codeforces',
      contestId: '1900',
      name: null,
      url: '',
      startTimeIso: '2026-09-20T14:00:00.000Z',
      endTimeIso: '2026-09-20T20:00:00.000Z',
      submissionCount: 502,
      problemCount: 3,
      acProblemCount: 0,
      lastSubmittedAt: '2026-09-20T20:00:00.000Z',
      evidence: 'contest',
      source: null,
    },
    submissions: [...rowsOf('500A', 500, 'WA'), ...rowsOf('501A', 1, 'WA'), ...rowsOf('502A', 1, 'WA')],
    problemSetKnown: false,
    unsubmittedProblems: [],
  };
  const md = renderContestContext(data);
  for (const key of ['500A', '501A', '502A']) {
    assert.match(md, new RegExp(`#### ${key} `), `${key} 必须仍有明细行`);
  }
  assert.match(md, /- 提交 500 次：/, '第一题给出总提交次数');
  assert.match(md, /其余因总量截断省略/, '被总量截断要注明');
  assert.equal(
    (md.match(/- 提交 1 次：\+00:00 WA（赛时）/g) ?? []).length,
    2,
    '后段两题各保留一条时间线，而不是空时间线',
  );
});

// ---------- 平台参赛记录（权威数据源）合并 ----------

import type { AuthoritativeContest, FetchParticipationOptions } from '../src/contests/participationSources.ts';
import {
  fetchAtcoderParticipation,
  fetchCodeforcesParticipation,
  fetchContestProblemSet,
  fetchLuoguJoinedContests,
  fetchNowcoderJoinedContests,
  loadParticipationSources,
  readParticipationSnapshot,
} from '../src/contests/participationSources.ts';

function srcEntry(
  platform: AuthoritativeContest['platform'],
  contestId: string,
  over: Partial<AuthoritativeContest> = {},
): AuthoritativeContest {
  return {
    platform,
    contestId,
    name: `${platform} 比赛 ${contestId}`,
    url: '',
    startTimeMs: Date.parse('2026-09-20T14:00:00.000Z'),
    endTimeMs: Date.parse('2026-09-20T16:00:00.000Z'),
    rank: null,
    rating: null,
    ratingChange: null,
    problemCount: null,
    acceptedCount: null,
    ...over,
  };
}

test('权威参赛记录合并：CF 旧数据（context=null）凭 user.rating 入列并补齐名称/成绩', () => {
  const db = createDb(':memory:');
  try {
    // 用户真实场景：Round 1122 的提交在库里但 context 为 null（旧版同步没有参赛标记）
    seedAll(db, [
      { platform: 'codeforces', problemKey: '2266A', verdict: 'AC', submittedAt: '2026-09-21T15:17:00.000Z', externalId: 'r1', context: null },
      { platform: 'codeforces', problemKey: '2266B', verdict: 'AC', submittedAt: '2026-09-21T15:33:00.000Z', externalId: 'r2', context: null },
      // 零散 gym 题：无参赛记录、无集中作答 → 仍被排除
      { platform: 'codeforces', problemKey: '106701K', verdict: 'WA', submittedAt: '2026-09-24T09:21:07.000Z', externalId: 'g1', context: null },
    ]);
    const sources = {
      codeforces: [
        srcEntry('codeforces', '2266', {
          name: 'Codeforces Round 1122 (Div. 3)',
          url: 'https://codeforces.com/contest/2266',
          startTimeMs: Date.parse('2026-09-21T14:35:00.000Z'),
          endTimeMs: Date.parse('2026-09-21T16:35:00.000Z'),
          rank: 15005,
          rating: 949,
          ratingChange: -6,
        }),
      ],
    };
    const contests = deriveParticipatedContests(db, { sources });
    assert.deepEqual(
      contests.map((c) => c.key),
      ['codeforces:2266'],
      'context=null 的组凭参赛记录入列，gym 散题仍排除',
    );
    const c = contests[0]!;
    assert.equal(c.evidence, 'joined-list');
    assert.equal(c.name, 'Codeforces Round 1122 (Div. 3)');
    assert.equal(c.startTimeIso, '2026-09-21T14:35:00.000Z', '官方起止时间来自参赛记录');
    assert.equal(c.submissionCount, 2, '本地提交仍归因到场');
    assert.deepEqual(c.source, { rank: 15005, rating: 949, ratingChange: -6, problemCount: null, acceptedCount: null });

    // 复盘注入端用同一索引能解析回同一场（含成绩行）
    const review = resolveContestGroup(db, 'codeforces:2266', { sources });
    assert.ok(review);
    assert.equal(review.submissions.length, 2);
    const md = renderContestContext(review);
    assert.match(md, /平台记录排名：15005/);
    assert.match(md, /平台记录 Rating：949（-6）/);
  } finally {
    db.close();
  }
});

test('权威参赛记录：本地无提交的场次（牛客）以零提交合成组入列', () => {
  const db = createDb(':memory:');
  try {
    const sources = {
      nowcoder: [
        srcEntry('nowcoder', '140237', {
          name: '牛客周赛 Round 162',
          url: 'https://ac.nowcoder.com/acm/contest/140237',
          rank: 371,
          rating: 876,
          ratingChange: 59,
          problemCount: 6,
          acceptedCount: 4,
        }),
      ],
    };
    const contests = deriveParticipatedContests(db, { sources });
    assert.deepEqual(contests.map((c) => c.key), ['nowcoder:140237']);
    const c = contests[0]!;
    assert.equal(c.evidence, 'joined-list');
    assert.equal(c.submissionCount, 0, '牛客不同步比赛提交，零提交入列');
    assert.equal(c.name, '牛客周赛 Round 162');

    const review = resolveContestGroup(db, 'nowcoder:140237', { sources })!;
    const md = renderContestContext(review);
    assert.match(md, /逐条提交记录尚未同步到本地/);
    assert.match(md, /平台记录排名：371/);
    assert.match(md, /平台记录 AC：4\/6/);
  } finally {
    db.close();
  }
});

test('牛客合成组：练习页已含比赛提交（context=null），按权威窗口 + 题目集归因', () => {
  const db = createDb(':memory:');
  try {
    // 周赛162（11:00~13:00Z）窗口内的提交——练习页同步进来的老数据 context 为 null
    seedAll(db, [
      { platform: 'nowcoder', problemKey: '323650', title: '小月的贴纸', verdict: 'AC', submittedAt: '2026-09-20T11:10:10.000Z', externalId: '84759685', context: null },
      { platform: 'nowcoder', problemKey: '323656', title: '小月的字带', verdict: 'AC', submittedAt: '2026-09-20T12:13:07.000Z', externalId: '84764578', context: null },
      // 窗口内但属于题库题（比赛进行时顺手刷的练习，真实踩坑案例）→ 不归因
      { platform: 'nowcoder', problemKey: '320640', title: '小月的立方体', verdict: 'AC', submittedAt: '2026-09-20T11:04:31.000Z', externalId: '84576646', context: null },
      // 窗口外的日常练习 → 不归因
      { platform: 'nowcoder', problemKey: '10001', title: 'A+B', verdict: 'AC', submittedAt: '2026-09-22T08:00:00.000Z', externalId: '84770000', context: null },
    ]);
    const sources = {
      nowcoder: [
        srcEntry('nowcoder', '140489', {
          name: '牛客周赛 Round 162',
          url: 'https://ac.nowcoder.com/acm/contest/140489',
          startTimeMs: Date.parse('2026-09-20T11:00:00.000Z'),
          endTimeMs: Date.parse('2026-09-20T13:00:00.000Z'),
          rank: 371,
          rating: 876,
          ratingChange: 59,
          problemCount: 6,
          acceptedCount: 4,
          problems: [{ id: '323650' }, { id: '323656' }],
        }),
      ],
    };
    const contests = deriveParticipatedContests(db, { sources });
    assert.deepEqual(contests.map((c) => c.key), ['nowcoder:140489']);
    const c = contests[0]!;
    assert.equal(c.submissionCount, 2, '题目集排歧：窗口内的题库练习题不归因');
    // problemCount 是「该场共几题」（平台参赛记录 6），不是「我交过几题」（本地 2）
    assert.equal(c.problemCount, 6, '总题数取平台参赛记录/题目集，而不是本地提交去重');
    assert.equal(c.acProblemCount, 2);

    const review = resolveContestGroup(db, 'nowcoder:140489', { sources })!;
    assert.equal(review.submissions.length, 2);
    const md = renderContestContext(review);
    assert.match(md, /323650/);
    assert.doesNotMatch(md, /320640/);

    // 题目集缺失（拉取失败）时退化为整窗归因：窗口内 3 条全归因
    const degraded = deriveParticipatedContests(db, {
      sources: {
        nowcoder: [
          srcEntry('nowcoder', '140489', {
            startTimeMs: Date.parse('2026-09-20T11:00:00.000Z'),
            endTimeMs: Date.parse('2026-09-20T13:00:00.000Z'),
            problems: null,
          }),
        ],
      },
    })[0]!;
    assert.equal(degraded.submissionCount, 3, '无题目集时退化为整窗归因');
  } finally {
    db.close();
  }
});

test('列表总题数 = 该场题目总数（牛客周赛162：共 6 题、交了 4 题全 AC → 6 题 AC 4）', () => {
  const db = createDb(':memory:');
  try {
    // 只提交了 A/B/C/D 四题且全 AC；E/F 赛时未开（真实用户反馈的场景）
    seedAll(db, [
      { platform: 'nowcoder', problemKey: '323650', title: '小月的贴纸', verdict: 'AC', submittedAt: '2026-09-20T11:10:10.000Z', externalId: 'n1', context: null },
      { platform: 'nowcoder', problemKey: '323652', title: '小月的周长', verdict: 'AC', submittedAt: '2026-09-20T11:20:00.000Z', externalId: 'n2', context: null },
      { platform: 'nowcoder', problemKey: '323654', title: '小月的数码轮', verdict: 'AC', submittedAt: '2026-09-20T11:40:00.000Z', externalId: 'n3', context: null },
      { platform: 'nowcoder', problemKey: '323656', title: '小月的字带', verdict: 'AC', submittedAt: '2026-09-20T12:13:07.000Z', externalId: 'n4', context: null },
    ]);
    const problems = ['323650', '323652', '323654', '323656', '323658', '323660'].map((id) => ({ id }));
    const sources = {
      nowcoder: [
        srcEntry('nowcoder', '140489', {
          name: '牛客周赛 Round 162',
          url: 'https://ac.nowcoder.com/acm/contest/140489',
          startTimeMs: Date.parse('2026-09-20T11:00:00.000Z'),
          endTimeMs: Date.parse('2026-09-20T13:00:00.000Z'),
          problemCount: 6,
          acceptedCount: 4,
          problems,
        }),
      ],
    };
    const c = deriveParticipatedContests(db, { sources })[0]!;
    assert.equal(c.problemCount, 6, '总题数是该场 6 题，不是「我交过的 4 题」');
    assert.equal(c.acProblemCount, 4);
    assert.equal(c.submissionCount, 4);

    // 复盘上下文同样按 6 题算：未提交的 E/F 要列出来
    const review = resolveContestGroup(db, 'nowcoder:140489', { sources })!;
    assert.equal(review.problemSetKnown, true);
    assert.deepEqual(
      review.unsubmittedProblems.map((p) => p.id),
      ['323658', '323660'],
      '未提交的题 = 题目集 − 已提交',
    );
    assert.match(renderContestContext(review), /全场 6 题中 AC 4 题、未提交 2 题/);
  } finally {
    db.close();
  }
});

test('洛谷有参赛记录时：按官方窗口归因 T 号题提交，公开日历时间窗回退关闭', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      // 纳新题（团队赛，窗口 09-24 ~ 12-01）窗口内的 T 号题提交 → 归因到场
      { platform: 'luogu', problemKey: 'T822401', verdict: 'WA', submittedAt: '2026-09-25T05:10:43.000Z', externalId: 'l1' },
      { platform: 'luogu', problemKey: 'T822413', verdict: 'AC', submittedAt: '2026-09-25T05:14:30.000Z', externalId: 'l2' },
      // 同窗口内的 P 号练习题 → 不归因（长窗口团队赛期间的日常练习）
      { platform: 'luogu', problemKey: 'P1001', verdict: 'AC', submittedAt: '2026-09-25T06:00:00.000Z', externalId: 'l3' },
    ]);
    const sources = {
      luogu: [
        srcEntry('luogu', '357001', {
          name: 'qu 第一次纳新题',
          url: 'https://www.luogu.com.cn/contest/357001',
          startTimeMs: Date.parse('2026-09-24T13:32:00.000Z'),
          endTimeMs: Date.parse('2026-12-01T13:32:00.000Z'),
          problemCount: 8,
        }),
      ],
    };
    // 日历里放同期公开月赛：无参赛记录来源时它会被时间窗误判，有来源时必须消失
    const calendar = CAL.filter((c) => c.platform === 'luogu');
    const contests = deriveParticipatedContests(db, { calendar, sources });
    assert.deepEqual(contests.map((c) => c.key), ['luogu:357001'], 'LGR 月赛误判不再出现，团队赛入列');
    const c = contests[0]!;
    assert.equal(c.name, 'qu 第一次纳新题');
    assert.equal(c.submissionCount, 2, '只归因 T 号比赛题提交');
    // 总题数用洛谷参赛记录里的 8 题（本地只交了 2 题）
    assert.equal(c.problemCount, 8);
  } finally {
    db.close();
  }
});

test('provider 映射：CF user.rating / AtCoder history（stub fetch，不访问外网）', async () => {
  const cal = calendarIndex([
    { id: 'cf-2266', platform: 'codeforces', name: 'CF1122', category: '', startTimeIso: '2026-09-21T14:35:00.000Z', durationMinutes: 120, phase: 'FINISHED', url: 'https://codeforces.com/contest/2266' },
  ]);
  const cfFetch: typeof fetch = (async () =>
    new Response(JSON.stringify({
      status: 'OK',
      result: [
        { contestId: 2266, contestName: 'Codeforces Round 1122 (Div. 3)', rank: 15005, oldRating: 955, newRating: 949, ratingUpdateTimeSeconds: Date.parse('2026-09-21T16:35:00.000Z') / 1000 },
        { contestId: 2310, contestName: 'Educational Round', rank: 8000, oldRating: 900, newRating: 955, ratingUpdateTimeSeconds: Date.parse('2026-10-01T16:00:00.000Z') / 1000 },
      ],
    }), { status: 200 })) as typeof fetch;
  const cf = await fetchCodeforcesParticipation('hieZF123', cal, cfFetch);
  assert.equal(cf.length, 2);
  assert.deepEqual(
    cf[0],
    {
      platform: 'codeforces', contestId: '2266', name: 'Codeforces Round 1122 (Div. 3)',
      url: 'https://codeforces.com/contest/2266',
      startTimeMs: Date.parse('2026-09-21T14:35:00.000Z'), endTimeMs: Date.parse('2026-09-21T16:35:00.000Z'),
      rank: 15005, rating: 949, ratingChange: -6, problemCount: null, acceptedCount: null,
    },
    '日历命中的场次用官方起止时间',
  );
  // 日历没有的场次：结束时间回推 2h 近似窗口
  assert.equal(cf[1]!.startTimeMs, Date.parse('2026-10-01T14:00:00.000Z'));

  const atFetch: typeof fetch = (async () =>
    new Response(JSON.stringify([
      { ContestScreenName: 'abc459.contest.atcoder.jp', ContestName: 'ABC459', EndTimeStamp: Date.parse('2026-05-23T13:40:00.000Z') / 1000, Place: 8970, IsRated: true, OldRating: 0, NewRating: 34 },
      { ContestScreenName: 'abc458', ContestName: 'ABC458', EndTimeStamp: Date.parse('2026-05-16T13:40:00.000Z') / 1000, Place: 5000, IsRated: false, OldRating: 34, NewRating: 34 },
    ]), { status: 200 })) as typeof fetch;
  const at = await fetchAtcoderParticipation('hieZF123', calendarIndex([]), atFetch);
  assert.equal(at[0]!.contestId, 'abc459', 'slug 剥掉 .contest.atcoder.jp 后缀');
  assert.equal(at[0]!.rank, 8970);
  assert.equal(at[0]!.rating, 34);
  assert.equal(at[1]!.rating, null, 'unrated 场次不携带 rating');
});

test('provider 映射：AtCoder 日历命中时用日历规范名（history ContestName 有脏值）', async () => {
  // 实测页面出现过「AtCoder Regular Contest-- 219」：history 的 ContestName 偶有脏值，
  // 日历（官方 contests 页解析）恒为规范名，命中 slug 时必须优先
  const cal = calendarIndex([
    {
      id: 'at-arc219',
      platform: 'atcoder',
      name: 'AtCoder Regular Contest 219',
      category: 'ARC',
      startTimeIso: '2026-05-10T12:00:00.000Z',
      durationMinutes: 120,
      phase: 'FINISHED',
      url: 'https://atcoder.jp/contests/arc219',
    },
  ]);
  const atFetch: typeof fetch = (async () =>
    new Response(JSON.stringify([
      { ContestScreenName: 'arc219.contest.atcoder.jp', ContestName: 'AtCoder Regular Contest-- 219', EndTimeStamp: Date.parse('2026-05-10T14:00:00.000Z') / 1000, Place: 1458, IsRated: true, OldRating: 0, NewRating: 100 },
    ]), { status: 200 })) as typeof fetch;
  const at = await fetchAtcoderParticipation('hieZF123', cal, atFetch);
  assert.equal(at[0]!.name, 'AtCoder Regular Contest 219', '日历命中的场次用规范名');
  // 日历未命中：回退 ContestName 原文（不臆造）
  const at2 = await fetchAtcoderParticipation('hieZF123', calendarIndex([]), atFetch);
  assert.equal(at2[0]!.name, 'AtCoder Regular Contest-- 219');
});

test('provider 映射：洛谷 joinedContests / 牛客 joined-history 分页与增量（stub fetch）', async () => {
  const lgRow = (id: number): unknown => ({ id, name: `洛谷比赛 ${id}`, startTime: 1790000000 - id * 86400, endTime: 1790010000, problemCount: 5 });
  let lgCalls = 0;
  const lgFetch: typeof fetch = (async (input: string | URL | Request) => {
    lgCalls += 1;
    const page = Number(new URL(String(input)).searchParams.get('page'));
    return new Response(JSON.stringify({
      contests: { result: page <= 2 ? [lgRow(page), lgRow(page + 10)] : [], count: 4, perPage: 2 },
    }), { status: 200 });
  }) as typeof fetch;
  // 首次全量：翻到列表末尾
  const lgFull = await fetchLuoguJoinedContests('_uid=1; __client_id=x', { backlogDone: false }, lgFetch);
  assert.equal(lgCalls, 2, '第 3 页空结果停止翻页');
  assert.equal(lgFull.items.length, 4);
  assert.equal(lgFull.truncated, false);
  assert.equal(lgFull.items[0]!.startTimeMs, (1790000000 - 1 * 86400) * 1000);
  // 增量：backlog 已完成 + 库内最旧 = 第 1 页最旧值 → 第 1 页即触及终止条件，只拉 1 页
  lgCalls = 0;
  const lgIncr = await fetchLuoguJoinedContests('_uid=1; __client_id=x', {
    backlogDone: true,
    knownOldestMs: (1790000000 - 11 * 86400) * 1000,
  }, lgFetch);
  assert.equal(lgCalls, 1, '第 1 页触及库内最旧记录即提前终止');
  assert.equal(lgIncr.items.length, 2);
  assert.equal(lgIncr.truncated, false);
  // 单次上限：maxPages=1 且 backlog 未完成 → truncated 标记，下次续拉
  lgCalls = 0;
  const lgCap = await fetchLuoguJoinedContests('_uid=1; __client_id=x', { backlogDone: false, maxPages: 1 }, lgFetch);
  assert.equal(lgCalls, 1);
  assert.equal(lgCap.truncated, true, '触及单次上限截断');
  assert.equal(lgCap.items.length, 2);

  const ncRow = (id: number, ratingStatus?: string): unknown => ({
    contestId: id,
    contestName: `牛客比赛 ${id}`,
    startTime: 1790334000000,
    endTime: 1790344800000,
    rank: 10,
    // 占位逻辑与真实接口一致：未结算/不计分时 rating 恒为 1000
    rating: ratingStatus === 'FINISHED' ? 876 : 1000,
    ratingStr: ratingStatus === 'FINISHED' ? '876' : ratingStatus === 'WAITING' ? '计算中' : '不计',
    ratingStatus,
    changeValue: ratingStatus === 'FINISHED' ? 59 : 0,
    problemCount: 6,
    acceptedCount: 4,
  });
  let ncCalls = 0;
  const ncFetch: typeof fetch = (async () => {
    ncCalls += 1;
    const status = ncCalls === 1 ? 'FINISHED' : ncCalls === 2 ? 'WAITING' : 'NO';
    return new Response(JSON.stringify({
      data: { dataList: [ncRow(ncCalls, status)], pageInfo: { pageCount: 2, totalCount: 20 } },
    }), { status: 200 });
  }) as typeof fetch;
  const nc = await fetchNowcoderJoinedContests('713093328', { backlogDone: false }, ncFetch);
  assert.equal(ncCalls, 2, '按 pageCount 翻页');
  assert.deepEqual(nc.items.map((c) => c.contestId), ['1', '2']);
  assert.equal(nc.items[0]!.rank, 10);
  assert.equal(nc.items[0]!.rating, 876, '结算完成（FINISHED）的 rating 采信');
  assert.equal(nc.items[0]!.ratingChange, 59);
  assert.equal(nc.items[1]!.rating, null, '计算中（WAITING）时 rating=1000 是占位值，不采信');
  assert.equal(nc.items[1]!.ratingChange, null);

  // 缺 Cookie / 缺账号 → 直接抛错（由聚合层记入 failures）
  await assert.rejects(fetchLuoguJoinedContests('', { backlogDone: false }, lgFetch), /未配置洛谷 Cookie/);
  await assert.rejects(fetchNowcoderJoinedContests('', { backlogDone: false }, ncFetch), /未绑定牛客账号/);
});

test('拉取落库与增量：fresh 状态不发请求，过期平台重拉并更新游标，失败回退库内数据', async () => {
  const db = createDb(':memory:');
  try {
    // 建一道牛客题 + 绑定账号的提交（账号来自 submissions.account）
    const pid = Number(
      db.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('nowcoder', '1', 'NC 题')").run().lastInsertRowid,
    );
    db.prepare(
      'INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id) VALUES (1, ?, ?, ?, ?, ?, ?)',
    ).run('nowcoder', '713093328', pid, 'AC', '2026-09-01T00:00:00.000Z', 'nc-seed');

    // 第一次：无状态 → 全量拉取并落库
    let fetches = 0;
    const fetchOnce: typeof fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        data: {
          dataList: [{
            contestId: 140237, contestName: '牛客挑战赛92', startTime: 1790334000000, endTime: 1790344800000,
            rank: 60, rating: 1000, ratingStr: '计算中', ratingStatus: 'WAITING', changeValue: 0,
            problemCount: 6, acceptedCount: 2,
          }],
          pageInfo: { pageCount: 1, totalCount: 1 },
        },
      }), { status: 200 });
    }) as typeof fetch;
    const first = await loadParticipationSources(db, undefined, { fetchFn: fetchOnce });
    assert.equal(fetches, 1);
    assert.equal(first.byPlatform.nowcoder?.length, 1);
    assert.equal(first.failures.nowcoder, undefined);
    // WAITING 占位不落库
    assert.equal(first.byPlatform.nowcoder?.[0]!.rating, null);

    // 第二次：30 分钟内（fresh）→ 不发请求，直接读库
    const second = await loadParticipationSources(db, undefined, { fetchFn: fetchOnce });
    assert.equal(fetches, 1, 'fresh 状态直接读库');
    assert.equal(second.byPlatform.nowcoder?.length, 1);

    // 过期：把 last_sync_at 拨回 2 小时前 → 重新拉取（增量第 1 页，仍是同一场 → 无新增）
    db.prepare('UPDATE participation_sync SET last_sync_at = ?').run(new Date(Date.now() - 7_200_000).toISOString());
    const third = await loadParticipationSources(db, undefined, { fetchFn: fetchOnce });
    assert.equal(fetches, 2, '过期后重新拉取');
    assert.equal(third.byPlatform.nowcoder?.length, 1, '增量合并不产生重复');

    // 拉取失败（网络挂）：先过期再重试 → 回退库内已有数据，错误记入 failures
    db.prepare('UPDATE participation_sync SET last_sync_at = ?').run(new Date(Date.now() - 7_200_000).toISOString());
    const failing: typeof fetch = (async () => new Response('', { status: 500 })) as typeof fetch;
    const fourth = await loadParticipationSources(db, undefined, { fetchFn: failing });
    assert.match(fourth.failures.nowcoder ?? '', /500/);
    assert.equal(fourth.byPlatform.nowcoder?.length, 1, '失败时回退库内数据');

    // 状态表记录了 last_error
    const state = db.prepare("SELECT last_error FROM participation_sync WHERE platform = 'nowcoder'").get() as { last_error: string };
    assert.match(state.last_error, /500/);
  } finally {
    db.close();
  }
});

// ---------- 赛时未提交的题（题目集 − 本地提交） ----------

test('复盘上下文列出「赛时未提交的题」：题目集已知但本地无提交的题带题号/题名/链接', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      { platform: 'nowcoder', problemKey: '323650', title: '小月的贴纸', verdict: 'AC', submittedAt: '2026-09-20T11:10:10.000Z', externalId: '84759685', context: null },
      { platform: 'nowcoder', problemKey: '323656', title: '小月的字带', verdict: 'AC', submittedAt: '2026-09-20T12:13:07.000Z', externalId: '84764578', context: null },
    ]);
    const sources = {
      nowcoder: [
        srcEntry('nowcoder', '140489', {
          name: '牛客周赛 Round 162',
          startTimeMs: Date.parse('2026-09-20T11:00:00.000Z'),
          endTimeMs: Date.parse('2026-09-20T13:00:00.000Z'),
          problemCount: 4,
          acceptedCount: 2,
          problems: [
            { id: '323650', index: 'A', title: '小月的贴纸' },
            { id: '323656', index: 'B', title: '小月的字带' },
            { id: '323662', index: 'C', title: '小月的项链' },
            { id: '323670', index: 'D', title: '小月的棋盘' },
          ],
        }),
      ],
    };
    const review = resolveContestGroup(db, 'nowcoder:140489', { sources })!;
    assert.equal(review.problemSetKnown, true);
    assert.deepEqual(
      review.unsubmittedProblems.map((p) => `${p.index} ${p.title}`),
      ['C 小月的项链', 'D 小月的棋盘'],
      '未提交题 = 题目集 − 本地提交',
    );

    const md = renderContestContext(review);
    assert.match(md, /概况：全场 4 题中 AC 2 题、未提交 2 题，共 2 次提交/, '概况按题目集全集口径');
    assert.match(md, /### 未提交的题（题目集已知但本地无任何提交，共 2 题）/);
    assert.match(md, /- C 小月的项链/);
    assert.match(md, /- D 小月的棋盘，题目链接：https:\/\/ac\.nowcoder\.com\/acm\/problem\/323670/);
  } finally {
    db.close();
  }
});

test('零提交场次：题目集已知时全部题目以「未提交的题」呈现', () => {
  const db = createDb(':memory:');
  try {
    const sources = {
      nowcoder: [
        srcEntry('nowcoder', '140237', {
          name: '牛客挑战赛 92',
          rank: 371,
          problems: [
            { id: '320779', index: 'A', title: '无理无智' },
            { id: '320781', index: 'B', title: '绝体绝命' },
          ],
        }),
      ],
    };
    const review = resolveContestGroup(db, 'nowcoder:140237', { sources })!;
    assert.equal(review.submissions.length, 0);
    assert.equal(review.unsubmittedProblems.length, 2);
    const md = renderContestContext(review);
    assert.match(md, /### 未提交的题（题目集已知但本地无任何提交，共 2 题）/);
    assert.match(md, /- A 无理无智/);
    assert.match(md, /逐条提交记录尚未同步到本地/, '缺提交的降级说明保留');
  } finally {
    db.close();
  }
});

test('旧格式 problem_ids（纯 id 字符串数组）兼容解析：归因与题目集判定不受影响', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      { platform: 'nowcoder', problemKey: '323650', title: '小月的贴纸', verdict: 'AC', submittedAt: '2026-09-20T11:10:10.000Z', externalId: '84759685', context: null },
      // 窗口内但不在题目集里的题库题 → 不归因
      { platform: 'nowcoder', problemKey: '320640', title: '小月的立方体', verdict: 'AC', submittedAt: '2026-09-20T11:04:31.000Z', externalId: '84576646', context: null },
    ]);
    // 直接以旧格式（string[]）写入 problem_ids 列，模拟升级前的存量数据
    db.prepare(
      `INSERT INTO participated_contests
         (user_id, platform, account, contest_id, name, url, start_ms, end_ms,
          contest_rank, rating, rating_change, problem_count, accepted_count, problem_ids, fetched_at)
       VALUES (1, 'nowcoder', 'nc-uid', '140489', '牛客周赛 Round 162', 'https://ac.nowcoder.com/acm/contest/140489',
               ?, ?, 371, 876, 59, 6, 4, ?, ?)`,
    ).run(
      String(Date.parse('2026-09-20T11:00:00.000Z')),
      String(Date.parse('2026-09-20T13:00:00.000Z')),
      JSON.stringify(['323650', '323656']),
      new Date().toISOString(),
    );
    db.prepare("UPDATE submissions SET account = 'nc-uid' WHERE platform = 'nowcoder'").run();

    const snapshot = readParticipationSnapshot(db);
    assert.ok(snapshot.byPlatform.nowcoder, '存量行应读出参赛记录');
    const review = resolveContestGroup(db, 'nowcoder:140489', { sources: snapshot.byPlatform })!;
    assert.equal(review.problemSetKnown, true, '旧格式解析后题目集视为已知');
    assert.equal(review.submissions.length, 1, '归因仍按旧题目集排歧：窗口内的题库练习题不归因');
    assert.deepEqual(
      review.unsubmittedProblems.map((p) => p.id),
      ['323656'],
    );
  } finally {
    db.close();
  }
});

// ---------- 复盘时的题目集按需补拉（fetchContestProblemSet） ----------

test('同步参赛记录：非牛客平台绝不调用牛客题目集接口（CF 2241 串台事故回归）', async () => {
  const db = createDb(':memory:');
  try {
    // 一个有参赛账号的 CF 场次：窗口内有提交（这正是历史上触发补题的入口条件）
    seedAll(db, [
      { platform: 'codeforces', problemKey: '2241A', title: 'Divide and Conquer', verdict: 'AC', submittedAt: '2026-06-30T15:25:32.000Z', externalId: 'cf1', context: 'contest' },
    ]);
    db.prepare('UPDATE submissions SET account = ? WHERE external_id = ?').run('hieZF123', 'cf1');

    const requested: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('user.rating')) {
        return new Response(
          JSON.stringify({
            status: 'OK',
            result: [
              {
                contestId: 2241,
                contestName: 'Codeforces Round 1107 (Div. 3)',
                rank: 9729,
                oldRating: 779,
                newRating: 923,
                ratingUpdateTimeSeconds: Date.parse('2026-06-30T14:35:00.000Z') / 1000,
              },
            ],
          }),
          { status: 200 },
        );
      }
      // 牛客题目集接口（历史 bug 就是拿 CF 的 contestId 来打这个接口）
      return new Response(
        JSON.stringify({
          msg: 'OK',
          code: 0,
          data: { data: [{ problemId: 54536, index: 'A', title: '小乐乐学编程' }] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await loadParticipationSources(db, undefined, { fetchFn });

    assert.ok(
      requested.some((u) => u.includes('user.rating')),
      'CF 参赛记录应被正常拉取',
    );
    assert.equal(
      requested.filter((u) => u.includes('ac.nowcoder.com/acm/contest/problem-list')).length,
      0,
      'CF 同步绝不能去打牛客题目集接口——这正是把牛客题目集写进 CF 场次的根因',
    );

    // 库里该 CF 场次不得出现被别人塞进来的题目集
    const row = db
      .prepare("SELECT problem_ids FROM participated_contests WHERE platform='codeforces' AND contest_id='2241'")
      .get() as { problem_ids: string | null } | undefined;
    assert.equal(row?.problem_ids ?? null, null, 'CF 行不应带任何题目集');
  } finally {
    db.close();
  }
});

test('fetchContestProblemSet：CF 优先走题目集缓存（零请求）；非 gym 的 standings 不得带 from/count', async () => {
  const db = createDb(':memory:');
  try {
    // ① problemset 缓存命中：完全不发请求
    db.prepare('INSERT INTO cf_problemset_cache (id, fetched_at, payload) VALUES (1, ?, ?)').run(
      new Date().toISOString(),
      JSON.stringify({
        '1877A': { tags: [], rating: 800, name: 'Rabbits', contestId: 1877, index: 'A' },
        '1877B': { tags: [], rating: 1600, name: 'Imbalanced Arrays', contestId: 1877, index: 'B' },
      }),
    );
    const warm = jsonFetch({});
    const fromCache = await fetchContestProblemSet(db, 'codeforces', '1877', warm.fetchFn);
    assert.equal(warm.calls(), 0, '题目集缓存命中时零请求');
    assert.deepEqual(
      fromCache.status === 'ok' ? fromCache.refs.map((r) => r.id) : null,
      ['1877A', '1877B'],
    );

    // ② 缓存里没有这场（新比赛）→ 退化到 standings：**非 gym 不能带 from/count**（CF 会 400）
    const urls: string[] = [];
    const standingsFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      urls.push(u);
      if (u.includes('problemset.problems')) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({
          status: 'OK',
          result: { problems: [{ index: 'A', name: 'Rabbits', rating: 800 }, { index: 'B', name: 'Imbalanced Arrays' }] },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const nonGym = await fetchContestProblemSet(db, 'codeforces', '2241', standingsFetch);
    const standingsUrl = urls.find((u) => u.includes('contest.standings')) ?? '';
    assert.ok(standingsUrl, '应退化到 contest.standings');
    assert.doesNotMatch(standingsUrl, /from=|count=/, '非 gym 场次带分页参数会被 CF 拒绝（实测 HTTP 400）');
    assert.deepEqual(
      nonGym.status === 'ok' ? nonGym.refs.map((r) => r.id) : null,
      ['2241A', '2241B'],
    );

    // ③ gym 场次才带分页参数（只取排行榜首行，避免整场数 MB）
    const urls2: string[] = [];
    const gymFetch = (async (input: string | URL | Request) => {
      const u = String(input);
      urls2.push(u);
      if (u.includes('problemset.problems')) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({ status: 'OK', result: { problems: [{ index: 'A', name: 'Gym A' }] } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await fetchContestProblemSet(db, 'codeforces', '105001', gymFetch);
    const gymUrl = urls2.find((u) => u.includes('contest.standings')) ?? '';
    assert.match(gymUrl, /from=1&count=1/, 'gym 允许分页参数，保持只取 1 行');
  } finally {
    db.close();
  }
});

function jsonFetch(routes: Record<string, unknown>): { fetchFn: typeof fetch; calls: () => number } {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const u = String(input);
    calls.push(u);
    for (const [needle, body] of Object.entries(routes)) {
      if (u.includes(needle)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls.length };
}

function seedAuthoritativeRow(db: Db, platform: string, contestId: string): void {
  db.prepare(
    `INSERT INTO participated_contests
       (user_id, platform, account, contest_id, name, url, start_ms, end_ms,
        contest_rank, rating, rating_change, problem_count, accepted_count, problem_ids, fetched_at)
     VALUES (1, ?, 'acc', ?, ?, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(platform, contestId, `${platform} 比赛 ${contestId}`, new Date().toISOString());
}

test('fetchContestProblemSet：CF contest.standings 解析 index/title/rating 并落库，退避期内不重拉', async () => {
  const db = createDb(':memory:');
  try {
    seedAuthoritativeRow(db, 'codeforces', '990001');
    const { fetchFn, calls } = jsonFetch({
      'contest.standings': {
        status: 'OK',
        result: {
          problems: [
            { index: 'A', name: 'Water Problem', rating: 800 },
            { index: 'B', name: 'Hard Problem' },
          ],
        },
      },
      // CF 分支会再查题目集全集缓存补官方 tags（空集 = 拿不到就不写）
      'problemset.problems': { status: 'OK', result: { problems: [] } },
    });
    const result = await fetchContestProblemSet(db, 'codeforces', '990001', fetchFn);
    const expectedRefs = [
      { id: '990001A', index: 'A', title: 'Water Problem', rating: 800 },
      { id: '990001B', index: 'B', title: 'Hard Problem', rating: null },
    ];
    assert.deepEqual(result, { status: 'ok', refs: expectedRefs });
    const row = db
      .prepare("SELECT problem_ids, problem_set_state FROM participated_contests WHERE platform='codeforces' AND contest_id='990001'")
      .get() as { problem_ids: string; problem_set_state: string };
    assert.deepEqual(JSON.parse(row.problem_ids), expectedRefs, '拉到的题目集应持久缓存');
    assert.equal(row.problem_set_state, 'ok', '题目集状态应持久缓存为 ok');

    // 退避期内：不再发请求、返回 unavailable（调用方沿用库内/既有数据）
    const beforeBackoff = calls();
    const backoffResult = await fetchContestProblemSet(db, 'codeforces', '990001', fetchFn);
    assert.equal(backoffResult.status, 'unavailable');
    assert.equal(calls(), beforeBackoff, '退避期内不重复任何外网请求');
  } finally {
    db.close();
  }
});

test('fetchContestProblemSet：AtCoder /contests/{slug}/tasks 解析题目集并修正串号题名', async () => {
  const db = createDb(':memory:');
  try {
    // 真实页面结构：每道题有「题号格 + 题名格」两个锚点（题名格文本更长，取它）
    const html = `<table><tbody>
      <tr><td><a href="/contests/abc454/tasks/abc454_a">A</a></td><td><a href="/contests/abc454/tasks/abc454_a">Closed interval</a></td></tr>
      <tr><td><a href="/contests/abc454/tasks/abc454_b">B</a></td><td><a href="/contests/abc454/tasks/abc454_b">Mapping</a></td></tr>
      <tr><td><a href="/contests/abc454/tasks/abc454_g?lang=en">G</a></td><td><a href="/contests/abc454/tasks/abc454_g?lang=en">Mode in the Subtree</a></td></tr>
      <tr><td><a href="/contests/other/tasks/other_a">X</a></td><td><a href="/contests/other/tasks/other_a">别的场次</a></td></tr>
      <tr><td><a href="/contests/abc454/tasks_print">一括表示</a></td></tr>
    </tbody></table>`;
    const fetchFn = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const result = await fetchContestProblemSet(db, 'atcoder', 'abc454', fetchFn);
    assert.deepEqual(result, {
      status: 'ok',
      refs: [
        { id: 'abc454_a', index: 'A', title: 'Closed interval' },
        { id: 'abc454_b', index: 'B', title: 'Mapping' },
        { id: 'abc454_g', index: 'G', title: 'Mode in the Subtree' },
      ],
    });

    // 失败路径：题目列表拿不到 → unavailable，不编造题目集
    const broken = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    assert.equal((await fetchContestProblemSet(db, 'atcoder', 'abc455', broken)).status, 'unavailable');
  } finally {
    db.close();
  }
});

test('fetchContestProblemSet：AtCoder 用官方题名修正库内被社区数据串号的 title', async () => {
  const db = createDb(':memory:');
  try {
    // 库内是 kenkoooo 社区数据：题名文字对、字母前缀错（实测 abc454_b → 「C. Mapping」）
    // 注意用独立场次 id：fetchContestProblemSet 有 5 分钟进程内退避（同 id 第二次直接 unavailable）
    for (const [key, title] of [
      ['abc456_a', 'A. Closed interval'],
      ['abc456_b', 'C. Mapping'],
      ['abc456_c', 'F. Straw Millionaire'],
    ] as const) {
      db.prepare('INSERT INTO problems (platform, problem_key, title, tags) VALUES (?, ?, ?, ?)').run(
        'atcoder',
        key,
        title,
        '[]',
      );
    }
    const html = `<tbody>
      <tr><td><a href="/contests/abc456/tasks/abc456_a">A</a></td><td><a href="/contests/abc456/tasks/abc456_a">Closed interval</a></td></tr>
      <tr><td><a href="/contests/abc456/tasks/abc456_b">B</a></td><td><a href="/contests/abc456/tasks/abc456_b">Mapping</a></td></tr>
      <tr><td><a href="/contests/abc456/tasks/abc456_c">C</a></td><td><a href="/contests/abc456/tasks/abc456_c">Straw Millionaire</a></td></tr>
    </tbody>`;
    const fetchFn = (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;
    const result = await fetchContestProblemSet(db, 'atcoder', 'abc456', fetchFn);
    assert.equal(result.status, 'ok', '题目集应抓到（否则修正不会发生）');

    const rows = db
      .prepare("SELECT problem_key, title FROM problems WHERE platform = 'atcoder' ORDER BY problem_key")
      .all() as Array<{ problem_key: string; title: string }>;
    // node:sqlite 返回 null 原型对象：转成普通对象再做严格深比较
    const titles = rows.map((r) => ({ problem_key: r.problem_key, title: r.title }));
    assert.deepEqual(titles, [
      { problem_key: 'abc456_a', title: 'A. Closed interval' },
      { problem_key: 'abc456_b', title: 'B. Mapping' },
      { problem_key: 'abc456_c', title: 'C. Straw Millionaire' },
    ]);
  } finally {
    db.close();
  }
});

test('fetchContestProblemSet：牛客 problem-list 解析 index/title；失败返回 unavailable（不落库）', async () => {
  const db = createDb(':memory:');
  try {
    seedAuthoritativeRow(db, 'nowcoder', '990002');
    const { fetchFn } = jsonFetch({
      'problem-list': {
        msg: 'OK',
        code: 0,
        data: {
          data: [
            { problemId: 320779, index: 'A', title: '无理无智' },
            { problemId: 320781, index: 'B', title: '绝体绝命' },
          ],
        },
      },
    });
    const result = await fetchContestProblemSet(db, 'nowcoder', '990002', fetchFn);
    assert.deepEqual(result, {
      status: 'ok',
      refs: [
        { id: '320779', index: 'A', title: '无理无智' },
        { id: '320781', index: 'B', title: '绝体绝命' },
      ],
    });

    // 失败路径：接口 500 → unavailable，且不落库（用另一场比赛 id 避开退避键）
    const broken = (async () => new Response('server error', { status: 500 })) as unknown as typeof fetch;
    const failResult = await fetchContestProblemSet(db, 'nowcoder', '990003', broken);
    assert.equal(failResult.status, 'unavailable');
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM participated_contests WHERE contest_id='990003'")
      .get() as { n: number };
    assert.equal(n.n, 0, '失败不落库');
  } finally {
    db.close();
  }
});



// ---------- 洛谷比赛题目集：转正 P 号提交的精确归因（2026-10 用户实测回归） ----------

/** 比赛详情页内嵌 JSON 片段（脱敏自 LGR-310 实测抓包） */
const LUOGU_CONTEST_HTML =
  '<script>window.__INITIAL_STATE__={"contest":{"name":"月赛"},"contestProblems":' +
  '[{"score":100,"problem":{"pid":"P17538","type":"P","name":"音符方阵","difficulty":2,"fullScore":100},"no":"A"},' +
  '{"score":100,"problem":{"pid":"P17539","type":"P","name":"日月同错","difficulty":4,"fullScore":100},"no":"B"},' +
  '{"score":100,"problem":{"pid":"P17540","type":"P","name":"发迹","difficulty":6,"fullScore":100},"no":"C"}]' +
  ',"canViewScoreboard":true};</script>';

test('fetchLuoguContestProblems：解析比赛页 contestProblems（含 C3VK 302 挑战重试）', async () => {
  let calls = 0;
  const fetchStub: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      // 首请求 302 回自身并下发新 C3VK（洛谷反爬协议）
      return new Response(null, { status: 302, headers: { 'Set-Cookie': 'C3VK=fresh-token; Path=/' } });
    }
    return new Response(LUOGU_CONTEST_HTML, { status: 200 });
  };
  const refs = await fetchLuoguContestProblems('278842', '', fetchStub);
  assert.equal(calls, 2, '首请求 302 后必须带新 C3VK 重试');
  assert.deepEqual(
    refs,
    [
      { id: 'P17538', index: 'A', title: '音符方阵' },
      { id: 'P17539', index: 'B', title: '日月同错' },
      { id: 'P17540', index: 'C', title: '发迹' },
    ],
  );
});

test('fetchLuoguContestProblems：页面缺 contestProblems / 非 JSON → 返回 null（归因退回 T 号）', async () => {
  const noData = await fetchLuoguContestProblems(
    '1',
    '',
    (async () => new Response('<html>权限墙</html>', { status: 200 })) as typeof fetch,
  );
  assert.equal(noData, null);
  const httpFail = await fetchLuoguContestProblems(
    '1',
    '',
    (async () => new Response('nope', { status: 500 })) as typeof fetch,
  );
  assert.equal(httpFail, null);
});

test('洛谷归因：题目集已知时按「窗口内 + 属于该场」精确匹配（转正 P 号计入、练习题不误归）', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      // 月赛窗口内的比赛题提交（转正后 P 号键，与题目集成员一致）
      { platform: 'luogu', problemKey: 'P17538', verdict: 'AC', submittedAt: '2026-09-30T10:11:49.000Z', externalId: 'l1' },
      { platform: 'luogu', problemKey: 'P17539', verdict: 'WA', submittedAt: '2026-09-30T10:26:48.000Z', externalId: 'l2' },
      // 窗口内的练习题（不在题目集）：不得误归进场
      { platform: 'luogu', problemKey: 'P10001', verdict: 'AC', submittedAt: '2026-09-30T11:00:00.000Z', externalId: 'l3' },
      // 比赛题但提交在窗口外（赛后补题）：不算赛时逐条提交
      { platform: 'luogu', problemKey: 'P17540', verdict: 'AC', submittedAt: '2026-10-02T02:00:00.000Z', externalId: 'l4' },
    ]);
    const sources = {
      luogu: [
        srcEntry('luogu', '278842', {
          name: '【LGR-310-Div.2】洛谷 9 月月赛 II',
          url: 'https://www.luogu.com.cn/contest/278842',
          startTimeMs: Date.parse('2026-09-30T10:00:00.000Z'),
          endTimeMs: Date.parse('2026-09-30T15:00:00.000Z'),
          problemCount: 4,
          problems: [
            { id: 'P17538', index: 'A', title: '音符方阵' },
            { id: 'P17539', index: 'B', title: '日月同错' },
            { id: 'P17540', index: 'C', title: '发迹' },
            { id: 'P17541', index: 'D', title: '25HRS' },
          ],
        }),
      ],
    };
    const contests = deriveParticipatedContests(db, { sources });
    assert.equal(contests.length, 1);
    const c = contests[0]!;
    assert.equal(c.key, 'luogu:278842');
    assert.equal(c.submissionCount, 2, '窗口内且属于该场的 2 条提交计入');
    assert.equal(c.problemCount, 4, '总题数来自参赛记录');
    assert.equal(c.acProblemCount, 1);
  } finally {
    db.close();
  }
});

test('洛谷归因：题目集未知时退回 T 号 × 窗口（P 号宁缺毋滥，不猜）', () => {
  const db = createDb(':memory:');
  try {
    seedAll(db, [
      { platform: 'luogu', problemKey: 'T822401', verdict: 'AC', submittedAt: '2026-09-24T13:40:00.000Z', externalId: 't1' },
      { platform: 'luogu', problemKey: 'P17538', verdict: 'AC', submittedAt: '2026-09-24T13:50:00.000Z', externalId: 'p1' },
    ]);
    const sources = {
      luogu: [
        srcEntry('luogu', '357001', {
          startTimeMs: Date.parse('2026-09-24T13:32:00.000Z'),
          endTimeMs: Date.parse('2026-09-24T15:00:00.000Z'),
          problemCount: 8,
          problems: null,
        }),
      ],
    };
    const contests = deriveParticipatedContests(db, { sources });
    assert.equal(contests[0]!.submissionCount, 1, '只认窗口内的 T 号；P 号可能是练习题，不猜');
  } finally {
    db.close();
  }
});

test('fetchContestProblemSet：洛谷走比赛页并落库三态（复盘「未提交的题」同源）', async () => {
  const db = createDb(':memory:');
  try {
    db.prepare(
      `INSERT INTO participated_contests (user_id, platform, account, contest_id, name, fetched_at)
       VALUES (1, 'luogu', 'u', '278842', '月赛', ?)`,
    ).run(new Date().toISOString());
    const refs = await fetchContestProblemSet(
      db,
      'luogu',
      '278842',
      (async () => new Response(LUOGU_CONTEST_HTML, { status: 200 })) as typeof fetch,
    );
    assert.equal(refs.status, 'ok');
    const row = db
      .prepare("SELECT problem_ids, problem_set_state FROM participated_contests WHERE contest_id='278842'")
      .get() as { problem_ids: string; problem_set_state: string };
    assert.equal(row.problem_set_state, 'ok');
    assert.match(row.problem_ids, /P17538/);
  } finally {
    db.close();
  }
});

test('洛谷题目集后台预取：脱离同步任务异步落库，下次读库即可归因', async () => {
  __setLuoguProblemSetPrefetchForTest(0);
  const db = createDb(':memory:');
  try {
    // 账号（latestAccounts 从 submissions 推导）+ 窗口内提交 + 题目集缺失的参赛记录
    seedAll(db, [
      { platform: 'luogu', problemKey: 'P17538', verdict: 'AC', submittedAt: '2026-09-30T10:11:49.000Z', externalId: 'l1' },
    ]);
    db.prepare("UPDATE submissions SET account = '1892580'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('cookie.luogu', '_uid=1')").run();
    db.prepare(
      `INSERT INTO participated_contests
         (user_id, platform, account, contest_id, name, url, start_ms, end_ms, problem_count, fetched_at)
       VALUES (1, 'luogu', '1892580', '278842', '月赛', 'https://www.luogu.com.cn/contest/278842', ?, ?, 4, ?)`,
    ).run(Date.parse('2026-09-30T10:00:00.000Z'), Date.parse('2026-09-30T15:00:00.000Z'), new Date().toISOString());
    // 同步状态过期：让本轮真的去拉参赛记录
    db.prepare(
      "INSERT INTO participation_sync (user_id, platform, account, last_sync_at, backlog_done) VALUES (1, 'luogu', '1892580', ?, 1)",
    ).run(new Date(Date.now() - 60 * 60_000).toISOString());

    let joinedPages = 0;
    const fetchStub = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('joinedContests')) {
        joinedPages += 1;
        const rows = joinedPages === 1
          ? [{ id: 278842, name: '【LGR-310-Div.2】月赛', startTime: Date.parse('2026-09-30T10:00:00.000Z') / 1000, endTime: Date.parse('2026-09-30T15:00:00.000Z') / 1000, problemCount: 4 }]
          : [];
        return new Response(JSON.stringify({ contests: { result: rows, count: joinedPages === 1 ? 1 : 0, perPage: 20 } }), { status: 200 });
      }
      if (url.includes('/contest/')) return new Response(LUOGU_CONTEST_HTML, { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const sources = await loadParticipationSources(db, undefined, { fetchFn: fetchStub });
    assert.equal(
      sources.byPlatform.luogu?.[0]?.problems ?? null,
      null,
      '同步任务内联绝不抓洛谷比赛页（防 host 队列被占死、并发同步超时）',
    );
    await __flushLuoguProblemSetPrefetchForTest();
    const row = db
      .prepare("SELECT problem_ids, problem_set_state FROM participated_contests WHERE contest_id='278842'")
      .get() as { problem_ids: string; problem_set_state: string };
    assert.equal(row.problem_set_state, 'ok', '预取成功即落库');
    assert.match(row.problem_ids, /P17538/);
  } finally {
    db.close();
  }
});
