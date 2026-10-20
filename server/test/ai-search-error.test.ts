/**
 * 回归（issue 50）：web_search 失败被静默吞掉。
 *
 * 旧版 executeWebSearch 在「未配置密钥 / 网络异常 / HTTP 非 200」三种失败下
 * 一律返回空数组，工具结果是一句「未返回结果」—— 模型无从分辨「搜了没搜到」
 * 和「搜索根本不可用」，会反复再搜白耗工具轮次；用户配错 Tavily key 也毫无感知
 * （表现为「触发联网搜索就出问题」）。
 *
 * 修复：executeWebSearch 返回 { results, error }，失败原因写进工具结果让模型
 * 降级回答并告知用户；成功路径与旧行为完全一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeWebSearch, formatSearchResults } from '../src/ai/search.ts';

test('未配置搜索密钥：返回带原因的 error，而非静默空结果', async () => {
  const out = await executeWebSearch('最近比赛', { searchApiKey: '' });
  assert.equal(out.results.length, 0);
  assert.match(out.error ?? '', /未配置.*密钥/);
});

test('搜索请求异常：error 带异常信息，让模型可降级回答', async () => {
  // Node fetch 对非法协议直接抛 TypeError，模拟网络层失败
  const out = await executeWebSearch('test', { searchApiKey: 'k', searchEngine: 'tavily' });
  // 无真实网络环境下该请求可能成功也可能失败；断言只约束「失败时 error 必在」
  if (out.results.length === 0) {
    assert.ok(out.error, '失败时必须给出 error 原因');
  }
});

test('HTTP 非 200（密钥无效/配额尽）：error 带状态码与提示', async () => {
  // monkey-patch 全局 fetch 模拟 Tavily 401：executeWebSearch 内部直接调用全局 fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"detail":"Invalid API key"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    const out = await executeWebSearch('test', { searchApiKey: 'bad-key' });
    assert.equal(out.results.length, 0);
    assert.match(out.error ?? '', /Tavily HTTP 401/);
    assert.match(out.error ?? '', /密钥无效/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('成功路径：结果照常返回且无 error 字段', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [
          { title: 'Codeforces', url: 'https://codeforces.com', content: 'Contest news...' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  try {
    const out = await executeWebSearch('cf', { searchApiKey: 'good-key' });
    assert.equal(out.error, undefined);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0]!.url, 'https://codeforces.com');
    const formatted = formatSearchResults('cf', out.results);
    assert.match(formatted, /返回 1 条结果/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
