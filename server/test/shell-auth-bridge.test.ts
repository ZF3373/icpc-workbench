import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createDb, type Db } from '../src/db/index.ts';
import { shellAuthRoutes } from '../src/routes/shellAuth.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';

/** 起一个挂壳凭据桥的独立服务（桥只需要 db 做账号绑定校验，内存状态各自独立） */
async function startBridge(): Promise<{ url: string; close: () => Promise<void> }> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/settings/shell-auth', shellAuthRoutes(db));
  const srv: Server = await listenForTest(app);
  const { port } = srv.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/settings/shell-auth`, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function bind(db: Db, platform: string, handle: string): void {
  db.prepare(
    'INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (?, ?, ?, 1)',
  ).run(DEFAULT_USER_ID, platform, handle);
}

test('shell-auth 桥：request → pending（pop 语义）→ 空轮询', async () => {
  const b = await startBridge();
  try {
    // 非法 action / 非凭据平台 / 非绑定的 handle 一律拒绝
    for (const body of [
      { action: 'hack' },
      { action: 'login', platform: 'codeforces' }, // 纯公开 API 平台没有登录窗
      { action: 'login', platform: 'qoj', handle: '   ' }, // 显式空串
      { action: 'pull', platform: 'luogu' }, // 续签仅 QOJ
    ]) {
      const bad = await fetch(`${b.url}/request`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      assert.equal(bad.status, 400, `body=${JSON.stringify(body)}`);
    }
    // 未绑定的 handle 是 404（不是 400）：资源存在性语义
    const missing = await fetch(`${b.url}/request`, { method: 'POST', body: JSON.stringify({ action: 'login', platform: 'qoj', handle: 'nobody' }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(missing.status, 404);

    // 无请求时 pending 为 null（壳空轮询的主路径）
    let res = await (await fetch(`${b.url}/pending`)).json() as { request: unknown };
    assert.equal(res.request, null);

    // 请求后第一次 GET 取走（pop），第二次 GET 为空——同一请求不会被壳执行两次。
    // platform 缺省 = qoj；未绑定的 handle 在上面已验证为 404，正路径见下一个用例
    let res2 = await (await fetch(`${b.url}/request`, { method: 'POST', body: JSON.stringify({ action: 'login' }), headers: { 'Content-Type': 'application/json' } })).json() as { ok: boolean; id: number };
    assert.equal(res2.ok, true);
    res = await (await fetch(`${b.url}/pending`)).json();
    assert.deepEqual(res.request, { id: res2.id, action: 'login', platform: 'qoj' });
    res = await (await fetch(`${b.url}/pending`)).json();
    assert.equal(res.request, null);
  } finally {
    await b.close();
  }
});

test('shell-auth 桥：绑定账号后带 handle 的请求可取走，缺省 platform=qoj', async () => {
  const app = express();
  app.use(express.json());
  const db = createDb(':memory:');
  bind(db, 'luogu', '1892580');
  app.use('/api/settings/shell-auth', shellAuthRoutes(db));
  const srv: Server = await listenForTest(app);
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/settings/shell-auth`;
  try {
    const post = await (await fetch(`${url}/request`, { method: 'POST', body: JSON.stringify({ action: 'login', platform: 'luogu', handle: '1892580' }), headers: { 'Content-Type': 'application/json' } })).json() as { ok: boolean; id: number };
    assert.equal(post.ok, true);
    let res = await (await fetch(`${url}/pending`)).json() as { request: { id: number; action: string; platform: string; handle?: string } | null };
    assert.deepEqual(res.request, { id: post.id, action: 'login', platform: 'luogu', handle: '1892580' });
    res = await (await fetch(`${url}/pending`)).json();
    assert.equal(res.request, null);

    // platform 缺省 = qoj（无 handle）：老客户端/壳兼容
    const post2 = await (await fetch(`${url}/request`, { method: 'POST', body: JSON.stringify({ action: 'login' }), headers: { 'Content-Type': 'application/json' } })).json() as { ok: boolean; id: number };
    res = await (await fetch(`${url}/pending`)).json();
    assert.deepEqual(res.request, { id: post2.id, action: 'login', platform: 'qoj' });
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('shell-auth 桥：status 心跳驱动 shell 在线判定，login 结果按 id 关联并截断超长 message', async () => {
  const b = await startBridge();
  try {
    // 冷启动：从未有心跳 → shell=false（网页版降级为手动粘贴引导的依据）
    let view = await (await fetch(`${b.url}/status`)).json() as { shell: boolean; last: unknown };
    assert.equal(view.shell, false);
    assert.equal(view.last, null);

    // 非法 kind / 缺 at 拒绝
    const badKind = await fetch(`${b.url}/status`, { method: 'POST', body: JSON.stringify({ kind: 'nope', ok: true, at: 1 }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(badKind.status, 400);
    const badAt = await fetch(`${b.url}/status`, { method: 'POST', body: JSON.stringify({ kind: 'heartbeat', ok: true }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(badAt.status, 400);

    // 心跳后 shell=true
    await fetch(`${b.url}/status`, { method: 'POST', body: JSON.stringify({ kind: 'heartbeat', ok: true, at: 1 }), headers: { 'Content-Type': 'application/json' } });
    view = await (await fetch(`${b.url}/status`)).json();
    assert.equal(view.shell, true);

    // 动作结果：id 关联 + 字段透传 + 超长 message 截断
    const longMsg = 'x'.repeat(600);
    await fetch(`${b.url}/status`, { method: 'POST', body: JSON.stringify({ kind: 'login', id: 42, ok: true, hasSessid: true, hasClearance: true, pushed: true, message: longMsg, at: 2 }), headers: { 'Content-Type': 'application/json' } });
    view = await (await fetch(`${b.url}/status`)).json();
    const last = view.last as { kind: string; id: number; pushed: boolean; message: string };
    assert.ok(last);
    assert.equal(last.kind, 'login');
    assert.equal(last.id, 42);
    assert.equal(last.pushed, true);
    assert.equal(last.message.length, 512);

    // /platforms：与 shared COOKIE_FIELDS 同口径的凭据平台清单
    const plats = await (await fetch(`${b.url}/platforms`)).json() as { platforms: string[] };
    assert.deepEqual(plats.platforms.sort(), ['atcoder', 'daimayuan', 'jisuanke', 'leetcode', 'luogu', 'qoj']);
  } finally {
    await b.close();
  }
});

test('shell-auth 桥：status 只保留最近一条（前端按 id 轮询只需最新）', async () => {
  const b = await startBridge();
  try {
    for (const id of [1, 2, 3]) {
      await fetch(`${b.url}/status`, { method: 'POST', body: JSON.stringify({ kind: 'pull', id, ok: id === 3, message: `m${id}`, at: id }), headers: { 'Content-Type': 'application/json' } });
    }
    const view = await (await fetch(`${b.url}/status`)).json();
    const last = view.last as { id: number; ok: boolean; message: string };
    assert.equal(last.id, 3);
    assert.equal(last.ok, true);
    assert.equal(last.message, 'm3');
  } finally {
    await b.close();
  }
});
