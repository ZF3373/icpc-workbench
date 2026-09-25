import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NormalizedSubmission } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { register } from '../src/adapters/index.ts';
import { syncPlatform } from '../src/adapters/sync.ts';
import type { PlatformAdapter } from '../src/adapters/types.ts';

// ---------- v0.8 迁移：老库（单账号约束）升级为多账号 ----------

/** 按多账号上线前的旧结构建库并塞入存量数据（单账号唯一键、submissions 无 account 列） */
function createLegacyDb(file: string): DatabaseSync {
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
  return legacy;
}

test('migration v0.8: legacy db upgraded, submissions attributed to the bound handle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-'));
  const file = path.join(dir, 'legacy.db');
  const legacy = createLegacyDb(file);
  legacy.close();

  const db = createDb(file);
  try {
    // 存量提交归属当时唯一绑定的账号
    const sub = db
      .prepare('SELECT account, external_id FROM submissions WHERE platform = ?')
      .get('codeforces') as { account: string | null; external_id: string };
    assert.equal(sub.account, 'big-account');
    assert.equal(sub.external_id, 'ext-1');

    // 账号表唯一键扩为 (user_id, platform, handle)：同平台第二个账号可插入
    db.prepare(
      "INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (1, 'codeforces', 'small-account', 1)",
    ).run();
    // 同 (user_id, platform, handle) 仍受唯一约束
    assert.throws(() => {
      db.prepare(
        "INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (1, 'codeforces', 'small-account', 1)",
      ).run();
    });

    // submissions 唯一键含 account：不同账号的同号提交共存；同账号同号拒绝
    db.prepare(
      `INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id)
       VALUES (1, 'codeforces', 'small-account', 1, 'WA', '2026-01-03T00:00:00.000Z', 'ext-1')`,
    ).run();
    assert.throws(() => {
      db.prepare(
        `INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id)
         VALUES (1, 'codeforces', 'big-account', 1, 'AC', '2026-01-02T00:00:00.000Z', 'ext-1')`,
      ).run();
    });
    // 迁移幂等：重开同一库不再变化（无异常即通过）
    db.close();
    const db2 = createDb(file);
    db2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 多账号同步隔离 ----------

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

function sub(key: string, externalId: string): NormalizedSubmission {
  return {
    problem: {
      platform: 'codeforces',
      problemKey: key,
      title: `T ${key}`,
      difficulty: 1500,
      url: `https://codeforces.com/problemset/problem/${key}`,
      tags: ['dp'],
    },
    verdict: 'AC',
    language: 'C++',
    submittedAt: '2026-01-05T00:00:00.000Z',
    externalId,
  };
}

/** 假适配器：按 handle 返回各自的数据，并记录每次调用看到的已知提交号 */
let fakeCalls: Array<{ handle: string; knownIds: string[] }> = [];
function makeFake(byHandle: Record<string, NormalizedSubmission[]>) {
  fakeCalls = [];
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(handle, opts) {
      fakeCalls.push({ handle, knownIds: [...(opts?.knownExternalIds ?? [])].sort() });
      return byHandle[handle] ?? [];
    },
    knownIdsFilter: true,
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
}

test('multi-account sync: submissions isolated per account, no data cleared', async () => {
  makeFake({
    big: [sub('1919A', 'e-big-1')],
    small: [sub('1919A', 'e-small-1'), sub('1919B', 'e-small-2')],
  });
  await syncPlatform(db, 'codeforces', 'big');
  await syncPlatform(db, 'codeforces', 'small');

  const rows = db
    .prepare('SELECT account, external_id FROM submissions ORDER BY external_id')
    .all() as Array<{ account: string | null; external_id: string }>;
  assert.deepEqual(
    rows.map((r) => `${r.account}:${r.external_id}`),
    ['big:e-big-1', 'small:e-small-1', 'small:e-small-2'],
    '两账号数据按 account 隔离共存',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM platform_accounts WHERE platform = ?').get('codeforces') as { c: number }).c,
    2,
  );

  // 小号全量同步没有清掉大号数据（旧版「换账号先清库」行为已移除）
  await syncPlatform(db, 'codeforces', 'big', { userId: 1 });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE account = 'small'").get() as { c: number }).c,
    2,
  );
});

test('multi-account sync: known-ids filter and dedupe are scoped to the syncing account', async () => {
  makeFake({
    big: [sub('1919A', 'e-big-1')],
    small: [sub('1919C', 'e-big-1'), sub('1919C', 'e-small-1')],
  });
  await syncPlatform(db, 'codeforces', 'big');

  // 小号同步：适配器只看到小号自己的已知提交号（空），不能被大号的 e-big-1 干扰
  const r1 = await syncPlatform(db, 'codeforces', 'small');
  assert.deepEqual(fakeCalls.at(-1), { handle: 'small', knownIds: [] });
  assert.equal(r1.imported, 2, '小号同号提交（e-big-1）与大号不冲突，照常入库');

  // 小号再次同步：已知号过滤只含小号的提交号；全部去重
  const r2 = await syncPlatform(db, 'codeforces', 'small');
  assert.deepEqual(fakeCalls.at(-1), { handle: 'small', knownIds: ['e-big-1', 'e-small-1'] });
  assert.equal(r2.imported, 0);
  assert.equal(r2.skipped, 2);
  assert.equal(r2.incremental, true);
});

test('multi-account sync: verdict refresh and context backfill hit only own account rows', async () => {
  makeFake({ big: [] });
  await syncPlatform(db, 'codeforces', 'big');
  // 手工插入同平台的另一账号同号提交（verdict 不同）
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1919A', 'T 1919A')`,
  ).run();
  db.prepare(
    `INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id)
     VALUES (1, 'codeforces', 'small', (SELECT id FROM problems WHERE platform='codeforces' AND problem_key='1919A'), 'WA', '2026-01-04T00:00:00.000Z', 'e-shared')`,
  ).run();
  db.prepare(
    `INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id, context)
     VALUES (1, 'codeforces', 'big', (SELECT id FROM problems WHERE platform='codeforces' AND problem_key='1919A'), 'WA', '2026-01-04T00:00:00.000Z', 'e-shared', NULL)`,
  ).run();

  // 大号同步带回同号提交：平台改判 AC 只刷新大号行；context 回填也只落大号行
  makeFake({
    big: [{ ...sub('1919A', 'e-shared'), context: 'contest' }],
  });
  const rowsBefore = db
    .prepare('SELECT account, verdict, context FROM submissions WHERE external_id = ? ORDER BY account')
    .all('e-shared') as Array<{ account: string | null; verdict: string; context: string | null }>;
  assert.equal(rowsBefore.length, 2);
  await syncPlatform(db, 'codeforces', 'big');
  const rows = db
    .prepare('SELECT account, verdict, context FROM submissions WHERE external_id = ? ORDER BY account')
    .all('e-shared') as Array<{ account: string | null; verdict: string; context: string | null }>;
  const big = rows.find((r) => r.account === 'big')!;
  const small = rows.find((r) => r.account === 'small')!;
  assert.equal(big.verdict, 'AC', '改判刷新命中本账号');
  assert.equal(big.context, 'contest', '语境回填命中本账号');
  assert.equal(small.verdict, 'WA', '其他账号行不受影响');
  assert.equal(small.context, null);
});
