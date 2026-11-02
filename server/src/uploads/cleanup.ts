import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDirFor, listBackups } from '../backup.ts';
import type { Db } from '../db/index.ts';

/**
 * 未使用上传文件的识别与清理（设置页手动触发，不做定时任务）。
 *
 * 删除不可撤销，所以判定全部从保守侧出发：
 * - 引用按「库内所有文本列」全表扫描，而不是列举已知的笔记列：以后新增的列、AI 对话里
 *   引用的图片都算数，漏列一张表就会误删用户文件，多扫几列只是慢一点；
 * - 恢复点引用的文件也保留：否则恢复备份后笔记里的图片和附件全成死链；
 * - 刚上传的文件保留：编辑器里还没保存的草稿已经把文件传上来了，此时库里还没有引用；
 * - 只认服务端生成的文件名形态，用户自己放进目录的文件不碰；
 * - 任何一个库读不了就整体失败，不在信息不全时做删除判断。
 */

/** 上传后多久才可能被判为未使用：覆盖「打开编辑器写了很久才保存」的草稿 */
export const UNUSED_GRACE_MS = 24 * 60 * 60 * 1000;

const IMAGE_FILE = /^[a-z0-9]+-[a-f0-9]{12}\.(?:png|jpg|gif|webp)$/;
const ATTACHMENT_FILE = /^[a-z0-9]+-[a-f0-9]{12}$/;
const UPLOAD_REF = /\/api\/uploads\/(files\/[a-z0-9]+-[a-f0-9]{12}|[A-Za-z0-9._-]+)/g;

export interface UnusedFile {
  /** 相对 uploads 目录的路径：图片 `xxx.png`，附件 `files/xxx` */
  file: string;
  kind: 'image' | 'attachment';
  size: number;
  modifiedAt: string;
}

export interface UploadScan {
  unused: UnusedFile[];
  unusedBytes: number;
  /** 当前数据引用的文件数 */
  inUse: number;
  /** 当前数据未引用、但恢复点还引用，因而保留的文件数 */
  keptForBackups: number;
  /** 未被引用、但上传不满 24 小时，因而保留的文件数 */
  keptRecent: number;
}

/** 从一个库的所有文本列里收集上传文件引用 */
export function collectUploadRefs(db: Pick<Db, 'prepare'>, into: Set<string> = new Set()): Set<string> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND COALESCE(sql, '') NOT LIKE 'CREATE VIRTUAL%'`,
    )
    .all() as Array<{ name: string }>;
  const quote = (id: string): string => `"${id.replaceAll('"', '""')}"`;
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string; type: string }>;
    for (const col of columns) {
      if (/^(INTEGER|INT|REAL|NUMERIC)$/i.test(col.type)) continue;
      const rows = db
        .prepare(`SELECT ${quote(col.name)} AS v FROM ${quote(name)} WHERE ${quote(col.name)} LIKE '%/api/uploads/%'`)
        .all() as Array<{ v: unknown }>;
      for (const { v } of rows) {
        const text = typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '';
        // 正文里 `.../a.png.` 这种句末标点不属于文件名
        for (const m of text.matchAll(UPLOAD_REF)) into.add(m[1].replace(/\.+$/, ''));
      }
    }
  }
  return into;
}

function listUploadFiles(uploadsDir: string): UnusedFile[] {
  const out: UnusedFile[] = [];
  const add = (dir: string, prefix: string, pattern: RegExp, kind: UnusedFile['kind']): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !pattern.test(entry.name)) continue;
      const stat = fs.statSync(path.join(dir, entry.name));
      out.push({ file: prefix + entry.name, kind, size: stat.size, modifiedAt: stat.mtime.toISOString() });
    }
  };
  add(uploadsDir, '', IMAGE_FILE, 'image');
  add(path.join(uploadsDir, 'files'), 'files/', ATTACHMENT_FILE, 'attachment');
  return out;
}

export function scanUploads(
  db: Db,
  opts: { uploadsDir: string; backupDir?: string; now?: number },
): UploadScan {
  const now = opts.now ?? Date.now();
  const current = collectUploadRefs(db);
  const inBackups = new Set<string>();
  const backupDir = backupDirFor(db, opts.backupDir);
  for (const backup of listBackups(db, opts.backupDir)) {
    const snapshot = new DatabaseSync(path.join(backupDir, backup.file), { readOnly: true });
    try {
      collectUploadRefs(snapshot, inBackups);
    } finally {
      snapshot.close();
    }
  }

  const scan: UploadScan = { unused: [], unusedBytes: 0, inUse: 0, keptForBackups: 0, keptRecent: 0 };
  for (const f of listUploadFiles(opts.uploadsDir)) {
    if (current.has(f.file)) scan.inUse += 1;
    else if (inBackups.has(f.file)) scan.keptForBackups += 1;
    else if (now - Date.parse(f.modifiedAt) < UNUSED_GRACE_MS) scan.keptRecent += 1;
    else {
      scan.unused.push(f);
      scan.unusedBytes += f.size;
    }
  }
  scan.unused.sort((a, b) => b.size - a.size);
  return scan;
}

/**
 * 删除用户确认过的文件：只删「这次重新扫描仍判为未使用」且在确认列表里的。
 * 预览到点击之间用户可能又引用了某个文件，也不会删掉预览时没展示过的文件。
 */
export function deleteUnusedUploads(
  db: Db,
  files: readonly string[],
  opts: { uploadsDir: string; backupDir?: string; now?: number },
): { deleted: number; freedBytes: number; failed: number } {
  const confirmed = new Set(files);
  const result = { deleted: 0, freedBytes: 0, failed: 0 };
  for (const f of scanUploads(db, opts).unused) {
    if (!confirmed.has(f.file)) continue;
    try {
      fs.unlinkSync(path.join(opts.uploadsDir, f.file));
      result.deleted += 1;
      result.freedBytes += f.size;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
