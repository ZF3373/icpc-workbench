import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandRanges,
  estimateLevel,
  pickBand,
  type CandidateProblem,
} from '../src/today/select.ts';

function c(id: number, difficulty: number, tags: string[] = []): CandidateProblem {
  return {
    id,
    platform: 'codeforces',
    problem_key: `P${id}`,
    title: `题目 ${id}`,
    difficulty,
    url: `https://example.com/${id}`,
    tags,
  };
}

test('estimateLevel: median of recent AC, rounded to 100', () => {
  assert.equal(estimateLevel([1200, 1300, 1400, 1500, 1600]), 1400);
  assert.equal(estimateLevel([1150, 1250]), 1200); // 偶数取均值再取整百
  assert.equal(estimateLevel([]), 1200); // 空数据回退
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

test('pickBand: rotate shifts the window deterministically', () => {
  const pool = [c(1, 1410), c(2, 1420), c(3, 1430)];
  const band = bandRanges(1400).core;
  const first = pickBand(pool, band, 1, [], new Set(), 0).problems;
  const shifted = pickBand(pool, band, 1, [], new Set(), 1).problems;
  // 档心 1500：默认取离档心最近的 1430；rotate=1 平移一格取次近的 1420
  assert.equal(first[0].id, 3);
  assert.equal(shifted[0].id, 2);
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
    { id: 9, platform: 'luogu', problem_key: 'P9', title: '无难度', difficulty: null, url: null, tags: [] },
  ];
  const r = pickBand(pool, bandRanges(1400).core, 3, [], new Set());
  assert.equal(r.problems.length, 0);
});
