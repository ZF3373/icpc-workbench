import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import { reschedulePlan } from '../src/plans/reschedule.ts';

test('reschedule skips weekends and spreads workload around fixed events', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO plans (user_id, title, start_date, end_date) VALUES (1, 'p', '2026-10-16', '2026-10-20')").run();
    const insert = db.prepare('INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (1, ?, ?, ?)');
    insert.run('2026-10-17', 'a', 'practice');
    insert.run('2026-10-17', 'b', 'topic');
    insert.run('2026-10-19', '比赛', 'contest');
    insert.run('2026-10-17', '复习', 'review');
    const result = reschedulePlan(db, 1, 1, { days: 0, skipWeekends: true, dailyLimit: 1 });
    assert.equal(result.shifted, 2);
    assert.deepEqual(db.prepare("SELECT task_date FROM plan_tasks WHERE kind IN ('practice', 'topic') ORDER BY id").all().map((r) => r.task_date), ['2026-10-20', '2026-10-21']);
    assert.equal(result.endDate, '2026-10-21');
    assert.equal(db.prepare("SELECT task_date FROM plan_tasks WHERE kind = 'review'").get()!.task_date, '2026-10-17');
    assert.equal(db.prepare("SELECT task_date FROM plan_tasks WHERE kind = 'contest'").get()!.task_date, '2026-10-19');
  } finally { db.close(); }
});

test('reschedule repeated titles without UNIQUE collisions and preserves IDs', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO plans (user_id, title, start_date, end_date) VALUES (1, 'p', '2026-10-14', '2026-10-16')").run();
    const insert = db.prepare("INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (1, ?, '练习', 'practice')");
    insert.run('2026-10-14'); insert.run('2026-10-15');
    reschedulePlan(db, 1, 1, { days: 1 });
    assert.deepEqual(db.prepare('SELECT id, task_date FROM plan_tasks ORDER BY id').all().map((r) => [r.id, r.task_date]), [[1, '2026-10-15'], [2, '2026-10-16']]);
    assert.throws(() => reschedulePlan(db, 1, 1, { days: -1 }), /顺延/);
    assert.throws(() => reschedulePlan(db, 1, 1, { days: 1, dailyLimit: 0 }), /上限/);
    assert.throws(() => reschedulePlan(db, 2, 1, { days: 1 }), /不存在/);
    assert.ok(db.prepare('SELECT task_date FROM plan_tasks').all().every((r) => !String(r.task_date).startsWith('rescheduling:')));
  } finally { db.close(); }
});

test('reschedule rolls back all tasks and plan on a database write failure', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO plans (user_id, title, start_date, end_date) VALUES (1, 'p', '2026-10-14', '2026-10-15')").run();
    db.prepare("INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (1, '2026-10-14', 'a', 'practice')").run();
    db.exec("CREATE TRIGGER reject_plan_update BEFORE UPDATE ON plans BEGIN SELECT RAISE(ABORT, 'fail'); END");
    assert.throws(() => reschedulePlan(db, 1, 1, { days: 1 }), /fail/);
    assert.equal(db.prepare('SELECT task_date FROM plan_tasks').get()!.task_date, '2026-10-14');
    assert.equal(db.prepare('SELECT end_date FROM plans').get()!.end_date, '2026-10-15');
  } finally { db.close(); }
});
