/**
 * SEA（Single Executable Application）打包入口适配层。
 *
 * 常规 tsx 开发运行：直接执行本文件，行为与原 index.ts 一致
 * （schema / 提示词 / widget 走磁盘文件，前端由 Vite dev server 提供）。
 *
 * SEA 打包：scripts/build-exe.mjs 以本文件为入口 esbuild bundle 成单 JS，
 * schema.sql / plan-prompt.md / widget.html / 前端 dist 全部作为 SEA assets 内嵌，
 * 运行时从 exe 自身读取（sea.getAsset），SQLite 数据库落在 exe 旁的 data/ 目录。
 */
import path from 'node:path';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isSea, getAsset } from 'node:sea';
import express, { type Express } from 'express';
import { aiConfigFromDb, loadConfig, type AppConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { initAdapters } from './adapters/index.ts';
import { checkinsRoutes } from './routes/checkins.ts';
import { exportRoutes } from './routes/export.ts';
import { importRoutes } from './routes/import.ts';
import { plansRoutes } from './routes/plans.ts';
import { problemsRoutes } from './routes/problems.ts';
import { settingsRoutes } from './routes/settings.ts';
import { statsRoutes } from './routes/stats.ts';
import { syncRoutes } from './routes/sync.ts';
import { widgetRoutes, setWidgetPublicDir } from './routes/widget.ts';
import { setSchemaSql } from './db/index.ts';
import { setPromptTemplate } from './plans/planService.ts';
import { PLATFORMS } from '../../shared/src/index.ts';

const CLIENT_DIST_PREFIX = 'client-dist/';
const WIDGET_FILES = ['widget.html'];

export function startServer(): { app: Express; port: number; config: AppConfig } {
  const config = loadConfigForRuntime();

  // SEA 资源注入：schema 与提示词模板从 exe 内读取
  setSchemaSql(readTextAsset('src/db/schema.sql'));
  setPromptTemplate(readTextAsset('src/ai/plan-prompt.md'));

  const db = createDb(config.dbPath);
  initAdapters(config.dataDir);

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use('/api/import', importRoutes(db));
  app.use('/api/sync', syncRoutes(db));
  app.use('/api/stats', statsRoutes(db));
  app.use('/api/plans', plansRoutes(db, () => aiConfigFromDb(db, config)));
  app.use('/api/export', exportRoutes(db));
  app.use('/api/problems', problemsRoutes(db));
  app.use('/api/checkins', checkinsRoutes(db));
  app.use('/api/settings', settingsRoutes(db, config));
  // widget 静态目录必须先注入再创建 router（express.static 创建时捕获目录值）
  setWidgetPublicDir(resolveWidgetDir());
  app.use('/widget', widgetRoutes());

  // 前端 SPA：静态资源 + BrowserRouter 刷新兜底
  const distDir = resolveClientDist();
  if (distDir) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api|\/widget).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      time: new Date().toISOString(),
      platforms: PLATFORMS.map((p) => p.id),
      dbPath: config.dbPath,
      sea: isSea(),
    });
  });

  const port = Number(process.env.PORT ?? config.port);
  return { app, port, config };
}

// ---------- 资源解析 ----------

/**
 * SEA 资产统一解码：Node 24 getAsset 恒返回 ArrayBuffer（配置层无 text 选项），
 * 文本资产此处转 string，二进制保留 Buffer。
 */
function assetToString(v: ArrayBuffer | string): string {
  return typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
}

function assetToBuffer(v: ArrayBuffer | Buffer): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

function readTextAsset(relPath: string): string {
  if (isSea()) return assetToString(getAsset(relPath) as ArrayBuffer | string);
  // 开发模式：sea.ts 位于 server/src/，资源相对 server/ 根
  const serverRoot = path.resolve(import.meta.dirname, '..');
  return fs.readFileSync(path.join(serverRoot, relPath), 'utf8');
}

/** SEA 模式下用户数据目录：exe 旁 data/（数据库、AtCoder 缓存等） */
function seaDataDir(): string {
  return path.join(path.dirname(process.execPath), 'data');
}

function loadConfigForRuntime(): AppConfig {
  if (!isSea()) return loadConfig();
  // SEA：config.json 只从 exe 旁读取；dbPath/dataDir 固定到 exe 旁 data/
  const cfgPath = path.join(path.dirname(process.execPath), 'config.json');
  const cfg = loadConfig(cfgPath);
  const dataDir = seaDataDir();
  return { ...cfg, dataDir, dbPath: path.join(dataDir, 'icpc.db') };
}

let clientDistDir: string | null = null;

/** 前端 dist：SEA 时按 manifest 提取到临时目录；开发时复用 client/dist（存在则服务） */
function resolveClientDist(): string | null {
  if (clientDistDir) return clientDistDir;
  if (!isSea()) {
    const devDist = path.resolve(import.meta.dirname, '..', '..', 'client', 'dist');
    if (existsSync(path.join(devDist, 'index.html'))) clientDistDir = devDist;
    return clientDistDir;
  }
  const manifest = assetToString(getAsset(`${CLIENT_DIST_PREFIX}manifest.txt`) as ArrayBuffer | string);
  const names = manifest
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'icpc-web-'));
  for (const name of names) {
    const buf = assetToBuffer(getAsset(`${CLIENT_DIST_PREFIX}${name}`) as ArrayBuffer | Buffer);
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
  }
  clientDistDir = dir;
  return dir;
}

let widgetDirCache: string | null = null;

/** widget 静态目录：SEA 时提取内嵌 widget.html；开发时用 server/src/public */
function resolveWidgetDir(): string {
  if (widgetDirCache) return widgetDirCache;
  if (!isSea()) {
    widgetDirCache = path.resolve(import.meta.dirname, 'public');
    return widgetDirCache;
  }
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'icpc-widget-'));
  for (const name of WIDGET_FILES) {
    fs.writeFileSync(
      path.join(dir, name),
      assetToBuffer(getAsset(`public/${name}`) as ArrayBuffer | Buffer),
    );
  }
  widgetDirCache = dir;
  return dir;
}

// ---- 直接执行（tsx dev 或 SEA bundle 顶层）时启动监听 ----
const { app, port, config } = startServer();
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] widget page: http://localhost:${port}/widget`);
  if (isSea()) console.log(`[sea] data dir: ${config.dataDir}`);
});
