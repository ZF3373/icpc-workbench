/**
 * 能力值算法（加权解题证据模型 + 赛事中心 rating 锚点 + 缓慢校准）测试。
 * 纯函数（因子/加权中位数/校准步长/rating 证据）直接断言；DB 行为用内存库 + 固定 now 保证确定性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import {
  ABILITY_STATE_KEY,
  attemptFactor,
  calibrateStep,
  collectSolveEvidence,
  computeAbility,
  computeAbilityDetail,
  contextFactor,
  estimateBreakdown,
  intentFactor,
  performanceAdjustment,
  qualityWeight,
  recencyWeight,
  spanFactor,
  weightedBase,
  weightedMedian,
  type SolveEvidence,
} from '../src/today/ability.ts';
import {
  ATCODER_CF_CEIL,
  ATCODER_CF_FLOOR,
  RATING_ANCHOR_MAX_WEIGHT,
  RATING_TREND_CAP,
  collectRatedContests,
  ratingEvidence,
  renderRatingEvidence,
  type RatedContestRecord,
} from '../src/today/abilityRating.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 固定"现在"，所有时间相对它构造，保证断言确定 */
const NOW = new Date('2026-09-23T12:00:00.000Z');
const HALF_LIFE = 45 * DAY;

const daysAgo = (d: number): string => new Date(NOW.getTime() - d * DAY).toISOString();

const ev = (over: Partial<SolveEvidence> = {}): SolveEvidence => ({
  problemId: 1,
  difficulty: 1500,
  attempts: 1,
  spanMs: 0,
  ageMs: 0,
  context: null,
  intent: null,
  ...over,
});

// ---------- 降权因子 ----------

test('attemptFactor：一发满权重，多试衰减，0.5 封底', () => {
  assert.equal(attemptFactor(1), 1);
  assert.ok(Math.abs(attemptFactor(3) - 0.84) < 1e-9);
  assert.equal(attemptFactor(10), 0.5);
  assert.equal(attemptFactor(50), 0.5);
});

test('spanFactor：同场满权重，跨天补题/长磨题逐档降权', () => {
  assert.equal(spanFactor(2 * HOUR), 1.0); // 比赛现场/单次练习
  assert.equal(spanFactor(12 * HOUR), 0.85);
  assert.equal(spanFactor(2 * DAY), 0.7);
  assert.equal(spanFactor(10 * DAY), 0.55);
  assert.equal(spanFactor(30 * DAY), 0.45); // 拖一个月的补题
});

test('contextFactor：practice 降权，contest/virtual/未知平台满权重', () => {
  assert.equal(contextFactor('contest'), 1);
  assert.equal(contextFactor('virtual'), 1);
  assert.equal(contextFactor('practice'), 0.85);
  assert.equal(contextFactor(null), 1); // 不下发语境的平台
});

test('intentFactor：看题解/完全不会/赛后补题打折最狠，未知 outcome 不打折', () => {
  assert.equal(intentFactor('cant_start'), 0.45);
  assert.equal(intentFactor('editorial'), 0.45);
  assert.equal(intentFactor('upsolved'), 0.45);
  assert.equal(intentFactor('wrong_approach'), 0.7);
  assert.equal(intentFactor('implementation'), 0.85);
  assert.equal(intentFactor('slight_bug'), 0.95);
  assert.equal(intentFactor(null), 1);
  assert.equal(intentFactor('mystery'), 1);
});

test('recencyWeight：半衰期指数衰减', () => {
  assert.equal(recencyWeight(0, HALF_LIFE), 1);
  assert.ok(Math.abs(recencyWeight(HALF_LIFE, HALF_LIFE) - 0.5) < 1e-9);
  assert.ok(recencyWeight(2 * HALF_LIFE, HALF_LIFE) < 0.26);
});

