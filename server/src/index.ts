import express from 'express';
import type { Server } from 'node:http';
import { aiConfigFromDb, loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { initAdapters } from './adapters/index.ts';
import { asyncHandler } from './asyncHandler.ts';
import { errorHandler, securityHeaders } from './middleware.ts';
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
import { widgetRoutes } from './routes/widget.ts';
import { PLATFORMS } from '../../shared/src/index.ts';

const config = loadConfig();
const db = createDb(config.dbPath);
initAdapters(config.dataDir);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(securityHeaders);

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
