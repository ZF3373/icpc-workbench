import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiProvider, type ChatMessage } from '../src/ai/provider.ts';
import type { AiConfig } from '../src/config.ts';

// ---------- 测试用 mock fetch：模拟上游 SSE 流 ----------

const CFG: AiConfig = { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };

/** 将多段 SSE data 帧编码为 ReadableStream（模拟上游流式响应） */
function makeSseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

function mockFetchFn(frames: string[], opts: { ok?: boolean } = {}): typeof fetch {
  return (async () =>
    new Response(opts.ok === false ? '' : makeSseStream(frames), {
      status: opts.ok === false ? 500 : 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch;
}

const DSML_BLOCK =
  '我来查看这个比赛和A题的内容。\n\n' +
  '<｜DSML｜tool_calls> <｜DSML｜invoke name="web_search"> ' +
  '<｜DSML｜parameter name="query" string="true">QOJ contest 4071 site:qoj.ac</｜DSML｜parameter> ' +
  '</｜DSML｜invoke> </｜DSML｜tool_calls>';

// ---------- 非流式 chat() ----------

test('chat: DSML in content stripped and parsed as tool_calls', async () => {
  let capturedBody: unknown;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: DSML_BLOCK }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  const provider = new AiProvider(CFG, fetchFn);

  let finishReason: string | null = null;
  let toolCalls: unknown;
  const content = await provider.chat(
    [{ role: 'user', content: '搜一下' }],
    { onFinish: (r, tc) => { finishReason = r; toolCalls = tc; } },
  );

  // DSML 标记已剥离，只保留正常文本
  assert.equal(content, '我来查看这个比赛和A题的内容。');
  assert.ok(!content.includes('｜DSML｜'));
  // 工具调用已从 DSML 解析
  assert.equal(finishReason, 'tool_calls');
  assert.ok(Array.isArray(toolCalls) && toolCalls.length === 1);
  const tc = (toolCalls as Array<{ function: { name: string; arguments: string } }>)[0]!;
  assert.equal(tc.function.name, 'web_search');
  assert.deepEqual(JSON.parse(tc.function.arguments), { query: 'QOJ contest 4071 site:qoj.ac' });
  // 请求体不受影响
  assert.ok((capturedBody as { messages: unknown[] }).messages);
});

test('chat: normal content without DSML passes through unchanged', async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: '这是一道贪心题。' }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
  const provider = new AiProvider(CFG, fetchFn);
  const content = await provider.chat([{ role: 'user', content: '讲解' }]);
  assert.equal(content, '这是一道贪心题。');
});

test('chat: structured tool_calls take precedence over DSML', async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: DSML_BLOCK,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'structured_search', arguments: '{"query":"test"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
  const provider = new AiProvider(CFG, fetchFn);
  let toolCalls: unknown;
  const content = await provider.chat([{ role: 'user', content: '搜' }], {
    onFinish: (_r, tc) => { toolCalls = tc; },
  });
  // DSML 从 content 剥离
  assert.equal(content, '我来查看这个比赛和A题的内容。');
  // 结构化 tool_calls 优先（不被 DSML 覆盖）
  const tc = (toolCalls as Array<{ function: { name: string } }>)[0]!;
  assert.equal(tc.function.name, 'structured_search');
});

// ---------- 流式 chatStream() ----------

test('chatStream: DSML in single chunk filtered, tool calls parsed, finish_reason overridden', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: DSML_BLOCK } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new AiProvider(CFG, mockFetchFn(frames));

  const yielded: string[] = [];
  let finishReason: string | null = null;
  let toolCalls: unknown;
  for await (const chunk of provider.chatStream([{ role: 'user', content: '搜' }], {
    onFinish: (r, tc) => { finishReason = r; toolCalls = tc; },
  })) {
    yielded.push(chunk);
  }

  const fullText = yielded.join('');
  // DSML 标记未泄漏到 yield 内容
  assert.ok(!fullText.includes('｜DSML｜'), 'DSML 标记不应出现在输出中');
  // 正常文本保留（DSML 块前的 \n\n 被保留，块本身被剥离）
  assert.ok(fullText.startsWith('我来查看这个比赛和A题的内容。'));
  // 工具调用已解析
  assert.equal(finishReason, 'tool_calls');
  const tc = (toolCalls as Array<{ function: { name: string; arguments: string } }>)[0]!;
  assert.equal(tc.function.name, 'web_search');
  assert.deepEqual(JSON.parse(tc.function.arguments), { query: 'QOJ contest 4071 site:qoj.ac' });
});

