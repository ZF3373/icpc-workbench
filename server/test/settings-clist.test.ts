import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { listenForTest } from './test-listen.ts';

/**
 * issue #57：clist.by 第三方难度备选源的凭据管理（GET 回显 / 保存 / 清除 / 连通性自检）。
 * 只断言 HTTP 契约，不真的访问 clist.by（fetch 由用例注入）。
 */

function appFor(db: Db, fetchFn: typeof fetch): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG, fetchFn));
  return app;
}

async function withApp(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/settings`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** clist.by 的 mock：默认成功；可换成 401/429 */
function mockClist(status = 200): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    if (status !== 200) return new Response('', { status });
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

test('clist 凭据：默认未配置；保存后只回打码值（原文不回传前端）', async () => {
  const db = createDb(':memory:');
  try {
    const mock = mockClist();
    await withApp(appFor(db, mock.fetchFn), async (base) => {
      const initial = (await (await fetch(base)).json()) as { clist: Record<string, unknown> };
      assert.deepEqual(initial.clist, { username: '', configured: false, keyMasked: '' });

      const saved = await postJson(base, '/clist', { username: 'alice', apiKey: 'super-secret-api-key' });
      assert.equal(saved.status, 200);
      const savedBody = (await saved.json()) as { ok: boolean; clist: Record<string, unknown> };
      assert.equal(savedBody.ok, true);
      assert.equal(savedBody.clist.configured, true);
      assert.equal(savedBody.clist.username, 'alice');
      assert.equal(savedBody.clist.keyMasked, 'supe••••••-key');
      assert.equal(JSON.stringify(savedBody).includes('super-secret-api-key'), false, 'Key 原文不得出现在响应里');

      // 空 apiKey = 保持已存值（与设置页其他密钥框同语义），而不是被清空
      await postJson(base, '/clist', { username: 'bob', apiKey: '   ' });
      const after = (await (await fetch(base)).json()) as { clist: Record<string, unknown> };
      assert.equal(after.clist.configured, true, '留空不该清除已存 Key');
      assert.equal(after.clist.username, 'bob');

      // 清除
      await postJson(base, '/clist', { clear: true });
      const cleared = (await (await fetch(base)).json()) as { clist: Record<string, unknown> };
      assert.deepEqual(cleared.clist, { username: '', configured: false, keyMasked: '' });
    });
  } finally {
    db.close();
  }
});

test('clist 凭据：超长字段 400 且不落库', async () => {
  const db = createDb(':memory:');
  try {
    const mock = mockClist();
    await withApp(appFor(db, mock.fetchFn), async (base) => {
      const res = await postJson(base, '/clist', { username: 'x'.repeat(101) });
      assert.equal(res.status, 400);
      const res2 = await postJson(base, '/clist', { apiKey: 'k'.repeat(201) });
      assert.equal(res2.status, 400);
      const body = (await (await fetch(base)).json()) as { clist: { configured: boolean } };
      assert.equal(body.clist.configured, false);
    });
  } finally {
    db.close();
  }
});

test('clist 连通性自检：未配置 400；成功/401/429 各自给出可执行说明', async () => {
  const db = createDb(':memory:');
  try {
    await withApp(appFor(db, mockClist().fetchFn), async (base) => {
      const notConfigured = await postJson(base, '/clist/test', {});
      assert.equal(notConfigured.status, 400);

      const ok = await postJson(base, '/clist/test', { username: 'alice', apiKey: 'k' });
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { ok: boolean }).ok, true);
    });

    await withApp(appFor(db, mockClist(401).fetchFn), async (base) => {
      const bad = (await (await postJson(base, '/clist/test', { username: 'alice', apiKey: 'k' })).json()) as {
        ok: boolean;
        message: string;
      };
      assert.equal(bad.ok, false);
      assert.match(bad.message, /认证失败/);
    });

    await withApp(appFor(db, mockClist(429).fetchFn), async (base) => {
      const limited = (await (await postJson(base, '/clist/test', { username: 'alice', apiKey: 'k' })).json()) as {
        ok: boolean;
        message: string;
      };
      assert.equal(limited.ok, false);
      assert.match(limited.message, /限流/);
    });
  } finally {
    db.close();
  }
});
