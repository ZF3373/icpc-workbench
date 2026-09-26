import type { ContestInfo, ParticipatedContest, PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import type { AuthoritativeContest, ParticipationSources } from './participationSources.ts';

/**
 * 赛后复盘：从提交记录推导「参加过的比赛」（只读，不改 schema）。
 *
 * 数据库里没有比赛实体，submissions 也不存 contest 号——比赛归属只能从
 * problemKey / url 的结构反解，各平台可用的信号不同：
 * - Codeforces：problemKey = {contestId}{index}，user.status 下发的 context
 *   （contest/virtual）是「当场参加」的精确信号；gym（contestId ≥ 100000）
 *   平台不下发 context，只有 ≥2 题、跨度 ≤ 6 小时的一次集中作答才算训练赛
 *   （平时散做 gym 题不算）。赛后的补题提交（practice）会合并进同一场，
 *   注入时按 context 区分赛时/补题。
 * - AtCoder：比赛 slug 在题目 url（atcoder.jp/contests/{slug}/…）里，与
 *   赛事日历（kenkoooo 全量历史）按比赛时间窗匹配判定参赛并取赛名——进行中
 *   的比赛题目仅注册者可见可交，窗口内提交即参赛；日历匹配不到时退化为
 *   启发式（≥3 题、提交跨度 ≤ 6 小时的集中作答）。
 * - 计蒜客 / QOJ：比赛题 problemKey 形如 {contestId}-{problemId}（同步本就
 *   按「参加过的比赛」逐场拉取），命中即参赛。
 * - 洛谷：比赛题在题库转正前题号为 T 前缀（练习题为 P 等），只有窗口内
 *   ≥2 道不同 T 号题有提交才算参赛——纯时间窗匹配会把「比赛进行时的
 *   日常练习」误判成参赛。
 * 牛客 / 代码源 / LeetCode 的同步数据不含比赛提交，不参与推导。
 */

/** 支持推导「参加过的比赛」的平台（牛客本地不同步比赛提交，仅凭平台参赛记录入列） */
export const PARTICIPATED_PLATFORMS: ReadonlySet<PlatformId> = new Set<PlatformId>([
  'codeforces',
  'atcoder',
  'luogu',
  'jisuanke',
  'qoj',
  'nowcoder',
]);

/** 参赛判定依据（写入 ParticipatedContest.evidence，供前端提示与测试断言） */
export type ParticipationSignal =
  | 'contest' // CF 现场参赛（participantType CONTESTED/OUT_OF_COMPETITION）
  | 'virtual' // CF 虚拟赛
  | 'gym' // CF gym 训练赛（一次集中作答）
  | 'key-pattern' // 计蒜客 / QOJ 比赛题键 {contestId}-{pid}
  | 'calendar-window' // 与赛事日历时间窗匹配（AtCoder / 洛谷回退）
  | 'heuristic' // AtCoder 无日历依据时的集中提交启发式
  | 'joined-list'; // 平台侧参赛记录（user.rating / history / joinedContests 等）

/** submissions ⋈ problems 的最小行（推导分组与复盘渲染共用） */
export interface ContestSubmissionRow {
  platform: PlatformId;
  problemKey: string;
  title: string;
  url: string | null;
  difficulty: number | null;
  tags: string[];
  verdict: string;
  submittedAt: string;
  /** 提交语境（仅 CF 下发）：contest / virtual / practice；其余平台为 null */
  context: string | null;
}

/** 复盘注入用的单场比赛数据：比赛元数据 + 全部相关提交（按提交时间升序） */
export interface ContestReviewData {
  contest: ParticipatedContest;
  submissions: ContestSubmissionRow[];
}

/** 参加过的比赛列表上限（下拉不需要更久远的场次） */
const MAX_LIST = 200;

function platformName(platform: PlatformId): string {
  return PLATFORMS.find((p) => p.id === platform)?.name ?? platform;
}

/** 从 problemKey / url 反解比赛标识；null = 该平台/该题携带不了比赛信息 */
export function contestIdOf(platform: PlatformId, problemKey: string, url: string | null): string | null {
  switch (platform) {
    case 'codeforces': {
      const m = /^(\d+)(.+)$/.exec(problemKey);
      return m ? m[1] : null;
    }
    case 'atcoder': {
      const m = url ? /atcoder\.jp\/contests\/([^/]+)\//.exec(url) : null;
      return m ? m[1] : null;
    }
    case 'jisuanke': {
      // 比赛题键 {contestId}-{problemId}；练习题键为 T1001 等形态，不命中
      const m = /^(\d+)-/.exec(problemKey);
      return m ? m[1] : null;
    }
    case 'qoj': {
      // 比赛题键两段均为纯数字；普通题键（如 9242）不命中
      const m = /^(\d+)-\d+$/.exec(problemKey);
      return m ? m[1] : null;
    }
    default:
      return null; // 洛谷等：problemKey 无比赛信息，走日历时间窗匹配
  }
}

/** 比赛链接（平台规则拼接；日历匹配到时优先用日历里的官方链接） */
export function contestUrl(platform: PlatformId, contestId: string): string {
  switch (platform) {
    case 'codeforces':
      return isCfGym(contestId)
        ? `https://codeforces.com/gym/${contestId}`
        : `https://codeforces.com/contest/${contestId}`;
    case 'atcoder':
      return `https://atcoder.jp/contests/${contestId}`;
    case 'jisuanke':
      return `https://www.jisuanke.com/contest/${contestId}`;
    case 'qoj':
      return `https://qoj.ac/contest/${contestId}`;
    default:
      return '';
  }
}

/** CF gym 判据：contestId 为纯数字且 ≥ 100000 */
function isCfGym(contestId: string): boolean {
  return /^\d+$/.test(contestId) && Number(contestId) >= 100000;
}

/**
 * 赛事日历 → 匹配索引。ContestInfo.id 形如 cf-2259 / at-abc380 / lg-353129 / jsk-xxx，
 * 剥掉平台前缀后以 `{platform}:{bare}` 为键，与推导出的 contestId 直接对上。
 */
export function calendarIndex(calendar: ContestInfo[] | undefined): Map<string, ContestInfo> {
  const map = new Map<string, ContestInfo>();
  for (const c of calendar ?? []) {
    map.set(`${c.platform}:${c.id.replace(/^[a-z]+-/, '')}`, c);
  }
  return map;
}

interface ContestGroup {
  contestId: string;
  rows: ContestSubmissionRow[];
  signals: Set<ParticipationSignal>;
  /** 匹配到的赛事日历条目（名称/官方时间/官方链接来源） */
  calendar?: ContestInfo;
  /** 平台侧参赛记录（user.rating / joinedContests 等）：名称/时间/成绩的最高优先级来源 */
  authoritative?: AuthoritativeContest;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((t): t is string => typeof t === 'string').slice(0, 5) : [];
  } catch {
    return [];
  }
}