test('qualityWeight：各因子相乘，WEIGHT_FLOOR 封底', () => {
  assert.equal(qualityWeight(ev(), HALF_LIFE), 1);
  // 全部打折叠乘后触底
  assert.equal(
    qualityWeight(ev({ attempts: 10, spanMs: 30 * DAY, context: 'practice', intent: 'cant_start' }), HALF_LIFE),
    0.25,
  );
});

// ---------- 加权中位数与离群保护 ----------

test('weightedMedian：权重过半取值，空表返回 null', () => {
  assert.equal(weightedMedian([]), null);
  assert.equal(weightedMedian([{ difficulty: 1500, weight: 0.01 }]), 1500);
  assert.equal(
    weightedMedian([
      { difficulty: 1200, weight: 1 },
      { difficulty: 1300, weight: 1 },
      { difficulty: 2500, weight: 0.2 },
    ]),
    1300,
  );
  assert.equal(
    weightedMedian([
      { difficulty: 1200, weight: 0.4 },
      { difficulty: 2000, weight: 1 },
    ]),
    2000,
  );
});

test('weightedBase：高出未加权中位数 400+ 的离群样本权重减半，不抬基数', () => {
  // 2×1400 + 1×1500 + 2×2400：M0=1500，2400 离群
  const items = [1400, 1400, 1500, 2400, 2400].map((d) => ev({ problemId: d, difficulty: d }));
  // 无折扣的加权中位落在 1500（权重过半在第 3 个样本）
  const naive = weightedMedian(items.map((e) => ({ difficulty: e.difficulty, weight: qualityWeight(e, HALF_LIFE) })));
  assert.equal(naive, 1500);
  // 离群减半后基数落回 1400 —— 偶然题带不动基数
  assert.equal(weightedBase(items, HALF_LIFE), 1400);
});

// ---------- 通过率校准与校准步长 ----------

test('performanceAdjustment：同段尝试 <8 次不校准，±150 封顶', () => {
  assert.equal(performanceAdjustment(7, 7), 0); // 样本不足
  assert.equal(performanceAdjustment(8, 8), 150); // r=1.0 → +300 封顶
  assert.equal(performanceAdjustment(8, 4), 0); // r=0.5
  assert.equal(performanceAdjustment(8, 2), -150); // r=0.25
  assert.equal(performanceAdjustment(8, 0), -150); // r=0 → −300 封底
  assert.equal(performanceAdjustment(40, 30), 150); // r=0.75
});

test('calibrateStep：升慢（+80 封顶）降快（−150 封顶），无新证据原地不动', () => {
  // 返回值是未取整的校准状态；发布值由 computeAbilityDetail 再 round 到百
  assert.equal(calibrateStep(1400, 1800, 0), 1400);
  assert.equal(calibrateStep(1400, 1800, 6), 1480);
  assert.equal(calibrateStep(1400, 1800, 3), 1480); // 因子后仍触 +80 顶
  assert.equal(calibrateStep(1400, 1440, 3), 1420); // 小 gap 时因子生效（半程）
  assert.equal(calibrateStep(1400, 1440, 6), 1440); // 满额因子，未触顶
  assert.equal(calibrateStep(1400, 1000, 6), 1250);
  assert.equal(calibrateStep(1400, 1410, 6), 1410); // 小步也允许移动，不会卡死
  assert.equal(calibrateStep(3400, 3600, 12), 3480); // 步长封顶（发布时 round 到 3500）
  assert.equal(calibrateStep(900, 600, 12), 800); // clamp 下限
});

// ---------- DB：证据采集 ----------

interface SeedOpts {
  key: string;
  difficulty?: number;
  verdict?: string;
  at: string;
  context?: 'contest' | 'virtual' | 'practice';
  externalId?: string;
}

function seed(db: Db, o: SeedOpts): void {
  insertNormalized(db, DEFAULT_USER_ID, [
    {
      problem: {
        platform: 'codeforces',
        problemKey: o.key,
        title: o.key,
        tags: [],
        ...(o.difficulty != null ? { difficulty: o.difficulty } : {}),
      },
      verdict: (o.verdict ?? 'AC') as 'AC',
      submittedAt: o.at,
      externalId: o.externalId ?? `${o.key}-${o.verdict ?? 'AC'}-${o.at}`,
      ...(o.context ? { context: o.context } : {}),
    },
  ]);
}

