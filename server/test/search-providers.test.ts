import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEngineKeys, parseSearchProvidersConfig } from '../../shared/src/index.ts';
import { aiConfigFromDb, DEFAULT_CONFIG } from '../src/config.ts';
import { createDb } from '../src/db/index.ts';
import { executeWebSearch, hasSearchChannel, resolveSearchProviders } from '../src/ai/search.ts';
import { executeFetchUrl, setDnsLookupForTest } from '../src/ai/fetch-url.ts';
import { benchEngineKey, buildAttempts, cooldownFor, engineAdapter, SearchEngineError, resetEngineCooldownsForTest, type SearchProviderEntry } from '../src/ai/search-engines.ts';

const originalFetch = globalThis.fetch;
const originalEnv = process.env.SEARCH_API_KEY;
beforeEach(() => {
  delete process.env.SEARCH_API_KEY;
  resetEngineCooldownsForTest();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) delete process.env.SEARCH_API_KEY;
  else process.env.SEARCH_API_KEY = originalEnv;
  resetEngineCooldownsForTest();
  setDnsLookupForTest(null);
});

test('Key 输入按行归一、去重并限制最多 20 个', () => {
  assert.deepEqual(normalizeEngineKeys(' a \r\n b\n\n a \n'), ['a', 'b']);
  assert.deepEqual(normalizeEngineKeys([' a ', 'b', 'a', '', 42]), ['a', 'b']);
  const keys = Array.from({ length: 25 }, (_, i) => `key-${i}`);
  assert.deepEqual(normalizeEngineKeys(keys), keys.slice(0, 20));
});

test('配置解析保留未启用引擎的 Key，丢弃未知引擎，坏 JSON 视为未配置', () => {
  assert.deepEqual(parseSearchProvidersConfig(JSON.stringify({
    order: ['brave', 'unknown', 'brave', 'anysearch'],
    keys: { tavily: [' saved '], brave: 'a\na', unknown: ['bad'] },
  })), { order: ['brave', 'anysearch'], keys: { tavily: ['saved'], brave: ['a'] } });
  assert.equal(parseSearchProvidersConfig('{broken'), undefined);
  assert.equal(parseSearchProvidersConfig('null'), undefined);
  assert.deepEqual(parseSearchProvidersConfig('{"order":[],"keys":{}}'), { order: [], keys: {} });
});

test('运行时从 DB 解析 order × keys，显式空 order 仍保留新模式', () => {
  const db = createDb(':memory:');
  try {
    const put = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    put.run('ai.searchApiKey', 'legacy');
    assert.equal(aiConfigFromDb(db, DEFAULT_CONFIG).searchProviders, undefined);
    put.run('ai.searchProviders', JSON.stringify({ order: ['brave', 'anysearch'], keys: { brave: ['one', 'two'], tavily: ['inactive'] } }));
    assert.deepEqual(aiConfigFromDb(db, DEFAULT_CONFIG).searchProviders, [
      { engine: 'brave', keys: ['one', 'two'] }, { engine: 'anysearch', keys: [] },
    ]);
    put.run('ai.searchProviders', '{"order":[],"keys":{}}');
    assert.deepEqual(resolveSearchProviders(aiConfigFromDb(db, DEFAULT_CONFIG)), []);
    put.run('ai.searchProviders', '{broken');
    assert.deepEqual(resolveSearchProviders(aiConfigFromDb(db, DEFAULT_CONFIG)), [{ engine: 'tavily', keys: ['legacy'] }]);
  } finally { db.close(); }
});

test('遗留单引擎回退，新模式含显式空数组优先，缺 Key 的非匿名渠道不可用', () => {
  assert.deepEqual(resolveSearchProviders({ searchEngine: 'brave', searchApiKey: ' old ' }), [{ engine: 'brave', keys: ['old'] }]);
  assert.deepEqual(resolveSearchProviders({ searchApiKey: 'old', searchProviders: [] }), []);
  assert.deepEqual(resolveSearchProviders({ searchApiKey: 'old', searchProviders: [
    { engine: 'tavily', keys: [' ', ''] }, { engine: 'anysearch', keys: [] },
  ] }), [{ engine: 'anysearch', keys: [] }]);
  assert.equal(hasSearchChannel({ searchProviders: [{ engine: 'brave', keys: [] }] }), false);
  const attempts = buildAttempts([{ engine: 'anysearch', keys: [] }], 'search');
  assert.deepEqual(attempts.map(({ engine, key }) => [engine.id, key]), [['anysearch', '']]);
});

