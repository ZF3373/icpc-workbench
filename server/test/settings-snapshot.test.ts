import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG, aiConfigFromDb, readAiProviders, saveAiConfig, saveAiProviders } from '../src/config.ts';
import { readSettingsSnapshot } from '../src/db/settings.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';

/**
 * settings 整表快照的回归（优化计划 #8）。
 *
 * GET /api/settings 原先对每个 key 各 `prepare` 一次 `SELECT value FROM settings WHERE key = ?`：
 * 一个请求 15+ 次同名查询。改为请求内一次 `SELECT key, value` 建 Map。
 * 这里同时钉住两件事：
 * 1. 输出结构与值完全不变（含 AI 配置 DB 覆盖 config.json 的语义）；
 * 2. 读取路径不再逐 key 查询（回退修复会让计数断言失败）。
 */

function countingDb(db: Db): { db: Db; statements: string[]; runs: string[] } {
  const statements: string[] = [];
  const runs: string[] = [];
  const orig = db.prepare.bind(db);
  // 只记录 SQL 与执行次数，行为完全委托给原实现
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    statements.push(sql);
    const stmt = orig(sql) as {
      get?: (...args: unknown[]) => unknown;
      all?: (...args: unknown[]) => unknown;
    };
    for (const method of ['get', 'all'] as const) {
      const fn = stmt[method];
      if (typeof fn !== 'function') continue;
      (stmt as Record<string, unknown>)[method] = (...args: unknown[]) => {
        runs.push(sql);
        return fn.apply(stmt, args);
      };
    }
    return stmt;
  };
  return { db, statements, runs };
}

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  const raw = createDb(':memory:');
  const { db } = countingDb(raw);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/settings`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

/** 逐 key 查询语句：快照化之后读取路径上不应再出现（写路由里的即时读取另行断言） */
const PER_KEY_SQL = /SELECT value FROM settings WHERE key = \?/;

test('GET /settings 只做一次整表查询，不再逐 key prepare', async () => {
  const raw = createDb(':memory:');
  const { db, statements, runs } = countingDb(raw);
  try {
    // 造出尽可能多的读取点：每个平台的开关/Cookie/CSRF/UA、提醒、同步、AI 键
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const key of [
      'reminder.enabled',
      'reminder.time',
      'contestReminder.enabled',
      'contestReminder.minutesBefore',
      'sync.maxSubmissions',
      'sync.autoContinueRounds',
      'sync.requestIntervalScale',
      'jisuanke.practiceSync',
      'ai.enabled',
      'ai.providers',
      'ai.activeProvider',
      'ai.maxTokens',
      'ai.contextWindow',
      'ai.searchEngine',
      'adapter.codeforces.enabled',
      'cookie.codeforces',
      'csrf.codeforces',
      'ua.qoj',
      'accountCreds.luogu',
    ]) {
      upsert.run(key, 'x');
    }
    const app = express();
    app.use(express.json());
    app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG));
    const srv = await listenForTest(app);
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/settings`;
    try {
      statements.length = 0;
      runs.length = 0;
      const res = await fetch(base);
      assert.equal(res.status, 200);
      await res.json();

      // 逐 key 查询（prepare 或执行）都不该再出现：回退修复时这里会数到十几次
      const settingsSql = statements.filter((s) => s.includes('FROM settings'));
      const perKeyPrepared = settingsSql.filter((s) => PER_KEY_SQL.test(s));
      assert.equal(
        perKeyPrepared.length,
        0,
        `读取路径不应再 prepare 逐 key 查询，实际 ${perKeyPrepared.length} 次`,
      );
      const perKeyRuns = runs.filter((s) => PER_KEY_SQL.test(s));
      assert.equal(perKeyRuns.length, 0, `读取路径不应再执行逐 key 查询，实际 ${perKeyRuns.length} 次`);
      const wholeTable = settingsSql.filter((s) => /SELECT key, value FROM settings/i.test(s));
      assert.equal(wholeTable.length, 1, `整表快照应恰好一次，实际 ${wholeTable.length} 次`);
    } finally {
      srv.close();
    }
  } finally {
    raw.close();
  }
});

