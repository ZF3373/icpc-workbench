import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/db/index.ts';

/**
 * 冗余索引 `idx_submissions_user_platform(user_id, platform)` 的清理回归（优化计划 #9）。
 *
 * 它是 `idx_submissions_user_account(user_id, platform, account)` 的严格前缀：
 * SQLite 用复合索引前缀即可服务 `(user_id, platform)` 过滤，多出来的索引只让每条提交
 * INSERT 多维护一棵 B 树。老库（v0.8 多账号重建前建的）需要迁移删除，新库不应再创建。
 */

function indexNames(db: Db, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

function withTempDb(fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-redundant-index-'));
  try {
    fn(path.join(dir, 'legacy.db'));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
}

/** 旧结构（无 account 列）+ 旧版冗余索引：模拟升级前的库，走完整的 v0.8 重建迁移 */
function createLegacyDb(file: string): void {
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE platforms (id TEXT PRIMARY KEY, name TEXT NOT NULL, has_official_api INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE platform_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      platform TEXT NOT NULL REFERENCES platforms(id),
      handle TEXT NOT NULL,
      last_sync_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sync_truncated INTEGER NOT NULL DEFAULT 0,
      backfill_page INTEGER,
      UNIQUE (user_id, platform)
    );
    CREATE TABLE problems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL REFERENCES platforms(id),
      problem_key TEXT NOT NULL,
      title TEXT NOT NULL,
      difficulty INTEGER,
      url TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      UNIQUE (platform, problem_key)
    );
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      platform TEXT NOT NULL REFERENCES platforms(id),
      problem_id INTEGER NOT NULL REFERENCES problems(id),
      verdict TEXT NOT NULL,
      language TEXT,
      submitted_at TEXT NOT NULL,
      external_id TEXT,
      context TEXT,
      UNIQUE (user_id, platform, external_id)
    );
    INSERT INTO users (id, username) VALUES (1, 'me');
    INSERT INTO platforms (id, name, has_official_api) VALUES ('codeforces', 'Codeforces', 1);
    INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled) VALUES (1, 'codeforces', 'alice', '2026-01-01T00:00:00.000Z', 1);
    INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1919A', 'T 1919A');
    INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id)
      VALUES (1, 'codeforces', 1, 'AC', '2026-01-02T00:00:00.000Z', 'ext-1');
    -- 旧版建过的冗余索引（重建迁移前存在）
    CREATE INDEX idx_submissions_user_platform ON submissions(user_id, platform);
    CREATE INDEX idx_submissions_user_time ON submissions(user_id, submitted_at);
  `);
  legacy.close();
}

test('新库不创建冗余索引 idx_submissions_user_platform', () => {
  const db = createDb(':memory:');
  try {
    const names = indexNames(db, 'submissions');
    assert.ok(names.includes('idx_submissions_user_account'), '复合索引必须存在');
    assert.ok(
      !names.includes('idx_submissions_user_platform'),
      '冗余索引不得出现在新库（它是 user_account 的严格前缀）',
    );
  } finally {
    db.close();
  }
});

test('老库迁移后冗余索引被删除，数据与账号归属不受影响', () => {
  withTempDb((file) => {
    createLegacyDb(file);
    const db = createDb(file);
    try {
      const names = indexNames(db, 'submissions');
      assert.ok(
        !names.includes('idx_submissions_user_platform'),
        '老库残留的冗余索引必须在迁移里 DROP 掉',
      );
      assert.ok(names.includes('idx_submissions_user_account'), '迁移后仍需补上复合索引');
      const rows = db.prepare('SELECT external_id, account FROM submissions').all() as Array<{
        external_id: string;
        account: string;
      }>;
      assert.deepEqual(
        rows.map((r) => ({ external_id: r.external_id, account: r.account })),
        [{ external_id: 'ext-1', account: 'alice' }],
        '重建迁移不得丢数据',
      );
    } finally {
      db.close();
    }
  });
});

test('迁移幂等：重复打开已迁移的老库不再报错，索引状态保持', () => {
  withTempDb((file) => {
    createLegacyDb(file);
    createDb(file).close();
    const db = createDb(file);
    try {
      const names = indexNames(db, 'submissions');
      assert.ok(!names.includes('idx_submissions_user_platform'));
      assert.ok(names.includes('idx_submissions_user_account'));
    } finally {
      db.close();
    }
  });
});

test('(user_id, platform) 过滤仍走 idx_submissions_user_account 前缀，不再依赖被删索引', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1A', 'x')").run();
    const ins = db.prepare(
      `INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id)
       VALUES (1, ?, ?, 1, 'AC', ?, ?)`,
    );
    db.exec('BEGIN');
    for (let i = 0; i < 500; i++) {
      ins.run(['codeforces', 'atcoder'][i % 2], `acct${i % 5}`, `2026-01-0${(i % 9) + 1}T00:00:00Z`, `e${i}`);
    }
    db.exec('COMMIT');
    db.exec('ANALYZE');

    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM submissions WHERE user_id = ? AND platform = ?')
      .all(1, 'codeforces') as Array<{ detail: string }>;
    const detail = plan.map((p) => p.detail).join(' | ');
    assert.match(detail, /idx_submissions_user_account/, `前缀过滤应走复合索引，实际: ${detail}`);
    assert.ok(!detail.includes('idx_submissions_user_platform'));
    assert.ok(!/SCAN submissions/.test(detail), `不得退化为全表扫描，实际: ${detail}`);
  } finally {
    db.close();
  }
});
