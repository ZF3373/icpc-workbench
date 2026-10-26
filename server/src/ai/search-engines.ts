/**
 * 联网搜索引擎适配层：12 引擎 × (搜索 | 抓取) + fallback 编排原语。
 *
 * 设计对齐 dsh-web-search-free（多渠道免费搜索聚合）：
 * - 每个引擎一个适配器，搜索/抓取结果为空一律**抛错**而非返回空——否则空成功会终止
 *   fallback 链，把后面的引擎全部藏死；
 * - 运行时按用户启用顺序展开成 (引擎, Key) 尝试序列：同一引擎多个 Key 按序轮换，
 *   鉴权/配额类失败把该 (引擎, Key) **冷却搁置**（移到链尾而非剔除），链照样能跑通，
 *   只是不再每次先撞死在坏 Key 上；
 * - 单次尝试独立超时；全部失败时聚合每次的原因（Key 已打码），让模型与用户能定位
 *   是哪一渠道出了什么问题（issue 50 的「失败必须可见」语义在链条上的延伸）。
 *
 * 引擎元数据（展示名/能力/额度/注册入口）单源在 shared/src/searchEngines.ts；
 * 本文件只负责 HTTP 调用与编排。引擎清单与请求格式参考 dsh-web-search-free 的实现。
 */
import { searchEngineMeta, type SearchEngineId } from '../../../shared/src/index.ts';

// ---------- 错误类型与通用工具 ----------

/** 引擎级失败。status 为 HTTP 状态码；信封式错误（200 里 code != 0）可能没有。 */
export class SearchEngineError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SearchEngineError';
  }
}

/** 单条搜索结果（注入给 AI 的统一形状；snippet 允许为空串） */
export interface EngineSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** 引擎抓取结果：正文 + 可选标题（标题缺省由调用方回退为 URL） */
export interface EngineFetchResult {
  content: string;
  title?: string;
}

export interface SearchEngineAdapter {
  id: SearchEngineId;
  label: string;
  /** 支持抓取的引擎才有 fetch；不支持的引擎不进 fetch 链（search-only） */
  supportsFetch: boolean;
  search(query: string, key: string, signal: AbortSignal): Promise<EngineSearchResult[]>;
  fetch?(url: string, key: string, signal: AbortSignal): Promise<EngineFetchResult>;
}

/** 单次尝试的独立超时：搜索 15 秒、抓取 30 秒（抓取要在引擎侧渲染页面） */
export const ATTEMPT_TIMEOUT_MS = { search: 15_000, fetch: 30_000 } as const;

/** 摘要上限：搜索结果只用于让模型挑选链接，长正文应走 fetch_url 再取 */
const SNIPPET_MAX_CHARS = 500;

/** 折叠空白并截断为摘要；非字符串/纯空白返回 undefined */
function toSnippet(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) : text;
}

/** 非 2xx → 抛 SearchEngineError（带状态码与响应体片段） */
async function assertOk(res: Response, label: string): Promise<void> {
  if (res.ok) return;
  const detail = await res.text().catch(() => '');
  let msg = `${label} HTTP ${res.status}`;
  if (detail) msg += `：${detail.slice(0, 200)}`;
  throw new SearchEngineError(msg, res.status);
}

/** 归一化一条结果：url 必须非空，title 回退 url，snippet 截断 */
function resultOf(url: unknown, title: unknown, snippet: unknown): EngineSearchResult | undefined {
  if (typeof url !== 'string' || url === '') return undefined;
  return {
    url,
    title: typeof title === 'string' && title !== '' ? title : url,
    snippet: toSnippet(snippet) ?? '',
  };
}

/** 结果列表为空必须抛错：空成功会终止 fallback 链（见文件头注） */
function assertResults<T>(rows: T[], label: string): T[] {
  if (rows.length === 0) throw new SearchEngineError(`${label} 搜索无结果`);
  return rows;
}

// ---------- 各引擎适配器 ----------

