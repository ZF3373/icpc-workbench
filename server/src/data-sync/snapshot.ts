import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.ts';
import { annotationsPath } from '../knowledge/store.ts';
import { DataSyncError, MAX_BLOCK_BYTES } from './webdav.ts';

// 账户凭据和应用设置均保留在本机。题目与依赖其 ID 的训练数据使用同一份清单。
const TABLES = [
  'platform_accounts', 'problems', 'deleted_problems', 'problem_keypoints', 'submission_intents',
  'submissions', 'plans', 'plan_tasks', 'checkins', 'review_items', 'review_events',
  'template_progress', 'custom_templates', 'template_example_overrides', 'template_categories',
  'problem_lists', 'problem_list_items', 'participated_contests', 'contest_analysis_tags',
  'participation_sync', 'problem_notes', 'contest_notes',
] as const;

const IMAGE_NAME = /^[a-z0-9]+-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/;
const IMAGE_LINK = /\/api\/uploads\/([a-z0-9]+-[0-9a-f]{12}\.(?:png|jpg|gif|webp))\b/g;
const HASH = /^[0-9a-f]{64}$/;
const TARGET_BLOCK_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_ANNOTATIONS_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PENDING_ANNOTATIONS = 'webdavSync.pendingAnnotations';

type TableName = typeof TABLES[number];
type Cell = null | string | number;
export type Block = { hash: string; bytes: number };
type Table = { columns: string[]; blocks: Block[] };
type Image = Block & { name: string };
export type Manifest = {
  version: 1;
  tables: Record<TableName, Table>;
  annotations: Block[] | null;
  images: Image[];
};
export type Snapshot = { manifest: Manifest; blocks: Map<string, Buffer> };

