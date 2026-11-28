/**
 * 「ChatGPT 登录」提供商适配层单测（Sign in with ChatGPT / Responses API）。
 *
 * fetchFn 注入桩：捕获请求体与 Authorization 头，返回构造好的 SSE 事件流
 * （Responses API 的 data 帧序列），覆盖预览期约束、事件解析、工具往返映射、
 * 额度错误友好化与临期刷新/401 重试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatgptChat, chatgptChatStream, responsesUrl } from '../src/ai/chatgptProvider.ts';
import { setChatgptCredentialRefresher, type ChatgptCredential } from '../src/ai/chatgptAuth.ts';
import type { AiConfig } from '../src/config.ts';
import type { ToolDefinition } from '../src/ai/provider.ts';

const encoder = new TextEncoder();

/** 把事件对象序列化为 Responses API 的 SSE data 帧 */
const sse = (...events: Array<Record<string, unknown>>): Response => {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(body));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
};

const cred = (overrides: Partial<ChatgptCredential> = {}): ChatgptCredential => ({
  clientId: 'client_test_issued',
  accessToken: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: Date.now() + 60 * 60_000,
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  accountId: 'acc-1',
  email: 'user@example.com',
  sessionId: 'sess-1',
  ...overrides,
});

const cfg = (overrides: Partial<AiConfig> = {}): AiConfig => ({
  enabled: true,
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-5.1-codex',
  protocol: 'chatgpt',
  chatgpt: cred(),
  ...overrides,
});

interface CapturedRequest {
  url: string;
  body?: Record<string, unknown>;
  auth?: string;
}

/** fetchFn 桩：记录每次请求（url/body/Authorization），按脚本依次回放响应 */
function fetchStub(responses: Array<Record<string, unknown>[] | Response>): { deps: { fetchFn: typeof fetch }; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const queue = responses.map((r) => (Array.isArray(r) ? sse(...r) : (r as Response)));
  const deps = {
    fetchFn: (async (input: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
      const url = String(input);
      let body: Record<string, unknown> | undefined;
      try {
        body = JSON.parse(String(init?.body));
      } catch {
        body = undefined;
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url, body, auth: headers.authorization });
      return queue.length > 0 ? (queue.shift() as Response) : new Response('no script', { status: 500 });
    }) as typeof fetch,
  };
  return { deps, requests };
}

