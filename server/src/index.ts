import express from 'express';
import { aiConfigFromDb, loadConfig } from './config.ts';
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
import { updateRoutes, APP_VERSION } from './routes/update.ts';
import { widgetRoutes } from './routes/widget.ts';
import { PLATFORMS } from '../../shared/src/index.ts';

const config = loadConfig();
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
app.use('/api/update', updateRoutes());
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

const port = Number(process.env.PORT ?? config.port);
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] widget page: http://localhost:${port}/widget`);
});
