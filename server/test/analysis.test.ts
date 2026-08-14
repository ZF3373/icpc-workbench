import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedSubmission } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { computeOverall, bucketForDifficulty, rate } from '../src/analysis/stats.ts';
import { computeWeakness } from '../src/analysis/weakness.ts';
import { computeTrend, getWeekKey } from '../src/analysis/trend.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

function sub(
  platform: 'codeforces' | 'luogu',
  key: string,
  verdict: 'AC' | 'WA',
  submittedAt: string,
  tags: string[],
  difficulty?: number,
): NormalizedSubmission {
  return {
    problem: {
      platform,
      problemKey: key,
      title: `T ${key}`,
      ...(difficulty !== undefined ? { difficulty } : {}),
      tags,
    },
    verdict,
    submittedAt,
    externalId: `${platform}-${key}-${verdict}-${submittedAt}`,
  };
}

function seed(): void {
  const subs: NormalizedSubmission[] = [
    // 题目 A（CF 1500, dp+greedy）：3 次提交 1 AC
    sub('codeforces', 'A', 'WA', '2026-07-28T10:00:00.000Z', ['dp', 'greedy'], 1500),
    sub('codeforces', 'A', 'WA', '2026-07-28T11:00:00.000Z', ['dp', 'greedy'], 1500),
    sub('codeforces', 'A', 'AC', '2026-07-28T12:00:00.000Z', ['dp', 'greedy'], 1500),
    // 题目 B（CF 1800, dp+graphs）：2 次提交 2 AC
    sub('codeforces', 'B', 'AC', '2026-08-04T10:00:00.000Z', ['dp', 'graphs'], 1800),
    sub('codeforces', 'B', 'AC', '2026-08-04T11:00:00.000Z', ['dp', 'graphs'], 1800),
    // 题目 C（洛谷 无难度, 模拟）：1 次提交 1 AC
    sub('luogu', 'P1001', 'AC', '2026-08-04T12:00:00.000Z', ['模拟']),
  ];
  insertNormalized(db, 1, subs);
}

test('bucketForDifficulty boundaries', () => {
  assert.equal(bucketForDifficulty(0), '<1200');
  assert.equal(bucketForDifficulty(1199), '<1200');
  assert.equal(bucketForDifficulty(1200), '1200-1399');
  assert.equal(bucketForDifficulty(1399), '1200-1399');
  assert.equal(bucketForDifficulty(1400), '1400-1599');
  assert.equal(bucketForDifficulty(1899), '1600-1899');
  assert.equal(bucketForDifficulty(2199), '1900-2199');
  assert.equal(bucketForDifficulty(2200), '2200+');
  assert.equal(bucketForDifficulty(null), '未知');
});

test('computeOverall aggregates attempts/ac/rate/solved', () => {
  seed();
  const s = computeOverall(db, 1);
  assert.equal(s.attempts, 6);
  assert.equal(s.ac, 4);
  assert.equal(s.acRate, rate(6, 4)); // 66.7
  assert.equal(s.solvedProblems, 3);

  const cf = s.byPlatform.find((p) => p.platform === 'codeforces')!;
  assert.deepEqual(cf, { platform: 'codeforces', attempts: 5, ac: 3, acRate: 60, solved: 2 });
  const luogu = s.byPlatform.find((p) => p.platform === 'luogu')!;
  assert.equal(luogu.solved, 1);
  // 无数据的接入平台也显示（attempts=0），避免平台列表中缺失
  const atcoder = s.byPlatform.find((p) => p.platform === 'atcoder')!;
  assert.deepEqual(atcoder, { platform: 'atcoder', attempts: 0, ac: 0, acRate: 0, solved: 0 });

  const dp = s.byTag.find((t) => t.tag === 'dp')!;
  assert.deepEqual(dp, { tag: 'dp', attempts: 5, ac: 3, acRate: 60, solved: 2 });
  const greedy = s.byTag.find((t) => t.tag === 'greedy')!;
  assert.deepEqual(greedy, { tag: 'greedy', attempts: 3, ac: 1, acRate: 33.3, solved: 1 });

  const b1400 = s.byDifficulty.find((d) => d.bucket === '1400-1599')!;
  assert.deepEqual(b1400, { bucket: '1400-1599', attempts: 3, ac: 1, acRate: 33.3 });
  const b1600 = s.byDifficulty.find((d) => d.bucket === '1600-1899')!;
  assert.deepEqual(b1600, { bucket: '1600-1899', attempts: 2, ac: 2, acRate: 100 });
});

