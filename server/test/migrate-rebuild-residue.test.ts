import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';

/**
 * v0.8 多账号重建（submissions 加 account 列、platform_accounts 扩唯一键）的**原子性**回归。
 *
 * 旧实现把 CREATE TABLE <t>_new 放在 BEGIN 之前、把 DROP/RENAME 放在 COMMIT 之后，
 * 而 SQLite 的 DDL 是隐式提交的 —— 于是重建中途被进程杀死只有一个后果：
 * 残留的 _new 表让此后**每次**启动都抛 `table <t>_new already exists`，应用再也打不开，
 * 且没有任何自愈路径（备份也救不了，因为 createDb 在备份之前就抛了）。
 *
 * 修复后：残留的 _new 表在进入重建前被清掉（此刻源表 data 完好，残留的只是不完整拷贝），
 * 且建表/拷贝/换名/重建索引整段处于同一个事务内。
 */

/** 按多账号上线前的旧结构建库（submissions 无 account 列、platform_accounts 单账号唯一键） */
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
    INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled) VALUES (1, 'codeforces', 'big-account', '2026-01-01T00:00:00.000Z', 1);
    INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1919A', 'T 1919A');
    INSERT INTO submissions (user_id, platform, problem_id, verdict, submitted_at, external_id)
      VALUES (1, 'codeforces', 1, 'AC', '2026-01-02T00:00:00.000Z', 'ext-1');
  `);
  legacy.close();
}

function withTempDb(fn: (file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-rebuild-'));
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

test('migrate: submissions_new 残留（重建中途被杀）不得让应用再也起不来', () => {
  withTempDb((file) => {
    createLegacyDb(file);
    // 模拟「拷到一半被杀」：DDL 已被隐式提交，数据只拷了一部分 —— 源表 submissions 完好
    const sim = new DatabaseSync(file);
    sim.exec(`
      CREATE TABLE submissions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT '',
        problem_id INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        language TEXT,
        submitted_at TEXT NOT NULL,
        external_id TEXT,
        context TEXT,
        UNIQUE (user_id, platform, account, external_id)
      )`);
    sim.exec(
      `INSERT INTO submissions_new (id, user_id, platform, account, problem_id, verdict, submitted_at, external_id)
       VALUES (1, 1, 'codeforces', 'big-account', 1, 'AC', '2026-01-02T00:00:00.000Z', 'ext-1')`,
    );
    sim.close();

    const db = createDb(file); // 修复前：抛 table submissions_new already exists
    try {
      const rows = db.prepare('SELECT external_id, account FROM submissions').all() as Array<{
        external_id: string;
        account: string;
      }>;
      assert.equal(rows.length, 1, '源表数据必须仍在（重建以 submissions 为源，残留的只是不完整拷贝）');
      assert.equal(rows[0].external_id, 'ext-1');
      assert.equal(rows[0].account, 'big-account', '迁移仍须把存量提交归属到当时唯一绑定的账号');
      const residue = db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'submissions_new'")
        .get() as { c: number };
      assert.equal(residue.c, 0, '残留的 _new 表必须被清掉，否则每次启动都会再抛一次');
    } finally {
      db.close();
    }
  });
});

test('migrate: platform_accounts_new 残留（重建中途被杀）不得让应用再也起不来', () => {
  withTempDb((file) => {
    createLegacyDb(file);
    const sim = new DatabaseSync(file);
    sim.exec(`
      CREATE TABLE platform_accounts_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        handle TEXT NOT NULL,
        last_sync_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        sync_truncated INTEGER NOT NULL DEFAULT 0,
        backfill_page INTEGER,
        UNIQUE (user_id, platform, handle)
      )`);
    sim.close();

    const db = createDb(file); // 修复前：抛 table platform_accounts_new already exists
    try {
      const accounts = db
        .prepare('SELECT handle FROM platform_accounts')
        .all() as Array<{ handle: string }>;
      assert.deepEqual(accounts.map((a) => a.handle), ['big-account'], '账号绑定不得丢失');
      const residue = db
        .prepare(
          "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'platform_accounts_new'",
        )
        .get() as { c: number };
      assert.equal(residue.c, 0);
    } finally {
      db.close();
    }
  });
});
