import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
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

test('GET / returns reminder defaults (disabled, 20:00)', async () => {
  await withServer(async (_db, base) => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { reminder: { enabled: boolean; time: string } };
    assert.deepEqual(body.reminder, { enabled: false, time: '20:00' });
  });
});

test('POST /reminder saves enabled and time, and returns the merged config', async () => {
  await withServer(async (db, base) => {
    const res = await fetch(`${base}/reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, time: '09:30' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: true, time: '09:30' });

    // 仅更新传入的字段：单独改时间不动开关
    const res2 = await fetch(`${base}/reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ time: '21:00' }),
    });
    assert.deepEqual(await res2.json(), { enabled: true, time: '21:00' });

    const stored = db
      .prepare("SELECT value FROM settings WHERE key = 'reminder.enabled'")
      .get() as { value: string };
    assert.equal(stored.value, 'true');
  });
});

test('POST /reminder rejects malformed time and non-boolean enabled', async () => {
  await withServer(async (_db, base) => {
    for (const bad of ['9:30', '24:00', '20-00', 'ab:cd', '20:60']) {
      const res = await fetch(`${base}/reminder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ time: bad }),
      });
      assert.equal(res.status, 400, `time=${bad} 应被拒绝`);
    }
    const res = await fetch(`${base}/reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(res.status, 400);
  });
});

test('contest reminder: defaults, save and validation', async () => {
  await withServer(async (_db, base) => {
    const res = await fetch(base);
    const body = (await res.json()) as { contestReminder: { enabled: boolean; minutesBefore: number } };
    assert.deepEqual(body.contestReminder, { enabled: false, minutesBefore: 30 });

    const saved = await fetch(`${base}/contest-reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, minutesBefore: 15 }),
    });
    assert.deepEqual(await saved.json(), { enabled: true, minutesBefore: 15 });

    // 仅更新开关不动分钟数
    const saved2 = await fetch(`${base}/contest-reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.deepEqual(await saved2.json(), { enabled: false, minutesBefore: 15 });

    // 非法值：非布尔开关 / 分钟越界
    const badEnabled = await fetch(`${base}/contest-reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 1 }),
    });
    assert.equal(badEnabled.status, 400);
    for (const bad of [4, 121, 30.5, 'x']) {
      const badRes = await fetch(`${base}/contest-reminder`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ minutesBefore: bad }),
      });
      assert.equal(badRes.status, 400, `minutesBefore=${bad} 应被拒绝`);
    }
  });
});
