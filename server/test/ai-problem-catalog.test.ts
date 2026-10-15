import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { executeToolCall, type ToolContext } from '../src/ai/tools/registry.ts';
import { savePlan } from '../src/plans/planService.ts';
import { listenForTest } from './test-listen.ts';
import type { ChatMessage, ChatOptions } from '../src/ai/provider.ts';

const cfg = { enabled: true, baseURL: 'https://x/v1', apiKey: 'k', model: 'm' };

function seed(db: Db): void {
  const ins = db.prepare('INSERT INTO problems (platform, problem_key, title, difficulty, tags, url) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 140; i++) {
    ins.run('codeforces', `${3000 + i}A`, `新题 ${i}`, 1600, '["binary search"]', `https://codeforces.com/contest/${3000 + i}/problem/A`);
  }
  insertNormalized(db, 1, [{
    problem: { platform: 'codeforces', problemKey: '1000A', title: '旧 AC', difficulty: 1600, tags: ['binary search'] },
    verdict: 'AC', submittedAt: '2020-01-01T00:00:00Z', externalId: 'old-ac',
  }]);
  ins.run('luogu', 'CF1000A', '已 AC 的镜像', 1600, '["binary search"]', 'https://www.luogu.com.cn/problem/CF1000A');
  insertNormalized(db, 1, [{
    problem: { platform: 'luogu', problemKey: 'at_abc300_a', title: 'AtCoder 镜像 AC', difficulty: 1600, tags: [] },
    verdict: 'AC', submittedAt: '2020-01-01T00:00:00Z', externalId: 'mirror-ac',
  }]);
  ins.run('atcoder', 'abc300_a', '镜像原题', 1600, '["binary search"]', 'https://atcoder.jp/contests/abc300/tasks/abc300_a');
  // 其他用户的 AC 不应影响当前用户选题。
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'other')").run();
  insertNormalized(db, 2, [{
    problem: { platform: 'codeforces', problemKey: '3000A', title: '新题 0', difficulty: 1600, tags: ['binary search'] },
    verdict: 'AC', submittedAt: '2020-01-01T00:00:00Z', externalId: 'other-ac',
  }]);
}

test('本地题库检索默认排除全部历史 AC 与镜像，跨页覆盖候选题且按用户隔离', async () => {
  const db = createDb(':memory:');
  try {
    seed(db);
    const ctx = { cfg, db, userId: 1 } as ToolContext;
    const first = JSON.parse((await executeToolCall('search_problems', { tag: '二分', difficultyMin: 1500, difficultyMax: 1700, limit: 100 }, ctx)).content);
    assert.equal(first.total, 140);
    assert.equal(first.problems.length, 100);
    assert.equal(first.nextOffset, 100);
    assert.ok(first.problems.some((p: { problemKey: string }) => p.problemKey === '3000A'));
    assert.ok(first.problems.every((p: { solved: boolean }) => p.solved === false));
    const second = JSON.parse((await executeToolCall('search_problems', { tag: '二分', difficultyMin: 1500, difficultyMax: 1700, limit: 100, offset: 100 }, ctx)).content);
    assert.equal(second.problems.length, 40);
    assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.problems, ...second.problems].map(p => p.problemKey)).size, 140);
    const ac = JSON.parse((await executeToolCall('search_problems', { status: 'ac' }, ctx)).content);
    assert.equal(ac.total, 4);
    assert.ok(ac.problems.every((p: { solved: boolean }) => p.solved === true));
  } finally { db.close(); }
});

test('状态核验覆盖旧 AC、大小写、镜像与库外题，不把未同步的题伪称为确认未做', async () => {
  const db = createDb(':memory:');
  try {
    seed(db);
    const result = JSON.parse((await executeToolCall('check_problem_status', { problems: [
      { platform: 'luogu', problemKey: 'cf1000a' },
      { platform: 'atcoder', problemKey: 'ABC300_A' },
      { platform: 'codeforces', problemKey: '3000A' },
      { platform: 'luogu', problemKey: 'P999999' },
    ] }, { cfg, db, userId: 1 } as ToolContext)).content);
    assert.deepEqual(result.problems.map((p: { status: string }) => p.status), ['已 AC', '已 AC', '未 AC（同步记录）', '未收录，未查到 AC 记录']);
  } finally { db.close(); }
});

test('助手注入未 AC 候选与关联对象状态，后续工具轮仍可分页检索', async () => {
  const db = createDb(':memory:');
  seed(db);
  const planId = savePlan(db, 1, { title: '待调整', goal: '', startDate: '2026-10-14', days: 7, tasks: [
    { date: '2026-10-14', title: '旧 AC', platform: 'codeforces', problemKey: '1000A', kind: 'practice' },
    { date: '2026-10-15', title: '只含链接的任务', url: 'https://www.luogu.com.cn/problem/CF1000A', kind: 'practice' },
  ] }, 'manual');
  const listId = Number(db.prepare("INSERT INTO problem_lists (user_id, title) VALUES (1, '待调整题单')").run().lastInsertRowid);
  db.prepare("INSERT INTO problem_list_items (list_id, platform, problem_key, category, position) VALUES (?, 'luogu', 'CF1000A', '二分', 0)").run(listId);
  const calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRoutes(db, () => cfg, {
    fetchStatementFn: async () => new Response(`<script>window.__INITIAL_STATE__ = ${JSON.stringify({ problem: { description: '这是实际读取的题面：给定序列，求操作次数。'.repeat(15), inputFormat: '输入 n 个整数', outputFormat: '输出最少操作数', hint: '序列长度不超过 200000' } })};</script>`),
    fetchContests: async () => ({ contests: [], failures: {} }),
    createProvider: () => ({ enabled: true, chat: async () => 'ok', chatStream: async function* (messages, options) {
      calls.push({ messages: [...messages], options: options ?? {} });
      if (calls.length === 1) {
        options?.onFinish?.('tool_calls', [{ id: 'catalog-1', type: 'function', function: { name: 'search_problems', arguments: '{"platform":"codeforces","limit":100}' } }]);
      } else if (calls.length === 2) {
        options?.onFinish?.('tool_calls', [{ id: 'catalog-2', type: 'function', function: { name: 'search_problems', arguments: '{"platform":"codeforces","limit":100,"offset":100}' } }]);
      } else { options?.onFinish?.('stop'); yield '已检索到足够的新题'; }
    } }),
  }));
  const srv = await listenForTest(app);
  try {
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId, listId, messages: [{ role: 'user', content: '替换已 AC 题，增加新题' }] }) });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /已检索到足够的新题/);
    const system = calls[0]!.messages[0]!.content as string;
    assert.match(system, /这是实际读取的题面/);
    assert.match(system, /序列长度不超过 200000/);
    assert.match(system, /未 AC 候选题/);
    assert.match(system, /3000A/);
    assert.match(system.split('## 关联的训练计划')[1]!.split('## 关联的题单')[0]!, /1000A.*已 AC/);
    assert.match(system.split('## 关联的训练计划')[1]!.split('## 关联的题单')[0]!, /只含链接的任务.*CF1000A.*已 AC/);
    assert.match(system.split('## 关联的题单')[1]!.split('## 对话要求')[0]!, /CF1000A.*已 AC/);
    assert.ok(calls[1]!.options.tools?.some(t => t.function.name === 'search_problems'));
    const toolResults = calls[2]!.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content as string));
    assert.deepEqual(toolResults.map(r => r.problems.length), [100, 40]);
  } finally { srv.close(); db.close(); }
});
