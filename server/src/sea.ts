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
import { SERVER_ROOT } from './server-root.ts';
import { looksLikeOurInstance } from './instance-health.ts';
import { resolveDataDir, migrateLegacyDataDir } from './data-dir.ts';
import { aiConfigFromDb, loadConfig, DEFAULT_CONFIG, type AppConfig } from './config.ts';
import { tryLaunchWidget } from './widget-launcher.ts';
import { createDb, type Db } from './db/index.ts';
import { applyPendingRestore, createBackup, maybeDailyBackup } from './backup.ts';
import { configureSyncScheduler } from './adapters/syncScheduler.ts';
import { migratePlatformCookieToAccounts } from './adapters/accountCreds.ts';
import { setRequestIntervalScale } from './net/hostThrottle.ts';
import { backupsRoutes } from './routes/backups.ts';
import { initAdapters } from './adapters/index.ts';
import { compressionMiddleware, errorHandler, hostGuard, securityHeaders } from './middleware.ts';
import { spaStaticRoutes } from './spa-static.ts';
import { checkinsRoutes } from './routes/checkins.ts';
import { contestsRoutes } from './routes/contests.ts';
import { exportRoutes } from './routes/export.ts';
import { historyRoutes } from './routes/history.ts';
import { importRoutes } from './routes/import.ts';
import { knowledgeRoutes } from './routes/knowledge.ts';
import { listsRoutes } from './routes/lists.ts';
import { plansRoutes } from './routes/plans.ts';
import { problemsRoutes } from './routes/problems.ts';
import { reviewsRoutes } from './routes/reviews.ts';
import { settingsRoutes } from './routes/settings.ts';
import { shellAuthRoutes } from './routes/shellAuth.ts';
import { qojAgentRoutes } from './routes/qojAgent.ts';
import { statsRoutes } from './routes/stats.ts';
import { syncRoutes } from './routes/sync.ts';
import { templatesRoutes } from './routes/templates.ts';
import { todayRoutes } from './routes/today.ts';
import { updateRoutes, APP_VERSION } from './routes/update.ts';
import { uploadsRoutes } from './routes/uploads.ts';
import { widgetRoutes, setWidgetPublicDir } from './routes/widget.ts';
import { mcpRoutes } from './routes/mcp.ts';
import { setSchemaSql } from './db/index.ts';
import { setBuiltinBankJson, seedBuiltinBank } from './db/builtinBank.ts';
import { setPromptTemplate } from './plans/planService.ts';
import { aiRoutes, setAssistantPromptTemplate, setTitlePromptTemplate } from './routes/ai.ts';
import { PLATFORMS } from '../../shared/src/index.ts';
import { setTaxonomyJson } from './knowledge/taxonomy.ts';
import { setRulesJson } from './knowledge/ruleEngine.ts';
import { initKnowledgeStore, loadAnnotationsIntoDb, purgeAiAnnotations } from './knowledge/store.ts';
import { setBundledTypstBinary } from './templates/typst.ts';

const CLIENT_DIST_PREFIX = 'client-dist/';
const WIDGET_FILES = ['widget.html'];

/**
 * 启动期装配结果。
 *
 * `db` 必须交给调用方：优雅退出要关闭 SQLite 连接让 WAL 正常收尾，否则容器被
 * SIGTERM 后的重启会读到未 checkpoint 的 -wal/-shm 残留。
 */
export interface StartedServer {
  app: Express;
  port: number;
  config: AppConfig;
  db: Db;
}

