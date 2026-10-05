import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';

/**
 * 历史库中 CF 题号存在 279/B（模板例题旧写法）与 279B（适配器规范）并存的裂行：
 * 迁移需合并为一行，提交/计划任务/复习条目引用跟着走，重复打开不二次变化。
 * migrate() 只在 createDb 时触发，所以用临时文件库「写旧数据 → 重开」来驱动。
 */
test('migrate: 合并带斜杠的历史 CF 题号，引用重指向规范行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-'));
  const file = path.join(dir, 'icpc.db');
  try {
    const db1 = createDb(file);
    db1.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '279B', 'Books')").run();
    db1.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '279/B', 'Books')").run();
    db1.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1091/A', 'Superpermutation')").run();
    const keepId = (db1.prepare("SELECT id FROM problems WHERE problem_key = '279B'").get() as { id: number }).id;
    const orphanId = (db1.prepare("SELECT id FROM problems WHERE problem_key = '279/B'").get() as { id: number }).id;
    // 提交可能挂在规范行（同步），也可能挂在斜杠行（手动导入）
    db1.prepare(
      "INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id) VALUES (1, 'codeforces', ?, 'AC', '2026-08-30T00:00:00.000Z', 'e1')",
    ).run(keepId);
    db1.prepare(
      "INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id) VALUES (1, 'codeforces', ?, 'WA', '2026-08-29T00:00:00.000Z', 'e2')",
    ).run(orphanId);
    db1.prepare('INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (1, ?, \'2026-09-01\')').run(orphanId);
    db1.prepare(
      "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, 'p', '', '2026-08-30', '2026-08-31', 'manual')",
    ).run();
    const planId = (db1.prepare('SELECT id FROM plans LIMIT 1').get() as { id: number }).id;
    db1.prepare(
      "INSERT INTO plan_tasks (plan_id, task_date, title, problem_id) VALUES (?, '2026-08-30', 't', ?)",
    ).run(planId, orphanId);
    // 题单条目按 (platform, problem_key) 存**串**而不是行 id：合并时必须一起改键，
    // 否则条目永久指向被删掉的斜杠题号，题单页的难度/标签/已 AC 全靠 key 匹配 → 全部显示不出来
    db1.prepare("INSERT INTO problem_lists (user_id, title) VALUES (1, '我的题单')").run();
    const listId = (db1.prepare('SELECT id FROM problem_lists LIMIT 1').get() as { id: number }).id;
    db1.prepare(
      "INSERT INTO problem_list_items (list_id, platform, problem_key, title) VALUES (?, 'codeforces', '279/B', 'Books')",
    ).run(listId);
    db1.close();

    // 第二次打开触发 migrate
    const db2 = createDb(file);
    const cfKeys = (): string[] =>
      db2
        .prepare("SELECT problem_key FROM problems WHERE platform = 'codeforces' ORDER BY problem_key")
        .all()
        .map((r) => (r as { problem_key: string }).problem_key);
    assert.deepEqual(cfKeys(), ['1091A', '279B']);

    // 引用全部指向规范行
    const subProblemIds = db2
      .prepare('SELECT DISTINCT problem_id FROM submissions')
      .all()
      .map((r) => (r as { problem_id: number }).problem_id);
    assert.deepEqual(subProblemIds, [keepId]);
    const review = db2.prepare('SELECT problem_id FROM review_items').get();
    assert.equal((review as { problem_id: number }).problem_id, keepId);
    const task = db2.prepare('SELECT problem_id FROM plan_tasks LIMIT 1').get();
    assert.equal((task as { problem_id: number }).problem_id, keepId);
    // 键型引用（题单条目）也要改到保留行的题号
    const item = db2.prepare('SELECT problem_key, title FROM problem_list_items').get() as {
      problem_key: string;
      title: string;
    };
    assert.equal(item.problem_key, '279B', '题单条目必须改键到保留行，否则难度/标签/已 AC 永远匹配不上');

    // 幂等：再次打开无变化
    db2.close();
    const db3 = createDb(file);
    assert.deepEqual(
      db3
        .prepare("SELECT problem_key FROM problems WHERE platform = 'codeforces' ORDER BY problem_key")
        .all()
        .map((r) => (r as { problem_key: string }).problem_key),
      ['1091A', '279B'],
    );
    assert.equal((db3.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number }).c, 2);
    db3.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
});

/**
 * submission_intents.problem_id 是 NOT NULL 外键且无 ON DELETE：斜杠行上有卡点时，
 * 合并里的 DELETE FROM problems 会抛外键错 → 迁移整体回滚 → createDb 抛错，应用再也打不开。
 */
test('migrate: 斜杠行带卡点（submission_intents）时合并不炸启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-intent-'));
  const file = path.join(dir, 'icpc.db');
  try {
    const db1 = createDb(file);
    db1
      .prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '279B', 'Books')")
      .run();
    db1
      .prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '279/B', 'Books')")
      .run();
    const keepId = (db1.prepare("SELECT id FROM problems WHERE problem_key = '279B'").get() as { id: number }).id;
    const slashedId = (db1.prepare("SELECT id FROM problems WHERE problem_key = '279/B'").get() as {
      id: number;
    }).id;
    // 卡点挂在被合并的斜杠行上（用户是在旧写法那一行上声明的）
    db1
      .prepare("INSERT INTO submission_intents (user_id, problem_id, code, outcome) VALUES (1, ?, NULL, 'implementation')")
      .run(slashedId);
    db1.close();

    const db2 = createDb(file); // 修复前：这里抛 FOREIGN KEY constraint failed
    const intents = db2
      .prepare('SELECT problem_id FROM submission_intents')
      .all() as Array<{ problem_id: number }>;
    assert.deepEqual(
      intents.map((r) => r.problem_id),
      [keepId],
      '卡点并入保留行，而不是随被删行一起消失',
    );
    db2.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
});

