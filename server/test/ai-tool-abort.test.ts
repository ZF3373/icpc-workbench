/**
 * 回归：**工具执行期间**用户点「停止」时不得再发起新一轮生成。
 *
 * 旧实现的缺口：轮次顶部的 aborted 检查只在每轮开始时生效、工具循环里的检查只覆盖
 * 「下一个工具」，若停止恰好落在**最后一个工具执行中**（web_search / fetch_url 单个就可能
 * 耗十几秒 —— 正是用户最可能点停止的时刻），内层退出后控制流仍会走到下一轮的 chatStream，
 * 带着**已经 aborted** 的 signal；而 provider 只在 signal 上挂监听、不检查注册时是否已 abort，
 * 已 aborted 信号的监听器永不触发 → 照常发出完整一轮上游生成（白白烧配额，与本次修复
 * 「点停止后不再发起后续轮次」的目标相悖）。
 *
 * 本文件用注册一个「慢工具」的方式把停点精确落在工具执行窗口内（路由在执行前会先推
 * `tool` 事件，客户端读到它即点停止），断言上游只被调用过一次。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { AiProvider } from '../src/ai/provider.ts';
import { registerTool } from '../src/ai/tools/registry.ts';
import type { AiConfig } from '../src/config.ts';

const CFG: AiConfig = { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };
const SLOW_TOOL = 'slow_test_tool';

/** 注册一个耗时 600ms 的测试工具：把「停止」精确落在工具执行窗口内 */
registerTool({
  definition: {
    type: 'function',
    function: {
      name: SLOW_TOOL,
      description: '测试用慢工具',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    },
  },
  execute: async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { content: '慢工具结果' };
  },
});

/** 第 1 轮：原生结构化 tool_calls（请求 slow_test_tool） */
function toolCallStream(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [
                { index: 0, id: 'call_slow', function: { name: SLOW_TOOL, arguments: '{"q":"x"}' } },
              ],
            },
          }],
        })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/** 后续轮：正常的一段流式回答（若被调用则说明中断没生效） */
function answerStream(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '第二轮生成不该发生' } }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

test('工具执行中点停止：不发起下一轮上游生成（回归）', async () => {
  let calls = 0;
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/api/ai',
    aiRoutes(db, () => CFG, {
      fetchContests: async () => ({ contests: [], failures: {} }),
      createProvider: () =>
        new AiProvider(CFG, (async () => {
          calls += 1;
          return calls === 1 ? toolCallStream() : answerStream();
        }) as unknown as typeof fetch),
    }),
  );
  const srv = await listenForTest(app);
  try {
    const port = (srv.address() as AddressInfo).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '走工具' }] }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // 读到 `tool` 事件：此刻工具刚开始执行（耗时 600ms），用户在这里点「停止」
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (decoder.decode(value).includes('"tool"')) break;
    }
    assert.equal(calls, 1, '读到工具事件时上游只应被调过 1 次');
    ac.abort();
    await reader.cancel().catch(() => {});

    // 工具 600ms + 余量：修复后工具执行完即发现 aborted 收尾，不会再有第 2 次上游调用
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(calls, 1, '停止后不得再发起新一轮上游生成');
  } finally {
    srv.close();
    db.close();
  }
});
