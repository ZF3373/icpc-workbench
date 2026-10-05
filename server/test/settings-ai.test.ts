import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { aiConfigFromDb, saveAiConfig } from '../src/config.ts';

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
