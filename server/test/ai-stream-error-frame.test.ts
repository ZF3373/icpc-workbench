/**
 * 回归（issue 50 / issue 36 残留根因）：上游在流中途下发 SSE error 帧。
 *
 * DeepSeek 官方 API 与各类聚合网关在内容审查拦截（data_inspection_failed）、
 * 限流/鉴权失败等场景下，会在已建立的 SSE 流里发一个带 error 字段的 JSON 帧，
 * 然后正常关连接 —— [DONE] 永远不会来。旧版 provider 的帧解析只认
 * choices/usage，error 帧被「单帧解析失败跳过」的兜底吞掉，流以 done 结束、
 * onFinish(finish_reason=null) 正常返回，路由照旧写 [DONE]。
 * 用户看到的现象正是 issue 50 的现场：触发联网搜索后回复停在半截、无任何报错
 * （搜索工具结果把审查关键词带进下一轮请求 → 下一轮被 error 帧拦截）。
 *
 * 修复：帧解析识别 error 字段并抛出可读错误，路由把它写成 {error} 事件。
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

test('上游 SSE error 帧：抛出可读错误事件，不再静默当正常结束（issue 50）', async () => {
  const { db, app } = makeApp(
    CFG,
    (async () =>
      new Response(
        makeSseStream([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '回答开头' } }] })}\n\n`,
          // DeepSeek 审查拦截的真实形态：流中途 error 帧 + 正常关流（无 [DONE]）
          `data: ${JSON.stringify({ error: { message: 'data_inspection_failed', code: 4001 } })}\n\n`,
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof fetch,
  );
  const srv = await listenForTest(app);
  try {
    const body = await postChat((srv.address() as AddressInfo).port, {
      messages: [{ role: 'user', content: '随便聊聊' }],
    });
    // 已流出的正文保留
    assert.match(body, /回答开头/);
    // 核心断言：error 帧不再被吞——前端能看到明确报错而非「正常结束的半截回复」
    assert.match(body, /AI 上游在流中返回错误：data_inspection_failed/);
    assert.ok(!body.includes('[DONE]'), '出错后不应再发 [DONE]（前端会把流当正常结束）');
  } finally {
    srv.close();
    db.close();
  }
});

test('上游静默空流（无 delta 无 finish_reason）：[DONE] 前显式报错（issue 36）', async () => {
  const { db, app } = makeApp(
    CFG,
    (async () =>
      // 网关吞流形态：200 + 直接关闭的空流，什么帧都没有
      new Response(makeSseStream([]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch,
  );
  const srv = await listenForTest(app);
  try {
    const body = await postChat((srv.address() as AddressInfo).port, {
      messages: [{ role: 'user', content: '随便聊聊' }],
    });
    // 旧版：空流被当正常结束，前端渲染出一条空回复且无任何提示
    assert.match(body, /AI 未返回任何内容（上游连接异常中断）/);
    assert.ok(body.includes('[DONE]'), '错误事件后流正常收尾（前端 catch 到 error 会显示报错气泡）');
  } finally {
    srv.close();
    db.close();
  }
});