/**
 * review_events 的两个外键（review_item_id / problem_id）都无级联：斜杠行上的复习条目带
 * 反馈历史时，合并里的 DELETE review_items / DELETE problems 会抛 FOREIGN KEY constraint
 * failed → 迁移整体回滚 → createDb 抛错，应用再也打不开。与上面卡点/推荐两条完全同款，
 * 只是漏了这张表（本用例是 db/index.ts 里 repointReviewEvents/dropReviewEvents 的回归）。
 * 覆盖两条分支：搬移条目的历史跟随保留行、丢弃条目的历史随条目删除（多用户）。
 */
test('migrate: 斜杠行带复习反馈历史（review_events）时合并不炸启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-revevents-'));
  const file = path.join(dir, 'icpc.db');
  try {
    const db1 = createDb(file);
    db1.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '279B', 'Books')").run();
    db1.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '279/B', 'Books')").run();
    const keepId = (db1.prepare("SELECT id FROM problems WHERE problem_key = '279B'").get() as { id: number }).id;
    const slashedId = (db1.prepare("SELECT id FROM problems WHERE problem_key = '279/B'").get() as { id: number }).id;
    db1.prepare("INSERT INTO users (id, username) VALUES (2, 'second')").run();
    const addReview = (userId: number, problemId: number): number =>
      db1
        .prepare("INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (?, ?, '2026-09-01')")
        .run(userId, problemId).lastInsertRowid as number;
    const addEvent = (userId: number, itemId: number, problemId: number): void => {
      db1.prepare(
        `INSERT INTO review_events (user_id, review_item_id, problem_id, reviewed_at, feedback,
                                    stage_before, stage_after, due_on, interval_days)
         VALUES (?, ?, ?, '2026-08-30T00:00:00.000Z', 'ok', 0, 1, '2026-09-01', 1)`,
      ).run(userId, itemId, problemId);
    };
    // 用户 1：只有斜杠行有条目 + 反馈历史 → 条目搬移，历史必须跟着改指保留行
    const movedItem = addReview(1, slashedId);
    addEvent(1, movedItem, slashedId);
    // 用户 2：保留行与斜杠行都有条目 → 斜杠行条目被丢弃，其反馈历史必须随之删除
    const keepItem2 = addReview(2, keepId);
    addEvent(2, keepItem2, keepId);
    const dropItem2 = addReview(2, slashedId);
    addEvent(2, dropItem2, slashedId);
    db1.close();

    const db2 = createDb(file); // 修复前：这里抛 FOREIGN KEY constraint failed
    const items = db2
      .prepare('SELECT id, user_id, problem_id FROM review_items ORDER BY id')
      .all()
      .map((r) => ({ ...r })) as Array<{ id: number; user_id: number; problem_id: number }>;
    assert.deepEqual(items, [
      { id: movedItem, user_id: 1, problem_id: keepId },
      { id: keepItem2, user_id: 2, problem_id: keepId },
    ], '撞 UNIQUE 的条目丢弃、未撞的搬移');
    const events = db2
      .prepare('SELECT user_id, review_item_id, problem_id FROM review_events ORDER BY id')
      .all()
      .map((r) => ({ ...r })) as Array<{ user_id: number; review_item_id: number; problem_id: number }>;
    assert.deepEqual(events, [
      { user_id: 1, review_item_id: movedItem, problem_id: keepId },
      { user_id: 2, review_item_id: keepItem2, problem_id: keepId },
    ], '搬移条目的历史改指保留行、丢弃条目的历史随之删除');
    assert.equal(
      (db2.prepare('PRAGMA foreign_key_check').all() as unknown[]).length,
      0,
      '迁移后不得留下外键孤儿（含 review_events 两个外键）',
    );
    db2.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
});

/**
 * today_recommendations 的主键是 (user_id, problem_id)，problem_id 是 NOT NULL 外键且无 ON DELETE：
 * 斜杠行被「今日训练」推荐过时，合并里的 DELETE FROM problems 会抛外键错 → 迁移整体回滚 →
 * createDb 抛错，应用再也打不开（与上面卡点那条完全同款，只是漏了这张表）。
 */
test('migrate: 斜杠行带今日训练推荐（today_recommendations）时合并不炸启动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-reco-'));
  const file = path.join(dir, 'icpc.db');
  try {
    const db1 = createDb(file);
    db1
      .prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '279B', 'Books')")
      .run();
    db1
      .prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '279/B', 'Books')")
      .run();
    const keepId = (db1.prepare("SELECT id FROM problems WHERE problem_key = '279B'").get() as { id: number }).id;
    const slashedId = (db1.prepare("SELECT id FROM problems WHERE problem_key = '279/B'").get() as {
      id: number;
    }).id;
    // 用户是在旧写法那一行上被推荐的（冷却记录挂在斜杠行）
    db1
      .prepare(
        "INSERT INTO today_recommendations (user_id, problem_id, recommended_on, band) VALUES (1, ?, '2026-09-01', 'core')",
      )
      .run(slashedId);
    db1.close();

    const db2 = createDb(file); // 修复前：这里抛 FOREIGN KEY constraint failed
    const recos = db2.prepare('SELECT problem_id FROM today_recommendations').all() as Array<{
      problem_id: number;
    }>;
    assert.deepEqual(
      recos.map((r) => r.problem_id),
      [keepId],
      '冷却记录并入保留行，而不是随被删行一起消失',
    );
    assert.equal(
      (db2.prepare('PRAGMA foreign_key_check').all() as unknown[]).length,
      0,
      '迁移后不得留下外键孤儿（含所有引用 problems 的表）',
    );
    db2.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
});
