import type { AiConfig } from '../config.ts';
import type { ToolDefinition } from './provider.ts';
import { registerTool, type ToolResult, type ToolContext, type PlatformCookies } from './tools/registry.ts';
import type { SearchConfig } from './search.ts';
import { extractPdfText, truncatePdfText, isPdfContentType } from './pdf.ts';
import { throttledFetch } from '../net/hostThrottle.ts';
import dns from 'node:dns/promises';

/**
 * 工具默认传输层：**必须**走全局按域名节流（见 net/hostThrottle.ts）。
 * 直连抓取会逐跳跟随重定向（≤5 跳）并在 C3VK 挑战时原地重试 —— 不加节流的话
 * AI 一次调用就可能对同一站点连发近十次请求，而且绕过所有平台的风控节奏。
 */
export const FETCH_URL_TRANSPORT: typeof fetch = throttledFetch;

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
 * 判断 IP 地址是否属于本机/内网/链路本地等禁止访问的范围：
 * IPv4 未指定/回环/RFC1918/链路本地/CGNAT/元数据端点；IPv6 回环/未指定/链路本地/唯一本地/IPv4 映射私网。
 */
export function isPrivateIp(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return true;
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  // IPv6：归一化 ::ffff:a.b.c.d 映射形式后按前缀判断
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIp(mapped[1]);
  const expanded = expandIpv6(addr);
  if (!expanded) return addr === '::' || addr === '::1';
  if (expanded === '0'.repeat(32)) return true; // ::
  if (expanded.startsWith('0'.repeat(31) + '1')) return true; // ::1
  if (expanded.startsWith('fe80')) return true; // 链路本地 fe80::/10
  if (expanded.startsWith('fc') || expanded.startsWith('fd')) return true; // 唯一本地 fc00::/7
  // IPv4 映射地址的十六进制形式（::ffff:7f00:1 ↔ ::ffff:127.0.0.1）
  if (expanded.startsWith('0'.repeat(20) + 'ffff')) {
    const v4hex = expanded.slice(-8);
    const v4 = [0, 1, 2, 3].map((i) => parseInt(v4hex.slice(i * 2, i * 2 + 2), 16)).join('.');
    return isPrivateIp(v4);
  }
  return false;
}

/** 将 IPv6 展开为 32 位十六进制字符串；非法输入返回 null */
function expandIpv6(addr: string): string | null {
  if (!/^[0-9a-f:.]+$/.test(addr)) return null;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  let out = '';
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out += g.padStart(4, '0');
  }
  return out.length === 32 ? out : null;
}

/**
 * DNS 解析可注入：测试中替换以模拟「公网域名解析到私网 IP」等场景。
 */
type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;
let dnsLookup: DnsLookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true }) as never;
export function setDnsLookupForTest(fn: DnsLookup | null): void {
  dnsLookup = fn ?? ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }) as never);
}

/**
 * 解析主机名并校验所有结果地址都不指向本机/内网。
 * 返回 null 表示可访问；否则返回给用户的错误说明。
 * 同时封堵字面量形式的非常规 IP（十六进制/十进制整数等，DNS 解析失败即拒绝）。
 */
export async function resolveAndValidateHost(hostname: string): Promise<string | null> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(host);
  } catch {
    return '域名解析失败（无法访问该主机）';
  }
  if (!addresses?.length) return '域名解析失败（无可用地址）';
  for (const { address } of addresses) {
    if (isPrivateIp(address)) return '该域名解析到本机或内网地址，禁止访问';
  }
  return null;
}

/**
 * 阻止工具访问本机/内网 HTTP 服务。该工具的 URL 来自模型调用，不能把它当作
 * 可信输入。此处做字符串级校验（协议、本地域名、字面 IP）；域名解析与逐跳
 * 重定向校验分别由 resolveAndValidateHost 与 directFetch 的重定向循环承担。
 */
export function validatePublicFetchUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '网址格式非法';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '网址需以 http:// 或 https:// 开头';
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return '禁止访问本机或本地域名';
  if (isPrivateIp(host)) return '禁止访问内网或链路本地地址';
  return null;
}

