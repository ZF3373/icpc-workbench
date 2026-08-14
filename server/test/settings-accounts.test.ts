import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';

let db: Db;

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/settings`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

test('rebinding account to a new handle resets last_sync_at (forces full re-sync)', async () => {
  await withServer(async (db, base) => {
    // 模拟旧账号已同步成功过
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled)
       VALUES (?, 'codeforces', 'alice', ?, 1)`,
    ).run(DEFAULT_USER_ID, '2026-01-01T00:00:00.000Z');

    const res = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'bob' }),
    });
    assert.equal(res.status, 200);

    const acc = db
      .prepare("SELECT handle, last_sync_at FROM platform_accounts WHERE platform = 'codeforces'")
      .get() as { handle: string; last_sync_at: string | null };
    assert.equal(acc.handle, 'bob');
    assert.equal(acc.last_sync_at, null); // 重置 → 下次同步全量重拉并清空旧数据
  });
});

test('rebinding the same handle keeps last_sync_at (no forced re-sync)', async () => {
  await withServer(async (db, base) => {
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled)
       VALUES (?, 'codeforces', 'alice', ?, 1)`,
    ).run(DEFAULT_USER_ID, '2026-01-01T00:00:00.000Z');

    const res = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'alice' }),
    });
    assert.equal(res.status, 200);

    const acc = db
      .prepare("SELECT last_sync_at FROM platform_accounts WHERE platform = 'codeforces'")
      .get() as { last_sync_at: string | null };
    assert.equal(acc.last_sync_at, '2026-01-01T00:00:00.000Z'); // 增量起点保留
  });
});

test('first-time binding creates account with null last_sync_at', async () => {
  await withServer(async (db, base) => {
    const res = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'atcoder', handle: 'newbie' }),
    });
    assert.equal(res.status, 200);
    const acc = db
      .prepare("SELECT handle, last_sync_at FROM platform_accounts WHERE platform = 'atcoder'")
      .get() as { handle: string; last_sync_at: string | null };
    assert.equal(acc.handle, 'newbie');
    assert.equal(acc.last_sync_at, null);
  });
});

// ---------- Cookie 检测接口 ----------

import { register, getAdapter } from '../src/adapters/registry.ts';
import type { PlatformAdapter } from '../src/adapters/types.ts';

function fakeLuoguAdapter(
  checkAuth: PlatformAdapter['checkAuth'],
): PlatformAdapter {
  return {
    platform: 'luogu',
    async fetchUserSubmissions() {
      return [];
    },
    problemUrl: () => 'https://www.luogu.com.cn/problem/P1001',
    ...(checkAuth ? { checkAuth } : {}),
  };
}

test('POST /cookies/check uses body cookie when provided', async () => {
  const original = getAdapter('luogu');
  register(fakeLuoguAdapter(async (opts) => ({
    ok: opts.cookie === 'fresh',
    message: opts.cookie === 'fresh' ? 'Cookie 有效' : '过期',
  })));
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/cookies/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'luogu', cookie: 'fresh' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: 'Cookie 有效' });
  });
  if (original) register(original);
});

test('POST /cookies/check falls back to saved cookie in settings', async () => {
  const original = getAdapter('luogu');
  let seenCookie = '';
  register(
    fakeLuoguAdapter(async (opts) => {
      seenCookie = opts.cookie;
      return { ok: true, message: 'ok' };
    }),
  );
  await withServer(async (db, base) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('cookie.luogu', 'saved-cookie')").run();
    const res = await fetch(`${base}/cookies/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'luogu' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seenCookie, 'saved-cookie'); // 未传 cookie 时读已保存的
  });
  if (original) register(original);
});

test('POST /cookies/check reports missing cookie and unsupported platform', async () => {
  const original = getAdapter('luogu');
  register(fakeLuoguAdapter(async () => ({ ok: true, message: 'ok' })));
  await withServer(async (_db, base) => {
    const missing = await fetch(`${base}/cookies/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'luogu' }),
    });
    const body = (await missing.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, false);
    assert.match(body.message, /尚未填写/);

    // codeforces 无 checkAuth（公开 API 平台）→ 提示不支持（不报错）
    const cf = await fetch(`${base}/cookies/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', cookie: 'x' }),
    });
    const cfBody = (await cf.json()) as { ok: boolean; message: string };
    assert.equal(cf.status, 200);
    assert.match(cfBody.message, /无需登录|不支持/);
  });
  if (original) register(original);
});
