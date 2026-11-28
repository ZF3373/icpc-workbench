import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { spawn as codexRealSpawn } from 'node:child_process';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { aiConfigFromDb, saveAiConfig } from '../src/config.ts';
import { setCodexTestDeps, type CodexSpawnFn } from '../src/ai/codexProvider.ts';
import {
  ensureFreshChatgptCredential,
  generateTestSigningKey,
  readChatgptCredential,
  setChatgptAuthDepsForTest,
  signTestJwt,
  type TestSigningKey,
} from '../src/ai/chatgptAuth.ts';

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
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/settings`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

test('搜索渠道保存、移除后保留 Key、缺省保持、显式清除与按需回显', async () => {
  await withServer(async (db, base) => {
    const save = async (searchProviders: unknown) => {
      const res = await fetch(`${base}/ai`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ searchProviders }) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.doesNotMatch(JSON.stringify(body), /secret-one|secret-two|brave-secret/);
      assert.equal(body.searchProviders, undefined, '运行时渠道含原文，不得展开到响应');
      return body;
    };
    const first = await save({ order: ['tavily', 'brave'], keys: { tavily: ' secret-one \nsecret-two\nsecret-one', brave: ['brave-secret'] } });
    assert.deepEqual(first.searchOrder, ['tavily', 'brave']);
    assert.deepEqual(first.searchKeyStats, [
      { engine: 'tavily', keysMasked: ['••••••••', '••••••••'] },
      { engine: 'brave', keysMasked: ['brav••••••cret'] },
    ]);
    const second = await save({ order: ['brave'] });
    assert.equal(second.searchKeyStats.find((s: { engine: string }) => s.engine === 'tavily').keysMasked.length, 2);
    const reveal = await fetch(`${base}/ai/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'searchProviderKeys', engine: 'tavily' }) });
    assert.deepEqual(await reveal.json(), { value: 'secret-one\nsecret-two' });
    await save({ order: ['tavily', 'brave'], keys: { tavily: '' } });
    const stored = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'ai.searchProviders'").get() as { value: string }).value);
    assert.deepEqual(stored, { order: ['tavily', 'brave'], keys: { tavily: [], brave: ['brave-secret'] } });
    const view = await (await fetch(base)).json();
    assert.deepEqual(view.ai.searchKeyStats, [{ engine: 'brave', keysMasked: ['brav••••••cret'] }]);
    assert.doesNotMatch(JSON.stringify(view), /secret-one|secret-two|brave-secret/);
    assert.equal(view.ai.searchProviders, undefined);
  });
});

