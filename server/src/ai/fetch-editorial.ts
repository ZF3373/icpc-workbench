import type { ToolDefinition } from './provider.ts';
import type { ToolResult, ToolContext } from './tools/registry.ts';
import { registerTool, type PlatformCookies } from './tools/registry.ts';
import { htmlToText, validatePublicFetchUrl } from './fetch-url.ts';
import { throttledFetch } from '../net/hostThrottle.ts';

/**
 * fetch_editorial 工具：读取一场比赛/一道题目的题解（editorial）。
 *
 * 背景：复盘时 AI 需要题解佐证知识点/解法，凭空推导难题会给出看似确定的错误
 * 题解（用户反馈）。各平台题解源形态不同，裸 fetch_url 不一定找得到入口：
 * - 牛客：题解是讨论帖，链接藏在比赛页 SSR HTML 里（「题解」锚文本），两跳才能到；
 * - AtCoder：官方 editorial 页公开（/contests/{slug}/editorial）；
 * - 洛谷：题解区按题一页，需登录（带已保存的 cookie.luogu），内容在
 *   window.__INITIAL_STATE__ JSON 里（htmlToText 会剥掉 script，需单独提取）；
 * - Codeforces：editorial 是博客链接、无稳定来源 —— 工具明确告知，不编造。
 *
 * 每次返回截断到 15K 字符，防止超长题解挤占对话上下文。
 */

export const FETCH_EDITORIAL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'fetch_editorial',
    description:
      '读取一场比赛或一道题目的题解（editorial / 题解帖）。传入以下任一 URL：' +
      '牛客比赛页（ac.nowcoder.com/acm/contest/{id}，自动定位该场题解帖）、' +
      '牛客题解帖直达链接（nowcoder.com/discuss/{id}，直接读正文）、' +
      '牛客系列题解列表（ac.nowcoder.com/acm/discuss/tutorials?tagId=…，返回题解帖条目清单，再把帖子链接传回本工具）、' +
      'AtCoder 比赛页（atcoder.jp/contests/{slug}，读官方 editorial）、' +
      '洛谷题目页（www.luogu.com.cn/problem/{pid}，读题解区，需已配置洛谷 Cookie）。' +
      'Codeforces 无稳定题解源，调用会明确提示（可改用 web_search 找官方 tutorial 博客）。' +
      '复盘时对「未提交的题」或判断不准的题，先用本工具读题解再下结论；没有题解佐证时不要给出看似确定的完整解法。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '比赛页或题目页的完整网址（http/https）',
        },
      },
      required: ['url'],
    },
  },
};

/** 单次返回的题解正文上限：一场合并题解（牛客整场一帖）也可能很长，防挤爆上下文 */
const MAX_EDITORIAL_CHARS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface EditorialResult {
  /** 题解正文（失败时缺省，error 说明原因） */
  content?: string;
  /** 来源链接（metadata 引用展示用） */
  sourceUrl?: string;
  error?: string;
}

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
 * 牛客比赛页 → 题解帖链接。优先认锚文本带「题解」的讨论帖；锚文本不携带时
 * 再看链接前的紧邻文字。窗口刻意收窄 —— 抓一个无关帖子回来会误导分析，
 * 宁可返回 null 让调用方给出「未找到题解入口」。
 */
