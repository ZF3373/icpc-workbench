import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';
import { fetchParticipatedContests } from '../adapters/jisuanke.ts';
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
   * 该场比赛的题目 ID 集（nowcoder 专用：problem-list 拉取后持久化）。
   * null/undefined = 尚未拉取（归因退化为整窗）；空数组按未拉取处理。
   */
  problemIds?: string[] | null;
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

/**
 * GET /acm/contest/problem-list —— 该场比赛的题目 ID 集（归因排歧用：
 * 窗口内的非本场题目是日常练习，不能归因到比赛）。
 */
async function fetchNowcoderProblemIds(
  contestId: string,
  fetchFn: typeof fetch,
): Promise<string[] | null> {
  try {
    const body = (await fetchJson(
      `${NC_API}/acm/contest/problem-list?token=&id=${encodeURIComponent(contestId)}`,
      fetchFn,
      { headers: { Accept: 'application/json' } },
    )) as { data?: { data?: Array<Record<string, unknown>> } };
    const rows = body.data?.data;
    if (!Array.isArray(rows)) return null;
    const ids = rows
      .map((r) => (typeof r.problemId === 'number' ? String(r.problemId) : null))
      .filter((v): v is string => v !== null);
    return ids.length > 0 ? ids : null;
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
              problem_count, accepted_count, problem_ids
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
  }>;
  return rows
    .map((r) => ({
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
      problemIds: parseProblemIds(r.problem_ids),
    }))
    .sort((a, b) => (b.startTimeMs ?? 0) - (a.startTimeMs ?? 0));
}

/** problem_ids JSON → 数组；空数组视为未拉取（归因退化为整窗） */
function parseProblemIds(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return null;
    const ids = arr.filter((v): v is string => typeof v === 'string');
    return ids.length > 0 ? ids : null;
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
      item.problemIds ? JSON.stringify(item.problemIds) : null,
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

/**
 * 牛客题目集按需补齐：仅对「窗口内确有本平台提交、且还没有题目集」的场次发请求
 * （有窗口内提交才存在归因歧义；题目集取到一次即随参赛记录持久化，不再重取）。
 */
async function enrichProblemIds(
  db: Db,
  items: AuthoritativeContest[],
  storedById: Map<string, string[] | null>,
  fetchFn: typeof fetch,
): Promise<void> {
  for (const item of items) {
    if (item.problemIds || storedById.get(item.contestId)) continue;
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
    item.problemIds = await fetchNowcoderProblemIds(item.contestId, fetchFn);
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
      const inflight = inFlight.get(platform);
      if (inflight) {
        await inflight.catch(() => {});
        byPlatform[platform] = readStoredContests(db, platform);
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
          await enrichProblemIds(
            db,
            result.items,
            new Map(stored.map((r) => [r.contestId, r.problemIds ?? null])),
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
