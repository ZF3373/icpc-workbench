import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { aiConfigFromDb, saveAiConfig, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

export function settingsRoutes(db: Db, config: AppConfig): Router {
  const r = Router();

  // GET /api/settings → AI 配置 + 平台账号 + 适配器开关
  r.get('/', (_req, res) => {
    const ai = aiConfigFromDb(db, config);
    const accounts = db
      .prepare(
        'SELECT platform, handle, last_sync_at, enabled FROM platform_accounts WHERE user_id = ?',
      )
      .all(DEFAULT_USER_ID);
    const adapterEnabled: Record<string, boolean> = {};
    for (const p of PLATFORMS) {
      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(`adapter.${p.id}.enabled`) as { value: string } | undefined;
      adapterEnabled[p.id] = row?.value !== 'false';
    }
    res.json({ ai, accounts, adapterEnabled, platforms: PLATFORMS });
  });

  // POST /api/settings/ai  body: { enabled?, baseURL?, apiKey?, model? }
  r.post('/ai', (req, res) => {
    const b = req.body ?? {};
    saveAiConfig(db, config, {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      baseURL: typeof b.baseURL === 'string' ? b.baseURL : undefined,
      apiKey: typeof b.apiKey === 'string' ? b.apiKey : undefined,
      model: typeof b.model === 'string' ? b.model : undefined,
    });
    res.json(aiConfigFromDb(db, config));
  });

  // POST /api/settings/accounts  body: { platform, handle }
  r.post('/accounts', (req, res) => {
    const { platform, handle } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    if (typeof handle !== 'string' || handle.trim() === '') {
      return res.status(400).json({ error: 'handle 必填' });
    }
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, enabled)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(user_id, platform) DO UPDATE SET handle = excluded.handle, enabled = 1`,
    ).run(DEFAULT_USER_ID, platform, handle.trim());
    res.json({ ok: true });
  });

  // POST /api/settings/adapters  body: { platform, enabled }
  r.post('/adapters', (req, res) => {
    const { platform, enabled } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(`adapter.${platform}.enabled`, String(Boolean(enabled)));
    res.json({ ok: true });
  });

  return r;
}

function isPlatform(p: unknown): p is PlatformId {
  return typeof p === 'string' && PLATFORMS.some((x) => x.id === p);
}
