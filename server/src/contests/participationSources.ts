import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';
import { fetchParticipatedContests } from '../adapters/jisuanke.ts';
import { lookupCfProblems, cfContestProblems } from './cfProblemset.ts';
import { isCfGymContestId, problemSetMatchesContest } from './problemSetShape.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import type { Db } from '../db/index.ts';
import { throttledFetch } from '../net/hostThrottle.ts';
import { calendarIndex, contestUrl } from './participated.ts';

/**
 * 「参加过的比赛」权威数据源：从平台侧拉取用户的参赛记录，落库持久化 +
 * 增量拉取（拉取题目同一套思路），弥补本地提交推导的盲区——旧数据没有
 * context 参赛标记、洛谷团队赛/重现赛不在公开日历、牛客根本不同步比赛提交。
 * 各端点均为社区公开方案（luogu-api-docs / 官方 API）：
 * - Codeforces：官方 user.rating（rated 场次，无需登录，单请求全量）
 * - AtCoder：官方 users/{handle}/history/json（rated 场次，无需登录，单请求全量）
 * - 洛谷：GET /api/user/joinedContests（含团队赛/重现赛，需同步用的登录 Cookie，分页）
 * - 牛客：acm-heavy contest-joined-history（仅需 uid，无需登录，分页）
 * - 计蒜客：复用适配器的 fetchParticipatedContests（需 Cookie，分页）
 *
 * 拉取模型（对齐提交同步）：
 * - 单次上限：分页平台单次最多翻 DEFAULT_MAX_PAGES 页，触及即 truncated，
 *   下次拉取从库内已覆盖的最旧记录继续向后补全（已翻过的页直接跳过）；
 * - 增量：backlog 完成后，每次刷新只翻到「整页都是库内旧内容」为止
 *   （列表按新→旧排序），稳态通常 1 页；
 * - 落库：记录入 participated_contests（重启不丢），刷新间隔 30 分钟，
 *   过期平台由 GET 路由触发后台刷新（打开页面不等外网）。
 */

/** 平台侧参赛记录（时间均为毫秒时间戳；成绩字段缺失为 null） */
export interface AuthoritativeContest {
  platform: PlatformId;
  /** CF/牛客/洛谷：数字比赛 id；AtCoder：比赛 slug */
  contestId: string;
  name: string;
  url: string;
  startTimeMs: number | null;
  endTimeMs: number | null;
  rank: number | null;
  rating: number | null;
  ratingChange: number | null;
  problemCount: number | null;
  acceptedCount: number | null;
  /**
   * 该场比赛的题目集（nowcoder: problem-list；CF: contest.standings，复盘时按需补拉）。
   * 归因排歧（窗口内的非本场题目是日常练习）+「赛时未提交的题」渲染共用。
   * null/undefined = 尚未拉取（归因退化为整窗）；空数组按未拉取处理。
   */
  problems?: ContestProblemRef[] | null;
  /**
   * 题目集拉取状态（三态）：'ok'=已拉取有题；'empty'=已拉取确认无题；'unknown'/缺省=未拉取。
   * 区分「空」与「未拉取」避免空题目集场次被每条消息无限重复拉取。
   */
  problemSetState?: 'ok' | 'empty' | 'unknown';
}

/** 题目集单题。id 与本地 problems.problem_key 同构（nowcoder 为题目数字 id，CF 为 {contestId}{index}） */
export interface ContestProblemRef {
  id: string;
  /** 比赛内题号（A/B/C…） */
  index?: string;
  /** 题名 */
  title?: string;
  /** 官方难度（CF 题目 rating；其余平台暂无） */
  rating?: number | null;
  /** 官方知识点标签（CF 来自 problemset.problems 全集缓存；拿不到就不写，不编造） */
  tags?: string[];
}

export interface ParticipationSources {
  byPlatform: Partial<Record<PlatformId, AuthoritativeContest[]>>;
  failures: Partial<Record<PlatformId, string>>;
}

const FETCH_TIMEOUT_MS = 15_000;
/** 单次拉取的分页上限（防异常响应导致无限翻页；触顶后下次拉取继续向后补全） */
const DEFAULT_MAX_PAGES = 30;
/** 参赛记录刷新间隔：30 分钟内重复打开直接读库，过期平台后台增量刷新 */
const REFRESH_INTERVAL_MS = 30 * 60_000;
/** 无官方起止时间的场次：结束时间回推一个近似窗口（仅用于时间线归因与展示） */
const FALLBACK_WINDOW_MS = 2 * 3_600_000;

const NC_API = 'https://ac.nowcoder.com';

function okStatus(res: Response): boolean {
  return res.status >= 200 && res.status < 300;
}

async function fetchJson(url: string, fetchFn: typeof fetch, init?: RequestInit): Promise<unknown> {
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...init,
  });
  if (!okStatus(res)) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function windowFromEnd(endMs: number): { startTimeMs: number; endTimeMs: number } {
  return { startTimeMs: endMs - FALLBACK_WINDOW_MS, endTimeMs: endMs };
}

