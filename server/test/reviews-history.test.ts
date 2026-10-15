import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { createDb, type Db } from '../src/db/index.ts';
import { reviewsRoutes } from '../src/routes/reviews.ts';
import { listenForTest } from './test-listen.ts';

let db: Db;
let server: Server;
let base: string;

beforeEach(async () => {
  db = createDb(':memory:');
  db.prepare("INSERT INTO users(id, username) VALUES(2, 'other')").run();
  const app = express();
  app.use(express.json());
  app.use('/api/reviews', reviewsRoutes(db));
  server = await listenForTest(app);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/reviews`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
});

function item(platform = 'codeforces', key = '1234A', userId = 1) {
  const problemId = Number(db.prepare('INSERT INTO problems(platform, problem_key, title) VALUES(?,?,?)')
    .run(platform, key, key).lastInsertRowid);
  const itemId = Number(db.prepare("INSERT INTO review_items(user_id, problem_id, next_due_on) VALUES(?,?,'2026-10-15')")
    .run(userId, problemId).lastInsertRowid);
  return { problemId, itemId, userId };
}

function event(target: ReturnType<typeof item>, feedback = 'hard', at = '2026-10-15T01:00:00.000Z') {
  return Number(db.prepare(`INSERT INTO review_events
    (user_id, review_item_id, problem_id, reviewed_at, feedback, stage_before, stage_after, due_on, interval_days, factor)
    VALUES(?,?,?,?,?,3,1,'2026-10-12',5,0.7)`)
    .run(target.userId, target.itemId, target.problemId, at, feedback).lastInsertRowid);
}

test('复习记录合并同题镜像，保留当时档位、间隔与系数，不串用户或其它题目', async () => {
  const original = item();
  const mirror = item('luogu', 'CF1234A');
  const other = item('codeforces', '1234B');
  const anotherUser = item('luogu', 'cf1234a', 2);
  const first = event(original);
  const second = event(mirror, 'easy', '2026-10-16T01:00:00.000Z');
  event(other);
  event(anotherUser);
  const response = await fetch(`${base}/${original.itemId}/history`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 2);
  assert.equal(body.lapseCount, 1);
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 20);
  assert.deepEqual(body.items.map((e: { id: number }) => e.id), [second, first]);
  assert.deepEqual(body.items[0], {
    id: second, platform: 'luogu', problemKey: 'CF1234A', reviewedAt: '2026-10-16T01:00:00.000Z',
    feedback: 'easy', stageBefore: 3, stageAfter: 1, dueOn: '2026-10-12', intervalDays: 5, factor: 0.7,
  });
  const fromMirror = await fetch(`${base}/${mirror.itemId}/history`).then(r => r.json());
  assert.deepEqual(fromMirror, body);
});

test('AtCoder 镜像与大小写/下划线变体共用复习历史；未复习的队列有明确空结果', async () => {
  const original = item('atcoder', 'ABC300_A');
  const mirror = item('luogu', 'at_abc300_a');
  const empty = await fetch(`${base}/${original.itemId}/history`).then(r => r.json());
  assert.equal(empty.total, 0);
  assert.equal(empty.lapseCount, 0);
  assert.deepEqual(empty.items, []);
  const id = event(mirror, 'ok');
  const body = await fetch(`${base}/${original.itemId}/history`).then(r => r.json());
  assert.equal(body.total, 1);
  assert.equal(body.items[0].id, id);
});

test('复习历史稳定按真实时刻倒序分页，同一时刻用 ID 排序，统计覆盖全部页', async () => {
  const target = item();
  const first = event(target, 'hard', '2026-10-15T02:00:00.000Z');
  const second = event(target, 'ok', '2026-10-15T10:00:00+08:00');
  const newest = event(target, 'easy', '2026-10-15T03:00:00.000Z');
  const older = event(target, 'hard', '2026-10-14T23:00:00.000Z');
  const page1 = await fetch(`${base}/${target.itemId}/history?page=1&pageSize=2`).then(r => r.json());
  const page2 = await fetch(`${base}/${target.itemId}/history?page=2&pageSize=2`).then(r => r.json());
  assert.equal(page1.total, 4);
  assert.equal(page2.total, 4);
  assert.equal(page1.lapseCount, 2);
  assert.deepEqual(page1.items.map((e: { id: number }) => e.id), [newest, second]);
  assert.deepEqual(page2.items.map((e: { id: number }) => e.id), [first, older]);
  const beyond = await fetch(`${base}/${target.itemId}/history?page=3&pageSize=2`).then(r => r.json());
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, 4);
});

test('复习历史校验条目归属与分页参数，拒绝不存在/其它用户条目', async () => {
  const own = item();
  const other = item('luogu', 'P1000', 2);
  event(other);
  for (const path of [`/${other.itemId}/history`, '/999999/history']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  for (const path of ['/oops/history', '/0/history', '/-1/history', '/1.5/history',
    `/${own.itemId}/history?page=0`, `/${own.itemId}/history?page=1.5`,
    `/${own.itemId}/history?pageSize=101`, `/${own.itemId}/history?pageSize=0`,
    `/${own.itemId}/history?page=9007199254740992`, `/${own.itemId}/history?page=1&page=2`,
    `/${own.itemId}/history?pageSize=`]) {
    assert.equal((await fetch(base + path)).status, 400, path);
  }
});

test('查看历史只读，不影响复习排期、证据或打卡记录', async () => {
  const target = item();
  event(target);
  const before = db.prepare('SELECT * FROM review_items').all();
  const logs = db.prepare('SELECT * FROM review_events').all();
  assert.equal((await fetch(`${base}/${target.itemId}/history`)).status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM review_items').all(), before);
  assert.deepEqual(db.prepare('SELECT * FROM review_events').all(), logs);
  assert.deepEqual(db.prepare('SELECT * FROM checkins').all(), []);
});
