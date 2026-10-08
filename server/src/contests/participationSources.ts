import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';
import { fetchParticipatedContests } from '../adapters/jisuanke.ts';
import { lookupCfProblems, cfContestProblems } from './cfProblemset.ts';
import { isCfGymContestId, problemSetMatchesContest } from './problemSetShape.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { effectiveCredentials } from '../adapters/accountCreds.ts';
import type { Db } from '../db/index.ts';
import { throttledFetch } from '../net/hostThrottle.ts';
import { calendarIndex, contestUrl } from './participated.ts';
import { fetchLuoguPage } from './problemStatements.ts';

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
  /** 该条参赛记录属于哪个账号（participated_contests.account）；同平台多账号时用于分派成绩 */
  account?: string;
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

/** 全平台参赛拉取的默认超时（ms） */
export const FETCH_TIMEOUT_MS = 15_000;
/**
 * 洛谷参赛拉取专用超时（ms）：`AbortSignal.timeout` 从**进节流队列**起算，而洛谷
 * 是全平台最严的 4s/请求档——同窗口只要有 4 个洛谷请求在飞（日历 2 页 × C3VK 挑战
 * 翻倍即可凑齐），队尾的 joinedContests 要等 ~16s，15s 预算在排队中就触发
 * （2026-10 实测：洛谷参赛记录总拉取失败，请求根本没发出去）。30s 覆盖 ~7 个
 * 槽位的排队，作为错峰（kickBackgroundRefresh 等 calendarCache.settled()）之外的安全垫。
 */
export const LUOGU_PARTICIPATION_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 单次拉取的分页上限（防异常响应导致无限翻页；触顶后下次拉取继续向后补全） */
const DEFAULT_MAX_PAGES = 30;
/** 参赛记录刷新间隔：30 分钟内重复打开直接读库，过期平台后台增量刷新 */
const REFRESH_INTERVAL_MS = 30 * 60_000;
/**
 * 失败平台的短退避：拉取失败也会刷新 last_sync_at（writeSyncState 成败同写），
 * 若按同间隔冻结，一次洛谷队列挤兑超时会让平台 30 分钟不可自愈、失败横幅挂满
 * 半小时（2026-10 用户观感「总是拉取失败」）。失败按 5 分钟重试，稳态打外网
 * 频率仍是每平台每次刷新 1~2 个请求，不构成压力。
 */
const FAILURE_RETRY_MS = 5 * 60_000;

/** 该平台本次的新鲜窗口：有失败记录（如超时/风控）按短退避重试，否则 30 分钟 */
function refreshIntervalMs(lastError: string | null | undefined): number {
  return lastError ? FAILURE_RETRY_MS : REFRESH_INTERVAL_MS;
}
/** 无官方起止时间的场次：结束时间回推一个近似窗口（仅用于时间线归因与展示） */
const FALLBACK_WINDOW_MS = 2 * 3_600_000;

const NC_API = 'https://ac.nowcoder.com';

function okStatus(res: Response): boolean {
  return res.status >= 200 && res.status < 300;
}