/** 日历匹配到的官方起止时间（CF / AtCoder 的 user.rating 与 history 都不带开始时间） */
function windowFromCalendar(
  cal: Map<string, ContestInfo>,
  platform: PlatformId,
  contestId: string,
): { startTimeMs: number; endTimeMs: number } | null {
  const entry = cal.get(`${platform}:${contestId}`);
  if (!entry?.startTimeIso) return null;
  const start = Date.parse(entry.startTimeIso);
  if (!Number.isFinite(start)) return null;
  return { startTimeMs: start, endTimeMs: start + entry.durationMinutes * 60_000 };
}

// ---------- 拉取选项与结果（分页平台的增量语义） ----------

export interface FetchParticipationOptions {
  /** 库内已覆盖的最旧比赛时间（毫秒）：本页触及即终止（列表按新→旧排序，后面全是旧内容） */
  knownOldestMs?: number | null;
  /** 之前已完成过全量翻页；false 时必须翻到空页/列表结束（首次或上次被截断后的补全） */
  backlogDone: boolean;
  /** 单次拉取的页数上限（缺省 DEFAULT_MAX_PAGES） */
  maxPages?: number;
}

export interface ParticipationFetchResult {
  items: AuthoritativeContest[];
  /** 触及单次上限，仍有更早的历史未拉（下次拉取继续补全） */
  truncated: boolean;
}

// ---------- 各平台拉取器 ----------

/** Codeforces：官方 user.rating——rated 场次（contestId 即比赛 id，含 Div.3/4 的真实 id） */
export async function fetchCodeforcesParticipation(
  handle: string,
  cal: Map<string, ContestInfo>,
  fetchFn: typeof fetch = throttledFetch,
): Promise<AuthoritativeContest[]> {
  const body = (await fetchJson(
    `https://codeforces.com/api/user.rating?handle=${encodeURIComponent(handle)}`,
    fetchFn,
  )) as { status?: string; result?: Array<Record<string, unknown>> };
  if (body.status !== 'OK' || !Array.isArray(body.result)) throw new Error('响应结构异常');
  return body.result.map((r) => {
    const contestId = String(r.contestId);
    const updateTimeMs = Number(r.ratingUpdateTimeSeconds) * 1000;
    const win =
      windowFromCalendar(cal, 'codeforces', contestId) ??
      (Number.isFinite(updateTimeMs) ? windowFromEnd(updateTimeMs) : null);
    const newRating = typeof r.newRating === 'number' ? r.newRating : null;
    const oldRating = typeof r.oldRating === 'number' ? r.oldRating : null;
    return {
      platform: 'codeforces' as const,
      contestId,
      name: typeof r.contestName === 'string' ? r.contestName : `Codeforces ${contestId}`,
      url: contestUrl('codeforces', contestId),
      startTimeMs: win?.startTimeMs ?? null,
      endTimeMs: win?.endTimeMs ?? null,
      rank: typeof r.rank === 'number' ? r.rank : null,
      rating: newRating,
      ratingChange: newRating !== null && oldRating !== null ? newRating - oldRating : null,
      problemCount: null,
      acceptedCount: null,
    };
  });
}

/** AtCoder：官方 history/json——rated 场次（ContestScreenName 即比赛 slug） */
export async function fetchAtcoderParticipation(
  handle: string,
  cal: Map<string, ContestInfo>,
  fetchFn: typeof fetch = throttledFetch,
): Promise<AuthoritativeContest[]> {
  const body = (await fetchJson(
    `https://atcoder.jp/users/${encodeURIComponent(handle)}/history/json`,
    fetchFn,
  )) as Array<Record<string, unknown>> | { error?: string };
  if (!Array.isArray(body)) throw new Error('响应结构异常');
  const out: AuthoritativeContest[] = [];
  for (const r of body) {
    // ContestScreenName 形如 abc459.contest.atcoder.jp（部分旧场次无后缀），剥成纯 slug
    const slug = typeof r.ContestScreenName === 'string'
      ? r.ContestScreenName.replace(/\.contest\.atcoder\.jp$/, '')
      : null;
    if (!slug) continue;
    const endMs = Number(r.EndTimeStamp) * 1000;
    const win =
      windowFromCalendar(cal, 'atcoder', slug) ??
      (Number.isFinite(endMs) ? windowFromEnd(endMs) : null);
    const isRated = r.IsRated === true;
    const newRating = typeof r.NewRating === 'number' ? r.NewRating : null;
    const oldRating = typeof r.OldRating === 'number' ? r.OldRating : null;
    out.push({
      platform: 'atcoder',
      contestId: slug,
      name: typeof r.ContestName === 'string' ? r.ContestName : slug,
      url: `https://atcoder.jp/contests/${slug}`,
      startTimeMs: win?.startTimeMs ?? null,
      endTimeMs: win?.endTimeMs ?? null,
      rank: typeof r.Place === 'number' ? r.Place : null,
      rating: isRated ? newRating : null,
      ratingChange:
        isRated && newRating !== null && oldRating !== null ? newRating - oldRating : null,
      problemCount: null,
      acceptedCount: null,
    });
  }
  return out;
}