function fetchContestableRows(db: Db): ContestSubmissionRow[] {
  const rows = db
    .prepare(
      `SELECT s.platform AS platform, p.problem_key AS problemKey, p.title AS title,
              p.url AS url, p.difficulty AS difficulty, p.tags AS tags,
              s.verdict AS verdict, s.submitted_at AS submittedAt, s.context AS context
       FROM submissions s JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = ?
         AND s.platform IN ('codeforces','atcoder','luogu','jisuanke','qoj','nowcoder')`,
    )
    .all(DEFAULT_USER_ID) as Array<{
    platform: PlatformId;
    problemKey: string;
    title: string;
    url: string | null;
    difficulty: number | null;
    tags: string | null;
    verdict: string;
    submittedAt: string;
    context: string | null;
  }>;
  return rows.map((r) => ({ ...r, tags: parseTags(r.tags) }));
}

/** 比赛时间窗：官方开始前 5 分钟内即算（钟表误差）。结束后不再放宽——
 * AtCoder 等平台结束后人人可补题，「刚结束就提交」不能证明参加过 */
const WINDOW_BEFORE_MS = 5 * 60_000;

/** 一次集中作答的判定口径：gym / AtCoder 启发式共用（≥N 题在 6 小时内） */
const SITTING_SPAN_MS = 6 * 3_600_000;
/** gym 训练赛与 AtCoder 启发式要求的最少不同题数（≥2 太易误伤散做练习） */
const SITTING_MIN_PROBLEMS = 3;

