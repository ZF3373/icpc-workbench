import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDb } from '../src/db/index.ts';

/**
 * v0.12 迁移：老库的 problem_lists 没有 position 列，migrate() 补列后必须**按升级前的展示顺序**
 * 回填（旧 GET /api/lists 逐字是 `ORDER BY created_at DESC, id DESC`），否则升级那一刻用户
 * 看到的题单顺序就被打乱了。
 *
 * migrate() 只在 createDb 时触发，所以这里用 node:sqlite 直接手搓一个「旧库」（列集与旧 schema
 * 完全一致、不含 position），再用 createDb 打开驱动迁移；随后 close + 重开验证幂等。
 */

/** 旧版 problem_lists（v0.5.6 之后、position 之前）的列集：不含 position */
function createLegacyDb(file: string): void {
  const db = new DatabaseSync(file);
  // 旧库按真实顺序也带着外键（users 表需要存在），这里先建最小依赖
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE problem_lists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      title      TEXT NOT NULL,
      source_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ai_suggestion  TEXT,
      ai_suggestion_at TEXT,
      ai_suggestion_order TEXT
    );
  `);
  db.prepare("INSERT INTO users (id, username) VALUES (1, 'me')").run();
  db.prepare("INSERT INTO users (id, username) VALUES (2, 'second')").run();
  db.close();
}

/** 按「旧展示顺序」读题单标题（created_at DESC, id DESC），即升级前用户看到的样子 */
function legacyDisplayOrder(file: string, userId: number): string[] {
  const db = new DatabaseSync(file);
  try {
    return (
      db
        .prepare(
          'SELECT title FROM problem_lists WHERE user_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(userId) as Array<{ title: string }>
    ).map((r) => r.title);
  } finally {
    db.close();
  }
}

test('migrate: 老库补 position 列并按旧展示顺序（created_at DESC, id DESC）回填，重开不变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-listpos-'));
  const file = path.join(dir, 'icpc.db');
  try {
    createLegacyDb(file);
    // 插入 3 条题单：created_at 与 id 故意不同向，确保「created_at DESC」而不是 id 决定顺序
    const legacy = new DatabaseSync(file);
    const ins = legacy.prepare(
      'INSERT INTO problem_lists (user_id, title, created_at) VALUES (?, ?, ?)',
    );
    ins.run(1, '最早创建', '2026-01-01T00:00:00.000Z'); // id=1
    ins.run(1, '最晚创建', '2026-03-01T00:00:00.000Z'); // id=2 → 应排第 0
    ins.run(1, '中间创建', '2026-02-01T00:00:00.000Z'); // id=3
    legacy.close();

    const before = legacyDisplayOrder(file, 1);
    assert.deepEqual(before, ['最晚创建', '中间创建', '最早创建']);

    // 打开即迁移
    const db1 = createDb(file);
    const cols = (db1.prepare('PRAGMA table_info(problem_lists)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.ok(cols.includes('position'), `position 列应被补上，实际列：${cols.join(',')}`);

    const orderAfter = (
      db1.prepare('SELECT title FROM problem_lists WHERE user_id = 1 ORDER BY position ASC, id ASC').all() as Array<{
        title: string;
      }>
    ).map((r) => r.title);
    assert.deepEqual(orderAfter, before, '升级后按 position 读出的顺序必须与升级前看到的完全一致');

    // position 是 0..n-1 的连续下标（与路由 /reorder 的写入口径一致）
    const positions = (
      db1.prepare('SELECT position FROM problem_lists WHERE user_id = 1 ORDER BY position').all() as Array<{
        position: number;
      }>
    ).map((r) => r.position);
    assert.deepEqual(positions, [0, 1, 2]);
    db1.close();

    // 幂等：再打开一次，position 不再变化
    const db2 = createDb(file);
    const orderAgain = (
      db2.prepare('SELECT title, position FROM problem_lists WHERE user_id = 1 ORDER BY position ASC, id ASC').all() as Array<{
        title: string;
        position: number;
      }>
    ).map((r) => ({ ...r }));
    assert.deepEqual(
      orderAgain,
      [
        { title: '最晚创建', position: 0 },
        { title: '中间创建', position: 1 },
        { title: '最早创建', position: 2 },
      ],
      '再次打开不得重排（迁移必须幂等）',
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

test('migrate: position 回填按用户各自从 0 起算，不跨用户串号', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-listpos-users-'));
  const file = path.join(dir, 'icpc.db');
  try {
    createLegacyDb(file);
    const legacy = new DatabaseSync(file);
    const ins = legacy.prepare('INSERT INTO problem_lists (user_id, title, created_at) VALUES (?, ?, ?)');
    ins.run(1, 'u1-早', '2026-01-01T00:00:00.000Z');
    ins.run(2, 'u2-晚', '2026-03-01T00:00:00.000Z');
    ins.run(1, 'u1-晚', '2026-02-01T00:00:00.000Z');
    ins.run(2, 'u2-早', '2026-02-15T00:00:00.000Z');
    legacy.close();

    const db = createDb(file);
    const rows = db
      .prepare('SELECT user_id, title, position FROM problem_lists ORDER BY user_id, position')
      .all()
      .map((r) => ({ ...r })) as Array<{ user_id: number; title: string; position: number }>;
    assert.deepEqual(rows, [
      { user_id: 1, title: 'u1-晚', position: 0 },
      { user_id: 1, title: 'u1-早', position: 1 },
      { user_id: 2, title: 'u2-晚', position: 0 },
      { user_id: 2, title: 'u2-早', position: 1 },
    ]);
    db.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 同上：Windows 下 WAL 句柄可能尚未释放
    }
  }
});

test('migrate: 老库没有任何题单时补列不炸（空表回填）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-listpos-empty-'));
  const file = path.join(dir, 'icpc.db');
  try {
    createLegacyDb(file);
    const db = createDb(file);
    const cols = (db.prepare('PRAGMA table_info(problem_lists)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    assert.ok(cols.includes('position'));
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM problem_lists').get() as { c: number }).c, 0);
    db.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 同上
    }
  }
});