test('GET /settings 输出结构与各字段值保持不变（含打码与默认值）', async () => {
  await withServer(async (db, base) => {
    saveAiConfig(db, DEFAULT_CONFIG, {
      apiKey: 'ai-secret-key-1234',
      searchApiKey: 'tvly-SECRET-5678',
      timeoutMs: 90000,
      maxTokens: 4096,
      contextWindow: 8192,
    });
    saveAiProviders(
      db,
      [
        { id: 'p1', name: 'P1', baseURL: 'https://p1.example/v1', apiKey: 'key-1234567890ab', model: 'm1' },
        { id: 'p2', name: 'P2', baseURL: 'https://p2.example/v1', apiKey: 'provider-key-abcdefgh', model: 'm2' },
      ],
      'p2',
    );
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    upsert.run('adapter.codeforces.enabled', 'false');
    upsert.run('cookie.luogu', '_uid=UID123; __client_id=CLIENT');
    upsert.run('csrf.nowcoder', 'csrf-token');
    upsert.run('ua.qoj', 'Mozilla/5.0 TestBrowser');
    upsert.run('reminder.enabled', 'true');
    upsert.run('reminder.time', '07:05');
    upsert.run('contestReminder.enabled', 'true');
    upsert.run('contestReminder.minutesBefore', '45');
    upsert.run('sync.maxSubmissions', '800');
    upsert.run('sync.autoContinueRounds', '4');
    upsert.run('sync.requestIntervalScale', '2.5');
    upsert.run('jisuanke.practiceSync', 'false');
    upsert.run(
      'accountCreds.luogu',
      JSON.stringify({ alice: { cookie: '_uid=ALICE_UID_LONG; __client_id=ALICE_CLIENT' } }),
    );
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled)
       VALUES (?, 'codeforces', 'alice', '2026-01-01T00:00:00.000Z', 1)`,
    ).run(DEFAULT_USER_ID);

    const res = await fetch(base);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;

    assert.deepEqual(Object.keys(body).sort(), [
      'accountCreds',
      'accounts',
      'adapterEnabled',
      'ai',
      'clist',
      'contestReminder',
      'cookies',
      'platforms',
      'reminder',
      'sync',
    ]);

    // 账号 / 开关
    assert.deepEqual(body.accounts, [
      { platform: 'codeforces', handle: 'alice', last_sync_at: '2026-01-01T00:00:00.000Z', enabled: 1 },
    ]);
    assert.equal(body.adapterEnabled.codeforces, false);
    assert.equal(body.adapterEnabled.atcoder, true, '未配置的平台默认开启');

    // Cookie：键名保留、值打码；csrf 单独配置也算已配置
    assert.deepEqual(body.cookies.luogu, {
      configured: true,
      masked: '_uid=••••••••; __client_id=••••••••',
    });
    // 第三方难度备选源（issue #57）：未配置 → 空视图；配置后原文不下发前端，只给打码值
    assert.deepEqual(body.clist, { username: '', configured: false, keyMasked: '' });
    assert.deepEqual(body.cookies.nowcoder, { configured: true });
    assert.deepEqual(body.cookies.qoj, { configured: true, hasUa: true });
    assert.deepEqual(body.accountCreds, {
      luogu: {
        alice: { configured: true, masked: '_uid=ALIC••••••LONG; __client_id=ALIC••••••IENT' },
      },
    });

    // 提醒 / 同步
    assert.deepEqual(body.reminder, { enabled: true, time: '07:05' });
    assert.deepEqual(body.contestReminder, { enabled: true, minutesBefore: 45 });
    assert.equal(body.sync.maxSubmissions, 800);
    assert.equal(body.sync.autoContinueRounds, 4);
    assert.equal(body.sync.requestIntervalScale, 2.5);
    assert.equal(body.sync.jisuankePracticeSync, false);

    // AI：秘密不回传原文，只回打码版；活跃提供商与参数档位按既有回退链解析
    assert.equal(body.ai.apiKey, '');
    assert.equal(body.ai.searchApiKey, '');
    assert.equal(body.ai.hasApiKey, true);
    assert.equal(body.ai.apiKeyMasked, 'prov••••••efgh');
    assert.equal(body.ai.apiKeyFromEnv, Boolean((process.env.AI_API_KEY ?? '').trim()));
    assert.equal(body.ai.activeProviderId, 'p2');
    assert.equal(body.ai.baseURL, 'https://p2.example/v1');
    assert.equal(body.ai.model, 'm2');
    assert.equal(body.ai.enabled, false);
    assert.equal(body.ai.timeoutMs, 90000);
    assert.equal(body.ai.maxTokens, 4096);
    assert.equal(body.ai.contextWindow, 8192);
    assert.deepEqual(
      body.ai.providers.map((p: { id: string }) => p.id),
      ['p1', 'p2'],
    );
    assert.equal(body.ai.providers[0].hasApiKey, true);
    assert.equal(body.ai.providers[1].hasApiKey, true);
    assert.equal(body.ai.apiKeyMasked, 'prov••••••efgh', '打码取活跃提供商（p2）的密钥');
  });
});

test('settings 快照不跨请求缓存：保存后的值在下一次 GET 立刻可见', async () => {
  await withServer(async (db, base) => {
    const first = await fetch(base);
    assert.equal(((await first.json()) as { reminder: { time: string } }).reminder.time, '20:00');

    const save = await fetch(`${base}/reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, time: '06:30' }),
    });
    assert.equal(save.status, 200);
    assert.deepEqual(await save.json(), { enabled: true, time: '06:30' });

    const second = await fetch(base);
    assert.deepEqual(((await second.json()) as { reminder: unknown }).reminder, {
      enabled: true,
      time: '06:30',
    });
  });
});

