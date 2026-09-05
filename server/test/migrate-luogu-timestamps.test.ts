import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';

/**
 * 历史库中洛谷提交的 submitted_at 是秒级时间戳被按毫秒解析的结果（全部落回 1970 年）：
 * 迁移需按「现值当作秒」×1000 换算回真实时间，正常时间行不动，重复打开不二次变化。
 * migrate() 只在 createDb 时触发，所以用临时文件库「写旧数据 → 重开」来驱动。
 */
test('migrate: 修复被按毫秒解析的洛谷秒级时间戳（1970 行 ×1000）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-lg-'));
  const file = path.join(dir, 'icpc.db');
  try {
    const db1 = createDb(file);
    db1.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('luogu', 'P1001', 'A+B Problem')").run();
    const pid = (db1.prepare("SELECT id FROM problems WHERE problem_key = 'P1001'").get() as { id: number }).id;
    // 病态行：2026-09 真实提交（秒 1788000000）被当毫秒解析后的存储值
    const brokenStored = new Date(1788000000).toISOString(); // 1970-01-21T...
    // 正常行：本 bug 修复后写入的毫秒时间戳
    const healthy = '2026-08-30T12:00:00.000Z';
    db1.prepare(
      "INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id) VALUES (1, 'luogu', ?, 'AC', ?, 'e1')",
    ).run(pid, brokenStored);
    db1.prepare(
      "INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id) VALUES (1, 'luogu', ?, 'AC', ?, 'e2')",
    ).run(pid, healthy);
    db1.close();

    const db2 = createDb(file);
    const rows = db2
      .prepare("SELECT external_id, submitted_at FROM submissions WHERE platform = 'luogu' ORDER BY external_id")
      .all() as Array<{ external_id: string; submitted_at: string }>;
    assert.equal(rows[0].submitted_at, new Date(1788000000 * 1000).toISOString());
    assert.equal(rows[1].submitted_at, healthy); // 正常行不动

    // 幂等：再次打开无变化
    db2.close();
    const db3 = createDb(file);
    const again = db3
      .prepare("SELECT submitted_at FROM submissions WHERE external_id = 'e1'")
      .get() as { submitted_at: string };
    assert.equal(again.submitted_at, new Date(1788000000 * 1000).toISOString());
    db3.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
});
