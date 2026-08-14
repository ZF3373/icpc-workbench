import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AiConfig } from '../src/config.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { plansRoutes } from '../src/routes/plans.ts';

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const ai: AiConfig = { enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm' };
  const app = express();
  app.use(express.json());
  app.use('/api/plans', plansRoutes(db, () => ai));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/plans`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

test('DELETE /api/plans/:id removes plan and cascades tasks', async () => {
  await withServer(async (db, base) => {
    db.prepare(
      "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, 'p', '', '2026-08-10', '2026-08-12', 'template')",
    ).run();
    const planId = (db.prepare('SELECT id FROM plans').get() as { id: number }).id;
    db.prepare(
      "INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (?, '2026-08-10', 't1', 'practice')",
    ).run(planId);
    db.prepare(
      'INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, (SELECT id FROM plan_tasks LIMIT 1), ?)',
    ).run('2026-08-10');

    const res = await fetch(`${base}/${planId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plans').get()!.c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plan_tasks').get()!.c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM checkins').get()!.c, 0); // 级联
  });
});

test('DELETE /api/plans/:id returns 404 for missing plan', async () => {
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/999`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /不存在/);
  });
});

async function seedTask(db: Db): Promise<number> {
  db.prepare(
    "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, 'p', '', '2026-08-10', '2026-08-12', 'template')",
  ).run();
  const planId = (db.prepare('SELECT id FROM plans').get() as { id: number }).id;
  db.prepare(
    "INSERT INTO plan_tasks (plan_id, task_date, title, kind, url, note) VALUES (?, '2026-08-10', 't1', 'practice', 'https://x', 'n')",
  ).run(planId);
  return (db.prepare('SELECT id FROM plan_tasks').get() as { id: number }).id;
}

test('PATCH /api/plans/tasks/:taskId updates provided fields only', async () => {
  await withServer(async (db, base) => {
    const taskId = await seedTask(db);
    const res = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '改名', kind: 'review', url: null }),
    });
    assert.equal(res.status, 200);
    const row = db
      .prepare('SELECT task_date, title, kind, url, note FROM plan_tasks WHERE id = ?')
      .get(taskId) as { task_date: string; title: string; kind: string; url: string | null; note: string };
    assert.equal(row.title, '改名');
    assert.equal(row.kind, 'review');
    assert.equal(row.url, null); // 传 null 清空
    assert.equal(row.note, 'n'); // 未提交字段不动
    assert.equal(row.task_date, '2026-08-10');
  });
});

test('PATCH /api/plans/tasks/:taskId validates inputs and 404s', async () => {
  await withServer(async (db, base) => {
    const taskId = await seedTask(db);
    const bad = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'xxx' }),
    });
    assert.equal(bad.status, 400);
    const badDate = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskDate: '2026/08/11' }),
    });
    assert.equal(badDate.status, 400);
    const empty = await fetch(`${base}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    const missing = await fetch(`${base}/tasks/999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(missing.status, 404);
  });
});

test('DELETE /api/plans/tasks/:taskId removes task and its checkins', async () => {
  await withServer(async (db, base) => {
    const taskId = await seedTask(db);
    db.prepare('INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, ?, ?)').run(
      taskId,
      '2026-08-10',
    );
    const res = await fetch(`${base}/tasks/${taskId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM plan_tasks').get()!.c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM checkins').get()!.c, 0); // 级联
    const again = await fetch(`${base}/tasks/${taskId}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
  });
});
