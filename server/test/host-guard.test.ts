import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { hostGuard, hostnameOfHostHeader } from '../src/middleware.ts';

/**
 * Host 头校验回归测试。
 *
 * 背景：本应用全站零鉴权，边界全靠「默认只绑 127.0.0.1」。但浏览器里的恶意页面可以
 * 用 DNS rebinding 绕过——页面先由攻击者域名提供，随后该域名改解析到 127.0.0.1，
 * 于是脚本对 `http://攻击者域名:3001/...` 的请求在浏览器看来是「同源」，实际打到了
 * 本机服务。服务端不看 Host 就区分不出，任何读接口都能被读走。
 *
 * 注意：用 node:http 直发而非 fetch —— fetch 不允许自定义 Host 头。
 */
function rawGet(origin: string, path: string, hostHeader?: string): Promise<{ status: number; body: string }> {
  const u = new URL(path, origin);
  const options: http.RequestOptions = {
    host: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'GET',
  };
  if (hostHeader !== undefined) {
    options.headers = { Host: hostHeader };
    options.setHost = false; // 否则 Node 会用 URL 里的主机名覆盖我们伪造的 Host
  }
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withGuard(
  boundHost: string,
  extraHosts: string | undefined,
  fn: (origin: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(hostGuard(boundHost, extraHosts));
  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true });
  });
  const srv = await listenForTest(app);
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(origin);
  } finally {
    srv.close();
  }
}

test('hostnameOfHostHeader 去掉端口并保留 IPv6 方括号形式', () => {
  assert.equal(hostnameOfHostHeader('localhost:5173'), 'localhost');
  assert.equal(hostnameOfHostHeader('127.0.0.1:3001'), '127.0.0.1');
  assert.equal(hostnameOfHostHeader('[::1]:3001'), '[::1]');
  assert.equal(hostnameOfHostHeader('  Evil.Example  '), 'evil.example');
  assert.equal(hostnameOfHostHeader('LOCALHOST'), 'localhost');
});

test('绑定回环时拒绝伪造 Host（DNS rebinding 的核心防线）', async () => {
  await withGuard('127.0.0.1', undefined, async (origin) => {
    for (const host of ['evil.example', 'evil.example:3001', 'attacker.test:5173']) {
      const res = await rawGet(origin, '/api/ping', host);
      assert.equal(res.status, 403, `Host=${host} 应被拒绝`);
      assert.match(res.body, /DNS rebinding/);
    }
  });
});

test('绑定回环时放行回环主机名：直连、vite 代理（5173）、IPv6、无 Host', async () => {
  await withGuard('127.0.0.1', undefined, async (origin) => {
    // 直连后端
    assert.equal((await rawGet(origin, '/api/ping', '127.0.0.1:3001')).status, 200);
    // vite 代理会保留浏览器的原始 Host，端口是 5173 —— 按主机名放行才不会误伤开发环境
    assert.equal((await rawGet(origin, '/api/ping', 'localhost:5173')).status, 200);
    assert.equal((await rawGet(origin, '/api/ping', 'localhost')).status, 200);
    // IPv6 回环
    assert.equal((await rawGet(origin, '/api/ping', '[::1]:3001')).status, 200);
    // HTTP/1.0 客户端等不带 Host 的请求：不构成 rebinding 条件，放行
    assert.equal((await rawGet(origin, '/api/ping')).status, 200);
  });
});

test('显式绑到非回环地址时不校验 Host（Docker/反向代理场景不误伤）', async () => {
  await withGuard('0.0.0.0', undefined, async (origin) => {
    assert.equal((await rawGet(origin, '/api/ping', 'evil.example')).status, 200);
    assert.equal((await rawGet(origin, '/api/ping', 'oi.internal:8080')).status, 200);
  });
});

test('ICPC_ALLOWED_HOSTS 可追加放行主机名，且不放开其它域名', async () => {
  await withGuard('127.0.0.1', 'oi.example.com, oi.internal:8080', async (origin) => {
    assert.equal((await rawGet(origin, '/api/ping', 'oi.example.com')).status, 200);
    assert.equal((await rawGet(origin, '/api/ping', 'oi.internal:8080')).status, 200);
    assert.equal((await rawGet(origin, '/api/ping', 'evil.example')).status, 403);
  });
});
