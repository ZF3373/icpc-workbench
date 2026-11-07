import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, dedupeReviewItemsByIdentity, type Db } from '../src/db/index.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';

/**
 * 回归（2026-11-07）：存量库里同一道题的多条复习条目要被合并。
 *
 * 成因见 db/index.ts 的 dedupeReviewItemsByIdentity：review_items 按题目**行**唯一，
 * 而同一道题在 problems 里可能有多行（洛谷 CF/AT 镜像、VJudge 转发后落原平台身份）。
 * 建库时跑一次迁移把历史重复并掉，否则用户升级后仍看到同一道题在待复习列表里出现两次。
 */

function seedProblem(db: Db, platform: string, key: string, title: string): number {
  const r = db
    .prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES (?, ?, ?, '[]')")
    .run(platform, key, title);
  return Number(r.lastInsertRowid);
}

function seedReview(db: Db, problemId: number, stage: number, due: string, note: string | null = null): number {
  const r = db
    .prepare('INSERT INTO review_items (user_id, problem_id, stage, next_due_on, note) VALUES (?, ?, ?, ?, ?)')
    .run(DEFAULT_USER_ID, problemId, stage, due, note);
  return Number(r.lastInsertRowid);
}

test('迁移：同一道题的两条复习条目合并成一条，复习日志跟着走', () => {
  const db = createDb(':memory:');
  try {
    // 同一道题的两行：CF 原题与洛谷镜像（identity 都是 codeforces:1000a）
    const cf = seedProblem(db, 'codeforces', '1000A', 'A+B');
    const mirror = seedProblem(db, 'luogu', 'CF1000A', 'A+B');
    const keepId = seedReview(db, cf, 6, '2026-12-01'); // 早加入（id 小）→ 保留
    const dropId = seedReview(db, mirror, 2, '2026-11-10', '镜像那条的笔记');

    // 被合并条目上有一条复习日志（留痕数据，不能删）
    db.prepare(`INSERT INTO review_events
      (user_id, review_item_id, problem_id, reviewed_at, feedback, stage_before, stage_after, due_on, interval_days, factor)
      VALUES (?, ?, ?, '2026-11-01T00:00:00Z', 'ok', 1, 2, '2026-11-01', 7, 1)`)
      .run(DEFAULT_USER_ID, dropId, mirror);

    dedupeReviewItemsByIdentity(db);

    const items = db.prepare('SELECT id, stage, next_due_on, note FROM review_items').all() as Array<{
      id: number; stage: number; next_due_on: string; note: string | null;
    }>;
    assert.equal(items.length, 1, '同一道题只能留一条复习条目');
    assert.equal(items[0]!.id, keepId, '保留最早加入的那条');
    // 档位取高（不让已练到高档的进度被新建条目拽回）、到期日取早（不耽误该做的复习）
    assert.equal(items[0]!.stage, 6, '档位取两者较高者');
    assert.equal(items[0]!.next_due_on, '2026-11-10', '到期日取较早者');
    assert.equal(items[0]!.note, '镜像那条的笔记', '保留条目没有笔记时沿用被合并条目的');

    // 复习日志改指保留条目，历史不丢（留存系数需要它做训练数据）
    const events = db.prepare('SELECT review_item_id FROM review_events').all() as Array<{ review_item_id: number }>;
    assert.deepEqual(events.map((e) => e.review_item_id), [keepId], '复习日志跟着条目走');
  } finally { db.close(); }
});

test('迁移：不同身份的复习条目不受影响（只合并同一道题）', () => {
  const db = createDb(':memory:');
  try {
    const cf = seedProblem(db, 'codeforces', '1000A', 'A+B');
    const other = seedProblem(db, 'codeforces', '1000B', 'Another');
    seedReview(db, cf, 3, '2026-11-05');
    seedReview(db, other, 1, '2026-11-06');

    dedupeReviewItemsByIdentity(db);

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n,
      2,
      '不同的题各留一条',
    );
  } finally { db.close(); }
});

test('迁移：幂等 —— 没有重复时是空操作', () => {
  const db = createDb(':memory:');
  try {
    const cf = seedProblem(db, 'codeforces', '1000A', 'A+B');
    seedReview(db, cf, 3, '2026-11-05');
    dedupeReviewItemsByIdentity(db);
    const again = db.prepare('SELECT id, stage, next_due_on FROM review_items').all() as Array<{ id: number }>;
    assert.equal(again.length, 1);
    dedupeReviewItemsByIdentity(db);
    assert.deepEqual(
      db.prepare('SELECT id, stage, next_due_on FROM review_items').all(),
      again,
      '重复跑不改变任何行',
    );
  } finally { db.close(); }
});