/** 洛谷比赛题号：题库转正前为 T 前缀（练习题为 P 等题库前缀） */
function isLuoguContestProblem(problemKey: string): boolean {
  return /^T\d+$/.test(problemKey);
}

function inCalendarWindow(calendar: ContestInfo, submittedAt: string): boolean {
  if (!calendar.startTimeIso) return false;
  const start = Date.parse(calendar.startTimeIso);
  if (!Number.isFinite(start)) return false;
  const end = start + calendar.durationMinutes * 60_000;
  const t = Date.parse(submittedAt);
  return Number.isFinite(t) && t >= start - WINDOW_BEFORE_MS && t <= end;
}

/** 一次集中作答：≥minProblems 道不同题、首末提交跨度 ≤ 6 小时 */
function isOneSitting(rows: ContestSubmissionRow[], minProblems: number): boolean {
  if (new Set(rows.map((r) => r.problemKey)).size < minProblems) return false;
  const times = rows.map((r) => Date.parse(r.submittedAt)).filter(Number.isFinite);
  if (times.length < 2) return false;
  return Math.max(...times) - Math.min(...times) <= SITTING_SPAN_MS;
}

/** 结构反解分组：CF / AtCoder / 计蒜客 / QOJ 共用，逐提交按 contestId 归组并收集参赛信号 */
function groupByStructuralKey(
  rows: ContestSubmissionRow[],
  platform: PlatformId,
  cal: Map<string, ContestInfo>,
): Map<string, ContestGroup> {
  const groups = new Map<string, ContestGroup>();
  for (const row of rows) {
    const contestId = contestIdOf(platform, row.problemKey, row.url);
    if (contestId === null) continue;
    let g = groups.get(contestId);
    if (!g) {
      g = { contestId, rows: [], signals: new Set(), calendar: cal.get(`${platform}:${contestId}`) };
      groups.set(contestId, g);
    }
    g.rows.push(row);
    if (platform === 'codeforces') {
      if (row.context === 'contest') g.signals.add('contest');
      else if (row.context === 'virtual') g.signals.add('virtual');
    } else if (platform === 'jisuanke' || platform === 'qoj') {
      g.signals.add('key-pattern');
    } else if (platform === 'atcoder' && g.calendar && inCalendarWindow(g.calendar, row.submittedAt)) {
      g.signals.add('calendar-window');
    }
  }
  if (platform === 'codeforces') {
    // gym 训练赛平台不下发 context：只有一次集中作答（≥3 题、跨度 ≤ 6 小时）才算，
    // 平时散做 gym 题（单题、或多题跨越数天）不是一场比赛，不列入
    for (const g of groups.values()) {
      if (g.signals.has('contest') || g.signals.has('virtual')) continue;
      if (isCfGym(g.contestId) && isOneSitting(g.rows, SITTING_MIN_PROBLEMS)) g.signals.add('gym');
    }
  } else if (platform === 'atcoder') {
    // AtCoder 启发式兜底：仅当日历里没有该场时，一次集中作答（≥3 题、跨度 ≤ 6 小时）
    // 才视作参赛。日历里有该场但提交全在窗外 = 赛后补题/虚拟赛，不猜（宁缺毋滥）
    for (const g of groups.values()) {
      if (g.calendar || g.signals.has('calendar-window')) continue;
      if (isOneSitting(g.rows, SITTING_MIN_PROBLEMS)) g.signals.add('heuristic');
    }
  }
  return groups;
}

/**
 * 洛谷专用：比赛题在题库转正前为 T 前缀题号（练习题为 P 等题库前缀），拿赛事日历
 * 逐场开窗后，窗口内 ≥2 道不同 T 号题有提交才认定参赛——纯时间窗匹配无法区分
 * 「比赛提交」与「比赛进行时恰好在线刷题」，会造成没参加过的比赛被列入。
 * 赛后同步的旧记录若题目已转正为 P 号则匹配不到（宁缺毋滥，不猜）。
 */
