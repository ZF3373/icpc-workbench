import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDb } from '../src/db/index.ts';
import { IDENTITY_COLUMN_EXPR, IDENTITY_COLUMN_SQL, problemIdentity, problemIdentitySql } from '../src/problems/identity.ts';

/**
 * v0.11：problems.identity 生成列（今日训练候选按身份连接派生表时走真实索引）。
 *
 * 两个不能退化的点：
 * 1. 口径 —— 生成列必须与 JS 的 problemIdentity / SQL 的 problemIdentitySql 逐字节一致；
 * 2. 幂等 —— PRAGMA table_info **不返回生成列**，迁移若用它判存在性，第二次打开会
 *    直接抛 "duplicate column name: identity"，应用再也起不来。
 */

const MIRROR_ROWS: Array<[string, string]> = [
  ['codeforces', '1919C'],
  ['atcoder', 'abc300_a'],
  ['atcoder', 'ABC_300_A'],
  ['atcoder', 'joi2011ho1'],
  ['luogu', 'cf1919C'],
  ['luogu', 'at_abc300_a'],
  ['luogu', ' P1001 '],
  ['luogu', 'p1001'],
  ['nowcoder', 'ABC'],
];

const generatedCols = (db: DatabaseSync): string[] =>
  (db.prepare('PRAGMA table_xinfo(problems)').all() as Array<{ name: string; hidden: number }>)
    .filter((c) => c.hidden !== 0)
    .map((c) => c.name);

test('problems.identity：与 JS / SQL 身份口径逐字节一致', () => {
  const db = createDb(':memory:');
  const ins = db.prepare('INSERT INTO problems (platform, problem_key, title) VALUES (?, ?, ?)');
  for (const [platform, key] of MIRROR_ROWS) ins.run(platform, key, `${platform}/${key}`);
  const rows = db
    .prepare(`SELECT platform, problem_key, identity, ${problemIdentitySql('p')} AS expr FROM problems p ORDER BY id`)
    .all() as Array<{ platform: string; problem_key: string; identity: string; expr: string }>;
  for (const row of rows) {
    const js = problemIdentity({ platform: row.platform, problemKey: row.problem_key });
    assert.equal(row.identity, js, `生成列与 JS 口径不一致: ${row.platform}/${row.problem_key}`);
    assert.equal(row.expr, js, `problemIdentitySql 与 JS 口径不一致: ${row.platform}/${row.problem_key}`);
  }
  // 镜像归并的既有语义：CF 镜像与 AtCoder 展示/规范题号落到同一个 identity
  const byKey = new Map(rows.map((r) => [`${r.platform}/${r.problem_key}`, r.identity]));
  assert.equal(byKey.get('luogu/cf1919C'), 'codeforces:1919c');
  assert.equal(byKey.get('atcoder/abc300_a'), byKey.get('atcoder/ABC_300_A'));
  assert.equal(byKey.get('luogu/at_abc300_a'), byKey.get('atcoder/abc300_a'));
  assert.equal(byKey.get('luogu/ P1001 '), 'luogu:p1001');
  assert.equal(byKey.get('luogu/p1001'), 'luogu:p1001');
  db.close();
});

test('problems.identity：库里每一行的生成列都等于不带别名的表达式（防表达式漂移）', () => {
  const db = createDb(':memory:');
  const ins = db.prepare('INSERT INTO problems (platform, problem_key, title) VALUES (?, ?, ?)');
  for (const [platform, key] of MIRROR_ROWS) ins.run(platform, key, key);
  const mismatch = (
    db.prepare(`SELECT COUNT(*) AS c FROM problems p WHERE p.identity IS NOT (${IDENTITY_COLUMN_EXPR})`).get() as {
      c: number;
    }
  ).c;
  assert.equal(mismatch, 0, '生成列表达式与 IDENTITY_COLUMN_EXPR 必须同源');
  db.close();
});

test('迁移：老库补 identity 生成列 + 索引，重复打开幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-identity-'));
  const file = path.join(dir, 'icpc.db');
  try {
    // 构造 v0.10 形态的老库：problems 没有 identity 列（schema.sql 不建它，只由迁移补）
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE problems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      problem_key TEXT NOT NULL,
      title TEXT NOT NULL,
      difficulty INTEGER,
      url TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      difficulty_source TEXT,
      native_difficulty TEXT,
      difficulty_scale TEXT,
      gap_state TEXT,
      gap_checked_at TEXT,
      UNIQUE (platform, problem_key)
    )`);
    const ins = legacy.prepare('INSERT INTO problems (platform, problem_key, title) VALUES (?, ?, ?)');
    for (const [platform, key] of MIRROR_ROWS) ins.run(platform, key, key);
    legacy.close();

    const db1 = createDb(file);
    assert.deepEqual(generatedCols(db1), ['identity'], '老库应被补上生成列');
    const indexNames = (db1.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='problems'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    assert.ok(indexNames.includes('idx_problems_identity'), '身份索引必须建好');
    const identityOf = (platform: string, key: string): string =>
      (db1.prepare('SELECT identity FROM problems WHERE platform = ? AND problem_key = ?').get(platform, key) as {
        identity: string;
      }).identity;
    assert.equal(identityOf('luogu', 'cf1919C'), 'codeforces:1919c', '老库补列后口径与 JS 一致');
    assert.equal(identityOf('atcoder', 'ABC_300_A'), 'atcoder:abc300a');
    // 生成列随写入即时生效（老库补列后新插入的行同样有值）
    db1.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('luogu', 'at_abc999_z', 'x')").run();
    assert.equal(identityOf('luogu', 'at_abc999_z'), 'atcoder:abc999z');
    db1.close();

    // 幂等：第二次、第三次打开都不再改结构（table_info 看不到生成列，靠 table_xinfo 判断）
    const db2 = createDb(file);
    assert.deepEqual(generatedCols(db2), ['identity']);
    db2.close();
    const db3 = createDb(file);
    assert.deepEqual(generatedCols(db3), ['identity']);
    assert.equal((db3.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number }).c, MIRROR_ROWS.length + 1);
    db3.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
});

test('IDENTITY_COLUMN_SQL 指向生成列（调用处题目表别名必须是 p）', () => {
  const db = createDb(':memory:');
  db.prepare("INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1A', 'A')").run();
  const row = db.prepare(`SELECT ${IDENTITY_COLUMN_SQL} AS identity FROM problems p`).get() as { identity: string };
  assert.equal(row.identity, 'codeforces:1a');
  db.close();
});
