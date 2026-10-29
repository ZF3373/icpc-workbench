/**
 * clist.by 第三方难度备选源（issue #57）。
 *
 * 背景：平台自身给不出难度的题（AtCoder 未被 kenkoooo 收录的旧题、Codeforces gym/官方 Unrated、
 * 牛客站上难度格为空、洛谷「暂无评定」等）此前只有两条出路 —— 记为「无官方难度」，或在界面上
 * 手动填写。issue #57 建议用第三方聚合站 clist.by 的数据兜底：该站收录了多个 OJ 的题目与 rating，
 * 支持「限定 resource + 题目名」的唯一查询。
 *
 * 落地时实测确认的约束（决定了本模块的形状）：
 * 1. **必须带 API Key**：`GET /api/v4/problem/` 无凭据直接 401；网页端 `/problems/` 被
 *    Cloudflare 挑战拦截（403 Just a moment），因此**不做 HTML 抓取**，只走官方 JSON API。
 *    Key 由用户在设置页填写（clist.by 账户页可复制，免费账号即可）。
 * 2. **限额 10 次/分钟**（官方 API 文档 Throttle 节）。因此绝不能逐题无脑打：本模块只由回填
 *    在「主来源确实没难度」时调用，且每轮有硬上限（见 difficultyBackfill 的 MAX_CLIST_LOOKUPS_PER_RUN），
 *    同时 `clist.by` 已登记进 net/hostThrottle 的 6s/次安全下限。
 * 3. **用题目链接确认身份**（2026-10-29 实测修正）：同名不同题在 clist 上是常态（本机 CF 缺难度
 *    466 行里 46 行与同平台另一行同名；`Spy Detected!` 5 条、`Treasure Hunt` 16 条），
 *    而「同名候选的 rating 唯一」**不等于**「命中的就是这一道题」——实测 `Shortest Path` 会为
 *    gym `100153E` 返回唯一非空值 2132（来自常规赛 `59E`），照写就是错的。
 *    故现在**只以 URL 归一后相等作为同一题的证据**：本行没有链接、或返回行里没有链接与本行
 *    一致的记录 → 返回 null（宁可漏补，不写错）。题目名只用于服务端检索（`name=` 实测为精确匹配）。
 *
 * 数据落库口径：`difficulty` = rating（钳到 800–3500）、`native_difficulty` = rating 原文、
 * `difficulty_scale` = `clist-rating`（见 shared/src/difficulty.ts），`difficulty_source` = `clist`。
 * 它不是平台官方难度 —— 标度与来源两列都如实标注，且优先级低于 sync/bank/backfill，
 * 平台后来给出权威难度时会被正常覆盖。
 */
import type { PlatformId } from '../../../shared/src/index.ts';
import { CF_RATING_MAX, CF_RATING_MIN } from '../../../shared/src/difficulty.ts';
import { asHttpClient } from '../adapters/http.ts';
import type { Db } from '../db/index.ts';

/** clist.by 题目查询接口（v4；返回 `{ objects: [{ name, url, rating }], meta }`） */
export const CLIST_API_BASE = 'https://clist.by/api/v4/problem/';

/** 设置页保存凭据用的 settings 键 */
export const CLIST_USERNAME_KEY = 'clist.username';
export const CLIST_APIKEY_KEY = 'clist.apiKey';

/** 单轮回填允许的 clist.by 查询次数上限（10 次/分钟 × 6s/次；40 次 ≈ 4 分钟）。 */
export const MAX_CLIST_LOOKUPS_PER_RUN = 40;

/**
 * 平台 → clist.by 的 `resource__regex` 过滤词。
 *
 * 只登记**确认被 clist.by 收录**的平台：codeforces / atcoder / luogu / nowcoder / leetcode
 * （clist.by 的 resource 列表里能看到这几家；qoj / 计蒜客 / 代码源 / DashOJ 未收录，
 * 对这些平台发请求只会白烧 10 次/分钟的额度，故不登记 —— 未登记 = 直接返回 unsupported，不发请求）。
 *
 * 用「域名片段」而不是精确域名：resource__regex 是正则**子串**匹配（2026-10-29 实测），片段同时覆盖
 * `www.luogu.com.cn` 与 `luogu.com.cn` 这类形态差异。
 *
 * 注意（有意保留）：`codeforces\.com` 也会命中 clist 的 `codeforces.com/gyms` resource（实测
 * `^codeforces\.com$` 可把 gyms 排除，但**故意不加锚**）—— 身份由 URL 判定（见 pickUniqueClistRating），
 * gym 与常规赛题的 URL 不同，不会互串；保留 gyms 是为了将来 clist 给 gym 题评级时仍能采纳
 * （本机 CF 缺难度行里 115/466 是 gym，正是最需要兜底的一类）。
 */
export const CLIST_RESOURCE_FILTER: Partial<Record<PlatformId, string>> = {
  codeforces: 'codeforces\\.com',
  atcoder: 'atcoder\\.jp',
  luogu: 'luogu\\.com\\.cn',
  nowcoder: 'nowcoder\\.com',
  leetcode: 'leetcode\\.(com|cn)',
};

