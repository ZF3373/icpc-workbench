import type { ToolDefinition } from './provider.ts';
import { searchEngineMeta } from '../../../shared/src/index.ts';
import { registerTool, type ToolResult, type ToolContext } from './tools/registry.ts';
import {
  ATTEMPT_TIMEOUT_MS,
  SearchEngineError,
  benchEngineKey,
  buildAttempts,
  describeEngineFailure,
  engineAdapter,
  maskKey,
  type SearchProviderEntry,
} from './search-engines.ts';

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
  /** 遗留单引擎字段（旧配置兼容；新配置用 searchProviders，见 resolveSearchProviders） */
  searchEngine?: 'tavily' | 'brave';
  /** 遗留单密钥字段（旧配置兼容） */
  searchApiKey?: string;
  /** 多渠道：启用的引擎与各自 Key 列表，数组顺序即 fallback 顺序；显式空数组 = 用户清空了渠道 */
  searchProviders?: SearchProviderEntry[];
}

/**
 * 解析生效的渠道清单：
 * - searchProviders 已定义（含显式空数组）→ 以它为准，**不再回退遗留字段**——用户在
 *   设置页清空渠道就是想关掉搜索，旧 Key 静默复活会违背操作意图；
 * - 未定义（旧配置/直接构造的 SearchConfig）→ 回退遗留单引擎字段；
 * - 环境变量 SEARCH_API_KEY 作为**末位兜底渠道**追加（不覆盖设置页排的序；仅当与已配
 *   Tavily Key 不同时），保持 env 覆盖语义在多渠道下仍可用。
 */
export function resolveSearchProviders(cfg: SearchConfig): SearchProviderEntry[] {
  const seen = new Set<string>();
  const entries: SearchProviderEntry[] = [];
  const push = (engine: string, keys: string[]) => {
    if (!seen.has(engine)) {
      seen.add(engine);
      entries.push({ engine: engine as SearchProviderEntry['engine'], keys });
    }
  };
  for (const e of cfg.searchProviders ?? []) {
    if (typeof e?.engine !== 'string') continue;
    const keys = [...new Set((e.keys ?? []).map((k) => k.trim()).filter((k) => k !== ''))];
    if (!engineAdapter(e.engine) || (!keys.length && !searchEngineMeta(e.engine)?.allowsKeyless)) continue;
    push(e.engine, keys);
  }
  if (cfg.searchProviders !== undefined) {
    appendEnvFallback(entries);
    return entries;
  }
  // 遗留单引擎：engine 缺省 tavily；key 已由 aiConfigFromDb 做 env 优先解析，此处再查一次 env 兜直接构造的配置
  const legacyKey = (cfg.searchApiKey ?? process.env.SEARCH_API_KEY ?? '').trim();
  if (!legacyKey) return [];
  push(cfg.searchEngine === 'brave' ? 'brave' : 'tavily', [legacyKey]);
  return entries;
}

/** env SEARCH_API_KEY 追加为末位 Tavily 兜底渠道（去重：与已配 Tavily Key 相同则不重复） */
function appendEnvFallback(entries: SearchProviderEntry[]): void {
  const envKey = process.env.SEARCH_API_KEY?.trim();
  if (!envKey) return;
  if (entries.some((e) => e.engine === 'tavily' && e.keys.includes(envKey))) return;
  // 独立追加，不能并入靠前的 Tavily 条目，否则 env 会抢在用户后续引擎之前执行。
  entries.push({ engine: 'tavily', keys: [envKey] });
}

/** 从完整 AI 配置中摘出搜索相关字段（避免把 baseURL/apiKey 等无关配置散播给下层） */
export function pickSearchConfig(cfg: SearchConfig): SearchConfig {
  return {
    ...(cfg.searchEngine !== undefined ? { searchEngine: cfg.searchEngine } : {}),
    ...(cfg.searchApiKey !== undefined ? { searchApiKey: cfg.searchApiKey } : {}),
    ...(cfg.searchProviders !== undefined ? { searchProviders: cfg.searchProviders } : {}),
  };
}

/** 是否配置了任一搜索渠道（题面抓取「值得一试」的判据与 UI 提示共用） */
export function hasSearchChannel(cfg?: SearchConfig): boolean {
  if (!cfg) return false;
  return resolveSearchProviders(cfg).length > 0;
}

/** 搜索工具结果：成功时 results 非空；失败/未配置时 error 说明原因 */
export interface WebSearchOutcome {
  results: SearchResult[];
  error?: string;
}

/**
 * 执行网络搜索：按启用顺序逐个 (引擎, Key) 尝试，失败自动换下一个。
 * 失败不抛错（不阻断对话），把原因放进 error 让 AI 与日志都能看到。
 */
export async function executeWebSearch(
  query: string,
  cfg: SearchConfig,
): Promise<WebSearchOutcome> {
  const entries = resolveSearchProviders(cfg);
  if (entries.length === 0) {
    return {
      results: [],
      error: '未配置任何联网搜索渠道（设置 → AI 配置 → 联网搜索，填入任一引擎的 API Key），无法联网搜索。请告知用户该功能未配置，不要假装已搜索。',
    };
  }

  const trail: string[] = [];
  for (const { engine, key } of buildAttempts(entries, 'search')) {
    try {
      const results = await engine.search(query, key, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS.search));
      if (results.length > 0) return { results };
      throw new SearchEngineError(`${engine.label} 搜索无结果`);
    } catch (e) {
      benchEngineKey(engine, key, e, 'search');
      const failure = describeEngineFailure(e, key);
      trail.push(`${engine.label}（Key ${maskKey(key)}）: ${failure}`);
      console.error(`[web_search] ${engine.label}（Key ${maskKey(key)}）失败:`, failure);
    }
  }
  // 全部尝试失败：单渠道保持旧报错格式，多渠道逐个列出原因（谁失败、为何失败）
  const tail = '请告知用户，基于已有知识回答并标注未联网核验。';
  const error = trail.length === 1
    ? `搜索失败：${trail[0]}。${tail}`
    : `搜索失败（${trail.length} 个渠道均失败）：${trail.join('；')}。${tail}`;
  return { results: [], error };
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
