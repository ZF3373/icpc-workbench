/**
 * 回归：AI 助手触发联网搜索/读题后「卡住然后直接结束」（issue 50）。
 *
 * 三个根因，三个测试面：
 *
 * A. DSML 双竖线方言穿透过滤器：issue 50 现场（DeepSeek-V4.1-Flash / deepseek-flash，
 *    0.5.6）截图显示模型把工具调用以 `<｜｜DSML｜｜calls>`（全角双竖线、外层标签省略
 *    tool_ 前缀、parameter 带 string="true" 类型标注）泄漏进 content；旧过滤器只认
 *    单竖线 `<｜DSML｜tool_calls>`，整块标记原样漏进正文，前端还把它渲染了出来。
 *    修复：分隔条统一按 [丨|｜]+ 匹配、标签名 calls/tool_calls 互相兼容，开标签
 *    泛化为任意完整 DSML 标签（裸 invoke 块同样拦截）。
 *
 * B. 工具轮次未回传 reasoning_content：DeepSeek 思考模式官方要求「请求携带 tools 时，
 *    前序轮次的 reasoning_content 必须完整回传，否则 API 返回 400」。旧版第二轮请求
 *    里 assistant 消息只有空 content + tool_calls → 第二轮被上游拒绝 → 上游以
 *    error 帧返回 →（配合根因 C）静默收流 → 前端看到回复戛然而止。修复：路由按轮次
 *    累积思维链与正文，构造 assistant 消息时整体回传。
 *
 * C. SSE 流内 error 帧被静默丢弃：旧版帧解析只看 choices/usage，`{"error":...}` 帧
 *    整帧丢弃、连接关闭后被当「正常结束」，不产生任何错误事件。修复：识别 error 帧
 *    并抛出可读错误（路由写给前端），非流式响应体同理。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { AiProvider } from '../src/ai/provider.ts';
import type { AiConfig } from '../src/config.ts';

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

function sseResponse(frames: string[]): Response {
  return new Response(makeSseStream(frames), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function makeApp(fetchFn: typeof fetch) {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/api/ai',
    aiRoutes(db, () => CFG, {
      fetchContests: async () => ({ contests: [], failures: {} }),
      createProvider: () => new AiProvider(CFG, fetchFn),
    }),
  );
  return { db, app };
}

async function postChat(port: number, body: unknown): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.text();
}

/** issue 50 截图现场的双竖线 DSML 泄漏块（fetch_url 抓 abc480 题面） */
const DOUBLE_BAR_DSML =
  '<｜｜DSML｜｜calls>\n' +
  '<｜｜DSML｜｜invoke name="fetch_url">\n' +
  '<｜｜DSML｜｜parameter name="url" string="true">https://atcoder.jp/contests/abc480/tasks/abc480_a</｜｜DSML｜｜parameter>\n' +
  '</｜｜DSML｜｜invoke>\n' +
  '</｜｜DSML｜｜calls>';

test('A: 双竖线 DSML 泄漏被过滤并解析为工具调用，标记不再漏进正文', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '我先把题面取回来。' + DOUBLE_BAR_DSML } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new AiProvider(CFG, (async () => sseResponse(frames)) as unknown as typeof fetch);

  const yielded: string[] = [];
  let finishReason: string | null = null;
  let toolCalls: Array<{ function: { name: string; arguments: string } }> | undefined;
  for await (const chunk of provider.chatStream([{ role: 'user', content: 'x' }], {
    onFinish: (r, tc) => { finishReason = r; toolCalls = tc; },
  })) {
    yielded.push(chunk);
  }
  const text = yielded.join('');
  // 标记不泄漏（旧版整块漏进正文，前端渲染出原始 invoke/parameter 标签）
  assert.ok(!text.includes('DSML'), `DSML 标记不应出现在正文：${text}`);
  assert.ok(!text.includes('invoke'), `invoke 标签不应出现在正文：${text}`);
  assert.ok(!text.includes('atcoder.jp'), `URL 参数值不应出现在正文：${text}`);
  // 正文保留
  assert.ok(text.includes('我先把题面取回来。'));
  // 泄漏块被解析为结构化工具调用（fetch_url + url 参数）
  assert.equal(finishReason, 'tool_calls');
  assert.ok(toolCalls && toolCalls.length === 1, `应解析出 1 个工具调用，实际 ${toolCalls?.length ?? 0}`);
  assert.equal(toolCalls![0]!.function.name, 'fetch_url');
  assert.deepEqual(JSON.parse(toolCalls![0]!.function.arguments), {
    url: 'https://atcoder.jp/contests/abc480/tasks/abc480_a',
  });
});

