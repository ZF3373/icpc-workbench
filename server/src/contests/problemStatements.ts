import type { PlatformId } from '../../../shared/src/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import type { Db } from '../db/index.ts';
import { htmlToText, validatePublicFetchUrl } from '../ai/fetch-url.ts';
import { throttledFetch } from '../net/hostThrottle.ts';
import type { ContestReviewData } from './participated.ts';

/**
 * 题面预取 + 落库缓存（复盘根因修复）。
 *
 * 背景：复盘时 AI 只有题名/难度/tags/时间线，没有题面。题名信息量极低且大量重名，
 * AI 凭题名推断题意会系统性出错（虚构一个符合题名的题意，再针对虚构题意给建议）。
 * 题面是把所有其他证据锚定到现实的那根桩。
 *
 * 设计：
 * - **抓取**：CF/AtCoder 是公开 SSR 页面，洛谷需 Cookie。复用 hostThrottle 节流。
 * - **落库**：problem_statements 表，题面几乎不变，缓存永久有效，仅 404/改版时失效重取。
 * - **预取/注入覆盖「所有题」，含赛时已 AC 的题**：曾经只覆盖「未通过 + 未提交」，
 *   结果 AI 对已 AC 的题凭空编造题意（已 AC ≠ 不需要题意：复盘要逐题点评思路与卡点）。
 *   优先级仍是 未通过 → 未提交 → 已 AC，已 AC 的题按更小的预算注入（只需题意与约束）。
 * - **拿不到题面时必须显式声明**：任何未注入题面的题都会在「未取到题面」清单里列名，
 *   提示词据此禁止模型凭题名概括题意——空态必须被说清，否则模型会把"没给"当成"可以编"。
 * - **可抓性按平台实测**（见 statementSupport）：AtCoder / 洛谷可抓（洛谷需过 C3VK 反爬）；
 *   CF 的 HTML 页被 Cloudflare / JS 校验拦死（含官方镜像 m1/m2，实测 403 或机器人校验页）、
 *   牛客题目页需登录、计蒜客·QOJ 无公开源 → 这些平台不抓，改成在上下文里说明原因并请用户粘贴题面。
 * - **噪声一律拒收**（见 statementLooksValid）：权限墙 / 挑战页 / 站点导航不能当题面落库——
 *   实测牛客未登录题库页会吐出 457 字符导航，被当成题面喂给模型比"没有题面"更糟。
 * - **不在 chat 请求路径里同步抓**：预取是后台通道，注入是纯读库。
 */

const FETCH_TIMEOUT_MS = 15_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 单题题面预算（字符）：保留题意+约束+关键样例，去掉冗长解释 */
const PER_PROBLEM_BUDGET = 4000;
/** 已 AC 题的题面预算（更小）：复盘这类题只需要题意与约束，不需要完整样例解释 */
const ACCEPTED_PROBLEM_BUDGET = 1600;
/**
 * 每场题面总量上限（字符）：system 膨胀会挤压对话历史预算。
 * 覆盖已 AC 的题后单场可达 10+ 题，故从 20K 提到 30K（13 题全 AC 约 20.8K，
 * 混合场次约 28K，仍在界内）；超出时按优先级丢弃并在上下文里列名。
 */
const PER_CONTEST_BUDGET = 30000;
/** 单轮后台预取的题目数上限（一场比赛实际 ≤13 题，留余量；其余下轮补） */
const MAX_FETCH_PER_RUN = 26;
/** 题面抓取退避（与 fetchContestProblemSet 同口径）：失败 5 分钟内不重试 */
const FETCH_BACKOFF_MS = 5 * 60_000;
/** 题面正文的最小体量：站点导航/权限提示通常在 100-500 字符区间，低于此一律当噪声 */
const MIN_STATEMENT_CHARS = 120;

/**
 * 「明显不是题面」的标记：权限墙 / 登录墙 / Cloudflare 挑战页。
 * 实测牛客未登录题库页会吐出 457 字符的站点导航（含「没有查看题目的权限哦」），
 * 若不拦截就会被当成题面落库并喂给 AI —— 比没有题面更糟（AI 会对着站点导航"分析题意"）。
 */
const NOISE_MARKERS = [
  '没有查看题目的权限',
  '仅作者可见',
  'Just a moment', // Cloudflare 挑战页标题
  'browser is being checked', // CF 镜像返回的 JS 机器人校验页（实测 m1.codeforces.com 200）
  'Enable JavaScript and cookies to continue',
];

