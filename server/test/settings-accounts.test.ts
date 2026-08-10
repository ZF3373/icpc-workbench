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