function groupLuoguByCalendarWindow(
  rows: ContestSubmissionRow[],
  cal: Map<string, ContestInfo>,
): Map<string, ContestGroup> {
  const groups = new Map<string, ContestGroup>();
  for (const calendar of cal.values()) {
    if (calendar.platform !== 'luogu' || !calendar.startTimeIso) continue;
    const start = Date.parse(calendar.startTimeIso);
    if (!Number.isFinite(start)) continue;
    const end = start + calendar.durationMinutes * 60_000;
    const inWindow = rows.filter((r) => {
      if (!isLuoguContestProblem(r.problemKey)) return false;
      const t = Date.parse(r.submittedAt);
      return Number.isFinite(t) && t >= start && t <= end;
    });
    if (new Set(inWindow.map((r) => r.problemKey)).size < 2) continue;
    const contestId = calendar.id.replace(/^[a-z]+-/, '');
    groups.set(contestId, { contestId, rows: inWindow, signals: new Set(['calendar-window']), calendar });
  }
  return groups;
}

function contestGroups(
  rows: ContestSubmissionRow[],
  platform: PlatformId,
  cal: Map<string, ContestInfo>,
  /** 洛谷拿得到平台参赛记录时，不再走公开日历时间窗回退（团队赛/重现赛不在日历里，纯窗口匹配误判多） */
  hasLuoguSource: boolean,
): Map<string, ContestGroup> {
  if (platform === 'luogu') {
    return hasLuoguSource ? new Map() : groupLuoguByCalendarWindow(rows, cal);
  }
  return groupByStructuralKey(rows, platform, cal);
}

/** 参赛信号 → 可复盘比赛；无有效信号返回 null（如 CF 普通比赛的纯补题/练习组） */
function qualifyGroup(platform: PlatformId, g: ContestGroup): ParticipatedContest | null {
  const src = g.authoritative;
  let evidence: ParticipationSignal | null = null;
  if (platform === 'codeforces') {
    if (g.signals.has('contest')) evidence = 'contest';
    else if (g.signals.has('virtual')) evidence = 'virtual';
    else if (g.signals.has('gym')) evidence = 'gym';
    else if (src) evidence = 'joined-list';
  } else if (platform === 'jisuanke' || platform === 'qoj') {
    if (g.signals.has('key-pattern')) evidence = 'key-pattern';
    else if (src) evidence = 'joined-list';
  } else if (platform === 'atcoder') {
    if (g.signals.has('calendar-window')) evidence = 'calendar-window';
    else if (g.signals.has('heuristic')) evidence = 'heuristic';
    else if (src) evidence = 'joined-list';
  } else if (platform === 'luogu') {
    if (src) evidence = 'joined-list';
    else if (g.signals.has('calendar-window')) evidence = 'calendar-window';
  } else if (src) {
    // 其余平台（牛客等）：本地不同步比赛提交，组只来自平台参赛记录
    evidence = 'joined-list';
  }
  if (evidence === null) return null;

  // 元数据优先级：平台参赛记录 > 赛事日历 > 提交时间近似（链接按平台规则拼接）
  const times = g.rows.map((r) => Date.parse(r.submittedAt)).filter(Number.isFinite);
  const firstIso = times.length > 0 ? new Date(Math.min(...times)).toISOString() : null;
  const lastIso = times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
  const calendar = g.calendar;
  const startIso =
    (src?.startTimeMs ? new Date(src.startTimeMs).toISOString() : null) ??
    calendar?.startTimeIso ??
    firstIso;
  const endIso =
    (src?.endTimeMs ? new Date(src.endTimeMs).toISOString() : null) ??
    (calendar && calendar.startTimeIso
      ? new Date(Date.parse(calendar.startTimeIso) + calendar.durationMinutes * 60_000).toISOString()
      : null) ??
    lastIso;
  const problemKeys = new Set(g.rows.map((r) => r.problemKey));
  const acProblems = new Set(g.rows.filter((r) => r.verdict === 'AC').map((r) => r.problemKey));
  return {
    key: `${platform}:${g.contestId}`,
    platform,
    contestId: g.contestId,
    name: src?.name ?? calendar?.name ?? null,
    url: src?.url ?? calendar?.url ?? contestUrl(platform, g.contestId),
    startTimeIso: startIso,
    endTimeIso: endIso,
    submissionCount: g.rows.length,
    problemCount: problemKeys.size,
    acProblemCount: acProblems.size,
    // 无提交的权威场次按官方结束时间排进列表（最近的在前）
    lastSubmittedAt: lastIso ?? endIso ?? '',
    evidence,
    source: src
      ? {
          rank: src.rank,
          rating: src.rating,
          ratingChange: src.ratingChange,
          problemCount: src.problemCount,
          acceptedCount: src.acceptedCount,
        }
      : null,
  };
}

