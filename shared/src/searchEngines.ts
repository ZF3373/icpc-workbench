/**
 * 联网搜索引擎注册表（多渠道 + fallback 编排，调用实现在 server/src/ai/search-engines.ts）。
 *
 * 这里只放「元数据」：展示名 / 能力 / 免费额度 / 注册入口。它是 client 设置 UI 与
 * server 校验、编排的共享真相；各引擎的 HTTP 调用只存在于 server 侧（出网逻辑不进
 * WebView，也便于测试 monkey-patch fetch）。
 *
 * 数组顺序即**默认 fallback 顺序**：按可持续免费次数从多到少（不限量 > 每日重置 >
 * 每月重置 > 一次性），相当时注册/绑卡门槛低的优先。用户在设置页启用并排序后，运行时
 * 按 ai.searchProviders 的数组顺序逐个尝试，失败或额度用尽自动换下一个（同一引擎可配
 * 多个 Key，每行一个，按序轮换）。引擎清单与默认序对齐 dsh-web-search-free。
 */

export const SEARCH_ENGINE_IDS = [
  'tinyfish',
  'searxng',
  'anysearch',
  'baidu',
  'tavily',
  'brave',
  'exa',
  'firecrawl',
  'volcengine',
  'serpapi',
  'jina',
  'serpingapi',
] as const;

export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];

export interface SearchEngineMeta {
  id: SearchEngineId;
  /** 展示名（设置页与错误信息共用） */
  label: string;
  /** 支持抓取（URL → 正文）；不支持的引擎不进 fetch_url 的引擎链，只参与搜索 */
  supportsFetch: boolean;
  /** 无 Key 也可用（如 AnySearch 匿名搜索）；此类引擎未填 Key 也参与链条 */
  allowsKeyless: boolean;
  /** 免费额度文案（设置页展示，以各控制台为准） */
  quota: string;
  /** 注册/获取 Key 的入口；自建类引擎是部署文档 */
  registerUrl?: string;
  /** Key 输入框语义特殊：填的是实例地址而非密钥（SearXNG） */
  keyIsUrl?: boolean;
}

export const SEARCH_ENGINES: readonly SearchEngineMeta[] = [
  {
    id: 'tinyfish',
    label: 'TinyFish',
    supportsFetch: true,
    allowsKeyless: false,
    quota: '搜索/抓取免费，限速（Search 30 次/分、Fetch 150 次/分）',
    registerUrl: 'https://www.tinyfish.ai/pricing',
  },
  {
    id: 'searxng',
    label: 'SearXNG',
    supportsFetch: false,
    allowsKeyless: false,
    quota: '自建实例，免费不限量（Key 填实例地址）',
    registerUrl: 'https://docs.searxng.org/admin/installation.html',
    keyIsUrl: true,
  },
  {
    id: 'anysearch',
    label: 'AnySearch',
    supportsFetch: true,
    allowsKeyless: true,
    quota: '1000 次/天（每日重置）',
    registerUrl: 'https://anysearch.com/pricing',
  },
  {
    id: 'baidu',
    label: 'Baidu Qianfan',
    supportsFetch: false,
    allowsKeyless: false,
    quota: '每日免费额度（每日重置）',
    registerUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list',
  },
  {
    id: 'tavily',
    label: 'Tavily',
    supportsFetch: true,
    allowsKeyless: false,
    quota: '1000 credits/月',
    registerUrl: 'https://app.tavily.com/',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    supportsFetch: false,
    allowsKeyless: false,
    quota: '$5 额度/月（需绑卡，约 1000 次）',
    registerUrl: 'https://api-dashboard.search.brave.com/register',
  },
  {
    id: 'exa',
    label: 'Exa (Metaphor)',
    supportsFetch: true,
    allowsKeyless: false,
    quota: '注册送 $20 + 每月补 $10（约 700 次/月）',
    registerUrl: 'https://dashboard.exa.ai/',
  },
  {
    id: 'firecrawl',
    label: 'Firecrawl',
    supportsFetch: true,
    allowsKeyless: false,
    quota: '1000 credits/月（约 500 次搜索）',
    registerUrl: 'https://www.firecrawl.dev/',
  },
  {
    id: 'volcengine',
    label: 'Volcengine（豆包搜索）',
    supportsFetch: false,
    allowsKeyless: false,
    quota: '500 次/月',
    registerUrl: 'https://console.volcengine.com/search-infinity/api-key',
  },
  {
    id: 'serpapi',
    label: 'SerpApi',
    supportsFetch: false,
    allowsKeyless: false,
    quota: '250 次/月',
    registerUrl: 'https://serpapi.com/users/sign_up',
  },
  {
    id: 'jina',
    label: 'Jina AI',
    supportsFetch: true,
    allowsKeyless: false,
    quota: '新 Key 送 10M tokens（一次性）',
    registerUrl: 'https://jina.ai/api-key',
  },
  {
    id: 'serpingapi',
    label: 'Serping API',
    supportsFetch: false,
    allowsKeyless: false,
    quota: '1000 次（一次性，无需绑卡）',
    registerUrl: 'https://serpingapi.com/signup',
  },
];

