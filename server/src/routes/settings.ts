import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { aiConfigFromDb, saveAiConfig, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { getAdapter } from '../adapters/registry.ts';

const DEFAULT_REMINDER_TIME = '20:00';

function readReminder(db: Db): { enabled: boolean; time: string } {
  const get = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
      ?.value;
  const time = get('reminder.time');
  return {
    enabled: get('reminder.enabled') === 'true',
    time: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : DEFAULT_REMINDER_TIME,
  };
}

const DEFAULT_CONTEST_REMINDER_MINUTES = 30;

export function readContestReminder(db: Db): { enabled: boolean; minutesBefore: number } {
  const get = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
      ?.value;
  const minutes = Number(get('contestReminder.minutesBefore'));
  return {
    enabled: get('contestReminder.enabled') === 'true',
    minutesBefore:
      Number.isInteger(minutes) && minutes >= 5 && minutes <= 120
        ? minutes
        : DEFAULT_CONTEST_REMINDER_MINUTES,
  };
}

export function settingsRoutes(db: Db, config: AppConfig): Router {
  const r = Router();

  // GET /api/settings → AI 配置 + 平台账号 + 适配器开关 + Cookie 配置 + 打卡提醒
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
    res.json({
      ai,
      accounts,
      adapterEnabled,
      platforms: PLATFORMS,
      cookies,
      reminder: readReminder(db),
      contestReminder: readContestReminder(db),
    });
  });

  // POST /api/settings/reminder  body: { enabled?, time? }  time 格式 HH:MM
  r.post('/reminder', (req, res) => {
    const { enabled, time } = req.body ?? {};
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled 需为布尔值' });
      }
      upsert.run('reminder.enabled', String(enabled));
    }
    if (time !== undefined) {
      if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
        return res.status(400).json({ error: 'time 格式需为 HH:MM（24 小时制）' });
      }
      upsert.run('reminder.time', time);
    }
    res.json(readReminder(db));
  });

  // POST /api/settings/contest-reminder  body: { enabled?, minutesBefore? }（5-120 分钟）
  r.post('/contest-reminder', (req, res) => {
    const { enabled, minutesBefore } = req.body ?? {};
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled 需为布尔值' });
      }
      upsert.run('contestReminder.enabled', String(enabled));
    }
    if (minutesBefore !== undefined) {
      const n = Number(minutesBefore);
      if (!Number.isInteger(n) || n < 5 || n > 120) {
        return res.status(400).json({ error: 'minutesBefore 需为 5-120 的整数分钟' });
      }
      upsert.run('contestReminder.minutesBefore', String(n));
    }
    res.json(readContestReminder(db));
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
    const remove = db.prepare('DELETE FROM settings WHERE key = ?');
    if (typeof cookie === 'string') {
      if (cookie === '') remove.run(`cookie.${platform}`);
      else upsert.run(`cookie.${platform}`, cookie);
    }
    if (typeof csrf === 'string') {
      if (csrf === '') remove.run(`csrf.${platform}`);
      else upsert.run(`csrf.${platform}`, csrf);
    }
    res.json({ ok: true });
  });

  // POST /api/settings/cookies/check  body: { platform, cookie?, csrf? }
  // 检测 Cookie 登录态；cookie 缺省时检测已保存的（适配器需实现 checkAuth，否则提示不支持）
  r.post('/cookies/check', asyncHandler(async (req, res) => {
    const { platform, cookie, csrf } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const adapter = getAdapter(platform);
    if (!adapter?.checkAuth) {
      return res.json({ ok: false, message: '该平台无需登录或暂不支持检测' });
    }
    const cookieVal =
      typeof cookie === 'string' && cookie.trim()
        ? cookie.trim()
        : (
            db.prepare('SELECT value FROM settings WHERE key = ?').get(`cookie.${platform}`) as
              | { value: string }
              | undefined
          )?.value;
    if (!cookieVal) {
      return res.json({ ok: false, message: '尚未填写 Cookie，请先填写并保存' });
    }
    const csrfVal =
      typeof csrf === 'string' && csrf.trim()
        ? csrf.trim()
        : (
            db.prepare('SELECT value FROM settings WHERE key = ?').get(`csrf.${platform}`) as
              | { value: string }
              | undefined
          )?.value;
    const result = await adapter.checkAuth({ cookie: cookieVal, ...(csrfVal ? { csrf: csrfVal } : {}) });
    res.json(result);
  }));

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
    // 换账号语义：handle 变化时重置 last_sync_at（NULL → 下次同步全量重拉并清空旧数据），
    // 否则保留增量起点（同 handle 重新绑定不破坏增量）。
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, enabled)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(user_id, platform) DO UPDATE SET
         handle = excluded.handle,
         enabled = 1,
         last_sync_at = CASE
           WHEN platform_accounts.handle = excluded.handle THEN platform_accounts.last_sync_at
           ELSE NULL
         END`,
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
