import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { todayRoutes } from '../src/routes/today.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import type { AiConfig } from '../src/config.ts';

const AI_DISABLED: AiConfig = { enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm' };

interface TestServer {
  db: Db
  aiBase: string
  todayBase: string
  providerChats: Array<{ system: string; messages: Array<{ role: string; content: string }> }>
}

async function withServer(
  fn: (s: TestServer) => Promise<void>,
  provider?: { enabled: boolean; reply: string | ((prompt: string) => string) },
): Promise<void> {
  const db = createDb(':memory:');
  const providerChats: Array<{ system: string; messages: Array<{ role: string; content: string }> }> = [];
  const app = express();
  app.use(express.json());
  const cfg = provider ? { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' } : AI_DISABLED;
  app.use(
    '/api/ai',
    aiRoutes(db, () => cfg, {
      createProvider: provider
        ? () => ({
            enabled: provider.enabled,
            chat: async (messages) => {
              providerChats.push({ system: messages[0]?.content ?? '', messages: messages.slice(1) as Array<{ role: string; content: string }> });
              const prompt = messages[messages.length - 1]?.content ?? '';
              return typeof provider.reply === 'function' ? provider.reply(prompt) : provider.reply;
            },
          })
        : undefined,
    }),
  );
  app.use('/api/today', todayRoutes(db));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const root = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn({ db, aiBase: `${root}/api/ai`, todayBase: `${root}/api/today`, providerChats });
  } finally {
    srv.close();
    db.close();
  }
}

function seedAc(db: Db, difficulty: number): void {
  insertNormalized(db, DEFAULT_USER_ID, [
    {
      problem: { platform: 'codeforces', problemKey: `${difficulty}`, title: `P${difficulty}`, tags: [], difficulty },
      verdict: 'AC',
      submittedAt: '2026-08-01T00:00:00.000Z',
      externalId: `ac-${difficulty}`,
    },
  ]);
}

// ---------- 能力值 ----------

test('ability: computed fallback 1200, override apply/reset, invalid level rejected', async () => {
  await withServer(async ({ aiBase }) => {
    const empty = (await (await fetch(`${aiBase}/ability`)).json()) as { computed: number; effective: number; override: unknown };
    assert.equal(empty.computed, 1200);
    assert.equal(empty.effective, 1200);
    assert.equal(empty.override, null);

    const bad = await fetch(`${aiBase}/ability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 1850 }), // 非 100 整数倍
    });
    assert.equal(bad.status, 400);

    const applied = (await (
      await fetch(`${aiBase}/ability`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 1900, reason: '近期稳定 AC 1900' }),
      })
    ).json()) as { effective: number; override: { level: number; reason: string } | null };
    assert.equal(applied.effective, 1900);
    assert.equal(applied.override?.level, 1900);
    assert.match(applied.override?.reason ?? '', /1900/);

    const reset = (await (
      await fetch(`${aiBase}/ability`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reset: true }),
      })
    ).json()) as { effective: number; override: unknown };
    assert.equal(reset.effective, 1200);
    assert.equal(reset.override, null);
  });
});

test('ability: today route uses override over computed', async () => {
  await withServer(async ({ db, aiBase, todayBase }) => {
    // 5 道 1500 AC → 计算值 1500
    for (let i = 0; i < 5; i += 1) seedAc(db, 1500);
    const before = (await (await fetch(todayBase)).json()) as { level: number; levelComputed: number; levelOverride: unknown };
    assert.equal(before.levelComputed, 1500);
    assert.equal(before.level, 1500);
    assert.equal(before.levelOverride, null);

    await fetch(`${aiBase}/ability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 2000, reason: 'AI 调整' }),
    });
    const after = (await (await fetch(todayBase)).json()) as { level: number; levelComputed: number; levelOverride: { level: number } | null };
    assert.equal(after.levelComputed, 1500);
    assert.equal(after.level, 2000); // 生效值 = AI 调整
    assert.equal(after.levelOverride?.level, 2000);
  });
});

