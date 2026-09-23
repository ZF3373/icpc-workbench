/**
 * 能力值算法（加权解题证据模型 + 缓慢校准）测试。
 * 纯函数（因子/加权中位数/校准步长）直接断言；DB 行为用内存库 + 固定 now 保证确定性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import {
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

test('intentFactor：看题解/完全不会打折最狠，未知 outcome 不打折', () => {
  assert.equal(intentFactor('cant_start'), 0.45);
  assert.equal(intentFactor('editorial'), 0.45);
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