export function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function readSyncSetting(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

export function writeSyncSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function writeAtomic(file: string, body: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, body, { mode: 0o600, flush: true });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function readFile(file: string, maxBytes: number): Buffer | undefined {
  try {
    if (fs.statSync(file).size > maxBytes) throw new DataSyncError('本地文件超出 WebDAV 同步大小限制');
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// 清单对应的 SQLite 事务先提交。断电后在知识点索引重建前补写 JSONL。
export function finishPendingAnnotations(db: Db, dataDir: string): void {
  const pending = readSyncSetting(db, PENDING_ANNOTATIONS);
  if (pending === undefined) return;
  const target = annotationsPath(dataDir);
  const staged = `${target}.webdav-sync.tmp`;
  if (pending === 'absent') {
    fs.rmSync(target, { force: true });
  } else {
    const data = readFile(staged, MAX_ANNOTATIONS_BYTES);
    if (data && digest(data) === pending) {
      fs.renameSync(staged, target);
    } else {
      const installed = readFile(target, MAX_ANNOTATIONS_BYTES);
      if (!installed || digest(installed) !== pending) throw new DataSyncError('无法完成上次同步的知识点标注写入');
    }
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run(PENDING_ANNOTATIONS);
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function rowValue(value: unknown): value is Cell {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

export function manifestBlocks(manifest: Manifest): Map<string, number> {
  const blocks = new Map<string, number>();
  let total = 0;
  for (const block of [
    ...Object.values(manifest.tables).flatMap((table) => table.blocks),
    ...(manifest.annotations ?? []),
    ...manifest.images,
  ]) {
    const knownSize = blocks.get(block.hash);
    if (knownSize !== undefined && knownSize !== block.bytes) throw new DataSyncError('同步清单的数据块大小不一致');
    total += block.bytes;
    if (total > MAX_SNAPSHOT_BYTES) throw new DataSyncError('数据超出 WebDAV 同步大小限制（256 MiB）');
    blocks.set(block.hash, block.bytes);
  }
  return blocks;
}

export function captureSnapshot(db: Db, dataDir: string): Snapshot {
  db.exec('BEGIN');
  try {
    return readSnapshot(db, dataDir);
  } finally {
    db.exec('ROLLBACK');
  }
}

function readSnapshot(db: Db, dataDir: string): Snapshot {
  const tables = {} as Manifest['tables'];
  const blocks = new Map<string, Buffer>();
  const imageNames = new Set<string>();
  let totalBytes = 0;
  const saveBlock = (body: Buffer): Block => {
    if (body.length > MAX_BLOCK_BYTES) throw new DataSyncError('同步记录超出单块大小限制（16 MiB）');
    const hash = digest(body);
    totalBytes += body.length;
    if (totalBytes > MAX_SNAPSHOT_BYTES) throw new DataSyncError('数据超出 WebDAV 同步大小限制（256 MiB）');
    if (!blocks.has(hash)) blocks.set(hash, body);
    return { hash, bytes: body.length };
  };

  for (const name of TABLES) {
    const info = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string; pk: number }>;
    const columns = info.map((column) => column.name).sort();
    const keys = info.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    const table: Table = { columns, blocks: [] };
    tables[name] = table;
    let buffer: string[] = [];
    let bytes = 0;
    const flush = () => {
      if (buffer.length) table.blocks.push(saveBlock(Buffer.from(buffer.join('\n'))));
      buffer = [];
      bytes = 0;
    };
    const rows = db.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${name} ORDER BY ${keys.map(quote).join(', ')}`);
    for (const row of rows.iterate()) {
      const values = columns.map((column) => row[column]);
      if (!values.every(rowValue)) throw new DataSyncError(`表 ${name} 包含不支持的同步字段`);
      const line = JSON.stringify(values);
      const lineBytes = Buffer.byteLength(line) + 1;
      if (buffer.length && bytes + lineBytes > TARGET_BLOCK_BYTES) flush();
      for (const match of line.matchAll(IMAGE_LINK)) imageNames.add(match[1]!);
      buffer.push(line);
      bytes += lineBytes;
      // 用主键确定边界，插入或删除一行只影响相邻的块，后续块可继续复用。
      const key = JSON.stringify(keys.map((column) => row[column]));
      if (digest(key).startsWith('00')) flush();
    }
    flush();
  }

  const contents = readFile(annotationsPath(dataDir), MAX_ANNOTATIONS_BYTES);
  const annotations: Block[] | null = contents ? [] : null;
  if (contents && annotations) {
    for (let offset = 0; offset < contents.length; offset += TARGET_BLOCK_BYTES) {
      annotations.push(saveBlock(contents.subarray(offset, offset + TARGET_BLOCK_BYTES)));
    }
  }
  const images: Image[] = [];
  for (const name of [...imageNames].sort()) {
    const body = readFile(path.join(dataDir, 'uploads', name), MAX_IMAGE_BYTES);
    if (body?.length) images.push({ name, ...saveBlock(body) });
  }
  return { manifest: { version: 1, tables, annotations, images }, blocks };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DataSyncError('WebDAV 同步清单格式无效');
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new DataSyncError('WebDAV 同步清单格式无效');
  return value;
}

function parseBlock(value: unknown, maxBytes = MAX_BLOCK_BYTES): Block {
  const { hash, bytes } = record(value);
  if (typeof hash !== 'string' || !HASH.test(hash) || typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > maxBytes) {
    throw new DataSyncError('WebDAV 同步清单包含无效的数据块');
  }
  return { hash, bytes };
}

export function parseManifest(body: Buffer, local: Manifest): Manifest {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    throw new DataSyncError('WebDAV 同步清单格式无效');
  }
  const raw = record(value);
  if (raw.version !== 1) throw new DataSyncError('WebDAV 同步格式不兼容，请检查各设备的应用版本');
  const rawTables = record(raw.tables);
  if (Object.keys(rawTables).length !== TABLES.length) throw new DataSyncError('设备间的数据表版本不一致，请更新到相同版本');
  const tables = {} as Manifest['tables'];
  for (const name of TABLES) {
    const table = record(rawTables[name]);
    const columns = local.tables[name].columns;
    if (JSON.stringify(table.columns) !== JSON.stringify(columns)) {
      throw new DataSyncError('设备间的数据表版本不一致，请更新到相同版本');
    }
    tables[name] = { columns, blocks: list(table.blocks).map((block) => parseBlock(block)) };
  }
  const annotations = raw.annotations === null ? null : list(raw.annotations).map((block) => parseBlock(block, TARGET_BLOCK_BYTES));
  if (annotations && annotations.reduce((sum, block) => sum + block.bytes, 0) > MAX_ANNOTATIONS_BYTES) {
    throw new DataSyncError('WebDAV 知识点标注超出大小限制');
  }
  const names = new Set<string>();
  const images = list(raw.images).map((value) => {
    const { name } = record(value);
    if (typeof name !== 'string' || !IMAGE_NAME.test(name) || names.has(name)) {
      throw new DataSyncError('WebDAV 同步清单包含无效的图片名称');
    }
    names.add(name);
    return { name, ...parseBlock(value, MAX_IMAGE_BYTES) };
  }).sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
  const manifest: Manifest = { version: 1, tables, annotations, images };
  manifestBlocks(manifest);
  return manifest;
}

export function applySnapshot(
  db: Db, dataDir: string, local: Manifest, remote: Manifest, blocks: Map<string, Buffer>, saveBase: () => void,
): void {
  const changed = TABLES.filter((name) => JSON.stringify(local.tables[name].blocks) !== JSON.stringify(remote.tables[name].blocks));
  const annotationsChanged = JSON.stringify(local.annotations) !== JSON.stringify(remote.annotations);
  const annotations = annotationsChanged && remote.annotations ? Buffer.concat(remote.annotations.map(({ hash }) => blocks.get(hash)!)) : undefined;
  if (annotations) writeAtomic(`${annotationsPath(dataDir)}.webdav-sync.tmp`, annotations);
  for (const image of remote.images) {
    const file = path.join(dataDir, 'uploads', image.name);
    const previous = readFile(file, MAX_IMAGE_BYTES);
    if (!previous) writeAtomic(file, blocks.get(image.hash)!);
    else if (digest(previous) !== image.hash) throw new DataSyncError('同名笔记图片内容不同，保留本地图片并停止同步');
  }

  // 仅替换有变化的表。暂停级联删除，提交前检查最终状态的所有外键。
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const name of changed) {
        const { columns, blocks: refs } = remote.tables[name];
        db.exec(`DELETE FROM ${name}`);
        const insert = db.prepare(`INSERT INTO ${name} (${columns.map(quote).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
        for (const ref of refs) {
          for (const line of blocks.get(ref.hash)!.toString('utf8').split('\n')) {
            const row: unknown = JSON.parse(line);
            if (!Array.isArray(row) || row.length !== columns.length || !row.every(rowValue)) {
              throw new DataSyncError('WebDAV 数据块包含无效的记录');
            }
            insert.run(...row);
          }
        }
      }
      if (changed.includes('problems')) db.exec('DELETE FROM today_recommendations');
      if (changed.includes('problems') || changed.includes('problem_keypoints')) db.exec('DELETE FROM knowledge_concept_stats');
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new DataSyncError('WebDAV 数据与本地数据库不兼容，导入已回滚');
      if (annotationsChanged) writeSyncSetting(db, PENDING_ANNOTATIONS, annotations ? digest(annotations) : 'absent');
      saveBase();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  finishPendingAnnotations(db, dataDir);
}