function seedIntent(db: Db, key: string, outcome: string): void {
  db.prepare(
    "INSERT INTO submission_intents (user_id, problem_id, code, outcome) VALUES (?, (SELECT id FROM problems WHERE platform = 'codeforces' AND problem_key = ?), NULL, ?)",
  ).run(DEFAULT_USER_ID, key, outcome);
}

test('collectSolveEvidence：按题去重、尝试/跨度统计、语境与卡点、窗口外排除', () => {
  const db = createDb(':memory:');
  // 题 A：WA → AC → 再 AC：attempts 3，首 AC 在 2 天前，span 2 天
  seed(db, { key: 'A', difficulty: 1500, verdict: 'WA', at: daysAgo(4) });
  seed(db, { key: 'A', difficulty: 1500, at: daysAgo(2) });
  seed(db, { key: 'A', difficulty: 1500, at: daysAgo(1), externalId: 'A3' });
  // 题 B：一发 AC，practice 语境
  seed(db, { key: 'B', difficulty: 1600, at: daysAgo(1), context: 'practice' });
  // 题 C：一发 AC + cant_start 卡点
  seed(db, { key: 'C', difficulty: 1700, at: daysAgo(1) });
  seedIntent(db, 'C', 'cant_start');
  // 题 E：首 AC 在窗口外（90 天前），昨天重交 —— 60 天窗口不收录
  seed(db, { key: 'E', difficulty: 1800, at: daysAgo(90) });
  seed(db, { key: 'E', difficulty: 1800, at: daysAgo(1), externalId: 'E2' });

  const recent = collectSolveEvidence(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(recent.length, 3); // A / B / C

  const a = recent.find((e) => e.difficulty === 1500)!;
  assert.equal(a.attempts, 3); // 含 WA 与重复 AC
  assert.ok(Math.abs(a.spanMs - 2 * DAY) < 1000); // 首提交 → 首 AC 跨 2 天
  assert.equal(a.context, null);
  assert.equal(a.intent, null);

  const b = recent.find((e) => e.difficulty === 1600)!;
  assert.equal(b.attempts, 1);
  assert.equal(b.spanMs, 0);
  assert.equal(b.context, 'practice');

  const c = recent.find((e) => e.difficulty === 1700)!;
  assert.equal(c.intent, 'cant_start');

  const all = collectSolveEvidence(db, DEFAULT_USER_ID, null, NOW);
  assert.equal(all.length, 4); // 全历史含 E
});

// ---------- DB：估算与校准 ----------

/** 8 道当日一发 AC：5×1400 + 3×1500 → 基数 1400，同段通过率 1.0 → 目标 1600 */
function seedCleanDay(db: Db): void {
  for (let i = 0; i < 5; i += 1) seed(db, { key: `c1400-${i}`, difficulty: 1400, at: daysAgo(0) });
  for (let i = 0; i < 3; i += 1) seed(db, { key: `c1500-${i}`, difficulty: 1500, at: daysAgo(0) });
}

test('estimateBreakdown：难度基数 + 同段通过率校准', () => {
  const db = createDb(':memory:');
  seedCleanDay(db);
  const up = estimateBreakdown(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(up.base, 1400);
  assert.equal(up.performanceAdj, 150); // 8 次尝试全 AC → +150 封顶
  assert.equal(up.target, 1600);
  assert.equal(up.samples, 8);

  // 压上 20 次同段失败（1300 WA）：通过率 8/28 → −129，目标回落 —— 「低难度 AC 成功率低应下调」
  for (let i = 0; i < 20; i += 1) {
    seed(db, { key: `w1300-${i}`, difficulty: 1300, verdict: 'WA', at: daysAgo(0) });
  }
  const down = estimateBreakdown(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(down.base, 1400); // 失败不产生解题证据，基数不动
  assert.equal(down.performanceAdj, -129);
  assert.equal(down.target, 1300);
});

test('computeAbilityDetail：升级引导走一步、无新练习不动、有新练习缓慢逼近', () => {
  const db = createDb(':memory:');
  seedCleanDay(db);

  // 升级引导：旧口径中位数 1400 → 目标 1600，一步 +80 封顶 → 1480，发布 1500
  const first = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(first.level, 1500);
  assert.equal(first.detail.base, 1400);
  assert.equal(first.detail.performanceAdj, 150);
  assert.equal(first.detail.target, 1600);
  assert.equal(first.detail.newEvidence, 8);

  // 无新练习 → 发布值不动（刷新页面不漂移）
  const again = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(again.level, 1500);
  assert.equal(again.detail.newEvidence, 0);

  // +2 次练习 → 步长 (1600−1480)×(2/6) = 40 → 1520，发布仍是 1500
  for (let i = 0; i < 2; i += 1) seed(db, { key: `n1500-${i}`, difficulty: 1500, at: daysAgo(0) });
  const third = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(third.level, 1500);
  assert.equal(third.detail.newEvidence, 2);

  // +6 次练习 → 步长满额 +80 → 1600（注意基数此时已随证据上移到 1500，目标 1700）
  for (let i = 0; i < 6; i += 1) seed(db, { key: `m1500-${i}`, difficulty: 1500, at: daysAgo(0) });
  const fourth = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(fourth.level, 1600);
});

test('computeAbilityDetail：纯失败期同样触发向下校准（降幅快于升幅）', () => {
  const db = createDb(':memory:');
  seedCleanDay(db);
  const first = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(first.level, 1500); // 状态 level 1480

  // 只练不出：20 次同段失败 → 目标 1300，一步 −150 封顶 → 1330，发布 1300
  for (let i = 0; i < 20; i += 1) {
    seed(db, { key: `f1300-${i}`, difficulty: 1300, verdict: 'WA', at: daysAgo(0) });
  }
  const down = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(down.level, 1300);
  assert.equal(down.detail.performanceAdj, -129);
});

test('computeAbility：空库回退 1200（与旧口径一致）', () => {
  const db = createDb(':memory:');
  assert.equal(computeAbility(db, DEFAULT_USER_ID), 1200);
});

test('computeAbility：质量差的高难度 AC（补题+看题解）不抬高能力值', () => {
  const db = createDb(':memory:');
  // 主力证据：8 道 1400 一发 AC
  for (let i = 0; i < 8; i += 1) seed(db, { key: `g1400-${i}`, difficulty: 1400, at: daysAgo(0) });
  // 偶然题：2400 磨了 20 天、看了题解（跨度 0.45 × 尝试 0.5 × 卡点 0.45 → 触底 0.25）
  seed(db, { key: 'lucky', difficulty: 2400, verdict: 'WA', at: daysAgo(20) });
  seed(db, { key: 'lucky', difficulty: 2400, at: daysAgo(0), externalId: 'lucky2' });
  seedIntent(db, 'lucky', 'cant_start');

  const detail = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  // 9 条证据里 2400 权重 0.25 vs 1400 权重 1：中位仍稳在 1400 段
  assert.equal(detail.detail.base, 1400);
  // 目标被通过率校准抬到 1550→1600，但发布值只走一步 +80（从 1400 引导）→ 1500
  assert.equal(detail.level, 1500);
});

// ---------- 赛事中心 rating 证据 ----------

const rc = (over: Partial<RatedContestRecord> = {}): RatedContestRecord => ({
  platform: 'codeforces',
  account: 'acc',
  contestId: 'c1',
  name: 'Codeforces c1',
  atMs: NOW.getTime(),
  rank: null,
  rating: 1500,
  ratingChange: null,
  ...over,
});

let contestSeq = 0;

/** 往 participated_contests 写一条带 rating 的参赛记录（endDaysAgo/startDaysAgo 相对 NOW，都不给即当天结算） */
function seedRated(
  db: Db,
  o: {
    rating: number | null;
    platform?: string;
    endDaysAgo?: number;
    startDaysAgo?: number;
    change?: number | null;
    rank?: number | null;
  },
): void {
  const platform = o.platform ?? 'codeforces';
  const contestId = `${platform}-${(contestSeq += 1)}`;
  const startMs = o.startDaysAgo === undefined ? null : NOW.getTime() - o.startDaysAgo * DAY;
  const endMs =
    o.endDaysAgo !== undefined ? NOW.getTime() - o.endDaysAgo * DAY : o.startDaysAgo === undefined ? NOW.getTime() : null;
  db.prepare(
    `INSERT INTO participated_contests
       (user_id, platform, account, contest_id, name, url, start_ms, end_ms,
        contest_rank, rating, rating_change, fetched_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_USER_ID,
    platform,
    'acc',
    contestId,
    `${platform} ${contestId}`,
    startMs,
    endMs,
    o.rank ?? null,
    o.rating,
    o.change ?? null,
    NOW.toISOString(),
  );
}

test('ratingEvidence：CF 锚点按时效加权，混合权重随有效场数上升且有上限', () => {
  // 单场：1 有效场 / 满置信 3 场 → 上限权重的 1/3
  const one = ratingEvidence([rc({ rating: 1500 })], NOW);
  assert.equal(one.anchor, 1500);
  assert.equal(one.anchorPlatform, 'Codeforces');
  assert.equal(one.anchorRaw, 1500);
  assert.equal(one.anchorSamples, 1);
  assert.ok(Math.abs(one.anchorWeight - RATING_ANCHOR_MAX_WEIGHT / 3) < 1e-9);
  // 胜者自己的分差不再重复计入趋势（它的水平已经进了锚点）
  assert.equal(ratingEvidence([rc({ rating: 1500, ratingChange: 50 })], NOW).trendAdj, 0);

  // 1500（当天）+ 1300（半年前，半衰期 180 天 → 权重 1 : 0.5）→ 偏向新场次
  const two = ratingEvidence(
    [rc({ rating: 1500 }), rc({ rating: 1300, contestId: 'c2', atMs: NOW.getTime() - 180 * DAY })],
    NOW,
  );
  assert.equal(Math.round(two.anchor!), 1433);
  assert.ok(two.anchorWeight < RATING_ANCHOR_MAX_WEIGHT);

  // 3 场新赛 → 满权重（45%），再多的场次也不会让 rating 独裁
  const three = ratingEvidence([rc(), rc({ contestId: 't2' }), rc({ contestId: 't3' })], NOW);
  assert.equal(three.anchorWeight, RATING_ANCHOR_MAX_WEIGHT);

  // 没有结算时间就不猜：不进锚点（洛谷这类无 rating 的平台天然也不会进来）
  assert.equal(ratingEvidence([rc({ atMs: null })], NOW).anchor, null);
});

test('ratingEvidence：远古的 CF 历史不够资格参选，退化为只吃它的分差方向', () => {
  // 3 场两年半前：有效场数 3×0.5^(912/180) ≈ 0.18 < 1 → 不合格 → 无锚点
  const old = [
    rc({ contestId: 'o1', rating: 1500, ratingChange: -30, atMs: NOW.getTime() - 912 * DAY }),
    rc({ contestId: 'o2', rating: 1500, ratingChange: -30, atMs: NOW.getTime() - 912 * DAY }),
    rc({ contestId: 'o3', rating: 1500, ratingChange: -30, atMs: NOW.getTime() - 912 * DAY }),
  ];
  const ev = ratingEvidence(old, NOW);
  assert.deepEqual(ev.anchors, []);
  assert.equal(ev.anchor, null);
  assert.equal(ev.anchorWeight, 0);
  // 没有胜者 → CF 的分差也参与趋势，但同样按 912 天（约 5 个半衰期）时效淡出：−80 × 0.03 ≈ −2
  assert.equal(ev.trendSamples, 3);
  assert.equal(ev.trendAdj, -2);
});

test('ratingEvidence：AtCoder 按实测换算进锚点（CF≈0.5×AT+1050，两端钳位后再打 150 折）', () => {
  const atRec = (rating: number): RatedContestRecord =>
    rc({ platform: 'atcoder', account: 'at', contestId: 'abc1', rating });
  assert.equal(Math.round(ratingEvidence([atRec(1200)], NOW).anchor!), 1500); // 1650 − 150
  assert.equal(Math.round(ratingEvidence([atRec(2000)], NOW).anchor!), 1900); // 2050 − 150
  // 两端钳到样本实测跨度：AT 2500 不外推，AT 600 那种「不怎么打 AtCoder」的地板分也不当低水平证据
  assert.equal(Math.round(ratingEvidence([atRec(2500)], NOW).anchor!), ATCODER_CF_CEIL - 150);
  assert.equal(Math.round(ratingEvidence([atRec(600)], NOW).anchor!), ATCODER_CF_FLOOR - 150);
  assert.equal(ratingEvidence([atRec(1200)], NOW).anchorPlatform, 'AtCoder');
});

test('ratingEvidence：多平台取换算后最高，haircut 让「刚好打平」的外平台分抢不走锚点', () => {
  const cf = (rating: number, i: number): RatedContestRecord => rc({ account: 'main', contestId: `cf${i}`, rating });
  const at = (rating: number, i: number): RatedContestRecord =>
    rc({ platform: 'atcoder', account: 'at', contestId: `abc${i}`, rating });

  // AT 1400 换算后正好等于 CF 1750，但打折只有 1600 → 同标尺的 CF 胜出
  const tie = ratingEvidence([cf(1750, 1), cf(1750, 2), cf(1750, 3), at(1400, 1), at(1400, 2), at(1400, 3)], NOW);
  assert.equal(tie.anchor, 1750);
  assert.equal(tie.anchorPlatform, 'Codeforces');
  assert.equal(tie.anchors.length, 2);
  assert.equal(Math.round(tie.anchors[1]!.adjusted), 1600); // 败者也透出，用户/AI 看得到差在哪

  // AT 2000 → 1900 > CF 1700 → 取 AtCoder，原分与换算后一起给
  const win = ratingEvidence([cf(1700, 1), cf(1700, 2), cf(1700, 3), at(2000, 1), at(2000, 2), at(2000, 3)], NOW);
  assert.equal(win.anchor, 1900);
  assert.equal(win.anchorPlatform, 'AtCoder');
  assert.equal(win.anchorRaw, 2000);
  // 胜者的分差不再重复计入；败者 CF 的涨分方向仍然进趋势
  const winTrend = ratingEvidence(
    [
      ...[cf(1700, 1), cf(1700, 2), cf(1700, 3)].map((r) => ({ ...r, ratingChange: 40 })),
      at(2000, 1),
      at(2000, 2),
      at(2000, 3),
    ],
    NOW,
  );
  assert.equal(winTrend.anchorPlatform, 'AtCoder');
  assert.equal(winTrend.trendAdj, RATING_TREND_CAP);
});

test('ratingEvidence：没有换算依据的平台（牛客）绝对分不做锚点，只按近期分差出方向修正', () => {
  const nc = (n: number, change: number, daysAgo = 0, account = 'nc'): RatedContestRecord[] =>
    Array.from({ length: n }, (_, i) =>
      rc({
        platform: 'nowcoder',
        account,
        contestId: `${account}-${i}`,
        rating: 1800,
        ratingChange: change,
        atMs: NOW.getTime() - daysAgo * DAY,
      }),
    );
  const ev = ratingEvidence(nc(3, 30), NOW);
  assert.equal(ev.anchor, null);
  assert.equal(ev.anchorSamples, 0);
  assert.equal(ev.anchorWeight, 0);
  assert.equal(ev.trendSamples, 3);
  assert.equal(ev.trendAdj, RATING_TREND_CAP); // 平均 +30 ×3 = 90 → 封顶 80

  // 样本不足（<3 场）不修正；半年前的趋势按半衰期淡出一半
  assert.equal(ratingEvidence(nc(2, 30), NOW).trendAdj, 0);
  assert.equal(ratingEvidence(nc(3, 30, 180), NOW).trendAdj, RATING_TREND_CAP / 2);

  // 每个账号各自取均值再对账号平均：一边涨一边跌抵消，不会被场次多的那头带偏
  assert.equal(ratingEvidence([...nc(3, 50, 0, 'a'), ...nc(5, -50, 0, 'b')], NOW).trendAdj, 0);
});

test('collectRatedContests：只要带 rating 的场次，按结算时间新→旧，无 end_ms 回退 start_ms', () => {
  const db = createDb(':memory:');
  seedRated(db, { rating: 1500, endDaysAgo: 10 });
  seedRated(db, { rating: 1600, endDaysAgo: 1 });
  seedRated(db, { rating: null, endDaysAgo: 2, platform: 'luogu' }); // 洛谷参赛记录无 rating
  seedRated(db, { rating: 1200, startDaysAgo: 5, platform: 'atcoder' });
  const recs = collectRatedContests(db, DEFAULT_USER_ID);
  assert.deepEqual(recs.map((r) => r.rating), [1600, 1200, 1500]);
  assert.equal(recs[1].atMs, NOW.getTime() - 5 * DAY);
});

test('ratingEvidence：同平台多账号各算各的锚点，取最高的那个（弱号不拖强号）', () => {
  const recs = [
    rc({ account: 'main', contestId: 'm1', rating: 1900 }),
    rc({ account: 'main', contestId: 'm2', rating: 1900 }),
    rc({ account: 'main', contestId: 'm3', rating: 1900 }),
    rc({ account: 'alt', contestId: 'a1', rating: 1200, ratingChange: 60 }),
    rc({ account: 'alt', contestId: 'a2', rating: 1200, ratingChange: 60 }),
    rc({ account: 'alt', contestId: 'a3', rating: 1200, ratingChange: 60 }),
  ];
  const ev = ratingEvidence(recs, NOW);
  assert.equal(ev.anchors.length, 2);
  // 平均会把两个号糊成一个 1550；取最高才是「你这个人的水平」
  assert.equal(ev.anchor, 1900);
  assert.equal(ev.anchorPlatform, 'Codeforces（main）');
  assert.equal(ev.anchorWeight, RATING_ANCHOR_MAX_WEIGHT);
  // 败者只被排挤掉锚点资格，它的涨分方向仍然计入趋势
  assert.equal(ev.trendSamples, 3);
  assert.equal(ev.trendAdj, RATING_TREND_CAP);
});

test('renderRatingEvidence：无记录引导去同步，有记录逐平台列出换算与取最高的那个', () => {
  assert.match(renderRatingEvidence([], ratingEvidence([], NOW)).join('\n'), /暂无带 rating 的参赛记录/);
  const recs = [rc({ rating: 1500, ratingChange: 32, rank: 400 })];
  const text = renderRatingEvidence(recs, ratingEvidence(recs, NOW)).join('\n');
  assert.match(text, /★Codeforces 1500（1 场、有效 1\.0 场、权重 15%）/);
  assert.match(text, /取最高/);
  assert.match(text, /Codeforces 2026-09-23 1500\(\+32\) 第400名/);
});

test('estimateBreakdown：CF rating 锚点拉低目标值，难度基数与解题口径不受影响', () => {
  const db = createDb(':memory:');
  seedCleanDay(db);
  // 库内没有 rating 记录 → 与旧口径逐字一致（回归闸门）
  const plain = estimateBreakdown(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(plain.ratingAnchor, null);
  assert.equal(plain.ratingAnchorPlatform, null);
  assert.equal(plain.ratingAnchorRaw, null);
  assert.equal(plain.ratingSamples, 0);
  assert.equal(plain.ratingWeight, 0);
  assert.equal(plain.ratingTrendAdj, 0);
  assert.equal(plain.solveTarget, 1600);
  assert.equal(plain.target, 1600);

  for (let i = 0; i < 6; i += 1) seedRated(db, { rating: 1000 });
  const anchored = estimateBreakdown(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(anchored.base, 1400); // 基数只来自解题证据
  assert.equal(anchored.performanceAdj, 150);
  assert.equal(anchored.solveTarget, 1600);
  assert.equal(anchored.ratingAnchor, 1000);
  assert.equal(anchored.ratingAnchorPlatform, 'Codeforces');
  assert.equal(anchored.ratingAnchorRaw, 1000);
  assert.equal(anchored.ratingSamples, 6);
  assert.equal(anchored.ratingWeight, RATING_ANCHOR_MAX_WEIGHT);
  assert.equal(anchored.target, 1330); // 1600×0.55 + 1000×0.45
});

test('estimateBreakdown：AtCoder 场次按实测换算进「取最高」，抬动目标值', () => {
  const db = createDb(':memory:');
  seedCleanDay(db);
  // AT 2400 → 钳到实测上限 2200 再打 150 折 = 2050，高于解题口径 1600 → 胜出成为锚点
  for (let i = 0; i < 3; i += 1) seedRated(db, { platform: 'atcoder', rating: 2400, change: -30 });
  const d = estimateBreakdown(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(d.ratingAnchor, 2050);
  assert.equal(d.ratingAnchorPlatform, 'AtCoder');
  assert.equal(d.ratingAnchorRaw, 2400);
  assert.equal(d.ratingSamples, 3);
  assert.equal(d.ratingWeight, RATING_ANCHOR_MAX_WEIGHT);
  // 胜者的 −30 分会差不再重复计入趋势
  assert.equal(d.ratingTrendAdj, 0);
  assert.equal(d.solveTarget, 1600);
  assert.equal(d.target, 1803); // 1600×0.55 + 2050×0.45
});

test('estimateBreakdown：没有换算依据的平台（牛客）不抬锚点，掉分只按趋势下修', () => {
  const db = createDb(':memory:');
  seedCleanDay(db);
  for (let i = 0; i < 3; i += 1) seedRated(db, { platform: 'nowcoder', rating: 1800, change: -30 });
  const d = estimateBreakdown(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(d.ratingAnchor, null);
  assert.equal(d.ratingAnchorPlatform, null);
  assert.equal(d.ratingSamples, 0);
  assert.equal(d.ratingTrendAdj, -RATING_TREND_CAP);
  assert.equal(d.target, 1520); // 1600 − 80，1800 这个数本身从不参与
});

test('computeAbilityDetail：新同步的 rating 场次算新证据，旧状态缺字段也能一次性生效', () => {
  const db = createDb(':memory:');
  seedCleanDay(db);
  const first = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(first.level, 1500);

  // 模拟旧版本落库的校准状态（没有 totalRatedContests）：按 0 起算
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
    JSON.stringify({ level: 1480, totalAttempts: 8, updatedAt: NOW.toISOString() }),
    ABILITY_STATE_KEY,
  );
  for (let i = 0; i < 6; i += 1) seedRated(db, { rating: 1000 });

  const second = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(second.detail.newEvidence, 6); // 没有新提交，仅 6 场新 rating 记录也够重新校准
  assert.equal(second.detail.target, 1330);
  assert.equal(second.level, 1300); // 1480 → 一步 −150 封顶 → 1330

  const third = computeAbilityDetail(db, DEFAULT_USER_ID, 60, NOW);
  assert.equal(third.level, 1300); // 无新证据不漂移
  assert.equal(third.detail.newEvidence, 0);
});
