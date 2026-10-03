/**
 * 回归：联网搜索后「自动停止」（用户报告：AI 助手在使用联网搜索后经常自动停止）。
 *
 * 路径 A（工具轮次上限耗尽后静默收尾）：DeepSeek 在 tool 结果回来后经常继续以
 * DSML 泄漏发起下一次搜索（provider 里「二轮流式避免 DeepSeek 误触发」的注释
 * 印证了这一真实形态）。工具往返循环上限 5 轮，旧版在耗尽后直接写 [DONE] ——
 * 最终回答流永远不会生成，没有错误、没有截断提示，前端表现为「我再搜一下。」
 * 之后的静默停止。修复：最后一轮强制收尾 —— 注入「直接回答」提示、关闭 DSML
 * 解析，保证一定产出一条最终回答。
 *
 * 路径 B（未闭合 DSML 残片吞掉调用）：最后一轮正文里模型泄漏的 DSML 块只有
 * 外层 tool_calls 包装没闭合（上游截断/格式错乱的常见形态），旧版把残片整体
 * 丢弃 —— 其中完整的 invoke（真实的再次搜索意图）凭空消失，模型基于「调用已
 * 发出」写下的内容也不复存在，回复静默半截停止。修复：流结束时抢救残片 ——
 * 完整 invoke 照常解析为工具调用，剩余文本剥标签后照常输出，绝不静默吞内容。
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

/** 第 1 轮：原生结构化 tool_calls（DeepSeek 正常解析路径） */
function nativeToolCallStream(): Response {
  return new Response(
    makeSseStream([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"query":"第一搜"}' } },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const SEARCH_DSML =
  '<｜DSML｜tool_calls> <｜DSML｜invoke name="web_search"> ' +
  '<｜DSML｜parameter name="query">第二搜</｜DSML｜parameter> ' +
  '</｜DSML｜invoke> </｜DSML｜tool_calls>';

/** DeepSeek 误触发形态：正文 + DSML 泄漏再次发起搜索（finish=stop） */
function dsmlLeakStream(text: string, dsml: string): Response {
  return new Response(
    makeSseStream([
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: dsml } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function makeApp(cfg: AiConfig, fetchFn: typeof fetch) {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/api/ai',
    aiRoutes(db, () => cfg, {
      // 赛事日历桩：/chat 会取近 14 天赛事拼 prompt，单测绝不能访问外部站点
      fetchContests: async () => ({ contests: [], failures: {} }),
      createProvider: () => new AiProvider(cfg, fetchFn),
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

test('工具轮次上限耗尽后：强制收尾流生成最终回答，不再 [DONE] 静默停止', async () => {
  let call = 0;
  /** 上游各次请求的消息角色序列（验证强制收尾轮注入了「直接回答」提示） */
  const requestRoles: string[][] = [];
  const { db, app } = makeApp(
    CFG,
    (async (_url: string, init: RequestInit) => {
      call += 1;
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> };
      requestRoles.push(body.messages.map((m) => m.role));
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) return nativeToolCallStream();
      // DeepSeek 误触发形态：每轮都继续要求搜索（直到被强制收尾）
      const forced = body.messages.some(
        (m) => m.role === 'user' && m.content.includes('工具调用轮次已达上限'),
      );
      if (forced) {
        return dsmlLeakStream('好的，基于已有搜索结果，最近一场比赛是本周六的 Codeforces。', '');
      }
      return dsmlLeakStream('我再搜一下。', SEARCH_DSML);
    }) as unknown as typeof fetch,
  );
  const srv = await listenForTest(app);
  try {
    const body = await postChat((srv.address() as AddressInfo).port, {
      messages: [{ role: 'user', content: '帮我查一下最近的比赛' }],
    });
    // 1 次原生 + 5 轮循环 = 上游共 6 次流；最后一次是强制收尾
    assert.equal(call, 6, `上游应共被调 6 次（1 原生 + 4 误触发 + 1 强制收尾），实际 ${call}`);
    // 强制收尾轮的请求里注入了「直接回答」提示（user 角色）
    const lastRoles = requestRoles[requestRoles.length - 1]!;
    assert.equal(lastRoles[lastRoles.length - 1], 'user', '强制收尾轮应以 user 提示收尾');
    // 核心断言：最终回答确实生成了（旧版在「我再搜一下。」之后直接 [DONE]）
    assert.match(body, /最近一场比赛是本周六的 Codeforces/);
    assert.ok(body.includes('[DONE]'));
    assert.ok(!body.includes('"error"'), '不应有错误事件');
  } finally {
    srv.close();
    db.close();
  }
});

test('未闭合 DSML 残片：其中完整 invoke 被抢救执行，后续回答正常生成', async () => {
  let call = 0;
  const { db, app } = makeApp(
    CFG,
    (async (_url: string, init: RequestInit) => {
      call += 1;
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> };
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) return nativeToolCallStream();
      if (body.messages.filter((m) => m.role === 'tool').length === 1) {
        // 第 2 轮：正文 + 只差外层闭合的 DSML（完整的 invoke 必须被抢救）
        return dsmlLeakStream('让我再确认一下。', SEARCH_DSML.replace('</｜DSML｜tool_calls>', ''));
      }
      return dsmlLeakStream('最终回答：最近的比赛是本周六。', '');
    }) as unknown as typeof fetch,
  );
  const srv = await listenForTest(app);
  try {
    const body = await postChat((srv.address() as AddressInfo).port, {
      messages: [{ role: 'user', content: '帮我查一下最近的比赛' }],
    });
    // 残片里的 invoke 被解析执行 → 有第 3 轮最终回答
    assert.equal(call, 3, `残片 invoke 应被执行（共 3 次上游调用），实际 ${call}`);
    assert.match(body, /最终回答：最近的比赛是本周六/);
    assert.ok(body.includes('[DONE]'));
    assert.ok(!body.includes('"error"'));
  } finally {
    srv.close();
    db.close();
  }
});

test('未闭合 DSML 残片（截断在参数中间）：DSML 噪音不出现在正文里', async () => {
  let call = 0;
  const { db, app } = makeApp(
    CFG,
    (async (_url: string, init: RequestInit) => {
      call += 1;
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> };
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) return nativeToolCallStream();
      // 最终轮正文写到一半泄漏了残缺 DSML（真实截断形态）
      return new Response(
        makeSseStream([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  content:
                    '根据搜索结果，最近的比赛是 Codeforces Round，细节如下<｜DSML｜tool_calls> <｜DSML｜invoke name="web_search"> <｜DSML｜parameter name="que',
                },
              },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch,
  );
  const srv = await listenForTest(app);
  try {
    const body = await postChat((srv.address() as AddressInfo).port, {
      messages: [{ role: 'user', content: '帮我查一下最近的比赛' }],
    });
    assert.ok(body.includes('[DONE]'));
    assert.ok(!body.includes('"error"'));
    // 正文里不能泄漏 DSML 标记或参数残片
    assert.ok(!body.includes('DSML'), `DSML 标记不应泄漏到正文：${body}`);
    assert.ok(!body.includes('parameter'), `参数残片不应泄漏到正文：${body}`);
    assert.match(body, /根据搜索结果，最近的比赛是 Codeforces Round/);
  } finally {
    srv.close();
    db.close();
  }
});
