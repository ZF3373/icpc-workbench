import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { createBackup } from '../src/backup.ts';
import { uploadsRoutes } from '../src/routes/uploads.ts';
import { deleteUnusedUploads, scanUploads, UNUSED_GRACE_MS } from '../src/uploads/cleanup.ts';

const OLD = Date.now() - UNUSED_GRACE_MS - 60_000;

interface Ctx {
  db: Db;
  uploadsDir: string;
  /** 建文件；默认上传时间早于保留期 */
  put: (rel: string, body?: string, mtime?: number) => void;
  exists: (rel: string) => boolean;
}

function withFixture(fn: (c: Ctx) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-cleanup-'));
    const uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(path.join(uploadsDir, 'files'), { recursive: true });
    const db = createDb(path.join(dir, 'main.db'));
    const put: Ctx['put'] = (rel, body = 'x', mtime = OLD) => {
      const file = path.join(uploadsDir, rel);
      fs.writeFileSync(file, body);
      fs.utimesSync(file, new Date(mtime), new Date(mtime));
    };
    try {
      await fn({ db, uploadsDir, put, exists: (rel) => fs.existsSync(path.join(uploadsDir, rel)) });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const IMG = (c: string) => `lx${c}-${c.repeat(12)}.png`;
const ATT = (c: string) => `files/lx${c}-${c.repeat(12)}`;
const unusedFiles = (c: Ctx) => scanUploads(c.db, { uploadsDir: c.uploadsDir }).unused.map((f) => f.file).sort();

function addProblem(db: Db): number {
  return Number(db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', 'ZZ1', 't', '[]')").run().lastInsertRowid);
}

test('笔记结构、Markdown 正文、复习笔记、模板笔记、任意其它文本列的引用都算使用中', withFixture((c) => {
  const pid = addProblem(c.db);
  const refs = { block: IMG('a'), att: ATT('b'), md: IMG('c'), review: IMG('d'), template: IMG('e'), other: IMG('f') };
  for (const rel of Object.values(refs)) c.put(rel);
  c.put(IMG('0'));
  c.put(ATT('1'));

  c.db.prepare('INSERT INTO problem_notes (user_id, problem_id, content, blocks) VALUES (1, ?, ?, ?)').run(
    pid,
    `![x](/api/uploads/${refs.md}).`,
    JSON.stringify([
      { type: 'image', url: `/api/uploads/${refs.block}`, name: 'a', caption: '' },
      { type: 'attachment', url: `/api/uploads/${refs.att}/a%20b.pdf`, name: 'a b.pdf', size: 1 },
    ]),
  );
  c.db.prepare('INSERT INTO review_items (user_id, problem_id, note, next_due_on) VALUES (1, ?, ?, ?)').run(pid, `![](/api/uploads/${refs.review})`, '2026-01-01');
  c.db.prepare("INSERT INTO template_progress (template_id, user_id, status, note) VALUES ('t1', 1, 'todo', ?)").run(`![](/api/uploads/${refs.template})`);
  c.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('future.column', `see /api/uploads/${refs.other}`);

  assert.deepEqual(unusedFiles(c), [ATT('1'), IMG('0')].sort());
  assert.equal(scanUploads(c.db, { uploadsDir: c.uploadsDir }).inUse, 6);
}));

test('恢复点还引用的文件保留，恢复点删除后才可清理', withFixture((c) => {
  const pid = addProblem(c.db);
  c.put(IMG('a'));
  const note = c.db.prepare('INSERT INTO problem_notes (user_id, problem_id, content) VALUES (1, ?, ?)').run(pid, `![](/api/uploads/${IMG('a')})`);
  const backup = createBackup(c.db, 'manual');
  c.db.prepare('DELETE FROM problem_notes WHERE id = ?').run(note.lastInsertRowid);

  const scan = scanUploads(c.db, { uploadsDir: c.uploadsDir });
  assert.deepEqual(scan.unused, []);
  assert.equal(scan.keptForBackups, 1);

  fs.rmSync(path.join(path.dirname(c.uploadsDir), 'backups', backup.file));
  assert.deepEqual(unusedFiles(c), [IMG('a')]);
}));

test('恢复点读不了就整体失败，不在信息不全时判定', withFixture((c) => {
  createBackup(c.db, 'manual');
  const dir = path.join(path.dirname(c.uploadsDir), 'backups');
  const [file] = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  fs.writeFileSync(path.join(dir, file), 'not a database');
  c.put(IMG('a'));
  assert.throws(() => scanUploads(c.db, { uploadsDir: c.uploadsDir }));
  assert.throws(() => deleteUnusedUploads(c.db, [IMG('a')], { uploadsDir: c.uploadsDir }));
  assert.ok(c.exists(IMG('a')));
}));

test('24 小时内上传的文件保留（草稿还没保存）；不是服务端生成的文件不碰', withFixture((c) => {
  c.put(IMG('a'), 'x', Date.now() - 1000);
  c.put('my-photo.png');
  c.put('readme.txt');
  c.put('files/manual.bin');
  const scan = scanUploads(c.db, { uploadsDir: c.uploadsDir });
  assert.deepEqual(scan.unused, []);
  assert.equal(scan.keptRecent, 1);
}));

test('只删确认清单里、且重新扫描仍未使用的文件', withFixture((c) => {
  const pid = addProblem(c.db);
  c.put(IMG('a'), '12345');
  c.put(IMG('b'));
  c.put(IMG('c'));
  // a 在预览后被重新引用；c 没在确认清单里；还混入一个穿越路径
  c.db.prepare('INSERT INTO problem_notes (user_id, problem_id, content) VALUES (1, ?, ?)').run(pid, `![](/api/uploads/${IMG('a')})`);
  const outside = path.join(path.dirname(c.uploadsDir), 'main.db');
  const r = deleteUnusedUploads(c.db, [IMG('a'), IMG('b'), '../main.db'], { uploadsDir: c.uploadsDir });
  assert.deepEqual(r, { deleted: 1, freedBytes: 1, failed: 0 });
  assert.ok(c.exists(IMG('a')));
  assert.ok(!c.exists(IMG('b')));
  assert.ok(c.exists(IMG('c')));
  assert.ok(fs.existsSync(outside));
}));

test('接口：预览不删除，确认才删除；参数校验；扫描失败回 500 不删文件', withFixture(async (c) => {
  c.put(IMG('a'));
  const app = express();
  app.use(express.json());
  app.use('/api/uploads', uploadsRoutes({ uploadsDir: c.uploadsDir, db: c.db }));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/uploads`;
  const clean = (body: unknown) => fetch(`${base}/cleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const preview = (await (await fetch(`${base}/unused`)).json()) as { unused: Array<{ file: string }> };
    assert.deepEqual(preview.unused.map((f) => f.file), [IMG('a')]);
    assert.ok(c.exists(IMG('a')));
    assert.equal((await clean({})).status, 400);
    assert.equal((await clean({ files: [1] })).status, 400);
    const ok = (await (await clean({ files: [IMG('a')] })).json()) as { deleted: number };
    assert.equal(ok.deleted, 1);
    assert.ok(!c.exists(IMG('a')));

    c.put(IMG('b'));
    createBackup(c.db, 'manual');
    const dir = path.join(path.dirname(c.uploadsDir), 'backups');
    fs.writeFileSync(path.join(dir, fs.readdirSync(dir).filter((f) => f.endsWith('.db'))[0]), 'bad');
    const failed = await fetch(`${base}/unused`);
    assert.equal(failed.status, 500);
    assert.match(((await failed.json()) as { error: string }).error, /恢复点/);
    assert.equal((await clean({ files: [IMG('b')] })).status, 500);
    assert.ok(c.exists(IMG('b')));
  } finally {
    srv.close();
  }
}));
