import type { ReviewFeedback } from '../../../shared/src/index.ts';

/**
 * 间隔复习调度（借鉴 cf-compass 复习库的阶梯思路，档位与折返规则本地化）：
 * 阶梯间隔 [1, 3, 7, 14, 30, 60, 120, 240] 天，按复习反馈调档——
 * - hard：退回两档（不是归零）
 * - ok：前进一档
 * - easy：跳进两档（封顶）
 *
 * 阶梯为什么要爬到 240 天：封顶在 60 天时，一道早已练熟的题每 60 天必回来一次，
 * 队列的稳态日均复习量恒等于「条数 ÷ 60」且只增不减——复习库越用越重，最后被弃用。
 * 连续答对的项必须能把间隔拉长到数月，整体负载才会收敛（留存率下降时会靠 hard 折返）。
 *
 * hard 为什么只退两档：一次失手（也可能是手滑）就把 60 天档打回「明天再来」，
 * 惩罚强度与「到底哪里不会」无关，实际后果是用户为了不重来而不敢如实点 hard，
 * 反馈数据随之失真。折返两档保留大部分已获得的间隔，同时仍明显收紧。
 */
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30, 60, 120, 240] as const;

export const MAX_STAGE = REVIEW_INTERVALS.length - 1;

/** hard 一次退回的档数 */
export const HARD_STAGE_BACKSTEP = 2;

export function intervalDaysForStage(stage: number): number {
  const i = Math.min(Math.max(0, Math.floor(stage)), MAX_STAGE);
  return REVIEW_INTERVALS[i];
}

/**
 * 档位推进。**三个分支都必须夹紧下界**：原先只有 hard 分支带 `Math.max(0, …)`，
 * ok/easy 只夹上界，于是库内出现负数 stage 时（脏数据/历史行/导入；schema 无 CHECK 约束）
 * 会被原样写回 —— 实测 stage=-5 时 ok → -4、easy → -3，档位越推越负。
 * 正常路径产生不了负数，这里是防御性夹紧。
 */
export function nextStage(stage: number, feedback: ReviewFeedback): number {
  const s = Math.min(Math.max(0, Math.floor(stage)), MAX_STAGE);
  if (feedback === 'hard') return Math.max(0, s - HARD_STAGE_BACKSTEP);
  if (feedback === 'easy') return Math.min(s + 2, MAX_STAGE);
  return Math.min(s + 1, MAX_STAGE);
}

/** 当地时区 YYYY-MM-DD（与 planService.today 口径一致：UTC 日期） */
export function dateAfterDays(baseDate: string, days: number): string {
  const d = new Date(`${baseDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 基线间隔 × 留存系数，至少 1 天（绝不排出「今天再见」的重复复习） */
export function intervalDaysWithFactor(baseDays: number, factor: number): number {
  return Math.max(1, Math.round(baseDays * factor));
}

export function scheduleNext(
  stage: number,
  feedback: ReviewFeedback,
  todayStr: string,
  /** 留存系数（见 reviews/retention.ts）：只改写排期天数，档位仍按阶梯走，缺省 1 = 原样 */
  factor = 1,
): { stage: number; nextDueOn: string; intervalDays: number } {
  const s = nextStage(stage, feedback);
  const days = intervalDaysWithFactor(intervalDaysForStage(s), factor);
  return { stage: s, nextDueOn: dateAfterDays(todayStr, days), intervalDays: days };
}

/**
 * 新条目首次到期的错峰天数：按题目 id 取模摊到 0–3 天。
 * 批量加入（题单一键、写题历史勾选）时新条目全写「今天」会让次日堆几十条到期，
 * 复习日被砸穿后队列基本就废了；连续加入的题目 id 天然连号，取模即均摊，
 * 且确定可测（不用随机数，避免同一条目重复加入时算出不同日期）。
 */
export const ADD_JITTER_DAYS = 4;

export function jitterDaysFor(problemId: number): number {
  return Math.abs(Math.trunc(problemId)) % ADD_JITTER_DAYS;
}
