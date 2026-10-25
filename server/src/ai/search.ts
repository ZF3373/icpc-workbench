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

/** 搜索工具结果：成功时 results 非空；失败/未配置时 error 说明原因 */
export interface WebSearchOutcome {
  results: SearchResult[];
  error?: string;
}

/** 执行网络搜索。失败不抛错（不阻断对话），但把原因放进 error 让 AI 与日志都能看到。 */
export async function executeWebSearch(
  query: string,
  cfg: SearchConfig,
): Promise<WebSearchOutcome> {
  const engine = cfg.searchEngine ?? 'tavily';
  const apiKey = cfg.searchApiKey?.trim();
  if (!apiKey) {
    return {
      results: [],
      error: `未配置${engine === 'brave' ? ' Brave' : ' Tavily'}搜索密钥（设置 → AI 配置 → 搜索 API 密钥），无法联网搜索。请告知用户该功能未配置，不要假装已搜索。`,
    };
  }

  try {
    if (engine === 'brave') return await braveSearch(query, apiKey);
    return await tavilySearch(query, apiKey);
  } catch (e) {
    // 搜索失败不阻断对话：AI 收到失败原因后可降级回答（标注未联网核验）
    console.error('[web_search] 请求失败:', (e as Error).message);
    return {
      results: [],
      error: `搜索请求失败：${(e as Error).message}。请告知用户搜索当前不可用，基于已有知识回答并标注未联网核验。`,
    };
  }
}

/** Tavily Search API：专为 AI 设计，返回干净的文本片段。免费额度 1000 次/月。 */
async function tavilySearch(query: string, apiKey: string): Promise<WebSearchOutcome> {
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
  // 非 200 一律视为失败（4xx 配额/鉴权、5xx 服务端），把状态码透出——
  // 静默返回空结果会让模型反复发起搜索白耗轮次，且用户配错 key 毫无感知（issue 50）
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let reason = `Tavily HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) reason += '（密钥无效或无权限，请检查搜索 API 密钥）';
    else if (res.status === 429) reason += '（搜索配额已用尽，可稍后重试）';
    else if (res.status >= 500) reason += '（Tavily 服务端错误）';
    if (detail) reason += `：${detail.slice(0, 200)}`;
    console.error('[web_search]', reason);
    return { results: [], error: `搜索失败：${reason}。请告知用户，基于已有知识回答并标注未联网核验。` };
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return {
    results: (data.results ?? [])
      .filter((r) => r.url && r.content)
      .map((r) => ({
        title: r.title ?? r.url ?? '',
        url: r.url!,
        snippet: r.content!.slice(0, 500),
      })),
  };
}

/** Brave Search API：免费额度 2000 次/月。 */
async function braveSearch(query: string, apiKey: string): Promise<WebSearchOutcome> {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let reason = `Brave HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) reason += '（密钥无效或无权限，请检查搜索 API 密钥）';
    else if (res.status === 429) reason += '（搜索配额已用尽，可稍后重试）';
    else if (res.status >= 500) reason += '（Brave 服务端错误）';
    if (detail) reason += `：${detail.slice(0, 200)}`;
    console.error('[web_search]', reason);
    return { results: [], error: `搜索失败：${reason}。请告知用户，基于已有知识回答并标注未联网核验。` };
  }
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return {
    results: (data.web?.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? r.url ?? '',
        url: r.url!,
        snippet: (r.description ?? '').slice(0, 500),
      })),
  };
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
 * - content 格式化后注入对话（AI 看到搜索摘要或失败原因）
 * - metadata 携带来源链接（前端展示引用）
 */
registerTool({
  definition: WEB_SEARCH_TOOL,
  execute: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) {
      return { content: '搜索关键词为空，请提供有效的搜索词。' };
    }
    const { results, error } = await executeWebSearch(query, ctx.cfg);
    if (error) {
      // 失败原因直接作为工具结果：模型据此降级（告知用户/标注未核验），
      // 而不是拿「未返回结果」假装搜索成功过、反复再搜白耗轮次（issue 50）
      return { content: `联网搜索失败：${error}` };
    }
    const content = formatSearchResults(query, results);
    // metadata 携带来源链接给前端展示
    const metadata = results.length > 0
      ? results.map((r) => ({ title: r.title, url: r.url }))
      : undefined;
    return { content, metadata };
  },
});