export function startServer(
  boundHost: string = process.env.HOST ?? '127.0.0.1',
): StartedServer {
  const config = loadConfigForRuntime();
  if (isSea()) {
    setBundledTypstBinary(
      assetToBuffer(getAsset('vendor/typst') as ArrayBuffer | Buffer),
    );
  }

  // SEA 资源注入：schema 与提示词模板从 exe 内读取
  setSchemaSql(readTextAsset('src/db/schema.sql'));
  setPromptTemplate(readTextAsset('src/ai/plan-prompt.md'));
  setAssistantPromptTemplate(readTextAsset('src/ai/assistant-prompt.md'));
  // 会话标题提示词同样必须入包：漏了它，打包版每次 POST /api/ai/title 都读盘失败 → 502，
  // 前端静默回退成「首条消息截断」，用户永远拿不到生成的标题
  setTitlePromptTemplate(readTextAsset('src/ai/title-prompt.md'));
  setBuiltinBankJson(readTextAsset('src/data/bank-builtin.json'));
  setTaxonomyJson(readTextAsset('src/knowledge/taxonomy.json'));
  setRulesJson(readTextAsset('src/knowledge/rules.json'));

  // 恢复点回滚：必须在 createDb 之前应用（覆盖数据库文件）——与 index.ts 同序，
  // 漏了它 SEA 版「设置 → 备份 → 恢复」的重启生效永远不发生，且 pending 标记残留导致该备份无法删除
  applyPendingRestore(config.dbPath);
  const db = createDb(config.dbPath);
  seedBuiltinBank(db); // 内置题库播种：版本变化时 upsert 一次，日常启动零开销
  // 账号级凭据迁移（幂等）：与 index.ts 同序——漏了它，pre-0.9 升级的打包版/Docker 用户
  // 的平台级旧 Cookie 永远不会播种到账号槽位，所有账号同步报「未配置 Cookie」
  try {
    if (migratePlatformCookieToAccounts(db)) {
      console.log('[accountCreds] 已将平台级 Cookie 迁移到各绑定账号');
    }
  } catch (e) {
    console.error(`[accountCreds] 平台级 Cookie 迁移失败（不影响启动）: ${(e as Error).message}`);
  }
  initAdapters(config.dataDir);
  // 后台分批续拉调度器：截断的同步按平台节奏自动续拉下一批。SEA 与 Docker（非 SEA 分支）
  // 都走本入口，漏装配会让「已截断、待续拉」的同步永远停在第一轮
  configureSyncScheduler({ db });
  // 拉取速度全局倍率：从设置恢复（缺失/越界 → 收敛为默认 1× = 安全下限）。
  // 节流层每次请求实时读取该值，此处一次下发即对整个进程生效
  const intervalScaleRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('sync.requestIntervalScale') as { value: string } | undefined;
  setRequestIntervalScale(Number(intervalScaleRow?.value));
  // 知识点管线：JSONL 源真相 → SQLite 索引幂等重建（无 JSONL 时零开销）
  initKnowledgeStore(config.dataDir);
  // 每日首次启动自动备份（settings 键幂等）；失败不阻塞启动——与 index.ts 同口径，
  // 漏了它 SEA 版永远没有每日备份
  try {
    const daily = maybeDailyBackup(db);
    if (daily.created) console.log(`[backup] 已创建每日备份 ${daily.file}`);
  } catch (e) {
    console.error(`[backup] 每日备份失败（不影响启动）: ${(e as Error).message}`);
  }
  try {
    const purged = purgeAiAnnotations(db, { dataDir: config.dataDir });
    if (purged.deleted > 0 || purged.tombstones > 0) {
      console.log(`[knowledge] 已清理 AI 标注: 删除 ${purged.deleted} 条，写入 ${purged.tombstones} 个 tombstone`);
    }
  } catch (e) {
    console.error(`[knowledge] AI 标注清理失败（不影响启动）: ${(e as Error).message}`);
  }
  try {
    const loaded = loadAnnotationsIntoDb(db, config.dataDir);
    if (loaded.lines > 0) {
      console.log(`[knowledge] 已从 JSONL 重建索引: ${loaded.inserted} 条标注 / ${loaded.problems} 题`);
    }
  } catch (e) {
    console.error(`[knowledge] JSONL 索引重建失败（不影响启动）: ${(e as Error).message}`);
  }

  const app = express();
  // Host 头校验（防 DNS rebinding）：与 index.ts 同口径，且必须早于所有路由——本应用全站
  // 零鉴权，安全边界全靠「默认只绑回环」；浏览器里的恶意页面可用 DNS rebinding 绕过它，
  // 以「同源」身份读走全部配置、调用全部写接口（例如把已存提供商的 baseURL 改到攻击者
  // 主机，此后用户自己的 AI 对话就会把真 Key 送出去）。
  //
  // ⚠ 本文件是 build-exe.mjs 的唯一 entryPoints，即**桌面版 icpc-core.exe 的真实入口**，
  // 其非 SEA 分支同时是 Docker 镜像的运行入口。此前只装了 index.ts（tsx 开发），打包版
  // 与 Docker 部署完全没有这道防线；守卫见 test/dual-entry-api-parity.test.ts。
  //
  // 判定与 index.ts 一致：仅绑定回环时启用；显式绑 0.0.0.0（Docker 的 HOST）时不校验——
  // 那是操作者主动选择的暴露，Host 会是任意域名，校验只会误伤。
  app.use(hostGuard(boundHost));
  // gzip/br 压缩：必须在所有路由与 express.static 之前——compression 在响应头写出时才
  // 决定是否压缩，挂到静态资源后面就只对之后注册的中间件生效。远程访问时前端产物
  // （约 6 MB JS/CSS）与 JSON 响应都能小一个数量级。SSE（/api/ai/chat）由 filter 显式排除，
  // 见 middleware.compressionMiddleware。
  app.use(compressionMiddleware());
  // 12 MiB：与 index.ts 对齐——/api/ai/chat 允许每条消息带 8 个附件、单个 textContent 上限
  // 1 MiB，加整封对话历史上行；2mb 会让这类合法请求在进入路由前就被 body-parser 拒掉。
  // （sea.ts 的非 SEA 分支也是 Docker 镜像的运行入口，Docker 部署走同一条限制）
  app.use(express.json({ limit: '12mb' }));
  app.use(securityHeaders);

  app.use('/api/import', importRoutes(db));
  app.use('/api/sync', syncRoutes(db));
  app.use('/api/stats', statsRoutes(db));
  app.use('/api/plans', plansRoutes(db, () => aiConfigFromDb(db, config)));
  app.use('/api/ai', aiRoutes(db, () => aiConfigFromDb(db, config)));
  app.use('/api/lists', listsRoutes(db, () => aiConfigFromDb(db, config)));
  app.use('/api/knowledge', knowledgeRoutes(db));
  app.use('/api/export', exportRoutes(db));
  app.use('/api/problems', problemsRoutes(db));
  app.use('/api/history', historyRoutes(db));
  app.use('/api/reviews', reviewsRoutes(db));
  app.use('/api/uploads', uploadsRoutes({ uploadsDir: path.join(config.dataDir, 'uploads') }));
  app.use('/api/today', todayRoutes(db));
  app.use('/api/templates', templatesRoutes(db, { dataDir: config.dataDir }));
  app.use('/api/contests', contestsRoutes(db));
  app.use('/api/checkins', checkinsRoutes(db));
  app.use('/api/settings', settingsRoutes(db, config));
  // 桌面壳凭据桥：登录窗口抓取 Cookie / QOJ 保活的中转。⚠ 服务器装配代码在 index.ts（dev）
  // 与本文件（SEA 打包）各有一份，新增路由必须两处同步——守卫见 test/dual-entry-api-parity.test.ts
  app.use('/api/settings/shell-auth', shellAuthRoutes(db));
  // QOJ WebView 同源代理：壳注入到 qoj.ac 页面的守护脚本经此领任务/回传 HTML（与 index.ts 同口径）
  app.use('/api/qoj-agent', qojAgentRoutes());
  app.use('/api/backups', backupsRoutes(db));
  app.use('/api/update', updateRoutes(config, () => createBackup(db, 'pre-upgrade')));
  // MCP 端点：外部 agent 经 http://127.0.0.1:<port>/mcp 操控本软件（工具层 = /api/* 回环代理，
  // 见 src/mcp/）。⚠ 与 index.ts（tsx dev）双入口同步——漏装则桌面版/Docker 上外部 agent 连不上
  app.use('/mcp', mcpRoutes());
  // widget 静态目录必须先注入再创建 router（express.static 创建时捕获目录值）
  setWidgetPublicDir(resolveWidgetDir());
  app.use('/widget', widgetRoutes());

  // 前端 SPA：静态资源 + BrowserRouter 刷新兜底。缓存头按「文件名是否带内容哈希」分流，
  // 见 spa-static.ts——assets/ 下 immutable 一年，index.html 必须 no-cache（升级后要拿到新入口）
  const distDir = resolveClientDist();
  if (distDir) {
    app.use(spaStaticRoutes(distDir));
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      time: new Date().toISOString(),
      platforms: PLATFORMS.map((p) => p.id),
      // 只回数据目录（About 页迁移/备份指引用），不回完整 db 文件路径：本端点无鉴权，
      // 绝对路径里的用户名/安装位置属于不必要的暴露面（优化计划 #78）
      dataDir: path.dirname(config.dbPath),
      version: APP_VERSION,
      sea: isSea(),
    });
  });

  // 全局错误中间件：必须放在所有路由之后
  app.use(errorHandler);

  const port = Number(process.env.PORT ?? config.port);
  return { app, port, config, db };
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
  // 开发模式：资源相对 server/ 根。用 SERVER_ROOT 而不是 import.meta.dirname ——
  // Docker 镜像里本文件被 bundle 到 server/dist/sea.cjs，模块目录与源码目录不再同级
  return fs.readFileSync(path.join(SERVER_ROOT, relPath), 'utf8');
}

