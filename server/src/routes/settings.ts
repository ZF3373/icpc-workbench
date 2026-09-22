import { Router } from 'express';
import type { PlatformId } from '../../../shared/src/index.ts';
import {
  PLATFORMS,
  CREDENTIAL_UA_FIELDS,
  cookieFieldsOf,
  cookieOnlyFieldsOf,
  mergeCookieFields,
} from '../../../shared/src/index.ts';
import { aiConfigFromDb, saveAiConfig, type AiConfig, type AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { asyncHandler } from '../asyncHandler.ts';
import { getAdapter } from '../adapters/registry.ts';
import {
  DEFAULT_SYNC_MAX_SUBMISSIONS,
  MIN_SYNC_MAX_SUBMISSIONS,
  MAX_SYNC_MAX_SUBMISSIONS,
} from '../adapters/sync.ts';
import { getAutoContinueRounds } from '../adapters/syncScheduler.ts';
import {
  DEFAULT_HOST_MIN_INTERVAL_MS,
  DEFAULT_REQUEST_INTERVAL_SCALE,
  HOST_MIN_INTERVAL_MS,
  MAX_REQUEST_INTERVAL_SCALE,
  MIN_REQUEST_INTERVAL_SCALE,
  hostOf,
  intervalForHost,
  setRequestIntervalScale,
} from '../net/hostThrottle.ts';
import { chatUrl } from '../ai/provider.ts';

const DEFAULT_REMINDER_TIME = '20:00';

/**
 * 秘密打码用于回显：让用户能确认「已填的是哪个密钥」，但不把原文回传给渲染层。
 * <12 字符全遮（短值露头尾即泄露大半）；长值露前 4 后 4，中间固定 6 个点不泄露长度。
 */
export function maskSecret(s: unknown): string {
  const v = typeof s === 'string' ? s.trim() : '';
  if (!v) return '';
  if (v.length < 12) return '••••••••';
  return `${v.slice(0, 4)}••••••${v.slice(-4)}`;
}

/** Cookie 头逐对打码（name=value; ...），保留 name 便于前端按名回填各输入框；无 = 的裸值整体打码 */
function maskCookieHeader(raw: string): string {
  return raw
    .split(';')
    .map((pair) => {
      const p = pair.trim();
      if (!p) return '';
      const i = p.indexOf('=');
      if (i < 0) return maskSecret(p);
      return `${p.slice(0, i)}=${maskSecret(p.slice(i + 1))}`;
    })
    .filter(Boolean)
    .join('; ');
}

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

/** 续拉轮数上限取值域（0 = 关闭后台续拉）；读侧校验与写入校验共用这两个边界 */
const MIN_SYNC_AUTO_CONTINUE_ROUNDS = 0;
const MAX_SYNC_AUTO_CONTINUE_ROUNDS = 50;

/**
 * 读取分批同步设置：单次同步新增上限（防封号）+ 后台续拉轮数上限 + 计蒜客自由练题开关。
 * - maxSubmissions 越界回退默认值（**复用同步层的 `DEFAULT_SYNC_MAX_SUBMISSIONS`**：
 *   读侧曾自带一份 500 的副本，同步层调整默认值后这里会给出与真正执行同步不同的答案）；
 * - autoContinueRounds 直接复用调度器的 `getAutoContinueRounds`（同一个 key、同一套
 *   0–50 校验、同一个默认值）—— 读侧与真正执行续拉的调度器不可能给出不同答案；
 * - jisuankePracticeSync：`settings['jisuanke.practiceSync']` 非 'false' 即开启（键缺失 = 默认开启，
 *   口径与适配器 `readSetting('jisuanke.practiceSync') !== 'false'` 完全一致）。
 */
export function readSyncSettings(db: Db): {
  maxSubmissions: number;
  autoContinueRounds: number;
  jisuankePracticeSync: boolean;
  requestIntervalScale: number;
  requestIntervalBase: Record<string, number>;
} {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('sync.maxSubmissions') as { value: string } | undefined;
  const practice = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('jisuanke.practiceSync') as { value: string } | undefined;
  const scaleRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('sync.requestIntervalScale') as { value: string } | undefined;
  const n = Number(row?.value);
  const scale = Number(scaleRow?.value);
  return {
    maxSubmissions:
      Number.isInteger(n) && n >= MIN_SYNC_MAX_SUBMISSIONS && n <= MAX_SYNC_MAX_SUBMISSIONS
        ? n
        : DEFAULT_SYNC_MAX_SUBMISSIONS,
    autoContinueRounds: getAutoContinueRounds(db),
    jisuankePracticeSync: practice?.value !== 'false',
    // 拉取速度全局倍率：越界/缺失回退默认 1×（= 安全下限）。与节流层实际生效值同源同口径。
    requestIntervalScale:
      Number.isFinite(scale) &&
      scale >= MIN_REQUEST_INTERVAL_SCALE &&
      scale <= MAX_REQUEST_INTERVAL_SCALE
        ? scale
        : DEFAULT_REQUEST_INTERVAL_SCALE,
    // 各平台 1× 基准间隔（毫秒）：前端据此实时换算「当前倍率下每次请求间隔 = 基准 × 倍率」，
    // 拖动滑块即可看到每个平台的秒数，无需往返服务端。域名取自平台 homepage（与节流表键一致）。
    requestIntervalBase: Object.fromEntries(
      PLATFORMS.map((p) => [
        p.id,
        intervalForHost(hostOf(p.homepage), HOST_MIN_INTERVAL_MS, DEFAULT_HOST_MIN_INTERVAL_MS),
      ]),
    ),
  };
}

export function settingsRoutes(db: Db, config: AppConfig): Router {
  const r = Router();

  // GET /api/settings → AI 配置 + 平台账号 + 适配器开关 + Cookie 配置 + 打卡提醒
  r.get('/', (_req, res) => {
    const savedAi = aiConfigFromDb(db, config);
    // 秘密原文只用于服务端请求上游，不回传给 WebView/浏览器；只回传打码版供界面回显。
    const ai = {
      ...savedAi,
      apiKey: '',
      searchApiKey: '',
      apiKeyMasked: maskSecret(savedAi.apiKey),
      searchApiKeyMasked: maskSecret(savedAi.searchApiKey),
      hasApiKey: Boolean(savedAi.apiKey),
      hasSearchApiKey: Boolean(savedAi.searchApiKey),
    };
    const accounts = db
      .prepare(
        'SELECT platform, handle, last_sync_at, enabled FROM platform_accounts WHERE user_id = ?',
      )
      .all(DEFAULT_USER_ID);
    const adapterEnabled: Record<string, boolean> = {};
    const cookies: Record<string, { configured: boolean; masked?: string; hasUa?: boolean }> = {};
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
      // 「浏览器 UA」类配置项（QOJ）：即使只有 UA 也要让前端知道已配置，否则表单会误判为未配置
      const hasUa = CREDENTIAL_UA_FIELDS[p.id]
        ? Boolean(
            (db.prepare('SELECT value FROM settings WHERE key = ?').get(`ua.${p.id}`) as
              | { value: string }
              | undefined)?.value,
          )
        : false;
      if (c || csrf || hasUa) {
        cookies[p.id] = {
          configured: true,
          ...(c?.value ? { masked: maskCookieHeader(c.value) } : {}),
          ...(CREDENTIAL_UA_FIELDS[p.id] ? { hasUa } : {}),
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
      sync: readSyncSettings(db),
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

  // POST /api/settings/cookies  body: { platform, cookie?, csrf?, cookieFields? }
  // Cookie 为**整条替换**语义（cookie: '' 即清除）；
  // cookieFields 为**单字段合并**语义（{ 字段key: 新值 }，空串表示显式清空该项，未列出的字段保留已保存值），
  // 用来消除「只补填一项、另一项留空」时把另一项清空的缺陷（见 shared/src/index.ts COOKIE_FIELDS）。
  r.post('/cookies', (req, res) => {
    const { platform, cookie, csrf, cookieFields } = req.body ?? {};
    if (!isPlatform(platform)) {
      return res.status(400).json({ error: `platform 非法: ${String(platform)}` });
    }
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    const remove = db.prepare('DELETE FROM settings WHERE key = ?');
    const readSetting = (key: string): string | undefined =>
      (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const readCookie = (): string => readSetting(`cookie.${platform}`) ?? '';

    // 单字段合并：只动用户显式填写的字段（空串 = 显式清空该项，未列出的字段保留已保存值）
    if (cookieFields !== undefined) {
      if (typeof cookieFields !== 'object' || cookieFields === null || Array.isArray(cookieFields)) {
        return res.status(400).json({ error: 'cookieFields 需为对象 { 字段key: 新值 }' });
      }
      const defs = cookieFieldsOf(platform);
      if (defs.length === 0) {
        return res.status(400).json({ error: `${platform} 未定义字段化 Cookie 表单，请改用 cookie 整条提交` });
      }
      const patches: Record<string, string> = {};
      for (const [key, value] of Object.entries(cookieFields as Record<string, unknown>)) {
        const def = defs.find((d) => d.key === key);
        if (!def) return res.status(400).json({ error: `未知 Cookie 字段: ${key}` });
        if (typeof value !== 'string') return res.status(400).json({ error: `Cookie 字段 ${key} 需为字符串` });
        // configOnly 字段（如 QOJ 的浏览器 UA）不进 Cookie 头，单独存 ua.<platform>
        if (def.configOnly) {
          if (value.trim() === '') remove.run(`ua.${platform}`);
          else upsert.run(`ua.${platform}`, value.trim());
          continue;
        }
        patches[key] = value;
      }
      const merged = mergeCookieFields(readCookie(), cookieOnlyFieldsOf(platform), patches);
      if (merged === '') remove.run(`cookie.${platform}`);
      else upsert.run(`cookie.${platform}`, merged);
    }

    if (typeof cookie === 'string') {
      if (cookie === '') remove.run(`cookie.${platform}`);
      else upsert.run(`cookie.${platform}`, cookie);
    }
    if (typeof csrf === 'string') {
      if (csrf === '') remove.run(`csrf.${platform}`);
      else upsert.run(`csrf.${platform}`, csrf);
    }
    // 回传合并后的字段构成（只含 Cookie 名与 UA 是否已配，不回传值），便于前端/用户确认。
    // 注意：必须从**实际保存的头**里提取名字，而不是只看字段定义——QOJ 的 raw「完整 Cookie」
    // 一项就携带 cf_clearance 与 UOJSESSID 等多个名字，只看定义会漏报（表现为界面提示缺项）。
    const saved = readCookie();
    const fields = [...saved.matchAll(/(?:^|;)\s*([A-Za-z0-9_.\-]+)=/g)].map((m) => m[1]);
    const uaKey = CREDENTIAL_UA_FIELDS[platform];
    res.json({
      ok: true,
      fields,
      configured: saved !== '',
      ...(uaKey ? { hasUa: Boolean(readSetting(`ua.${platform}`)) } : {}),
    });
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
    // 检测应与同步走同一数据页：带上已绑定账号的 handle（如代码源 Hydro 需按"自己的记录"访问）
    const account = db
      .prepare('SELECT handle FROM platform_accounts WHERE user_id = ? AND platform = ?')
      .get(DEFAULT_USER_ID, platform) as { handle: string } | undefined;
    // 复刻浏览器 UA（QOJ 等 cf_clearance 绑定 UA 的平台需要）：与同步层同一来源
    const uaVal = (
      db.prepare('SELECT value FROM settings WHERE key = ?').get(`ua.${platform}`) as
        | { value: string }
        | undefined
    )?.value;
    const result = await adapter.checkAuth({
      cookie: cookieVal,
      ...(csrfVal ? { csrf: csrfVal } : {}),
      ...(account ? { handle: account.handle } : {}),
      ...(uaVal ? { ua: uaVal } : {}),
    });
    res.json(result);
  }));

  // POST /api/settings/ai  body: { enabled?, baseURL?, apiKey?, model?, timeoutMs?, maxTokens?, contextWindow?, searchEngine?, searchApiKey? }
  r.post('/ai', (req, res) => {
    const b = req.body ?? {};
    saveAiConfig(db, config, {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      baseURL: typeof b.baseURL === 'string' ? b.baseURL : undefined,
      apiKey: typeof b.apiKey === 'string' ? b.apiKey : undefined,
      model: typeof b.model === 'string' ? b.model : undefined,
      ...(typeof b.timeoutMs === 'number' && b.timeoutMs > 0 ? { timeoutMs: b.timeoutMs } : {}),
      ...(typeof b.maxTokens === 'number' && b.maxTokens > 0 ? { maxTokens: b.maxTokens } : {}),
      ...(typeof b.contextWindow === 'number' && b.contextWindow > 0 ? { contextWindow: b.contextWindow } : {}),
      ...(b.searchEngine === 'tavily' || b.searchEngine === 'brave' ? { searchEngine: b.searchEngine } : {}),
      ...(typeof b.searchApiKey === 'string' ? { searchApiKey: b.searchApiKey } : {}),
    });
    // 与 GET 一致：保存后的响应同样不回传秘密原文，只回传打码版。
    const saved = aiConfigFromDb(db, config);
    res.json({
      ...saved,
      apiKey: '',
      searchApiKey: '',
      apiKeyMasked: maskSecret(saved.apiKey),
      searchApiKeyMasked: maskSecret(saved.searchApiKey),
      hasApiKey: Boolean(saved.apiKey),
      hasSearchApiKey: Boolean(saved.searchApiKey),
    });
  });

  // POST /api/settings/ai/test  body: { baseURL?, apiKey?, model? }
  // 连接测试：body 值优先（支持先测后存），缺省回退已保存配置。首选免费快速的 GET /models；
  // 部分兼容网关不实现该端点 → 退化用 1 token 的 chat/completions 真实验证。
  r.post('/ai/test', asyncHandler(async (req, res) => {
    const cfg = effectiveAiConfig(db, config, req.body ?? {});
    if (!/^https?:\/\//.test(cfg.baseURL)) {
      return res.json({ ok: false, message: `Base URL 需为 http(s) 地址，当前：${cfg.baseURL || '（空）'}` });
    }
    const started = Date.now();
    let models: string[] = [];
    try {
      models = await fetchModelIds(cfg.baseURL, cfg.apiKey);
    } catch (modelsErr) {
      try {
        await probeChat(cfg);
        const ms = Date.now() - started;
        return res.json({
          ok: true,
          message: `连接成功（${ms}ms，经 chat/completions 验证；该服务未提供 /models 列表）`,
          models: [],
        });
      } catch (chatErr) {
        return res.json({ ok: false, message: `连接失败：${(chatErr as Error).message}` });
      }
    }
    const ms = Date.now() - started;
    const modelNote = cfg.model
      ? models.includes(cfg.model)
        ? `；模型 ${cfg.model} 在可用列表中 ✓`
        : `；⚠ 模型 ${cfg.model} 不在列表中（部分网关列表不全，以实际调用为准）`
      : '';
    return res.json({
      ok: true,
      message: `连接成功（${ms}ms，/models 返回 ${models.length} 个模型）${modelNote}`,
      models,
    });
  }));

  // POST /api/settings/ai/models  body: { baseURL?, apiKey? }
  // 一键获取可用模型列表（OpenAI GET /models，兼容 data[].id / models[].name 等变体）
  r.post('/ai/models', asyncHandler(async (req, res) => {
    const cfg = effectiveAiConfig(db, config, req.body ?? {});
    if (!/^https?:\/\//.test(cfg.baseURL)) {
      return res.status(400).json({ error: `Base URL 需为 http(s) 地址，当前：${cfg.baseURL || '（空）'}` });
    }
    try {
      res.json({ models: await fetchModelIds(cfg.baseURL, cfg.apiKey) });
    } catch (e) {
      res.status(502).json({ error: `获取模型列表失败：${(e as Error).message}` });
    }
  }));

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

  // POST /api/settings/sync  body: { maxSubmissions, autoContinueRounds?, jisuankePracticeSync?, requestIntervalScale? }
  // maxSubmissions：100–1500（MIN/MAX_SYNC_MAX_SUBMISSIONS），单次同步新增上限，防封号。
  // autoContinueRounds：0–50 的**数字**，后台续拉轮数上限（0 = 关闭）；**省略即保留已存值**（前端只改
  // 一项时不会把另一项重置成默认）。jisuankePracticeSync：布尔，计蒜客「同步自由练题提交」开关
  // （落库为 settings['jisuanke.practiceSync'] 的 'true'/'false'；同样省略即保留已存值）。
  // requestIntervalScale：1–5 的**数值**（可带小数，如 1.5），拉取速度全局倍率（1 = 安全下限/最快）；
  // 同样省略即保留已存值。写入后实时下发到节流层（setRequestIntervalScale），无需重启。
  // 各项都先校验后写入：任一非法则整次请求不落库。
  r.post('/sync', (req, res) => {
    const { maxSubmissions, autoContinueRounds, jisuankePracticeSync, requestIntervalScale } =
      req.body ?? {};
    const n = Number(maxSubmissions);
    if (!Number.isInteger(n) || n < MIN_SYNC_MAX_SUBMISSIONS || n > MAX_SYNC_MAX_SUBMISSIONS) {
      return res
        .status(400)
        .json({ error: `maxSubmissions 需为 ${MIN_SYNC_MAX_SUBMISSIONS}–${MAX_SYNC_MAX_SUBMISSIONS} 的整数` });
    }
    let rounds: number | undefined;
    if (autoContinueRounds !== undefined) {
      // 必须严格要求 number 类型，不能用 Number(...) 强转：JSON null（「保持已存值」的自然写法）、
      // ''、false、[] 强转后都是 0，而 0 恰是本字段的合法值（关闭后台续拉）——于是「不传具体值」
      // 会被静默写成 '0' 把续拉关掉。类型不符即 400，已存值原样保留。
      if (
        typeof autoContinueRounds !== 'number' ||
        !Number.isInteger(autoContinueRounds) ||
        autoContinueRounds < MIN_SYNC_AUTO_CONTINUE_ROUNDS ||
        autoContinueRounds > MAX_SYNC_AUTO_CONTINUE_ROUNDS
      ) {
        return res.status(400).json({
          error: `autoContinueRounds 需为 ${MIN_SYNC_AUTO_CONTINUE_ROUNDS}–${MAX_SYNC_AUTO_CONTINUE_ROUNDS} 的整数（0 = 关闭后台续拉；省略该字段则保留已存值）`,
        });
      }
      rounds = autoContinueRounds;
    }
    if (jisuankePracticeSync !== undefined && typeof jisuankePracticeSync !== 'boolean') {
      return res.status(400).json({ error: 'jisuankePracticeSync 需为布尔值' });
    }
    // 倍率同样严格要求 number 类型：null/''/false 强转后是 0，而 0 低于安全下限 1×，
    // 不能让它被静默写成「比安全下限还快」。类型/范围不符即 400，已存值原样保留。
    let scale: number | undefined;
    if (requestIntervalScale !== undefined) {
      if (
        typeof requestIntervalScale !== 'number' ||
        !Number.isFinite(requestIntervalScale) ||
        requestIntervalScale < MIN_REQUEST_INTERVAL_SCALE ||
        requestIntervalScale > MAX_REQUEST_INTERVAL_SCALE
      ) {
        return res.status(400).json({
          error: `requestIntervalScale 需为 ${MIN_REQUEST_INTERVAL_SCALE}–${MAX_REQUEST_INTERVAL_SCALE} 的数值（1 = 安全下限/最快；省略该字段则保留已存值）`,
        });
      }
      scale = requestIntervalScale;
    }
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    upsert.run('sync.maxSubmissions', String(n));
    if (rounds !== undefined) upsert.run('sync.autoContinueRounds', String(rounds));
    if (typeof jisuankePracticeSync === 'boolean') {
      upsert.run('jisuanke.practiceSync', String(jisuankePracticeSync));
    }
    if (scale !== undefined) {
      upsert.run('sync.requestIntervalScale', String(scale));
      setRequestIntervalScale(scale); // 实时下发到全局节流层，下一次平台请求即按新间隔
    }
    res.json(readSyncSettings(db));
  });

  return r;
}

function isPlatform(p: unknown): p is PlatformId {
  return typeof p === 'string' && PLATFORMS.some((x) => x.id === p);
}

// ---------- AI 连接测试 / 模型列表 ----------

/** 组装待测配置：body 值优先（先测后存），缺省回退已保存配置（apiKey 与实际请求一致，含环境变量覆盖） */
function effectiveAiConfig(
  db: Db,
  config: AppConfig,
  b: { baseURL?: unknown; apiKey?: unknown; model?: unknown },
): AiConfig {
  const saved = aiConfigFromDb(db, config);
  const pick = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
  return {
    enabled: saved.enabled,
    baseURL: pick(b.baseURL, saved.baseURL),
    apiKey: pick(b.apiKey, saved.apiKey),
    model: pick(b.model, saved.model),
  };
}

/** baseURL → /models 地址：容忍用户把完整 chat/completions 端点粘进 baseURL（同 provider.chatUrl 惯例） */
function modelsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  const root = trimmed.endsWith('/chat/completions')
    ? trimmed.slice(0, -'/chat/completions'.length)
    : trimmed;
  return `${root}/models`;
}

/** 拉取并解析模型列表：OpenAI { data: [{ id }] }，兼容 { models: [{ name|id }] } 与纯数组，去重排序 */
async function fetchModelIds(baseURL: string, apiKey: string): Promise<string[]> {
  const res = await fetch(modelsUrl(baseURL), {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const payload: unknown = await res.json().catch(() => {
    throw new Error('响应不是合法 JSON');
  });
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data)
      : Array.isArray((payload as { models?: unknown })?.models)
        ? ((payload as { models: unknown[] }).models)
        : [];
  const ids = list
    .map((m) =>
      typeof m === 'string'
        ? m
        : ((m as { id?: unknown })?.id ?? (m as { name?: unknown })?.name),
    )
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim());
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** 兜底连通性探测：1 token 的 chat/completions（/models 不可用但对话可用的网关，如部分 one-api 部署） */
async function probeChat(cfg: AiConfig): Promise<void> {
  const res = await fetch(chatUrl(cfg.baseURL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      ...(cfg.model ? { model: cfg.model } : {}),
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
}