/**
 * 构建「平台:比赛id」→ 分组的完整索引：本地提交推导的组 + 平台参赛记录合并。
 * 权威记录对已有组补名称/时间/成绩；本地没有提交的场次（牛客不同步比赛提交、
 * 洛谷重现赛题目已转正等）生成零提交的合成组——列表照常展示，注入时说明缺提交。
 * 洛谷的合成组把权威窗口内的 T 号比赛题提交归因到场（团队赛题目赛前是 T 号）。
 */
function buildContestIndex(
  db: Db,
  opts?: { calendar?: ContestInfo[]; sources?: ParticipationSources['byPlatform'] },
): Map<string, { platform: PlatformId; group: ContestGroup }> {
  const cal = calendarIndex(opts?.calendar);
  const sources = opts?.sources ?? {};
  const rows = fetchContestableRows(db);
  const byPlatform = new Map<PlatformId, ContestSubmissionRow[]>();
  for (const row of rows) {
    const list = byPlatform.get(row.platform);
    if (list) list.push(row);
    else byPlatform.set(row.platform, [row]);
  }
  const index = new Map<string, { platform: PlatformId; group: ContestGroup }>();
  for (const platform of PARTICIPATED_PLATFORMS) {
    const platformRows = byPlatform.get(platform) ?? [];
    const platformSources = sources[platform];
    for (const g of contestGroups(platformRows, platform, cal, Array.isArray(platformSources)).values()) {
      index.set(`${platform}:${g.contestId}`, { platform, group: g });
    }
    for (const src of platformSources ?? []) {
      const key = `${platform}:${src.contestId}`;
      const existing = index.get(key);
      if (existing) {
        existing.group.authoritative = src;
        continue;
      }
      // 本地无该场结构化提交组的平台：合成组按**权威参赛窗口**归因提交。
      // 洛谷认 T 号比赛题（排除窗口内的日常练习）；牛客认「窗口内 + 题目属于该场」
      // （题目集来自 problem-list，排除比赛进行时顺手刷的题库题；题目集缺失时
      // 退化为整窗归因）。CF/AtCoder 不做窗口归因——它们的提交按 contestId
      // 结构化分组承载，合成组按窗口捞会误挂窗口内的其他练习。
      let attributed: ContestSubmissionRow[] = [];
      if (
        (platform === 'luogu' || platform === 'nowcoder') &&
        src.startTimeMs !== null &&
        src.endTimeMs !== null
      ) {
        attributed = platformRows.filter((r) => {
          if (platform === 'luogu' && !isLuoguContestProblem(r.problemKey)) return false;
          if (platform === 'nowcoder' && src.problemIds && !src.problemIds.includes(r.problemKey)) {
            return false;
          }
          const t = Date.parse(r.submittedAt);
          return Number.isFinite(t) && t >= src.startTimeMs! && t <= src.endTimeMs!;
        });
      }
      index.set(key, {
        platform,
        group: {
          contestId: src.contestId,
          rows: attributed,
          signals: new Set<ParticipationSignal>(['joined-list']),
          authoritative: src,
        },
      });
    }
  }
  return index;
}

/**
 * 推导「参加过的比赛」全量列表（按最后提交时间倒序 = 最近复盘优先）。
 * calendar 传入赛事日历聚合结果（routes 侧已带 60min 缓存）用于补赛名与时间窗；
 * sources 传入平台侧参赛记录（loadParticipationSources）——名称/时间/成绩的最高
 * 优先级来源，并让本地没有提交的场次也能进入列表。缺省时 CF/计蒜客/QOJ 仍可
 * 推导（不依赖日历），AtCoder 退化启发式，洛谷走 T 号 × 日历窗口回退。
 */
