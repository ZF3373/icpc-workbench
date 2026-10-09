/**
 * 复习条目的「按日期取数」口径回归（日历板块 / 今日训练 / 复习库共用同一数据源）。
 *
 * 关键约定（错一条就会出现「今日训练说 3 道、日历说 2 道」这类互相打脸）：
 * - 查询日 = 今天：含逾期（next_due_on <= 今天），逾期项今天就该做
 * - 查询日 ≠ 今天：只取当天到期的（历史日不补挂今天的逾期，否则翻历史处处是债）
 * - 月历角标的 overdue 只挂在今天那一格
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createDb, type Db } from '../src/db/index.ts';
import { reviewsRoutes } from '../src/routes/reviews.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';
import { localToday } from '../src/dates.ts';
import { dateAfterDays } from '../src/reviews/schedule.ts';
import { listenForTest } from './test-listen.ts';
import type { ReviewCalendarDay, ReviewItem } from '../../shared/src/index.ts';

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

function addItem(problemId: number, nextDueOn: string, stage = 0): number {
  return db
    .prepare('INSERT INTO review_items (user_id, problem_id, stage, next_due_on) VALUES (?, ?, ?, ?)')
    .run(DEFAULT_USER_ID, problemId, stage, nextDueOn).lastInsertRowid as number;
}

async function api<T>(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

const today = (): string => localToday();

test('GET /api/reviews?date=今天：含逾期项（逾期没做的今天就该做）', async () => {
  const overdueId = addProblem('OVERDUE');
  const todayId = addProblem('TODAY');
  const futureId = addProblem('FUTURE');
  addItem(overdueId, dateAfterDays(today(), -3));
  addItem(todayId, today());
  addItem(futureId, dateAfterDays(today(), 5));

  const { status, body } = await api<ReviewItem[]>(`/api/reviews?date=${today()}`);
  assert.equal(status, 200);
  assert.deepEqual(
    body.map((i) => i.problemKey),
    ['OVERDUE', 'TODAY'],
    '今天该做 = 逾期 + 今日到期，未来的不掺进来',
  );
});

test('GET /api/reviews?date=历史某天：只取当天到期的，不把今天的逾期摊回去', async () => {
  const past = dateAfterDays(today(), -5);
  const pastId = addProblem('PAST');
  const overdueId = addProblem('OVERDUE');
  addItem(pastId, past);
  addItem(overdueId, dateAfterDays(today(), -1)); // 逾期，但原定到期日不是 past

  const { body } = await api<ReviewItem[]>(`/api/reviews?date=${past}`);
  assert.deepEqual(body.map((i) => i.problemKey), ['PAST']);
});

test('GET /api/reviews?date= 非法格式返回 400', async () => {
  const { status } = await api('/api/reviews?date=2026-9-1');
  assert.equal(status, 400);
});

test('GET /api/reviews/calendar：只回有到期项的日子，overdue 只挂今天那一格', async () => {
  const month = today().slice(0, 7);
  const overdueId = addProblem('OVERDUE');
  const todayId = addProblem('TODAY');
  const futureId = addProblem('FUTURE');
  addItem(overdueId, dateAfterDays(today(), -2));
  addItem(todayId, today());
  addItem(futureId, dateAfterDays(today(), 3));

  const { status, body } = await api<ReviewCalendarDay[]>(`/api/reviews/calendar?month=${month}`);
  assert.equal(status, 200);
  const todayRow = body.find((d) => d.date === today());
  assert.ok(todayRow, '今天应有角标行');
  assert.equal(todayRow.due, 1, '今天到期 1 条');
  assert.equal(todayRow.overdue, 1, '逾期 1 条挂在今天');
  // 逾期项自己原本的到期日（-2 天）不该出现一行——那时用户确实没有这些题
  assert.equal(body.find((d) => d.date === dateAfterDays(today(), -2)), undefined);
  // 未来到期的日子有自己的行，且 overdue 为 0
  const futureRow = body.find((d) => d.date === dateAfterDays(today(), 3));
  assert.ok(futureRow);
  assert.equal(futureRow.due, 1);
  assert.equal(futureRow.overdue, 0);
});

test('GET /api/reviews/calendar：翻看其它月份时不挂今天的逾期', async () => {
  const overdueId = addProblem('OVERDUE');
  addItem(overdueId, dateAfterDays(today(), -1));

  // 取一个与今天无关的月份（今天所在月的前两个月）
  const otherMonth = dateAfterDays(`${today().slice(0, 7)}-01`, -60).slice(0, 7);
  const { body } = await api<ReviewCalendarDay[]>(`/api/reviews/calendar?month=${otherMonth}`);
  assert.deepEqual(body, [], '别的月份既无到期项、也不该出现逾期角标');
});

test('GET /api/reviews/calendar：month 非法格式返回 400', async () => {
  const { status } = await api('/api/reviews/calendar?month=2026-13');
  assert.equal(status, 400);
});

test('GET /api/reviews?due=1 口径不变：仍只回到期与逾期', async () => {
  const overdueId = addProblem('OVERDUE');
  const todayId = addProblem('TODAY');
  const futureId = addProblem('FUTURE');
  addItem(overdueId, dateAfterDays(today(), -1));
  addItem(todayId, today());
  addItem(futureId, dateAfterDays(today(), 9));

  const { body } = await api<ReviewItem[]>('/api/reviews?due=1');
  assert.deepEqual(body.map((i) => i.problemKey), ['OVERDUE', 'TODAY']);
});

test('排序：到期日升序，其次难度升序（无难度沉底）', async () => {
  const a = addProblem('A', 1800);
  const b = addProblem('B', 1200);
  const c = addProblem('C');
  db.prepare('UPDATE problems SET difficulty = NULL WHERE id = ?').run(c);
  addItem(a, today(), 0);
  addItem(b, today(), 0);
  addItem(c, today(), 0);

  const { body } = await api<ReviewItem[]>(`/api/reviews?date=${today()}`);
  assert.deepEqual(body.map((i) => i.problemKey), ['B', 'A', 'C'], '同日到期按难度升序，难度未知最后');
});

test('复习反馈后条目从「今天」消失（排期已推后）', async () => {
  const id = addProblem('A');
  const itemId = addItem(id, today());
  const before = await api<ReviewItem[]>(`/api/reviews?date=${today()}`);
  assert.equal(before.body.length, 1);

  const res = await fetch(`${base}/api/reviews/${itemId}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feedback: 'ok' }),
  });
  assert.equal(res.status, 200);
  const after = await api<ReviewItem[]>(`/api/reviews?date=${today()}`);
  assert.deepEqual(after.body, [], '反馈后已排到未来，不再出现在今天');
});
