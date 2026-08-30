import type { ReviewFeedback } from '../../../shared/src/index.ts';

/**
 * 间隔复习调度（借鉴 cf-compass 复习库）：
 * 阶梯间隔 [1, 3, 7, 14, 30, 60] 天，按复习反馈调档——
 * - hard：回炉重练，档位归零（明天再来）
 * - ok：前进一档
 * - easy：跳进两档（封顶）
 */
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60] as const;

export const MAX_STAGE = REVIEW_INTERVALS.length - 1;

export function intervalDaysForStage(stage: number): number {
  const i = Math.min(Math.max(0, Math.floor(stage)), MAX_STAGE);
  return REVIEW_INTERVALS[i];
}

export function nextStage(stage: number, feedback: ReviewFeedback): number {
  if (feedback === 'hard') return 0;
  if (feedback === 'easy') return Math.min(stage + 2, MAX_STAGE);
  return Math.min(stage + 1, MAX_STAGE);
}

/** 当地时区 YYYY-MM-DD（与 planService.today 口径一致：UTC 日期） */
export function dateAfterDays(baseDate: string, days: number): string {
  const d = new Date(`${baseDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function scheduleNext(
  stage: number,
  feedback: ReviewFeedback,
  todayStr: string,
): { stage: number; nextDueOn: string } {
  const s = nextStage(stage, feedback);
  return { stage: s, nextDueOn: dateAfterDays(todayStr, intervalDaysForStage(s)) };
}
