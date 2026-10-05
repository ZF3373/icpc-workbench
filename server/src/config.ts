import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiProviderConfig } from '../../shared/src/index.ts';
import { AI_PROVIDERS_MAX, AI_PROVIDER_MODELS_MAX } from '../../shared/src/index.ts';
import type { Db } from './db/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(SERVER_ROOT, 'config.json');

export interface AiConfig {
  enabled: boolean;
  /** 当前活跃提供商的 Base URL（多提供商：来自 ai.providers 中激活项，见 readAiProviders） */
  baseURL: string;
  /** 当前活跃提供商的 API Key（环境变量 AI_API_KEY 仍最高优先） */
  apiKey: string;
  /** 当前活跃提供商的模型 */
  model: string;
  /** AI 对话超时（毫秒），用户可在设置页调整；缺省 120000（2 分钟） */
  timeoutMs?: number;
  /** AI 单次回复最大 token 数，用户可在设置页调整；缺省 393216（384K）。值越大越不易截断，但受模型上限约束 */
  maxTokens?: number;
  /** 模型上下文窗口大小（token 数），含输入+输出；对话历史超限时自动裁剪最早消息。缺省 1024000（1000K） */
  contextWindow?: number;
  /** 联网搜索引擎：tavily（默认，AI 友好）或 brave */
  searchEngine?: 'tavily' | 'brave';
  /** 搜索 API Key，留空则不启用联网搜索（AI 回复不含外部信息） */
  searchApiKey?: string;
}

export interface AppConfig {
  port: number;
  dbPath: string;
  dataDir: string;
  launchWidget: boolean;
  ai: AiConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 3001,
  dbPath: path.join(SERVER_ROOT, 'data', 'icpc.db'),
  dataDir: path.join(SERVER_ROOT, 'data'),
  launchWidget: true,
  ai: {
    enabled: false,
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-flash',
    timeoutMs: 120000,
    maxTokens: 393216,
    contextWindow: 1024000,
  },
};

/** 加载并校验 config.json（不存在时回退默认值，可复制 config.example.json）。 */
export function loadConfig(filePath: string = DEFAULT_CONFIG_PATH): AppConfig {
  let file: Partial<AppConfig> = {};
  if (fs.existsSync(filePath)) {
    try {
      file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<AppConfig>;
    } catch (e) {
      throw new Error(`config.json 解析失败: ${(e as Error).message}`);
    }
  } else {
    // 缺省时静默回退默认值——开发模式每次 tsx watch 重启都会触发，反复 warn 反而干扰
  }

  const cfg: AppConfig = {
    port: Number(file.port ?? DEFAULT_CONFIG.port),
    dbPath: resolvePath(file.dbPath, DEFAULT_CONFIG.dbPath),
    dataDir: resolvePath(file.dataDir, DEFAULT_CONFIG.dataDir),
    launchWidget: typeof file.launchWidget === 'boolean' ? file.launchWidget : DEFAULT_CONFIG.launchWidget,
    ai: { ...DEFAULT_CONFIG.ai, ...(file.ai ?? {}) },
  };
  validate(cfg);
  return cfg;
}

function resolvePath(p: unknown, fallback: string): string {
  if (typeof p !== 'string' || p.trim() === '') return fallback;
  return path.isAbsolute(p) ? p : path.resolve(SERVER_ROOT, p);
}

function validate(cfg: AppConfig): void {
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    throw new Error(`config.port 非法: ${cfg.port}`);
  }
  if (!cfg.dbPath) throw new Error('config.dbPath 不能为空');
  if (cfg.ai.enabled) {
    if (!/^https?:\/\//.test(cfg.ai.baseURL)) {
      throw new Error(`ai.baseURL 需为 http(s) URL: ${cfg.ai.baseURL}`);
    }
    if (!cfg.ai.apiKey) {
      throw new Error('ai.enabled=true 但未配置 ai.apiKey（可用环境变量 AI_API_KEY）');
    }
  }
}

/** settings 表单条读取（aiConfigFromDb / 提供商读写共用；预编译避免每个 key 重复 prepare） */
function settingsGetter(db: Db): (key: string) => string | undefined {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  return (key: string): string | undefined => {
    const row = getStmt.get(key) as { value: string } | undefined;
    return row?.value;
  };
}

/**
 * 读取全部已保存的模型提供商（settings 表 `ai.providers`，JSON 数组）。
 *
 * 存储损坏/字段缺失的条目按「能救则救」逐字段净化（trim、baseURL 必须 http(s)），
 * 整体不合法或为空时回退**旧版单提供商迁移**：用遗留的 ai.baseURL/ai.apiKey/ai.model
 * （DB 优先，缺省落回 config.json）合成 id=default 的单个提供商——
 * 升级用户零操作无缝衔接，旧数据不会被丢弃（下次保存提供商列表时才真正改写存储格式）。
 *
 * **环境变量 AI_API_KEY 只参与运行时解析（见 aiConfigFromDb），绝不进这里**：本函数的返回值
 * 既是界面回显的来源、又是 POST /ai 保存时「保持已存密钥」的兜底值，若把 env 密钥合成进来，
 * 用户点一次「保存 AI 配置」就会把它原文写进 settings（并随之进入每日备份），
 * 而旧版单密钥路径下 env 密钥是永不落库的。
 */
