/**
 * 统一外部请求层（adapters/http.ts）单元测试。
 * 覆盖优化方案 P1-5 的核心诉求：只有超时 → 加上有限重试（指数退避 + Retry-After），
 * 且默认不重试（保持适配器单测的单次响应语义）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, parseRetryAfter, backoffDelayMs, asHttpClient, isHttpClient } from '../src/adapters/http.ts';

/** 按序返回响应的 mock fetch，并记录每次调用的 URL */
function scripted(responses: Array<Response | Error>): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = (body = '{}'): Response => new Response(body, { status: 200 });

test('http: 默认不重试 —— 非 2xx 立即原样返回（适配器单测语义不变）', async () => {
  const { fn, calls } = scripted([new Response('', { status: 503 })]);
  const http = createHttpClient(fn);
  // 无 label：把 Response 原样交给调用方分流（适配器要自己判 302/403/504）
  const res = await http.fetch('https://x/y');
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1, '默认不重试 → 只请求一次');
});

test('http: 非 2xx 原样返回而非抛错 —— 适配器必须能自行分流 302/403', async () => {
  // 回归：曾在此抢先抛 `HTTP 302`，导致洛谷「302 = 未登录」判定被绕过、报错信息失真
  const { fn } = scripted([new Response('', { status: 302, headers: { location: '/login' } })]);
  const http = createHttpClient(fn);
  const res = await http.fetch('https://x/y', { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('http: 开启重试后 5xx 自动重试并在成功后返回', async () => {
  const { fn, calls } = scripted([
    new Response('', { status: 503 }),
    new Response('', { status: 500 }),
    ok('{"ok":true}'),
  ]);
  const http = createHttpClient(fn, { retries: 2, retryBaseMs: 0, retryMaxMs: 0 });
  const res = await http.fetch('https://x/y');
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3, '两次失败 + 一次成功');
});

test('http: 重试耗尽后返回最后一次响应', async () => {
  const { fn, calls } = scripted([new Response('', { status: 502 })]);
  const http = createHttpClient(fn, { retries: 2, retryBaseMs: 0, retryMaxMs: 0 });
  const res = await http.fetch('https://x/y');
  assert.equal(res.status, 502);
  assert.equal(calls.length, 3, '首次 + 2 次重试');
});

test('http: 4xx（非限流）不重试 —— 凭据/权限类错误重试无意义', async () => {
  const { fn, calls } = scripted([new Response('', { status: 403 })]);
  const http = createHttpClient(fn, { retries: 2, retryBaseMs: 0, retryMaxMs: 0 });
  assert.equal((await http.fetch('https://x/y')).status, 403);
  assert.equal(calls.length, 1);
});

test('http: 429 属可重试（限流）', async () => {
  const { fn, calls } = scripted([
    new Response('', { status: 429, headers: { 'retry-after': '0' } }),
    ok(),
  ]);
  const http = createHttpClient(fn, { retries: 1, retryBaseMs: 0, retryMaxMs: 0 });
  assert.equal((await http.fetch('https://x/y')).status, 200);
  assert.equal(calls.length, 2);
});

test('http: 网络异常重试，最终抛出原始错误', async () => {
  const { fn, calls } = scripted([new Error('ECONNRESET')]);
  const http = createHttpClient(fn, { retries: 1, retryBaseMs: 0, retryMaxMs: 0 });
  await assert.rejects(() => http.fetch('https://x/y'), /ECONNRESET/);
  assert.equal(calls.length, 2);
});

test('http: json() 在非 ok 时抛 `HTTP ${status}`，传 label 时用其作前缀', async () => {
  const bad = createHttpClient(scripted([new Response('', { status: 404 })]).fn);
  await assert.rejects(() => bad.json('https://x/y'), /HTTP 404/);

  const labelled = createHttpClient(scripted([new Response('', { status: 503 })]).fn);
  await assert.rejects(
    () => labelled.json('https://x/y', {}, { label: 'Codeforces API' }),
    /Codeforces API HTTP 503/,
  );
});

test('http: json() 解析响应体', async () => {
  const good = createHttpClient(scripted([ok('{"a":1}')]).fn);
  assert.deepEqual(await good.json<{ a: number }>('https://x/y'), { a: 1 });
});

test('http: 调用处 opts 覆盖客户端默认值（timeout/retries 均可局部调整）', async () => {
  const { fn, calls } = scripted([new Response('', { status: 500 })]);
  const http = createHttpClient(fn, { retries: 2, retryBaseMs: 0, retryMaxMs: 0 });
  // 调用处显式 retries: 0 → 覆盖默认的 2
  assert.equal((await http.fetch('https://x/y', {}, { retries: 0 })).status, 500);
  assert.equal(calls.length, 1);
});

test('http: recordWait 汇总退避等待耗时（供 sync_runs.waited_ms）', async () => {
  const { fn } = scripted([new Response('', { status: 503 }), ok()]);
  const http = createHttpClient(fn);
  let waited = 0;
  await http.fetch('https://x/y', {}, { retries: 1, retryBaseMs: 40, retryMaxMs: 40, recordWait: (ms) => { waited += ms; } });
  assert.ok(waited > 0, '应把退避等待计入 waitedMs');
});

test('parseRetryAfter: 支持秒数与 HTTP 日期，非法值返回 null', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('0'), 0);
  const now = Date.parse('2026-01-01T00:00:10.000Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:15 GMT', now), 5000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
});

test('backoffDelayMs: 指数增长、受上限约束、且不低于 Retry-After', () => {
  const noJitter = () => 0.5; // 固定随机数以断言确定性
  assert.equal(backoffDelayMs(1, 800, 8000, null, noJitter), 600); // exp=800 → 400+200
  assert.equal(backoffDelayMs(2, 800, 8000, null, noJitter), 1200); // exp=1600 → 800+400
  assert.ok(backoffDelayMs(10, 800, 8000, null, noJitter) <= 8000, '不超过上限');
  // Retry-After 比退避更长时以 Retry-After 为准
  assert.equal(backoffDelayMs(1, 800, 8000, 5000, noJitter), 5000);
  // Retry-After 不被 maxMs 钳制：限流窗口（30s）比本地退避上限（8s）长时必须等满，
  // 否则每次重试都撞回 429、把重试次数烧光（2026-10 审查修复）
  assert.equal(backoffDelayMs(1, 800, 8000, 30_000, noJitter), 30_000);
});

test('asHttpClient / isHttpClient: 既有 typeof fetch 注入可无感接入', () => {
  const plain = (async () => ok()) as unknown as typeof fetch;
  assert.equal(isHttpClient(plain), false);
  const wrapped = asHttpClient(plain);
  assert.equal(isHttpClient(wrapped), true);
  // 已是客户端则原样返回，不重复包装
  assert.equal(asHttpClient(wrapped), wrapped);
});