/** 站点导航特征词：一段文本里命中 ≥3 个，基本可以判定是导航而不是题面 */
const NAV_WORDS = ['竞赛讨论区', '登录', '注册', '关于我们', '意见反馈', '下载APP', '去牛客', '扫码'];

/** 题面抓取支持情况（2026-09-26 本机实测，见下方各平台说明） */
export type StatementSupport = 'ok' | 'gated' | 'blocked' | 'unsupported';

/**
 * 各平台题面可抓性（实测结论，改动前请先复测）：
 * - `atcoder` ✅ 公开 SSR：题面在 `#task-statement` 内的 `lang-en` / `lang-ja` 两个 span；
 *   比赛题目列表可从 `/contests/{slug}/tasks` 抓出（实测 abc454 → 7 题）。
 * - `luogu` ✅ 公开但**有 C3VK 反爬**：首请求 302 回自身并下发 C3VK，带新值重试即 200；
 *   题面在 `window.__INITIAL_STATE__`（见 extractLuoguStatement）。
 * - `nowcoder` ⚠️ 题库页**需登录**：匿名只剩导航噪声 → 归为 gated，不抓（由用户粘贴）。
 * - `codeforces` ❌ 所有 HTML 页被 **Cloudflare** 拦截（实测 `/contest/1877/problem/A`、
 *   `/problemset/problem/1877/A` 均 403 "Just a moment..."，补 Accept-Language/Referer 无效）；
 *   `codeforces.com/api/*` 可用但**不含题面** → 服务端拿不到 CF 题面，只能请用户粘贴。
 * - 其余（jisuanke/qoj/daimayuan/leetcode）❌ 无公开可抓来源（QOJ 403 challenge；计蒜客为 SPA）。
 */
export function statementSupport(platform: PlatformId): StatementSupport {
  switch (platform) {
    case 'atcoder':
    case 'luogu':
      return 'ok';
    case 'nowcoder':
      return 'gated';
    case 'codeforces':
      return 'blocked';
    default:
      return 'unsupported';
  }
}

/** 不可抓题面的原因（写进复盘上下文，让 AI 知道该请用户粘贴而不是凭题名硬讲） */
export function statementUnavailableReason(platform: PlatformId): string {
  switch (statementSupport(platform)) {
    case 'ok':
      return '';
    case 'gated':
      return '牛客题目页需登录才可见（匿名只剩站点导航）';
    case 'blocked':
      return 'Codeforces 的 HTML 页被 Cloudflare 拦截（API 不提供题面）';
    default:
      return '该平台没有公开可抓的题面来源';
  }
}

/**
 * 「像题面吗」判定：题面必须像一段可读的题面正文——登录墙 / 权限墙 / 挑战页 / 站点导航一律拒收。
 * 判定的不是"是不是完整题面"，而是"像不像题面"：宁可报「未取到题面」让 AI 去问用户，
 * 也不能把导航文字当题面喂进去。
 */
export function statementLooksValid(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_STATEMENT_CHARS) return false;
  if (NOISE_MARKERS.some((m) => t.includes(m))) return false;
  const navHits = NAV_WORDS.filter((w) => t.includes(w)).length;
  return navHits < 3;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fetchBackoff = new Map<string, number>();

export interface StatementEntry {
  platform: PlatformId;
  problemKey: string;
  text: string;
  sourceUrl: string | null;
  fetchedAt: string;
}

// ---------- 平台特定的题面提取 ----------

/**
 * 从 HTML 中提取 CF 题面正文。
 * CF 题目页的题面在 `<div class="problem-statement">` 内，含题意/输入输出格式/样例。
 */
function extractCfStatement(html: string): string {
  // 截取 problem-statement 区块（避免整页 htmlToText 带入导航噪声）
  const m = html.match(/<div\s+class="[^"]*\bproblem-statement\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);
  const block = m?.[1] ?? html;
  return htmlToText(block);
}

/**
 * 从 HTML 中提取 AtCoder 题面正文。
 *
 * 实测结构（abc454_a，2026-09-26）：
 *   `<div id="task-statement"><span class="lang"><span class="lang-ja">…</span><span class="lang-en">…</span></span></div>`
 * 两种语言各一份。**旧实现用懒匹配到第一个 `</span>` 就收工，实测只抽到 68 字符**
 * （问题文一句，丢掉约束/输入输出/全部样例）→ AI 拿半截题面分析，照样出错。
 * 现在按「语言 span 自身 + 外层 class="lang" 的两个连续 `</span>`」定界，能取到完整正文；
 * 优先英文（模型读英文最稳），退化日文，再退化整个 task-statement 区块。
 */
