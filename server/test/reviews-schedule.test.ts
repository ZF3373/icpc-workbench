import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STAGE,
  REVIEW_INTERVALS,
  dateAfterDays,
  intervalDaysForStage,
  nextStage,
  scheduleNext,
} from '../src/reviews/schedule.ts';

test('interval ladder maps stages to days', () => {
  assert.deepEqual([...REVIEW_INTERVALS], [1, 3, 7, 14, 30, 60, 120, 240]);
  assert.equal(intervalDaysForStage(0), 1);
  assert.equal(intervalDaysForStage(3), 14);
  assert.equal(intervalDaysForStage(99), 240); // 越界封顶
  assert.equal(intervalDaysForStage(-1), 1); // 越界兜底
});

test('阶梯延长到 240 天：队列会收敛，而不是永久每 60 天回来一次', () => {
  // 旧阶梯到顶 60 天 → N 条队列的稳态日均复习量恒为 N/60，且只增不减。
  // 延长后连续 ok 的题能走到 120 / 240 天档。
  assert.equal(MAX_STAGE, REVIEW_INTERVALS.length - 1);
  assert.equal(intervalDaysForStage(MAX_STAGE), 240);
  let s = 0;
  for (let i = 0; i < 10; i++) s = nextStage(s, 'ok');
  assert.equal(s, MAX_STAGE);
  assert.equal(intervalDaysForStage(s), 240);
});

test('nextStage: ok advances one, easy advances two, hard 折返两档而不是归零', () => {
  assert.equal(nextStage(0, 'ok'), 1);
  assert.equal(nextStage(2, 'ok'), 3);
  assert.equal(nextStage(0, 'easy'), 2);
  assert.equal(nextStage(4, 'easy'), 6);
  assert.equal(nextStage(6, 'easy'), MAX_STAGE); // 封顶不越界
  // hard 一次只退回两档：练熟 60 天的题因为一次手滑被打回「明天再来」，
  // 惩罚与「到底哪里不会」无关，还会让用户不敢如实点 hard
  assert.equal(nextStage(6, 'hard'), 4);
  assert.equal(nextStage(5, 'hard'), 3);
  assert.equal(nextStage(1, 'hard'), 0);
  assert.equal(nextStage(0, 'hard'), 0);
});

test('scheduleNext computes due date from today', () => {
  const r = scheduleNext(0, 'ok', '2026-08-30');
  assert.equal(r.stage, 1);
  assert.equal(r.nextDueOn, '2026-09-02'); // +3 天
  const hard = scheduleNext(4, 'hard', '2026-08-30');
  assert.equal(hard.stage, 2);
  assert.equal(hard.nextDueOn, '2026-09-06'); // 7 天后再练，而不是明天
  const easy = scheduleNext(1, 'easy', '2026-08-30');
  assert.equal(easy.stage, 3);
  assert.equal(easy.nextDueOn, '2026-09-13'); // +14 天
});

test('dateAfterDays rolls over month boundaries', () => {
  assert.equal(dateAfterDays('2026-08-30', 3), '2026-09-02');
  assert.equal(dateAfterDays('2026-12-30', 5), '2027-01-04');
});