test('A: 双竖线标记跨 SSE 帧拆开（切在标记中间）也能正确缓冲', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '开始<｜｜DSML｜｜ca' } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { content: 'lls><｜｜DSML｜｜invoke name="web_search"><｜｜DSML｜｜parameter name="query" string="true">q</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>结束' } }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new AiProvider(CFG, (async () => sseResponse(frames)) as unknown as typeof fetch);
  const yielded: string[] = [];
  let toolCalls: Array<{ function: { name: string; arguments: string } }> | undefined;
  for await (const chunk of provider.chatStream([{ role: 'user', content: 'x' }], {
    onFinish: (_r, tc) => { toolCalls = tc; },
  })) {
    yielded.push(chunk);
  }
  const text = yielded.join('');
  assert.equal(text, '开始结束');
  assert.ok(toolCalls?.length === 1);
  assert.equal(toolCalls![0]!.function.name, 'web_search');
  assert.deepEqual(JSON.parse(toolCalls![0]!.function.arguments), { query: 'q' });
});

test('B: 工具轮次回传 reasoning_content 与实际正文（DeepSeek 思考模式要求）', async () => {
  const captured: Array<{ role: string; content: string; reasoning_content?: string; tool_calls?: unknown[] }> = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string; reasoning_content?: string; tool_calls?: unknown[] }> };
    const hasToolResult = body.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      // 第一轮：思考 + 正文 + 原生结构化 tool_calls（DeepSeek 思考模式形态）
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '用户想查比赛，我需要搜索。' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: '我来查一下。' } }] })}\n\n`,
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"query":"codeforces"}' } }] } }],
        })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }
    // 第二轮：捕获请求里的 assistant 消息，验证回传
    for (const m of body.messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) captured.push(m);
    }
    return sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '最近的比赛是 Codeforces Round。' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }) as unknown as typeof fetch;

  const { db, app } = makeApp(fetchFn);
  const srv = await listenForTest(app);
  try {
    const body = await postChat((srv.address() as AddressInfo).port, {
      messages: [{ role: 'user', content: '帮我查一下最近的比赛' }],
    });
    assert.match(body, /最近的比赛是 Codeforces Round/);
    assert.ok(body.includes('[DONE]'));
    // 第二轮请求里的 assistant tool_calls 消息：reasoning_content 与正文都已回传
    assert.equal(captured.length, 1, '第二轮请求应含 1 条 assistant tool_calls 消息');
    const msg = captured[0]!;
    assert.equal(msg.reasoning_content, '用户想查比赛，我需要搜索。', 'reasoning_content 必须回传（DeepSeek 思考模式要求）');
    assert.equal(msg.content, '我来查一下。', '工具调用同轮的正文应按原文回传');
  } finally {
    srv.close();
    db.close();
  }
});

test('B: 客户端回传的历史 reasoning 透传到上游请求', async () => {
  let sawReasoning = false;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; reasoning_content?: string }> };
    sawReasoning = body.messages.some((m) => m.role === 'assistant' && m.reasoning_content === '历史思维链');
    return sseResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '好的。' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }) as unknown as typeof fetch;
  const { db, app } = makeApp(fetchFn);
  const srv = await listenForTest(app);
  try {
    const body = await postChat((srv.address() as AddressInfo).port, {
      messages: [
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '第一答', reasoning: '历史思维链' },
        { role: 'user', content: '第二问' },
      ],
    });
    assert.match(body, /好的。/);
    assert.ok(sawReasoning, '历史 assistant 轮次的 reasoning 应透传到上游请求');
  } finally {
    srv.close();
    db.close();
  }
});

test('C: 上游流内 error 帧抛出可读错误，不再静默收流', async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`,
    `data: ${JSON.stringify({ error: { message: 'Invalid request: reasoning_content of previous turns is required', code: 400 } })}\n\n`,
  ];
  const provider = new AiProvider(CFG, (async () => sseResponse(frames)) as unknown as typeof fetch);
  await assert.rejects(
    (async () => {
      for await (const _ of provider.chatStream([{ role: 'user', content: 'x' }])) { void _; }
    })(),
    /reasoning_content of previous turns/,
    'error 帧应抛出含上游错误信息的异常',
  );
});

test('C: 整链路——工具轮 error 帧经路由透传为前端 error 事件（不静默结束）', async () => {
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string }> };
    if (!body.messages.some((m) => m.role === 'tool')) {
      // 第一轮：发起 web_search
      return sseResponse([
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"query":"q"}' } }] } }],
        })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }
    // 第二轮：上游以 error 帧拒绝（DeepSeek 思考模式缺 reasoning_content 的 400 形态）
    return sseResponse([
      `data: ${JSON.stringify({ error: { message: 'Invalid request: 400', type: 'invalid_request_error' } })}\n\n`,
    ]);
  }) as unknown as typeof fetch;
  const { db, app } = makeApp(fetchFn);
  const srv = await listenForTest(app);
  try {
    const body = await postChat((srv.address() as AddressInfo).port, {
      messages: [{ role: 'user', content: '帮我查一下' }],
    });
    // 前端必须收到 error 事件而不是「正常结束」的 [DONE]
    assert.ok(body.includes('"error"'), `应包含 error 事件：${body}`);
    assert.match(body, /AI 调用失败/);
  } finally {
    srv.close();
    db.close();
  }
});
