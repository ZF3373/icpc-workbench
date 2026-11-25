import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { listenForTest } from './test-listen.ts';
import * as middleware from '../src/middleware.ts';
import { createDb } from '../src/db/index.ts';
import { shellAuthRoutes } from '../src/routes/shellAuth.ts';

const createGuard = (middleware as unknown as { csrfGuard?: () => RequestHandler }).csrfGuard;

async function startApp(register?: (app: express.Express) => void): Promise<{ root: string; writes: () => number; close: () => Promise<void> }> {
  assert.ok(createGuard, '必须提供跨站写请求守卫');
  let writes = 0;
  const app = express();
  app.use(express.json());
  app.use(createGuard());
  app.post('/api/write', (_req, res) => {
    writes += 1;
    res.json({ ok: true });
  });
  app.get('/api/read', (_req, res) => res.json({ ok: true }));
  app.post('/api/qoj-agent/next', (_req, res) => res.json({ job: null }));
  register?.(app);
  const srv = await listenForTest(app);
  const root = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { root, writes: () => writes, close: () => new Promise<void>((resolve) => {
    srv.closeAllConnections();
    srv.close(() => resolve());
  }) };
}

test('csrfGuard 拒绝跨站 Origin 的写请求且不进入路由', async () => {
  const b = await startApp();
  try {
    const res = await fetch(`${b.root}/api/write`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 403);
    assert.equal(b.writes(), 0);
  } finally {
    await b.close();
  }
});

test('csrfGuard 按反向代理转发 Host 和协议校验同源写请求', async () => {
  const b = await startApp();
  try {
    const res = await fetch(`${b.root}/api/write`, {
      method: 'POST',
      headers: {
        Origin: 'https://workbench.example',
        'X-Forwarded-Host': 'workbench.example',
        'X-Forwarded-Proto': 'https',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.equal(b.writes(), 1);
  } finally {
    await b.close();
  }
});

test('csrfGuard 放行同源写请求和原生 JSON 请求', async () => {
  const b = await startApp();
  try {
    const sameOrigin = await fetch(`${b.root}/api/write`, {
      method: 'POST',
      headers: { Origin: b.root, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const native = await fetch(`${b.root}/api/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(native.status, 200);
    assert.equal(b.writes(), 2);
  } finally {
    await b.close();
  }
});

test('csrfGuard 拒绝无 Origin 的简单表单和 cross-site Fetch Metadata', async () => {
  const b = await startApp();
  try {
    const form = await fetch(`${b.root}/api/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    const crossSite = await fetch(`${b.root}/api/write`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(form.status, 403);
    assert.equal(crossSite.status, 403);
    assert.equal(b.writes(), 0);
  } finally {
    await b.close();
  }
});

test('csrfGuard 不拦截只读 GET，并允许 QOJ 路由自行校验跨源平台请求', async () => {
  const b = await startApp();
  try {
    assert.equal((await fetch(`${b.root}/api/read`)).status, 200);
    const agent = await fetch(`${b.root}/api/qoj-agent/next?platform=qoj`, {
      method: 'POST',
      headers: { Origin: 'https://qoj.ac', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(agent.status, 200);
  } finally {
    await b.close();
  }
});

test('csrfGuard 保护 shell-auth pending：跨站请求不能抢走登录动作', async () => {
  const db = createDb(':memory:');
  const b = await startApp((app) => {
    app.use('/api/settings/shell-auth', shellAuthRoutes(db));
  });
  try {
    const created = await fetch(`${b.root}/api/settings/shell-auth/request`, {
      method: 'POST',
      headers: { Origin: b.root, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', platform: 'qoj' }),
    });
    assert.equal(created.status, 200);

    const stolen = await fetch(`${b.root}/api/settings/shell-auth/pending`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(stolen.status, 403);

    const native = await fetch(`${b.root}/api/settings/shell-auth/pending`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(native.status, 200);
    const body = await native.json() as { request: { action: string } | null };
    assert.equal(body.request?.action, 'login');
  } finally {
    await b.close();
    db.close();
  }
});
