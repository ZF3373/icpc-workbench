import type { AiConfig } from '../config.ts';
import type { ToolDefinition } from './provider.ts';
import { registerTool, type ToolResult, type ToolContext } from './tools/registry.ts';

/** web_search 工具定义：AI 可在回复中调用以获取外部信息 */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '搜索互联网获取最新信息。当用户询问近期赛事、最新算法资料、技术文档、或你训练数据中可能过时的内容时调用。每次调用传入一个搜索关键词。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（中英文均可，尽量精简准确）',
        },
      },
      required: ['query'],
    },
  },
};

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchConfig {
  searchEngine?: 'tavily' | 'brave';
  searchApiKey?: string;
}

/** 执行网络搜索，返回结果列表。引擎由配置决定，失败时返回空数组而非抛错（不阻断对话）。 */
export async function executeWebSearch(
  query: string,
  cfg: SearchConfig,
): Promise<SearchResult[]> {
  const engine = cfg.searchEngine ?? 'tavily';
  const apiKey = cfg.searchApiKey?.trim();
  if (!apiKey) return [];

  try {
    if (engine === 'brave') return await braveSearch(query, apiKey);
    return await tavilySearch(query, apiKey);
  } catch {
    // 搜索失败不阻断对话，返回空结果让 AI 自行回答
    return [];
  }
}

/** Tavily Search API：专为 AI 设计，返回干净的文本片段。免费额度 1000 次/月。 */
async function tavilySearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: 5,
      search_depth: 'basic',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? [])
    .filter((r) => r.url && r.content)
    .map((r) => ({
      title: r.title ?? r.url ?? '',
      url: r.url!,
      snippet: r.content!.slice(0, 500),
    }));
}

/** Brave Search API：免费额度 2000 次/月。 */
async function braveSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title ?? r.url ?? '',
      url: r.url!,
      snippet: (r.description ?? '').slice(0, 500),
    }));
}

/** 将搜索结果格式化为 tool 消息内容（注入给 AI） */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `搜索"${query}"未返回结果。请基于你已有知识回答，或建议用户换用更精确的关键词重试。`;
  }
  const lines = results.map(
    (r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n摘要: ${r.snippet}`,
  );
  return `搜索"${query}"返回 ${results.length} 条结果：\n\n${lines.join('\n\n')}`;
}

// ---------- 注册到工具注册表 ----------

/**
 * web_search 工具执行逻辑：
 * - 从 args.query 提取搜索关键词
 * - 调用 executeWebSearch 获取结果
 * - content 格式化后注入对话（AI 看到搜索摘要）
 * - metadata 携带来源链接（前端展示引用）
 */
registerTool({
  definition: WEB_SEARCH_TOOL,
  execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) {
      return { content: '搜索关键词为空，请提供有效的搜索词。' };
    }
    const results = await executeWebSearch(query, ctx.cfg);
    const content = formatSearchResults(query, results);
    // metadata 携带来源链接给前端展示
    const metadata = results.length > 0
      ? results.map((r) => ({ title: r.title, url: r.url }))
      : undefined;
    return { content, metadata };
  },
});
