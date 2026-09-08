import type { AiConfig } from '../config.ts';
import type { ToolDefinition } from './provider.ts';
import { registerTool, type ToolResult, type ToolContext, type PlatformCookies } from './tools/registry.ts';
import type { SearchConfig } from './search.ts';
import { extractPdfText, truncatePdfText, isPdfContentType } from './pdf.ts';

/** fetch_url 工具定义：AI 可在回复中调用以读取指定网址的网页正文 */
export const FETCH_URL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description:
      '读取指定网址的网页正文内容。当用户消息中包含 http(s) 网址、或要求查看某个网页（如 OJ 比赛/题目页、博客、文档）的内容时调用。与 web_search（按关键词搜索）不同：本工具传入一个完整 URL，返回该页面的正文文本。先搜索得到链接、再读取链接详情时尤其有用。',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要读取的完整网址（须以 http:// 或 https:// 开头）',
        },
      },
      required: ['url'],
    },
  },
};

/** 正文最大字符数，超出截断。现代模型上下文窗口已达 128K-1M token，放宽至 50K 字符（约 12K token） */
const MAX_TEXT_CHARS = 50000;

/** 浏览器 User-Agent：避免部分站点对默认 fetch UA 返回 403 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface FetchResult {
  /** 正文文本（失败时为空字符串） */
  content: string;
  /** 页面标题（取 <title>，无则回退 url） */
  title: string;
  /** 失败原因（成功时省略） */
  error?: string;
}

/**
 * 执行网址读取：主路径 Tavily Extract（能处理 JS 渲染页面），失败或未配置时走兜底直接 fetch。
 * 失败不抛错（对齐 web_search），返回 content 为空 + error 说明。
 * cookies 可选：对已配置 Cookie 的平台（如洛谷）携带认证信息以读取需登录的页面。
 */
export async function executeFetchUrl(url: string, cfg: SearchConfig, cookies?: PlatformCookies): Promise<FetchResult> {
  const engine = cfg.searchEngine ?? 'tavily';
  const apiKey = cfg.searchApiKey?.trim();

  // 主路径：Tavily Extract API（仅 tavily 引擎 + 有 key 时）
  if (engine === 'tavily' && apiKey) {
    const r = await tavilyExtract(url, apiKey);
    if (r.content.trim()) return r;
  }

  // 兜底路径：直接 fetch + HTML 转文本（对服务端渲染页面有效）
  const r = await directFetch(url, cookies);
  return r;
}

/** Tavily Extract API：读取指定 URL 正文，返回 markdown 格式内容。能处理 JS 渲染页面。 */
async function tavilyExtract(url: string, apiKey: string): Promise<FetchResult> {
  try {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        urls: [url],
        extract_depth: 'basic',
        format: 'markdown',
        include_images: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { content: '', title: url, error: `Tavily Extract HTTP ${res.status}` };
    const data = (await res.json()) as {
      results?: Array<{ url?: string; raw_content?: string }>;
      failed_results?: Array<{ url?: string; error?: string }>;
    };
    const first = data.results?.[0];
    if (first?.raw_content && first.raw_content.trim()) {
      // markdown 内容首行 # 标题可作为页面标题
      const titleMatch = first.raw_content.match(/^#\s+(.+)$/m);
      return {
        content: truncate(first.raw_content),
        title: titleMatch ? titleMatch[1].trim() : url,
      };
    }
    const failErr = data.failed_results?.[0]?.error;
    return { content: '', title: url, error: failErr ?? 'Tavily Extract 返回空内容' };
  } catch (e) {
    return { content: '', title: url, error: `Tavily Extract 请求失败：${(e as Error).message}` };
  }
}

/** 主机名 → 平台 id 映射：用于匹配已保存的平台 Cookie */
const HOST_TO_PLATFORM: Record<string, string> = {
  'www.luogu.com.cn': 'luogu',
  'luogu.com.cn': 'luogu',
};

/** 根据网址主机名查找已保存的平台 Cookie */
function findCookie(url: string, cookies?: PlatformCookies): { cookie?: string; csrf?: string } | undefined {
  if (!cookies) return undefined;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const platform = HOST_TO_PLATFORM[host];
    if (!platform) return undefined;
    return cookies[platform];
  } catch {
    return undefined;
  }
}

/** 兜底路径：直接 fetch 网页 HTML/PDF，转为可读文本。对服务端渲染页面有效。
 *  cookies 可选：对洛谷等需登录的平台携带认证信息，并处理 C3VK 反爬验证。 */
