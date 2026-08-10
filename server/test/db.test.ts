import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

afterEach(() => {
  db.close();
});

const TABLES = [
  'platforms',
  'users',
  'platform_accounts',
  'problems',
  'submissions',
  'plans',
  'plan_tasks',
  'checkins',
  'settings',
];

test('schema creates all tables', () => {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  const names = rows.map((r) => r.name);
  for (const t of TABLES) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
});

test('seeds platforms (4) and default user (me)', () => {
  const platformCount = db.prepare('SELECT COUNT(*) AS c FROM platforms').get() as {
    c: number;
  };
  assert.equal(platformCount.c, 4);
  const user = db.prepare('SELECT id, username FROM users').get() as {
    id: number;
    username: string;
  };
  assert.equal(user.username, 'me');
});

test('platform_accounts unique per (user, platform)', () => {
  const ins = db.prepare(
    'INSERT INTO platform_accounts (user_id, platform, handle) VALUES (1, ?, ?)',
  );
  ins.run('codeforces', 'tourist');
  assert.throws(() => ins.run('codeforces', 'another_handle'), /UNIQUE/);
});

test('checkins references plan_tasks and cascades', () => {
  db.prepare(
    "INSERT INTO plans (user_id, title, start_date, end_date) VALUES (1, 'p', '2026-01-01', '2026-01-07')",
  ).run();
  const taskId = Number(
    db
      .prepare("INSERT INTO plan_tasks (plan_id, task_date, title) VALUES (1, '2026-01-01', 't1')")
      .run()
      .lastInsertRowid,
  );
  db.prepare(
    'INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, ?, ?)',
  ).run(taskId, '2026-01-01');
  const dup = db.prepare(
    'INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, ?, ?)',
  );
  assert.throws(() => dup.run(taskId, '2026-01-01'), /UNIQUE/);
  // 级联删除：删计划任务后打卡记录随之删除
  db.prepare('DELETE FROM plan_tasks WHERE id = ?').run(taskId);
  const remain = db.prepare('SELECT COUNT(*) AS c FROM checkins').get() as { c: number };
  assert.equal(remain.c, 0);
});
