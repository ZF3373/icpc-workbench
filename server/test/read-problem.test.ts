import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import '../src/routes/ai.ts';
import { executeToolCall, getToolDefinitions, type ToolContext } from '../src/ai/tools/registry.ts';
import { __resetProblemStatementsForTest } from '../src/contests/problemStatements.ts';
import { generatePlan, buildPlanPackage } from '../src/plans/planService.ts';
import type { ChatMessage, ChatOptions } from '../src/ai/provider.ts';
import { prepareStatementEvidence, linkedStatementRefs, renderStatementEvidence } from '../src/problems/statements.ts';

const cfg = { enabled: true, baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm' };
const body = 'Find the minimum number of operations on the given sequence. '.repeat(10);
const page = `<script id="lentille-context" type="application/json">${JSON.stringify({ data: { problem: { content: { description: body, inputFormat: 'n integers', outputFormat: 'minimum operations', hint: 'n <= 200000' } } } })}</script>`;

test('按题号读取工具无需搜索密钥，并返回实际输入输出和约束', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  try {
    assert.ok(getToolDefinitions(cfg).some(t => t.function.name === 'read_problem'));
    const result = await executeToolCall('read_problem', { platform: 'luogu', problemKey: 'P1001' }, { cfg, db, fetchFn: async () => new Response(page) });
    const data = JSON.parse(result.content);
    assert.equal(data.status, 'available');
    assert.match(data.text, /n <= 200000/);
    assert.match(data.text, /minimum operations/);
    assert.equal(data.sourceUrl, 'https://www.luogu.com.cn/problem/P1001');
  } finally { db.close(); }
});

test('CF 无 Cookie 时读取同题洛谷镜像，不发送其他平台 Cookie', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  const urls: string[] = [];
  try {
    const ctx: ToolContext = { cfg, db, cookies: { codeforces: {}, atcoder: { cookie: 'private-at' }, luogu: { cookie: 'lg-only' } }, fetchFn: async (url, init) => {
      urls.push(String(url));
      assert.equal(new Headers(init?.headers).get('cookie'), 'lg-only');
      assert.equal(init?.redirect, 'manual');
      return new Response(page);
    } };
    const data = JSON.parse((await executeToolCall('read_problem', { platform: 'codeforces', problemKey: '1877A' }, ctx)).content);
    assert.equal(data.status, 'available');
    assert.deepEqual(urls, ['https://www.luogu.com.cn/problem/CF1877A']);
    const cached = JSON.parse((await executeToolCall('read_problem', { platform: 'luogu', problemKey: 'cf1877a' }, ctx)).content);
    assert.equal(cached.status, 'available');
    assert.equal(urls.length, 1);
  } finally { db.close(); }
});

test('长题面可分页读到末尾，截断缓存不得声称完整', async () => {
  const db = createDb(':memory:');
  try {
    db.prepare('INSERT INTO problem_statements VALUES (?, ?, ?, ?, ?)').run('atcoder', 'abc300_a', `${body.repeat(20)}\nLAST CONSTRAINT`, 'https://atcoder.jp/contests/abc300/tasks/abc300_a', new Date().toISOString());
    const ctx = { cfg, db, fetchFn: async () => { throw new Error('缓存命中不应联网'); } };
    const first = JSON.parse((await executeToolCall('read_problem', { platform: 'atcoder', problemKey: 'ABC300A' }, ctx)).content);
    assert.equal(first.status, 'partial');
    assert.ok(first.nextOffset > 0);
    const last = JSON.parse((await executeToolCall('read_problem', { platform: 'atcoder', problemKey: 'abc300_a', offset: first.nextOffset }, ctx)).content);
    assert.match(last.text, /LAST CONSTRAINT/);
    assert.equal(last.nextOffset, null);
    db.prepare('UPDATE problem_statements SET text = ?').run(`${body}\n（题面过长已截断：仅保留前 4000 字符）`);
    const legacy = JSON.parse((await executeToolCall('read_problem', { platform: 'atcoder', problemKey: 'abc300_a' }, ctx)).content);
    assert.notEqual(legacy.status, 'available');
    db.prepare('UPDATE problem_statements SET text = ?').run(`${body}\n[…内容已截断，原文较长]`);
    const legacyHtml = JSON.parse((await executeToolCall('read_problem', { platform: 'atcoder', problemKey: 'abc300_a' }, ctx)).content);
    assert.notEqual(legacyHtml.status, 'available');
  } finally { db.close(); }
});

