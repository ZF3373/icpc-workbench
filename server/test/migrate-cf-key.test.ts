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