test('computeOverall respects time window filter', () => {
  seed();
  const s = computeOverall(db, 1, { from: '2026-08-01T00:00:00.000Z' });
  assert.equal(s.attempts, 3); // 仅 8 月的 3 条
  assert.equal(s.solvedProblems, 2);
});

test('computeWeakness ranks tags by gap below average', () => {
  seed();
  const w = computeWeakness(db, 1, { minAttempts: 2, topN: 5 });
  // 总体 AC 率 66.7；greedy 33.3 → gap 33.4 最大
  assert.equal(w.items.length, 3); // dp / greedy / graphs
  assert.equal(w.items[0].tag, 'greedy');
  assert.ok(Math.abs(w.items[0].gap - (66.7 - 33.3)) < 0.2);
  // dp 与 graphs AC 率 60 → gap 6.7
  const dp = w.items.find((i) => i.tag === 'dp')!;
  assert.ok(Math.abs(dp.gap - 6.7) < 0.2);
  // 难度桶弱项：1400-1599 33.3 最低
  assert.equal(w.byDifficulty[0].bucket, '1400-1599');
});

test('computeWeakness excludes noise tags (year/contest/source)', () => {
  // 即使噪声标签提交量最大、AC 率最低，也不进入弱项画像
  insertNormalized(db, 1, [
    sub('luogu', 'N1', 'WA', '2026-01-01T00:00:00.000Z', ['2026', '蓝桥杯省赛', '贪心']),
    sub('luogu', 'N2', 'WA', '2026-01-02T00:00:00.000Z', ['2026', 'NOIP 普及组', '贪心']),
    sub('luogu', 'N3', 'WA', '2026-01-03T00:00:00.000Z', ['洛谷原创', '*special', '贪心']),
    sub('codeforces', 'N4', 'AC', '2026-01-04T00:00:00.000Z', ['dp']),
    sub('codeforces', 'N5', 'AC', '2026-01-05T00:00:00.000Z', ['dp']),
  ]);
  const w = computeWeakness(db, 1, { minAttempts: 3, topN: 10 });
  const tags = w.items.map((i) => i.tag);
  assert.ok(!tags.includes('2026'), `年份标签不应入画像: ${tags}`);
  assert.ok(!tags.includes('蓝桥杯省赛'), `赛事标签不应入画像: ${tags}`);
  assert.ok(!tags.includes('NOIP 普及组') && !tags.includes('洛谷原创') && !tags.includes('*special'));
  // 真实算法标签（贪心 0/3 AC）仍在且排最弱
  assert.equal(w.items[0].tag, '贪心');
});

test('computeTrend aggregates by ISO week', () => {
  seed();
  const t = computeTrend(db, 1, 12);
  assert.equal(t.length, 2); // 2026-W31 与 2026-W32
  const w31 = t.find((p) => p.week === '2026-W31')!;
  const w32 = t.find((p) => p.week === '2026-W32')!;
  assert.ok(w31);
  assert.ok(w32);
  assert.equal(w31.attempts, 3);
  assert.equal(w31.ac, 1);
  assert.equal(w31.solved, 1);
  assert.equal(w31.avgDifficulty, 1500);
  assert.deepEqual(w31.difficultyDist, { '1400-1599': 1 });
  assert.equal(w32.attempts, 3);
  assert.equal(w32.ac, 3);
  assert.equal(w32.solved, 2);
  assert.equal(w32.avgDifficulty, 1800);
});

test('getWeekKey ISO week correctness', () => {
  // 2026-07-28 是周二 → 2026-W31；2026-08-04 是周二 → 2026-W32
  assert.equal(getWeekKey(new Date('2026-07-28T00:00:00Z')), '2026-W31');
  assert.equal(getWeekKey(new Date('2026-08-04T00:00:00Z')), '2026-W32');
  // 跨年边界：2021-01-01 属 2020-W53
  assert.equal(getWeekKey(new Date('2021-01-01T00:00:00Z')), '2020-W53');
});