/** 洛谷：GET /api/user/joinedContests——含团队赛/重现赛（需同步用登录 Cookie，分页） */
export async function fetchLuoguJoinedContests(
  cookie: string,
  opts: FetchParticipationOptions,
  fetchFn: typeof fetch = throttledFetch,
): Promise<ParticipationFetchResult> {
  if (!cookie) throw new Error('未配置洛谷 Cookie');
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const items: AuthoritativeContest[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const body = (await fetchJson(
      `https://www.luogu.com.cn/api/user/joinedContests?page=${page}`,
      fetchFn,
      { headers: { Cookie: cookie } },
    )) as {
      contests?: {
        result?: Array<Record<string, unknown>>;
        count?: number;
        perPage?: number | null;
      };
    };
    const rows = body.contests?.result;
    if (!Array.isArray(rows) || rows.length === 0) break; // 翻到列表末尾
    let oldestOnPage = Infinity;
    for (const c of rows) {
      const id = typeof c.id === 'number' ? c.id : null;
      if (id === null) continue;
      const startMs = typeof c.startTime === 'number' ? c.startTime * 1000 : null;
      const endMs = typeof c.endTime === 'number' ? c.endTime * 1000 : null;
      if (startMs !== null && startMs < oldestOnPage) oldestOnPage = startMs;
      items.push({
        platform: 'luogu',
        contestId: String(id),
        name: typeof c.name === 'string' ? c.name : `洛谷比赛 ${id}`,
        url: `https://www.luogu.com.cn/contest/${id}`,
        startTimeMs: startMs,
        endTimeMs: endMs,
        rank: null,
        rating: null,
        ratingChange: null,
        problemCount: typeof c.problemCount === 'number' ? c.problemCount : null,
        acceptedCount: null,
      });
    }
    // 增量提前终止：backlog 已完成且本页触及库内最旧记录 → 之后全是已入库的旧内容
    if (opts.backlogDone && opts.knownOldestMs != null && oldestOnPage <= opts.knownOldestMs) break;
    const perPage = body.contests?.perPage;
    const count = body.contests?.count;
    if (typeof perPage === 'number' && typeof count === 'number' && page * perPage >= count) break;
    if (page === maxPages) truncated = true; // 触及单次上限：更早的历史下次继续
  }
  return { items, truncated };
}

/** 牛客：acm-heavy 参赛历史——仅需 uid（无需登录），10 条/页，按新→旧排序 */
export async function fetchNowcoderJoinedContests(
  uid: string,
  opts: FetchParticipationOptions,
  fetchFn: typeof fetch = throttledFetch,
): Promise<ParticipationFetchResult> {
  if (!uid) throw new Error('未绑定牛客账号');
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const items: AuthoritativeContest[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const body = (await fetchJson(
      `https://ac.nowcoder.com/acm-heavy/acm/contest/profile/contest-joined-history` +
        `?token=&uid=${encodeURIComponent(uid)}&page=${page}&onlyJoinedFilter=true` +
        `&searchContestName=&onlyRatingFilter=false&contestEndFilter=true`,
      fetchFn,
      { headers: { Accept: 'application/json' } },
    )) as { data?: { dataList?: Array<Record<string, unknown>>; pageInfo?: { pageCount?: number } } };
    const dataList = body.data?.dataList;
    if (!Array.isArray(dataList) || dataList.length === 0) break; // 翻到列表末尾
    let oldestOnPage = Infinity;
    for (const c of dataList) {
      const contestId = typeof c.contestId === 'number' ? String(c.contestId) : null;
      if (contestId === null) continue;
      const startMs = typeof c.startTime === 'number' ? c.startTime : null;
      const endMs = typeof c.endTime === 'number' ? c.endTime : null;
      if (startMs !== null && startMs < oldestOnPage) oldestOnPage = startMs;
      // rating 只在结算完成后采信：WAITING（计算中）/ NO（不计分）时接口给的是
      // 1000 占位值，直接展示会变成假 Rating
      const ratingFinal = c.ratingStatus === 'FINISHED';
      items.push({
        platform: 'nowcoder',
        contestId,
        name: typeof c.contestName === 'string' ? c.contestName : `牛客比赛 ${contestId}`,
        url: `https://ac.nowcoder.com/acm/contest/${contestId}`,
        startTimeMs: startMs,
        endTimeMs: endMs,
        rank: typeof c.rank === 'number' ? c.rank : null,
        rating: ratingFinal && typeof c.rating === 'number' ? c.rating : null,
        ratingChange:
          ratingFinal && typeof c.changeValue === 'number' ? c.changeValue : null,
        problemCount: typeof c.problemCount === 'number' ? c.problemCount : null,
        acceptedCount: typeof c.acceptedCount === 'number' ? c.acceptedCount : null,
      });
    }
    if (opts.backlogDone && opts.knownOldestMs != null && oldestOnPage <= opts.knownOldestMs) break;
    const pageCount = body.data?.pageInfo?.pageCount;
    if (typeof pageCount !== 'number' || page >= pageCount) break;
    if (page === maxPages) truncated = true;
  }
  return { items, truncated };
}

/** 抓 HTML 页用的浏览器 UA（AtCoder 对默认 Node UA 不友好） */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * AtCoder 比赛题目集：`/contests/{slug}/tasks` 是公开 SSR 页（实测 abc454 → 7 题 A-G）。
 * 拿到题目集后「赛时未提交的题」才有题号/题名，**这些题的题面也才进得了预取范围**
 * （否则 AI 既看不到未开的题，也不可能拿到它们的题面）。
 *
 * 页面上每道题有两个锚点（题号格 + 题名格），题名格文本更长 → 取**最长**文本作题名。
 * 本页同时是**题名的权威来源**：适配器用的 kenkoooo 社区 problems.json 会串号
 * （实测 abc454_b 的题名被写成「C. Mapping」，题名文字对但字母前缀错），
 * 见 repairAtcoderTitles。
 */