test('ability evidence: rendered into assistant prompt with percentiles/detail/guidance', async () => {
  await withServer(
    async ({ db, aiBase, providerChats }) => {
      // 近 60 天内 10 道已知难度 AC（其中一道 2300 拉高证据）
      for (let i = 0; i < 10; i += 1) {
        insertNormalized(db, DEFAULT_USER_ID, [
          {
            problem: { platform: 'codeforces', problemKey: `k${i}`, title: `P${i}`, tags: [], difficulty: 1500 + i * 80 },
            verdict: 'AC',
            submittedAt: new Date(Date.now() - (i + 1) * 86_400_000).toISOString(),
            externalId: `e-${i}`,
          },
        ]);
      }
      const res = await fetch(`${aiBase}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '帮我评估能力值' }] }),
      });
      assert.equal(res.status, 200);
      const system = providerChats[0]!.system;
      assert.match(system, /能力评估数据/); // 证据段
      assert.match(system, /近 60 天 AC 10 题/); // 分位/计数
      assert.match(system, /难度分布（200 分一档）/); // 直方图
      assert.match(system, /最近 AC（新→旧）/); // 明细
      assert.match(system, /独立判断/); // 主动评估指引
      assert.doesNotMatch(system, /证据不足：不要建议调整/); // 空样本专属文案不应出现
      void db;
    },
    { enabled: true, reply: 'ok' },
  );
});

test('ability evidence: empty recent AC renders guidance instead of evidence', async () => {
  await withServer(
    async ({ aiBase, providerChats }) => {
      const res = await fetch(`${aiBase}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '评估能力值' }] }),
      });
      assert.equal(res.status, 200);
      const system = providerChats[0]!.system;
      assert.match(system, /证据不足/); // 明确引导不调整
      assert.doesNotMatch(system, /难度分布（200 分一档）/);
    },
    { enabled: true, reply: 'ok' },
  );
});

// ---------- 通用 AI 助手 ----------

test('assistant: chat returns needConfig when AI disabled', async () => {
  await withServer(async ({ aiBase }) => {
    const res = await fetch(`${aiBase}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { needConfig: boolean };
    assert.equal(body.needConfig, true);
  });
});

test('assistant: chat injects summary/weakness/ability and optional plan context', async () => {
  await withServer(
    async ({ db, aiBase, providerChats }) => {
      // 种子：能力值数据 + 一份计划
      for (let i = 0; i < 6; i += 1) seedAc(db, 1600 + i * 100);
      db.prepare(
        "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, '冲刺计划', '练图论', '2026-09-01', '2026-09-07', 'ai')",
      ).run();
      const planId = (db.prepare('SELECT id FROM plans').get() as { id: number }).id;

      const res = await fetch(`${aiBase}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: '我该练什么？' }], planId }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { reply: string };
      assert.equal(body.reply, 'ok');

      assert.equal(providerChats.length, 1);
      const system = providerChats[0]!.system;
      assert.match(system, /练习数据汇总/); // 问题分布统计来源
      assert.match(system, /弱项画像/);
      assert.match(system, /当前估算能力值/);
      assert.match(system, /冲刺计划/); // 关联计划上下文
      assert.deepEqual(providerChats[0]!.messages, [{ role: 'user', content: '我该练什么？' }]);
    },
    { enabled: true, reply: 'ok' },
  );
});

test('assistant: chat rejects invalid messages and nonexistent plan falls back to note', async () => {
  await withServer(
    async ({ aiBase, providerChats }) => {
      const bad = await fetch(`${aiBase}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      });
      assert.equal(bad.status, 400);

      const res = await fetch(`${aiBase}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], planId: 999 }),
      });
      assert.equal(res.status, 200);
      assert.match(providerChats[0]!.system, /不存在/);
    },
    { enabled: true, reply: 'ok' },
  );
});