test('不可信题号、任意 URL、噪声页面均不能成为题面证据', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  let count = 0;
  try {
    const ctx = { cfg, db, fetchFn: async () => { count++; return new Response(`Just a moment ${body}`); } };
    const invalid = JSON.parse((await executeToolCall('read_problem', { platform: 'luogu', problemKey: '../settings?token=x', url: 'http://127.0.0.1' }, ctx)).content);
    assert.equal(invalid.status, 'unavailable');
    assert.equal(count, 0);
    const failed = JSON.parse((await executeToolCall('read_problem', { platform: 'luogu', problemKey: 'P1002' }, ctx)).content);
    assert.equal(failed.status, 'unavailable');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM problem_statements').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('取消读题时中止传输，不把未完成内容缓存或继续生成', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  const controller = new AbortController();
  try {
    const result = executeToolCall('read_problem', { platform: 'luogu', problemKey: 'P1003' }, { cfg, db, signal: controller.signal, fetchFn: async (_url, init) => {
      controller.abort();
      assert.ok(init?.signal?.aborted);
      throw new DOMException('Aborted', 'AbortError');
    } });
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM problem_statements').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('计划首次生成取得候选题面，工具续读后才解析最终 JSON，导出也含缓存证据', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  const calls: ChatMessage[][] = [];
  try {
    db.prepare('INSERT INTO problems (platform, problem_key, title, difficulty, tags, url) VALUES (?, ?, ?, ?, ?, ?)')
      .run('luogu', 'P1001', '序列划分', 1500, '["dp"]', 'https://www.luogu.com.cn/problem/P1001');
    const provider = { enabled: true, chat: async (messages: ChatMessage[], options?: ChatOptions) => {
      calls.push([...messages]);
      if (calls.length === 1) {
        assert.match(String(messages[1]?.content), /n <= 200000/);
        assert.ok(options?.tools?.some(t => t.function.name === 'read_problem'));
        options?.onFinish?.('tool_calls', [{ id: 'read-1', type: 'function', function: { name: 'read_problem', arguments: '{"platform":"luogu","problemKey":"P1001"}' } }]);
        return '';
      }
      assert.ok(messages.some(m => m.role === 'tool' && String(m.content).includes('minimum operations')));
      options?.onFinish?.('stop');
      return JSON.stringify({ title: '按题面选题', goal: '训练序列建模', tasks: [{ date: '2026-10-15', title: '序列划分', kind: 'practice', platform: 'luogu', problemKey: 'P1001', note: '训练建模，20 分钟后回顾' }] });
    } };
    const result = await generatePlan(db, cfg, { days: 1, startDate: '2026-10-15', provider, fetchStatementFn: async () => new Response(page) });
    assert.equal(result.source, 'ai');
    assert.equal(calls.length, 2);
    assert.match(buildPlanPackage(db, 1, { days: 1 }).prompt, /n <= 200000/);
  } finally { db.close(); }
});

test('预取预算用在未缓存题上，超时返回已有证据与缺失状态', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  try {
    const refs = Array.from({ length: 7 }, (_, i) => ({ platform: 'luogu', problemKey: `P${2000 + i}` }));
    for (const p of refs.slice(0, 6)) db.prepare('INSERT INTO problem_statements VALUES (?, ?, ?, ?, ?)').run(p.platform, p.problemKey, body, null, new Date().toISOString());
    let fetches = 0;
    const text = await prepareStatementEvidence(db, refs, { limit: 1, fetchFn: async () => { fetches++; return new Response(page); } });
    assert.equal(fetches, 1);
    assert.match(text, /"problemKey":"P2006","status":"available"/);
    const text2 = await prepareStatementEvidence(db, [{ platform: 'luogu', problemKey: 'P3000' }], { timeoutMs: 20, fetchFn: async (_url, init) => {
      await new Promise(resolve => setTimeout(resolve, 40));
      init?.signal?.throwIfAborted();
      return new Response(page);
    } });
    assert.match(text2, /"status":"unavailable"/);
  } finally { db.close(); }
});

test('关联题面只读当前用户拥有的计划和题单', () => {
  const db = createDb(':memory:');
  try {
    const listId = Number(db.prepare("INSERT INTO problem_lists (user_id, title) VALUES (1, 'private')").run().lastInsertRowid);
    db.prepare("INSERT INTO problem_list_items (list_id, platform, problem_key, category, position) VALUES (?, 'luogu', 'P1001', '', 0)").run(listId);
    assert.equal(linkedStatementRefs(db, 1, { listId }).length, 1);
    assert.deepEqual(linkedStatementRefs(db, 2, { listId }), []);
  } finally { db.close(); }
});

