import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb } from '../src/db/index.ts';
import { reviewsRoutes } from '../src/routes/reviews.ts';
import { checkinsRoutes } from '../src/routes/checkins.ts';
import { localToday } from '../src/dates.ts';
import { dateAfterDays } from '../src/reviews/schedule.ts';
import { listenForTest } from './test-listen.ts';

test('复习反馈返回同题当日计划，确认后仅完成所选复习任务且可取消打卡', async () => {
  const db = createDb(':memory:');
  const date = localToday();
  const p = db.prepare('INSERT INTO problems(platform,problem_key,title) VALUES(?,?,?)');
  const original = p.run('codeforces', '1234A', 'original').lastInsertRowid;
  const mirror = p.run('luogu', 'CF1234A', 'mirror').lastInsertRowid;
  const other = p.run('codeforces', '1234B', 'other').lastInsertRowid;
  db.prepare("INSERT INTO users(id,username) VALUES(2,'other')").run();
  const plan = db.prepare("INSERT INTO plans(user_id,title,start_date,end_date) VALUES(1,'p',?,?)").run(date, date).lastInsertRowid;
  const otherPlan = db.prepare("INSERT INTO plans(user_id,title,start_date,end_date) VALUES(2,'other',?,?)").run(date, date).lastInsertRowid;
  const task = db.prepare('INSERT INTO plan_tasks(plan_id,task_date,title,kind,problem_id) VALUES(?,?,?,?,?)');
  const same = task.run(plan, date, '复习原题', 'review', original).lastInsertRowid;
  const sameMirror = task.run(plan, date, '复习镜像', 'review', mirror).lastInsertRowid;
  const unrelated = task.run(plan, date, '其它题', 'review', other).lastInsertRowid;
  task.run(plan, date, '新题任务', 'practice', original);
  task.run(plan, dateAfterDays(date, 1), '未来复习', 'review', original);
  task.run(otherPlan, date, '其它用户', 'review', original);
  const id = db.prepare('INSERT INTO review_items(user_id,problem_id,next_due_on) VALUES(1,?,?)').run(original, date).lastInsertRowid;
  const app = express(); app.use(express.json()); app.use('/api/reviews', reviewsRoutes(db));
  app.use('/api/checkins', checkinsRoutes(db));
  const server = await listenForTest(app);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/reviews/${id}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const feedback = await post('/feedback', { feedback: 'ok' });
    assert.equal(feedback.status, 200);
    assert.deepEqual(feedback.body.planTasks.map((t: { id: number }) => t.id), [Number(same), Number(sameMirror)]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkins').get()!.n, 0, '反馈本身不自动打卡');
    const eventId = feedback.body.eventId;
    assert.equal((await post('/complete-tasks', { eventId, taskIds: [Number(same), Number(unrelated)] })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkins').get()!.n, 0, '非法组合不能部分写入');
    assert.equal((await post('/complete-tasks', { eventId: eventId + 1, taskIds: [Number(same)] })).status, 404);
    assert.equal((await post('/complete-tasks', { eventId, taskIds: [Number(same)] })).body.checked, 1);
    assert.equal((await post('/complete-tasks', { eventId, taskIds: [Number(same)] })).body.checked, 0, '重复确认幂等');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_events').get()!.n, 1, '确认不再次推进排期');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkins').get()!.n, 1);
    const cancel = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/checkins/${same}`, { method: 'DELETE' });
    assert.equal(cancel.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkins').get()!.n, 0, '沿用取消打卡入口');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_events').get()!.n, 1, '取消任务打卡不抹掉复习反馈');
    db.prepare('UPDATE review_events SET reviewed_at = ? WHERE id = ?').run('2020-01-01T00:00:00Z', eventId);
    assert.equal((await post('/complete-tasks', { eventId, taskIds: [Number(sameMirror)] })).status, 409, '旧复习不能完成今天任务');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});
