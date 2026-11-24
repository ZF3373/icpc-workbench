import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { resolveContestGroup } from '../contests/participated.ts';

/**
 * 「按比赛 / 参赛阶段筛选提交」（issue #70）。
 *
 * 赛时与赛后的分界有两个证据源，优先级从高到低：
 * 1. 平台自报语境（submissions.context，目前只有 Codeforces 下发 contest/virtual/practice）
 *    —— 平台亲口说的最准，尤其虚拟赛：虚拟赛的提交时间是「今天某个窗口」，
 *    用时间窗判定会全盘判错；
 * 2. 官方赛程时间窗（participated_contests / 日历给的 start/end）
 *    —— 其余平台只有时间可依，且必须是**非近似**窗口，否则赛后补题与
 *    赛时提交会混在一起（旧版用 Rating 结算时间推算的窗口就是这样）。
 *
 * 同一场比赛可能有多次参赛（正式 + 一次 VP）：本模块给的是合并范围，
 * 具体是哪一次由账号过滤区分——一个账号在同一场里只可能参赛一次。
 */

/** 参赛阶段：赛时（含虚拟赛）/ 赛后（补题）/ 全部 */
export type ContestPhase = 'during' | 'after' | 'all';
export const CONTEST_PHASES: ReadonlySet<string> = new Set<ContestPhase>(['during', 'after', 'all']);

export interface ContestScope {
  contestKey: string;
  platform: PlatformId;
  /** 比赛时间窗（毫秒）；缺任一即视为没有可靠窗口 */
  startMs: number | null;
  endMs: number | null;
  /** 窗口是否可靠：官方赛程或权威参赛记录给的才为 true */
  reliableWindow: boolean;
  name: string;
}

/**
 * 解析一场比赛的可筛选范围。解析不到（数据已清理 / key 非法）返回 null。
 * 只读库不发网络请求：写题历史是查询页面，不该为了筛选去拉平台。
 */
export function resolveContestScope(db: Db, contestKey: string): ContestScope | null {
  if (!/^[a-z]+:[\w.-]+$/.test(contestKey)) return null;
  const review = resolveContestGroup(db, contestKey);
  if (!review) return null;
  const c = review.contest;
  const startMs = c.startTimeIso ? Date.parse(c.startTimeIso) : NaN;
  const endMs = c.endTimeIso ? Date.parse(c.endTimeIso) : NaN;
  const hasWindow = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const reliableWindow = hasWindow && !c.timeIsApproximate;
  return {
    contestKey,
    platform: c.platform,
    startMs: hasWindow ? startMs : null,
    endMs: hasWindow ? endMs : null,
    reliableWindow,
    name: c.name ?? contestKey,
  };
}

/** 该平台是否由平台自己下发提交语境（决定能否用 context 判阶段） */
export function hasPlatformContext(platform: PlatformId): boolean {
  return platform === 'codeforces';
}

export interface ScopeSql {
  /** 以 AND 开头的 SQL 片段（含前导空格）；空串表示无约束 */
  sql: string;
  params: Array<string | number>;
}

/**
 * 把「比赛 + 阶段」编译成 WHERE 片段。
 *
 * 为什么在 SQL 里筛而不是取回 JS 筛：写题历史有分页与总数，
 * JS 侧筛完再分页会让「共 N 条」和翻页都对不上（还得把整表捞进内存）。
 */
export function contestScopeSql(scope: ContestScope, phase: ContestPhase): ScopeSql {
  const withContext = hasPlatformContext(scope.platform);
  const window = scope.reliableWindow && scope.startMs !== null && scope.endMs !== null
    ? { start: new Date(scope.startMs).toISOString(), end: new Date(scope.endMs).toISOString() }
    : null;
  if (!window) {
    // 无可靠时间窗：只能靠平台语境。其余平台既无语境也无窗口时无法判定阶段 ——
    // 返回「全部」而不是猜：宁可多显示几条，也不要漏掉用户要找的那条。
    if (!withContext) return { sql: '', params: [] };
    if (phase === 'during') return { sql: " AND s.context IN ('contest','virtual')", params: [] };
    if (phase === 'after') return { sql: " AND s.context = 'practice'", params: [] };
    return { sql: '', params: [] };
  }
  if (phase === 'during') {
    return withContext
      ? { sql: " AND (s.context IN ('contest','virtual') OR (s.context IS NULL AND s.submitted_at >= ? AND s.submitted_at < ?))", params: [window.start, window.end] }
      : { sql: ' AND s.submitted_at >= ? AND s.submitted_at < ?', params: [window.start, window.end] };
  }
  if (phase === 'after') {
    return withContext
      ? { sql: " AND (s.context = 'practice' OR (s.context IS NULL AND s.submitted_at >= ?))", params: [window.end] }
      : { sql: ' AND s.submitted_at >= ?', params: [window.end] };
  }
  // all：本场赛时 + 赛后（更早的无关提交不进来）
  return withContext
    ? { sql: ' AND (s.context IS NOT NULL OR s.submitted_at >= ?)', params: [window.start] }
    : { sql: ' AND s.submitted_at >= ?', params: [window.start] };
}
