/**
 * computeHeatmap 单元测试：近 N 天逐日刷题热力聚合。
 * 重点覆盖：去重口径（同题同日多次 AC 记 1 题）、计数口径（提交/AC 提交分开）、
 * 窗口补零与边界（窗口外/未来提交不计入）、平台过滤。
 * 时间都用「本地当天正午」构造，任意进程时区下都落在同一日，不依赖机器时区。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedSubmission } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { computeHeatmap } from '../src/analysis/heatmap.ts';
import { localDayOf } from '../src/dates.ts';

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
  at: Date,
  difficulty?: number,
): NormalizedSubmission {
  return {
    problem: {
      platform,
      problemKey: key,
      title: `T ${key}`,
      ...(difficulty !== undefined ? { difficulty } : {}),
      tags: [],
    },
    verdict,
    submittedAt: at.toISOString(),
    externalId: `${platform}-${key}-${verdict}-${at.getTime()}`,
  };
}

/** 锚定「今天」：2026-09-24（周四）15:00 本地时间 */
const NOW = new Date(2026, 8, 24, 15, 0, 0);
const dayAt = (d: number, hour = 10) => new Date(2026, 8, d, hour, 0, 0);
const dayKey = (d: number) => localDayOf(dayAt(d));

test('computeHeatmap counts attempts/ac separately and dedups solved per day', () => {
  insertNormalized(db, 1, [
    // 9月24日：题 A 三连（2 WA 1 AC）+ 题 A 重复 AC 一次 + 题 B 一次 AC
    sub('codeforces', 'A', 'WA', dayAt(24, 9)),
    sub('codeforces', 'A', 'WA', dayAt(24, 10)),
    sub('codeforces', 'A', 'AC', dayAt(24, 11), 1500),
    sub('codeforces', 'A', 'AC', dayAt(24, 12), 1500),
    sub('codeforces', 'B', 'AC', dayAt(24, 13), 1800),
  ]);
  const r = computeHeatmap(db, 1, { days: 7, now: NOW });

  assert.equal(r.days.length, 7);
  assert.equal(r.to, dayKey(24));
  assert.equal(r.from, dayKey(18));
  const today = r.days[r.days.length - 1];
  assert.equal(today.date, dayKey(24));
  assert.equal(today.attempts, 5);
  assert.equal(today.ac, 3);
  // 题 A 当天两次 AC 只算 1 题，加题 B 共 2 题
  assert.equal(today.solved, 2);
  assert.equal(r.totalAttempts, 5);
  assert.equal(r.totalAc, 3);
  assert.equal(r.totalSolved, 2);
});

test('computeHeatmap zeroes days without submissions inside the window', () => {
  insertNormalized(db, 1, [sub('luogu', 'P1001', 'AC', dayAt(20, 12))]);
  const r = computeHeatmap(db, 1, { days: 7, now: NOW });

  const seeded = r.days.find((d) => d.date === dayKey(20))!;
  assert.equal(seeded.solved, 1);
  // 窗口内其余 6 天补零
  assert.equal(r.days.filter((d) => d.attempts === 0).length, 6);
  assert.equal(r.totalAttempts, 1);
});

test('computeHeatmap excludes submissions outside the window and in the future', () => {
  insertNormalized(db, 1, [
    // 窗口外（8 天前）
    sub('codeforces', 'OLD', 'AC', dayAt(16, 12)),
    // 时钟偏斜：晚于 now 的提交也不计入
    sub('codeforces', 'FUTURE', 'AC', dayAt(25, 12)),
  ]);
  const r = computeHeatmap(db, 1, { days: 7, now: NOW });
  assert.equal(r.totalAttempts, 0);
  assert.ok(r.days.every((d) => d.attempts === 0 && d.solved === 0));
});

test('computeHeatmap platform filter narrows the source rows', () => {
  insertNormalized(db, 1, [
    sub('codeforces', 'A', 'AC', dayAt(24, 10)),
    sub('luogu', 'P1001', 'AC', dayAt(24, 11)),
  ]);
  const r = computeHeatmap(db, 1, { days: 7, now: NOW, platform: 'luogu' });
  const today = r.days[r.days.length - 1];
  assert.equal(today.attempts, 1);
  assert.equal(today.solved, 1);
});