test('快照读取保持 config.json 兜底 + DB 覆盖的语义', () => {
  const db = createDb(':memory:');
  try {
    // 空库：全部落 config.json
    const base = aiConfigFromDb(db, DEFAULT_CONFIG);
    assert.equal(base.enabled, DEFAULT_CONFIG.ai.enabled);
    assert.equal(base.baseURL, DEFAULT_CONFIG.ai.baseURL);
    assert.equal(base.model, DEFAULT_CONFIG.ai.model);
    assert.equal(base.timeoutMs, DEFAULT_CONFIG.ai.timeoutMs);
    assert.equal(base.maxTokens, DEFAULT_CONFIG.ai.maxTokens);
    assert.equal(base.contextWindow, DEFAULT_CONFIG.ai.contextWindow);

    saveAiConfig(db, DEFAULT_CONFIG, {
      enabled: true,
      timeoutMs: 45000,
      maxTokens: 1234,
      contextWindow: 5678,
      searchEngine: 'brave',
    });
    const snapshot = readSettingsSnapshot(db);
    const read = (key: string) => snapshot.get(key);
    const overridden = aiConfigFromDb(db, DEFAULT_CONFIG, read);
    assert.equal(overridden.enabled, true, 'DB 值覆盖 config.json');
    assert.equal(overridden.timeoutMs, 45000);
    assert.equal(overridden.maxTokens, 1234);
    assert.equal(overridden.contextWindow, 5678);
    assert.equal(overridden.searchEngine, 'brave');
    // 快照读取与即时读取必须给出完全相同的聚合结果
    assert.deepEqual(overridden, aiConfigFromDb(db, DEFAULT_CONFIG));
    assert.deepEqual(readAiProviders(db, DEFAULT_CONFIG, read), readAiProviders(db, DEFAULT_CONFIG));
  } finally {
    db.close();
  }
});
