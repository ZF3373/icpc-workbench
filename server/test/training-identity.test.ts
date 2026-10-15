import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { todayRoutes } from '../src/routes/today.ts';
import { listTodayTasks } from '../src/plans/todayTasks.ts';
import { localToday } from '../src/dates.ts';
import { listenForTest } from './test-listen.ts';

function problem(db: Db, platform: string, key: string): number {
  return Number(db.prepare('INSERT INTO problems(platform,problem_key,title,difficulty) VALUES(?,?,?,1300)').run(platform, key, key).lastInsertRowid);
}

async function recommendations(db: Db) {
  const app = express();
  app.use('/api/today', todayRoutes(db));
  const server = await listenForTest(app);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/today`);
    assert.equal(response.status, 200);
    return (await response.json()).bands.flatMap((b: { problems: Array<{ id: number }> }) => b.problems) as Array<{ id: number }>;
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('今日训练排除原题与镜像的任意历史 AC，保持用户隔离', async () => {
  const db = createDb(':memory:');
  try {
    const cf = problem(db, 'codeforces', '1234A');
    const mirror = problem(db, 'luogu', 'CF1234A');
    const at = problem(db, 'atcoder', 'abc300_a');
    const atMirror = problem(db, 'luogu', 'at_abc300_a');
    const fresh = problem(db, 'codeforces', '1234B');
    db.prepare("INSERT INTO users(id,username) VALUES(2,'other')").run();
    const ac = db.prepare("INSERT INTO submissions(user_id,platform,problem_id,verdict,submitted_at) VALUES(?,?,?,'AC','2020-01-01T00:00:00Z')");
    ac.run(1, 'codeforces', cf);
    ac.run(1, 'luogu', atMirror);
    ac.run(2, 'codeforces', fresh);
    const picked = (await recommendations(db)).map(p => p.id);
    assert.ok(picked.includes(fresh));
    assert.ok([cf, mirror, at, atMirror].every(id => !picked.includes(id)));
  } finally { db.close(); }
});

test('计划中的镜像不再作为新推荐，同题原生与镜像只推荐一次', async () => {
  const db = createDb(':memory:');
  try {
    const cf = problem(db, 'codeforces', '1234A');
    const mirror = problem(db, 'luogu', 'CF1234A');
    const fresh = problem(db, 'codeforces', '1234B');
    const freshMirror = problem(db, 'luogu', 'CF1234B');
    const date = localToday();
    const plan = db.prepare("INSERT INTO plans(user_id,title,start_date,end_date) VALUES(1,'p',?,?)").run(date, date).lastInsertRowid;
    db.prepare("INSERT INTO plan_tasks(plan_id,task_date,title,problem_id) VALUES(?,?,'p',?)").run(plan, date, mirror);
    const picked = (await recommendations(db)).map(p => p.id);
    assert.ok(!picked.includes(cf) && !picked.includes(mirror));
    assert.equal(picked.filter(id => id === fresh || id === freshMirror).length, 1);
  } finally { db.close(); }
});

test('当日 AC 确认使用镜像身份，但旧 AC 不能代替当日练习', () => {
  const db = createDb(':memory:');
  try {
    const cf = problem(db, 'codeforces', '1234A');
    const mirror = problem(db, 'luogu', 'cf1234a');
    const date = localToday();
    const plan = db.prepare("INSERT INTO plans(user_id,title,start_date,end_date) VALUES(1,'p',?,?)").run(date, date).lastInsertRowid;
    db.prepare("INSERT INTO plan_tasks(plan_id,task_date,title,problem_id) VALUES(?,?,'p',?)").run(plan, date, mirror);
    const submission = db.prepare("INSERT INTO submissions(user_id,platform,problem_id,verdict,submitted_at) VALUES(1,'codeforces',?,'AC',?)");
    submission.run(cf, '2020-01-01T00:00:00Z');
    assert.equal(listTodayTasks(db, 1, date)[0].solvedToday, false);
    submission.run(cf, new Date().toISOString());
    assert.equal(listTodayTasks(db, 1, date)[0].solvedToday, true);
  } finally { db.close(); }
});
