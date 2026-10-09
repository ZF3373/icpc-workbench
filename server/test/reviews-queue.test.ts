/**
 * 复习队列「加入即全体到期」的错峰回归。
 *
 * 旧实现把每个新条目的 next_due_on 一律写成今天：从题单/写题历史一键加几十道题时，
 * 第二天就是几十条到期，复习日被砸穿后用户往往直接弃用队列。
 * 现在按题目 id 做 0–3 天错峰（确定性、可测），并把负载分布透出给界面。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createDb, type Db } from '../src/db/index.ts';
import { reviewsRoutes } from '../src/routes/reviews.ts';
import { localToday } from '../src/dates.ts';
import { listenForTest } from './test-listen.ts';

let db: Db;
let server: Server;
let base = '';

beforeEach(async () => {
  db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/reviews', reviewsRoutes(db));
  server = await listenForTest(app);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

function addProblem(key: string, difficulty = 1200): number {
  return db
    .prepare("INSERT INTO problems (platform, problem_key, title, difficulty, tags) VALUES ('codeforces', ?, ?, ?, '[]')")
    .run(key, `题 ${key}`, difficulty).lastInsertRowid as number;
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as never };
}

/** 日期 + n 天（与调度层同口径：UTC 日历日加减） */
function dayPlus(n: number): string {
  const d = new Date(`${localToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test('批量加入按题目 id 错峰到今日起 0–3 天，不再同日全到期', async () => {
  const ids = [addProblem('A'), addProblem('B'), addProblem('C'), addProblem('D'), addProblem('E')];
  for (const key of ['A', 'B', 'C', 'D', 'E']) await api('POST', '/api/reviews', { platform: 'codeforces', problemKey: key });

  const rows = db
    .prepare('SELECT problem_id, next_due_on FROM review_items ORDER BY id')
    .all() as Array<{ problem_id: number; next_due_on: string }>;
  assert.equal(rows.length, 5);
  // 确定性规则：problem_id % 4 → 连续加入的题均摊到 4 天里
  assert.deepEqual(
    rows.map((r) => r.next_due_on),
    ids.map((id) => dayPlus(id % 4)),
  );
  // 关键指标：同一天最多只堆 ⌈5/4⌉ = 2 条
  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.next_due_on, (perDay.get(r.next_due_on) ?? 0) + 1);
  assert.equal(Math.max(...perDay.values()), 2, '不应有一日堆叠超过 2 条');
});

test('加入响应带回下次到期日（界面要告诉用户什么时候会看到它）', async () => {
  addProblem('A');
  const res = await api('POST', '/api/reviews', { platform: 'codeforces', problemKey: 'A' });
  assert.equal(res.status, 200);
  const body = res.body as { ok: boolean; nextDueOn: string; alreadyInQueue: boolean };
  assert.equal(body.ok, true);
  assert.match(body.nextDueOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.alreadyInQueue, false);
});

test('重复加入是幂等的：不把已经排到后面的到期日拽回今天', async () => {
  const id = addProblem('A');
  await api('POST', '/api/reviews', { platform: 'codeforces', problemKey: 'A' });
  const first = (db.prepare('SELECT next_due_on FROM review_items WHERE problem_id = ?').get(id) as { next_due_on: string }).next_due_on;
  // 复习一次，排到更远
  const itemId = (db.prepare('SELECT id FROM review_items WHERE problem_id = ?').get(id) as { id: number }).id;
  await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'easy' });
  const afterReview = (db.prepare('SELECT next_due_on, stage FROM review_items WHERE id = ?').get(itemId) as { next_due_on: string; stage: number }).next_due_on;
  assert.ok(afterReview > first, '复习后到期日应推后');

  const again = await api('POST', '/api/reviews', { platform: 'codeforces', problemKey: 'A' });
  const body = again.body as { alreadyInQueue: boolean; nextDueOn: string };
  assert.equal(body.alreadyInQueue, true);
  assert.equal(body.nextDueOn, afterReview, '重复加入不得改动已有排期');
});

test('due-count 透出负载分布：逾期 / 今日 / 未来 7 天', async () => {
  const ids = [addProblem('A'), addProblem('B'), addProblem('C'), addProblem('D'), addProblem('E')];
  for (const key of ['A', 'B', 'C', 'D', 'E']) await api('POST', '/api/reviews', { platform: 'codeforces', problemKey: key });
  // 手工造一条逾期的
  db.prepare('UPDATE review_items SET next_due_on = ? WHERE problem_id = ?').run(dayPlus(-3), ids[0]);

  const { body } = await api('GET', '/api/reviews/due-count');
  const counts = body as { count: number; overdue: number; dueToday: number; next7: number; total: number };
  assert.equal(counts.total, 5);
  assert.equal(counts.overdue, 1);
  // 剩下 4 条的错峰是 +0/+1/+2/+3：今日 1 条、未来 7 天内 3 条
  assert.equal(counts.dueToday, 1);
  assert.equal(counts.next7, 3);
  assert.equal(counts.count, counts.overdue + counts.dueToday, 'count 仍是「今天该做的量」（今日训练/挂件口径不变）');
  assert.equal(counts.count, 2);
});

test('hard 反馈走折返档：练到 60 天的题失手一次不该回到明天', async () => {
  const id = addProblem('A');
  await api('POST', '/api/reviews', { platform: 'codeforces', problemKey: 'A' });
  const itemId = (db.prepare('SELECT id FROM review_items WHERE problem_id = ?').get(id) as { id: number }).id;
  db.prepare('UPDATE review_items SET stage = 5 WHERE id = ?').run(itemId);

  const { body } = await api('POST', `/api/reviews/${itemId}/feedback`, { feedback: 'hard' });
  const next = body as { stage: number; nextDueOn: string };
  assert.equal(next.stage, 3, '60 天档失手 → 退到 14 天档，而不是明天');
  assert.equal(next.nextDueOn, dayPlus(14));
});

test('DELETE /api/reviews/:id 对非法 id 回 400、对不存在的 id 回 404（B21 回归）', async () => {
  /**
   * 原实现既不校验 id 也不看 changes，一律回 {"ok":true} —— 与 lists/plans 等兄弟端点
   * （不存在回 404）不一致，前端无从判断「是否真的删掉了」。
   */
  const bad = await api('DELETE', '/api/reviews/abc');
  assert.equal(bad.status, 400);

  const missing = await api('DELETE', '/api/reviews/99999');
  assert.equal(missing.status, 404);

  // 真实条目仍能正常删除
  const id = addProblem('A');
  await api('POST', '/api/reviews', { platform: 'codeforces', problemKey: 'A' });
  const itemId = (db.prepare('SELECT id FROM review_items WHERE problem_id = ?').get(id) as { id: number }).id;
  const ok = await api('DELETE', `/api/reviews/${itemId}`);
  assert.equal(ok.status, 200);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM review_items').get() as { c: number }).c, 0);
});
