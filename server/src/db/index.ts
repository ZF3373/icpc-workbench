import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../../../shared/src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** SEA 单文件分发时 schema 由入口（sea.ts）内嵌注入，不再读磁盘 */
let schemaOverride: string | null = null;

export function setSchemaSql(sql: string): void {
  schemaOverride = sql;
}

export type Db = DatabaseSync;

/**
 * 打开（或创建）SQLite 数据库并执行 schema 与种子数据。
 * 使用 Node 内置 node:sqlite（DatabaseSync），零原生依赖。
 */
export function createDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schemaOverride ?? fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  seed(db);
  return db;
}

/**
 * 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给老库补新列，
 * 这里按 PRAGMA table_info 检查缺列后 ALTER TABLE 补齐；
 * 数据修复类迁移必须幂等（重复打开同一库不再产生变化）。
 */
function migrate(db: Db): void {
  const columnsOf = (table: string): Set<string> => {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(info.map((c) => c.name));
  };
  // v0.3: template_progress 增加用户写入的模板内容列
  const progressCols = columnsOf('template_progress');
  for (const col of ['code', 'idea', 'complexity', 'url']) {
    if (!progressCols.has(col)) db.exec(`ALTER TABLE template_progress ADD COLUMN ${col} TEXT`);
  }
  mergeSlashedCfKeys(db);
}

/**
 * v0.4.3 数据修复：模板库 CF 例题键曾写成 279/B，与适配器规范键 279B 不一致，
 * 同一道题裂成两行（提交挂规范行、例题查斜杠行），例题 AC 追踪永远匹配不上。
 * 把带斜杠的行合并进规范键行（无规范行时原地改名），清理冗余行。
 */
function mergeSlashedCfKeys(db: Db): void {
  const slashed = db
    .prepare(
      "SELECT id, problem_key FROM problems WHERE platform = 'codeforces' AND instr(problem_key, '/') > 0",
    )
    .all() as unknown as Array<{ id: number; problem_key: string }>;
  if (slashed.length === 0) return;

  const canonicalOf = db.prepare(
    "SELECT id FROM problems WHERE platform = 'codeforces' AND problem_key = ?",
  );
  const rename = db.prepare('UPDATE problems SET problem_key = ? WHERE id = ?');
  const repointSubmissions = db.prepare(
    'UPDATE submissions SET problem_id = ? WHERE problem_id = ?',
  );
  const repointPlanTasks = db.prepare('UPDATE plan_tasks SET problem_id = ? WHERE problem_id = ?');
  // 复习条目同一题只留一条：规范行已有则丢弃斜杠行的
  const repointReviews = db.prepare(
    `UPDATE review_items SET problem_id = ? WHERE problem_id = ?
       AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.user_id = review_items.user_id AND r.problem_id = ?)`,
  );
  const dropReviews = db.prepare('DELETE FROM review_items WHERE problem_id = ?');
  const dropProblem = db.prepare('DELETE FROM problems WHERE id = ?');

  db.exec('BEGIN');
  try {
    for (const row of slashed) {
      const canonicalKey = row.problem_key.replaceAll('/', '');
      const keep = canonicalOf.get(canonicalKey) as { id: number } | undefined;
      if (!keep) {
        rename.run(canonicalKey, row.id);
        continue;
      }
      repointSubmissions.run(keep.id, row.id);
      repointPlanTasks.run(keep.id, row.id);
      repointReviews.run(keep.id, row.id, keep.id);
      dropReviews.run(row.id);
      dropProblem.run(row.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seed(db: Db): void {
  const upsertPlatform = db.prepare(
    'INSERT OR IGNORE INTO platforms (id, name, has_official_api) VALUES (?, ?, ?)',
  );
  for (const p of PLATFORMS) {
    upsertPlatform.run(p.id, p.name, p.hasOfficialApi ? 1 : 0);
  }
  db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (1, ?)').run('me');
}