async function fetchJson(
  url: string,
  fetchFn: typeof fetch,
  init?: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<unknown> {
  const res = await fetchFn(url, {
    signal: AbortSignal.timeout(timeoutMs),
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

/** AtCoder history 的结算时间：接口实际给 `EndTime`（ISO，如 2026-10-04T23:00:00+09:00，
 *  2026-10-08 实测 /users/{h}/history/json），`EndTimeStamp`（Unix 秒）是早期 fixture 口径，
 *  两者都要认。解析不出来返回 NaN，由调用方回退日历时间窗。
 *  这不只是展示问题：落 NULL 的场次既进不了复盘时间窗，也无法作为能力值 rating 锚点的时效依据。 */
function atcoderEndMs(r: Record<string, unknown>): number {
  const stamp = Number(r.EndTimeStamp);
  if (Number.isFinite(stamp) && stamp > 0) return stamp * 1000;
  return typeof r.EndTime === 'string' ? Date.parse(r.EndTime) : NaN;
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
    const endMs = atcoderEndMs(r);
    // 日历命中即取官方赛名：history 的 ContestName 偶有脏值（实测 ARC219 为
    // 「AtCoder Regular Contest-- 219」），而日历条目（官方 contests 页解析）恒为规范名；
    // 未命中日历（太久远的场次）才回退 ContestName / slug
    const calendarEntry = cal.get(`atcoder:${slug}`);
    const win =
      windowFromCalendar(cal, 'atcoder', slug) ??
      (Number.isFinite(endMs) ? windowFromEnd(endMs) : null);
    const isRated = r.IsRated === true;
    const newRating = typeof r.NewRating === 'number' ? r.NewRating : null;
    const oldRating = typeof r.OldRating === 'number' ? r.OldRating : null;
    out.push({
      platform: 'atcoder',
      contestId: slug,
      name: calendarEntry?.name ?? (typeof r.ContestName === 'string' ? r.ContestName : slug),
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
      LUOGU_PARTICIPATION_TIMEOUT_MS,
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

/**
 * 洛谷比赛题目集：比赛详情页内嵌 JSON 的 `contestProblems` 数组（实测公开赛匿名可抓，
 * 过 C3VK 反爬即可；团队赛/重现赛需要登录 Cookie，随参赛同步的 Cookie 传入）。
 * 每项形如 `{"score":100,"problem":{"pid":"P17538","type":"P","name":"音符方阵",…},"no":"A"}`。
 *
 * 为什么必须抓题目集：洛谷比赛题赛后转正 T→P（数字会变、无映射可反查），窗口内按
 * 「T 号才认」的旧口径会把已转正场次的提交统计清零，而放开 P 号又会把比赛进行时
 * 刷的练习题误归进场。题目集给出该场**当前键**（转正后即 P 号）的精确名单，
 * 「窗口内 + 属于该场」的归因才既不漏也不滥。拉取失败返回 null → 归因退回 T 号 × 窗口。
 */
export async function fetchLuoguContestProblems(
  contestId: string,
  cookie: string,
  fetchFn: typeof fetch,
): Promise<ContestProblemRef[] | null> {
  try {
    const html = await fetchLuoguPage(
      `https://www.luogu.com.cn/contest/${encodeURIComponent(contestId)}`,
      fetchFn,
      cookie,
    );
    const key = '"contestProblems":';
    const start = html.indexOf(key);
    if (start < 0) return null;
    // 括号配对提取数组（字符串感知：题目名里的引号/转义不能截断扫描）
    let i = start + key.length;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < html.length; i += 1) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth += 1;
      else if (c === ']') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    if (depth !== 0) return null;
    const arr = JSON.parse(html.slice(start + key.length, i)) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr)) return null;
    const refs: ContestProblemRef[] = [];
    for (const row of arr) {
      const problem = row?.problem as Record<string, unknown> | undefined;
      if (typeof problem?.pid !== 'string' || problem.pid === '') continue;
      refs.push({
        id: problem.pid,
        index: typeof row.no === 'string' ? row.no : undefined,
        title: typeof problem.name === 'string' ? problem.name : undefined,
      });
    }
    return refs.length > 0 ? refs : null;
  } catch {
    return null; // 拉取失败 → 归因退回 T 号 × 窗口（不阻断参赛同步）
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
/**
 * 库内已存的参赛记录（读路径）。account 给定时只取该账号 —— 新鲜度判断必须按账号，
 * 否则第一个账号拉过之后，第二个账号会被判定「已有数据、无需再拉」而永久缺失。
 */
function readStoredContests(db: Db, platform: PlatformId, account?: string): AuthoritativeContest[] {
  const rows = db
    .prepare(
      `SELECT contest_id, name, url, start_ms, end_ms, contest_rank, rating, rating_change,
              problem_count, accepted_count, problem_ids, problem_set_state, account
       FROM participated_contests WHERE user_id = ? AND platform = ?${account !== undefined ? ' AND account = ?' : ''}`,
    )
    .all(...(account !== undefined ? [DEFAULT_USER_ID, platform, account] : [DEFAULT_USER_ID, platform])) as Array<{
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
    account: string;
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
        account: r.account,
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

/**
 * 每平台的绑定账号清单（参赛记录逐账号拉取）。
 *
 * 旧实现每平台只取「最近活跃的一个 handle」，于是同平台第二个账号（练习小号）的
 * 参赛记录**永远不会被拉取**，也没有自己的新鲜度与失败状态。
 * 两个来源合并：platform_accounts 的启用绑定（含刚绑定、还没同步出提交的号）+
 * submissions 里出现过的账号（兜住历史数据里没登记绑定行的情况）。
 * 顺序稳定：绑定表按 id 升序，再补 submissions 里最近活跃优先。
 */
function participationAccounts(db: Db): Map<PlatformId, string[]> {
  const bound = db
    .prepare(
      `SELECT platform, handle FROM platform_accounts
        WHERE user_id = ? AND enabled = 1
          AND platform IN ('codeforces','atcoder','luogu','nowcoder','jisuanke')
        ORDER BY platform, id`,
    )
    .all(DEFAULT_USER_ID) as Array<{ platform: PlatformId; handle: string }>;
  const synced = db
    .prepare(
      `SELECT platform, account, MAX(submitted_at) AS latest FROM submissions
       WHERE user_id = ? AND account != ''
         AND platform IN ('codeforces','atcoder','luogu','nowcoder','jisuanke')
       GROUP BY platform, account
       ORDER BY latest DESC`,
    )
    .all(DEFAULT_USER_ID) as Array<{ platform: PlatformId; account: string; latest: string }>;
  const out = new Map<PlatformId, string[]>();
  const push = (platform: PlatformId, account: string): void => {
    const list = out.get(platform) ?? [];
    if (!list.includes(account)) {
      list.push(account);
      out.set(platform, list);
    }
  };
  for (const row of bound) push(row.platform, row.handle);
  for (const row of synced) push(row.platform, row.account);
  return out;
}

function readSetting(db: Db, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

// ---------- 聚合入口 ----------

/** 同一(平台,账号)的拉取进行中时复用（GET 后台刷新与 chat 同步刷新不会重复打外网）。
 *  键必须带账号：只按平台去重时，同平台第二个账号的拉取会被当成「已有在跑的」吞掉
 *  ——小号参赛记录又永远不会被拉（多账号回归：test/participation-accounts.test.ts）。
 *  每槽是一个**集合**：force 刷新与后台刷新可以并存——用单槽 Map 时 force 会覆盖
 *  在跑的条目，先完成方 finally 里的 delete 会把对方条目一起删掉，后续非 force 调用
 *  查不到 in-flight 就会再起一个并发拉取打外网 */
const inFlight = new Map<string, Set<Promise<void>>>();
const inflightKey = (platform: PlatformId, account: string): string => `${platform}\u0000${account}`;
/** 该平台是否有任一账号正在拉取（洛谷题目集预取的让路判定用） */
function anyInflight(platform: PlatformId): boolean {
  const prefix = `${platform}\u0000`;
  for (const [key, set] of inFlight) if (key.startsWith(prefix) && set.size > 0) return true;
  return false;
}

/** 题目集是否为富引用（带比赛内题号）——旧格式纯 id 集合需要重新拉取升级 */
export function problemsAreRich(refs: ContestProblemRef[] | null | undefined): boolean {
  return !!refs && refs.some((r) => r.index !== undefined);
}

/**
 * 题目集按需补齐：仅对「窗口内确有本平台提交、且还没有**富**题目集」的场次发请求
 * （有窗口内提交才存在归因歧义；题目集取到一次即随参赛记录持久化，不再重取；
 * 旧格式纯 id 集合视为未拉取，借下一次同步升级出题号/题名）。
 *
 * **按平台分派**：牛客内联抓（题目集接口轻）；洛谷**不内联**——返回候选场清单，
 * 由调用方在全部同步任务结束后交给后台预取（kickLuoguProblemSetPrefetch）。
 * 历史上这里漏了平台判断，而它被每个平台的同步流程共用 —— 于是 Codeforces 的数字
 * contestId 被拿去查「牛客同号比赛」，把牛客题目集写进了 CF 场次（真实事故：CF 2241
 * 存进 20 道牛客「小乐乐」题，导致赛事中心显示 20 题、复盘列出并不存在的未提交题）。
 */
async function enrichProblems(
  db: Db,
  items: AuthoritativeContest[],
  storedById: Map<string, ContestProblemRef[] | null>,
  fetchFn: typeof fetch,
): Promise<AuthoritativeContest[]> {
  const luoguCandidates: AuthoritativeContest[] = [];
  for (const item of items) {
    if (item.platform !== 'nowcoder' && item.platform !== 'luogu') continue;
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
    if (item.platform === 'nowcoder') {
      item.problems = await fetchNowcoderProblems(item.contestId, fetchFn);
    } else {
      luoguCandidates.push(item);
    }
  }
  return luoguCandidates;
}

/** 每轮预取的场次上限：剩余场等下一轮同步（30 分钟周期）继续，避免首刷连发打疼洛谷 */
const LUOGU_SET_PREFETCH_PER_CYCLE = 3;
/** 场间间隔：洛谷风控全平台最严（hostThrottle 4s 档）之上再放宽一档 */
const LUOGU_SET_PREFETCH_SPACING_MS = 3_000;
let luoguPrefetchSpacingMs = LUOGU_SET_PREFETCH_SPACING_MS;
/** 后台预取去重：上一轮没跑完时不叠加（剩余场次等下一轮同步再入队） */
let luoguPrefetchInFlight: Promise<void> | null = null;

/** 题目集落库（与 fetchContestProblemSet 同一持久化；预取成功即写，下次读库可见） */
function persistProblemSet(db: Db, platform: PlatformId, contestId: string, refs: ContestProblemRef[]): void {
  db.prepare(
    `UPDATE participated_contests SET problem_ids = ?, problem_set_state = 'ok'
     WHERE user_id = ? AND platform = ? AND contest_id = ?`,
  ).run(JSON.stringify(refs), DEFAULT_USER_ID, platform, contestId);
}

/**
 * 洛谷题目集后台预取：**必须在同步任务全部结束之后启动**。
 * 绝不能内联进同步任务：每场要过 C3VK 两连请求，走 hostThrottle 的 4s/请求最严档，
 * 连发多场会长时间占住洛谷 host 队列——每个请求的 15s 超时从入队起算，此时若有
 * 并发同步（用户点「刷新」的 force 不等后台刷新）把 joinedContests 请求排到队尾，
 * 只会在排队中超时（2026-10 实测：洛谷参赛记录拉取失败 abort timeout）。因此：
 * - 同步任务只收集候选场，全部结束后才在此处脱离执行；
 * - 每轮限量 + 场间间隔；任何同步开始打洛谷（in-flight 非空）立即让路；
 * - 结果直接落库，下次 GET/轮询即可见，无需等下一轮同步的 upsert。
 */
function kickLuoguProblemSetPrefetch(
  db: Db,
  candidates: AuthoritativeContest[],
  cookie: string,
  fetchFn: typeof fetch,
): void {
  if (candidates.length === 0 || luoguPrefetchInFlight) return;
  luoguPrefetchInFlight = (async () => {
    let fetched = 0;
    for (const item of candidates) {
      if (fetched >= LUOGU_SET_PREFETCH_PER_CYCLE) break; // 剩余场等下一轮同步
      if (anyInflight('luogu')) break; // 同步开始打洛谷：让路
      const refs = await fetchLuoguContestProblems(item.contestId, cookie, fetchFn);
      if (refs) {
        persistProblemSet(db, 'luogu', item.contestId, refs);
        fetched += 1;
      }
      await sleep(luoguPrefetchSpacingMs);
    }
  })()
    .catch(() => undefined) // 预取失败不外泄：题目集缺失只是归因退回 T 号 × 窗口
    .finally(() => {
      luoguPrefetchInFlight = null;
    });
}

/** 测试用：调整预取间隔（默认 3s，测试改 0 免拖节奏） */
export function __setLuoguProblemSetPrefetchForTest(spacingMs: number): void {
  luoguPrefetchSpacingMs = spacingMs;
}

/** 测试用：等待在跑的洛谷题目集预取结束（未在跑则立即返回） */
export function __flushLuoguProblemSetPrefetchForTest(): Promise<void> {
  return luoguPrefetchInFlight ?? Promise.resolve();
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
  const accounts = participationAccounts(db);
  const luoguCookie = readSetting(db, 'cookie.luogu');
  const jisuankeCookie = readSetting(db, 'cookie.jisuanke');
  const byPlatform: ParticipationSources['byPlatform'] = {};
  const failures: ParticipationSources['failures'] = {};
  /** 逐账号成败：只有该平台**每个**尝试过的账号都失败，才对该平台报失败 */
  const platformOk = new Set<PlatformId>();
  const platformErrors = new Map<PlatformId, string[]>();

  interface Task {
    platform: PlatformId;
    account: string;
    fetcher: (o: FetchParticipationOptions) => Promise<ParticipationFetchResult>;
  }
  const tasks: Task[] = [];
  // 公开 API 平台（CF/AtCoder/牛客）：按 handle 拉，每个绑定账号一条任务
  for (const handle of accounts.get('codeforces') ?? []) {
    tasks.push({
      platform: 'codeforces',
      account: handle,
      fetcher: () =>
        fetchCodeforcesParticipation(handle, cal, fetchFn).then((items) => ({ items, truncated: false })),
    });
  }
  for (const handle of accounts.get('atcoder') ?? []) {
    tasks.push({
      platform: 'atcoder',
      account: handle,
      fetcher: () =>
        fetchAtcoderParticipation(handle, cal, fetchFn).then((items) => ({ items, truncated: false })),
    });
  }
  for (const handle of accounts.get('nowcoder') ?? []) {
    tasks.push({
      platform: 'nowcoder',
      account: handle,
      fetcher: (o) => fetchNowcoderJoinedContests(handle, o, fetchFn),
    });
  }
  // 洛谷/计蒜客靠登录态：Cookie 取该账号自己的槽位（账号级凭据，不回退平台影子值）。
  // 没有任何绑定账号、但平台级 Cookie 还在（老库/手工配置）时，仍按旧口径拉一次。
  const luoguAccounts = accounts.get('luogu') ?? [];
  for (const handle of luoguAccounts) {
    const cookie = effectiveCredentials(db, 'luogu', handle).cookie;
    if (!cookie) continue;
    tasks.push({ platform: 'luogu', account: handle, fetcher: (o) => fetchLuoguJoinedContests(cookie, o, fetchFn) });
  }
  if (luoguCookie && !luoguAccounts.some((h) => effectiveCredentials(db, 'luogu', h).cookie)) {
    tasks.push({
      platform: 'luogu',
      account: luoguAccounts[0] ?? '',
      fetcher: (o) => fetchLuoguJoinedContests(luoguCookie, o, fetchFn),
    });
  }
  const jisuankeAccounts = accounts.get('jisuanke') ?? [];
  for (const handle of jisuankeAccounts) {
    const cookie = effectiveCredentials(db, 'jisuanke', handle).cookie;
    if (!cookie) continue;
    tasks.push({
      platform: 'jisuanke',
      account: handle,
      fetcher: () => fetchJisuankeParticipation(cookie).then((items) => ({ items, truncated: false })),
    });
  }
  if (jisuankeCookie && !jisuankeAccounts.some((h) => effectiveCredentials(db, 'jisuanke', h).cookie)) {
    tasks.push({
      platform: 'jisuanke',
      account: jisuankeAccounts[0] ?? '',
      fetcher: () =>
        fetchJisuankeParticipation(jisuankeCookie).then((items) => ({ items, truncated: false })),
    });
  }

  // 洛谷题目集预取候选（各任务只收集不抓取，全部任务结束后统一后台预取）
  const luoguPrefetchQueue: AuthoritativeContest[] = [];
  await Promise.all(
    tasks.map(async ({ platform, account, fetcher }) => {
      // force=true 时不复用 in-flight：用户点「刷新」期望强制重拉，不该被后台刷新
      // 的 in-flight 吞掉而看到旧数据。force 请求自己建 in-flight 并入集合，后续非 force
      // 请求会等集合里所有在跑任务完成（避免同一平台并发两请求打外网）。
      const slot = inflightKey(platform, account);
      const inflight = inFlight.get(slot);
      if (!opts?.force && inflight && inflight.size > 0) {
        await Promise.allSettled([...inflight]);
        byPlatform[platform] = readStoredContests(db, platform);
        // 补上 in-flight 分支的 failures 读取：原实现只读 byPlatform 不读 failures，
        // 导致在 in-flight 期间发生的失败对调用方不可见
        const inflightState = readSyncState(db, platform, account);
        if (inflightState?.lastError) failures[platform] = inflightState.lastError;
        return;
      }
      const task = (async () => {
        const state = readSyncState(db, platform, account);
        // 新鲜度与已存数据都按**该账号**判：用整平台 stored 判断会让第二个账号
        // 因第一个账号已拉过而被判定新鲜、永远不拉
        const stored = readStoredContests(db, platform, account);
        const fresh =
          !opts?.force &&
          state?.lastSyncAt !== null &&
          state?.lastSyncAt !== undefined &&
          Date.now() - Date.parse(state.lastSyncAt) < refreshIntervalMs(state.lastError) &&
          (state.backlogDone || stored.length > 0);
        if (fresh) {
          platformOk.add(platform);
          return; // 30 分钟内该账号已拉过：库内数据即是最新
        }
        try {
          const result = await fetcher({
            knownOldestMs: state?.oldestMs ?? null,
            backlogDone: state?.backlogDone ?? false,
          });
          const luoguCandidates = await enrichProblems(
            db,
            result.items,
            new Map(stored.map((r) => [r.contestId, r.problems ?? null])),
            fetchFn,
          );
          luoguPrefetchQueue.push(...luoguCandidates);
          const oldestMs = upsertContests(db, platform, account, result.items);
          writeSyncState(db, platform, account, {
            truncated: result.truncated,
            oldestMs,
            backlogDone: !result.truncated,
            error: null,
          });
          platformOk.add(platform);
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          writeSyncState(db, platform, account, {
            truncated: state?.truncated ?? false,
            oldestMs: state?.oldestMs ?? null,
            backlogDone: state?.backlogDone ?? false,
            error: msg,
          });
          platformErrors.set(platform, [...(platformErrors.get(platform) ?? []), msg]);
        }
      })();
      const running = inFlight.get(slot) ?? new Set<Promise<void>>();
      running.add(task);
      inFlight.set(slot, running);
      try {
        await task;
      } finally {
        running.delete(task);
        if (running.size === 0) inFlight.delete(slot);
      }
      byPlatform[platform] = readStoredContests(db, platform);
    }),
  );

  // 全部同步任务已结束（in-flight 已清空）：此刻启动洛谷题目集后台预取才是安全的
  if (luoguPrefetchQueue.length > 0) {
    kickLuoguProblemSetPrefetch(db, luoguPrefetchQueue, luoguCookie, fetchFn);
  }

  // 逐账号成败汇总：任一账号成功就不算该平台失败（否则小号的 Cookie 失效
  // 会把主力号刚拉到的记录一并标成错误）
  for (const [platform, msgs] of platformErrors) {
    if (platformOk.has(platform)) continue;
    failures[platform] = msgs.length === 1 ? msgs[0] : `${msgs.length} 个账号全部失败：${msgs[0]}`;
  }

  return { byPlatform, failures };
}

/** 仅读库（不访问网络）：GET 路由用——打开页签秒出，过期平台交给后台刷新 */
export function readParticipationSnapshot(db: Db): {
  byPlatform: ParticipationSources['byPlatform'];
  failures: ParticipationSources['failures'];
  stalePlatforms: PlatformId[];
} {
  const accounts = participationAccounts(db);
  const byPlatform: ParticipationSources['byPlatform'] = {};
  const failures: ParticipationSources['failures'] = {};
  const stalePlatforms: PlatformId[] = [];
  for (const [platform, handles] of accounts) {
    const stored = readStoredContests(db, platform);
    if (stored.length > 0) byPlatform[platform] = stored;
    // 任一账号过期/缺记录 → 该平台整体算 stale（后台刷新会只补缺的那部分账号）
    let stale = false;
    const errors: string[] = [];
    for (const account of handles) {
      const state = readSyncState(db, platform, account);
      const own = readStoredContests(db, platform, account);
      const fresh =
        state?.lastSyncAt !== null &&
        state?.lastSyncAt !== undefined &&
        Date.now() - Date.parse(state.lastSyncAt) < refreshIntervalMs(state.lastError) &&
        (state.backlogDone || own.length > 0 || state.truncated);
      if (!fresh) stale = true;
      if (state?.lastError) errors.push(state.lastError);
    }
    // 全部账号都报错才对外报平台失败（与 loadParticipationSources 同口径）
    if (errors.length === handles.length && errors.length > 0) failures[platform] = errors[0];
    if (stale) stalePlatforms.push(platform);
  }
  return { byPlatform, failures, stalePlatforms };
}

/** 后台刷新去重（GET 路由多次触发只跑一轮） */
let backgroundRefresh: Promise<void> | null = null;

/**
 * 过期平台的后台增量刷新（非阻塞）；已有刷新在进行中时不再叠加，返回是否真正启动。
 *  fetchFn 透传给拉取层：路由把注入的 fetchFn 带进来，测试才能 stub 而不打外网。
 *
 * `after`：错峰挂点（路由传 calendarCache.settled()）。GET /participated 在同一请求里
 * 先 kick 日历后台重拉、又 kick 本刷新——两者并发打洛谷会把 joinedContests 挤到
 * 队尾等 ~16s，15s/30s 超时从进队起算（2026-10 实测：洛谷参赛记录总拉取失败）。
 * 等日历落幕后启动，洛谷桶里就没有自己人了；`after` 失败不阻断刷新本身。
 */
export function kickBackgroundRefresh(
  db: Db,
  calendar: ContestInfo[] | undefined,
  fetchFn?: typeof fetch,
  after?: Promise<void>,
): boolean {
  if (backgroundRefresh) return false;
  backgroundRefresh = Promise.resolve(after)
    .catch(() => undefined) // 放行信号出问题不该连累参赛刷新
    .then(() => loadParticipationSources(db, calendar, { ...(fetchFn ? { fetchFn } : {}) }))
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
    } else if (platform === 'luogu') {
      // 比赛页 contestProblems：转正 P 号 / 未转正 T 号都按当前键给出，
      // 复盘的「赛时未提交的题」列表与赛事中心的归因同一数据源
      refs = await fetchLuoguContestProblems(contestId, readSetting(db, 'cookie.luogu'), fetchFn);
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
