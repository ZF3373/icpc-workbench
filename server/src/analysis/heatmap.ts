import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { localDayOf } from '../dates.ts';
import { fetchLiteRows } from './stats.ts';

export interface HeatmapDay {
  /** 本地日 YYYY-MM-DD（localDayOf 口径，与打卡/日历一致） */
  date: string;
  attempts: number;
  ac: number;
  /** 当天 AC 的去重题数（platform:problem_key），热力格子用这个着色 */
  solved: number;
}

export interface HeatmapResult {
  from: string;
  to: string;
  totalAttempts: number;
  totalAc: number;
  totalSolved: number;
  days: HeatmapDay[];
}

export interface HeatmapOptions {
  /** 统计窗口天数（含今天），默认 365 */
  days?: number;
  platform?: PlatformId;
  /** 归属账号（须与 platform 同时给）；省略 = 全部账号 */
  account?: string;
  /** 锚定「今天」，默认系统时间；测试注入固定时间 */
  now?: Date;
}

/** 本地日历加减天：用 Date(y, m, d + delta) 归一化，避免毫秒减法在夏令时回退日偏移一天 */
function addLocalDays(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
}

/**
 * 近 N 天逐日刷题热力：格子口径 = 当天 AC 去重题数（solved），
 * 悬停明细带提交数（attempts）与 AC 提交数（ac）。
 * 「日」取 localDayOf 本地口径——凌晨刷的题算当天，与打卡/日历不出现错位。
 * 窗口内无提交的日子补零，保证前端网格日期连续；今天之后不产出。
 *
 * 时间窗下推：`from` 是本地日，换算成「本地零点」的绝对时刻（toISOString）作为 SQL 下界，
 * 走 idx_submissions_user_time。上界不用 SQL 卡死：本地日 `to` 的次日零点是精确上界，
 * 但为了不把「时钟偏斜产生的未来提交」这种脏数据带进 SQL 口径，仍由下面按 localDayOf
 * 精修（day > to 丢弃）——下界精确、上界保守，不会改变任何输出。
 */
export function computeHeatmap(db: Db, userId: number, opts: HeatmapOptions = {}): HeatmapResult {
  const now = opts.now ?? new Date();
  const window = Math.max(1, Math.floor(opts.days ?? 365));
  const to = localDayOf(now);
  const from = localDayOf(addLocalDays(now, -(window - 1)));

  const byDay = new Map<string, { attempts: number; ac: number; solved: Set<string> }>();
  const scope = { platform: opts.platform, account: opts.account };
  // 本地日 from 的零点 = addLocalDays(now, -(window-1))（构造函数即本地零点），
  // 其绝对时刻正是窗口内所有提交的下界；夏令时由 addLocalDays 的归一化处理。
  const fromIso = addLocalDays(now, -(window - 1)).toISOString();
  for (const r of fetchLiteRows(db, userId, { ...scope, from: fromIso })) {
    const day = localDayOf(new Date(r.submitted_at));
    if (day < from || day > to) continue;
    let stat = byDay.get(day);
    if (!stat) {
      stat = { attempts: 0, ac: 0, solved: new Set() };
      byDay.set(day, stat);
    }
    stat.attempts += 1;
    if (r.verdict === 'AC') {
      stat.ac += 1;
      stat.solved.add(`${r.platform}:${r.problem_key}`);
    }
  }

  const days: HeatmapDay[] = [];
  const totals = { attempts: 0, ac: 0, solved: 0 };
  for (let i = 0; i < window; i++) {
    const date = localDayOf(addLocalDays(now, i - (window - 1)));
    const stat = byDay.get(date);
    const day: HeatmapDay = {
      date,
      attempts: stat?.attempts ?? 0,
      ac: stat?.ac ?? 0,
      solved: stat?.solved.size ?? 0,
    };
    days.push(day);
    totals.attempts += day.attempts;
    totals.ac += day.ac;
    totals.solved += day.solved;
  }
  return {
    from,
    to,
    totalAttempts: totals.attempts,
    totalAc: totals.ac,
    totalSolved: totals.solved,
    days,
  };
}