export function readAiProviders(db: Db, cfg: AppConfig): AiProviderConfig[] {
  const get = settingsGetter(db);
  const raw = get('ai.providers');
  if (raw) {
    const providers = sanitizeProviders(parseJsonArray(raw));
    if (providers.length > 0) return providers;
  }
  // ---- 旧版单提供商迁移（只读合成，不写库；首次保存提供商时才落新格式） ----
  // maxTokens/contextWindow 一并搬进迁移结果：否则升级用户激活任一提供商后，
  // 这两个参数会「跳回」config.json 内置默认值（而非他调过的全局值）。
  const apiKey = (get('ai.apiKey') ?? cfg.ai.apiKey).trim();
  const legacyGet = get('ai.maxTokens');
  const legacyCtx = get('ai.contextWindow');
  const legacyMaxTokens = Number(legacyGet);
  const legacyContextWindow = Number(legacyCtx);
  const legacy: AiProviderConfig = {
    id: 'default',
    name: '默认提供商',
    baseURL: (get('ai.baseURL') ?? cfg.ai.baseURL).trim(),
    apiKey,
    model: (get('ai.model') ?? cfg.ai.model).trim(),
    ...(Number.isFinite(legacyMaxTokens) && legacyMaxTokens > 0 ? { maxTokens: legacyMaxTokens } : {}),
    ...(Number.isFinite(legacyContextWindow) && legacyContextWindow > 0 ? { contextWindow: legacyContextWindow } : {}),
  };
  return [legacy];
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 逐条净化模型目录条目：id 必填去重、参数正数才收（对齐 sanitizeProviders 的口径） */
function sanitizeModelEntries(list: unknown[]): AiProviderConfig['models'] {
  const out: NonNullable<AiProviderConfig['models']> = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const contextWindow = Number(o.contextWindow);
    const maxTokens = Number(o.maxTokens);
    out.push({
      id,
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    });
    if (out.length >= AI_PROVIDER_MODELS_MAX) break;
  }
  return out;
}

/** 逐条净化提供商：字段缺失/类型不对的条目丢弃，合法条目 trim 归一；数量封顶防误粘贴 */
function sanitizeProviders(list: unknown[]): AiProviderConfig[] {
  const out: AiProviderConfig[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const baseURL = typeof o.baseURL === 'string' ? o.baseURL.trim() : '';
    if (!id || !name || !baseURL || !/^https?:\/\//.test(baseURL)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const maxTokens = Number(o.maxTokens);
    const contextWindow = Number(o.contextWindow);
    out.push({
      id,
      name,
      baseURL,
      apiKey: typeof o.apiKey === 'string' ? o.apiKey.trim() : '',
      model: typeof o.model === 'string' ? o.model.trim() : '',
      // 参数档位是可选覆盖：只在为正数时保留（防 0/负数/字符串混进存储）
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      // 模型目录：仅接受数组形态，条目内部自行净化；空数组 = 明确清空目录
      ...(Array.isArray(o.models) ? { models: sanitizeModelEntries(o.models) } : {}),
    });
    if (out.length >= AI_PROVIDERS_MAX) break;
  }
  return out;
}

/** 当前活跃提供商 id：`ai.activeProvider` 指向失效（被删/未设置）时回退第一个 */
export function activeProviderIdOf(db: Db, providers: AiProviderConfig[]): string {
  const raw = settingsGetter(db)('ai.activeProvider');
  if (raw && providers.some((p) => p.id === raw)) return raw;
  return providers[0]?.id ?? '';
}

/**
 * 把提供商列表 + 活跃 id 写入 settings 表（设置页「保存 AI 配置」整表覆盖保存）。
 *
 * 入参必须是已净化的完整列表（apiKey 原文）。活跃 id 的解析：
 * - 缺省（不传）：**保持已存的 `ai.activeProvider`**（仍在列表内）——旧客户端/脚本不传该字段时
 *   不该被静默切回首项；
 * - 显式传入且仍在列表内：用它；
 * - 显式传入但已失效（指向被删提供商）：落回首个。
 * 返回净化后的存储口径列表，供路由直接组装打码响应。
 */
export function saveAiProviders(
  db: Db,
  providers: AiProviderConfig[],
  activeId?: string,
): AiProviderConfig[] {
  const stored = sanitizeProviders(providers);
  if (stored.length === 0) throw new Error('至少需要保留一个提供商');
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  upsert.run('ai.providers', JSON.stringify(stored));
  const stillValid = (id: string | undefined): string | undefined =>
    id && stored.some((p) => p.id === id) ? id : undefined;
  // 缺省 = 保持已存活跃项；显式传入（含空串）= 以传入值为准，失效则回退首项
  const active = (activeId === undefined ? stillValid(settingsGetter(db)('ai.activeProvider')) : stillValid(activeId))
    ?? stored[0]!.id;
  upsert.run('ai.activeProvider', active);
  return stored;
}

/**
 * 全局兜底档位（不含提供商覆盖）：设置页回显「留空 = 跟随全局默认」用。
 * maxTokens/contextWindow 已下沉到提供商级，这里只保留 config.json/DB 全局键的兜底链。
 */
export function globalAiTuning(db: Db, cfg: AppConfig): { maxTokens?: number; contextWindow?: number } {
  const get = settingsGetter(db);
  const maxTokens = Number(get('ai.maxTokens'));
  const contextWindow = Number(get('ai.contextWindow'));
  return {
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : (cfg.ai.maxTokens ?? 0) > 0 ? { maxTokens: cfg.ai.maxTokens! } : {}),
    ...(Number.isFinite(contextWindow) && contextWindow > 0
      ? { contextWindow }
      : (cfg.ai.contextWindow ?? 0) > 0
        ? { contextWindow: cfg.ai.contextWindow! }
        : {}),
  };
}