test('非法搜索渠道返回 400，整次请求不写入已验证的模型提供商', async () => {
  await withServer(async (db, base) => {
    for (const searchProviders of [null, [], {}, { order: 'tavily' }, { order: ['unknown'] }, { order: [], keys: [] }, { order: [], keys: { unknown: 'key' } }, { order: [], keys: { tavily: 42 } }, { order: [], keys: { tavily: ['key', null] } }]) {
      const res = await fetch(`${base}/ai`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        enabled: true, providers: [{ id: 'new', name: 'New', baseURL: 'https://example.com', model: 'm' }], searchProviders,
      }) });
      assert.equal(res.status, 400, JSON.stringify(searchProviders));
      assert.equal(db.prepare("SELECT value FROM settings WHERE key IN ('ai.providers', 'ai.searchProviders', 'ai.enabled')").get(), undefined);
    }
    const res = await fetch(`${base}/ai/reveal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'searchProviderKeys', engine: 'unknown' }) });
    assert.equal(res.status, 400);
  });
});

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

test('GET /api/settings reports secret presence without returning secret values', async () => {
  await withServer(async (db, base) => {
    saveAiConfig(db, DEFAULT_CONFIG, { apiKey: 'ai-secret', searchApiKey: 'search-secret-key' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('cookie.luogu', 'session=short')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('cookie.daimayuan', 'sid=a-very-long-session-token-here')").run();
    const res = await fetch(base);
    const body = (await res.json()) as {
      ai: { apiKey: string; searchApiKey: string; hasApiKey: boolean; hasSearchApiKey: boolean; apiKeyMasked: string; searchApiKeyMasked: string };
      cookies: Record<string, { configured: boolean; masked?: string }>;
    };
    assert.equal(body.ai.apiKey, '');
    assert.equal(body.ai.searchApiKey, '');
    assert.equal(body.ai.hasApiKey, true);
    assert.equal(body.ai.hasSearchApiKey, true);
    // 打码版回显：短值（<12 字符）全遮，长值露前 4 后 4
    assert.equal(body.ai.apiKeyMasked, '••••••••');
    assert.equal(body.ai.searchApiKeyMasked, 'sear••••••-key');
    assert.deepEqual(body.cookies.luogu, { configured: true, masked: 'session=••••••••' });
    assert.equal(body.cookies.daimayuan.masked, 'sid=a-ve••••••here');
    assert.doesNotMatch(JSON.stringify(body), /secret|short|a-very-long/);

    // 保存响应同样不回传秘密原文，只回传打码版；空密钥提交（不传字段）不覆盖已保存值
    const save = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, baseURL: 'https://ai.example.com', model: 'm1' }),
    });
    const savedBody = (await save.json()) as { apiKey: string; searchApiKey: string; hasApiKey: boolean; apiKeyMasked: string };
    assert.equal(savedBody.apiKey, '');
    assert.equal(savedBody.searchApiKey, '');
    assert.equal(savedBody.hasApiKey, true);
    assert.equal(savedBody.apiKeyMasked, '••••••••');
    assert.doesNotMatch(JSON.stringify(savedBody), /secret/);
  });
});

test('maskSecret masks short values fully and reveals only 4+4 of long values', async () => {
  const { maskSecret } = await import('../src/routes/settings.ts');
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('  '), '');
  assert.equal(maskSecret('short'), '••••••••');
  assert.equal(maskSecret('exactly-11c'), '••••••••');
  assert.equal(maskSecret('sk-1234567890abcdef'), 'sk-1••••••cdef');
  // 中间固定 6 个点，不泄露原文长度
  assert.equal(maskSecret('a'.repeat(40)), 'aaaa••••••aaaa');
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

// ---------- 多提供商（providers 批量保存 / 密钥合并 / 活跃切换） ----------

interface ProviderView {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  maxTokens?: number;
  contextWindow?: number;
  models?: Array<{ id: string; maxTokens?: number; contextWindow?: number }>;
}

test('旧单配置自动迁移：GET 返回 default 提供商的打码视图，密钥原文不回传', async () => {
  await withServer(async (db, base) => {
    const savedEnv = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    try {
      saveAiConfig(db, DEFAULT_CONFIG, { baseURL: 'https://legacy.example/v1', apiKey: 'legacy-key', model: 'legacy-model' });
      const res = await fetch(base);
      const body = (await res.json()) as {
        ai: { activeProviderId?: string; providers?: ProviderView[]; baseURL: string; model: string };
      };
      assert.equal(body.ai.activeProviderId, 'default');
      assert.deepEqual(body.ai.providers, [{
        id: 'default',
        name: '默认提供商',
        baseURL: 'https://legacy.example/v1',
        model: 'legacy-model',
        hasApiKey: true,
        apiKeyMasked: '••••••••',
      }]);
      assert.equal(body.ai.baseURL, 'https://legacy.example/v1');
      assert.doesNotMatch(JSON.stringify(body), /legacy-key/);
    } finally {
      if (savedEnv !== undefined) process.env.AI_API_KEY = savedEnv;
    }
  });
});

test('POST /ai 保存提供商列表：密钥缺省保持已存值，非空覆盖，空串清空', async () => {
  const upstream = await startUpstream({ withModels: true, requireKey: 'kept-key' });
  await withServer(async (_db, base) => {
    const postJson = async (body: unknown) =>
      fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // 第一次保存：两家提供商，第一家带密钥（baseURL 指向 mock 上游，断言密钥真实送达）
    const r1 = await postJson({
      providers: [
        { id: 'p1', name: 'DeepSeek', baseURL: upstream.base, model: 'deepseek-chat', apiKey: 'kept-key' },
        { id: 'p2', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      ],
      activeProviderId: 'p1',
    });
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as { activeProviderId?: string; providers?: ProviderView[] };
    assert.equal(b1.activeProviderId, 'p1');
    assert.deepEqual(b1.providers?.map((p) => [p.id, p.hasApiKey]), [['p1', true], ['p2', false]]);
    assert.doesNotMatch(JSON.stringify(b1), /kept-key/);

    // 第二次保存：p1 不带 apiKey 字段（缺省语义）→ 已存密钥保持有效，可通 requireKey 上游
    await postJson({
      providers: [
        { id: 'p1', name: 'DeepSeek 改名', baseURL: upstream.base, model: 'deepseek-reasoner' },
        { id: 'p2', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
      ],
      activeProviderId: 'p1',
    });
    const testRes = await fetch(`${base}/ai/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'p1' }),
    });
    const testBody = (await testRes.json()) as { ok: boolean; message: string };
    assert.equal(testBody.ok, true);
    assert.equal(upstream.requests[0]?.auth, 'Bearer kept-key');
    // 测试用的是 p1 的最新模型名（mock 上游列表只有 model-a/b，自定义名必然提示不在列表，
    // 报错文案里带出的正是服务端实际使用的模型 → 反向验证提供商数据流）
    assert.match(testBody.message, /模型 deepseek-reasoner 不在列表中/);

    // 空串 = 显式清空密钥
    await postJson({
      providers: [{ id: 'p1', name: 'DeepSeek 改名', baseURL: upstream.base, model: 'm', apiKey: '' }],
      activeProviderId: 'p1',
    });
    const cleared = await fetch(base);
    const clearedBody = (await cleared.json()) as { ai: { providers?: ProviderView[] } };
    assert.equal(clearedBody.ai.providers?.[0]?.hasApiKey, false);
  });
  await upstream.close();
});

test('POST /ai/providers/active 一键切换活跃提供商，AI 请求随之切换', async () => {
  const upstream = await startUpstream({ withModels: true, requireKey: 'key-b' });
  await withServer(async (_db, base) => {
    await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          { id: 'pa', name: 'A', baseURL: 'https://a.example/v1', model: 'ma', apiKey: 'key-a' },
          { id: 'pb', name: 'B', baseURL: upstream.base, model: 'mb', apiKey: 'key-b' },
        ],
        activeProviderId: 'pa',
      }),
    });
    // 切到 B：不带任何字段的 /ai/test 应回退到 B 的已存配置
    const sw = await fetch(`${base}/ai/providers/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'pb' }),
    });
    assert.equal(sw.status, 200);
    const testRes = await fetch(`${base}/ai/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const testBody = (await testRes.json()) as { ok: boolean; message: string };
    assert.equal(testBody.ok, true);
    assert.equal(upstream.requests[0]?.auth, 'Bearer key-b');
    assert.match(testBody.message, /模型 mb 不在列表中/);

    // 未知 id → 404
    const missing = await fetch(`${base}/ai/providers/active`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'nope' }),
    });
    assert.equal(missing.status, 404);
  });
  await upstream.close();
});