const engTavily: SearchEngineAdapter = {
  id: 'tavily',
  label: 'Tavily',
  supportsFetch: true,
  async search(query, key, signal) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 5, search_depth: 'basic' }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    // Tavily 的 content 是结果主体，缺失的条目没有注入价值（历史口径：url+content 双必需）
    const rows = (data.results ?? [])
      .filter((r) => r.url && r.content)
      .map((r) => resultOf(r.url, r.title ?? r.url, r.content))
      .filter((r): r is EngineSearchResult => r !== undefined);
    return assertResults(rows, this.label);
  },
  async fetch(url, key, signal) {
    // Tavily Extract：能处理 JS 渲染页面，返回 markdown
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ urls: [url], extract_depth: 'basic', format: 'markdown', include_images: false }),
      signal,
    });
    if (!res.ok) throw new SearchEngineError(`Tavily Extract HTTP ${res.status}`, res.status);
    const data = (await res.json()) as {
      results?: Array<{ url?: string; raw_content?: string }>;
      failed_results?: Array<{ url?: string; error?: string }>;
    };
    const first = data.results?.[0];
    if (first?.raw_content && first.raw_content.trim()) {
      // markdown 内容首行 # 标题可作为页面标题
      const titleMatch = first.raw_content.match(/^#\s+(.+)$/m);
      return { content: first.raw_content, title: titleMatch ? titleMatch[1].trim() : undefined };
    }
    // 提取失败的 URL 落在 failed_results 里而非 HTTP 错误，带上原因给下一个引擎让位
    const reason = data.failed_results?.[0]?.error;
    throw new SearchEngineError(reason ? `Tavily Extract 失败：${reason}` : 'Tavily Extract 返回空内容');
  },
};

const engBrave: SearchEngineAdapter = {
  id: 'brave',
  label: 'Brave',
  supportsFetch: false,
  async search(query, key, signal) {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      { headers: { 'X-Subscription-Token': key, Accept: 'application/json' }, signal },
    );
    await assertOk(res, this.label);
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const rows = (data.web?.results ?? []).map((r) => resultOf(r.url, r.title ?? r.url, r.description));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
};

