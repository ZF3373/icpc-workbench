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
 * 轻量列迁移：CREATE TABLE IF NOT EXISTS 不会给老库补新列，
 * 这里按 PRAGMA table_info 检查缺列后 ALTER TABLE 补齐。
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
