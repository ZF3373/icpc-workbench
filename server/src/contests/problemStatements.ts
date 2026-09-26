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
 * - **预取**：复盘打开时按场次批量预取（只对未通过+未提交的题），后台非阻塞。
 * - **注入**：renderContestContext 读库拼题面，受预算约束（每场 ≤20K 字符，只注入未通过/未提交题）。
 * - **不在 chat 请求路径里同步抓**：预取是后台通道，注入是纯读库。
 */

const FETCH_TIMEOUT_MS = 15_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 单题题面预算（字符）：保留题意+约束+关键样例，去掉冗长解释 */
const PER_PROBLEM_BUDGET = 4000;
/** 每场题面总量上限（字符）：system 膨胀会挤压对话历史预算 */
const PER_CONTEST_BUDGET = 20000;
/** 题面抓取退避（与 fetchContestProblemSet 同口径）：失败 5 分钟内不重试 */
const FETCH_BACKOFF_MS = 5 * 60_000;

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
 * AtCoder 题目页的题面在 `#task-statement` 或 `#problem-statement` 区块内。
 */
function extractAtcoderStatement(html: string): string {
  const m = html.match(/<(?:div|span)[^>]*\bid="task-statement"[^>]*>([\s\S]*?)<\/(?:div|span)>/i)
    ?? html.match(/<(?:div|span)[^>]*\bid="problem-statement"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
  const block = m?.[1] ?? html;
  return htmlToText(block);
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
 * 抓取单题题面并落库。成功返回正文，失败返回 null（退避期内也返回 null）。
 * 缓存永久有效（题面几乎不变），仅 404/改版时失效重取——不主动过期。
 */
export async function fetchProblemStatement(
  db: Db,
  platform: PlatformId,
  problemKey: string,
  url: string,
  fetchFn: typeof fetch = throttledFetch,
  cookie?: string,
): Promise<string | null> {
  const cacheKey = `${platform}:${problemKey}`;
  if (Date.now() - (fetchBackoff.get(cacheKey) ?? 0) < FETCH_BACKOFF_MS) return null;
  fetchBackoff.set(cacheKey, Date.now());

  const invalid = validatePublicFetchUrl(url);
  if (invalid) return null;

  try {
    const html = await fetchPage(url, fetchFn, cookie);
    const text = extractStatement(html, platform).trim();
    if (text.length < 50) return null; // 抓取失败或内容过短（JS 渲染/登录墙）
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

// ---------- 后台批量预取 ----------

let prefetching: Promise<void> | null = null;

/**
 * 后台批量预取题面（非阻塞）。只对复盘中的「未通过 + 未提交」题抓取
 * （一场通常 ≤6 题），已 1A 的简单题跳过。成功落库后下次复盘即有题面注入。
 * 不在 chat 同步路径里阻塞——注入是纯读库，预取走后台通道。
 */
export function prefetchProblemStatementsBackground(
  db: Db,
  review: ContestReviewData,
  fetchFn: typeof fetch = throttledFetch,
  cookies?: Record<string, { cookie?: string }>,
): void {
  if (prefetching) return; // 已有预取在进行中，不叠加
  prefetching = (async () => {
    const { contest, submissions, unsubmittedProblems } = review;
    // 未通过的题：本地有提交但无 AC
    const byProblem = new Map<string, typeof submissions>();
    for (const s of submissions) {
      const list = byProblem.get(s.problemKey);
      if (list) list.push(s);
      else byProblem.set(s.problemKey, [s]);
    }
    const failedKeys = new Set<string>();
    for (const [key, rows] of byProblem) {
      if (!rows.some((r) => r.verdict === 'AC')) failedKeys.add(key);
    }
    // 未提交的题
    const unsubmittedKeys = new Set(unsubmittedProblems.map((p) => p.id));
    // 合并需要预取的题（未通过 + 未提交）
    const toFetch: Array<{ problemKey: string; url: string }> = [];
    for (const s of submissions) {
      if (failedKeys.has(s.problemKey) && s.url) {
        toFetch.push({ problemKey: s.problemKey, url: s.url });
      }
    }
    for (const p of unsubmittedProblems) {
      if (!unsubmittedKeys.has(p.id)) continue;
      // 构造题目页 URL
      const url = problemPageUrl(contest.platform, contest.contestId, contest.url, p);
      if (url) toFetch.push({ problemKey: p.id, url });
    }
    // 去重（同一题可能在多次提交中出现）
    const seen = new Set<string>();
    for (const { problemKey, url } of toFetch) {
      if (seen.has(problemKey)) continue;
      seen.add(problemKey);
      // 已有缓存的题不重抓
      const existing = db
        .prepare('SELECT 1 FROM problem_statements WHERE platform = ? AND problem_key = ?')
        .get(contest.platform, problemKey);
      if (existing) continue;
      const cookie = cookies?.[contest.platform]?.cookie;
      await fetchProblemStatement(db, contest.platform, problemKey, url, fetchFn, cookie);
    }
  })()
    .catch(() => undefined) // 后台预取失败静默
    .finally(() => {
      prefetching = null;
    });
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

// ---------- 注入到复盘上下文（预算控制） ----------

/**
 * 将已缓存的题面注入复盘上下文（纯读库，零网络）。
 * 只注入未通过 + 未提交的题，已 1A 的简单题跳过。
 * 每场总量 ≤20K 字符，超出时按未通过题优先。
 */
export function renderStatementSection(
  db: Db,
  review: ContestReviewData,
): string[] {
  const { contest, submissions, unsubmittedProblems } = review;
  // 收集需要注入题面的题（未通过 + 未提交）
  const byProblem = new Map<string, typeof submissions>();
  for (const s of submissions) {
    const list = byProblem.get(s.problemKey);
    if (list) list.push(s);
    else byProblem.set(s.problemKey, [s]);
  }
  const failedKeys = new Set<string>();
  for (const [key, rows] of byProblem) {
    if (!rows.some((r) => r.verdict === 'AC')) failedKeys.add(key);
  }
  const unsubmittedKeys = new Set(unsubmittedProblems.map((p) => p.id));
  const allKeys = [
    ...[...failedKeys].map((k) => ({ platform: contest.platform, problemKey: k })),
    ...[...unsubmittedKeys].map((k) => ({ platform: contest.platform, problemKey: k })),
  ];
  // 去重
  const uniqueKeys = allKeys.filter((k, i, arr) =>
    arr.findIndex((x) => x.problemKey === k.problemKey) === i,
  );
  if (uniqueKeys.length === 0) return [];

  const statements = readProblemStatements(db, uniqueKeys);
  if (statements.size === 0) return [];

  const lines: string[] = [];
  let usedBudget = 0;
  let injected = 0;
  const skipped: string[] = [];

  // 优先注入未通过的题
  const orderedKeys = [
    ...[...failedKeys],
    ...[...unsubmittedKeys].filter((k) => !failedKeys.has(k)),
  ];

  for (const key of orderedKeys) {
    const text = statements.get(key);
    if (!text) continue;
    if (usedBudget + text.length > PER_CONTEST_BUDGET) {
      skipped.push(key);
      continue;
    }
    usedBudget += text.length;
    injected += 1;
    lines.push('');
    lines.push(`**${key} 题面：**`);
    lines.push(text);
  }

  if (skipped.length > 0) {
    lines.push('');
    lines.push(
      `（题面预算已满（${PER_CONTEST_BUDGET} 字符），以下题的题面未注入：${skipped.join(', ')}。可追问时单独读取。）`,
    );
  }
  if (injected === 0) return [];
  return lines;
}

/** 仅供测试：清空进程内预取状态 */
export function __resetProblemStatementsForTest(): void {
  prefetching = null;
  fetchBackoff.clear();
}