test('洛谷 SP 远程题号仍可读取，AtCoder 题号前缀不等于所属比赛时沿用已核对的库内链接', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  const urls: string[] = [];
  const transport: typeof fetch = async url => { urls.push(String(url)); return new Response(String(url).includes('atcoder') ? `<div id="task-statement"><span class="lang-en">${body}</span></div>` : page); };
  try {
    const sp = await executeToolCall('read_problem', { platform: 'luogu', problemKey: 'SP1' }, { cfg, db, fetchFn: transport });
    assert.equal(JSON.parse(sp.content).status, 'available');
    db.prepare('INSERT INTO problems (platform, problem_key, title, url) VALUES (?, ?, ?, ?)').run('atcoder', 'arc059_a', 'Same task in ABC043', 'https://atcoder.jp/contests/abc043/tasks/arc059_a');
    const at = await executeToolCall('read_problem', { platform: 'atcoder', problemKey: 'arc059_a' }, { cfg, db, fetchFn: transport });
    assert.equal(JSON.parse(at.content).status, 'available');
    assert.deepEqual(urls, ['https://www.luogu.com.cn/problem/SP1', 'https://atcoder.jp/contests/abc043/tasks/arc059_a']);
    db.prepare('INSERT INTO problems (platform, problem_key, title, url) VALUES (?, ?, ?, ?)').run('atcoder', 'joi2011ho1', 'JOI task', 'https://atcoder.jp/contests/joi2011ho/tasks/joi2011ho1');
    const joi = await executeToolCall('read_problem', { platform: 'atcoder', problemKey: 'joi2011ho1' }, { cfg, db, fetchFn: transport });
    assert.equal(JSON.parse(joi.content).sourceUrl, 'https://atcoder.jp/contests/joi2011ho/tasks/joi2011ho1');
  } finally { db.close(); }
});

test('CF 合法纯数字题号按末两位拆分题号，AtCoder 多段前缀转为比赛地址且只允许同源跳转', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  const urls: string[] = [];
  try {
    const ctx = { cfg, db, cookies: { codeforces: { cookie: 'cf-only' }, atcoder: { cookie: 'at-only' } }, fetchFn: (async (url, init) => {
      urls.push(String(url));
      if (String(url).includes('codeforces')) return new Response(`<div class="problem-statement">${body}</div>`);
      assert.equal(new Headers(init?.headers).get('cookie'), 'at-only');
      if (String(url) === 'https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_a') return new Response('', { status: 302, headers: { location: '/contests/tessoku-book/tasks/tessoku_book_a?lang=ja' } });
      return new Response(`<div id="task-statement"><span class="lang-en">${body}</span></div>`);
    }) as typeof fetch };
    assert.equal(JSON.parse((await executeToolCall('read_problem', { platform: 'codeforces', problemKey: '92101' }, ctx)).content).status, 'available');
    assert.equal(JSON.parse((await executeToolCall('read_problem', { platform: 'atcoder', problemKey: 'tessoku_book_a' }, ctx)).content).status, 'available');
    assert.deepEqual(urls, ['https://codeforces.com/contest/921/problem/01', 'https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_a', 'https://atcoder.jp/contests/tessoku-book/tasks/tessoku_book_a?lang=ja']);
  } finally { db.close(); }
});

test('认证读题不跟随跨源重定向，不可信库内 URL 不能覆盖题目来源', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  const urls: string[] = [];
  try {
    db.prepare('INSERT INTO problems (platform, problem_key, title, url) VALUES (?, ?, ?, ?)').run('atcoder', 'abc301_a', 'test', 'https://attacker.test/contests/abc301/tasks/abc301_a');
    const data = JSON.parse((await executeToolCall('read_problem', { platform: 'atcoder', problemKey: 'abc301_a' }, { cfg, db, cookies: { atcoder: { cookie: 'secret' } }, fetchFn: async url => {
      urls.push(String(url));
      return new Response('', { status: 302, headers: { location: 'https://attacker.test/collect' } });
    } })).content);
    assert.equal(data.status, 'unavailable');
    assert.ok(urls.every(url => !url.includes('attacker.test')));
  } finally { db.close(); }
});

test('历史洛谷缓存只有描述时重新补取输入输出和约束', async () => {
  const db = createDb(':memory:');
  __resetProblemStatementsForTest();
  try {
    db.prepare('INSERT INTO problem_statements VALUES (?, ?, ?, ?, ?)').run('luogu', 'P1001', body, 'https://www.luogu.com.cn/problem/P1001', '2026-09-01T00:00:00Z');
    const before = renderStatementEvidence(db, [{ platform: 'luogu', problemKey: 'P1001' }]);
    assert.match(before, /"status":"partial"/);
    let fetches = 0;
    const data = JSON.parse((await executeToolCall('read_problem', { platform: 'luogu', problemKey: 'P1001' }, { cfg, db, fetchFn: async () => { fetches++; return new Response(page); } })).content);
    assert.equal(fetches, 1);
    assert.equal(data.status, 'available');
    assert.match(data.text, /n <= 200000/);
  } finally { db.close(); }
});
