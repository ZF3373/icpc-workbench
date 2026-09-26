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
      '按最后提交时间倒序；纯练习组与零散 gym 被排除',
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
    assert.match(md, /#### 1877A Rabbits（难度 800｜tags: math）/);
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
  // 45 题 × 1 发 → 题目数上限 40 截断
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
  };
  const md = renderContestContext(manyProblems);
  assert.match(md, /明细已截断：仅渲染前 40 题 \/ 40 次提交/);

  // 单题 15 发 → 保留首尾各 5 条，中间省略
  const single: ContestReviewData = {
    contest: { ...manyProblems.contest, problemCount: 1, submissionCount: 15 },
    submissions: Array.from({ length: 15 }, (_, i) => ({
      ...row(0, new Date(Date.parse('2026-09-20T14:00:00.000Z') + i * 60_000).toISOString()),
      verdict: i === 14 ? 'AC' : 'WA',
    })),
  };
  const md2 = renderContestContext(single);
  assert.match(md2, /中间省略 5 次/);
  assert.match(md2, /\+00:00 WA（赛时）/, '开头的时间线保留');
  assert.match(md2, /\+14:00 AC（赛时）/, '最终的 AC 保留在末尾');
});

// ---------- 平台参赛记录（权威数据源）合并 ----------

import type { AuthoritativeContest, FetchParticipationOptions } from '../src/contests/participationSources.ts';
import {
  fetchAtcoderParticipation,
  fetchCodeforcesParticipation,
  fetchLuoguJoinedContests,
  fetchNowcoderJoinedContests,
  loadParticipationSources,
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
          problemIds: ['323650', '323656'],
        }),
      ],
    };
    const contests = deriveParticipatedContests(db, { sources });
    assert.deepEqual(contests.map((c) => c.key), ['nowcoder:140489']);
    const c = contests[0]!;
    assert.equal(c.submissionCount, 2, '题目集排歧：窗口内的题库练习题不归因');
    assert.equal(c.problemCount, 2);
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
            problemIds: null,
          }),
        ],
      },
    })[0]!;
    assert.equal(degraded.submissionCount, 3, '无题目集时退化为整窗归因');
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
    assert.equal(c.problemCount, 2);
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