/** 平台是否可能从 clist.by 取到难度（false = 该站未收录，调用方不必浪费额度） */
export function clistSupportsPlatform(platform: PlatformId): boolean {
  return CLIST_RESOURCE_FILTER[platform] !== undefined;
}

/** clist.by 凭据（设置页保存；username 可为空，此时 apiKey 需自带 `user:key` 形态） */
export interface ClistCredentials {
  username: string;
  apiKey: string;
}

/** settings 键读取器（与 db/settings.ts 的 SettingLookup 同签名，便于复用请求内快照） */
type SettingReader = (key: string) => string | undefined | null;

/** 从已建好的读取器（快照）取凭据；未配置（apiKey 为空）返回 null */
export function clistCredentialsOf(read: SettingReader): ClistCredentials | null {
  const get = (key: string): string => {
    const v = read(key);
    return typeof v === 'string' ? v.trim() : '';
  };
  return normalizeClistCredentials(get(CLIST_USERNAME_KEY), get(CLIST_APIKEY_KEY));
}

/** 从 settings 表读凭据；未配置返回 null（回填链路用；只读两行，代价可忽略） */
export function readClistCredentials(db: Db): ClistCredentials | null {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  return clistCredentialsOf((key) => {
    const row = stmt.get(key) as { value?: string } | undefined;
    return typeof row?.value === 'string' ? row.value : undefined;
  });
}

/**
 * 归一/校验凭据：apiKey 必填；username 可空（此时把 apiKey 当作 `user:key` 整串）。
 * 只做「是否值得发请求」的判定，不校验 key 真伪（由 `/api/settings/clist/test` 实测）。
 */
export function normalizeClistCredentials(username: unknown, apiKey: unknown): ClistCredentials | null {
  const u = typeof username === 'string' ? username.trim() : '';
  const k = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (k === '') return null;
  return { username: u, apiKey: k };
}

/**
 * Authorization 头。clist.by 的 API 要求 `Authorization: ApiKey <username>:<api_key>`；
 * 用户直接把账户页那串 `user:key` 粘进 Key 框（username 留空）时原样发送，两种填法都能用。
 */
export function clistAuthorization(creds: ClistCredentials): string {
  if (creds.username === '') return `ApiKey ${creds.apiKey}`;
  return `ApiKey ${creds.username}:${creds.apiKey}`;
}

/** 题目名归一：去首尾空白、连续空白折成一个空格、大小写不敏感（仅用于检索与日志，不作身份证据） */
export function normalizeProblemName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

/**
 * 题目 URL 归一——**身份判定的唯一依据**（见 pickUniqueClistRating）。
 *
 * 实测差异（2026-10-29 真实响应）：clist 对同一站点的记录 `url` 既有 http 也有 https
 * （如 `1351A` 是 http、`1959A` 是 https），而库内统一是 https；另外可能出现 `www.` 前缀、
 * 末尾斜杠、query/fragment。这些差异不影响身份，故统一成 `https://<host 去 www><path 去尾斜杠>`
 * 再比较。无法解析（空串/非 URL）→ 空串（= 没有身份证据，调用方应放弃写入）。
 */
export function normalizeProblemUrl(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return '';
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `https://${host}${path}`;
  } catch {
    return '';
  }
}

/** 一次查询的目标题：题名（服务端 `name=` 检索用）+ 链接（身份判定用） */
export interface ClistTarget {
  title: string;
  /** 库内这道题的 URL；为空 = 无法核对身份，调用方应跳过 */
  url: string | null;
}

/** 单条 clist.by 题目（只取用得到的字段） */
export interface ClistProblemRow {
  name: string;
  url: string | null;
  rating: number | null;
}

