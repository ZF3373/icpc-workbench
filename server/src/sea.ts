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
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { isSea, getAsset } from 'node:sea';
import express, { type Express } from 'express';
import { aiConfigFromDb, loadConfig, DEFAULT_CONFIG, type AppConfig } from './config.ts';
import { tryLaunchWidget } from './widget-launcher.ts';
import { createDb } from './db/index.ts';
import { initAdapters } from './adapters/index.ts';
import { checkinsRoutes } from './routes/checkins.ts';
import { contestsRoutes } from './routes/contests.ts';
import { exportRoutes } from './routes/export.ts';
import { importRoutes } from './routes/import.ts';
import { plansRoutes } from './routes/plans.ts';
import { problemsRoutes } from './routes/problems.ts';
import { reviewsRoutes } from './routes/reviews.ts';
import { settingsRoutes } from './routes/settings.ts';
import { statsRoutes } from './routes/stats.ts';
import { syncRoutes } from './routes/sync.ts';
import { templatesRoutes } from './routes/templates.ts';
import { todayRoutes } from './routes/today.ts';
import { updateRoutes, APP_VERSION } from './routes/update.ts';
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
  app.use('/api/reviews', reviewsRoutes(db));
  app.use('/api/today', todayRoutes(db));
  app.use('/api/templates', templatesRoutes(db));
  app.use('/api/contests', contestsRoutes());
  app.use('/api/checkins', checkinsRoutes(db));
  app.use('/api/settings', settingsRoutes(db, config));
  app.use('/api/update', updateRoutes());
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
      version: APP_VERSION,
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
  // SEA：config.json 只从 exe 旁读取（缺省时静默用默认值，不给双击用户弹警告）；
  // dbPath/dataDir 固定到 exe 旁 data/
  const cfgPath = path.join(path.dirname(process.execPath), 'config.json');
  const cfg = existsSync(cfgPath) ? loadConfig(cfgPath) : { ...DEFAULT_CONFIG };
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
// SEA 面向双击运行的普通用户：自动开浏览器、端口冲突自动让位、报错不闪退。
if (isSea()) {
  process.on('uncaughtException', (e) => {
    void fatal(`程序出错：${e.message}`);
  });
  try {
    const { app, config } = startServer();
    const desiredPort = Number(process.env.PORT ?? config.port);
    bootSea(app, config, desiredPort).catch((e: unknown) => {
      void fatal(errMessage(e));
    });
  } catch (e) {
    void fatal(errMessage(e));
  }
} else {
  const { app, port } = startServer();
  app.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
    console.log(`[server] widget page: http://localhost:${port}/widget`);
  });
}

// ---------- SEA 启动流程 ----------

/**
 * 双击 exe 的启动体验：
 * - 重复双击：检测到已运行的本程序实例 → 直接打开它的页面并退出
 * - 端口被其他程序占用：自动尝试后续端口
 * - 只监听 127.0.0.1，避免 Windows 首次运行弹出防火墙授权窗口
 * - 就绪后自动打开默认浏览器，并展示“勿关窗口”等中文提示
 */
async function bootSea(app: Express, config: AppConfig, desiredPort: number): Promise<void> {
  if (await isOurInstance(desiredPort)) {
    console.log('ICPC 备赛工作台已经在运行了，正在为你打开页面…');
    openBrowser(`http://localhost:${desiredPort}`);
    await holdWindow(6000);
    process.exit(0);
  }

  let port = desiredPort;
  let server: Server | null = null;
  for (let i = 0; i < 20; i++, port++) {
    try {
      server = await listenOn(app, port);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!server) throw new Error(`端口 ${desiredPort} 起连续 20 个端口均被占用，无法启动`);

  server.on('error', (e) => {
    void fatal(`运行出错：${(e as Error).message}`);
  });
  if (port !== desiredPort) {
    console.log(`提示：默认端口 ${desiredPort} 被其他程序占用，已自动改用 ${port}。`);
  }
  const url = `http://localhost:${port}`;
  console.log(banner(url, APP_VERSION));
  openBrowser(url);
  if (tryLaunchWidget(config, port)) {
    console.log(`[widget] 已自动拉起桌面挂件（关闭可在 config.json 设 launchWidget: false）`);
  }
}

/** 在 127.0.0.1 上监听，端口占用时以 EADDRINUSE reject。 */
function listenOn(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
    server.once('error', reject);
  });
}

/** 判断某端口上是否已是本程序实例（health 探测）。 */
async function isOurInstance(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean; platforms?: unknown };
    return data.ok === true && Array.isArray(data.platforms);
  } catch {
    return false;
  }
}

/** 用系统默认浏览器打开页面；失败不影响服务本身。 */
function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    cmd.unref();
  } catch {
    console.log(`（自动打开浏览器失败，请手动访问 ${url}）`);
  }
}

function banner(url: string, version: string): string {
  const line = '='.repeat(54);
  return [
    '',
    line,
    '   ICPC 备赛工作台  已启动！',
    line,
    `   软件页面：${url}`,
    '   （浏览器没有自动打开？把上面网址复制到浏览器即可）',
    '',
    `   当前版本：${version}（可在 设置 → 软件更新 中检查新版本）`,
    '   [1] 使用期间请保留本窗口，可以最小化；关闭窗口 = 退出软件',
    '   [2] 练习数据保存在本软件旁的 data 文件夹，请勿删除',
    `   [3] widget 挂件页面：${url}/widget`,
    line,
    '',
  ].join('\n');
}

/** 启动失败：给出可读报错并让窗口停留（双击场景默认一闪而过，用户根本看不清）。 */
async function fatal(message: string): Promise<never> {
  console.error(`\n[启动失败] ${message}`);
  console.error('请把本窗口截图，反馈给软件提供者。');
  await holdWindow(120000);
  process.exit(1);
}

/** 交互式窗口等用户按键，超时 ms 后放行；非交互（管道/测试）立即返回。 */
function holdWindow(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    try {
      if (process.stdin?.isTTY) {
        console.log('（按任意键关闭本窗口）');
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once('data', done);
      } else {
        done();
      }
    } catch {
      done();
    }
  });
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
