import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPRESSION_TIERS,
  bandRanges,
  daysBetweenDates,
  estimateLevel,
  pickBand,
  suppressedProblemIds,
  type CandidateProblem,
} from '../src/today/select.ts';

function c(
  id: number,
  difficulty: number,
  tags: string[] = [],
  extra: Partial<CandidateProblem> = {},
): CandidateProblem {
  return {
    id,
    platform: 'codeforces',
    problem_key: `P${id}`,
    title: `题目 ${id}`,
    difficulty,
    url: `https://example.com/${id}`,
    tags,
    recommendedOn: null,
    inReview: false,
    ...extra,
  };
}

test('estimateLevel: median of recent AC, rounded to 100', () => {
  assert.equal(estimateLevel([1200, 1300, 1400, 1500, 1600]), 1400);
  assert.equal(estimateLevel([1150, 1250]), 1200); // 偶数取均值再取整百
  assert.equal(estimateLevel([]), 1200); // 空数据回退
});

test('estimateLevel: 过滤 ≤0 的难度（AtCoder 负难度不拉低中位数）', () => {
  // AtCoder Problems 难度标尺可为负，混入会把中位数拉到不存在的 rating 段
  assert.equal(estimateLevel([-1152, -921, 800, 1000, 1100, 1200, 1300]), 1100);
  assert.equal(estimateLevel([-500, -800]), 1200); // 全为非正 → 回退
});

test('bandRanges: three bands around the level', () => {
  const r = bandRanges(1400);
  assert.deepEqual(
    [r.consolidation.min, r.consolidation.max],
    [1200, 1399],
  );
  assert.deepEqual([r.core.min, r.core.max], [1400, 1600]);
  assert.deepEqual([r.challenge.min, r.challenge.max], [1601, 1800]);
});

test('pickBand: only problems inside the band, closest to center first', () => {
  const pool = [c(1, 1300), c(2, 1250), c(3, 1399), c(4, 1600), c(5, 1450)];
  const band = bandRanges(1400).core;
  const { problems } = pickBand(pool, band, 2, [], new Set());
  // 1450 / 1600 落在 core 段，1450 离档心 1500 更近
  assert.deepEqual(problems.map((p) => p.id), [5, 4]);
});

test('pickBand: weak-tag matches beat closer difficulty', () => {
  const pool = [c(1, 1500), c(2, 1490, ['dp'])];
  const band = bandRanges(1400).core;
  const { problems } = pickBand(pool, band, 1, ['dp'], new Set());
  assert.equal(problems[0].id, 2);
  assert.deepEqual(problems[0].weakTags, ['dp']);
});

test('pickBand: rotate 按整批平移，相邻两批零重叠', () => {
  const pool = [c(1, 1410), c(2, 1420), c(3, 1430), c(4, 1440), c(5, 1450), c(6, 1460)];
  const band = bandRanges(1400).core;
  // 档心 1500 → 离档心由近到远：1460, 1450, 1440, 1430, 1420, 1410
  const first = pickBand(pool, band, 2, [], new Set(), 0).problems.map((p) => p.id);
  const second = pickBand(pool, band, 2, [], new Set(), 1).problems.map((p) => p.id);
  const third = pickBand(pool, band, 2, [], new Set(), 2).problems.map((p) => p.id);
  assert.deepEqual(first, [6, 5]);
  assert.deepEqual(second, [4, 3]);
  assert.deepEqual(third, [2, 1]);
  assert.equal(
    first.filter((id) => second.includes(id)).length,
    0,
  );
});

test('pickBand: rotate 超出槽位数回绕到首批', () => {
  const pool = [c(1, 1410), c(2, 1420), c(3, 1430), c(4, 1440)];
  const band = bandRanges(1400).core;
  const wrap = pickBand(pool, band, 2, [], new Set(), 2).problems.map((p) => p.id);
  // 4 题 / count 2 = 2 槽，rotate 2 回绕到 rotate 0 的窗口
  assert.deepEqual(wrap, [4, 3]);
});

test('pickBand: count 大于池子时不重复取题', () => {
  const pool = [c(1, 1410), c(2, 1420)];
  const band = bandRanges(1400).core;
  assert.equal(pickBand(pool, band, 5, [], new Set(), 3).problems.length, 2);
});

test('daysBetweenDates: ISO 日期差', () => {
  assert.equal(daysBetweenDates('2026-09-01', '2026-09-24'), 23);
  assert.equal(daysBetweenDates('2026-09-24', '2026-09-24'), 0);
  assert.equal(daysBetweenDates('bad', '2026-09-24'), null);
});

test('suppressedProblemIds: 只排除往日推荐，当天已展示交给 rotate', () => {
  const today = '2026-09-24';
  const pool = [
    c(1, 1500, [], { recommendedOn: today }), // 今天刚推荐 → 不排除
    c(2, 1500, [], { recommendedOn: '2026-09-23' }), // 1 天前
    c(3, 1500, [], { recommendedOn: '2026-09-17' }), // 7 天前
    c(4, 1500, [], { recommendedOn: '2026-09-01' }), // 23 天前，超出所有窗口
  ];
  assert.deepEqual([...suppressedProblemIds(pool, SUPPRESSION_TIERS[0], today)].sort(), [2, 3]);
  assert.deepEqual([...suppressedProblemIds(pool, SUPPRESSION_TIERS[1], today)].sort(), [2, 3]);
  assert.deepEqual([...suppressedProblemIds(pool, SUPPRESSION_TIERS[2], today)].sort(), [2]);
  assert.deepEqual([...suppressedProblemIds(pool, SUPPRESSION_TIERS[3], today)].sort(), []);
});

test('suppressedProblemIds: 复习队列中的题单独排除，最松档才放回', () => {
  const today = '2026-09-24';
  const pool = [c(1, 1500, [], { inReview: true })];
  for (const tier of SUPPRESSION_TIERS.slice(0, 4)) {
    assert.deepEqual([...suppressedProblemIds(pool, tier, today)], [1]);
  }
  assert.equal(suppressedProblemIds(pool, SUPPRESSION_TIERS[4], today).size, 0);
});

test('pickBand: excludes ids (cross-band dedupe) and reports pool size', () => {
  const pool = [c(1, 1410), c(2, 1420)];
  const band = bandRanges(1400).core;
  const r = pickBand(pool, band, 2, [], new Set([1]));
  assert.equal(r.pool, 1);
  assert.deepEqual(r.problems.map((p) => p.id), [2]);
});

test('pickBand: null difficulty never selected', () => {
  const pool: CandidateProblem[] = [
    {
      id: 9,
      platform: 'luogu',
      problem_key: 'P9',
      title: '无难度',
      difficulty: null,
      url: null,
      tags: [],
      recommendedOn: null,
      inReview: false,
    },
  ];
  const r = pickBand(pool, bandRanges(1400).core, 3, [], new Set());
  assert.equal(r.problems.length, 0);
});
