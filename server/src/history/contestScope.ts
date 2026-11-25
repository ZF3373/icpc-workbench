import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { resolveContestGroup } from '../contests/participated.ts';
import { readContestProblemSet } from '../contests/problemSetCache.ts';

/**
 * 「按比赛 / 参赛阶段筛选提交」（issue #70）。
 *
 * 一场比赛的提交必须**同时**满足两件事，缺一都会串味：
 * A. 归属：这条提交属于这场比赛（的平台、且是这场比赛里的题）；
 * B. 阶段：赛时（含虚拟赛）还是赛后补题。
 *
 * 归属的证据按优先级：
 * 1. 已拉取的官方题目集（contest_problem_sets）→ 精确的题号集合；
 * 2. 平台自身的题号 / 链接规则（CF 的 /contest/N/ 与 /gym/N/、AtCoder 的
 *    /contests/slug/、QOJ 与计蒜客的 `N-题号`）→ 可判定；
 * 3. 都没有（洛谷、牛客：题号与链接都不带比赛信息）→ **无法归属**，
 *    只能退回时间窗；连时间窗都没有时宁可回空并说明，也不能把该平台
 *    别的比赛的提交当成这一场的。
 *
 * 阶段的证据按优先级：
 * 1. 平台自报语境（submissions.context，目前只有 Codeforces 下发）。
 *    注意 context 只说「这条是在比赛中/虚拟赛/练习时提交的」，**不含哪场比赛** ——
 *    所以必须与上面的归属条件取交集，否则选了 A 场会把 B 场的赛时提交也算进来；
 * 2. 官方赛程时间窗（participated_contests / 日历），且必须是**非近似**窗口；
 *    虚拟赛尤其不能只靠时间窗：虚拟赛的提交时间是「今天某个窗口」，会全盘判错。
 */

/** 参赛阶段：赛时（含虚拟赛）/ 赛后（补题）/ 全部 */
export type ContestPhase = 'during' | 'after' | 'all';
export const CONTEST_PHASES: ReadonlySet<string> = new Set<ContestPhase>(['during', 'after', 'all']);

export interface ContestScope {
  contestKey: string;
  platform: PlatformId;
  /** 平台侧比赛 id（codeforces:1877 → 1877；atcoder:abc380 → abc380） */
  contestId: string;
  /** 官方题目集里的题号（已拉取时）；null = 未拉取/不可用 */
  problemKeys: string[] | null;
  /** 比赛时间窗（毫秒）；缺任一即视为没有可靠窗口 */
  startMs: number | null;
  endMs: number | null;
  /** 窗口是否可靠：官方赛程或权威参赛记录给的才为 true */
  reliableWindow: boolean;
  name: string;
}

const CONTEST_KEY_RE = /^([a-z]+):([\w.-]+)$/;

/**
 * 解析一场比赛的可筛选范围。解析不到（数据已清理 / key 非法）返回 null。
 * 只读库不发网络请求：写题历史是查询页面，不该为了筛选去拉平台。
 */