export function searchEngineMeta(id: string): SearchEngineMeta | undefined {
  return SEARCH_ENGINES.find((e) => e.id === id);
}

export function isSearchEngineId(value: unknown): value is SearchEngineId {
  return typeof value === 'string' && (SEARCH_ENGINE_IDS as readonly string[]).includes(value);
}

/**
 * 搜索渠道的持久化形状（settings 表 `ai.searchProviders` 键，存 JSON 字符串）。
 * `order` 是启用的引擎与 fallback 顺序；`keys` 是各引擎的 Key 列表——**引擎被移出
 * order 时 Key 保留**，重新启用免重填（对齐 dsh-web-search-free 的体验）。
 */
export interface SearchProvidersConfig {
  order: SearchEngineId[];
  keys: Partial<Record<SearchEngineId, string[]>>;
}

/** 单引擎 Key 输入归一：字符串按行拆（textarea 多 Key）、数组逐项；trim + 去空 + 去重，上限 20 个 */
export function normalizeEngineKeys(input: unknown): string[] {
  const rawLines: unknown[] = typeof input === 'string' ? input.split('\n') : Array.isArray(input) ? input : [];
  const out: string[] = [];
  for (const item of rawLines) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (key && !out.includes(key)) out.push(key);
  }
  return out.slice(0, 20);
}

/**
 * 解析持久化 blob（容忍脏数据：未知引擎/空 Key 静默丢弃）。
 * 非法输入（坏 JSON / 非对象 / 空串）返回 undefined —— 视为「未配置」，读取侧回退遗留单引擎字段。
 */
export function parseSearchProvidersConfig(raw: unknown): SearchProvidersConfig | undefined {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return undefined;
    try {
      obj = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (obj === null || typeof obj !== 'object') return undefined;
  const o = obj as { order?: unknown; keys?: unknown };
  const order: SearchEngineId[] = [];
  if (Array.isArray(o.order)) {
    for (const id of o.order) {
      if (isSearchEngineId(id) && !order.includes(id)) order.push(id);
    }
  }
  const keys: Partial<Record<SearchEngineId, string[]>> = {};
  if (o.keys && typeof o.keys === 'object') {
    for (const [engine, input] of Object.entries(o.keys as Record<string, unknown>)) {
      if (!isSearchEngineId(engine)) continue;
      const list = normalizeEngineKeys(input);
      if (list.length > 0) keys[engine] = list;
    }
  }
  return { order, keys };
}

/** 设置页回显的渠道条目：只带 Key 数量，不带原文（秘密不下发） */
export interface SearchEngineChannelView {
  engine: SearchEngineId;
  keysCount: number;
}