test('responsesUrl 容忍粘贴 chat/completions、/models 结尾的地址', () => {
  assert.equal(responsesUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/responses');
  assert.equal(responsesUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/responses');
  assert.equal(responsesUrl('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/responses');
  assert.equal(responsesUrl('https://api.openai.com/v1/models'), 'https://api.openai.com/v1/responses');
  assert.equal(responsesUrl('https://api.openai.com/v1/responses'), 'https://api.openai.com/v1/responses');
});

test('请求体符合预览期约束：store:false + stream:true + instructions + 禁用字段缺席', async () => {
  const { deps, requests } = fetchStub([[
    { type: 'response.output_text.delta', delta: 'pong' },
    { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } },
  ]]);
  const text = await chatgptChat(cfg(), [
    { role: 'system', content: 'SYS-CONTENT' },
    { role: 'user', content: 'ping' },
  ], { temperature: 0.3, maxTokens: 64 }, deps);
  assert.equal(text, 'pong');
  assert.equal(requests.length, 1);
  const body = requests[0]!.body!;
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, 'gpt-5.1-codex');
  assert.equal(body.instructions, 'SYS-CONTENT');
  assert.ok(Array.isArray(body.input));
  // 预览期禁用字段绝不出现
  for (const f of ['temperature', 'top_p', 'max_output_tokens', 'metadata', 'previous_response_id', 'background']) {
    assert.equal(f in body, false, `${f} 不应出现在请求体`);
  }
  // system → instructions，user → input 数组
  const input = body.input as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  assert.deepEqual(input, [
    { role: 'user', content: [{ type: 'input_text', text: 'ping' }] },
  ]);
  assert.match(requests[0]!.auth ?? '', /^Bearer at-1$/);
});

test('system 中段映射 developer；assistant tool_calls/function_call 与 tool/function_call_output 对齐', async () => {
  const { deps, requests } = fetchStub([[
    { type: 'response.output_text.delta', delta: 'ok' },
    { type: 'response.completed', response: { usage: {} } },
  ]]);
  await chatgptChat(cfg(), [
    { role: 'system', content: 'first' },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_problem', arguments: '{"a":1}' } }] },
    { role: 'system', content: 'mid-system' },
    { role: 'tool', content: '题面内容', tool_call_id: 'call_1' },
  ], {}, deps);
  const input = requests[0]!.body!.input as Array<Record<string, unknown>>;
  assert.deepEqual(input[0], { role: 'user', content: [{ type: 'input_text', text: 'read it' }] });
  assert.deepEqual(input[1], { type: 'function_call', call_id: 'call_1', name: 'read_problem', arguments: '{"a":1}' });
  assert.deepEqual(input[2], { role: 'developer', content: [{ type: 'input_text', text: 'mid-system' }] });
  assert.deepEqual(input[3], { type: 'function_call_output', call_id: 'call_1', output: '题面内容' });
});

test('工具定义收进 namespace（预览期强制）', async () => {
  const { deps, requests } = fetchStub([[
    { type: 'response.output_text.delta', delta: 'ok' },
    { type: 'response.completed', response: { usage: {} } },
  ]]);
  const tools: ToolDefinition[] = [{
    type: 'function',
    function: { name: 'read_problem', description: '读题面', parameters: { type: 'object' } },
  }];
  await chatgptChat(cfg(), [{ role: 'user', content: 'hi' }], { tools }, deps);
  const toolsSent = requests[0]!.body!.tools as Array<Record<string, unknown>>;
  assert.equal(toolsSent.length, 1);
  assert.equal(toolsSent[0]!.type, 'namespace');
  assert.equal(toolsSent[0]!.name, 'icpc-workbench');
  const inner = toolsSent[0]!.tools as Array<Record<string, unknown>>;
  assert.equal(inner[0]!.type, 'function');
  assert.equal(inner[0]!.name, 'read_problem');
});

test('流式：正文 delta 依次 yield，reasoning 走回调，completed usage 映射为 OpenAI 口径', async () => {
  const { deps } = fetchStub([[
    { type: 'response.created', response: {} },
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking...' },
    { type: 'response.output_text.delta', delta: '你' },
    { type: 'response.output_text.delta', delta: '好' },
    {
      type: 'response.completed',
      response: {
        usage: { input_tokens: 100, output_tokens: 8, input_tokens_details: { cached_tokens: 64 } },
      },
    },
  ]]);
  const deltas: string[] = [];
  const reasoning: string[] = [];
  const usage: unknown[] = [];
  for await (const d of chatgptChatStream(cfg(), [{ role: 'user', content: 'hi' }], {
    onReasoning: (c) => reasoning.push(c),
    onUsage: (u) => usage.push(u),
  }, deps)) {
    deltas.push(d);
  }
  assert.deepEqual(deltas, ['你', '好']);
  assert.deepEqual(reasoning, ['thinking...']);
  assert.deepEqual(usage, [{
    prompt_tokens: 100,
    completion_tokens: 8,
    total_tokens: 108,
    prompt_tokens_details: { cached_tokens: 64 },
  }]);
});

test('function_call 输出项经 onFinish 以 tool_calls 语义回传（工具往返循环可用）', async () => {
  const { deps } = fetchStub([[
    { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'search_problems', arguments: '{"tag":"dp"}' } },
    { type: 'response.completed', response: { usage: {} } },
  ]]);
  let finishReason: string | null = null;
  let calls: Array<{ id: string; name: string; arguments: string }> | undefined;
  for await (const d of chatgptChatStream(cfg(), [{ role: 'user', content: 'hi' }], {
    onFinish: (r, tc) => {
      finishReason = r;
      calls = tc?.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
    },
  }, deps)) {
    void d;
  }
  assert.equal(finishReason, 'tool_calls');
  assert.deepEqual(calls, [{ id: 'call_9', name: 'search_problems', arguments: '{"tag":"dp"}' }]);
});

test('response.failed 额度用尽 → 友好提示含用量页', async () => {
  const { deps } = fetchStub([[
    {
      type: 'response.failed',
      response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit exceeded' } },
    },
  ]]);
  await assert.rejects(
    () => chatgptChat(cfg(), [{ role: 'user', content: 'hi' }], {}, deps),
    (e: Error) => /套餐额度已用尽/.test(e.message) && /chatgpt\.com\/usage/.test(e.message),
  );
});

test('顶层 error 事件 → 抛错', async () => {
  const { deps } = fetchStub([
    [{ type: 'error', code: 'server_error', message: 'boom upstream' }],
  ]);
  await assert.rejects(
    () => chatgptChat(cfg(), [{ role: 'user', content: 'hi' }], {}, deps),
    /boom upstream/,
  );
});

