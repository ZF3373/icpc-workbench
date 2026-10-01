/**
 * 2026-09-30 回归：联网工具抛网络层异常（undici「fetch failed」）时，异常曾一路
 * 穿过 executeToolCall 炸进 /chat 外层 catch，整轮对话以「AI 调用失败：fetch failed」
 * 告终——而大模型第一轮已正常流出（用户看到思考 + 半截正文后报错，误以为大模型 API
 * 有问题）。修复后：路由层把工具异常转成 tool 结果消息，AI 据此降级，对话继续。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { registerTool } from '../src/ai/tools/registry.ts';
import type { AiConfig } from '../src/config.ts';
import type { ChatMessage, ChatOptions, ToolCall } from '../src/ai/provider.ts';

const CFG: AiConfig = { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };

/** 探针工具：一执行就复刻 undici 网络层失败的形态（message=fetch failed + cause） */
registerTool({
  definition: {
    type: 'function',
    function: {
      name: 'boom_probe',
      description: '测试探针：调用即抛 TypeError: fetch failed（cause: redirect count exceeded）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  execute: async () => {
    const e: Error & { cause?: unknown } = new TypeError('fetch failed');
    e.cause = new Error('redirect count exceeded');
    throw e;
  },
});

test('工具抛网络层异常 → 转 tool 结果继续对话，不再整轮报「AI 调用失败」', async () => {
  const db = createDb(':memory:');
  /** 每次 chatStream 收到的轮次（去 system），用于断言第二轮注入了工具失败结果 */
  const turns: Array<Array<{ role: string; content: string }>> = [];
  let call = 0;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/api/ai',
    aiRoutes(db, () => CFG, {
      // 赛事日历桩：/chat 会取近 14 天赛事拼 prompt，单测绝不能访问外部站点
      fetchContests: async () => ({ contests: [], failures: {} }),
      createProvider: () => ({
        enabled: true,
        chat: async () => 'ok',
        chatStream: async function* (
          messages: ChatMessage[],
          opts: ChatOptions,
        ): AsyncGenerator<string, void, void> {
          call += 1;
          turns.push(
            messages
              .slice(1)
              .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '[blocks]' })),
          );
          if (call === 1) {
            // 第一轮：不输出正文，直接请求调用探针工具（finishReason=tool_calls）
            const tc: ToolCall = {
              id: 'call_boom',
              type: 'function',
              function: { name: 'boom_probe', arguments: '{}' },
            };
            opts.onFinish?.('tool_calls', [tc]);
            return;
          }
          // 第二轮：正常收尾
          opts.onFinish?.('stop', undefined);
          yield '结论：工具读取失败，以下只给方向性提示。';
        },
      }),
    }),
  );
  const srv = await listenForTest(app);
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '蓝桥杯洛谷P9230为什么B测试点过不了' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    // 工具执行进度事件照常发给前端
    assert.ok(body.includes('"name":"boom_probe"'), `缺少工具进度事件：${body}`);
    // 核心断言：整轮对话不再以「AI 调用失败」告终
    assert.ok(!body.includes('AI 调用失败'), `工具异常不应炸掉整轮对话：${body}`);
    // 第二轮流式正文正常输出并以 [DONE] 收尾
    assert.match(body, /方向性提示/);
    assert.ok(body.includes('[DONE]'));
    // 第二轮请求注入了「工具失败」的 tool 结果（AI 能据此降级，而不是凭空编造）
    assert.equal(turns.length, 2);
    const toolMsg = turns[1]!.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '第二轮应携带 tool 结果消息');
    assert.match(toolMsg.content, /工具 boom_probe 执行失败：fetch failed（redirect count exceeded）/);
  } finally {
    srv.close();
    db.close();
  }
});
