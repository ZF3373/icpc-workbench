/**
 * read_template 工具回归：AI 助手的模板库查询接口。
 *
 * 背景：旧实现把 2-4 段 30 行代码片段预注入系统提示词当「风格参考」，每轮对话
 * 都被撑大，且 AI 看不到完整模板——完善已有条目时（PUT content 是整体覆盖）
 * 更可能把用户已写内容冲掉。现改为按需查询：
 * - read_template 按 id 读完整模板（内置 / c-<id> 自定义），含旧内容与风格；
 * - 系统提示词不再预注入任何代码片段；自定义模板摘要带 c-<id>。
 */
import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { executeToolCall, type ToolContext } from '../src/ai/tools/registry.ts';import { buildTemplateLibrarySummary } from '../src/ai/templateContext.ts';
// 触发 read_template / web_search / read_problem 注册（副作用导入）
import '../src/ai/read-template.ts';
import '../src/ai/search.ts';
import '../src/ai/read-problem.ts';
import type { AiConfig } from '../src/config.ts';
import type { ChatMessage, ChatOptions, ToolCall } from '../src/ai/provider.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';

const CFG: AiConfig = { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };

/** 直接执行 read_template（不经 /chat），返回工具注入对话的 content 文本 */
async function callReadTemplate(db: Db, templateId: string, omitTemplateId = false): Promise<string> {
  const ctx: ToolContext = { cfg: CFG, db, userId: DEFAULT_USER_ID };
  const result = await executeToolCall('read_template', omitTemplateId ? {} : { templateId }, ctx);
  return result.content;
}

test('read_template：内置模板（有已写内容）返回完整 code/idea 与增量完善提示', async () => {
  const db = createDb(':memory:');
  try {
    // ds-dsu 用户已写代码 + 思路（模拟 PUT /:id/content 的落库结果）
    db.prepare(
      `INSERT INTO template_progress (template_id, user_id, status, code, idea, complexity, url)
       VALUES ('ds-dsu', ?, 'learning', ?, ?, ?, ?)`,
    ).run(DEFAULT_USER_ID, 'struct DSU{int fa[N];}dsu;', '路径压缩+按秩合并', 'O(alpha n)', 'https://example.com');
    const raw = await callReadTemplate(db, 'ds-dsu');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(obj.templateId, 'ds-dsu');
    assert.equal(obj.source, 'builtin');
    assert.equal(obj.name, '并查集（路径压缩 + 按秩合并）');
    assert.equal(obj.categoryKey, 'ds');
    assert.equal(obj.code, 'struct DSU{int fa[N];}dsu;');
    assert.equal(obj.idea, '路径压缩+按秩合并');
    assert.equal(obj.status, 'learning');
    assert.equal(obj.hasContent, true);
    assert.match(String(obj.note), /增量补充完善/);
    assert.match(String(obj.note), /不要凭空重写整体覆盖/);
  } finally {
    db.close();
  }
});

test('read_template：内置空模板返回 hasContent=false 与「可直接生成」提示', async () => {
  const db = createDb(':memory:');
  try {
    const raw = await callReadTemplate(db, 'dp-lis'); // 大纲里存在但用户没写过内容
    const obj = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(obj.hasContent, false);
    assert.equal(obj.code, null);
    assert.match(String(obj.note), /可直接生成/);
    assert.ok(Array.isArray(obj.examples), '内置条目要带例题清单');
    assert.ok((obj.outline as string).length > 0, '内置条目要带大纲要点');
  } finally {
    db.close();
  }
});

test('read_template：自定义模板 c-<id> 返回完整内容；不存在/格式错误的 id 给明确报错', async () => {
  const db = createDb(':memory:');
  try {
    db.prepare(
      `INSERT INTO custom_templates (user_id, category_key, name, difficulty, tags, code, idea)
       VALUES (?, 'graph', '我的树剖', 5, '["树链剖分"]', 'void split(){}', '重链剖分')`,
    ).run(DEFAULT_USER_ID);
    const id = (db.prepare('SELECT id FROM custom_templates').get() as { id: number }).id;

    const raw = await callReadTemplate(db, `c-${id}`);
    const obj = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(obj.templateId, `c-${id}`);
    assert.equal(obj.source, 'custom');
    assert.equal(obj.name, '我的树剖');
    assert.equal(obj.category, '图论'); // category_key graph → 内置分类名「图论」
    assert.deepEqual(obj.tags, ['树链剖分']);
    assert.equal(obj.code, 'void split(){}');

    // 不存在的自定义 id
    assert.match(await callReadTemplate(db, 'c-99999'), /不存在/);
    // 不存在的内置 id（不撞 c- 前缀）
    assert.match(await callReadTemplate(db, 'totally-made-up'), /不存在/);
    // 缺参
    assert.match(await callReadTemplate(db, '', true), /templateId/);
  } finally {
    db.close();
  }
});

