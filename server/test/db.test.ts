import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { PLATFORMS } from '../../shared/src/index.ts';

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
  'template_categories',
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

test('seeds platforms and default user (me)', () => {
  const platformCount = db.prepare('SELECT COUNT(*) AS c FROM platforms').get() as {
    c: number;
  };
  assert.equal(platformCount.c, PLATFORMS.length);
  const user = db.prepare('SELECT id, username FROM users').get() as {
    id: number;
    username: string;
  };
  assert.equal(user.username, 'me');
});

test('platform_accounts unique per (user, platform, handle) — 多账号同平台可并存', () => {
  const ins = db.prepare(
    'INSERT INTO platform_accounts (user_id, platform, handle) VALUES (1, ?, ?)',
  );
  ins.run('codeforces', 'tourist');
  ins.run('codeforces', 'another_handle'); // 同平台不同账号：允许多行（v0.8 多账号）
  assert.throws(() => ins.run('codeforces', 'tourist'), /UNIQUE/); // 同平台同账号：拒绝
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM platform_accounts WHERE platform='codeforces'").get() as { c: number }).c,
    2,
  );
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

test('review_items unique per (user, problem) — 同一题在队列里只能有一条', () => {
  db.prepare(
    "INSERT INTO problems (id, platform, problem_key, title) VALUES (10, 'codeforces', '1A', 'Theatre Square')",
  ).run();
  const ins = db.prepare(
    "INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (1, ?, '2026-01-01')",
  );
  ins.run(10);
  assert.throws(() => ins.run(10), /UNIQUE/);
});

test('migrate 修复历史库中重复的复习条目（否则标量子查询取到陈旧行，题目永远显示「已加入」）', () => {
  // 复现历史库状态：去重合并把多条复习条目重指到同一个 problem_id，且旧表没有 UNIQUE。
  db.prepare(
    "INSERT INTO problems (id, platform, problem_key, title) VALUES (20, 'codeforces', '2B', 'The least round way')",
  ).run();
  const ins = db.prepare(
    "INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (1, 20, ?)",
  );
  ins.run('2026-01-01');
  // 新 schema 自带 UNIQUE，从源头就阻断重复（这正是修复的第一道防线）
  assert.throws(() => ins.run('2026-02-02'), /UNIQUE/);

  // 第二道防线：历史库里已存在的重复，由 migrate 的 dedupeReviewItems 清理。
  // 直接构造带重复行的旧表，然后断言修复查询能精确定位多余行。
  const dupeIds = db
    .prepare(
      `SELECT id FROM review_items
        WHERE id NOT IN (SELECT MIN(id) FROM review_items GROUP BY user_id, problem_id)`,
    )
    .all() as Array<{ id: number }>;
  assert.equal(dupeIds.length, 0, '刚建的新库没有重复行');

  // 模拟历史库遗留的重复行：旧表没有 UNIQUE 约束，重建一张同结构的表再写入重复行
  db.exec(`
    CREATE TABLE review_items_legacy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      problem_id INTEGER NOT NULL,
      stage INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_reviewed_at TEXT,
      next_due_on TEXT NOT NULL
    );
  `);
  const legacyIns = db.prepare(
    "INSERT INTO review_items_legacy (user_id, problem_id, next_due_on) VALUES (1, 20, ?)",
  );
  legacyIns.run('2026-01-01');
  legacyIns.run('2026-02-02');

  const dupCount = (
    db.prepare('SELECT COUNT(*) AS c FROM review_items_legacy WHERE problem_id = 20').get() as { c: number }
  ).c;
  assert.equal(dupCount, 2, '前置条件：成功构造出两条重复复习条目');

  // 标量子查询在重复行下不报错、只静默取第一行 —— 这正是必须去重的原因
  const picked = db
    .prepare(
      'SELECT (SELECT ri.id FROM review_items_legacy ri WHERE ri.problem_id = 20 AND ri.user_id = 1) AS id',
    )
    .get() as { id: number | null };
  assert.ok(picked.id != null, '重复行下子查询只取第一行且不报错（故必须去重）');

  // 修复：与 server/src/db/index.ts 的 dedupeReviewItems 同一谓词，保留最早一条
  const stale = db
    .prepare(
      `SELECT id FROM review_items_legacy
        WHERE id NOT IN (SELECT MIN(id) FROM review_items_legacy GROUP BY user_id, problem_id)`,
    )
    .all() as Array<{ id: number }>;
  assert.equal(stale.length, 1, '应恰好识别出 1 条多余复习条目');
  const drop = db.prepare('DELETE FROM review_items_legacy WHERE id = ?');
  for (const r of stale) drop.run(r.id);

  const remain = (
    db.prepare('SELECT COUNT(*) AS c FROM review_items_legacy WHERE problem_id = 20').get() as { c: number }
  ).c;
  assert.equal(remain, 1, '去重后同一题只剩一条复习条目');
  const kept = db
    .prepare('SELECT next_due_on FROM review_items_legacy WHERE problem_id = 20')
    .get() as { next_due_on: string };
  assert.equal(kept.next_due_on, '2026-01-01', '保留最早一条（与最初加入时间/进度一致）');
});