/**
 * 执行网址读取：主路径 Tavily Extract（能处理 JS 渲染页面），失败或未配置时走兜底直接 fetch。
 * 失败不抛错（对齐 web_search），返回 content 为空 + error 说明。
 * cookies 可选：对已配置 Cookie 的平台（如洛谷）携带认证信息以读取需登录的页面。
 */
export async function executeFetchUrl(
  url: string,
  cfg: SearchConfig,
  cookies?: PlatformCookies,
  fetchFn: typeof fetch = FETCH_URL_TRANSPORT,
): Promise<FetchResult> {
  const invalid = validatePublicFetchUrl(url);
  if (invalid) return { content: '', title: url, error: invalid };
  const engine = cfg.searchEngine ?? 'tavily';
  const apiKey = cfg.searchApiKey?.trim();

  // 主路径：Tavily Extract API（仅 tavily 引擎 + 有 key 时）
  if (engine === 'tavily' && apiKey) {
    const r = await tavilyExtract(url, apiKey);
    if (r.content.trim()) return r;
  }

  // 兜底路径：直接 fetch + HTML 转文本（对服务端渲染页面有效），走全局节流
  const r = await directFetch(url, cookies, fetchFn);
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
 *  cookies 可选：对洛谷等需登录的平台携带认证信息，并处理 C3VK 反爬验证。
 *  重定向采用手动逐跳跟随（≤5 跳）：每一跳都先做字符串级 URL 校验 + DNS 解析
 *  校验，防止公网页面 302 跳向内网；跨主机重定向不再携带平台 Cookie。 */
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function directFetch(
  url: string,
  cookies?: PlatformCookies,
  fetchFn: typeof fetch = FETCH_URL_TRANSPORT,
): Promise<FetchResult> {
  const initialPlatCreds = findCookie(url, cookies);
  const cookieStr = initialPlatCreds?.cookie?.trim() || '';
  const initialHost = new URL(url).hostname.toLowerCase();

  let currentUrl = url;
  let cookie = cookieStr;
  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const invalid = validatePublicFetchUrl(currentUrl) ?? await resolveAndValidateHost(new URL(currentUrl).hostname);
      if (invalid) return { content: '', title: url, error: invalid };

      const headers: Record<string, string> = {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,text/plain,application/pdf',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      };
      // 仅原始主机（洛谷 C3VK 场景）携带平台 Cookie，防止凭据经重定向泄露到第三方
      if (cookie && new URL(currentUrl).hostname.toLowerCase() === initialHost) {
        headers['Cookie'] = cookie;
      }

      const res = await fetchFn(currentUrl, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });

      // C3VK 反爬验证：洛谷 302 后需从 Set-Cookie 提取 C3VK，原地重试（不跟随该跳）
      if (res.status === 302 && new URL(currentUrl).hostname.toLowerCase() === initialHost) {
        const setCookies = res.headers.getSetCookie?.() ?? [];
        let c3vk = '';
        for (const c of setCookies) {
          const m = c.match(/C3VK=([^;]+)/);
          if (m) c3vk = m[1];
        }
        if (c3vk) {
          cookie = (cookieStr ? cookieStr + '; ' : '') + 'C3VK=' + c3vk;
          continue; // 原地重试，Cookie 附加逻辑由下一轮 headers 组装完成
        }
      }

      // 逐跳重定向：校验目标 URL 与其 DNS 解析结果后再跟随
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) return { content: '', title: url, error: `HTTP ${res.status}（缺少重定向目标）` };
        if (hop === MAX_REDIRECT_HOPS) return { content: '', title: url, error: '重定向次数过多（>5 跳）' };
        currentUrl = new URL(location, currentUrl).toString();
        continue;
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
    }
    return { content: '', title: url, error: '重定向次数过多（>5 跳）' };
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
    const invalid = validatePublicFetchUrl(url);
    if (invalid) {
      return { content: `无法读取该网址：${invalid}` };
    }
    const { content, title, error } = await executeFetchUrl(
      url,
      ctx.cfg,
      ctx.cookies,
      ctx.fetchFn ?? FETCH_URL_TRANSPORT,
    );
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