async function fetchAtcoderProblemSet(
  contestId: string,
  fetchFn: typeof fetch,
): Promise<ContestProblemRef[] | null> {
  try {
    const slug = contestId;
    const res = await fetchFn(`https://atcoder.jp/contests/${encodeURIComponent(slug)}/tasks`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!okStatus(res)) return null;
    const html = await res.text();
    const titleById = new Map<string, string>();
    const indexById = new Map<string, string>();
    const order: string[] = [];
    const re = /<a[^>]*href="\/contests\/[^"/]+\/tasks\/([a-z0-9_]+)(?:\?[^"]*)?"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of html.matchAll(re)) {
      const id = m[1]!;
      if (!id.startsWith(`${slug}_`)) continue; // 页面可能挂别的场次链接
      const suffix = id.slice(slug.length + 1);
      if (!/^[a-z0-9]+$/.test(suffix)) continue;
      if (!indexById.has(id)) {
        indexById.set(id, suffix.toUpperCase());
        order.push(id);
      }
      const text = m[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const prev = titleById.get(id);
      if (!prev || text.length > prev.length) titleById.set(id, text); // 题名格比题号格长
    }
    const refs = order.map((id) => ({
      id,
      index: indexById.get(id),
      title: titleById.get(id)?.replace(/^[A-Za-z0-9]{1,2}\s*[-–]\s*/, '').trim() || undefined,
    }));
    return refs.length > 0 ? refs : null;
  } catch {
    return null; // 拉取失败 → 题目集保持未知（下次复盘再试）
  }
}

/**
 * 用官方 tasks 页题名修正库内标题（**回复正文，写 problems.title**）。
 * 依据：适配器的题名来自 kenkoooo 社区 problems.json，会串号（实测 abc454_b 为
 * 「C. Mapping」，官方为「B. Mapping」）；官方 tasks 页才是权威。
 * 只修本场（key 前缀匹配）且只在与官方不一致时写，避免无谓写入。
 */
function repairAtcoderTitles(db: Db, refs: ContestProblemRef[]): void {
  const update = db.prepare(
    'UPDATE problems SET title = ? WHERE platform = ? AND problem_key = ? AND title != ?',
  );
  for (const ref of refs) {
    if (!ref.title || !ref.index) continue;
    const fixed = `${ref.index}. ${ref.title}`;
    update.run(fixed, 'atcoder', ref.id, fixed);
  }
}

/**
 * GET /acm/contest/problem-list —— 该场比赛的题目集（归因排歧 +「未提交的题」渲染；
 * 无需登录）。同一次响应里带 index（A/B/C…）与 title，未提交的题也能给出完整身份。
 */
async function fetchNowcoderProblems(
  contestId: string,
  fetchFn: typeof fetch,
): Promise<ContestProblemRef[] | null> {
  try {
    const body = (await fetchJson(
      `${NC_API}/acm/contest/problem-list?token=&id=${encodeURIComponent(contestId)}`,
      fetchFn,
      { headers: { Accept: 'application/json' } },
    )) as { data?: { data?: Array<Record<string, unknown>> } };
    const rows = body.data?.data;
    if (!Array.isArray(rows)) return null;
    const refs: ContestProblemRef[] = [];
    for (const r of rows) {
      if (typeof r.problemId !== 'number') continue;
      refs.push({
        id: String(r.problemId),
        index: typeof r.index === 'string' ? r.index : undefined,
        title: typeof r.title === 'string' ? r.title : undefined,
      });
    }
    return refs.length > 0 ? refs : null;
  } catch {
    return null; // 题目集拉取失败 → 归因退化为整窗（不阻断）
  }
}

/** 计蒜客：复用适配器的「已参加比赛」列表（补赛名/开始时间；Cookie 失效时计入 failures） */
export async function fetchJisuankeParticipation(
  cookie: string,
): Promise<AuthoritativeContest[]> {
  if (!cookie) throw new Error('未配置计蒜客 Cookie');
  const rows = await fetchParticipatedContests(throttledFetch, cookie);
  return rows.map((c) => {
    // startTime 为北京时间字符串（无时区后缀）；无结束时间字段，不猜
    const startMs = c.startTime ? Date.parse(`${c.startTime}+08:00`) : NaN;
    return {
      platform: 'jisuanke' as const,
      contestId: String(c.contestId),
      name: c.title ?? `计蒜客比赛 ${c.contestId}`,
      url: `https://www.jisuanke.com/contest/${c.contestId}`,
      startTimeMs: Number.isFinite(startMs) ? startMs : null,
      endTimeMs: null,
      rank: null,
      rating: null,
      ratingChange: null,
      problemCount: null,
      acceptedCount: null,
    };
  });
}

// ---------- 库内持久化（participated_contests / participation_sync） ----------

interface PlatformSyncState {
  lastSyncAt: string | null;
  backlogDone: boolean;
  oldestMs: number | null;
  truncated: boolean;
  lastError: string | null;
}

function readSyncState(db: Db, platform: PlatformId, account: string): PlatformSyncState | null {
  const row = db
    .prepare(
      'SELECT last_sync_at, backlog_done, oldest_ms, truncated, last_error FROM participation_sync WHERE user_id = ? AND platform = ? AND account = ?',
    )
    .get(DEFAULT_USER_ID, platform, account) as
    | {
        last_sync_at: string | null;
        backlog_done: number;
        oldest_ms: number | null;
        truncated: number;
        last_error: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    lastSyncAt: row.last_sync_at,
    backlogDone: row.backlog_done === 1,
    oldestMs: row.oldest_ms,
    truncated: row.truncated === 1,
    lastError: row.last_error,
  };
}

/** 库内某平台全部账号的参赛记录（复盘列表合并展示；按开始时间新→旧排序） */
function readStoredContests(db: Db, platform: PlatformId): AuthoritativeContest[] {
  const rows = db
    .prepare(
      `SELECT contest_id, name, url, start_ms, end_ms, contest_rank, rating, rating_change,
              problem_count, accepted_count, problem_ids, problem_set_state
       FROM participated_contests WHERE user_id = ? AND platform = ?`,
    )
    .all(DEFAULT_USER_ID, platform) as Array<{
    contest_id: string;
    name: string | null;
    url: string | null;
    start_ms: number | null;
    end_ms: number | null;
    contest_rank: number | null;
    rating: number | null;
    rating_change: number | null;
    problem_count: number | null;
    accepted_count: number | null;
    problem_ids: string | null;
    problem_set_state: string | null;
  }>;
  return rows
    .map((r) => {
      const parsed = parseProblems(r.problem_ids);
      // 归属校验：题目集必须属于这场比赛（CF/AtCoder 按 key 前缀判定）。
      // 不匹配 = 历史串台数据（见 problemSetShape.ts 的事故说明）→ 当作未拉取处理，
      // 状态退回 unknown，下一次复盘会用正确的平台接口重拉（自愈）。
      const problems = problemSetMatchesContest(platform, r.contest_id, parsed) ? parsed : null;
      const rawState = r.problem_set_state;
      const state: 'ok' | 'empty' | 'unknown' =
        rawState === 'ok' ? 'ok' : rawState === 'empty' ? 'empty' : 'unknown';
      return {
        platform,
        contestId: r.contest_id,
        name: r.name ?? `${platform} 比赛 ${r.contest_id}`,
        url: r.url ?? contestUrl(platform, r.contest_id),
        startTimeMs: r.start_ms,
        endTimeMs: r.end_ms,
        rank: r.contest_rank,
        rating: r.rating,
        ratingChange: r.rating_change,
        problemCount: r.problem_count,
        acceptedCount: r.accepted_count,
        problems,
        // 有题目集即 ok；状态为 empty 即 empty；其余 unknown
        // 注意：problems 已被归属校验过 —— 串台数据在这里变成 null，状态随之退回 unknown
        problemSetState: (state === 'unknown' && problems !== null ? 'ok' : state) as 'ok' | 'empty' | 'unknown',
      };
    })
    .sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0));
}