/** 读取运行时 AI 配置：全局项读 settings 表（缺省落 config.json），baseURL/apiKey/model 取当前活跃提供商。 */
export function aiConfigFromDb(db: Db, cfg: AppConfig): AiConfig {
  const get = settingsGetter(db);

  const providers = readAiProviders(db, cfg);
  const activeId = activeProviderIdOf(db, providers);
  const active = providers.find((p) => p.id === activeId) ?? providers[0]!;

  const enabledRaw = get('ai.enabled');
  const timeoutRaw = get('ai.timeoutMs');
  const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : cfg.ai.timeoutMs;
  // 输出/上下文档位三级回退：当前模型命中的目录条目 → 提供商级 → 全局兜底链。
  // 目录条目参数最精确（来自网关真实值或用户手填），提供商级是「当前模型不在目录里」时的档位。
  const global = globalAiTuning(db, cfg);
  const entry = active.models?.find((m) => m.id === active.model.trim());
  const searchEngineRaw = get('ai.searchEngine');
  const searchEngine = searchEngineRaw === 'tavily' || searchEngineRaw === 'brave'
    ? searchEngineRaw
    : cfg.ai.searchEngine;
  const searchApiKey = (process.env.SEARCH_API_KEY ?? get('ai.searchApiKey') ?? cfg.ai.searchApiKey)?.trim();
  return {
    enabled: enabledRaw !== undefined ? enabledRaw === 'true' : cfg.ai.enabled,
    // trim：用户粘贴 baseURL/apiKey 时常带首尾空格/换行，会导致 URL 解析失败或鉴权头异常
    baseURL: active.baseURL.trim(),
    model: active.model.trim(),
    apiKey: (process.env.AI_API_KEY ?? active.apiKey).trim(),
    ...(Number.isFinite(timeoutMs) && timeoutMs! > 0 ? { timeoutMs: timeoutMs! } : {}),
    ...(entry?.maxTokens ?? active.maxTokens ?? global.maxTokens
      ? { maxTokens: (entry?.maxTokens ?? active.maxTokens ?? global.maxTokens)! } : {}),
    ...(entry?.contextWindow ?? active.contextWindow ?? global.contextWindow
      ? { contextWindow: (entry?.contextWindow ?? active.contextWindow ?? global.contextWindow)! } : {}),
    ...(searchEngine ? { searchEngine } : {}),
    ...(searchApiKey ? { searchApiKey } : {}),
  };
}

/**
 * 将 AI 配置写入 DB settings 表（设置页可改，重启保留）。
 *
 * baseURL/apiKey/model 是**旧版单提供商**的遗留键：多提供商改造后设置页不再提交它们，
 * 它们的正式载体是 ai.providers（见 saveAiProviders）。本函数仍接受这些字段，
 * 仅为兼容旧客户端/脚本；已迁移到提供商列表的用户写这些键不生效（读取侧优先 providers）。
 */
export function saveAiConfig(db: Db, cfg: AppConfig, patch: Partial<AiConfig>): AiConfig {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const entries: [string, string | undefined][] = [
    ['ai.enabled', patch.enabled === undefined ? undefined : String(patch.enabled)],
    // 存库前 trim，从源头避免带空格的粘贴值入库
    ['ai.baseURL', patch.baseURL?.trim()],
    ['ai.apiKey', patch.apiKey?.trim()],
    ['ai.model', patch.model?.trim()],
    ['ai.timeoutMs', patch.timeoutMs === undefined ? undefined : String(patch.timeoutMs)],
    ['ai.maxTokens', patch.maxTokens === undefined ? undefined : String(patch.maxTokens)],
    ['ai.contextWindow', patch.contextWindow === undefined ? undefined : String(patch.contextWindow)],
    ['ai.searchEngine', patch.searchEngine],
    ['ai.searchApiKey', patch.searchApiKey],
  ];
  for (const [k, v] of entries) {
    if (v !== undefined) upsert.run(k, v);
  }
  return aiConfigFromDb(db, cfg);
}
