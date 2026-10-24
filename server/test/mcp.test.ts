import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { mcpRoutes } from '../src/routes/mcp.ts';
import { statsRoutes } from '../src/routes/stats.ts';
import { checkinsRoutes } from '../src/routes/checkins.ts';
import { reviewsRoutes } from '../src/routes/reviews.ts';
import { MCP_TOOLS } from '../src/mcp/tools.ts';
import { listenForTest } from './test-listen.ts';
import { localToday } from '../src/dates.ts';

/**
 * MCP 端点测试：按真实 MCP 客户端的行为走 Streamable HTTP 无状态握手——
 * initialize → tools/list → tools/call，全部经 HTTP 打到 /mcp，工具再回环打到 /api/*。
 * 测试 app 只挂被工具用到的路由（stats/checkins/reviews + health），与生产装配的
 * 子集等价；写路径用 checkin_task 验证「MCP 调用 → 回环 REST → SQLite 落库」全链路。
 */

interface JsonRpcResult {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

let nextId = 0;

async function rpc(base: string, method: string, params?: unknown): Promise<JsonRpcResult> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, ...(params ? { params } : {}) }),
  });
  assert.equal(res.status, 200, `${method} 应答 200（实际 ${res.status}）`);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  return (await res.json()) as JsonRpcResult;
}

/** 调一个工具并解析 content[0].text 为 JSON */
async function callTool(base: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(base, 'tools/call', { name, arguments: args });
  assert.ok(r.result, `tools/call ${name} 应有 result（error=${JSON.stringify(r.error)}）`);
  const content = r.result.content as { type: string; text: string }[];
  assert.ok(Array.isArray(content) && content[0]?.type === 'text');
  return { isError: r.result.isError === true, text: content[0].text };
}

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString(), version: 'test' });
  });
  app.use('/api/stats', statsRoutes(db));
  app.use('/api/checkins', checkinsRoutes(db));
  app.use('/api/reviews', reviewsRoutes(db));
  app.use('/mcp', mcpRoutes());
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

test('initialize 握手：协议版本协商 + serverInfo + tools 能力声明', async () => {
  await withServer(async (_db, base) => {
    const r = await rpc(base, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    });
    assert.ok(r.result, `initialize 应有 result（error=${JSON.stringify(r.error)}）`);
    assert.equal((r.result.serverInfo as { name: string }).name, 'icpc-workbench');
    assert.ok((r.result.capabilities as { tools?: unknown }).tools, '应声明 tools 能力');
    assert.equal(typeof r.result.protocolVersion, 'string');
  });
});

test('tools/list：清单完整、名称唯一、schema 形态合法', async () => {
  await withServer(async (_db, base) => {
    const r = await rpc(base, 'tools/list');
    const tools = r.result!.tools as { name: string; description: string; inputSchema: { type: string } }[];
    assert.ok(tools.length >= 30, `工具数量应 ≥30（实际 ${tools.length}）`);
    const names = new Set(tools.map((t) => t.name));
    assert.equal(names.size, tools.length, '工具名不应重复');
    for (const t of tools) {
      assert.ok(t.description, `${t.name} 缺 description`);
      assert.equal(t.inputSchema.type, 'object', `${t.name} 的 inputSchema 应为 object`);
    }
    // 注册表与端点返回一一对应（路由装配的就是 MCP_TOOLS 本身）
    assert.deepEqual(
      [...names].sort(),
      MCP_TOOLS.map((t) => t.name).sort(),
    );
  });
});

test('tools/call 只读工具：get_app_status 经回环代理拿到 health 数据', async () => {
  await withServer(async (_db, base) => {
    const { isError, text } = await callTool(base, 'get_app_status');
    assert.equal(isError, false);
    const data = JSON.parse(text) as { ok: boolean; version: string };
    assert.equal(data.ok, true);
    assert.equal(data.version, 'test');
  });
});

test('tools/call 只读工具：get_stats_overview 返回统计对象', async () => {
  await withServer(async (_db, base) => {
    const { isError, text } = await callTool(base, 'get_stats_overview');
    assert.equal(isError, false);
    assert.equal(typeof JSON.parse(text), 'object');
  });
});

test('tools/call 写工具：checkin_task 全链路落库（MCP → 回环 REST → SQLite）', async () => {
  await withServer(async (db, base) => {
    const today = localToday();
    db.prepare(
      "INSERT INTO plans (user_id, title, start_date, end_date, source) VALUES (1, 'p', ?, ?, 'template')",
    ).run(today, today);
    db.prepare(
      "INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (1, ?, 't', 'practice')",
    ).run(today);
    const { isError, text } = await callTool(base, 'checkin_task', { taskId: 1 });
    assert.equal(isError, false, text);
    const n = db.prepare('SELECT COUNT(*) AS n FROM checkins').get() as { n: number };
    assert.equal(n.n, 1, '打卡应已写入 checkins 表');
  });
});

test('tools/call 合并调用：get_checkin_calendar 一次带回日历与连续天数', async () => {
  await withServer(async (_db, base) => {
    const { isError, text } = await callTool(base, 'get_checkin_calendar');
    assert.equal(isError, false);
    const data = JSON.parse(text) as { month: string; days: unknown; streak: { current: number } };
    assert.match(data.month, /^\d{4}-\d{2}$/);
    assert.equal(data.streak.current, 0);
  });
});

test('上游 4xx 映射为 isError 工具结果（模型可见、可纠正），而不是 JSON-RPC error', async () => {
  await withServer(async (_db, base) => {
    // 题库中不存在该题 → 路由 404 { error } → ToolError → isError:true
    const { isError, text } = await callTool(base, 'add_to_review_queue', {
      platform: 'codeforces',
      problemKey: 'NO_SUCH_PROBLEM',
    });
    assert.equal(isError, true);
    assert.match(text, /HTTP 404/);
  });
});

test('未知工具与缺参：isError true 且错误信息可读', async () => {
  await withServer(async (_db, base) => {
    const unknown = await callTool(base, 'no_such_tool');
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /未知工具/);
    const missing = await callTool(base, 'checkin_task', {});
    assert.equal(missing.isError, true);
    assert.match(missing.text, /taskId/);
  });
});

test('无状态端点：GET / DELETE /mcp 按规范回 405', async () => {
  await withServer(async (_db, base) => {
    const get = await fetch(`${base}/mcp`);
    assert.equal(get.status, 405);
    const del = await fetch(`${base}/mcp`, { method: 'DELETE' });
    assert.equal(del.status, 405);
  });
});
