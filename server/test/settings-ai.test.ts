import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { saveAiConfig } from '../src/config.ts';

/** mock OpenAI 兼容上游：可配置是否提供 /models、是否校验 Bearer key */
interface Upstream {
  base: string;
  requests: Array<{ path: string; auth: string | undefined }>;
  close: () => Promise<void>;
}

async function startUpstream(opts: { withModels: boolean; requireKey?: string }): Promise<Upstream> {
  const requests: Array<{ path: string; auth: string | undefined }> = [];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ path: req.url ?? '', auth: req.headers.authorization });
      if (opts.requireKey && req.headers.authorization !== `Bearer ${opts.requireKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      if (req.url?.endsWith('/models')) {
        if (!opts.withModels) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        // 乱序 + 重复 → 验证去重排序
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }));
        return;
      }
      if (req.url?.endsWith('/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  srv.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  return {
    base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`,
    requests,
    close: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}

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

test('POST /ai/models returns sorted deduped ids and forwards api key', async () => {
  const upstream = await startUpstream({ withModels: true, requireKey: 'secret' });
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/ai/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: upstream.base, apiKey: 'secret' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { models: ['model-a', 'model-b'] });
    assert.equal(upstream.requests[0]?.auth, 'Bearer secret');
    assert.match(upstream.requests[0]?.path ?? '', /\/v1\/models$/);
  });
  await upstream.close();
});

test('POST /ai/test succeeds via /models and reports configured model', async () => {
  const upstream = await startUpstream({ withModels: true, requireKey: 'secret' });
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/ai/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: upstream.base, apiKey: 'secret', model: 'model-a' }),
    });
    const body = (await res.json()) as { ok: boolean; message: string; models: string[] };
    assert.equal(body.ok, true);
    assert.match(body.message, /连接成功/);
    assert.match(body.message, /model-a 在可用列表中/);
    assert.deepEqual(body.models, ['model-a', 'model-b']);
    // /models 成功 → 不应退化调用 chat
    assert.equal(upstream.requests.some((r) => r.path.endsWith('/chat/completions')), false);
  });
  await upstream.close();
});

test('POST /ai/test warns when configured model is absent from the list', async () => {
  const upstream = await startUpstream({ withModels: true, requireKey: 'secret' });
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/ai/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: upstream.base, apiKey: 'secret', model: 'not-there' }),
    });
    const body = (await res.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.match(body.message, /不在列表中/);
  });
  await upstream.close();
});

test('POST /ai/test falls back to chat probe when /models is unsupported', async () => {
  const upstream = await startUpstream({ withModels: false });
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/ai/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: upstream.base, model: 'm1' }),
    });
    const body = (await res.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, true);
    assert.match(body.message, /chat\/completions/);
    assert.equal(upstream.requests.some((r) => r.path.endsWith('/chat/completions')), true);
  });
  await upstream.close();
});

test('POST /ai/test falls back to saved config when body fields are empty', async () => {
  const upstream = await startUpstream({ withModels: true, requireKey: 'saved-key' });
  await withServer(async (db, base) => {
    const savedEnv = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY; // 环境变量优先级高于 DB，避免污染断言
    try {
      saveAiConfig(db, DEFAULT_CONFIG, { baseURL: upstream.base, apiKey: 'saved-key', model: 'model-b' });
      const res = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as { ok: boolean; message: string };
      assert.equal(body.ok, true);
      assert.equal(upstream.requests[0]?.auth, 'Bearer saved-key');
      assert.match(body.message, /model-b 在可用列表中/);
    } finally {
      if (savedEnv !== undefined) process.env.AI_API_KEY = savedEnv;
    }
  });
  await upstream.close();
});

test('POST /ai/test reports failure for unreachable host and invalid baseURL', async () => {
  await withServer(async (_db, base) => {
    const down = await fetch(`${base}/ai/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: 'http://127.0.0.1:9/v1' }),
    });
    const downBody = (await down.json()) as { ok: boolean; message: string };
    assert.equal(downBody.ok, false);
    assert.match(downBody.message, /连接失败/);

    const bad = await fetch(`${base}/ai/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: 'ftp://example.com/v1' }),
    });
    const badBody = (await bad.json()) as { ok: boolean; message: string };
    assert.equal(badBody.ok, false);
    assert.match(badBody.message, /http\(s\)/);
  });
});