test('环境变量只追加为兜底，避免重复 Key 且不修改调用方配置', () => {
  process.env.SEARCH_API_KEY = ' env-key ';
  const entries: SearchProviderEntry[] = [{ engine: 'brave', keys: ['b'] }];
  assert.deepEqual(resolveSearchProviders({ searchProviders: entries }), [
    { engine: 'brave', keys: ['b'] }, { engine: 'tavily', keys: ['env-key'] },
  ]);
  assert.deepEqual(entries, [{ engine: 'brave', keys: ['b'] }]);
  assert.deepEqual(resolveSearchProviders({ searchProviders: [{ engine: 'tavily', keys: ['env-key'] }] }), [
    { engine: 'tavily', keys: ['env-key'] },
  ]);
});

test('已有 Tavily 时环境变量 Key 仍在所有用户渠道之后尝试', () => {
  process.env.SEARCH_API_KEY = 'env-key';
  const entries: SearchProviderEntry[] = [{ engine: 'tavily', keys: ['saved'] }, { engine: 'brave', keys: ['brave'] }];
  assert.deepEqual(buildAttempts(resolveSearchProviders({ searchProviders: entries }), 'search').map(({ engine, key }) => [engine.id, key]), [
    ['tavily', 'saved'], ['brave', 'brave'], ['tavily', 'env-key'],
  ]);
  assert.deepEqual(entries[0]?.keys, ['saved']);
});

test('429 限频与配额冷却分开，并在冷却过期后恢复原顺序', (t) => {
  assert.equal(cooldownFor(new SearchEngineError('rate limit exceeded', 429), 'search'), 120000);
  assert.equal(cooldownFor(new SearchEngineError('monthly quota exceeded', 429), 'search'), 1800000);
  assert.equal(cooldownFor(new SearchEngineError('no access', 403), 'fetch'), undefined);
  assert.equal(cooldownFor(new SearchEngineError('unauthorized', 401), 'search'), 1800000);
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const entries: SearchProviderEntry[] = [{ engine: 'tavily', keys: ['a'] }, { engine: 'brave', keys: ['b'] }];
  benchEngineKey(engineAdapter('tavily')!, 'a', new SearchEngineError('rate limit exceeded', 429), 'search');
  assert.deepEqual(buildAttempts(entries, 'search').map(({ engine }) => engine.id), ['brave', 'tavily']);
  now += 120001;
  assert.deepEqual(buildAttempts(entries, 'search').map(({ engine }) => engine.id), ['tavily', 'brave']);
});

test('聚合失败原因与日志打码上游回显的 Key，并区分同引擎各 Key', async (t) => {
  const keys = ['first-secret-key-12345', 'second-secret-key-67890'];
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  globalThis.fetch = async (_url, init) => new Response(`Invalid API key ${JSON.parse(String(init?.body)).api_key}`, { status: 401 });
  const result = await executeWebSearch('news', { searchProviders: [{ engine: 'tavily', keys }] });
  assert.match(result.error ?? '', /2 个渠道均失败/);
  assert.match(result.error ?? '', /firs…345/);
  assert.match(result.error ?? '', /seco…890/);
  for (const key of keys) {
    assert.equal(result.error?.includes(key), false);
    assert.equal(JSON.stringify(logs).includes(key), false);
  }
});

test('抓取重试遇到 401 时也冷却该 Key，下次优先其他渠道', async () => {
  const entries: SearchProviderEntry[] = [{ engine: 'tavily', keys: ['bad'] }, { engine: 'jina', keys: ['good'] }];
  let tavilyCalls = 0;
  globalThis.fetch = async (url) => {
    if (new URL(String(url)).hostname === 'api.tavily.com') {
      return new Response('', { status: ++tavilyCalls === 1 ? 503 : 401 });
    }
    return new Response('Title: Example\nMarkdown Content:\nUseful content');
  };
  const result = await executeFetchUrl('https://example.com', { searchProviders: entries });
  assert.equal(result.error, undefined);
  assert.equal(tavilyCalls, 2);
  assert.deepEqual(buildAttempts(entries, 'fetch').map(({ engine }) => engine.id), ['jina', 'tavily']);
});

