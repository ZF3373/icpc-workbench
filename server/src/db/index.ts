import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../../../shared/src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

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
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  seed(db);
  return db;
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