export function resolveContestScope(db: Db, contestKey: string): ContestScope | null {
  const m = CONTEST_KEY_RE.exec(contestKey);
  if (!m) return null;
  const platform = m[1] as PlatformId;
  const contestId = m[2]!;
  const review = resolveContestGroup(db, contestKey);
  if (!review) return null;
  const c = review.contest;
  const startMs = c.startTimeIso ? Date.parse(c.startTimeIso) : NaN;
  const endMs = c.endTimeIso ? Date.parse(c.endTimeIso) : NaN;
  const hasWindow = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const reliableWindow = hasWindow && !c.timeIsApproximate;
  // 已落库的官方题目集：最精确的归属依据（含用户一题都没提交的场次）
  const refs = readContestProblemSet(db, platform, contestId);
  const problemKeys = refs && refs.length > 0 ? refs.map((r) => r.id) : null;
  return {
    contestKey,
    platform,
    contestId,
    problemKeys,
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
  /** 无法归属时的解释（前端展示给用户）；能正常筛选时为 null */
  note: string | null;
}

/** LIKE 参数转义：题号里可能有 `_`（AtCoder 的 abc321_a），它是 LIKE 的单字符通配符 */
function likeEscape(v: string): string {
  return v.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 「这条提交属于这场比赛」的 SQL 片段。
 * 返回空串 = 该平台无法从题号/链接/题目集判出归属（调用方退回时间窗）。
 */
function contestMemberSql(scope: ContestScope): ScopeSql {
  if (scope.problemKeys !== null && scope.problemKeys.length > 0) {
    return {
      sql: ` AND p.problem_key IN (${scope.problemKeys.map(() => '?').join(',')})`,
      params: scope.problemKeys,
      note: null,
    };
  }
  const id = likeEscape(scope.contestId);
  switch (scope.platform) {
    case 'codeforces':
      // 题号形如 1877C（比赛号+题号），前缀匹配会撞号（1877 vs 187）；
      // URL 里的 /contest/1877/ 与 /gym/1877/ 是平台侧权威归属，用它做精确段匹配。
      return {
        sql: ' AND (p.url LIKE ? ESCAPE \'\\\\\' OR p.url LIKE ? ESCAPE \'\\\\\')',
        params: [`%/contest/${id}/%`, `%/gym/${id}/%`],
        note: null,
      };
    case 'atcoder':
      return { sql: ' AND p.url LIKE ? ESCAPE \'\\\\\'', params: [`%/contests/${id}/%`], note: null };
    case 'qoj':
    case 'jisuanke':
      // 比赛题键 = {contestId}-{problemId}（见 contests/participated.ts 的 contestIdOf）
      return { sql: ' AND p.problem_key LIKE ? ESCAPE \'\\\\\'', params: [`${id}-%`], note: null };
    default:
      // 洛谷 / 牛客：题号与链接都不携带比赛信息，只能靠时间窗
      return { sql: '', params: [], note: null };
  }
}

/**
 * 把「比赛 + 阶段」编译成 WHERE 片段。
 *
 * 为什么在 SQL 里筛而不是取回 JS 筛：写题历史有分页与总数，
 * JS 侧筛完再分页会让「共 N 条」和翻页都对不上（还得把整表捞进内存）。
 */
export function contestScopeSql(scope: ContestScope, phase: ContestPhase): ScopeSql {
  // 平台约束**永远**加上：这场比赛是某个平台上的，别的平台的提交无论如何都不属于它。
  // 少了这一条，没有可靠窗口的场次会返回全平台的提交（评审意见 P2）。
  const parts: string[] = [' AND s.platform = ?'];
  const params: Array<string | number> = [scope.platform];

  const member = contestMemberSql(scope);
  if (member.sql) {
    parts.push(member.sql);
    params.push(...member.params);
  }

  const withContext = hasPlatformContext(scope.platform);
  const window = scope.reliableWindow && scope.startMs !== null && scope.endMs !== null
    ? { start: new Date(scope.startMs).toISOString(), end: new Date(scope.endMs).toISOString() }
    : null;

  // 既判不出归属（洛谷/牛客），也没有可靠时间窗，平台还不下发语境：
  // 这场比赛无法被归属。此时回空并说明，而不是把该平台的全部提交当成这一场。
  if (!member.sql && !window && !withContext) {
    return {
      sql: ' AND 1 = 0',
      params: [],
      note: `${scope.name}：这场比赛缺少可归属的提交证据（平台不下发比赛标记、题号/链接不含比赛信息，且没有可靠的赛程时间窗）。刷新赛事中心重新同步参赛记录与题目集后再试。`,
    };
  }

  if (!window) {
    // 无可靠时间窗：只能靠平台语境 + 上面的归属条件
    if (!withContext) return { sql: parts.join(''), params, note: null };
    if (phase === 'during') parts.push(" AND s.context IN ('contest','virtual')");
    else if (phase === 'after') parts.push(" AND s.context = 'practice'");
    return { sql: parts.join(''), params, note: null };
  }

  if (phase === 'during') {
    if (withContext) {
      // 虚拟赛必须靠 context：它的提交时间是「今天某个窗口」，用时间窗会全盘判错。
      // 老行 context 为空（历史 bug，已由同步回填）时退回时间窗。
      parts.push(" AND (s.context IN ('contest','virtual') OR (s.context IS NULL AND s.submitted_at >= ? AND s.submitted_at < ?))");
    } else {
      parts.push(' AND s.submitted_at >= ? AND s.submitted_at < ?');
    }
    params.push(window.start, window.end);
  } else if (phase === 'after') {
    if (withContext) {
      parts.push(" AND (s.context = 'practice' OR (s.context IS NULL AND s.submitted_at >= ?))");
    } else {
      parts.push(' AND s.submitted_at >= ?');
    }
    params.push(window.end);
  } else if (withContext) {
    // all：本场的赛时 + 赛后（更早的无关提交不进来）
    parts.push(' AND (s.context IS NOT NULL OR s.submitted_at >= ?)');
    params.push(window.start);
  } else {
    parts.push(' AND s.submitted_at >= ?');
    params.push(window.start);
  }
  return { sql: parts.join(''), params, note: null };
}