/** rating 归一：只接受有限正数（clist 的 rating 与 CF 同标尺，实测为整数；空值 = 该站也没有） */
export function parseClistRating(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

/** 解析 `/` 响应：容忍缺失字段与脏行（多了字段不影响；`objects` 非数组时返回空表） */
export function parseClistProblems(payload: unknown): ClistProblemRow[] {
  const list = (payload as { objects?: unknown } | null)?.objects;
  if (!Array.isArray(list)) return [];
  const rows: ClistProblemRow[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const o = item as { name?: unknown; url?: unknown; rating?: unknown };
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (name === '') continue;
    rows.push({
      name,
      url: typeof o.url === 'string' ? o.url : null,
      rating: parseClistRating(o.rating),
    });
  }
  return rows;
}

/**
 * 在查询结果里挑出这道题**自己**的 rating。
 *
 * 判定规则（2026-10-29 按实测缺陷重写）：
 * - **以 URL 为身份**：只有归一后与目标链接相等的行才参评。题目名相同**不算**证据 ——
 *   clist 上同名不同题是常态（`Spy Detected!` 5 条、`Treasure Hunt` 16 条），而「同名候选里
 *   唯一非空 rating」完全可能来自另一道题（实测 `Shortest Path`：gym `100153/E` 自身 rating
 *   为 null，同名中唯一非空的是常规赛 `59/E` 的 2132 —— 旧实现会把 2132 写给它）。
 * - 目标链接为空 / 无法解析 → null（没有身份证据就不写）。
 * - 同 URL 命中的行非空 rating 去重后**恰好一个**才采纳；0 个或 ≥2 个不同值 → null（不猜）。
 */
export function pickUniqueClistRating(
  rows: readonly ClistProblemRow[],
  target: ClistTarget,
): number | null {
  const wantUrl = normalizeProblemUrl(target.url);
  if (wantUrl === '') return null;
  const ratings = new Set<number>();
  for (const row of rows) {
    if (normalizeProblemUrl(row.url) !== wantUrl) continue;
    if (row.rating !== null) ratings.add(row.rating);
  }
  if (ratings.size !== 1) return null;
  return [...ratings][0]!;
}

/** 构造查询 URL；平台未收录或题目名为空 → null（调用方据此直接跳过，不发请求） */
export function buildClistProblemUrl(platform: PlatformId, title: string): string | null {
  const filter = CLIST_RESOURCE_FILTER[platform];
  const name = title.trim();
  if (filter === undefined || name === '') return null;
  const q = new URLSearchParams({
    resource__regex: filter,
    name,
    // 只取少量对象：唯一命中判定不依赖大页，limit 越小响应越快，也少占带宽
    limit: '20',
  });
  return `${CLIST_API_BASE}?${q.toString()}`;
}

/** 一次查询的结局：区分「未收录/无记录」与「凭据或限流问题」（后者本轮不应继续打） */
export type ClistLookup =
  | { status: 'hit'; rating: number }
  | { status: 'miss' }
  | { status: 'unsupported' }
  | { status: 'unauthorized' }
  | { status: 'rate_limited' }
  | { status: 'failed' };

/**
 * 查一道题在 clist.by 的 rating。
 * - 401/403：Key 缺失/无效 → `unauthorized`（调用方应停掉本轮所有 clist 查询并提示用户）
 * - 429：额度用尽 → `rate_limited`（同上）
 * - 其余非 2xx / 网络异常 / JSON 结构不符 → `failed`（只是这一题没查到，不写任何结论）
 */
export async function fetchClistRating(
  fetchFn: typeof fetch,
  creds: ClistCredentials,
  platform: PlatformId,
  target: ClistTarget,
): Promise<ClistLookup> {
  const url = buildClistProblemUrl(platform, target.title);
  if (url === null) return { status: 'unsupported' };
  let res: Response;
  try {
    res = await asHttpClient(fetchFn).fetch(
      url,
      {
        headers: {
          Authorization: clistAuthorization(creds),
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      // 不传 label：asHttpClient 带 label 时会把非 2xx 直接抛出（错误消息形如 clist.by HTTP 401），
      // 那样下面就分不清「认证失败」与「上游坏了」—— 这里要自己分流状态码
      { timeoutMs: 20000 },
    );
  } catch {
    return { status: 'failed' };
  }
  if (res.status === 401 || res.status === 403) return { status: 'unauthorized' };
  if (res.status === 429) return { status: 'rate_limited' };
  if (!res.ok) return { status: 'failed' };
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'failed' };
  }
  const rating = pickUniqueClistRating(parseClistProblems(payload), target);
  return rating === null ? { status: 'miss' } : { status: 'hit', rating };
}

/** clist rating → 落库的 difficulty（钳到 CF 标尺取值域，与 shared 的 clampRating 同口径） */
export function clistRatingToDifficulty(rating: number): number {
  return Math.min(CF_RATING_MAX, Math.max(CF_RATING_MIN, Math.round(rating)));
}

/**
 * 连通性自检（设置页「测试」按钮）：用**只读的最小查询**确认 Key 是否有效。
 * 成功判据是「拿到了 JSON 而不是 401」—— 不要求查到任何题（题库本来就可能没有目标）。
 * 返回的 message 直接展示给用户，因此写明该做什么。
 */
export async function testClistCredentials(
  fetchFn: typeof fetch,
  creds: ClistCredentials,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await asHttpClient(fetchFn).fetch(
      `${CLIST_API_BASE}?limit=1`,
      {
        headers: {
          Authorization: clistAuthorization(creds),
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      },
      { timeoutMs: 20000 },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: 'clist.by 认证失败（401/403）：请核对用户名与 API Key（账户页可复制），或确认 Key 未被重置' };
    }
    if (res.status === 429) {
      return { ok: false, message: 'clist.by 限流（429）：免费账号 10 次/分钟，请稍后再试' };
    }
    if (!res.ok) return { ok: false, message: `clist.by 返回 HTTP ${res.status}` };
    const payload = (await res.json()) as { objects?: unknown };
    if (!Array.isArray(payload.objects)) {
      return { ok: false, message: 'clist.by 响应结构异常（未取到 objects 数组）' };
    }
    return { ok: true, message: 'clist.by 连接正常（标准限额 10 次/分钟）' };
  } catch (e) {
    return { ok: false, message: `clist.by 连接失败：${(e as Error).message}` };
  }
}