test('POST /ai/providers/active 带 model 顺带改写该提供商模型，不带 model 时模型不动', async () => {
  await withServer(async (_db, base) => {
    await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          { id: 'pa', name: 'A', baseURL: 'https://a.example/v1', model: 'ma', apiKey: 'key-a' },
          { id: 'pb', name: 'B', baseURL: 'https://b.example/v1', model: 'mb', apiKey: 'key-b' },
        ],
        activeProviderId: 'pa',
      }),
    });
    /** 读回「活跃 id + 各提供商模型 + 运行时生效模型」：切换是否落库、是否只影响目标提供商 */
    const snapshot = async () => {
      const v = (await (await fetch(base)).json()) as {
        ai: { activeProviderId: string; model: string; providers: Array<{ id: string; model: string }> };
      };
      return {
        active: v.ai.activeProviderId,
        effectiveModel: v.ai.model,
        models: Object.fromEntries(v.ai.providers.map((p) => [p.id, p.model])),
      };
    };
    const switchTo = async (body: Record<string, unknown>) =>
      fetch(`${base}/ai/providers/active`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // 切到 B 并指定模型：活跃项与 B 的模型一起生效，A 不受影响
    const sw = await switchTo({ id: 'pb', model: 'mb-pro' });
    assert.equal(sw.status, 200);
    assert.deepEqual(await sw.json(), { ok: true, activeProviderId: 'pb', model: 'mb-pro' });
    assert.deepEqual(await snapshot(), {
      active: 'pb',
      effectiveModel: 'mb-pro',
      models: { pa: 'ma', pb: 'mb-pro' },
    });

    // 只切回 A（不带 model）：B 上次改写的模型保留，不被整表保存时的旧值冲回
    assert.equal((await switchTo({ id: 'pa' })).status, 200);
    assert.deepEqual(await snapshot(), {
      active: 'pa',
      effectiveModel: 'ma',
      models: { pa: 'ma', pb: 'mb-pro' },
    });

    // 空白 model = 只切提供商，等价于不传
    assert.equal((await switchTo({ id: 'pb', model: '   ' })).status, 200);
    assert.deepEqual(await snapshot(), {
      active: 'pb',
      effectiveModel: 'mb-pro',
      models: { pa: 'ma', pb: 'mb-pro' },
    });

    // 未知 id 仍是 404，且不改动任何已存值
    assert.equal((await switchTo({ id: 'nope', model: 'x' })).status, 404);
    assert.deepEqual(await snapshot(), {
      active: 'pb',
      effectiveModel: 'mb-pro',
      models: { pa: 'ma', pb: 'mb-pro' },
    });
  });
});