test('抓取正文净化后为空仍继续下一引擎', async () => {
  globalThis.fetch = async (url) => new URL(String(url)).hostname === 'api.tavily.com'
    ? Response.json({ results: [{ raw_content: 'Codeforces navigation only' }] })
    : new Response('A. Problem\nValid problem statement');
  const result = await executeFetchUrl('https://codeforces.com/contest/1/problem/A', { searchProviders: [
    { engine: 'tavily', keys: ['a'] }, { engine: 'jina', keys: ['b'] },
  ] });
  assert.equal(result.content, 'A. Problem\nValid problem statement');
});

test('Tavily 401 后 Brave 成功，坏 Key 冷却后移到链尾而非删除', async () => {
  const entries: SearchProviderEntry[] = [{ engine: 'tavily', keys: ['bad-key'] }, { engine: 'brave', keys: ['good-key'] }];
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    calls.push(host);
    if (host === 'api.tavily.com') return new Response('invalid key', { status: 401 });
    if (host === 'api.search.brave.com') return Response.json({ web: { results: [{ url: 'https://example.com/news', title: 'News', description: 'x'.repeat(600) }] } });
    throw new Error(`unexpected URL: ${url}`);
  };
  const result = await executeWebSearch('news', { searchProviders: entries });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.results, [{ url: 'https://example.com/news', title: 'News', snippet: 'x'.repeat(500) }]);
  assert.deepEqual(calls, ['api.tavily.com', 'api.search.brave.com']);
  assert.deepEqual(buildAttempts(entries, 'search').map(({ engine }) => engine.id), ['brave', 'tavily']);
});

test('同引擎多 Key 按序尝试，空结果不能终止链条', async () => {
  const keys: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const key = JSON.parse(String(init?.body)).api_key as string;
    keys.push(key);
    return Response.json({ results: key === 'second' ? [{ url: 'https://example.com', content: 'found' }] : [] });
  };
  const result = await executeWebSearch('news', { searchProviders: [{ engine: 'tavily', keys: ['first', 'second'] }] });
  assert.equal(result.results[0]?.snippet, 'found');
  assert.deepEqual(keys, ['first', 'second']);
});

test('Tavily extract 401 后 Jina Reader 成功，按引擎链抓取', async () => {
  const calls: string[] = [];
  setDnsLookupForTest(async () => [{ address: '93.184.216.34' }]);
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.hostname);
    if (u.hostname === 'api.tavily.com') return new Response('unauthorized', { status: 401 });
    if (u.hostname === 'r.jina.ai') return new Response('Title: Example\nMarkdown Content:\nUseful content');
    throw new Error(`unexpected URL: ${url}`);
  };
  const result = await executeFetchUrl('https://example.com/article', { searchProviders: [
    { engine: 'tavily', keys: ['bad'] }, { engine: 'jina', keys: ['good'] },
  ] }, undefined, async () => new Response('unexpected direct fetch', { status: 502 }));
  assert.equal(result.error, undefined);
  assert.equal(result.title, 'Example');
  assert.match(result.content, /Useful content/);
  assert.deepEqual(calls, ['api.tavily.com', 'r.jina.ai']);
});

test('AnySearch 抓取 401 不重复尝试，继续直连兜底', async () => {
  let engineCalls = 0;
  globalThis.fetch = async () => { engineCalls++; return new Response('unauthorized', { status: 401 }); };
  setDnsLookupForTest(async () => [{ address: '93.184.216.34' }]);
  const result = await executeFetchUrl('https://example.com', { searchProviders: [{ engine: 'anysearch', keys: ['bad'] }] }, undefined,
    async () => new Response('<head><title>Direct</title></head><p>Direct content</p>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(result.title, 'Direct');
  assert.equal(result.content, 'Direct content');
  assert.equal(engineCalls, 1);
});