async function directFetch(url: string, cookies?: PlatformCookies): Promise<FetchResult> {
  const platCreds = findCookie(url, cookies);
  const cookieStr = platCreds?.cookie?.trim() || '';
  try {
    const baseHeaders: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,text/plain,application/pdf',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    };
    if (cookieStr) baseHeaders['Cookie'] = cookieStr;

    let res = await fetch(url, {
      headers: baseHeaders,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });

    // C3VK 反爬验证：洛谷返回 302 重定向，需从 Set-Cookie 提取 C3VK 再重试
    if (res.status === 302) {
      const setCookies = res.headers.getSetCookie?.() ?? [];
      let c3vk = '';
      for (const c of setCookies) {
        const m = c.match(/C3VK=([^;]+)/);
        if (m) c3vk = m[1];
      }
      if (c3vk) {
        baseHeaders['Cookie'] = (cookieStr ? cookieStr + '; ' : '') + 'C3VK=' + c3vk;
        res = await fetch(url, {
          headers: baseHeaders,
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000),
        });
      }
    }

    if (!res.ok) return { content: '', title: url, error: `HTTP ${res.status}` };
    const ct = res.headers.get('content-type') ?? '';
    // PDF：以字节读取后调用 unpdf 提取文本
    if (isPdfContentType(ct)) {
      const buf = new Uint8Array(await res.arrayBuffer());
      try {
        const { text } = await extractPdfText(buf);
        if (!text.trim()) return { content: '', title: url, error: 'PDF 未提取到文本（可能是扫描型 PDF）' };
        // 标题取 URL 末段（如 contest/4071 → 4071），无法提取时回退 url
        const seg = url.split('/').filter(Boolean).pop() || url;
        return { content: truncatePdfText(text), title: seg };
      } catch (e) {
        return { content: '', title: url, error: `PDF 提取失败：${(e as Error).message}` };
      }
    }
    if (!/text\/(html|plain)|application\/xhtml/i.test(ct)) {
      return { content: '', title: url, error: `非文本内容类型：${ct || '未知'}` };
    }
    const html = await res.text();
    const title = extractTitle(html) || url;
    const content = htmlToText(html);
    if (!content.trim()) return { content: '', title: url, error: '页面正文为空（可能是 JS 渲染页面）' };
    return { content, title };
  } catch (e) {
    return { content: '', title: url, error: `请求失败：${(e as Error).message}` };
  }
}

/** 截断超长正文，超出部分用省略标注 */
function truncate(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + '\n[…内容已截断，原文较长]';
}

/** 从 HTML 中提取 <title> 文本（在剥离前调用） */
export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

/**
 * HTML 转可读文本：移除脚本/样式等噪声块，保留 pre/code 内容（OJ 样例 I/O 关键），
 * 解码常见实体，折叠空白，截断超长内容。纯函数，便于测试。
 */
export function htmlToText(html: string): string {
  let s = html;
  // 1. 整块移除噪声标签（含内容）
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<nav\b[\s\S]*?<\/nav>/gi, '');
  s = s.replace(/<header\b[\s\S]*?<\/header>/gi, '');
  s = s.replace(/<footer\b[\s\S]*?<\/footer>/gi, '');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '');
  // 2. 块级标签闭合转换行（保留文档结构，pre/code 内容仅去标签保留文本）
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|ul|ol|table)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // 3. 剥离剩余标签
  s = s.replace(/<[^>]+>/g, '');
  // 4. 解码常见 HTML 实体
  s = decodeEntities(s);
  // 5. 折叠多余空白（保留换行结构）
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  // 6. 截断超长正文
  return truncate(s);
}

/** 解码常见 HTML 实体 */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ---------- 注册到工具注册表 ----------

/**
 * fetch_url 工具执行逻辑：
 * - 从 args.url 提取网址并校验协议
 * - 调用 executeFetchUrl 获取正文（主路径 Tavily Extract，兜底直接 fetch）
 * - content 格式化后注入对话（AI 看到网页正文）
 * - metadata 携带来源链接（前端展示引用，复用 sources 渲染）
 */
registerTool({
  definition: FETCH_URL_TOOL,
  execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) {
      return { content: '请提供要读取的网址（url 参数不能为空）。' };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { content: `网址需以 http:// 或 https:// 开头：${url}` };
    }
    const { content, title, error } = await executeFetchUrl(url, ctx.cfg, ctx.cookies);
    if (!content.trim()) {
      return {
        content: `读取 ${url} 失败：${error ?? '无法获取该网址内容'}。可能原因：页面需登录、依赖 JS 渲染、或网络不通。请确认网址可公开访问，或将网页正文直接粘贴给我。`,
      };
    }
    return {
      content: `以下是 ${url} 的网页内容：\n\n${content}`,
      metadata: [{ title: title || url, url }],
    };
  },
});