test('POST /ai/reveal 点眼睛按需取回单个密钥原文；没存过的不下发', async () => {
  const savedAi = process.env.AI_API_KEY;
  const savedSearch = process.env.SEARCH_API_KEY;
  delete process.env.AI_API_KEY; // 环境变量优先级高于 DB，避免污染断言
  delete process.env.SEARCH_API_KEY;
  try {
    await withServer(async (_db, base) => {
      await fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: [
            { id: 'pa', name: 'A', baseURL: 'https://a.example/v1', model: 'ma', apiKey: 'key-a' },
            { id: 'pb', name: 'B', baseURL: 'https://b.example/v1', model: 'mb' },
          ],
          activeProviderId: 'pa',
          searchApiKey: 'tvly-secret',
        }),
      });
      const reveal = async (body: Record<string, unknown>) => {
        const res = await fetch(`${base}/ai/reveal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: res.status, payload: await res.json() };
      };

      // 已存密钥的提供商：返回原文（GET 侧只有打码版，这是原文唯一的下发口）
      assert.deepEqual(await reveal({ providerId: 'pa' }), { status: 200, payload: { value: 'key-a' } });
      // 没配密钥的提供商：空串——即使环境变量 AI_API_KEY 生效中也不能借此下发，
      // 否则前端把它填进输入框，下一次「保存 AI 配置」就写进 settings（env 密钥永不落库）
      process.env.AI_API_KEY = 'env-secret-should-not-leak';
      assert.deepEqual(await reveal({ providerId: 'pb' }), { status: 200, payload: { value: '' } });
      delete process.env.AI_API_KEY;
      // 未知提供商 → 404
      assert.equal((await reveal({ providerId: 'nope' })).status, 404);
      // 搜索密钥：与界面「已配置 xxx」同口径的运行时生效值
      assert.deepEqual(await reveal({ target: 'searchApiKey' }), { status: 200, payload: { value: 'tvly-secret' } });
    });
  } finally {
    if (savedAi === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedAi;
    if (savedSearch === undefined) delete process.env.SEARCH_API_KEY;
    else process.env.SEARCH_API_KEY = savedSearch;
  }
});

test('POST /ai 校验提供商条目：坏 baseURL 返回 400 且不落库', async () => {
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [{ id: 'p1', name: '坏地址', baseURL: 'api.example.com/v1', model: 'm' }],
        activeProviderId: 'p1',
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /http\(s\)/);
    // 未落库：GET 仍是迁移出的单个默认提供商
    const get = await fetch(base);
    const getBody = (await get.json()) as { ai: { providers?: ProviderView[] } };
    assert.equal(getBody.ai.providers?.length, 1);
    assert.equal(getBody.ai.providers?.[0]?.id, 'default');
  });
});

test('POST /ai 保存提供商的输出/上下文档位；显式 null 清除单独设置', async () => {
  await withServer(async (_db, base) => {
    const postJson = async (body: unknown) =>
      fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    await postJson({
      providers: [
        { id: 'p1', name: 'A', baseURL: 'https://a.example/v1', model: 'ma', maxTokens: 8192, contextWindow: 131072 },
        { id: 'p2', name: 'B', baseURL: 'https://b.example/v1', model: 'mb' },
      ],
      activeProviderId: 'p1',
    });
    let get = await fetch(base);
    let body = (await get.json()) as {
      ai: { providers?: ProviderView[]; globalMaxTokens?: number; globalContextWindow?: number; maxTokens?: number };
    };
    assert.deepEqual(
      body.ai.providers?.map((p) => [p.id, p.maxTokens, p.contextWindow]),
      [['p1', 8192, 131072], ['p2', undefined, undefined]],
    );
    // 活跃 p1 → 聚合口径带其档位；全局兜底字段是**不含提供商覆盖**的 config 默认值
    assert.equal(body.ai.maxTokens, 8192);
    assert.equal(body.ai.globalMaxTokens, DEFAULT_CONFIG.ai.maxTokens);
    assert.equal(body.ai.globalContextWindow, DEFAULT_CONFIG.ai.contextWindow);

    // 显式 null = 清除 p1 的单独设置（回退全局）
    await postJson({
      providers: [{ id: 'p1', name: 'A', baseURL: 'https://a.example/v1', model: 'ma', maxTokens: null, contextWindow: null }],
      activeProviderId: 'p1',
    });
    get = await fetch(base);
    body = (await get.json()) as { ai: { providers?: ProviderView[] } };
    assert.equal(body.ai.providers?.[0]?.maxTokens, undefined);
    assert.equal(body.ai.providers?.[0]?.contextWindow, undefined);
  });
});

test('POST /ai 保存模型目录并原样回读；条目参数随后用于聚合口径', async () => {
  const upstream = await startUpstream({ withModels: true, requireKey: 'k-catalog' });
  await withServer(async (_db, base) => {
    const r1 = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [{
          id: 'p1',
          name: 'A',
          baseURL: upstream.base,
          model: 'model-a',
          apiKey: 'k-catalog',
          models: [
            { id: 'model-a', maxTokens: 16384, contextWindow: 131072 },
            { id: 'model-b' },
          ],
        }],
        activeProviderId: 'p1',
      }),
    });
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as { providers?: ProviderView[] };
    assert.deepEqual(b1.providers?.[0]?.models, [
      { id: 'model-a', maxTokens: 16384, contextWindow: 131072 },
      { id: 'model-b' },
    ]);

    // 活跃模型 model-a 命中目录条目 → 聚合口径用条目参数（而不是提供商级/全局）
    const get = await fetch(base);
    const body = (await get.json()) as { ai: { maxTokens?: number; contextWindow?: number } };
    assert.equal(body.ai.maxTokens, 16384);
    assert.equal(body.ai.contextWindow, 131072);
  });
  await upstream.close();
});

test('POST /ai 空串 searchApiKey 不清空已存联网搜索密钥（设置页密码框恒发空串）', async () => {
  await withServer(async (db, base) => {
    const postJson = async (body: unknown) =>
      fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    saveAiConfig(db, DEFAULT_CONFIG, { searchApiKey: 'tvly-SECRET-123456' });

    // 客户端 collectSavePayload 的真实形状：搜索密钥框留空 → 恒带空串（旧行为会被当成显式清空）
    const r1 = await postJson({
      enabled: true,
      searchEngine: 'tavily',
      searchApiKey: '',
      providers: [{
        id: 'default', name: '默认提供商', baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat', maxTokens: null, contextWindow: null, models: [],
      }],
      activeProviderId: 'default',
      timeoutMs: 120000,
    });
    assert.equal(r1.status, 200);
    assert.equal(((await r1.json()) as { hasSearchApiKey: boolean }).hasSearchApiKey, true, '空串 = 保持已存密钥');
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).searchApiKey, 'tvly-SECRET-123456');

    // 非空 = 覆盖
    await postJson({ searchApiKey: 'tvly-NEW-KEY-9999' });
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).searchApiKey, 'tvly-NEW-KEY-9999');
    // 纯空白同样不覆盖（密码框可能被敲进空格）
    await postJson({ searchApiKey: '   ' });
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).searchApiKey, 'tvly-NEW-KEY-9999');
    // 不带字段 = 保持
    const r4 = await postJson({ enabled: false });
    assert.equal(((await r4.json()) as { hasSearchApiKey: boolean }).hasSearchApiKey, true);
  });
});

test('POST /ai 传空 providers 数组 → 400（不再 500 + 同请求全局项静默丢失）', async () => {
  await withServer(async (db, base) => {
    saveAiConfig(db, DEFAULT_CONFIG, { apiKey: 'k-old', timeoutMs: 60000 });
    const res = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providers: [], enabled: true, timeoutMs: 90000 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /至少需要保留一个提供商/);
    // 显式失败而不是半截保存：同请求的全局项不落库
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).timeoutMs, 60000);
  });
});

test('POST /ai 的 providers 全是非对象条目时同样 400，不是 500（B16 回归）', async () => {
  /**
   * 空数组守卫原先检查的是**原始** `b.providers.length`，而净化循环会把非对象条目
   * continue 掉、之后从不复查 drafts：`[null]` / `[5,"x"]` 于是绕过守卫直达
   * saveAiProviders 抛错 → 500，且同一请求里的全局 AI 设置（saveAiConfig）根本不会执行，
   * 用户的「启用/超时」等修改一并丢失。守卫必须复查净化后的结果。
   */
  await withServer(async (db, base) => {
    saveAiConfig(db, DEFAULT_CONFIG, { timeoutMs: 60000 });
    for (const providers of [[null], [5, 'x'], [null, undefined], [{}, { id: '' }]]) {
      const res = await fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providers, enabled: true, timeoutMs: 90000 }),
      });
      assert.equal(res.status, 400, `providers=${JSON.stringify(providers)} 应为 400，实际 ${res.status}`);
      // 错误文案可能来自更早的逐条校验（如 `providers[].id 必填`），只要不是 500 即可
      const body = (await res.json()) as { error: string };
      assert.ok(body.error && !/服务器内部错误/.test(body.error), `不应回通用 500 文案: ${body.error}`);
      // 关键：显式失败，不是 500 + 半截保存
      assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).timeoutMs, 60000, '失败时全局项不得被写入');
    }
  });
});

test('缺省 activeProviderId 保持已存活跃项（旧客户端/脚本不传时不静默切回首项）', async () => {
  await withServer(async (_db, base) => {
    const postJson = async (body: unknown) =>
      fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const providers = [
      { id: 'p1', name: 'A', baseURL: 'https://a.example/v1', model: 'ma', apiKey: 'k1' },
      { id: 'p2', name: 'B', baseURL: 'https://b.example/v1', model: 'mb', apiKey: 'k2' },
    ];
    await postJson({ providers, activeProviderId: 'p2' });
    // 再保存一次（不带 activeProviderId）：活跃项保持不变
    await postJson({ providers: providers.map(({ apiKey: _k, ...p }) => p) });
    const view = (await (await fetch(base)).json()) as { ai: { activeProviderId?: string } };
    assert.equal(view.ai.activeProviderId, 'p2');
  });
});

test('环境变量 AI_API_KEY 生效时下发 apiKeyFromEnv，且不把它写成提供商密钥（回归）', async () => {
  const savedEnv = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'env-secret-key-1234';
  try {
    await withServer(async (db, base) => {
      const view = (await (await fetch(base)).json()) as {
        ai: { apiKeyFromEnv?: boolean; hasApiKey?: boolean; providers?: ProviderView[] };
      };
      assert.equal(view.ai.apiKeyFromEnv, true, '前端据此显示「密钥来自环境变量」而不是红标未配密钥');
      assert.equal(view.ai.providers?.[0]?.hasApiKey, false, '提供商自己没有存密钥（env 不落库）');
      // 按客户端形状保存（不下发 apiKey 字段）→ env 不会被写进 settings
      const res = await fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: [{
            id: 'default', name: '默认提供商', baseURL: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat', maxTokens: null, contextWindow: null, models: [],
          }],
          activeProviderId: 'default',
        }),
      });
      assert.equal(res.status, 200);
      const raw = (db.prepare("SELECT value FROM settings WHERE key = 'ai.providers'").get() as { value: string } | undefined)?.value ?? '';
      assert.doesNotMatch(raw, /env-secret/, 'env 密钥绝不落库');
    });
  } finally {
    if (savedEnv === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedEnv;
  }
});

test('POST /ai/models 下发网关返回的真实参数档位（OpenRouter 风格 caps）', async () => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'openai/gpt-4o-mini', context_length: 128000, top_provider: { max_completion_tokens: 16384 } },
            { id: 'plain-model' },
            { id: 'ctx-only', context_length: 32768 },
            // DeepSeek 官方 /models：档位平铺在条目顶层
            { id: 'deepseek-flash', context_window: 1048576, max_output_tokens: 393216 },
            // 百炼（DashScope）：嵌在 model_info 里
            { id: 'qwen-plus', model_info: { context_window: 1000000, max_output_tokens: 32768 } },
          ],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  srv.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/ai/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseURL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1` }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      models: string[];
      caps?: Record<string, { maxTokens?: number; contextWindow?: number }>;
    };
    assert.deepEqual(body.models, ['ctx-only', 'deepseek-flash', 'openai/gpt-4o-mini', 'plain-model', 'qwen-plus']);
    assert.deepEqual(body.caps?.['openai/gpt-4o-mini'], { maxTokens: 16384, contextWindow: 128000 });
    assert.deepEqual(body.caps?.['ctx-only'], { contextWindow: 32768 });
    assert.deepEqual(body.caps?.['deepseek-flash'], { maxTokens: 393216, contextWindow: 1048576 });
    assert.deepEqual(body.caps?.['qwen-plus'], { maxTokens: 32768, contextWindow: 1000000 });
    assert.equal(body.caps?.['plain-model'], undefined);
  });
  await new Promise<void>((resolve) => srv.close(() => resolve()));
});

