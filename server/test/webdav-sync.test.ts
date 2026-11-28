import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { applyPendingRestore, listBackups, requestRestore } from '../src/backup.ts';
import { WebDavSync } from '../src/data-sync/service.ts';
import { digest, writeSyncSetting } from '../src/data-sync/snapshot.ts';
import { createDb } from '../src/db/index.ts';
import { annotationsPath } from '../src/knowledge/store.ts';
import { webDavSyncRoutes } from '../src/routes/webdavSync.ts';
import { listenForTest } from './test-listen.ts';

const auth = `Basic ${Buffer.from('sync-user:app-password').toString('base64')}`;
const dir = '/work/icpc-workbench-sync-v1/';

async function davServer(t: TestContext) {
  const files = new Map<string, Buffer>();
  const traffic = { upload: 0, download: 0 };
  const hooks = { beforeBlockGet: () => {}, beforeManifestPut: () => {} };
  let directory = false;
  const app = express();
  app.use(express.raw({ type: () => true, limit: '16mb' }));
  app.use((req, res) => {
    if (req.header('authorization') !== auth) return res.sendStatus(401);
    if (req.method === 'PROPFIND' && req.path === '/work/') {
      assert.equal(req.header('depth'), '0');
      return res.sendStatus(207);
    }
    if (req.method === 'MKCOL' && req.path === dir) {
      if (directory) return res.sendStatus(405);
      directory = true;
      return res.sendStatus(201);
    }
    if (!directory || !req.path.startsWith(dir)) return res.sendStatus(404);
    const name = req.path.slice(dir.length);
    if (req.method === 'PUT' && name === 'manifest.json') hooks.beforeManifestPut();
    const current = files.get(name);
    const etag = current && `"${digest(current)}"`;
    if (req.method === 'GET') {
      if (!current) return res.sendStatus(404);
      if (name.startsWith('block-')) {
        traffic.download += 1;
        hooks.beforeBlockGet();
      }
      return res.setHeader('ETag', etag!).type('application/octet-stream').send(current);
    }
    if (req.method !== 'PUT') return res.sendStatus(405);
    if (current ? req.header('if-match') !== etag : req.header('if-none-match') !== '*') {
      return res.sendStatus(412);
    }
    if (name.startsWith('block-')) {
      assert.equal(name, `block-${digest(req.body as Buffer)}.bin`);
      traffic.upload += 1;
    }
    files.set(name, req.body as Buffer);
    return res.sendStatus(current ? 204 : 201);
  });
  const server = await listenForTest(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/work/`;
  return { url, files, traffic, hooks };
}

function device(t: TestContext, url: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-webdav-'));
  const db = createDb(path.join(dataDir, 'icpc.db'));
  const sync = new WebDavSync(db, dataDir);
  const config = { url, username: 'sync-user', password: 'app-password', intervalMinutes: 1, enabled: false };
  sync.configure(config);
  t.after(() => {
    sync.configure(config);
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { db, dataDir, sync, config };
}

test('WebDAV 双向增量同步，涵盖 SQLite、标注和笔记图片', async (t) => {
  const dav = await davServer(t);
  const a = device(t, dav.url);
  const b = device(t, dav.url);
  await a.sync.testConnection({ ...a.config, password: undefined });
  a.db.exec(`
    INSERT INTO settings (key, value) VALUES ('ai.apiKey', 'local-secret');
    INSERT INTO plans (id, user_id, title, start_date, end_date) VALUES (1, 1, '训练', '2026-11-01', '2026-11-30');
    INSERT INTO plan_tasks (id, plan_id, task_date, title) VALUES (1, 1, '2026-11-27', '任务');
    INSERT INTO checkins (user_id, task_id, task_date) VALUES (1, 1, '2026-11-27');
    INSERT INTO problem_notes (user_id, identity, text)
      VALUES (1, 'codeforces:100A', '![例图](/api/uploads/demo-123456abcdef.png)');
  `);
  const image = 'demo-123456abcdef.png';
  fs.mkdirSync(path.join(a.dataDir, 'uploads'));
  fs.writeFileSync(path.join(a.dataDir, 'uploads', image), 'test image');
  const annotations = '{"platform":"codeforces","problemKey":"100A","writeSource":"manual","knowledgePoints":[]}\n';
  fs.mkdirSync(path.dirname(annotationsPath(a.dataDir)));
  fs.writeFileSync(annotationsPath(a.dataDir), annotations);

  const initial = await a.sync.run();
  assert.equal(initial.state, 'uploaded', initial.message);
  assert.ok(initial.transferredBlocks > 3);
  assert.ok([...dav.files.values()].every((body) => !body.includes('local-secret') && !body.includes('app-password')));
  const pairing = await b.sync.run();
  assert.equal(pairing.state, 'conflict', pairing.message);
  const pulled = await b.sync.run({ ...pairing.conflict!, keep: 'remote' });
  assert.equal(pulled.state, 'downloaded', pulled.message);
  assert.equal(b.db.prepare('SELECT title FROM plans').get()?.title, '训练');
  assert.equal(b.db.prepare('SELECT count(*) AS n FROM checkins').get()?.n, 1);
  assert.equal(b.db.prepare("SELECT value FROM settings WHERE key = 'ai.apiKey'").get(), undefined);
  assert.equal(fs.readFileSync(annotationsPath(b.dataDir), 'utf8'), annotations);
  assert.equal(fs.readFileSync(path.join(b.dataDir, 'uploads', image), 'utf8'), 'test image');
  const backup = listBackups(b.db)[0]!;
  assert.equal(backup.reason, 'pre-webdav-sync');
  assert.equal(backup.knowledge, true);

  const traffic = { ...dav.traffic };
  assert.equal((await b.sync.run()).state, 'unchanged');
  assert.deepEqual(dav.traffic, traffic);
  b.db.exec("UPDATE plans SET title = '设备 B 更新'");
  assert.equal((await b.sync.run()).transferredBlocks, 1);
  const incremental = await a.sync.run();
  assert.equal(incremental.state, 'downloaded', incremental.message);
  assert.equal(incremental.transferredBlocks, 1);
  assert.equal(a.db.prepare('SELECT title FROM plans').get()?.title, '设备 B 更新');
  assert.equal(a.db.prepare('SELECT count(*) AS n FROM checkins').get()?.n, 1);
  assert.equal(a.db.prepare("SELECT value FROM settings WHERE key = 'ai.apiKey'").get()?.value, 'local-secret');

  a.db.exec('DELETE FROM problem_notes');
  fs.rmSync(annotationsPath(a.dataDir));
  assert.equal((await a.sync.run()).state, 'uploaded');
  const deleted = await b.sync.run();
  assert.equal(deleted.state, 'downloaded', deleted.message);
  assert.equal(deleted.transferredBlocks, 0);
  assert.equal(b.db.prepare('SELECT count(*) AS n FROM problem_notes').get()?.n, 0);
  assert.equal(fs.existsSync(annotationsPath(b.dataDir)), false);
  assert.equal((await b.sync.run()).state, 'unchanged');

  fs.writeFileSync(annotationsPath(b.dataDir), annotations);
  requestRestore(b.db, backup.file);
  const dbFile = path.join(b.dataDir, 'icpc.db');
  b.db.close();
  try {
    assert.equal(applyPendingRestore(dbFile), backup.file);
    assert.equal(fs.existsSync(annotationsPath(b.dataDir)), false);
  } finally {
    b.db.open();
  }
});

test('保护双端改动、陈旧确认、损坏的块及并发写入', async (t) => {
  const dav = await davServer(t);
  const a = device(t, dav.url);
  const b = device(t, dav.url);
  assert.equal((await a.sync.run()).state, 'uploaded');
  assert.equal((await b.sync.run()).state, 'unchanged');
  a.db.exec("INSERT INTO problem_notes (user_id, identity, text) VALUES (1, 'codeforces:1A', 'A 改动')");
  b.db.exec("INSERT INTO problem_notes (user_id, identity, text) VALUES (1, 'codeforces:1A', 'B 改动')");
  assert.equal((await a.sync.run()).state, 'uploaded');
  const conflict = await b.sync.run();
  assert.equal(conflict.state, 'conflict');
  b.db.exec("UPDATE problem_notes SET text = 'B 再次编辑'");
  assert.match((await b.sync.run({ ...conflict.conflict!, keep: 'remote' })).message, /已有变化/);
  assert.equal(b.db.prepare('SELECT text FROM problem_notes').get()?.text, 'B 再次编辑');

  const current = await b.sync.run();
  const [name, contents] = [...dav.files].find(([, body]) => body.includes('A 改动'))!;
  dav.files.set(name, Buffer.alloc(contents.length, 'x'));
  assert.match((await b.sync.run({ ...current.conflict!, keep: 'remote' })).message, /校验失败/);
  assert.equal(b.db.prepare('SELECT text FROM problem_notes').get()?.text, 'B 再次编辑');
  dav.files.set(name, contents);
  dav.hooks.beforeBlockGet = () => b.db.exec("UPDATE problem_notes SET text = '下载时的本地编辑'");
  const changedDuringPull = await b.sync.run({ ...current.conflict!, keep: 'remote' });
  assert.equal(changedDuringPull.state, 'conflict');
  assert.match(changedDuringPull.message, /下载期间/);
  dav.hooks.beforeBlockGet = () => {};
  assert.equal((await b.sync.run({ ...changedDuringPull.conflict!, keep: 'remote' })).state, 'downloaded');

  const beforeRace = dav.files.get('manifest.json')!;
  a.db.exec("UPDATE problem_notes SET text = '准备上传'");
  const racingManifest = Buffer.from(`${beforeRace.toString()}\n`);
  dav.hooks.beforeManifestPut = () => dav.files.set('manifest.json', racingManifest);
  assert.match((await a.sync.run()).message, /远端在同步期间已更新/);
  assert.deepEqual(dav.files.get('manifest.json'), racingManifest);
  dav.hooks.beforeManifestPut = () => {};
  assert.equal((await a.sync.run()).state, 'uploaded');
  assert.equal((await b.sync.run()).state, 'downloaded');
  assert.equal(b.db.prepare('SELECT text FROM problem_notes').get()?.text, '准备上传');
});

test('远端记录违反外键时回滚本地事务，并恢复外键检查', async (t) => {
  const dav = await davServer(t);
  const a = device(t, dav.url);
  const b = device(t, dav.url);
  assert.equal((await a.sync.run()).state, 'uploaded');
  assert.equal((await b.sync.run()).state, 'unchanged');

  a.db.exec(`
    PRAGMA foreign_keys = OFF;
    INSERT INTO plan_tasks (plan_id, task_date, title) VALUES (999, '2026-11-27', '缺少对应计划');
    PRAGMA foreign_keys = ON;
  `);
  assert.equal((await a.sync.run()).state, 'uploaded');
  const result = await b.sync.run();
  assert.equal(result.state, 'error');
  assert.match(result.message, /导入已回滚/);
  assert.equal(b.db.prepare('SELECT count(*) AS n FROM plan_tasks').get()?.n, 0);
  assert.equal(b.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
  b.db.exec('BEGIN; ROLLBACK;');
});

test('设置 API 保存凭据、启动后台同步并且只返回密码状态', async (t) => {
  const dav = await davServer(t);
  const { config, sync } = device(t, dav.url);
  const app = express();
  app.use(express.json());
  app.use('/api/webdav-sync', webDavSyncRoutes(sync));
  const server = await listenForTest(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/webdav-sync`;
  const update = await fetch(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config, enabled: true }),
  });
  assert.equal(update.status, 200);
  const { settings } = await update.json();
  assert.equal(settings.enabled, true);
  assert.equal(settings.hasPassword, true);
  assert.equal(settings.password, undefined);
  for (let attempt = 0; sync.status().state !== 'uploaded' && attempt < 100; attempt += 1) await delay(25);
  assert.equal(sync.status().state, 'uploaded', sync.status().message);
  assert.ok(dav.files.has('manifest.json'));
});

test('重启可补写已提交的知识点标注，缺少暂存文件时保留现有文件', (t) => {
  const { db, dataDir, sync } = device(t, 'http://localhost/work/');
  const annotations = annotationsPath(dataDir);
  fs.mkdirSync(path.dirname(annotations));
  fs.writeFileSync(annotations, 'previous');
  writeSyncSetting(db, 'webdavSync.pendingAnnotations', digest('downloaded'));
  assert.equal(sync.recoverAnnotations(), false);
  assert.equal(sync.status().state, 'error');
  assert.equal(fs.readFileSync(annotations, 'utf8'), 'previous');
  fs.writeFileSync(`${annotations}.webdav-sync.tmp`, 'downloaded');
  assert.equal(sync.recoverAnnotations(), true);
  assert.equal(fs.readFileSync(annotations, 'utf8'), 'downloaded');
});