test('未登录 / 未选模型 → 可读错误', async () => {
  const { deps } = fetchStub([[]]);
  await assert.rejects(
    () => chatgptChat(cfg({ chatgpt: undefined }), [{ role: 'user', content: 'hi' }], {}, deps),
    /ChatGPT 未登录/,
  );
  await assert.rejects(
    () => chatgptChat(cfg({ model: '' }), [{ role: 'user', content: 'hi' }], {}, deps),
    /未选择模型/,
  );
});

test('临期凭据：请求前自动刷新并用新 token 发送（轮换后落库由刷新器负责）', async () => {
  let refreshCount = 0;
  setChatgptCredentialRefresher(async (stale) => {
    refreshCount += 1;
    assert.equal(stale.accessToken, 'at-stale');
    return { ...stale, accessToken: 'at-fresh', refreshToken: 'rt-2' };
  });
  try {
    const { deps, requests } = fetchStub([[
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { usage: {} } },
    ]]);
    const text = await chatgptChat(
      cfg({ chatgpt: cred({ accessToken: 'at-stale', expiresAt: Date.now() - 1000 }) }),
      [{ role: 'user', content: 'hi' }],
      {},
      deps,
    );
    assert.equal(text, 'ok');
    assert.equal(refreshCount, 1);
    assert.match(requests[0]!.auth ?? '', /^Bearer at-fresh$/);
  } finally {
    setChatgptCredentialRefresher(null as never);
  }
});

test('401：强制刷新一次后单次重试成功', async () => {
  let refreshCount = 0;
  setChatgptCredentialRefresher(async (stale) => {
    refreshCount += 1;
    return { ...stale, accessToken: `at-fresh-${refreshCount}` };
  });
  try {
    const { deps, requests } = fetchStub([
      new Response('{"error":{"code":"invalid_token"}}', { status: 401 }),
      [
        { type: 'response.output_text.delta', delta: 'after-401' },
        { type: 'response.completed', response: { usage: {} } },
      ],
    ]);
    const text = await chatgptChat(cfg({ chatgpt: cred({ expiresAt: Date.now() + 60 * 60_000 }) }), [{ role: 'user', content: 'hi' }], {}, deps);
    assert.equal(text, 'after-401');
    assert.equal(refreshCount, 1);
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.auth ?? '', /^Bearer at-1$/);
    assert.match(requests[1]!.auth ?? '', /^Bearer at-fresh-1$/);
  } finally {
    setChatgptCredentialRefresher(null as never);
  }
});

test('多模态：image_url data URL 映射 input_image，file 块占位说明', async () => {
  const { deps, requests } = fetchStub([[
    { type: 'response.output_text.delta', delta: 'ok' },
    { type: 'response.completed', response: { usage: {} } },
  ]]);
  await chatgptChat(cfg(), [
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
        { type: 'file', file_id: 'file-api-123' },
      ],
    },
  ] as never, {}, deps);
  const input = requests[0]!.body!.input as Array<{ content: Array<Record<string, unknown>> }>;
  const parts = input[0]!.content;
  assert.deepEqual(parts[0], { type: 'input_text', text: '看图' });
  assert.deepEqual(parts[1], { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' });
  assert.match(String(parts[2]!.text), /file-api-123/);
  assert.match(String(parts[2]!.text), /不支持 Files API/);
});

test('Responses API 层的地区封锁（HTTP 403 unsupported_country_region_territory）→ 代理配置指引', async () => {
  const { deps } = fetchStub([
    new Response(
      JSON.stringify({
        error: {
          code: 'unsupported_country_region_territory',
          message: 'Country, region, or territory not supported',
          param: null,
          type: 'request_forbidden',
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ),
  ]);
  await assert.rejects(
    () => chatgptChat(cfg(), [{ role: 'user', content: 'hi' }], {}, deps),
    (e: Error) => /unsupported_country_region_territory/.test(e.message) && /网络代理/.test(e.message),
  );
});

test('HTTP 错误体一次性消费：非 2xx 响应的错误详情进入错误消息（不再恒为空）', async () => {
  const { deps } = fetchStub([
    new Response('{"error":{"message":"upstream boom detail"}}', { status: 429, headers: { 'content-type': 'application/json' } }),
  ]);
  await assert.rejects(
    () => chatgptChat(cfg(), [{ role: 'user', content: 'hi' }], {}, deps),
    (e: Error) => /HTTP 429/.test(e.message) && /upstream boom detail/.test(e.message),
  );
});
