import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import { plansRoutes } from '../src/routes/plans.ts';
import { listsRoutes } from '../src/routes/lists.ts';
import { listenForTest } from './test-listen.ts';
import { __resetProblemStatementsForTest } from '../src/contests/problemStatements.ts';

const cfg = { enabled: true, baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm' };
for (const mode of ['chat', 'plan', 'list-suggest', 'list-classify'] as const) {
  test(`${mode}：准备题面时断开客户端，中止抓取且不调用模型或保存计划`, async () => {
    const db = createDb(':memory:');
    __resetProblemStatementsForTest();
    db.prepare("INSERT INTO problems (platform, problem_key, title, difficulty, tags) VALUES ('luogu', 'P1001', 'A+B', 1500, '[\"math\"]')").run();
    db.prepare("UPDATE problems SET url = 'https://www.luogu.com.cn/problem/P1001'").run();
    const listId = Number(db.prepare("INSERT INTO problem_lists (user_id, title) VALUES (1, 'test')").run().lastInsertRowid);
    db.prepare("INSERT INTO problem_list_items (list_id, platform, problem_key, category, position) VALUES (?, 'luogu', 'P1001', '', 0)").run(listId);
    let calls = 0;
    let fetchSignal: AbortSignal | null | undefined;
    let onStarted!: () => void;
    const started = new Promise<void>(resolve => { onStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const provider = { enabled: true, chat: async () => { calls++; return '{}'; }, chatStream: async function* () { calls++; yield 'unexpected'; } };
    const fetchStatementFn: typeof fetch = async (_url, init) => {
      fetchSignal = init?.signal;
      onStarted();
      await gate;
      init?.signal?.throwIfAborted();
      return new Response('', { status: 404 });
    };
    const app = express();
    app.use(express.json());
    app.use('/api/ai', aiRoutes(db, () => cfg, { fetchContests: async () => ({ contests: [], failures: {} }), createProvider: () => provider, fetchStatementFn }));
    app.use('/api/plans', plansRoutes(db, () => cfg, { createProvider: () => provider, fetchStatementFn }));
    app.use('/api/lists', listsRoutes(db, () => cfg, { createProvider: () => provider, fetchStatementFn }));
    const server = await listenForTest(app);
    const controller = new AbortController();
    const path = mode === 'chat' ? 'ai/chat' : mode === 'plan' ? 'plans/generate' : `lists/${listId}/ai-${mode === 'list-suggest' ? 'suggest' : 'classify'}`;
    const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify(mode === 'chat' ? { listId, messages: [{ role: 'user', content: '分析题单' }] } : { days: 1 }),
    }).then(res => res.text()).catch(() => 'aborted');
    try {
      await started;
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(fetchSignal?.aborted, true);
      release();
      await request;
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(calls, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM plans').get() as { n: number }).n, 0);
      assert.equal((db.prepare('SELECT ai_suggestion FROM problem_lists WHERE id = ?').get(listId) as { ai_suggestion: string | null }).ai_suggestion, null);
    } finally {
      release();
      await request;
      await new Promise(resolve => setTimeout(resolve, 50));
      server.close();
      db.close();
    }
  });
}
