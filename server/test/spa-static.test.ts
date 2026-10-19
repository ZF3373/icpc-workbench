/**
 * 前端静态资源的 gzip 与缓存头回归测试。
 *
 * 背景：桌面 SEA 版与 Docker 版共用 sea.ts，client/dist 约 6 MB。此前
 * `express.static(distDir)` 裸挂：远程访问首屏全量传输、JS/CSS 没有任何缓存头，
 * 每次刷新都回源。本次加 compression + 按「文件名是否带内容哈希」分流的缓存策略。
 *
 * 两条底线必须锁住：
 * 1. SSE（/api/ai/chat）绝不能被压缩——gzip 攒块才出字节，前端逐 delta 渲染会退化成
 *    「等回答完才显示」。注意 compression 的默认 filter 按 compressible 判断，
 *    text/event-stream 在 mime-db 里是可压缩的，所以这**不是**默认安全行为。
 * 2. index.html 必须 no-cache：升级后旧入口指向已被替换的旧 chunk，用户白屏且无法自愈。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { compressionMiddleware, isSsePath } from '../src/middleware.ts';
import { spaStaticRoutes } from '../src/spa-static.ts';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** node:http 直发：fetch 会自动解压并把 content-encoding 藏起来，测不出真实线缆行为 */
function rawGet(
  origin: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  const u = new URL(pathname, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** 一块远超 1 KB 阈值、可压缩性良好的文本 */
const BIG_TEXT = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => `第 ${i} 条测试数据`) });

test('isSsePath：命中 /api/ai/chat 及其子路径，不误伤同前缀的其它路径', () => {
  assert.equal(isSsePath('/api/ai/chat'), true);
  assert.equal(isSsePath('/api/ai/chat/'), true);
  assert.equal(isSsePath('/api/ai/chat/history'), true);
  assert.equal(isSsePath('/api/ai/chatty'), false);
  assert.equal(isSsePath('/api/ai/title'), false);
});

test('gzip：大 JSON 响应被压缩，解压后与原文一致', async () => {
  const app = express();
  app.use(compressionMiddleware());
  app.get('/api/big', (_req, res) => {
    res.json({ items: JSON.parse(BIG_TEXT).items });
  });
  const srv = await listenForTest(app);
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await rawGet(origin, '/api/big', { 'Accept-Encoding': 'gzip' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.match(String(res.headers['vary']), /Accept-Encoding/i);
    const plain = zlib.gunzipSync(res.body).toString('utf8');
    assert.deepEqual(JSON.parse(plain), JSON.parse(BIG_TEXT));
    assert.ok(res.body.length < plain.length, '压缩后应小于原文');
  } finally {
    srv.close();
  }
});

test('SSE：/api/ai/chat 即使客户端接受 gzip 也原样流式输出（不压缩）', async () => {
  const app = express();
  app.use(compressionMiddleware());
  app.get('/api/ai/chat', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`data: ${'x'.repeat(4096)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const srv = await listenForTest(app);
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await rawGet(origin, '/api/ai/chat', { 'Accept-Encoding': 'gzip' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], undefined, 'SSE 响应不得带 content-encoding');
    assert.match(String(res.headers['content-type']), /text\/event-stream/);
    assert.match(res.body.toString('utf8'), /^data: x{4096}\n\ndata: \[DONE\]/);
  } finally {
    srv.close();
  }
});

test('SSE 兜底：未列入清单的端点若返回 text/event-stream 也不压缩', async () => {
  const app = express();
  app.use(compressionMiddleware());
  app.get('/api/future-stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.flushHeaders();
    res.write(`data: ${'y'.repeat(4096)}\n\n`);
    res.end();
  });
  const srv = await listenForTest(app);
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const res = await rawGet(origin, '/api/future-stream', { 'Accept-Encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.match(res.body.toString('utf8'), /^data: y{4096}/);
  } finally {
    srv.close();
  }
});

/** 造一份最小 dist：带哈希的 assets + index.html + 无哈希的 favicon */
function makeDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-spa-test-'));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'index-D2S9hhDk.js'), `console.log(${JSON.stringify('z'.repeat(4096))});`);
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>');
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return dir;
}

async function withSpaApp(fn: (origin: string) => Promise<void>): Promise<void> {
  const dir = makeDist();
  const app = express();
  app.use(compressionMiddleware());
  app.use(spaStaticRoutes(dir));
  const srv = await listenForTest(app);
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(origin);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('缓存策略：带哈希的 assets immutable 一年 + gzip', async () => {
  await withSpaApp(async (origin) => {
    const res = await rawGet(origin, '/assets/index-D2S9hhDk.js', { 'Accept-Encoding': 'gzip' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.match(zlib.gunzipSync(res.body).toString('utf8'), /^console\.log\("z{4096}"\)/);
  });
});

test('缓存策略：index.html 与未哈希文件 no-cache（升级后必须拿到新入口）', async () => {
  await withSpaApp(async (origin) => {
    for (const p of ['/', '/index.html', '/favicon.svg']) {
      const res = await rawGet(origin, p);
      assert.equal(res.status, 200, `${p} 应可访问`);
      assert.equal(res.headers['cache-control'], 'no-cache', `${p} 必须 no-cache`);
    }
  });
});

test('缓存策略：BrowserRouter 刷新兜底返回 index.html，同样 no-cache', async () => {
  await withSpaApp(async (origin) => {
    const res = await rawGet(origin, '/contests/123');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-cache');
    assert.match(res.body.toString('utf8'), /<body>app<\/body>/);
  });
});