export function findNowcoderEditorialLink(html: string, baseUrl = 'https://ac.nowcoder.com'): string | null {
  const absolutify = (href: string) => new URL(href, baseUrl).toString();
  // 牛客 SSR 会把部分公告/题解区块以转义 JSON 内嵌（href=\"...\"），先还原引号
  // 再匹配锚点；只用于链接发现，不影响原 HTML 的其他用途
  const normalized = html.replace(/\\"/g, '"');
  const anchors = [...normalized.matchAll(/<a\s[^>]*href="([^"]*\/discuss\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const m of anchors) {
    const text = m[2]!.replace(/<[^>]+>/g, '');
    if (text.includes('题解')) return absolutify(m[1]!);
  }
  for (const m of anchors) {
    const before = normalized.slice(Math.max(0, (m.index ?? 0) - 60), m.index ?? 0);
    if (before.includes('题解')) return absolutify(m[1]!);
  }
  return null;
}

/** 题解正文的体量下限：登录墙残留 / 站点导航噪声通常远低于此 */
const MIN_EDITORIAL_CHARS = 200;

/**
 * 登录墙关键词的扫描窗口。未登录抓取牛客题解帖时页面只剩导航噪声（实测渲染成
 * 「仅作者可见！」+ 站点导航）；该提示实测可能出现在标题/面包屑**之后**，
 * 只查前 400 字符会漏判 —— 把导航噪声当题解喂给 AI，比直接报错严重得多。
 */
const GATE_SCAN_CHARS = 2000;

/** 判定结果：null = 像题解正文；gated = 登录墙；too-short = 体量不足（噪声/空页） */
export type EditorialRejection = 'gated' | 'too-short' | null;

/**
 * 「像题解吗」判定：把登录墙关键词与正文体量**合并成一个函数**，调用方据返回原因
 * 给出精确报错。判定的不是「是不是题解」，而是「像不像一段能读的题解正文」——
 * 噪声必须被拒，宁可报错让 AI 走兜底路径（web_search / 请用户粘贴），
 * 也不能把导航文字当题解喂给模型。
 */
export function classifyNowcoderEditorial(
  content: string,
  minChars = MIN_EDITORIAL_CHARS,
): EditorialRejection {
  const text = content.trim();
  if (/仅作者可见/.test(text.slice(0, GATE_SCAN_CHARS))) return 'gated';
  if (text.length < minChars) return 'too-short';
  return null;
}

/**
 * 牛客系列题解列表页（acm/discuss/tutorials?tagId=…）→ 题解帖条目。
 * 列表是 SSR 的（tagId 过滤在服务端生效），但 htmlToText 会丢掉链接，
 * 必须提取「标题 + 帖子链接」对返回，模型才能链到正文。
 */
export function findNowcoderTutorialsEntries(html: string): Array<{ title: string; url: string }> {
  const normalized = html.replace(/\\"/g, '"');
  const out: Array<{ title: string; url: string }> = [];
  for (const m of normalized.matchAll(/<a\s[^>]*href="([^"]*\/discuss\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = m[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text.includes('题解')) continue;
    const url = new URL(m[1]!, 'https://ac.nowcoder.com').toString();
    if (!out.some((e) => e.url === url)) out.push({ title: text, url });
  }
  return out;
}

/**
 * 洛谷题解区：正文嵌在 window.__INITIAL_STATE__ 的 JSON 里（htmlToText 会剥掉
 * script，必须单独提取）。递归收集「带 markdown 特征（标题/加粗/代码块）」的
 * 长字符串 —— 洛谷页面结构常变，特征判定比按字段路径硬编码稳；一个都找不到时
 * 返回 ''，由调用方决定降级提示。
 */
export function extractLuoguSolutions(html: string): string {
  const MARKDOWN_RE = /(^|\n)\s*#{1,4} |\*\*[^*]+\*\*|```|\n[-*] /;
  for (const m of html.matchAll(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/g)) {
    try {
      const state = JSON.parse(m[1]!) as unknown;
      const texts: string[] = [];
      const walk = (node: unknown, depth: number): void => {
        if (depth > 12 || texts.length >= 20) return;
        if (typeof node === 'string') {
          // 题解正文是 markdown：标题/加粗/代码块/列表任一特征，且具备正文体量
          if (node.length >= 20 && MARKDOWN_RE.test(node)) texts.push(node);
          return;
        }
        if (Array.isArray(node)) {
          for (const child of node) walk(child, depth + 1);
          return;
        }
        if (node && typeof node === 'object') {
          for (const value of Object.values(node as Record<string, unknown>)) walk(value, depth + 1);
        }
      };
      walk(state, 0);
      if (texts.length > 0) return texts.join('\n\n---\n\n');
    } catch {
      // JSON 截断/编码不兼容：换下一处 script 或交回退路径
    }
  }
  return '';
}

function truncate(text: string): string {
  if (text.length <= MAX_EDITORIAL_CHARS) return text;
  return `${text.slice(0, MAX_EDITORIAL_CHARS)}\n\n（题解过长已截断：仅保留前 ${MAX_EDITORIAL_CHARS} 字符）`;
}

/**
 * 工具默认传输层：**必须**走全局按域名节流（见 net/hostThrottle.ts）——
 * 否则 AI 可以在一轮对话里连发多次题解抓取，绕过所有平台的风控节奏。
 */
export const EDITORIAL_TRANSPORT: typeof fetch = throttledFetch;

/**
 * 按平台派发读取题解。失败一律返回 error 文案（对齐 fetch_url：不抛错），
 * 拿不到题解时明确说明原因，AI 据此降级为「未经验证的推断」而不是硬编。
 */
export async function executeFetchEditorial(
  url: string,
  cookies?: PlatformCookies,
  fetchFn: typeof fetch = EDITORIAL_TRANSPORT,
): Promise<EditorialResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `URL 无法解析：${url}` };
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // ---------- 牛客：题解帖正文 / 题解列表 / 比赛页两跳 ----------
  if (host === 'ac.nowcoder.com' || host === 'www.nowcoder.com') {
    // 帖子直达：web_search 或题解列表里找到的 discuss 链接，直接读正文
    if (/^\/discuss\/\d+/.test(path)) {
      const postHtml = await fetchPage(url, fetchFn);
      const content = htmlToText(postHtml).trim();
      const rejection = classifyNowcoderEditorial(content);
      if (rejection === 'gated') {
        return { error: '题解帖仅作者可见（需登录）。可用 web_search 搜索同名公开题解帖，或把帖子链接在浏览器登录后复制正文。' };
      }
      if (rejection === 'too-short') {
        return { error: `题解帖（${url}）内容过短或读取失败：帖子可能需要登录、已被删除，或不是题解帖。` };
      }
      return { content: truncate(content), sourceUrl: url };
    }
    // 系列题解列表（tutorials?tagId=…）：返回「标题 → 帖子链接」清单，
    // 模型找到对应场次的条目后把帖子链接传回本工具读正文
    if (host === 'ac.nowcoder.com' && path.startsWith('/acm/discuss/tutorials')) {
      const listHtml = await fetchPage(url, fetchFn);
      const entries = findNowcoderTutorialsEntries(listHtml);
      if (entries.length === 0) {
        return { error: '题解列表读取失败：列表为空或页面结构变化。可改用 web_search 搜索「{比赛名} 题解」。' };
      }
      const lines = entries.map((e) => `- ${e.title}：${e.url}`).join('\n');
      return {
        content: truncate(
          `以下是牛客题解列表的条目（标题 → 帖子链接）。找到与目标比赛对应的条目后，把它的帖子链接传回本工具读取正文：\n${lines}`,
        ),
        sourceUrl: url,
      };
    }
    // 比赛页：两跳发现；比赛页通常只挂规范类公告，题解帖要靠列表/搜索兜底
    if (host === 'ac.nowcoder.com' && /^\/acm\/contest\/\d+/.test(path)) {
      const contestHtml = await fetchPage(url, fetchFn);
      const editorialUrl = findNowcoderEditorialLink(contestHtml);
      if (!editorialUrl) {
        const titleMatch = contestHtml.match(/<title>([^<_-]{2,60})/);
        const name = titleMatch?.[1]?.trim();
        return {
          error:
            '比赛页里没有找到带「题解」标注的讨论帖链接（多数牛客比赛的题解帖不在比赛页挂链接）。' +
            `两条兜底路径：① web_search 搜索「${name ?? '比赛名'} 题解」，找到 nowcoder discuss 帖子链接后传回本工具；` +
            '② 若知道该系列的题解列表链接（ac.nowcoder.com/acm/discuss/tutorials?tagId=…），把列表链接传回本工具，会列出全部题解帖条目。',
        };
      }
      const postHtml = await fetchPage(editorialUrl, fetchFn);
      const content = htmlToText(postHtml).trim();
      if (classifyNowcoderEditorial(content, 300) !== null) {
        // 实测：比赛页挂的题解帖可能「仅作者可见」（需登录），htmlToText 只剩
        // 导航噪声 —— 绝不能把噪声当题解返回，交给兜底路径
        const titleMatch = contestHtml.match(/<title>([^<_-]{2,60})/);
        const name = titleMatch?.[1]?.trim();
        return {
          error:
            `比赛页链接的题解帖（${editorialUrl}）需要登录或内容不可见。公开题解帖的兜底路径：` +
            `① web_search 搜索「${name ?? '比赛名'} 题解」，找到 nowcoder discuss 帖子链接后传回本工具；` +
            '② 把该系列题解列表链接（ac.nowcoder.com/acm/discuss/tutorials?tagId=…）传回本工具，会列出全部题解帖条目。',
        };
      }
      return { content: truncate(content), sourceUrl: editorialUrl };
    }
  }

  // ---------- AtCoder：官方 editorial 页 ----------
  if (host === 'atcoder.jp' && /^\/contests\/[\w.-]+/.test(path)) {
    const base = path.replace(/\/$/, '');
    const editorialUrl = `https://atcoder.jp${base}/editorial`;
    const editorialHtml = await fetchPage(editorialUrl, fetchFn);
    const content = htmlToText(editorialHtml).trim();
    if (!content) return { error: 'AtCoder editorial 页读取失败：内容可能是 PDF 附件，请改用 web_search 或粘贴题解。' };
    return { content: truncate(content), sourceUrl: editorialUrl };
  }

  // ---------- 洛谷：题解区（需登录，内容在 __INITIAL_STATE__） ----------
  if ((host === 'www.luogu.com.cn' || host === 'luogu.com.cn') && /^\/problem\/[\w-]+/.test(path)) {
    const cookie = cookies?.luogu?.cookie;
    if (!cookie) {
      return { error: '洛谷题解区需要登录：请先在「设置」配置洛谷 Cookie，或用 web_search 搜索该题题解。' };
    }
    const solutionUrl = `https://www.luogu.com.cn/problem/solution/${path.split('/')[2]}`;
    const solutionHtml = await fetchPage(solutionUrl, fetchFn, cookie);
    // 主路径：__INITIAL_STATE__ JSON 提取；拿不到再试整页转文本（须够长，避免
    // 把导航/页脚噪声当题解）；两者皆空才降级报错
    let content = extractLuoguSolutions(solutionHtml).trim();
    if (!content) {
      const fallback = htmlToText(solutionHtml).trim();
      if (fallback.length >= 200) content = fallback;
    }
    if (!content) {
      return { error: '洛谷题解区读取失败：该题可能暂无题解，或页面结构变化导致解析不到正文。可改用 web_search。' };
    }
    return { content: truncate(content), sourceUrl: solutionUrl };
  }

  // ---------- Codeforces：无稳定题解源，明确告知 ----------
  if (host === 'codeforces.com') {
    return {
      error:
        'Codeforces 的 editorial 是博客链接、没有稳定的读取来源，无法自动获取题解。' +
        '请改用 web_search 搜索「Codeforces Round XXXX editorial」，或让用户粘贴题解；' +
        '没有题解佐证时，对题目解法的判断需明确标注为推断。',
    };
  }

  return {
    error:
      '无法识别的题解来源（仅支持牛客比赛页 / AtCoder 比赛页 / 洛谷题目页 / Codeforces 提示无源）。' +
      '可改用 fetch_url 直接读取题解页面，或 web_search 搜索。',
  };
}

registerTool({
  definition: FETCH_EDITORIAL_TOOL,
  execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) {
      return { content: '请提供比赛页或题目页的网址（url 参数不能为空）。' };
    }
    const invalid = validatePublicFetchUrl(url);
    if (invalid) {
      return { content: `无法读取该网址：${invalid}` };
    }
    const { content, sourceUrl, error } = await executeFetchEditorial(
      url,
      ctx.cookies,
      ctx.fetchFn ?? EDITORIAL_TRANSPORT,
    );
    if (error || !content?.trim()) {
      return { content: `读取题解失败：${error ?? '未获取到题解内容'}。没有题解佐证时，请不要给出看似确定的完整解法，明确标注哪些是推断。` };
    }
    return {
      content: `以下是 ${sourceUrl ?? url} 的题解内容：\n\n${content}`,
      metadata: sourceUrl ? [{ title: '题解', url: sourceUrl }] : undefined,
    };
  },
});
