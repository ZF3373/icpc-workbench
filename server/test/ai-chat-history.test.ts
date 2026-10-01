/**
 * issue 36 回归：AI 对话「没有输出 + 报错」的连锁失败。
 *
 * 现象：会话里出现一条空 assistant 轮次（模型偶发返回空回复）后，之后每一轮发送
 * 都被 /api/ai/chat 整体拒绝，报错却是「messages 必填：1-60 条 …」，用户无从自救。
 * 另外长会话（>60 轮）同样被整体拒绝。
 *
 * 这里把三类轮次的处理固定住：
 *   1. 空 assistant 轮次 → 静默丢弃（不整单拒绝，历史里留有它也能继续对话）；
 *   2. 超过 MAX_TURNS(60) → 从最早开始裁剪，并告知前端（不再 400）；
 *   3. 全部轮次为空 / 超过硬上限 → 400，且错误文案能区分原因。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import type { AiConfig } from '../src/config.ts';

const CFG: AiConfig = { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };

interface Capture {
  /** 每次上游调用收到的轮次（去掉 system） */
  turns: Array<Array<{ role: string; content: string }>>;
}

/** 挂起一个真实 HTTP 服务，provider 为桩；返回捕获到的上游轮次 */
async function withServer(
  fn: (ctx: { base: string; capture: Capture }) => Promise<void>,
  opts: { reply?: string } = {},
): Promise<void> {
  const db = createDb(':memory:');
  const capture: Capture = { turns: [] };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(
    '/api/ai',
    aiRoutes(db, () => CFG, {
      // 赛事日历桩：/chat 会取近 14 天赛事拼 prompt，单测绝不能去访问 5 个外部站点
      fetchContests: async () => ({ contests: [], failures: {} }),
      createProvider: () => ({
        enabled: true,
        chat: async () => 'ok',
        chatStream: async function* (
          messages: Array<{ role: string; content: string | unknown[] }>,
        ): AsyncGenerator<string, void, void> {
          capture.turns.push(
            messages.slice(1).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '[blocks]' })),
          );
          yield opts.reply ?? 'ok';
        },
      }),
    }),
  );
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/ai`;
  try {
    await fn({ base, capture });
  } finally {
    srv.close();
    db.close();
  }
}

async function postChat(base: string, messages: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  return { status: res.status, body: await res.text() };
}

test('issue36: 历史里的空 assistant 轮次被丢弃，不再整单 400', async () => {
  await withServer(async ({ base, capture }) => {
    const r = await postChat(base, [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '' }, // 模型零输出留下的空轮次
      { role: 'user', content: '追问' },
    ]);
    assert.equal(r.status, 200, `空轮次不应让整单失败，实际: ${r.body}`);
    assert.deepEqual(capture.turns[0], [
      { role: 'user', content: '问题' },
      { role: 'user', content: '追问' },
    ]);
  });
});

test('issue36: 空白字符（含换行/空格）的轮次同样被丢弃', async () => {
  await withServer(async ({ base, capture }) => {
    const r = await postChat(base, [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '   \n\n  ' },
      { role: 'user', content: '追问' },
    ]);
    assert.equal(r.status, 200);
    assert.equal(capture.turns[0]!.length, 2);
    assert.equal(capture.turns[0]!.every((t) => t.content.trim() !== ''), true);
  });
});

test('issue36: 全部轮次为空 → 400，并说明是内容为空而非轮次数量', async () => {
  await withServer(async ({ base }) => {
    const r = await postChat(base, [
      { role: 'user', content: '  ' },
      { role: 'assistant', content: '' },
    ]);
    assert.equal(r.status, 400);
    assert.match(r.body, /无有效内容/);
    assert.doesNotMatch(r.body, /1-60/);
  });
});

test('issue36: 超过 60 轮的长会话 → 200 且只发最后 60 轮，并告知裁剪条数', async () => {
  await withServer(async ({ base, capture }) => {
    const messages = Array.from({ length: 70 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第${i}轮`,
    }));
    const r = await postChat(base, messages);
    assert.equal(r.status, 200, `长会话不应被拒绝，实际: ${r.body}`);
    const sent = capture.turns[0]!;
    assert.equal(sent.length, 60);
    // 丢的是最早的 10 条：第 10 轮（下标 10，assistant）成为首条
    assert.equal(sent[0]!.content, '第10轮');
    assert.equal(sent[59]!.content, '第69轮');
    // 前端要靠事件提示「已自动裁剪最早的 N 条」：裁剪条数 >= 摘要阈值时走摘要事件
    assert.match(r.body, /"summarized":true,"droppedCount":10|"contextTrimmed":10/);
  });
});

test('issue36: 轮次超过硬上限 → 400 且文案指向数量', async () => {
  await withServer(async ({ base }) => {
    const messages = Array.from({ length: 1001 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `第${i}轮`,
    }));
    const r = await postChat(base, messages);
    assert.equal(r.status, 400);
    assert.match(r.body, /轮次过多/);
  });
});

test('issue36: 结构非法仍然 400（role/content 类型错误不被空轮次过滤掩盖）', async () => {
  await withServer(async ({ base }) => {
    const badRole = await postChat(base, [{ role: 'system', content: 'hi' }]);
    assert.equal(badRole.status, 400);
    const badContent = await postChat(base, [{ role: 'user', content: 123 }]);
    assert.equal(badContent.status, 400);
    assert.match(badContent.body, /content 必须为字符串/);
  });
});

test('issue36: 纯附件 user 轮次（content 为空）不被当成空轮次丢弃', async () => {
  await withServer(async ({ base, capture }) => {
    const r = await postChat(base, [
      { role: 'user', content: '', attachments: [{ fileId: 'file-api-1', filename: 'a.png' }] },
      { role: 'assistant', content: '看这张图' },
      { role: 'user', content: '继续' },
    ]);
    assert.equal(r.status, 200, r.body);
    const sent = capture.turns[0]!;
    assert.equal(sent.length, 3, '纯图片提问必须保留');
  });
});