function extractAtcoderStatement(html: string): string {
  for (const cls of ['lang-en', 'lang-ja']) {
    const m = html.match(
      new RegExp(`<span[^>]*class="${cls}"[^>]*>([\\s\\S]*?)<\\/span>\\s*<\\/span>`, 'i'),
    );
    const text = m?.[1] ? htmlToText(m[1]).trim() : '';
    if (text.length >= 20) return text;
  }
  // 退化：整个 task-statement 区块（截到分享组件/页脚之前，避免带进站点噪声）
  const start = html.search(/<div[^>]*\bid="task-statement"[^>]*>/i);
  if (start < 0) return htmlToText(html);
  const rest = html.slice(start);
  const ends = [rest.indexOf('class="a2a_kit"'), rest.indexOf('<footer')].filter((i) => i > 0);
  const end = ends.length > 0 ? Math.min(...ends) : rest.length;
  return htmlToText(rest.slice(0, end));
}

/**
 * 从 HTML 中提取洛谷题面。
 * 洛谷题面在 `window.__INITIAL_STATE__` JSON 的 `problem.description` 字段（Markdown）。
 * htmlToText 会剥掉 script，必须单独提取——同 extractLuoguSolutions 的模式。
 */
function extractLuoguStatement(html: string): string {
  for (const m of html.matchAll(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g)) {
    try {
      const state = JSON.parse(m[1]!) as unknown;
      const desc = findField(state, ['description', 'content']);
      if (desc && typeof desc === 'string' && desc.length > 20) return desc;
    } catch {
      // JSON 截断/编码不兼容：换下一处
    }
  }
  // 降级：整页 htmlToText（须够长避免噪声）
  const fallback = htmlToText(html);
  return fallback.length > 200 ? fallback : '';
}