// ---------- 跨源 Key 复用防护 ----------
// 本机服务零鉴权，默认只靠「绑回环」划边界；恶意网页可借 DNS rebinding 以同源身份打到
// /ai/test。若该接口把「body 给的 baseURL」与「已保存的真 Key」自由组合，它就成了
// 「把 Key 送到任意主机」的开关（修复前已在本机实测复现：真 Key 被原样送达攻击者主机）。
// 以下用例锁死这个组合。两处 mock 上游端口不同 → 天然是「不同源」。

/** 清空 AI_API_KEY 环境变量跑一段逻辑（环境变量优先级高于 DB，会污染断言） */
async function withoutEnvKey(fn: () => Promise<void>): Promise<void> {
  const saved = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  try {
    await fn();
  } finally {
    if (saved !== undefined) process.env.AI_API_KEY = saved;
  }
}

test('POST /ai/test 不把已保存的 Key 复用到不同源地址，且一个字节都不发出去', async () => {
  const evil = await startUpstream({ withModels: true });
  await withServer(async (db, base) => {
    await withoutEnvKey(async () => {
      saveAiConfig(db, DEFAULT_CONFIG, {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'saved-key',
      });
      // 攻击者形态：只把 baseURL 指向自己的主机，不带 apiKey
      const res = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseURL: evil.base }),
      });
      const body = (await res.json()) as { ok: boolean; message: string };
      assert.equal(body.ok, false);
      assert.match(body.message, /不同源/);
      assert.equal(evil.requests.length, 0, '不应向不同源地址发出任何请求');
    });
  });
  await evil.close();
});

test('POST /ai/test 换源时只用请求体显式带来的 Key，绝不混入已保存的 Key', async () => {
  const evil = await startUpstream({ withModels: true, requireKey: 'user-typed-key' });
  await withServer(async (db, base) => {
    await withoutEnvKey(async () => {
      saveAiConfig(db, DEFAULT_CONFIG, {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'saved-key',
      });
      const res = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseURL: evil.base, apiKey: 'user-typed-key' }),
      });
      const body = (await res.json()) as { ok: boolean };
      assert.equal(body.ok, true);
      assert.equal(evil.requests[0]?.auth, 'Bearer user-typed-key');
      assert.notEqual(evil.requests[0]?.auth, 'Bearer saved-key');
    });
  });
  await evil.close();
});

test('POST /ai/test 同源换路径时仍复用已保存的 Key（正常「先测后存」流程不受影响）', async () => {
  const own = await startUpstream({ withModels: true, requireKey: 'saved-key' });
  const origin = new URL(own.base).origin;
  await withServer(async (db, base) => {
    await withoutEnvKey(async () => {
      saveAiConfig(db, DEFAULT_CONFIG, { baseURL: `${origin}/v1`, apiKey: 'saved-key' });
      // 同源、不同路径：属于同一服务商，允许复用
      const res = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseURL: `${origin}/v2` }),
      });
      const body = (await res.json()) as { ok: boolean };
      assert.equal(body.ok, true);
      assert.equal(own.requests[0]?.auth, 'Bearer saved-key');
      assert.match(own.requests[0]?.path ?? '', /\/v2\/models$/);
    });
  });
  await own.close();
});