export function deriveParticipatedContests(
  db: Db,
  opts?: { calendar?: ContestInfo[]; sources?: ParticipationSources['byPlatform'] },
): ParticipatedContest[] {
  const out: ParticipatedContest[] = [];
  for (const { platform, group } of buildContestIndex(db, opts).values()) {
    const contest = qualifyGroup(platform, group);
    if (contest) out.push(contest);
  }
  out.sort((a, b) => (a.lastSubmittedAt < b.lastSubmittedAt ? 1 : -1));
  return out.slice(0, MAX_LIST);
}

/**
 * 按复盘关联键（`{platform}:{contestId}`）解析单场比赛：比赛元数据 + 全部相关提交。
 * 与 deriveParticipatedContests 走同一套索引（分组 + 平台参赛记录合并）——列表里
 * 能选到的场，这里一定能解析回同一组数据。解析不到（数据被清理/换账号等）返回 null。
 */
export function resolveContestGroup(
  db: Db,
  key: string,
  opts?: { calendar?: ContestInfo[]; sources?: ParticipationSources['byPlatform'] },
): ContestReviewData | null {
  const m = /^([a-z]+):([\w.-]+)$/.exec(key);
  if (!m) return null;
  const platform = m[1] as PlatformId;
  if (!PARTICIPATED_PLATFORMS.has(platform)) return null;
  const group = buildContestIndex(db, opts).get(key)?.group;
  if (!group) return null;
  const contest = qualifyGroup(platform, group);
  if (!contest) return null;
  const submissions = [...group.rows].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
  return { contest, submissions };
}

// ---------- 复盘上下文渲染（注入 AI system prompt） ----------

const MAX_RENDER_PROBLEMS = 40;
const MAX_RENDER_SUBMISSIONS = 200;
/** 单题时间线超过 10 条时保留首尾各 5 条（开头暴露思路方向，结尾是最终结果） */
const ATTEMPT_HEAD = 5;
const ATTEMPT_TAIL = 5;

const CONTEXT_LABEL: Record<string, string> = {
  contest: '赛时',
  virtual: '虚拟赛',
  practice: '补题',
};

/** 相对开赛时刻的偏移标签（+mm:ss / +h:mm:ss）；无开赛时刻时回退绝对时间 */
function offsetLabel(submittedAt: string, startMs: number): string {
  if (!Number.isFinite(startMs)) return submittedAt;
  let diff = Math.max(0, Date.parse(submittedAt) - startMs);
  const h = Math.floor(diff / 3_600_000);
  diff -= h * 3_600_000;
  const m = Math.floor(diff / 60_000);
  const s = Math.floor((diff - m * 60_000) / 1000);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `+${h}:${mm}:${ss}` : `+${mm}:${ss}`;
}

function renderAttempts(rows: ContestSubmissionRow[], startMs: number, isCf: boolean): string {
  const show = (r: ContestSubmissionRow) => {
    const label = isCf && r.context ? `（${CONTEXT_LABEL[r.context] ?? r.context}）` : '';
    return `${offsetLabel(r.submittedAt, startMs)} ${r.verdict}${label}`;
  };
  if (rows.length <= ATTEMPT_HEAD + ATTEMPT_TAIL) {
    return rows.map(show).join(' → ');
  }
  const omitted = rows.length - ATTEMPT_HEAD - ATTEMPT_TAIL;
  return [
    ...rows.slice(0, ATTEMPT_HEAD).map(show),
    `（中间省略 ${omitted} 次）`,
    ...rows.slice(-ATTEMPT_TAIL).map(show),
  ].join(' → ');
}

/**
 * 渲染单场比赛的复盘上下文（Markdown，注入 system prompt 的 {contestSection}）。
 * 结构：比赛元信息 → 逐题明细（按首提交顺序：难度/tags/链接/提交时间线/结果）。
 * 上限 40 题 / 200 条提交，超出截断并注明，防止超长比赛挤占上下文窗口。
 */