/** 递归搜索对象中第一个指定键的长字符串值 */
function findField(node: unknown, keys: string[], depth = 0): string | null {
  if (depth > 10 || node == null) return null;
  if (typeof node === 'string') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const v = findField(child, keys, depth + 1);
      if (v) return v;
    }
    return null;
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.length > 20) return v;
    }
    for (const v of Object.values(obj)) {
      const r = findField(v, keys, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

/** 按平台派发题面提取 */
function extractStatement(html: string, platform: PlatformId): string {
  switch (platform) {
    case 'codeforces':
      return extractCfStatement(html);
    case 'atcoder':
      return extractAtcoderStatement(html);
    case 'luogu':
      return extractLuoguStatement(html);
    default:
      return htmlToText(html);
  }
}

/** 截断题面到预算内，保留开头（题意+约束+样例通常在前半段） */
function truncateStatement(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n（题面过长已截断：仅保留前 ${budget} 字符）`;
}

// ---------- 抓取 + 落库 ----------

async function fetchPage(url: string, fetchFn: typeof fetch, cookie?: string): Promise<string> {
  const res = await fetchFn(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 洛谷页面抓取：必须自行处理 C3VK 反爬挑战（协议同 adapters/luogu.ts 的 fetchWithChallenge，
 * 此处独立实现以免把适配器依赖引到复盘渲染链上）。
 * 首请求 302 回自身并 Set-Cookie 下发新 C3VK（5 分钟有效），带新值重试即 200；
 * `redirect: 'manual'` 是硬要求 —— 跟随的话 302 循环会耗尽 fetch 重定向次数直接抛 fetch failed
 * （实测匿名直连 `https://www.luogu.com.cn/problem/P1001` 就是 fetch failed）。
 */
async function fetchLuoguPage(url: string, fetchFn: typeof fetch, cookie: string): Promise<string> {
  let current = cookie;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    if (attempt > 0) await sleep(300); // 重试间限速，避免毫秒级连发触发风控
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/json',
        Referer: 'https://www.luogu.com.cn/',
        ...(current ? { Cookie: current } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (![301, 302, 303].includes(res.status)) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    }
    const fresh = (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0])
      .find((kv) => kv.startsWith('C3VK='));
    if (!fresh) throw new Error('HTTP 302（未下发新 C3VK：可能需要登录）');
    current = current.includes('C3VK=')
      ? current.replace(/C3VK=[^;]*/, fresh)
      : `${current}; ${fresh}`.replace(/^;\s*/, '');
  }
  throw new Error('洛谷反爬挑战重试超限');
}

/**
 * 抓取单题题面并落库。成功返回正文，失败返回 null（退避期内也返回 null）。
 * 缓存永久有效（题面几乎不变），仅 404/改版时失效重取——不主动过期。
 *
 * 两道门槛：
 * 1. **平台支持矩阵**：CF（Cloudflare 拦截）/ 牛客（需登录）/ 计蒜客·QOJ（无公开源）
 *    直接不抓 —— 反复试只会白打网络，且失败原因会写进上下文让 AI 去问用户；
 * 2. **「像题面吗」校验**：命中权限墙/挑战页/导航噪声一律不落库（宁缺毋滥，
 *    导航文字被当成题面喂给模型比没有题面更糟）。
 */
export async function fetchProblemStatement(
  db: Db,
  platform: PlatformId,
  problemKey: string,
  url: string,
  fetchFn: typeof fetch = throttledFetch,
  cookie?: string,
): Promise<string | null> {
  if (statementSupport(platform) !== 'ok') return null;

  const cacheKey = `${platform}:${problemKey}`;
  if (Date.now() - (fetchBackoff.get(cacheKey) ?? 0) < FETCH_BACKOFF_MS) return null;
  fetchBackoff.set(cacheKey, Date.now());

  const invalid = validatePublicFetchUrl(url);
  if (invalid) return null;

  try {
    const html = platform === 'luogu'
      ? await fetchLuoguPage(url, fetchFn, cookie ?? '')
      : await fetchPage(url, fetchFn, cookie);
    const text = extractStatement(html, platform).trim();
    if (!statementLooksValid(text)) return null; // 登录墙/挑战页/导航噪声：不落库
    const truncated = truncateStatement(text, PER_PROBLEM_BUDGET);
    db.prepare(
      `INSERT INTO problem_statements (platform, problem_key, text, source_url, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (platform, problem_key) DO UPDATE SET
         text = excluded.text, source_url = excluded.source_url, fetched_at = excluded.fetched_at`,
    ).run(platform, problemKey, truncated, url, new Date().toISOString());
    return truncated;
  } catch {
    return null; // 失败静默：退避控制重试频率，不阻断对话
  }
}

// ---------- 读库（纯读，零网络） ----------

/** 读一批题的已缓存题面（Map: problemKey → text） */
export function readProblemStatements(
  db: Db,
  keys: Array<{ platform: PlatformId; problemKey: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const { platform, problemKey } of keys) {
    const row = db
      .prepare('SELECT text FROM problem_statements WHERE platform = ? AND problem_key = ?')
      .get(platform, problemKey) as { text: string } | undefined;
    if (row?.text) out.set(problemKey, row.text);
  }
  return out;
}

// ---------- 题面目标收集（预取与注入共用同一口径） ----------

/** 题面优先级：未通过（最需要复盘）→ 未提交 → 已 AC（也需要，否则只能凭题名编造） */
export type StatementPriority = 'unpassed' | 'unsubmitted' | 'accepted';

export interface StatementTarget {
  problemKey: string;
  /** 题名（有则带上，便于与「逐题提交明细」对齐） */
  title: string | null;
  priority: StatementPriority;
  /** 题目页 URL；null = 该平台/该题没有可抓取的题面来源 */
  url: string | null;
}

/**
 * 收集一场比赛里**所有**需要题面的题（**含赛时已 AC 的题**），按优先级排序。
 *
 * 这是修「已 AC 题被编造题面」的关键：预取与注入共用本函数，保证口径一致——
 * 曾经两处各自只挑「未通过 + 未提交」，已 AC 的题既没抓也没注入，模型却仍被要求
 * 逐题点评，于是顺着题名编出题意。
 */
export function collectStatementTargets(review: ContestReviewData): StatementTarget[] {
  const { contest, submissions, unsubmittedProblems } = review;
  const rowsByKey = new Map<string, typeof submissions>();
  const titleByKey = new Map<string, string | null>();
  const urlByKey = new Map<string, string>();
  for (const s of submissions) {
    const list = rowsByKey.get(s.problemKey);
    if (list) list.push(s);
    else rowsByKey.set(s.problemKey, [s]);
    if (!titleByKey.get(s.problemKey)) titleByKey.set(s.problemKey, s.title ?? null);
    if (s.url && !urlByKey.has(s.problemKey)) urlByKey.set(s.problemKey, s.url);
  }

  const unpassed: StatementTarget[] = [];
  const accepted: StatementTarget[] = [];
  for (const [problemKey, rows] of rowsByKey) {
    const target: StatementTarget = {
      problemKey,
      title: titleByKey.get(problemKey) ?? null,
      priority: rows.some((r) => r.verdict === 'AC') ? 'accepted' : 'unpassed',
      url: urlByKey.get(problemKey) ?? null,
    };
    if (target.priority === 'accepted') accepted.push(target);
    else unpassed.push(target);
  }

  const unsubmitted: StatementTarget[] = [];
  for (const p of unsubmittedProblems) {
    if (rowsByKey.has(p.id)) continue; // 有本地提交的题按提交判定，不重复
    unsubmitted.push({
      problemKey: p.id,
      title: p.title ?? null,
      priority: 'unsubmitted',
      url: problemPageUrl(contest.platform, contest.contestId, contest.url, p),
    });
  }

  return [...unpassed, ...unsubmitted, ...accepted];
}

// ---------- 后台批量预取 ----------

/** 串行链：多场复盘排队抓取，而不是"有在跑就丢弃后一场"（丢的那场题面永远补不上） */
let prefetchChain: Promise<void> = Promise.resolve();
const inFlightContests = new Set<string>();

/**
 * 后台批量预取题面（非阻塞）。覆盖**该场所有能拿到 URL 的题**（未通过 → 未提交 → 已 AC），
 * 已有缓存的跳过；单轮上限 MAX_FETCH_PER_RUN，其余留待下轮。
 * 同一场比赛在飞行中时不重复排队；不同比赛串行排队。
 * 返回排队后的 Promise 供测试等待；调用方（chat 路由）无需等待。
 */
export function prefetchProblemStatementsBackground(
  db: Db,
  review: ContestReviewData,
  fetchFn: typeof fetch = throttledFetch,
  cookies?: Record<string, { cookie?: string }>,
): Promise<void> {
  const contestKey = `${review.contest.platform}:${review.contest.contestId}`;
  if (inFlightContests.has(contestKey)) return prefetchChain;
  inFlightContests.add(contestKey);
  prefetchChain = prefetchChain
    .then(() => prefetchContestStatements(db, review, fetchFn, cookies))
    .catch(() => undefined) // 后台预取失败静默
    .finally(() => {
      inFlightContests.delete(contestKey);
    });
  return prefetchChain;
}

async function prefetchContestStatements(
  db: Db,
  review: ContestReviewData,
  fetchFn: typeof fetch,
  cookies?: Record<string, { cookie?: string }>,
): Promise<void> {
  const { contest } = review;
  const targets = collectStatementTargets(review).filter((t) => t.url);
  let fetched = 0;
  for (const { problemKey, url } of targets) {
    if (fetched >= MAX_FETCH_PER_RUN) break;
    // 已有缓存的题不重抓（题面几乎不变，缓存永久有效）
    const existing = db
      .prepare('SELECT 1 FROM problem_statements WHERE platform = ? AND problem_key = ?')
      .get(contest.platform, problemKey);
    if (existing) continue;
    fetched += 1;
    const cookie = cookies?.[contest.platform]?.cookie;
    await fetchProblemStatement(db, contest.platform, problemKey, url!, fetchFn, cookie);
  }
}

/** 构造未提交题的题目页 URL */
function problemPageUrl(
  platform: PlatformId,
  contestId: string,
  contestUrl: string,
  p: { id: string; index?: string },
): string | null {
  if (platform === 'codeforces' && p.index) {
    return `${contestUrl}/problem/${p.index}`;
  }
  if (platform === 'nowcoder') {
    return `https://ac.nowcoder.com/acm/problem/${p.id}`;
  }
  if (platform === 'atcoder' && p.index) {
    // abc300_a 形式
    const slug = contestId;
    return `https://atcoder.jp/contests/${slug}/tasks/${slug}_${p.index.toLowerCase()}`;
  }
  if (platform === 'luogu') {
    return `https://www.luogu.com.cn/problem/${p.id}`;
  }
  return null;
}

// ---------- 注入到复盘上下文（预算控制 + 空态声明） ----------

/**
 * 将已缓存的题面注入复盘上下文（纯读库，零网络），并**显式声明未取到题面的题**。
 *
 * 两条硬要求：
 * 1. **已 AC 的题也要注入**（预算更小）——复盘要逐题点评，没有题意就只能编造；
 * 2. 任何未注入题面的题都必须在「未取到题面」清单里列名。空态被说清，模型才不会
 *    把"上下文没给"当成"可以顺着题名编"（对齐 renderContestContext 的题目集空态区分）。
 *
 * 每场总量 ≤PER_CONTEST_BUDGET；题多时按优先级丢弃，并说明哪些是被预算丢掉的。
 * 返回内容自带 `### 题面` 标题；无任何目标题时返回空数组。
 */
export function renderStatementSection(
  db: Db,
  review: ContestReviewData,
): string[] {
  const { contest } = review;
  const targets = collectStatementTargets(review);
  if (targets.length === 0) return [];

  const statements = readProblemStatements(
    db,
    targets.map((t) => ({ platform: contest.platform, problemKey: t.problemKey })),
  );

  const lines: string[] = ['### 题面（已落库缓存；用来锚定题意，不要凭题名推测）'];
  const injected = new Set<string>();
  const skippedByBudget: string[] = [];
  let usedBudget = 0;

  // targets 已按优先级排序：未通过 → 未提交 → 已 AC
  for (const target of targets) {
    const text = statements.get(target.problemKey);
    if (!text) continue;
    const perProblem =
      target.priority === 'accepted' ? ACCEPTED_PROBLEM_BUDGET : PER_PROBLEM_BUDGET;
    const body = truncateStatement(text, perProblem);
    if (usedBudget + body.length > PER_CONTEST_BUDGET) {
      skippedByBudget.push(target.problemKey);
      continue;
    }
    usedBudget += body.length;
    injected.add(target.problemKey);
    const label = target.title ? `${target.problemKey} ${target.title}` : target.problemKey;
    lines.push('');
    lines.push(`**${label} 题面：**`);
    lines.push(body);
  }

  const missing = targets.filter((t) => !injected.has(t.problemKey));
  if (missing.length > 0) {
    lines.push('');
    lines.push(
      `**未取到题面（禁止凭题名概括题意、禁止推断考点与卡点）**：${missing.map((t) => t.problemKey).join('、')}`,
    );
    lines.push(
      '（这些题只允许陈述客观事实：提交次数、时间线、结果、AC 语言。要点评思路或卡点，' +
        '先调用 `fetch_url` 读题目链接；读不到就明确写"未取到题面"，不得虚构题意。）',
    );
    const support = statementSupport(contest.platform);
    // 平台压根抓不到（CF 被 Cloudflare 拦 / 牛客需登录 / 计蒜客·QOJ 无源）：
    // 明说原因并给出可执行的替代路径，别写成"正在预取"骗人
    if (support !== 'ok') {
      lines.push(
        `（本平台题面**无法自动抓取**：${statementUnavailableReason(contest.platform)}。` +
          '这些题的题意与卡点分析必须先拿到题面——请让用户把题面正文粘贴到对话里（或上传截图/文本附件），' +
          '也可以让用户把题目链接的正文复制过来；**不得凭题名硬讲**。）',
      );
    }
    const noUrl = support === 'ok' ? missing.filter((t) => !t.url).map((t) => t.problemKey) : [];
    if (noUrl.length > 0) {
      lines.push(`（${noUrl.join('、')} 缺少题目链接，无法自动抓取题面。）`);
    }
    const pending = support === 'ok' ? missing.filter((t) => t.url).map((t) => t.problemKey) : [];
    if (pending.length > 0) {
      lines.push(
        `（${pending.join('、')} 的题面正在后台按场次预取；落库后下一条消息即会注入，无需重开会话。）`,
      );
    }
    if (skippedByBudget.length > 0) {
      lines.push(
        `（其中 ${skippedByBudget.join('、')} 因题面预算已满（${PER_CONTEST_BUDGET} 字符）未注入，可在追问时单独读取。）`,
      );
    }
  }
  return lines;
}

/** 仅供测试：清空进程内预取状态 */
export function __resetProblemStatementsForTest(): void {
  prefetchChain = Promise.resolve();
  inFlightContests.clear();
  fetchBackoff.clear();
}
