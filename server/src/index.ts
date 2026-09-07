import express from 'express';
import type { Server } from 'node:http';
import { aiConfigFromDb, loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { seedBuiltinBank } from './db/builtinBank.ts';
import { initAdapters } from './adapters/index.ts';
import { asyncHandler } from './asyncHandler.ts';
import { errorHandler, securityHeaders } from './middleware.ts';
import { checkinsRoutes } from './routes/checkins.ts';
import { contestsRoutes } from './routes/contests.ts';
import { aiRoutes } from './routes/ai.ts';
import { exportRoutes } from './routes/export.ts';
import { importRoutes } from './routes/import.ts';
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
import { widgetRoutes } from './routes/widget.ts';
import { PLATFORMS } from '../../shared/src/index.ts';

const config = loadConfig();
const db = createDb(config.dbPath);
seedBuiltinBank(db); // 内置题库播种：版本变化时 upsert 一次，日常启动零开销
initAdapters(config.dataDir);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(securityHeaders);

app.use('/api/import', importRoutes(db));
app.use('/api/sync', syncRoutes(db));
app.use('/api/stats', statsRoutes(db));
app.use('/api/plans', plansRoutes(db, () => aiConfigFromDb(db, config)));
app.use('/api/ai', aiRoutes(db, () => aiConfigFromDb(db, config)));
app.use('/api/lists', listsRoutes(db, () => aiConfigFromDb(db, config)));
app.use('/api/export', exportRoutes(db));
app.use('/api/problems', problemsRoutes(db));
app.use('/api/reviews', reviewsRoutes(db));
app.use('/api/today', todayRoutes(db));
app.use('/api/templates', templatesRoutes(db));
app.use('/api/contests', contestsRoutes());
app.use('/api/checkins', checkinsRoutes(db));
app.use('/api/settings', settingsRoutes(db, config));
app.use('/api/update', updateRoutes(config));
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
const server: Server = app.listen(port, () => {
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