const engTinyfish: SearchEngineAdapter = {
  id: 'tinyfish',
  label: 'TinyFish',
  supportsFetch: true,
  async search(query, key, signal) {
    // 搜索与抓取在不同子域；搜索是根路径裸 GET，参数全在 query string
    const url = new URL('https://api.search.tinyfish.ai');
    url.searchParams.set('query', query);
    const res = await fetch(url, { headers: { 'X-API-Key': key }, signal });
    await assertOk(res, this.label);
    const data = (await res.json()) as { results?: Array<{ url?: string; title?: string; snippet?: string }> };
    const rows = (data.results ?? []).map((r) => resultOf(r.url, r.title, r.snippet));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
  async fetch(url, key, signal) {
    const res = await fetch('https://api.fetch.tinyfish.ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ urls: [url], format: 'markdown' }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as {
      results?: Array<{ text?: string }>;
      errors?: Array<{ url?: string; error?: string }>;
    };
    const text = data.results?.[0]?.text;
    if (typeof text === 'string' && text.trim()) return { content: text };
    const reason = data.errors?.find((e) => e.url === url)?.error;
    throw new SearchEngineError(reason ? `TinyFish 抓取失败：${reason}` : 'TinyFish 抓取返回空内容');
  },
};

const engAnysearch: SearchEngineAdapter = {
  id: 'anysearch',
  label: 'AnySearch',
  supportsFetch: true,
  async search(query, key, signal) {
    const res = await fetch('https://api.anysearch.com/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ query, max_results: 5 }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as {
      code?: number;
      message?: string;
      data?: { results?: Array<{ url?: string; title?: string; content?: string; snippet?: string }> };
    };
    // 信封式错误：200 也可能失败（success 仅 code === 0），只看 res.ok 会把失败当成功
    if (data.code !== 0) {
      throw new SearchEngineError(`AnySearch 搜索失败：${data.message || `code=${data.code}`}`);
    }
    const rows = (data.data?.results ?? []).map((r) => resultOf(r.url, r.title, r.content ?? r.snippet));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
  async fetch(url, key, signal) {
    const res = await fetch('https://api.anysearch.com/v1/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ url }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as { code?: number; message?: string; data?: { content?: string } };
    if (data.code !== 0) {
      throw new SearchEngineError(`AnySearch 抓取失败：${data.message || `code=${data.code}`}`);
    }
    const text = data.data?.content;
    if (typeof text !== 'string' || !text.trim()) throw new SearchEngineError('AnySearch 抓取返回空内容');
    return { content: text };
  },
};

const engSearxng: SearchEngineAdapter = {
  id: 'searxng',
  label: 'SearXNG',
  supportsFetch: false,
  async search(query, instance, signal) {
    // 「Key」是实例地址：容忍粘贴 /search 路径或尾斜杠
    let base: URL;
    try {
      base = new URL(instance.trim());
    } catch {
      throw new SearchEngineError(`SearXNG 实例地址无效：${instance.trim() || '（空）'}`);
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      throw new SearchEngineError(`SearXNG 实例地址需为 http(s)：${instance.trim()}`);
    }
    base.pathname = `${base.pathname.replace(/\/+$/, '').replace(/\/search$/, '')}/search`;
    base.search = '';
    base.hash = '';
    base.searchParams.set('q', query);
    base.searchParams.set('format', 'json');
    const res = await fetch(base, { headers: { Accept: 'application/json' }, signal });
    // JSON 格式默认关闭：实例须在 settings.yml 的 search.formats 里加 json，否则 403
    if (res.status === 403) {
      throw new SearchEngineError(
        'SearXNG HTTP 403：实例未开放 JSON 输出，需在其 settings.yml 的 search.formats 中加入 "json"',
        403,
      );
    }
    await assertOk(res, this.label);
    const data = (await res.json()) as { results?: Array<{ url?: string; title?: string; content?: string }> };
    const rows = (data.results ?? []).map((r) => resultOf(r.url, r.title, r.content));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
};

const engBaidu: SearchEngineAdapter = {
  id: 'baidu',
  label: 'Baidu Qianfan',
  supportsFetch: false,
  async search(query, key, signal) {
    const res = await fetch('https://qianfan.baidubce.com/v2/ai_search/web_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: fitBaiduQuery(query) }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: 5 }],
      }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as {
      code?: number | string;
      message?: string;
      references?: Array<{ url?: string; title?: string; content?: string }>;
    };
    // 信封式错误：200 里 code != 0 也是失败
    if (data.code !== undefined && data.code !== 0 && data.code !== '0') {
      throw new SearchEngineError(`Baidu Qianfan 搜索失败：${data.message || `code=${data.code}`}`);
    }
    const rows = (data.references ?? []).map((r) => resultOf(r.url, r.title, r.content));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
};

/** Baidu 查询上限 72 单元（CJK/全角算 2），超长截断而非被整体拒绝 */
const BAIDU_MAX_QUERY_UNITS = 72;
function fitBaiduQuery(query: string): string {
  let units = 0;
  let out = '';
  for (const ch of query.trim()) {
    units += ch.charCodeAt(0) > 0xff ? 2 : 1;
    if (units > BAIDU_MAX_QUERY_UNITS) break;
    out += ch;
  }
  return out;
}

const engExa: SearchEngineAdapter = {
  id: 'exa',
  label: 'Exa',
  supportsFetch: true,
  async search(query, key, signal) {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        query,
        numResults: 5,
        // 只要摘要级文本：搜索结果会被截成 500 字符摘要，整页文本是白花的计费
        contents: { text: { maxCharacters: 1000 } },
      }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as { results?: Array<{ url?: string; title?: string; text?: string }> };
    const rows = (data.results ?? []).map((r) => resultOf(r.url, r.title, r.text));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
  async fetch(url, key, signal) {
    const res = await fetch('https://api.exa.ai/contents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      // 与本地 MAX_TEXT_CHARS 同量级：确定性的长度上限
      body: JSON.stringify({ urls: [url], text: { maxCharacters: 50000 } }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as { results?: Array<{ text?: string; title?: string }> };
    const first = data.results?.[0];
    if (typeof first?.text !== 'string' || !first.text.trim()) {
      throw new SearchEngineError('Exa 抓取返回空内容');
    }
    return { content: first.text, title: first.title };
  },
};

const engFirecrawl: SearchEngineAdapter = {
  id: 'firecrawl',
  label: 'Firecrawl',
  supportsFetch: true,
  async search(query, key, signal) {
    const res = await fetch('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, limit: 5 }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as {
      success?: boolean;
      data?: Array<{ url?: string; title?: string; markdown?: string; description?: string }>;
    };
    if (!data.success) throw new SearchEngineError('Firecrawl 搜索失败（success=false）');
    const rows = (data.data ?? []).map((r) => resultOf(r.url, r.title, r.markdown || r.description));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
  async fetch(url, key, signal) {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    const markdown = data.data?.markdown;
    if (!data.success || typeof markdown !== 'string' || !markdown.trim()) {
      throw new SearchEngineError('Firecrawl 抓取返回空内容');
    }
    return { content: markdown, title: data.data?.metadata?.title };
  },
};

const engVolcengine: SearchEngineAdapter = {
  id: 'volcengine',
  label: 'Volcengine',
  supportsFetch: false,
  async search(query, key, signal) {
    const res = await fetch('https://open.feedcoopapi.com/search_api/web_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ Query: query.trim().slice(0, 100), SearchType: 'web', Count: 5, NeedSummary: true }),
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as {
      ResponseMetadata?: { Error?: { Code?: string; CodeN?: number; Message?: string } };
      Result?: { WebResults?: Array<{ Url?: string; Title?: string; Summary?: string; Snippet?: string }> };
    };
    // 信封式错误：200 里 ResponseMetadata.Error 携带业务码，映射成 HTTP 语义供冷却分类
    const error = data.ResponseMetadata?.Error;
    if (error && (error.Code || error.CodeN || error.Message)) {
      const code = String(error.CodeN ?? error.Code ?? '');
      throw new SearchEngineError(
        `Volcengine 搜索失败：${code ? `${code} ` : ''}${error.Message ?? '未知错误'}`,
        VOLC_ERROR_STATUS[code],
      );
    }
    const rows = (data.Result?.WebResults ?? []).map((r) =>
      resultOf(r.Url, stripTags(r.Title), stripTags(r.Summary) ?? stripTags(r.Snippet)),
    );
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
};

/** Volcengine 200 信封错误码 → 冷却分类用的 HTTP 语义（见 cooldownFor） */
const VOLC_ERROR_STATUS: Record<string, number | undefined> = {
  '10403': 401, // 账号/权限问题——常见于误用 Ark 模型 Key 而非搜索 Key
  '700901': 401, // Key 无效
  '100013': 401, // 子账号缺 TorchlightApiFullAccess
  '10406': 402, // 免费额度用尽
  '10407': 402, // 无可用免费额度策略
  '700429': 429, // 免费额度限频
};

function stripTags(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/<[^>]+>/g, '') : undefined;
}

const engSerpapi: SearchEngineAdapter = {
  id: 'serpapi',
  label: 'SerpApi',
  supportsFetch: false,
  async search(query, key, signal) {
    // SerpApi 官方要求 key 走 ?api_key= 查询参数（不要放 header/form）
    const url = new URL('https://serpapi.com/search');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', key);
    const res = await fetch(url, { signal });
    await assertOk(res, this.label);
    const data = (await res.json()) as {
      error?: string;
      organic_results?: Array<{ link?: string; title?: string; snippet?: string }>;
    };
    // 顶层 error 字符串可能出现在 200 响应里
    if (typeof data.error === 'string' && data.error) {
      throw new SearchEngineError(`SerpApi 搜索失败：${data.error}`);
    }
    const rows = (data.organic_results ?? []).map((r) => resultOf(r.link, r.title, r.snippet));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
};

const engJina: SearchEngineAdapter = {
  id: 'jina',
  label: 'Jina',
  supportsFetch: true,
  async search(query, key, signal) {
    // s.jina.ai 默认返回整篇 markdown 墙；Accept: application/json 拿结构化条目列表
    const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal,
    });
    await assertOk(res, this.label);
    const data = (await res.json()) as unknown;
    // JSON 形态历史上在裸数组 / {data:[]} / {results:[]} 间变动，三者都接受
    const d = data as { data?: unknown[]; results?: unknown[] };
    const entries: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(d.data)
        ? d.data
        : Array.isArray(d.results)
          ? d.results
          : [];
    const rows = entries
      .map((e) => {
        const o = e as { url?: unknown; title?: unknown; description?: unknown; content?: unknown };
        return resultOf(o.url, o.title, typeof o.description === 'string' && o.description ? o.description : o.content);
      })
      .filter((r): r is EngineSearchResult => r !== undefined);
    return assertResults(rows, this.label);
  },
  async fetch(url, key, signal) {
    const res = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), Accept: 'text/plain' },
      signal,
    });
    await assertOk(res, this.label);
    const text = await res.text();
    if (!text.trim()) throw new SearchEngineError('Jina 抓取返回空内容');
    // Reader 输出形如 "Title: ...\nURL Source: ...\nMarkdown Content:\n..."
    const titleMatch = text.match(/^Title:\s*(.+)$/m);
    return { content: text, title: titleMatch ? titleMatch[1].trim() : undefined };
  },
};

const engSerpingapi: SearchEngineAdapter = {
  id: 'serpingapi',
  label: 'Serping API',
  supportsFetch: false,
  async search(query, key, signal) {
    // POST + X-API-Key：把 Key 与查询都留在请求体/头里而非 URL
    const res = await fetch('https://api.serpingapi.com/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ q: query, num: 5 }),
      signal,
    });
    if (!res.ok) {
      // 错误体为 { error: { code, message } }（401 无效 Key、429 quota_exceeded）
      let detail = '';
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        if (typeof body?.error?.message === 'string' && body.error.message) detail = `：${body.error.message}`;
      } catch {
        // 非 JSON 错误体，状态行足够
      }
      throw new SearchEngineError(`Serping API HTTP ${res.status}${detail}`, res.status);
    }
    const data = (await res.json()) as { organic?: Array<{ link?: string; title?: string; snippet?: string }> };
    const rows = (data.organic ?? []).map((r) => resultOf(r.link, r.title, r.snippet));
    return assertResults(rows.filter((r): r is EngineSearchResult => r !== undefined), this.label);
  },
};

/** 全部引擎适配器（顺序无关：调用顺序由用户配置决定） */
export const SEARCH_ENGINE_ADAPTERS: readonly SearchEngineAdapter[] = [
  engTinyfish,
  engSearxng,
  engAnysearch,
  engBaidu,
  engTavily,
  engBrave,
  engExa,
  engFirecrawl,
  engVolcengine,
  engSerpapi,
  engJina,
  engSerpingapi,
];

const ENGINE_BY_ID: Record<string, SearchEngineAdapter> = Object.fromEntries(
  SEARCH_ENGINE_ADAPTERS.map((e) => [e.id, e]),
);

export function engineAdapter(id: string): SearchEngineAdapter | undefined {
  return ENGINE_BY_ID[id];
}

// ---------- fallback 编排原语 ----------

/** 一个已启用的渠道：引擎 + 该引擎的 Key 列表（顺序即轮换顺序） */
export interface SearchProviderEntry {
  engine: SearchEngineId;
  keys: string[];
}

export type EngineKind = 'search' | 'fetch';

/** (引擎, Key) 冷却表：键 `${engineId}:${key}` → 搁置截止时间戳 */
const benchedUntil = new Map<string, number>();

/** 冷却时长：鉴权/配额失败会持续失败（30 分钟）；429 可能只是限频（2 分钟） */
const COOLDOWN_MS = { auth: 30 * 60_000, quota: 30 * 60_000, rate: 2 * 60_000 } as const;

const QUOTA_MESSAGE = /quota|credits?\b|额度|配额|余额|run out of|insufficient|balance/i;

/** 依据失败类型决定该 (引擎, Key) 的搁置时长；undefined = 瞬时失败，不搁置 */
export function cooldownFor(err: unknown, kind: EngineKind): number | undefined {
  const status = err instanceof SearchEngineError ? err.status : undefined;
  // 403 只在搜索时记为鉴权失败：抓取的 403 更可能是目标网站拒绝爬取，迁怒于 Key 会让
  // 这个 Key 对所有其他 URL 一起失效
  if (status === 401 || (status === 403 && kind === 'search')) return COOLDOWN_MS.auth;
  if (status === 402) return COOLDOWN_MS.quota;
  if (status === 429) return QUOTA_MESSAGE.test(String((err as Error).message)) ? COOLDOWN_MS.quota : COOLDOWN_MS.rate;
  // 信封式错误（AnySearch code、SerpApi error）没有状态码，靠报文判断配额
  if (status === undefined && err instanceof SearchEngineError && QUOTA_MESSAGE.test(err.message)) {
    return COOLDOWN_MS.quota;
  }
  return undefined;
}

/** 失败后按类型登记冷却（供链条的统一出口调用） */
export function benchEngineKey(engine: SearchEngineAdapter, key: string, err: unknown, kind: EngineKind): void {
  const cooldown = cooldownFor(err, kind);
  if (cooldown !== undefined) benchedUntil.set(`${engine.id}:${key}`, Date.now() + cooldown);
}

/** 测试钩子：清空冷却表 */
export function resetEngineCooldownsForTest(): void {
  benchedUntil.clear();
}

/**
 * 把用户配置的渠道清单展开为有序尝试序列。
 * 冷却中的 (引擎, Key) **移到链尾而非剔除**——全部冷却时链仍会尝试，只是不再先付死请求；
 * 无 Key 条目仅对 allowsKeyless 引擎展开一次无 Key 尝试，其余引擎跳过（没 Key 试了必败）。
 */
export function buildAttempts(entries: readonly SearchProviderEntry[], kind: EngineKind): EngineAttempt[] {
  const now = Date.now();
  const ready: EngineAttempt[] = [];
  const benched: EngineAttempt[] = [];
  for (const entry of entries) {
    const engine = ENGINE_BY_ID[entry.engine];
    if (!engine) continue;
    if (kind === 'fetch' && !engine.supportsFetch) continue;
    const keys = entry.keys.length > 0 ? entry.keys : searchEngineMeta(engine.id)?.allowsKeyless ? [''] : [];
    for (const key of keys) {
      const until = benchedUntil.get(`${engine.id}:${key}`) ?? 0;
      (until > now ? benched : ready).push({ engine, key });
    }
  }
  return [...ready, ...benched];
}

export interface EngineAttempt {
  engine: SearchEngineAdapter;
  key: string;
}

/** 单次尝试的失败描述：错误信息 + 状态码提示（供聚合报错与日志） */
export function describeEngineFailure(err: unknown, key?: string): string {
  const status = err instanceof SearchEngineError ? err.status : undefined;
  let msg = err instanceof Error ? err.message : String(err);
  // 上游错误体或网络异常可能回显密钥（含 URL 参数形态），打码后才能进入日志与模型上下文。
  if (key) {
    for (const value of new Set([key, encodeURIComponent(key)])) {
      msg = msg.split(value).join(maskKey(key));
    }
  }
  if (status === 401 || status === 403) msg += '（密钥无效或无权限，请检查 API Key）';
  else if (status === 429) msg += '（配额已用尽或请求过频，可稍后重试）';
  else if (status !== undefined && status >= 500) msg += '（服务端错误）';
  return msg;
}

/** 瞬时失败判定：值得对同一 (引擎, Key) 原地重试一次（网络异常/超时/5xx/429/408/425） */
export function isRetryableEngineError(err: unknown): boolean {
  if (!(err instanceof SearchEngineError)) return true; // fetch 网络层异常
  const status = err.status;
  if (status === undefined) return !QUOTA_MESSAGE.test(err.message); // 信封式错误：配额类不重试
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** 日志用 Key 打码：URL 型 Key（SearXNG 实例）只留主机名 */
export function maskKey(key: string): string {
  if (!key) return '无 Key';
  if (/^https?:\/\//i.test(key)) {
    try {
      return new URL(key).host;
    } catch {
      return '***';
    }
  }
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-3)}`;
}

/** 校验引擎 id 是否在注册表中（配置边界处的白名单过滤用） */
export function isKnownEngineId(id: string): id is SearchEngineId {
  return searchEngineMeta(id) !== undefined;
}
