import express from 'express';
import path from 'node:path';
import type { Server } from 'node:http';
import { aiConfigFromDb, loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { applyPendingRestore, createBackup, maybeDailyBackup } from './backup.ts';
import { seedBuiltinBank } from './db/builtinBank.ts';
import { initAdapters } from './adapters/index.ts';
import { configureSyncScheduler } from './adapters/syncScheduler.ts';
import { setRequestIntervalScale } from './net/hostThrottle.ts';
import { asyncHandler } from './asyncHandler.ts';
import { errorHandler, securityHeaders } from './middleware.ts';
import { backupsRoutes } from './routes/backups.ts';
import { checkinsRoutes } from './routes/checkins.ts';
import { contestsRoutes } from './routes/contests.ts';
import { aiRoutes } from './routes/ai.ts';
import { exportRoutes } from './routes/export.ts';
import { historyRoutes } from './routes/history.ts';
import { importRoutes } from './routes/import.ts';
import { knowledgeRoutes } from './routes/knowledge.ts';
import { listsRoutes } from './routes/lists.ts';
import { plansRoutes } from './routes/plans.ts';
import { problemsRoutes } from './routes/problems.ts';
import { reviewsRoutes } from './routes/reviews.ts';
import { settingsRoutes } from './routes/settings.ts';
import { statsRoutes } from './routes/stats.ts';
import { syncRoutes } from './routes/sync.ts';
import { templatesRoutes } from './routes/templates.ts';
import { todayRoutes } from './routes/today.ts';
import { updateRoutes, APP_VERSION } from './routes/update.ts';
import { uploadsRoutes } from './routes/uploads.ts';
import { widgetRoutes } from './routes/widget.ts';
import { PLATFORMS } from '../../shared/src/index.ts';
import { initKnowledgeStore, loadAnnotationsIntoDb, purgeAiAnnotations } from './knowledge/store.ts';

const config = loadConfig();
// 恢复点回滚：必须在 createDb 之前应用（覆盖数据库文件）
applyPendingRestore(config.dbPath);
const db = createDb(config.dbPath);
seedBuiltinBank(db); // 内置题库播种：版本变化时 upsert 一次，日常启动零开销
initAdapters(config.dataDir);
// 后台分批续拉调度器：截断的同步按平台节奏自动续拉下一批（未装配则不排期，不影响手动同步）
configureSyncScheduler({ db });
// 拉取速度全局倍率：从设置恢复（缺失/越界 → setRequestIntervalScale 收敛为默认 1× = 安全下限）。
// 节流层每次请求实时读取该值，故此处一次下发即对整个进程生效，无需重启或重建节流单例。
const intervalScaleRow = db
  .prepare('SELECT value FROM settings WHERE key = ?')
  .get('sync.requestIntervalScale') as { value: string } | undefined;
setRequestIntervalScale(Number(intervalScaleRow?.value));
// 知识点存储目录（便宜：只记路径）；JSONL → SQLite 的重建在 listen 之后做，见文件末尾
initKnowledgeStore(config.dataDir);
// 每日首次启动自动备份（settings 键幂等）；失败不阻塞启动
// 放在 listen 之前：备份期间不接收请求，快照更干净（这一步很快，不含索引重建）
try {
  const daily = maybeDailyBackup(db);
  if (daily.created) console.log(`[backup] 已创建每日备份 ${daily.file}`);
} catch (e) {
  console.error(`[backup] 每日备份失败（不影响启动）: ${(e as Error).message}`);
}

const app = express();
// 12 MiB：/api/ai/chat 允许每条消息带 8 个附件、单个 textContent 上限 1 MiB（见 routes/ai.ts），
// 加上对话历史整封上行。原来 2mb 会让这种合法请求在进入路由前就被 body-parser 拒掉
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
// 笔记图片：上传与静态服务封装在同一 Router（GET 服务 /api/uploads/xxx，POST 上传）
app.use('/api/uploads', uploadsRoutes({ uploadsDir: path.join(config.dataDir, 'uploads') }));
app.use('/api/today', todayRoutes(db));
app.use('/api/templates', templatesRoutes(db, { dataDir: config.dataDir }));
app.use('/api/contests', contestsRoutes());
app.use('/api/checkins', checkinsRoutes(db));
app.use('/api/settings', settingsRoutes(db, config));
app.use('/api/backups', backupsRoutes(db));
app.use('/api/update', updateRoutes(config, () => createBackup(db, 'pre-upgrade')));
app.use('/widget', widgetRoutes());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    platforms: PLATFORMS.map((p) => p.id),
    dbPath: config.dbPath,
    version: APP_VERSION,
  });
});

// 全局错误中间件：必须放在所有路由之后
app.use(errorHandler);

const port = Number(process.env.PORT ?? config.port);
// 这是本地单用户应用：绝不默认暴露到局域网。若以后需要远程访问，应单独
// 设计认证和 TLS，而不是通过修改此处的默认行为绕过安全边界。
//
// ⚠ 顺序很重要：**先 listen，再做启动期初始化**（见文件末尾的知识点索引重建）。
// 端口绑定是同步的，而初始化的代码是同步阻塞的，所以"先 listen"只会把端口
// 提前打开，不会让请求读到未初始化的状态（请求要等事件循环空出来才会被处理）。
//
// 实测（node 直接跑本文件，PORT=4102）：端口可连接 1.57s / 首个 200 返回 1.67s，
// 其中索引重建只占约 0.1s —— 启动开销主要在进程引导（import + 打开 DB + 适配器），
// 不在重建。所以这里改的是"把失败窗口压到最小"，而不是消除那 1.5s 引导时间。
const server: Server = app.listen(port, '127.0.0.1', () => {
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] widget page: http://localhost:${port}/widget`);
});
server.on('error', (e: NodeJS.ErrnoException) => {
  // Windows 上 3000-3xxx 段可能被 Hyper-V/winnat 动态保留（重启后区间变化），
  // 绑定报 EACCES——给出可操作的解法，而不是一句 "listen EACCES" 让人无从下手。
  if (e.code === 'EACCES') {
    console.error(
      `[server] 端口 ${port} 被系统保留，无法监听（Windows Hyper-V/winnat 动态保留区间，重启后可能变化）。\n` +
        `[server] 解法（任选其一）：\n` +
        `[server]   1. 管理员 PowerShell 执行: net stop winnat; net start winnat  （释放动态保留）\n` +
        `[server]   2. 换端口启动: PORT=4100 npm run dev  （前端代理需同步改 client/vite.config.ts）`,
    );
  } else {
    console.error(`[server] 监听端口 ${port} 失败: ${e.message}`);
  }
  process.exit(1);
});

// 知识点管线：JSONL 源真相 → SQLite 索引幂等重建（无 JSONL 时零开销）。
// 放在 listen 之后：端口提前打开，这几百毫秒里的请求排队等初始化结束（不会连接失败）。
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
    console.log(`[knowledge] 已从 JSONL 重建索引: ${loaded.inserted} 条标注 / ${loaded.problems} 题（跳过未知 code ${loaded.skippedUnknownCode}）`);
  }
} catch (e) {
  console.error(`[knowledge] JSONL 索引重建失败（不影响启动）: ${(e as Error).message}`);
}

// Graceful shutdown：收到信号时关闭 HTTP 连接与数据库，避免 WAL 写入中途被强制终止
let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[server] shutting down…');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // 兜底：5 秒后仍未退出则强制退出
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
