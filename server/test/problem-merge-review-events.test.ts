import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { mergeProblemRow } from '../src/import/problemMerge.ts';

/**
 * 回归：洛谷比赛题 T 号赛后转正为 P 号时，insertNormalized 走 mergeProblemRow 合并旧题行。
 * 复习反馈历史（review_events）的两个外键（review_item_id / problem_id）都无级联——
 * 修复前合并路径不清理它们，DELETE review_items / DELETE problems 抛
 * FOREIGN KEY constraint failed，整个同步事务回滚；旧键提交每次同步都会重新下发，
 * 同步从此每次失败，直到手工修库。复习过的题（至少反馈过一次）才会触发。
 */

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

const addProblem = (key: string): number =>
  db
    .prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('luogu', ?, ?)")
    .run(key, `题 ${key}`).lastInsertRowid as number;

const addReviewItem = (userId: number, problemId: number): number =>
  db
    .prepare("INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (?, ?, '2026-10-10')")
    .run(userId, problemId).lastInsertRowid as number;

const addReviewEvent = (userId: number, itemId: number, problemId: number): void => {
  db.prepare(
    `INSERT INTO review_events (user_id, review_item_id, problem_id, reviewed_at, feedback,
                                stage_before, stage_after, due_on, interval_days)
     VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', 'ok', 0, 1, '2026-10-01', 1)`,
  ).run(userId, itemId, problemId);
};

test('搬移路径：复习过的 T 号题转正合并后，条目与反馈历史一起对齐保留行，不抛外键错', () => {
  const fromId = addProblem('T123456');
  const toId = addProblem('P123456');
  const itemId = addReviewItem(1, fromId);
  addReviewEvent(1, itemId, fromId);

  mergeProblemRow(db, { platform: 'luogu', fromId, fromKey: 'T123456', toId, toKey: 'P123456' });

  assert.equal(
    (db.prepare('SELECT COUNT(*) c FROM problems WHERE id = ?').get(fromId) as { c: number }).c,
    0,
    '旧题行已删除',
  );
  const item = db.prepare('SELECT problem_id FROM review_items WHERE id = ?').get(itemId) as {
    problem_id: number;
  };
  assert.equal(item.problem_id, toId, '复习条目并入保留行');
  const ev = db.prepare('SELECT problem_id, review_item_id FROM review_events').get() as {
    problem_id: number;
    review_item_id: number;
  };
  assert.equal(ev.problem_id, toId, '反馈历史跟随条目对齐保留行');
  assert.equal(ev.review_item_id, itemId, '反馈历史仍挂在原条目上');
});

test('丢弃路径：保留行已有同用户条目时，旧行条目与其反馈历史一起删除，不抛外键错', () => {
  const fromId = addProblem('T123456');
  const toId = addProblem('P123456');
  const dropItemId = addReviewItem(1, fromId);
  addReviewEvent(1, dropItemId, fromId);
  const keepItemId = addReviewItem(1, toId);
  addReviewEvent(1, keepItemId, toId);

  mergeProblemRow(db, { platform: 'luogu', fromId, fromKey: 'T123456', toId, toKey: 'P123456' });

  assert.equal(
    (db.prepare('SELECT COUNT(*) c FROM problems WHERE id = ?').get(fromId) as { c: number }).c,
    0,
    '旧题行已删除',
  );
  const items = db
    .prepare('SELECT id, problem_id FROM review_items ORDER BY id')
    .all()
    .map((r) => ({ ...r })) as Array<{ id: number; problem_id: number }>;
  assert.deepEqual(items, [{ id: keepItemId, problem_id: toId }], '只剩保留行的条目');
  const evs = db
    .prepare('SELECT problem_id, review_item_id FROM review_events ORDER BY id')
    .all()
    .map((r) => ({ ...r })) as Array<{ problem_id: number; review_item_id: number }>;
  assert.deepEqual(
    evs,
    [{ problem_id: toId, review_item_id: keepItemId }],
    '丢弃条目的反馈历史随之删除，保留条目的历史不受影响',
  );
});

test('多用户：各自条目独立处理——撞 UNIQUE 的丢弃、未撞的搬移，反馈历史同口径', () => {
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'second')").run();
  const fromId = addProblem('T123456');
  const toId = addProblem('P123456');
  // 用户 1 两边都有条目 → 旧行侧丢弃
  const dropItemId = addReviewItem(1, fromId);
  addReviewEvent(1, dropItemId, fromId);
  const keepItemId = addReviewItem(1, toId);
  // 用户 2 只有旧行条目 → 搬移
  const movedItemId = addReviewItem(2, fromId);
  addReviewEvent(2, movedItemId, fromId);

  mergeProblemRow(db, { platform: 'luogu', fromId, fromKey: 'T123456', toId, toKey: 'P123456' });

  const items = db
    .prepare('SELECT user_id, id, problem_id FROM review_items ORDER BY id')
    .all()
    .map((r) => ({ ...r })) as Array<{ user_id: number; id: number; problem_id: number }>;
  assert.deepEqual(items, [
    { user_id: 1, id: keepItemId, problem_id: toId },
    { user_id: 2, id: movedItemId, problem_id: toId },
  ]);
  const evs = db
    .prepare('SELECT user_id, problem_id, review_item_id FROM review_events ORDER BY id')
    .all()
    .map((r) => ({ ...r })) as Array<{ user_id: number; problem_id: number; review_item_id: number }>;
  assert.deepEqual(evs, [
    { user_id: 2, problem_id: toId, review_item_id: movedItemId },
  ]);
});
