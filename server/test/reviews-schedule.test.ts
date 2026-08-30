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
  assert.deepEqual([...REVIEW_INTERVALS], [1, 3, 7, 14, 30, 60]);
  assert.equal(intervalDaysForStage(0), 1);
  assert.equal(intervalDaysForStage(3), 14);
  assert.equal(intervalDaysForStage(99), 60); // 越界封顶
  assert.equal(intervalDaysForStage(-1), 1); // 越界兜底
});

test('nextStage: ok advances one, easy advances two, hard resets', () => {
  assert.equal(nextStage(0, 'ok'), 1);
  assert.equal(nextStage(2, 'ok'), 3);
  assert.equal(nextStage(0, 'easy'), 2);
  assert.equal(nextStage(4, 'easy'), MAX_STAGE); // 封顶不越界
  assert.equal(nextStage(3, 'hard'), 0);
});

test('scheduleNext computes due date from today', () => {
  const r = scheduleNext(0, 'ok', '2026-08-30');
  assert.equal(r.stage, 1);
  assert.equal(r.nextDueOn, '2026-09-02'); // +3 天
  const hard = scheduleNext(4, 'hard', '2026-08-30');
  assert.equal(hard.stage, 0);
  assert.equal(hard.nextDueOn, '2026-08-31'); // 明天再来
  const easy = scheduleNext(1, 'easy', '2026-08-30');
  assert.equal(easy.stage, 3);
  assert.equal(easy.nextDueOn, '2026-09-13'); // +14 天
});

test('dateAfterDays rolls over month boundaries', () => {
  assert.equal(dateAfterDays('2026-08-30', 3), '2026-09-02');
  assert.equal(dateAfterDays('2026-12-30', 5), '2027-01-04');
});