test('chatStream: DSML split across multiple chunks — buffered correctly', async () => {
  // 将 DSML 块拆成 3 段，模拟跨 chunk 到达
  const part1 = '我来查看这个比赛和A题的内容。\n\n<｜DSML｜tool_calls> <｜DSML｜invoke name="';
  const part2 = 'web_search"> <｜DSML｜parameter name="query" string="true">QOJ contest';
  const part3 = ' 4071 site:qoj.ac</｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜tool_calls>';
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: part1 } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: part2 } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: part3 } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new AiProvider(CFG, mockFetchFn(frames));

  const yielded: string[] = [];
  let finishReason: string | null = null;
  let toolCalls: unknown;
  for await (const chunk of provider.chatStream([{ role: 'user', content: '搜' }], {
    onFinish: (r, tc) => { finishReason = r; toolCalls = tc; },
  })) {
    yielded.push(chunk);
  }

  const fullText = yielded.join('');
  assert.ok(!fullText.includes('｜DSML｜'));
  assert.ok(fullText.startsWith('我来查看这个比赛和A题的内容。'));
  assert.equal(finishReason, 'tool_calls');
  assert.ok((toolCalls as Array<unknown>).length === 1);
});

test('chatStream: normal text with < in code — not falsely buffered', async () => {
  const text = '比较大小用 a < b 即可。';
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new AiProvider(CFG, mockFetchFn(frames));
  const yielded: string[] = [];
  for await (const chunk of provider.chatStream([{ role: 'user', content: '问' }])) {
    yielded.push(chunk);
  }
  // 含 < 的正常代码文本完整输出
  assert.equal(yielded.join(''), text);
});

test('chatStream: text before DSML yielded, DSML filtered, text after DSML yielded', async () => {
  const before = '这是我的回答。';
  const after = '以上就是结果。';
  const fullContent = `${before}${DSML_BLOCK}${after}`;
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: fullContent } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new AiProvider(CFG, mockFetchFn(frames));
  const yielded: string[] = [];
  for await (const chunk of provider.chatStream([{ role: 'user', content: '问' }])) {
    yielded.push(chunk);
  }
  const fullText = yielded.join('');
  assert.ok(!fullText.includes('｜DSML｜'));
  // DSML 块前后有 \n\n，剥离后保留：before + \n\n + (DSML 剥离后的干净文本) + \n\n + after
  assert.ok(fullText.startsWith(`${before}我来查看这个比赛和A题的内容。`));
  assert.ok(fullText.endsWith(after));
});

test('chatStream: structured delta.tool_calls still work alongside DSML filtering', async () => {
  const frames = [
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"query":"test"}' } }] } }],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new AiProvider(CFG, mockFetchFn(frames));
  const yielded: string[] = [];
  let finishReason: string | null = null;
  let toolCalls: unknown;
  for await (const chunk of provider.chatStream([{ role: 'user', content: '搜' }], {
    onFinish: (r, tc) => { finishReason = r; toolCalls = tc; },
  })) {
    yielded.push(chunk);
  }
  assert.equal(yielded.length, 0); // 工具调用时无 content delta
  assert.equal(finishReason, 'tool_calls');
  const tc = (toolCalls as Array<{ function: { name: string } }>)[0]!;
  assert.equal(tc.function.name, 'web_search');
});

test('chatStream: incomplete DSML at stream end —残片丢弃，不 yield 噪音', async () => {
  // DSML 块未闭合就收到 [DONE]
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '正常文本<｜DSML｜tool_calls> <｜DSML｜invoke' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new AiProvider(CFG, mockFetchFn(frames));
  const yielded: string[] = [];
  for await (const chunk of provider.chatStream([{ role: 'user', content: '问' }])) {
    yielded.push(chunk);
  }
  const fullText = yielded.join('');
  assert.equal(fullText, '正常文本'); // 未闭合的 DSML 残片被丢弃
  assert.ok(!fullText.includes('｜DSML｜'));
});