/** SEA 模式下用户数据目录：默认 exe 旁 data/，macOS 上挪出应用包（见 data-dir.ts） */
function seaDataDir(): string {
  return resolveDataDir();
}

function loadConfigForRuntime(): AppConfig {
  if (!isSea()) return loadConfig();
  // SEA：config.json 只从 exe 旁读取（缺省时静默用默认值，不给双击用户弹警告）；
  // dbPath/dataDir 固定到用户数据目录
  const cfgPath = path.join(path.dirname(process.execPath), 'config.json');
  const cfg = existsSync(cfgPath) ? loadConfig(cfgPath) : { ...DEFAULT_CONFIG };
  const dataDir = seaDataDir();
  // 老 nightly 把数据写在了应用包内部：升级到本版时把旧数据搬出来一次
  migrateLegacyDataDir(process.execPath, dataDir);
  return { ...cfg, dataDir, dbPath: path.join(dataDir, 'icpc.db') };
}

let clientDistDir: string | null = null;

/** 前端 dist：SEA 时按 manifest 提取到临时目录；非 SEA（开发 / Docker）复用磁盘 client/dist */
function resolveClientDist(): string | null {
  if (clientDistDir) return clientDistDir;
  if (!isSea()) {
    // SERVER_ROOT 的上一级就是仓库根，client/dist 在它下面（Docker 里即 /app/client/dist）
    const devDist = path.join(SERVER_ROOT, '..', 'client', 'dist');
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

/** widget 静态目录：SEA 时提取内嵌 widget.html；非 SEA（开发 / Docker）用 server/src/public */
function resolveWidgetDir(): string {
  if (widgetDirCache) return widgetDirCache;
  if (!isSea()) {
    const dir = path.join(SERVER_ROOT, 'src', 'public');
    // Docker 镜像里 widget.html 由 Dockerfile 按源码布局拷入；缺失时不注入空目录，
    // 否则 express.static 静默 404，/widget 看起来「页面不存在」而非配置错误
    if (!existsSync(dir)) {
      console.warn(`[widget] 未找到 widget 静态目录: ${dir}（/widget 页面将不可用）`);
    }
    widgetDirCache = dir;
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

/**
 * SEA 每次启动把内嵌前端 / widget 解到 mkdtempSync 建的临时目录（进程内有缓存，每次启动各建一个），
 * 退出时清理，避免反复启动 / 升级在 %TEMP% 持续累积。安全起见只删本程序建的 icpc-web- / icpc-widget-
 * 前缀目录，绝不碰其它路径；'exit' 事件只跑同步代码，rmSync 正好同步。
 */
function cleanupSeaTempDirs(): void {
  for (const dir of [clientDistDir, widgetDirCache]) {
    if (!dir) continue;
    const base = path.basename(dir);
    if (!base.startsWith('icpc-web-') && !base.startsWith('icpc-widget-')) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败无关紧要：OS 临时目录最终会回收 */
    }
  }
}

// ---- 直接执行（tsx dev / Docker bundle / SEA bundle 顶层）时启动监听 ----
// SEA 面向双击运行的普通用户：自动开浏览器、端口冲突自动让位、报错不闪退。
// 非 SEA（Docker / tsx dev）：固定端口、失败即退出（容器 restart 策略接管重启）。

/**
 * 进程是否已进入「对外服务」状态。
 *
 * 启动期异常与运行期异常的处置不同：
 * - 启动期（serving=false）：配置错误 / 端口占用属于致命错误，必须让人看见并退出；
 * - 运行期（serving=true）：本应用是本地单用户工具，数据全在 SQLite，带伤运行
 *   优于崩溃重启（重启会打断正在写的同步/备份，且 Docker 下还多一次冷启动）。
 */
let serving = false;

/**
 * 进程级兜底：未捕获异常与未处理的 Promise 拒绝都不再沿用 Node 默认的「直接崩进程」。
 *
 * 为什么必须挂：Node 15+ 的 unhandledRejection 默认是 fatal；本应用里有大量
 * `void someAsync()` 形态的后台任务（同步调度器、备份、知识库重建、AI 流式请求），
 * 任何一处漏 catch 都会让整个服务进程消失——Docker 里表现为容器莫名重启，
 * 桌面版表现为窗口一闪。
 *
 * - 启动期（SEA）：交给 fatal（停留窗口 + 中文提示，双击用户才看得见）；
 * - 启动期（Docker/dev）：记日志后以非零码退出，交给容器 restart 策略；
 * - 运行期（两分支一致）：只写 stderr，不退出。
 */
function installProcessGuards(): void {
  process.on('uncaughtException', (e) => {
    reportRuntimeError('uncaughtException', e);
  });
  process.on('unhandledRejection', (reason) => {
    reportRuntimeError('unhandledRejection', reason);
  });
}

function reportRuntimeError(kind: string, e: unknown): void {
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(`[${kind}] ${detail}`);
  if (serving) {
    console.error(`[${kind}] 已忽略该异常，进程继续运行（数据在 SQLite，带伤运行优于崩溃重启）`);
    return;
  }
  if (isSea()) {
    void fatal(`程序出错：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  // 非 SEA 启动期失败：容器/开发环境没有交互窗口可停留，直接以非零码退出等重启
  console.error('[server] 启动期发生未捕获异常，进程退出');
  process.exit(1);
}

installProcessGuards();

if (isSea()) {
  process.on('exit', cleanupSeaTempDirs);
  try {
    // SEA 分支只绑回环（listenOn 硬编码），显式传入以免校验口径与实际绑定地址脱节
    const { app, config, db } = startServer('127.0.0.1');
    const desiredPort = Number(process.env.PORT ?? config.port);
    bootSea(app, config, db, desiredPort).catch((e: unknown) => {
      void fatal(errMessage(e));
    });
  } catch (e) {
    void fatal(errMessage(e));
  }
} else {
  // 默认只绑回环，维持「本地单用户应用不默认暴露局域网」的安全边界；
  // HOST 供容器部署显式覆盖（Docker 里必须绑 0.0.0.0，端口映射才对外可达）
  const host = process.env.HOST ?? '127.0.0.1';
  // 校验口径必须与实际绑定地址一致（绑 0.0.0.0 时不校验，见 hostGuard）
  const { app, port, db } = startServer(host);
  void bootServer(app, db, port, host);
}

/**
 * 非 SEA 启动：固定端口监听（不做端口漂移）。
 *
 * 容器部署下端口是映射目标的一部分，自动换端口会让 `-p 3080:3001` 指向一个没人监听的
 * 端口——容器看起来「起来了」但访问不通，比启动失败更难排查。所以这里端口冲突就
 * 明确报错退出，由部署者决定改 PORT 还是释放端口。
 */
async function bootServer(app: Express, db: Db, port: number, host: string): Promise<void> {
  let server: Server;
  try {
    server = await listenOn(app, port, host);
  } catch (e) {
    reportListenError(e, port);
    process.exit(1);
  }
  serving = true;
  // 运行期 server 错误（accept 失败、底层 socket 异常等）：记日志后继续跑。
  // 不挂这个监听，运行时 'error' 会抛成 uncaughtException（现已由进程级兜底接住，
  // 但那条路径没有端口上下文，排查时看不出是监听层出的问题）。
  server.on('error', (e) => {
    console.error(`[server] 监听层错误（进程继续运行）: ${errMessage(e)}`);
  });
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`[server] listening on http://${displayHost}:${port}`);
  console.log(`[server] widget page: http://localhost:${port}/widget`);
  installShutdown(server, db);
}

/** 监听失败的可读报错：容器里跑起来再报 "listen EADDRINUSE" 最难排查。 */
function reportListenError(e: unknown, port: number): void {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    console.error(
      `[server] 端口 ${port} 已被占用，无法启动。\n` +
        `[server] 容器部署：改用别的 PORT 或释放宿主机端口；本地运行：换端口启动（PORT=4100 npm start）。`,
    );
  } else if (code === 'EACCES') {
    console.error(
      `[server] 端口 ${port} 被系统保留，无法监听（Windows Hyper-V/winnat 动态保留区间，重启后可能变化）。\n` +
        `[server] 解法（任选其一）：\n` +
        `[server]   1. 管理员 PowerShell 执行: net stop winnat; net start winnat  （释放动态保留）\n` +
        `[server]   2. 换端口启动: PORT=4100 npm run dev  （前端代理需同步改 client/vite.config.ts）`,
    );
  } else {
    console.error(`[server] 监听端口 ${port} 失败: ${errMessage(e)}`);
  }
}

/**
 * 优雅退出：SIGTERM / SIGINT / SIGHUP（+ Windows 的 SIGBREAK）。
 *
 * - SIGTERM：`docker stop`、systemd、k8s 的默认停止信号；
 * - SIGINT：Ctrl+C（开发机前台运行）；
 * - SIGHUP：Linux 下是终端断开，**Windows 下是关闭控制台窗口**——桌面版用户点窗口
 *   右上角 × 就是这个信号；不监听它，默认行为是直接终止进程，WAL 可能停在半写状态；
 * - SIGBREAK：Windows 的 Ctrl+Break（Node 在 Windows 上独有）。
 *
 * 顺序：先停接新连接 → 等在途请求收尾 → 关 SQLite（checkpoint WAL）→ 退出。
 * SSE（/api/ai/chat）这类长连接不会自己结束，所以给两级超时兜底。
 */
function installShutdown(server: Server, db: Db): void {
  let shuttingDown = false;
  const finish = (code: number): void => {
    // 关库失败不阻塞退出：进程结束时 SQLite 仍会自行收尾，只是可能留下 -wal 残留
    try {
      db.close();
    } catch {
      /* 连接可能已被关闭 */
    }
    process.exit(code);
  };
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] 收到 ${signal}，正在优雅退出…`);
    server.close(() => finish(0));
    // 空闲的 keep-alive 连接立即释放，别让它们白等 5 秒
    server.closeIdleConnections();
    // SSE 等长连接 2 秒后强制断开，5 秒仍未退出则强制结束（docker stop 默认给 10 秒）
    setTimeout(() => server.closeAllConnections(), 2000).unref();
    setTimeout(() => {
      console.error('[server] 优雅退出超时，强制结束进程');
      finish(1);
    }, 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

// ---------- SEA 启动流程 ----------

/**
 * 双击 exe 的启动体验：
 * - 重复双击：检测到已运行的本程序实例 → 直接打开它的页面并退出
 * - 端口被其他程序占用：自动尝试后续端口
 * - 只监听 127.0.0.1，避免 Windows 首次运行弹出防火墙授权窗口
 * - 就绪后自动打开默认浏览器，并展示“勿关窗口”等中文提示
 */
async function bootSea(app: Express, config: AppConfig, db: Db, desiredPort: number): Promise<void> {
  // 探测范围必须与下面「端口漂移」的尝试范围一致：上一份实例可能因为默认端口被别的
  // 程序占着而落在 desiredPort+1..+19，只探默认端口会把「重复双击」误判成新实例。
  const runningPort = await findOurInstance(desiredPort);
  if (runningPort !== null) {
    console.log(`ICPC 备赛工作台已经在运行了（端口 ${runningPort}），正在为你打开页面…`);
    openBrowser(`http://localhost:${runningPort}`);
    await holdWindow(6000);
    try {
      db.close();
    } catch {
      /* 只是探测用的连接，关不掉也无妨 */
    }
    process.exit(0);
  }

  let port = desiredPort;
  let server: Server | null = null;
  for (let i = 0; i < SEA_PORT_ATTEMPTS; i++, port++) {
    try {
      server = await listenOn(app, port, '127.0.0.1');
      break;
    } catch (e) {
      // EADDRINUSE=被其他程序占用；EACCES=被 Windows winnat/Hyper-V 动态保留
      // （netsh excludedportrange，端口看似空闲却拒绝绑定）——都换下一个端口再试
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e;
    }
  }
  if (!server)
    throw new Error(
      `端口 ${desiredPort} 起连续 ${SEA_PORT_ATTEMPTS} 个端口均无法监听（被占用或被系统保留），无法启动。` +
        `若为 Windows，可尝试管理员 PowerShell 执行: net stop winnat; net start winnat 释放动态保留区间`,
    );

  server.on('error', (e) => {
    void fatal(`运行出错：${(e as Error).message}`);
  });
  if (port !== desiredPort) {
    console.log(`提示：默认端口 ${desiredPort} 被其他程序占用，已自动改用 ${port}。`);
  }
  serving = true;
  installShutdown(server, db);
  const url = `http://localhost:${port}`;
  console.log(banner(url, APP_VERSION));
  // 桌面壳（Tauri）拉起的嵌入模式：窗口由壳提供，不再抢占默认浏览器
  const embedded = process.env.ICPC_EMBEDDED === '1';
  if (!embedded) openBrowser(url);
  if (tryLaunchWidget(config, port)) {
    console.log(`[widget] 已自动拉起桌面挂件（关闭可在 config.json 设 launchWidget: false）`);
  }
}

/**
 * 在指定地址上监听；端口占用时以 EADDRINUSE reject，成功则返回已监听的 server。
 *
 * 成功路径必须摘掉 reject 监听：listen 之后的运行期错误由调用方另接 error 处理，
 * 残留的 reject 监听会让一次运行期错误变成「未处理的 rejection」（虽然已被进程级
 * 兜底接住，但错误信息会重复且丢失上下文）。
 */
function listenOn(app: Express, port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
    server.once('error', reject);
  });
}

/** SEA 的端口漂移上限：与 bootSea 的尝试次数保持一致 */
const SEA_PORT_ATTEMPTS = 20;

/**
 * 找已运行的本程序实例：探测 [desiredPort, desiredPort+20) 全部端口，返回命中的端口。
 *
 * 只探默认端口是不够的——上一份实例可能因默认端口被别的程序占着而漂移到 +1..+19，
 * 用户重复双击时会再起一个实例抢同一个数据库。反过来，从低位往高位扫还有额外好处：
 * 漂移总是从低位向上占用，最先命中的通常就是最早那份实例。
 */
async function findOurInstance(desiredPort: number): Promise<number | null> {
  for (let p = desiredPort; p < desiredPort + SEA_PORT_ATTEMPTS; p++) {
    if (p > 65535) break;
    if (await isOurInstance(p)) return p;
  }
  return null;
}

/** 判断某端口上是否已是本程序实例（health 探测）。 */
async function isOurInstance(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    return looksLikeOurInstance(await res.json());
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