test('模板库摘要不再预注入代码片段；自定义模板条目带 c-<id>', async () => {
  const db = createDb(':memory:');
  try {
    db.prepare(
      `INSERT INTO template_progress (template_id, user_id, status, code, idea)
       VALUES ('ds-dsu', ?, 'mastered', 'int fa[N];', '并查集思路')`,
    ).run(DEFAULT_USER_ID);
    db.prepare(
      `INSERT INTO custom_templates (user_id, category_key, name, difficulty, tags, code)
       VALUES (?, 'graph', '树套树', 5, '[]', 'seg[sq]')`,
    ).run(DEFAULT_USER_ID);
    const summary = buildTemplateLibrarySummary(db);
    // 核心回归：预注入的代码风格片段没了
    assert.doesNotMatch(summary, /代码风格参考/);
    assert.doesNotMatch(summary, /int fa\[N\]/, '已写代码正文绝不能进系统提示词');
    assert.doesNotMatch(summary, /seg\[sq\]/, '自定义模板代码正文绝不能进系统提示词');
    // 保留：状态标记与已有内容标记（AI 判断要不要读的依据）
    assert.match(summary, /✓已掌握/);
    assert.match(summary, /✏已有内容/);
    // 自定义模板行带 id，AI 才知道 read_template 查什么
    assert.match(summary, /id=c-\d+/);
    assert.match(summary, /read_template/);
  } finally {
    db.close();
  }
});

test('read_template 在 /chat 工具往返中可被调用：进度事件 + tool 结果注入对话', async () => {
  const db = createDb(':memory:');
  db.prepare(
    `INSERT INTO template_progress (template_id, user_id, status, code, idea)
     VALUES ('ds-dsu', ?, 'mastered', 'struct DSU{int f[N];}u;', '并查集')`,
  ).run(DEFAULT_USER_ID);
  /** 每轮流式请求收到的消息（去 system），用于断言 tool 结果注入 */
  const turns: Array<Array<{ role: string; content: string }>> = [];
  let call = 0;
  const app = express();
  app.use(express.json());
  app.use(
    '/api/ai',
    aiRoutes(db, () => CFG, {
      fetchContests: async () => ({ contests: [], failures: {} }),
      createProvider: () => ({
        enabled: true,
        chat: async () => 'ok',
        chatStream: async function* (messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<string, void, void> {
          call += 1;
          turns.push(
            messages
              .slice(1)
              .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '[blocks]' })),
          );
          if (call === 1) {
            const tc: ToolCall = {
              id: 'call_rt',
              type: 'function',
              function: { name: 'read_template', arguments: '{"templateId":"ds-dsu"}' },
            };
            opts.onFinish?.('tool_calls', [tc]);
            return;
          }
          opts.onFinish?.('stop', undefined);
          yield '已读取你的并查集模板，风格将对其对齐。';
        },
      }),
    }),
  );
  const srv = await listenForTest(app);
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '帮我把这个写成模板，风格要像我已有模板' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    // 工具进度事件带 templateId（前端显示「正在查看模板库：ds-dsu」）
    assert.ok(body.includes('"name":"read_template"'), `缺少工具进度事件：${body}`);
    assert.ok(body.includes('ds-dsu'), '进度事件 detail 应展示 templateId');
    // 第二轮请求注入了工具读出的完整模板内容
    assert.equal(turns.length, 2);
    const toolMsg = turns[1]!.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '第二轮应携带 tool 结果消息');
    const payload = JSON.parse(toolMsg.content) as Record<string, unknown>;
    assert.equal(payload.code, 'struct DSU{int f[N];}u;');
    // 工具定义进入了第一轮请求（AI 知道有 read_template 可用）
    assert.ok(body.includes('[DONE]'));
  } finally {
    srv.close();
    db.close();
  }
});
