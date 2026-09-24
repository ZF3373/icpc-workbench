import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { localDayOf } from '../dates.ts';
import { fetchRows } from './stats.ts';

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
 * fetchRows 不传 from/to（那里按 UTC 日界裁剪），窗口过滤在这里按本地日做。
 */
export function computeHeatmap(db: Db, userId: number, opts: HeatmapOptions = {}): HeatmapResult {
  const now = opts.now ?? new Date();
  const window = Math.max(1, Math.floor(opts.days ?? 365));
  const to = localDayOf(now);
  const from = localDayOf(addLocalDays(now, -(window - 1)));

  const byDay = new Map<string, { attempts: number; ac: number; solved: Set<string> }>();
  for (const r of fetchRows(db, userId, opts.platform ? { platform: opts.platform } : {})) {
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