export function renderContestContext(data: ContestReviewData): string {
  const { contest, submissions } = data;
  const isCf = contest.platform === 'codeforces';
  const startMs = contest.startTimeIso ? Date.parse(contest.startTimeIso) : NaN;
  const lines: string[] = [];
  lines.push(
    `- 比赛：${contest.name ?? `${platformName(contest.platform)} · ${contest.contestId}`}（${platformName(contest.platform)}）`,
  );
  if (contest.url) lines.push(`- 比赛链接：${contest.url}`);
  if (contest.startTimeIso) lines.push(`- 开始：${contest.startTimeIso}`);
  if (contest.endTimeIso) lines.push(`- 结束：${contest.endTimeIso}`);
  if (contest.source?.rank !== null && contest.source?.rank !== undefined) {
    lines.push(`- 平台记录排名：${contest.source.rank}`);
  }
  if (contest.source?.rating !== null && contest.source?.rating !== undefined) {
    const change = contest.source.ratingChange;
    lines.push(
      `- 平台记录 Rating：${contest.source.rating}${change ? `（${change > 0 ? '+' : ''}${change}）` : ''}`,
    );
  }
  if (
    (contest.source?.acceptedCount !== null && contest.source?.acceptedCount !== undefined) ||
    (contest.source?.problemCount !== null && contest.source?.problemCount !== undefined)
  ) {
    lines.push(
      `- 平台记录 AC：${contest.source?.acceptedCount ?? '?'}/${contest.source?.problemCount ?? '?'}`,
    );
  }
  const evidenceLabel: Record<ParticipationSignal, string> = {
    contest: '现场参赛',
    virtual: '虚拟赛',
    gym: 'gym 训练赛',
    'key-pattern': '比赛提交',
    'calendar-window': '按比赛时间窗匹配',
    heuristic: '按提交聚集推断（未必是正式参赛）',
    'joined-list': '平台参赛记录',
  };
  lines.push(
    `- 概况：${contest.problemCount} 题中出现 AC ${contest.acProblemCount} 题，共 ${contest.submissionCount} 次提交（${evidenceLabel[contest.evidence as ParticipationSignal] ?? contest.evidence}）`,
  );

  if (submissions.length === 0) {
    lines.push('');
    lines.push(
      '（该场比赛的逐条提交记录尚未同步到本地，无法给出逐题时间线。可结合上方排名/Rating 与比赛链接做整体点评；需要逐题分析时请用户先到「题目管理」同步该平台，或直接粘贴提交记录。）',
    );
    return lines.join('\n');
  }

  // 按题目分组，题目按首提交时间排序（贴近比赛做题顺序）
  const byProblem = new Map<string, ContestSubmissionRow[]>();
  for (const s of submissions) {
    const list = byProblem.get(s.problemKey);
    if (list) list.push(s);
    else byProblem.set(s.problemKey, [s]);
  }
  lines.push('');
  lines.push('### 逐题提交明细（按首提交顺序）');
  let renderedSubmissions = 0;
  let renderedProblems = 0;
  let truncated = false;
  for (const [problemKey, rows] of byProblem) {
    if (renderedProblems >= MAX_RENDER_PROBLEMS || renderedSubmissions >= MAX_RENDER_SUBMISSIONS) {
      truncated = true;
      break;
    }
    renderedProblems += 1;
    const first = rows[0];
    const acCount = rows.filter((r) => r.verdict === 'AC').length;
    const solved = acCount > 0;
    const difficulty = first.difficulty !== null ? String(first.difficulty) : '未知';
    const tags = first.tags.length > 0 ? `｜tags: ${first.tags.join(', ')}` : '';
    lines.push('');
    lines.push(`#### ${problemKey} ${first.title}（难度 ${difficulty}${tags}）`);
    if (first.url) lines.push(`- 题目链接：${first.url}`);
    const budget = MAX_RENDER_SUBMISSIONS - renderedSubmissions;
    const shown = rows.slice(0, budget);
    renderedSubmissions += shown.length;
    lines.push(`- 提交 ${rows.length} 次：${renderAttempts(shown, startMs, isCf)}${shown.length < rows.length ? ' →（其余因总量截断省略）' : ''}`);
    lines.push(`- 结果：${solved ? `AC${acCount > 1 ? `（${acCount} 次 AC）` : ''}` : '未通过'}`);
  }
  if (truncated) {
    lines.push('');
    lines.push(
      `（明细已截断：仅渲染前 ${renderedProblems} 题 / ${renderedSubmissions} 次提交，比赛规模超出注入上限）`,
    );
  }
  return lines.join('\n');
}
