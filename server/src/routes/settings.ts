import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { aiConfigFromDb, saveAiConfig, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';

export function settingsRoutes(db: Db, config: AppConfig): Router {
  const r = Router();

  // GET /api/settings → AI 配置 + 平台账号 + 适配器开关 + Cookie 配置
  r.get('/', (_req, res) => {
    const ai = aiConfigFromDb(db, config);
    const accounts = db
      .prepare(
        'SELECT platform, handle, last_sync_at, enabled FROM platform_accounts WHERE user_id = ?',
      )
      .all(DEFAULT_USER_ID);
    const adapterEnabled: Record<string, boolean> = {};
    const cookies: Record<string, { cookie?: string; csrf?: string }> = {};
    for (const p of PLATFORMS) {
      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(`adapter.${p.id}.enabled`) as { value: string } | undefined;
      adapterEnabled[p.id] = row?.value !== 'false';
      const c = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(`cookie.${p.id}`) as { value: string } | undefined;
      const csrf = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(`csrf.${p.id}`) as { value: string } | undefined;
      if (c || csrf) {
        cookies[p.id] = {
          ...(c ? { cookie: c.value } : {}),
          ...(csrf ? { csrf: csrf.value } : {}),
        };
      }
    }
    res.json({ ai, accounts, adapterEnabled, platforms: PLATFORMS, cookies });
  });

  // POST /api/settings/cookies  body: { platform, cookie?, csrf? }（空串可清除）
  r.post('/cookies', (req, res) => {
    const { platform, cookie, csrf } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    if (typeof cookie === 'string') upsert.run(`cookie.${platform}`, cookie);
    if (typeof csrf === 'string') upsert.run(`csrf.${platform}`, csrf);
    res.json({ ok: true });
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