/** problem_ids JSON → 题目集引用；兼容旧格式（纯 id 字符串数组）；空数组视为未拉取 */
function parseProblems(raw: string | null): ContestProblemRef[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    const refs = arr
      .map((v) => (typeof v === 'string' ? { id: v } : (v as ContestProblemRef)))
      .filter((v): v is ContestProblemRef => typeof v?.id === 'string');
    return refs.length > 0 ? refs : null;
  } catch {
    return null;
  }
}

function upsertContests(
  db: Db,
  platform: PlatformId,
  account: string,
  items: AuthoritativeContest[],
): number | null {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO participated_contests
       (user_id, platform, account, contest_id, name, url, start_ms, end_ms,
        contest_rank, rating, rating_change, problem_count, accepted_count, problem_ids, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, platform, account, contest_id) DO UPDATE SET
       name = excluded.name, url = excluded.url, start_ms = excluded.start_ms,
       end_ms = excluded.end_ms, contest_rank = excluded.contest_rank,
       rating = excluded.rating, rating_change = excluded.rating_change,
       problem_count = excluded.problem_count, accepted_count = excluded.accepted_count,
       problem_ids = COALESCE(excluded.problem_ids, participated_contests.problem_ids),
       fetched_at = excluded.fetched_at`,
  );
  let oldestMs: number | null = null;
  for (const item of items) {
    stmt.run(
      DEFAULT_USER_ID,
      platform,
      account,
      item.contestId,
      item.name,
      item.url,
      item.startTimeMs,
      item.endTimeMs,
      item.rank,
      item.rating,
      item.ratingChange,
      item.problemCount,
      item.acceptedCount,
      item.problems ? JSON.stringify(item.problems) : null,
      now,
    );
    if (item.startTimeMs !== null && (oldestMs === null || item.startTimeMs < oldestMs)) {
      oldestMs = item.startTimeMs;
    }
  }
  // 与库内既有最旧记录取更小值（增量拉取不动更早的历史）
  const prev = readSyncState(db, platform, account)?.oldestMs ?? null;
  if (prev !== null && (oldestMs === null || prev < oldestMs)) oldestMs = prev;
  return oldestMs;
}

function writeSyncState(
  db: Db,
  platform: PlatformId,
  account: string,
  patch: { truncated: boolean; oldestMs: number | null; backlogDone: boolean; error: string | null },
): void {
  db.prepare(
    `INSERT INTO participation_sync (user_id, platform, account, last_sync_at, backlog_done, oldest_ms, truncated, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, platform, account) DO UPDATE SET
       last_sync_at = excluded.last_sync_at, backlog_done = excluded.backlog_done,
       oldest_ms = excluded.oldest_ms, truncated = excluded.truncated, last_error = excluded.last_error`,
  ).run(
    DEFAULT_USER_ID,
    platform,
    account,
    new Date().toISOString(),
    patch.backlogDone ? 1 : 0,
    patch.oldestMs,
    patch.truncated ? 1 : 0,
    patch.error,
  );
}

/** 每平台最近活跃的绑定账号（同步与拉取都面向当前主力账号） */
function latestAccounts(db: Db): Map<PlatformId, string> {
  const rows = db
    .prepare(
      `SELECT platform, account, MAX(submitted_at) AS latest FROM submissions
       WHERE user_id = ? AND account != ''
         AND platform IN ('codeforces','atcoder','luogu','nowcoder','jisuanke')
       GROUP BY platform`,
    )
    .all(DEFAULT_USER_ID) as Array<{ platform: PlatformId; account: string; latest: string }>;
  return new Map(rows.map((r) => [r.platform, r.account]));
}

function readSetting(db: Db, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

// ---------- 聚合入口 ----------

/** 同一平台的拉取进行中时复用（GET 后台刷新与 chat 同步刷新不会重复打外网） */
const inFlight = new Map<PlatformId, Promise<void>>();

/** 题目集是否为富引用（带比赛内题号）——旧格式纯 id 集合需要重新拉取升级 */
export function problemsAreRich(refs: ContestProblemRef[] | null | undefined): boolean {
  return !!refs && refs.some((r) => r.index !== undefined);
}

/**
 * 牛客题目集按需补齐：仅对「窗口内确有本平台提交、且还没有**富**题目集」的场次发请求
 * （有窗口内提交才存在归因歧义；题目集取到一次即随参赛记录持久化，不再重取；
 * 旧格式纯 id 集合视为未拉取，借下一次同步升级出题号/题名）。
 *
 * **只处理牛客**：本函数抓的是牛客题目集接口。历史上这里漏了平台判断，
 * 而它被每个平台的同步流程共用 —— 于是 Codeforces 的数字 contestId 被拿去查
 * 「牛客同号比赛」，把牛客题目集写进了 CF 场次（真实事故：CF 2241 存进 20 道
 * 牛客「小乐乐」题，导致赛事中心显示 20 题、复盘列出并不存在的未提交题）。
 */
async function enrichProblems(
  db: Db,
  items: AuthoritativeContest[],
  storedById: Map<string, ContestProblemRef[] | null>,
  fetchFn: typeof fetch,
): Promise<void> {
  for (const item of items) {
    if (item.platform !== 'nowcoder') continue; // 牛客题目集接口不得用于其它平台
    if (item.problems || problemsAreRich(storedById.get(item.contestId))) continue;
    if (item.startTimeMs === null || item.endTimeMs === null) continue;
    const candidate = db
      .prepare(
        'SELECT 1 FROM submissions WHERE user_id = ? AND platform = ? AND submitted_at >= ? AND submitted_at <= ? LIMIT 1',
      )
      .get(
        DEFAULT_USER_ID,
        item.platform,
        new Date(item.startTimeMs).toISOString(),
        new Date(item.endTimeMs).toISOString(),
      );
    if (!candidate) continue;
    item.problems = await fetchNowcoderProblems(item.contestId, fetchFn);
  }
}

/**
 * 同步拉取参赛记录（落库后返回）。平台 30 分钟内已拉过 → 直接读库返回；
 * force=true（刷新按钮）无视间隔强制重拉。分页平台按增量游标拉取：
 * backlog 已完成的稳态通常只翻 1 页；触及单次上限标记 truncated，下次续拉。
 * calendar 传入赛事日历（CF/AtCoder 补官方起止时间）；单平台失败记入 failures
 * 并回退库内已有数据。
 */
export async function loadParticipationSources(
  db: Db,
  calendar: ContestInfo[] | undefined,
  opts?: { force?: boolean; fetchFn?: typeof fetch },
): Promise<ParticipationSources> {
  const cal = calendarIndex(calendar);
  const fetchFn = opts?.fetchFn ?? throttledFetch;
  const accounts = latestAccounts(db);
  const luoguCookie = readSetting(db, 'cookie.luogu');
  const jisuankeCookie = readSetting(db, 'cookie.jisuanke');
  const byPlatform: ParticipationSources['byPlatform'] = {};
  const failures: ParticipationSources['failures'] = {};

  interface Task {
    platform: PlatformId;
    account: string;
    fetcher: (o: FetchParticipationOptions) => Promise<ParticipationFetchResult>;
  }
  const tasks: Task[] = [];
  const cfHandle = accounts.get('codeforces');
  if (cfHandle) {
    tasks.push({
      platform: 'codeforces',
      account: cfHandle,
      fetcher: () =>
        fetchCodeforcesParticipation(cfHandle, cal, fetchFn).then((items) => ({ items, truncated: false })),
    });
  }
  const atHandle = accounts.get('atcoder');
  if (atHandle) {
    tasks.push({
      platform: 'atcoder',
      account: atHandle,
      fetcher: () =>
        fetchAtcoderParticipation(atHandle, cal, fetchFn).then((items) => ({ items, truncated: false })),
    });
  }
  const lgAccount = accounts.get('luogu');
  if (lgAccount || luoguCookie) {
    tasks.push({
      platform: 'luogu',
      account: lgAccount ?? '',
      fetcher: (o) => fetchLuoguJoinedContests(luoguCookie, o, fetchFn),
    });
  }
  const ncUid = accounts.get('nowcoder');
  if (ncUid) {
    tasks.push({
      platform: 'nowcoder',
      account: ncUid,
      fetcher: (o) => fetchNowcoderJoinedContests(ncUid, o, fetchFn),
    });
  }
  if (jisuankeCookie) {
    const jskAccount = accounts.get('jisuanke') ?? '';
    tasks.push({
      platform: 'jisuanke',
      account: jskAccount,
      fetcher: () =>
        fetchJisuankeParticipation(jisuankeCookie).then((items) => ({ items, truncated: false })),
    });
  }

  await Promise.all(
    tasks.map(async ({ platform, account, fetcher }) => {
      // force=true 时不复用 in-flight：用户点「刷新」期望强制重拉，不该被后台刷新
      // 的 in-flight 吞掉而看到旧数据。force 请求自己建 in-flight，后续非 force 请求
      // 仍会等它完成（避免同一平台并发两请求打外网）。
      const inflight = opts?.force ? undefined : inFlight.get(platform);
      if (inflight) {
        await inflight.catch(() => {});
        byPlatform[platform] = readStoredContests(db, platform);
        // 补上 in-flight 分支的 failures 读取：原实现只读 byPlatform 不读 failures，
        // 导致在 in-flight 期间发生的失败对调用方不可见
        const inflightState = readSyncState(db, platform, account);
        if (inflightState?.lastError) failures[platform] = inflightState.lastError;
        return;
      }
      const task = (async () => {
        const state = readSyncState(db, platform, account);
        const stored = readStoredContests(db, platform);
        const fresh =
          !opts?.force &&
          state?.lastSyncAt !== null &&
          state?.lastSyncAt !== undefined &&
          Date.now() - Date.parse(state.lastSyncAt) < REFRESH_INTERVAL_MS &&
          (state.backlogDone || stored.length > 0);
        if (fresh) return; // 30 分钟内已拉过：库内数据即是最新
        try {
          const result = await fetcher({
            knownOldestMs: state?.oldestMs ?? null,
            backlogDone: state?.backlogDone ?? false,
          });
          await enrichProblems(
            db,
            result.items,
            new Map(stored.map((r) => [r.contestId, r.problems ?? null])),
            fetchFn,
          );
          const oldestMs = upsertContests(db, platform, account, result.items);
          writeSyncState(db, platform, account, {
            truncated: result.truncated,
            oldestMs,
            backlogDone: !result.truncated,
            error: null,
          });
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          writeSyncState(db, platform, account, {
            truncated: state?.truncated ?? false,
            oldestMs: state?.oldestMs ?? null,
            backlogDone: state?.backlogDone ?? false,
            error: msg,
          });
          failures[platform] = msg;
        }
      })();
      inFlight.set(platform, task);
      try {
        await task;
      } finally {
        inFlight.delete(platform);
      }
      byPlatform[platform] = readStoredContests(db, platform);
    }),
  );

  return { byPlatform, failures };
}

/** 仅读库（不访问网络）：GET 路由用——打开页签秒出，过期平台交给后台刷新 */
export function readParticipationSnapshot(db: Db): {
  byPlatform: ParticipationSources['byPlatform'];
  failures: ParticipationSources['failures'];
  stalePlatforms: PlatformId[];
} {
  const accounts = latestAccounts(db);
  const byPlatform: ParticipationSources['byPlatform'] = {};
  const failures: ParticipationSources['failures'] = {};
  const stalePlatforms: PlatformId[] = [];
  for (const [platform, account] of accounts) {
    const stored = readStoredContests(db, platform);
    if (stored.length > 0) byPlatform[platform] = stored;
    const state = readSyncState(db, platform, account);
    const fresh =
      state?.lastSyncAt !== null &&
      state?.lastSyncAt !== undefined &&
      Date.now() - Date.parse(state.lastSyncAt) < REFRESH_INTERVAL_MS &&
      (state.backlogDone || stored.length > 0 || state.truncated);
    if (state?.lastError) failures[platform] = state.lastError;
    if (!fresh) stalePlatforms.push(platform);
  }
  return { byPlatform, failures, stalePlatforms };
}

/** 后台刷新去重（GET 路由多次触发只跑一轮） */
let backgroundRefresh: Promise<void> | null = null;

/** 过期平台的后台增量刷新（非阻塞）；已有刷新在进行中时不再叠加，返回是否真正启动 */
export function kickBackgroundRefresh(db: Db, calendar: ContestInfo[] | undefined): boolean {
  if (backgroundRefresh) return false;
  backgroundRefresh = loadParticipationSources(db, calendar)
    .then(() => undefined)
    .catch(() => undefined) // 后台刷新失败静默：GET 已返回，错误留存在状态表里
    .finally(() => {
      backgroundRefresh = null;
    });
  return true;
}

// ---------- 复盘时的题目集补拉（CF contest.standings / 牛客 problem-list） ----------

/** 复盘注入需要「未提交的题」，但同步阶段只对有窗口提交的牛客场次拉过题目集；
 * CF 从不拉（每场一次 standings 太贵）。这里在**复盘时**按需补拉单场，
 * 成功即写回 participated_contests.problem_ids 持久缓存，之后零请求。 */
const problemSetBackoff = new Map<string, number>();
const PROBLEM_SET_BACKOFF_MS = 5 * 60_000;

/** 题目集拉取的三态结果：区分「已拉取确认无题」与「未拉取/失败」 */
export type ProblemSetResult =
  | { status: 'ok'; refs: ContestProblemRef[] }
  | { status: 'empty' }
  | { status: 'unavailable' };

/**
 * 按平台拉取单场比赛的题目集并落库（行不存在 = 虚拟赛/gym 等无参赛记录，只返回不落库）。
 * 成功时（含确认无题）写回 problem_set_state；失败返回 unavailable 并退避 5 分钟 ——
 * 每条对话消息都会渲染复盘上下文，不能逐请求重试网络。三态区分避免空题目集被无限重拉。
 */
export async function fetchContestProblemSet(
  db: Db,
  platform: PlatformId,
  contestId: string,
  fetchFn: typeof fetch = throttledFetch,
): Promise<ProblemSetResult> {
  const cacheKey = `${platform}:${contestId}`;
  if (Date.now() - (problemSetBackoff.get(cacheKey) ?? 0) < PROBLEM_SET_BACKOFF_MS) {
    return { status: 'unavailable' };
  }
  problemSetBackoff.set(cacheKey, Date.now());

  let refs: ContestProblemRef[] | null = null;
  try {
    if (platform === 'codeforces') {
      // ① 首选 problemset 全集缓存（零额外请求）：它本来就是为标签抓的，顺带给出每场的题目集
      refs = await cfContestProblems(db, contestId, fetchFn);
      if (refs === null) {
        // ② 退化到 contest.standings。注意 CF 的硬限制（实测 HTTP 400）：
        //    非 gym 场次的匿名请求**不允许**携带 from/count —— 只有 gym 能带（保持在 1 行）。
        //    不带参数会拉回整场排行榜（数 MB），因此只在上面的零请求路径拿不到时才走。
        const params = isCfGymContestId(contestId) ? '&from=1&count=1' : '';
        const body = (await fetchJson(
          `https://codeforces.com/api/contest.standings?contestId=${encodeURIComponent(contestId)}${params}`,
          fetchFn,
        )) as { status?: string; result?: { problems?: Array<Record<string, unknown>> } };
        const rows = body.status === 'OK' ? body.result?.problems : undefined;
        if (Array.isArray(rows)) {
          refs = rows.flatMap((p) => {
            const index = typeof p.index === 'string' ? p.index : null;
            if (index === null) return [];
            const rating = p.rating;
            return [
              {
                id: `${contestId}${index}`,
                index,
                title: typeof p.name === 'string' ? p.name : undefined,
                rating: typeof rating === 'number' ? rating : null,
              } satisfies ContestProblemRef,
            ];
          });
        }
      }
    } else if (platform === 'nowcoder') {
      refs = await fetchNowcoderProblems(contestId, fetchFn);
    } else if (platform === 'atcoder') {
      // 公开 SSR 题目列表：未提交的题也就能拿到题号/题名与题面
      refs = await fetchAtcoderProblemSet(contestId, fetchFn);
    }

    // AtCoder：官方 tasks 页的题名顺手修正库内被社区数据串号的标题
    // （kenkoooo problems.json 实测把 abc454_b 写成「C. Mapping」）
    if (platform === 'atcoder' && refs && refs.length > 0) {
      repairAtcoderTitles(db, refs);
    }

    // CF 未提交题的官方 tags/rating 来自题目集全集缓存（standings 不带 tags）；
    // 拿不到的题保持缺省——宁可空着，不编标签
    if (platform === 'codeforces' && refs && refs.length > 0) {
      const metas = await lookupCfProblems(
        db,
        refs.map((r) => r.id),
        fetchFn,
      );
      for (const ref of refs) {
        const meta = metas.get(ref.id);
        if (!meta) continue;
        ref.tags = meta.tags;
        if (ref.rating == null && meta.rating != null) ref.rating = meta.rating;
      }
    }
  } catch {
    refs = null;
  }

  // 成功拉取（含确认无题）即持久缓存 state；失败不写 state（保持 unknown，下次仍会重试）
  if (refs !== null) {
    const state = refs.length > 0 ? 'ok' : 'empty';
    db.prepare(
      `UPDATE participated_contests SET problem_ids = ?, problem_set_state = ?
       WHERE user_id = ? AND platform = ? AND contest_id = ?`,
    ).run(
      refs.length > 0 ? JSON.stringify(refs) : null,
      state,
      DEFAULT_USER_ID,
      platform,
      contestId,
    );
    return refs.length > 0 ? { status: 'ok', refs } : { status: 'empty' };
  }
  return { status: 'unavailable' };
}
