/**
 * 用户反馈：无法指定 AI 助手把模板放到哪个算法课程标签下。
 *
 * 根因：提示词里的 {templateCategories} 只列了内置 10 个分类，用户自建标签（template_categories）
 * 对 AI 完全不可见 —— 用户说「记到 XX 标签下」时，AI 只能回「没有这个分类」。
 * 这里把「自建标签必须出现在提示词里（含一个模板都没有的空标签）」固定住。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { templatesRoutes } from '../src/routes/templates.ts';
import type { AiConfig } from '../src/config.ts';

const CFG: AiConfig = { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };

/** 挂 ai + templates 两个路由：先建自建标签，再看注入 AI 的系统提示词 */
async function withServers(
  fn: (ctx: { aiBase: string; tplBase: string; db: Db; systems: string[] }) => Promise<void>,
): Promise<void> {
  const db = createDb(':memory:');
  const systems: string[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRoutes(db));
  app.use(
    '/api/ai',
    aiRoutes(db, () => CFG, {
      fetchContests: async () => ({ contests: [], failures: {} }),
      createProvider: () => ({
        enabled: true,
        chat: async () => 'ok',
        chatStream: async function* (messages: Array<{ role: string; content: unknown }>) {
          systems.push(String(messages[0]?.content ?? ''));
          yield 'ok';
        },
      }),
    }),
  );
  const srv = await listenForTest(app);
  const root = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn({ aiBase: `${root}/api/ai`, tplBase: `${root}/api/templates`, db, systems });
  } finally {
    srv.close();
    db.close();
  }
}

async function createCategory(tplBase: string, name: string): Promise<string> {
  const res = await fetch(`${tplBase}/categories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { key: string }).key;
}

async function askAssistant(aiBase: string): Promise<void> {
  const res = await fetch(`${aiBase}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '把这段记到我的标签下' }] }),
  });
  assert.equal(res.status, 200);
  await res.text(); // 读干 SSE，确保 provider 已被调用并记录提示词
}

test('AI 提示词包含用户自建标签（含空标签）并标注「自建」', async () => {
  await withServers(async ({ aiBase, tplBase, systems }) => {
    const key = await createCategory(tplBase, '图论进阶');
    const emptyKey = await createCategory(tplBase, '还没放模板的标签');
    await askAssistant(aiBase);

    const system = systems[0]!;
    // 1) {templateCategories} 占位符被替换，且自建标签带着 key 出现在可选分类清单里
    assert.doesNotMatch(system, /\{templateCategories\}/);
    assert.ok(system.includes(`${key}（图论进阶·自建）`), '自建标签必须出现在可选分类清单中');
    assert.ok(
      system.includes(`${emptyKey}（还没放模板的标签·自建）`),
      '一个模板都没有的空标签也必须可见（用户刚建好标签就来让 AI 写入）',
    );
    // 内置分类仍在（且不带「·自建」）
    assert.match(system, /basic（基础算法）/);
    assert.doesNotMatch(system, /basic（基础算法·自建）/);

    // 2) 模板库摘要里有「用户自建标签」清单（带 key）
    assert.match(system, /用户自建标签/);
    assert.ok(system.includes(`key=${key}`), '摘要里要给出 key，AI 才能直接写进 categoryKey');
    // 3) 明确要求：用户点名的标签要原样写入，不得自造 key
    assert.match(system, /用户指定了标签就按用户说的写/);
    assert.match(system, /绝不自造 key/);
  });
});

test('没有自建标签时不出现自建标签段（不污染提示词）', async () => {
  await withServers(async ({ aiBase, systems }) => {
    await askAssistant(aiBase);
    const system = systems[0]!;
    assert.doesNotMatch(system, /用户自建标签/);
    assert.match(system, /basic（基础算法）/);
  });
});

test('AI 写自建标签：categoryKey 用自建标签 key 时被服务端接受', async () => {
  await withServers(async ({ tplBase }) => {
    const key = await createCategory(tplBase, '我的专题');
    // 模拟「AI 输出 template-add 块 → 前端点写入」的落库请求
    const res = await fetch(`${tplBase}/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        categoryKey: key,
        name: '树上启发式合并',
        difficulty: 5,
        tags: ['dsu on tree'],
        code: 'void dfs(){}',
      }),
    });
    assert.equal(res.status, 200);
    const outline = (await (await fetch(tplBase)).json()) as {
      categories: Array<{ key: string; custom?: boolean; templates: Array<{ name: string }> }>;
    };
    const mine = outline.categories.find((c) => c.key === key)!;
    assert.equal(mine.custom, true);
    assert.equal(mine.templates[0]!.name, '树上启发式合并');
  });
});