test('POST /ai/models 同样拒绝跨源复用已保存的 Key', async () => {
  const evil = await startUpstream({ withModels: true });
  await withServer(async (db, base) => {
    await withoutEnvKey(async () => {
      saveAiConfig(db, DEFAULT_CONFIG, {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'saved-key',
      });
      const res = await fetch(`${base}/ai/models`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseURL: evil.base }),
      });
      assert.equal(res.status, 403);
      assert.match(((await res.json()) as { error: string }).error, /不同源/);
      assert.equal(evil.requests.length, 0);
    });
  });
  await evil.close();
});

// 多提供商形态（v0.5.5 起）：providerId 指向已存提供商即可取用它的密钥，
// 而 body 里的 baseURL 会覆盖请求目标 —— 攻击者只要读一次提供商列表就能拿到合法 id，
// 该组合必须同样被拦住。
test('POST /ai/test 多提供商形态：providerId 的密钥不得跟着被覆盖的 baseURL 走', async () => {
  const own = await startUpstream({ withModels: true, requireKey: 'provider-key' });
  const evil = await startUpstream({ withModels: true });
  await withServer(async (_db, base) => {
    await withoutEnvKey(async () => {
      const save = await fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: [
            { id: 'p1', name: 'DeepSeek', baseURL: own.base, model: 'deepseek-chat', apiKey: 'provider-key' },
          ],
          activeProviderId: 'p1',
        }),
      });
      assert.equal(save.status, 200);

      // 攻击者：选 p1 取得其密钥，同时把 baseURL 换成自己的主机
      const attack = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'p1', baseURL: evil.base }),
      });
      const attackBody = (await attack.json()) as { ok: boolean; message: string };
      assert.equal(attackBody.ok, false);
      assert.match(attackBody.message, /不同源/);
      assert.equal(evil.requests.length, 0, '提供商的密钥不得发往被覆盖的目标主机');

      // 对照组：不带 baseURL 覆盖时，providerId 正常取用自身密钥（功能没被砍掉）
      const ok = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'p1' }),
      });
      assert.equal(((await ok.json()) as { ok: boolean }).ok, true);
      assert.equal(own.requests[0]?.auth, 'Bearer provider-key');
    });
  });
  await own.close();
  await evil.close();
});

// ---------- 本地 Codex 提供商（issue 67） ----------

/** 与 codex-provider.test.ts 同款假 codex：node -e 按 FAKE_CODEX_MODE 输出 JSONL 事件 */
const SETTINGS_FAKE_CODEX_SCRIPT = `
const mode = process.env.FAKE_CODEX_MODE;
if (mode === 'exit-immediately') process.exit(0);
if (mode === 'login-ok') { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }
if (mode === 'login-missing') { process.stdout.write('Not logged in\\n'); process.exit(1); }
const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  emit({ type: 'item.completed', item: { id: 'a0', type: 'agent_message', text: 'pong' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
});
`;

function fakeCodexSpawnFn(loginMode: 'login-ok' | 'login-missing'): CodexSpawnFn {
  return (cmd, args, opts) => {
    assert.equal(cmd, 'codex');
    const a = args ?? [];
    // login → 可控登录态；--version → 立即退出；其余（codex exec 探测对话）→ 正常事件流
    const mode = a[0] === 'login' ? loginMode : a[0] === '--version' ? 'exit-immediately' : 'ok';
    return codexRealSpawn(process.execPath, ['-e', SETTINGS_FAKE_CODEX_SCRIPT], {
      ...opts,
      env: { ...(opts?.env ?? process.env), FAKE_CODEX_MODE: mode },
    });
  };
}

test('本地 Codex 提供商：免 baseURL/apiKey 保存落库，视图回传 protocol，运行时解析携带 codex', async () => {
  await withServer(async (db, base) => {
    const save = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          { id: 'pc1', name: '本地 Codex', baseURL: '', model: '', protocol: 'codex' },
          { id: 'ph1', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-flash', apiKey: 'sk-x' },
        ],
        activeProviderId: 'pc1',
      }),
    });
    assert.equal(save.status, 200);
    const stored = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'ai.providers'").get() as { value: string }).value);
    const codex = stored.find((p: { id: string }) => p.id === 'pc1');
    assert.equal(codex.protocol, 'codex');
    assert.equal(codex.baseURL, '');
    assert.equal(codex.apiKey, '');

    const view = (await (await fetch(base)).json()) as { ai: { providers: Array<{ id: string; protocol?: string; hasApiKey: boolean }>; protocol?: string } };
    const viewCodex = view.ai.providers.find((p) => p.id === 'pc1');
    assert.equal(viewCodex?.protocol, 'codex');
    assert.equal(viewCodex?.hasApiKey, false);

    // 运行时解析：激活 codex 提供商时 protocol 随之下发
    const cfg = aiConfigFromDb(db, DEFAULT_CONFIG);
    assert.equal(cfg.protocol, 'codex');
    assert.equal(cfg.baseURL, '');

    // 非 codex 提供商仍强制 http(s) baseURL（口径未被放宽误伤）
    const bad = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [{ id: 'pb1', name: '坏地址', baseURL: '', model: 'm' }],
      }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /http\(s\)/);

    // codex 提供商切回 chat 口径：显式 protocol 'chat' 覆盖旧值，空 baseURL 被拒
    const back = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [{ id: 'pc1', name: '本地 Codex', baseURL: '', model: '', protocol: 'chat' }],
      }),
    });
    assert.equal(back.status, 400);
  });
});

