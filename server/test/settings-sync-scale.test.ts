/**
 * 拉取速度全局倍率（settings['sync.requestIntervalScale']）读写测试。
 *
 * 关键不变量：
 * 1. GET /api/settings 返回 requestIntervalScale（默认 1×）与各平台 1× 基准间隔 requestIntervalBase；
 * 2. POST /api/settings/sync 校验范围 [1,5]、允许小数、省略即保留已存值；
 * 3. 写入后实时下发到节流层（getRequestIntervalScale 同步变化），无需重启；
 * 4. 非法值（越界 / 非 number）一律 400 且不改动已存值。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import {
  DEFAULT_REQUEST_INTERVAL_SCALE,
  HOST_MIN_INTERVAL_MS,
  getRequestIntervalScale,
  hostOf,
  setRequestIntervalScale,
} from '../src/net/hostThrottle.ts';
import { PLATFORMS } from '../../shared/src/index.ts';

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
    setRequestIntervalScale(DEFAULT_REQUEST_INTERVAL_SCALE); // 不泄漏到其它用例
  }
}

interface SyncBody {
  sync: {
    maxSubmissions: number;
    requestIntervalScale: number;
    requestIntervalBase: Record<string, number>;
  };
}

/** POST /api/settings/sync 直接返回 readSyncSettings 的扁平结果（不像 GET 那样包一层 sync） */
interface SyncPostBody {
  maxSubmissions: number;
  requestIntervalScale: number;
}

function postSync(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET / 返回默认倍率 1× 与各平台 1× 基准间隔', async () => {
  await withServer(async (_db, base) => {
    const body = (await (await fetch(base)).json()) as SyncBody;
    assert.equal(body.sync.requestIntervalScale, 1);
    // 每个平台都有基准间隔，且等于节流表中该域名的安全下限
    for (const p of PLATFORMS) {
      const expected = HOST_MIN_INTERVAL_MS[hostOf(p.homepage)];
      assert.equal(typeof expected, 'number', `${p.id} 的 homepage 域名应在节流表中登记`);
      assert.equal(body.sync.requestIntervalBase[p.id], expected, `${p.id} 基准间隔应等于安全下限`);
      assert.ok(body.sync.requestIntervalBase[p.id]! >= 1500, `${p.id} 基准间隔应 ≥1.5s`);
    }
  });
});

test('POST /sync 保存倍率、落库并实时下发到节流层', async () => {
  await withServer(async (db, base) => {
    const res = await postSync(base, { maxSubmissions: 300, requestIntervalScale: 2.5 });
    assert.equal(res.status, 200);
    const body = (await res.json()) as SyncPostBody;
    assert.equal(body.requestIntervalScale, 2.5);
    assert.equal(getRequestIntervalScale(), 2.5, '写入后节流层倍率应同步生效');

    const stored = db
      .prepare("SELECT value FROM settings WHERE key = 'sync.requestIntervalScale'")
      .get() as { value: string };
    assert.equal(stored.value, '2.5');
  });
});

test('POST /sync 省略 requestIntervalScale 时保留已存值', async () => {
  await withServer(async (_db, base) => {
    await postSync(base, { maxSubmissions: 300, requestIntervalScale: 3 });
    // 只改 maxSubmissions，不带倍率字段
    const res = await postSync(base, { maxSubmissions: 500 });
    const body = (await res.json()) as SyncPostBody;
    assert.equal(body.requestIntervalScale, 3, '省略即保留，不应被重置成默认');
    assert.equal(body.maxSubmissions, 500);
  });
});

test('POST /sync 拒绝越界与非 number 倍率，且不改动已存值', async () => {
  await withServer(async (_db, base) => {
    await postSync(base, { maxSubmissions: 300, requestIntervalScale: 2 });
    for (const bad of [0.5, 0, 6, 5.1, '2', null, [], NaN]) {
      const res = await postSync(base, { maxSubmissions: 300, requestIntervalScale: bad });
      assert.equal(res.status, 400, `requestIntervalScale=${JSON.stringify(bad)} 应被拒绝`);
    }
    // 拒绝后仍是原值
    const after = (await (await fetch(base)).json()) as SyncBody;
    assert.equal(after.sync.requestIntervalScale, 2);
    assert.equal(getRequestIntervalScale(), 2, '非法请求不得改动节流层倍率');
  });
});
