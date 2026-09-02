import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(SERVER_ROOT, 'config.json');

export interface AiConfig {
  enabled: boolean;
  baseURL: string;
  apiKey: string;
  model: string;
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
    model: 'deepseek-chat',
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

/** 读取运行时 AI 配置：DB settings 表优先于 config.json，apiKey 可被环境变量 AI_API_KEY 覆盖。 */
export function aiConfigFromDb(db: Db, cfg: AppConfig): AiConfig {
  const get = (key: string): string | undefined => {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  };

  const enabledRaw = get('ai.enabled');
  return {
    enabled: enabledRaw !== undefined ? enabledRaw === 'true' : cfg.ai.enabled,
    baseURL: get('ai.baseURL') ?? cfg.ai.baseURL,
    model: get('ai.model') ?? cfg.ai.model,
    apiKey: process.env.AI_API_KEY ?? get('ai.apiKey') ?? cfg.ai.apiKey,
  };
}

/** 将 AI 配置写入 DB settings 表（设置页可改，重启保留）。 */
export function saveAiConfig(db: Db, cfg: AppConfig, patch: Partial<AiConfig>): AiConfig {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const entries: [string, string | undefined][] = [
    ['ai.enabled', patch.enabled === undefined ? undefined : String(patch.enabled)],
    ['ai.baseURL', patch.baseURL],
    ['ai.apiKey', patch.apiKey],
    ['ai.model', patch.model],
  ];
  for (const [k, v] of entries) {
    if (v !== undefined) upsert.run(k, v);
  }
  return aiConfigFromDb(db, cfg);
}