test('本地 Codex：/ai/models 返回空目录（模型跟随 CLI 配置）', async () => {
  await withServer(async (_db, base) => {
    await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [{ id: 'pc1', name: '本地 Codex', baseURL: '', model: '', protocol: 'codex' }],
        activeProviderId: 'pc1',
      }),
    });
    const res = await fetch(`${base}/ai/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'pc1' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { models: [] });
  });
});

test('本地 Codex：/ai/test 走 codex 探测（版本 → 登录态 → 最小对话）', async () => {
  await withServer(async (_db, base) => {
    setCodexTestDeps({ spawnFn: fakeCodexSpawnFn('login-ok') });
    try {
      const saved = await fetch(`${base}/ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providers: [{ id: 'pc1', name: '本地 Codex', baseURL: '', model: '', protocol: 'codex' }],
          activeProviderId: 'pc1',
        }),
      });
      assert.equal(saved.status, 200);
      const ok = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'pc1' }),
      });
      const okBody = (await ok.json()) as { ok: boolean; message: string };
      assert.equal(okBody.ok, true, okBody.message);
      assert.match(okBody.message, /连接成功/);

      // 未保存的 codex 草稿：靠请求体 protocol 提示识别
      const draft = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: 'codex' }),
      });
      assert.equal(((await draft.json()) as { ok: boolean }).ok, true);
    } finally {
      setCodexTestDeps(null);
    }

    // 未登录形态：ok:false + codex login 指引
    setCodexTestDeps({ spawnFn: fakeCodexSpawnFn('login-missing') });
    try {
      const bad = await fetch(`${base}/ai/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'pc1' }),
      });
      const badBody = (await bad.json()) as { ok: boolean; message: string };
      assert.equal(badBody.ok, false);
      assert.match(badBody.message, /codex login/);
    } finally {
      setCodexTestDeps(null);
    }
  });
});

// ---------- Sign in with ChatGPT：OAuth 登录端到端（fake 授权服务器 + 真 RSA/JWKS 验证） ----------

test('本地 Codex 与 ChatGPT 提供商的 protocol 落库与视图回传（多口径共存）', async () => {
  await withServer(async (db, base) => {
    const save = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [
          { id: 'pc1', name: 'ChatGPT 订阅', baseURL: 'https://api.openai.com/v1', model: '', protocol: 'chatgpt' },
        ],
        activeProviderId: 'pc1',
      }),
    });
    assert.equal(save.status, 200);
    const stored = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'ai.providers'").get() as { value: string }).value);
    assert.equal(stored[0].protocol, 'chatgpt');
    assert.equal(stored[0].baseURL, 'https://api.openai.com/v1');
    assert.equal(stored[0].apiKey, '');
    const view = (await (await fetch(base)).json()) as { ai: { providers: Array<{ protocol?: string }> } };
    assert.equal(view.ai.providers[0]?.protocol, 'chatgpt');
  });
});

test('ChatGPT 登录端到端：授权 URL 参数 → 回环回调 → code 交换 → 加密落库 → 套餐模型写入目录 → 登出撤销', async () => {
  // fake 授权服务器：token/metadata/jwks/models/revoke；id_token 用真 RSA 密钥签发
  const signer: TestSigningKey = generateTestSigningKey();
  let expectedNonce = '';
  let lastRefreshToken = '';
  let refreshCount = 0;
  const revokedTokens: string[] = [];
  let modelsAuth: string | undefined;
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const respond = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const pathname = (req.url ?? '').split('?')[0];
      if (pathname === '/.well-known/openid-configuration') {
        respond(200, { issuer: ISSUER_BASE, jwks_uri: `${ISSUER_BASE}/jwks`, revocation_endpoint: `${ISSUER_BASE}/revoke` });
        return;
      }
      if (pathname === '/jwks') {
        respond(200, { keys: [signer.publicJwk] });
        return;
      }
      if (pathname === '/api/accounts/oauth/token') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const grant = form.get('grant_type');
        const clientId = form.get('client_id') ?? '';
        if (grant === 'authorization_code') {
          assert.equal(form.get('code'), 'auth-code-1');
          assert.equal((form.get('code_verifier') ?? '').length >= 43, true, 'PKCE verifier 必须足够长');
          assert.equal(form.get('resource'), `${ISSUER_BASE}/v1`, 'resource 与测试覆盖的资源标识一致');
          const now = Math.floor(Date.now() / 1000);
          const idToken = signTestJwt(signer.privateKey,
            { alg: 'RS256', kid: 'test-key', typ: 'JWT' },
            { iss: ISSUER_BASE, aud: clientId, sub: 'acc-123', email: 'user@example.com', exp: now + 3600, nonce: expectedNonce });
          lastRefreshToken = 'rt-1';
          respond(200, {
            access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600,
            scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
            id_token: idToken,
          });
          return;
        }
        if (grant === 'refresh_token') {
          assert.equal(form.get('refresh_token'), lastRefreshToken, '刷新必须用最新一轮的 refresh_token（轮换语义）');
          refreshCount += 1;
          const now = Math.floor(Date.now() / 1000);
          const idToken = signTestJwt(signer.privateKey,
            { alg: 'RS256', kid: 'test-key', typ: 'JWT' },
            { iss: ISSUER_BASE, aud: clientId, sub: 'acc-123', email: 'user@example.com', exp: now + 3600 });
          lastRefreshToken = `rt-2-${refreshCount}`;
          respond(200, {
            access_token: `at-2-${refreshCount}`, refresh_token: lastRefreshToken, expires_in: 3600,
            scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
            id_token: idToken,
          });
          return;
        }
        respond(400, { error: 'unsupported_grant_type' });
        return;
      }
      if (pathname === '/v1/models') {
        modelsAuth = req.headers.authorization;
        respond(200, {
          models: [
            { slug: 'gpt-5.1-codex', display_name: 'Codex', visibility: 'list' },
            { slug: 'internal-only', display_name: '内部', visibility: 'hidden' },
          ],
        });
        return;
      }
      if (pathname === '/revoke') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        revokedTokens.push(form.get('token') ?? '');
        respond(200, {});
        return;
      }
      respond(404, {});
    });
  });
  srv.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const addr = srv.address() as AddressInfo;
  const ISSUER_BASE = `http://127.0.0.1:${addr.port}`;
  setChatgptAuthDepsForTest({ issuerOrigin: ISSUER_BASE, resource: `${ISSUER_BASE}/v1` });

  // ChatGPT 测试用独立 dataDir（加密密钥文件不写进仓库 data/ 目录）
  const cfg: AppConfig = { ...DEFAULT_CONFIG, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-chatgpt-test-')) };
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, cfg));
  const server = await listenForTest(app);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;

  try {
    // 1. 建 ChatGPT 提供商
    const save = await fetch(`${base}/ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providers: [{ id: 'pc1', name: 'ChatGPT 订阅', baseURL: 'https://api.openai.com/v1', model: '', protocol: 'chatgpt' }],
        activeProviderId: 'pc1',
      }),
    });
    assert.equal(save.status, 200);

    // 2. 发起登录 → 校验授权 URL 的官方契约参数
    const loginRes = await fetch(`${base}/ai/chatgpt/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'pc1' }),
    });
    assert.equal(loginRes.status, 200);
    const login = (await loginRes.json()) as { loginId: string; authorizeUrl: string };
    const authorizeUrl = new URL(login.authorizeUrl);
    assert.equal(authorizeUrl.origin, ISSUER_BASE);
    assert.equal(authorizeUrl.pathname, '/api/accounts/authorize');
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(authorizeUrl.searchParams.get('agent_name_hint'), 'ICPC Workbench');
    assert.ok(authorizeUrl.searchParams.get('ext_agent_host_id'));
    assert.equal(authorizeUrl.searchParams.get('response_type'), 'code');
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok((authorizeUrl.searchParams.get('scope') ?? '').includes('chatgpt.tokens.use.direct'));
    assert.match(authorizeUrl.searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expectedNonce = authorizeUrl.searchParams.get('nonce') ?? '';
    console.error(`[CHATGPT-DBG] step2 ok redirect=${authorizeUrl.searchParams.get('redirect_uri')}`);

    // 3. 模拟浏览器回调（state 归属 + code + 签发的 client_id）
    const redirectUri = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
    const state = authorizeUrl.searchParams.get('state') ?? '';
    const cb = await fetch(`${redirectUri.origin}${redirectUri.pathname}?code=auth-code-1&client_id=client_issued_123&state=${encodeURIComponent(state)}`);
    assert.equal(cb.status, 200);

    // 4. 轮询到 ok；凭据已加密落库（settings 原文不含 token 明文）
    let pollBody: { status: string; email?: string; message?: string } | null = null;
    for (let i = 0; i < 40; i++) {
      const poll = await fetch(`${base}/ai/chatgpt/login/poll?loginId=${encodeURIComponent(login.loginId)}`);
      pollBody = (await poll.json()) as { status: string; email?: string; message?: string };
      if (pollBody.status !== 'pending') break;
      await new Promise((s) => setTimeout(s, 100));
    }
    assert.equal(pollBody?.status, 'ok', pollBody?.message);
    assert.equal(pollBody?.email, 'user@example.com');
    const rawBlob = (db.prepare("SELECT value FROM settings WHERE key = 'ai.chatgptAuth'").get() as { value: string }).value;
    assert.doesNotMatch(rawBlob, /at-1|rt-1|user@example\.com/, '凭据必须密文落库');
    const parsedBlob = JSON.parse(rawBlob) as { enc?: string };
    assert.match(parsedBlob.enc ?? '', /^\S+\.\S+\.\S+$/, '密文形态 iv.tag.data');

    // 5. 运行时解析携带解密凭据；/v1/models 用 Bearer 调用；套餐模型写入目录（hidden 过滤）
    const runtime = aiConfigFromDb(db, cfg);
    assert.equal(runtime.protocol, 'chatgpt');
    assert.equal(runtime.chatgpt?.accessToken, 'at-1');
    assert.equal(runtime.chatgpt?.clientId, 'client_issued_123');
    assert.equal(runtime.chatgpt?.accountId, 'acc-123');
    assert.match(modelsAuth ?? '', /^Bearer at-1$/);
    const view = (await (await fetch(base)).json()) as { ai: { chatgptLoggedIn?: boolean; chatgptEmail?: string; chatgpt?: unknown; providers: Array<{ id: string; model: string; models: Array<{ id: string }> }> } };
    assert.equal(view.ai.chatgptLoggedIn, true);
    assert.equal(view.ai.chatgptEmail, 'user@example.com');
    assert.equal(view.ai.chatgpt, undefined, '凭据原文绝不随视图下发');
    const pc1 = view.ai.providers.find((p) => p.id === 'pc1');
    assert.deepEqual(pc1?.models.map((m) => m.id), ['gpt-5.1-codex'], 'hidden 模型被过滤');
    assert.equal(pc1?.model, 'gpt-5.1-codex', '目录首个模型自动选用');

    // 6. 刷新（轮换）：走接线后的刷新器（强制刷新）——网络交换 + 新凭据立即落库
    const before = readChatgptCredential(db, cfg);
    assert.ok(before);
    const fresh = await ensureFreshChatgptCredential(before, { force: true });
    assert.equal(fresh.accessToken, 'at-2-1');
    assert.equal(fresh.refreshToken, 'rt-2-1');
    const after = readChatgptCredential(db, cfg);
    assert.equal(after?.refreshToken, 'rt-2-1', '轮换后的凭据必须立即落库');

    // 7. 登出：撤销 + 本地清除
    const logout = await fetch(`${base}/ai/chatgpt/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 200);
    assert.deepEqual(revokedTokens, ['rt-2-1']);
    assert.equal(readChatgptCredential(db, cfg), null);
    const status = (await (await fetch(`${base}/ai/chatgpt/status`)).json()) as { loggedIn: boolean };
    assert.equal(status.loggedIn, false);
  } finally {
    server.close();
    db.close();
    setChatgptAuthDepsForTest(null);
    srv.close();
    fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});
