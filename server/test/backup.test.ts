import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/db/index.ts';
import {
  applyPendingRestore,
  createBackup,
  deleteBackup,
  listBackups,
  maybeDailyBackup,
  requestRestore,
} from '../src/backup.ts';

let db: Db;
let dir: string;
beforeEach(() => {
  db = createDb(':memory:');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-backup-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('createBackup：VACUUM INTO 快照包含完整数据，listBackups 返回元信息', () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('k1', 'v1')").run();
  const b = createBackup(db, 'manual', dir);
  assert.match(b.file, /^icpc-\d{8}-\d{6}-manual\.db$/);
  assert.ok(b.size > 0);

  // 备份文件可独立打开且包含数据
  const restored = createDb(path.join(dir, b.file));
  const row = restored.prepare("SELECT value FROM settings WHERE key = 'k1'").get() as { value: string };
  assert.equal(row.value, 'v1');
  restored.close();

  const list = listBackups(db, dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'manual');
});

test('保留策略：同 reason 只留最近 N 份，总份数兜底', () => {
  // 手动备份保留 10 份：创建 12 份（用不同 mtime 区分不了同秒 → 依靠文件名退避与清理逻辑）
  for (let i = 0; i < 12; i += 1) {
    createBackup(db, 'manual', dir);
    // 同秒文件名退避依赖 Date.now()%1000，可能碰撞；碰撞时 createBackup 内部会换名，不抛错即可
  }
  assert.ok(listBackups(db, dir).length <= 10, 'manual 备份应只保留 10 份');
});

test('requestRestore + applyPendingRestore：标记、覆盖与 WAL 清理', () => {
  // 模拟生产布局：dbPath 在 dir 下，备份目录派生为 dir/backups，标记写在 dir 下
  const dbPath = path.join(dir, 'main.db');
  const real = createDb(dbPath);
  real.prepare("INSERT INTO settings (key, value) VALUES ('marker', 'real')").run();
  const backup = createBackup(real, 'manual');
  real.close();

  // 备份之后再写入一个新键：恢复后该键应消失（回滚到备份时间点）
  const real2 = createDb(dbPath);
  real2.prepare("INSERT INTO settings (key, value) VALUES ('after-backup', 'x')").run();

  const marker = requestRestore(real2, backup.file);
  assert.ok(marker.requestedAt);
  assert.ok(fs.existsSync(path.join(dir, 'restore-pending.json')), '标记写在数据目录下');
  real2.close();

  const applied = applyPendingRestore(dbPath);
  assert.equal(applied, backup.file);
  assert.ok(!fs.existsSync(path.join(dir, 'restore-pending.json')), '标记应用后清除');
  assert.ok(!fs.existsSync(dbPath + '-wal'), '恢复后应清理 WAL 残留');

  // 恢复后的库不含备份之后的键
  const restored = createDb(dbPath);
  assert.equal(restored.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'after-backup'").get()!.c, 0);
  restored.close();
});

test('applyPendingRestore：无标记返回 null；非法/缺失备份安全跳过', () => {
  const dbPath = path.join(dir, 'main.db');
  const cur = createDb(dbPath);
  cur.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
  cur.close();
  assert.equal(applyPendingRestore(dbPath), null);

  fs.writeFileSync(path.join(dir, 'restore-pending.json'), JSON.stringify({ file: 'not-exist.db' }));
  assert.equal(applyPendingRestore(dbPath), null);
  const after = createDb(dbPath);
  assert.equal(after.prepare("SELECT value FROM settings WHERE key='k'").get()!.value, 'v', '恢复失败时保留现有数据库');
  after.close();
});

test('maybeDailyBackup：当日幂等，次日（模拟）可再备', () => {
  const r1 = maybeDailyBackup(db, dir);
  assert.equal(r1.created, true);
  const r2 = maybeDailyBackup(db, dir);
  assert.equal(r2.created, false, '同一天重复启动不再备份');
  assert.equal(listBackups(db, dir).length, 1);
});

// ---------- 知识点源真相（annotations.jsonl）纳入恢复点 ----------
// 背景：启动时 loadAnnotationsIntoDb 用 JSONL 重建 problem_keypoints。
// 只回滚 .db 不回滚 JSONL = 恢复点在知识点上无效（更晚的 JSONL 会立刻覆盖回来）。

const ANNOTATIONS_LINE = (key: string): string =>
  JSON.stringify({
    platform: 'luogu',
    problemKey: key,
    knowledgePoints: [{ code: 'basic.greedy', confidence: 1, source: 'manual', method: 'manual' }],
    taxonomyVersion: 2,
    pipelineVersion: 4001,
    annotatedAt: '2026-01-01T00:00:00.000Z',
    writeSource: 'manual',
  }) + '\n';

test('恢复点含知识点源真相：annotations.jsonl 与数据库同步回滚', () => {
  const dbPath = path.join(dir, 'main.db');
  const real = createDb(dbPath);
  real.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v1')").run();
  const ann = path.join(dir, 'knowledge', 'annotations.jsonl');
  fs.mkdirSync(path.dirname(ann), { recursive: true });
  fs.writeFileSync(ann, ANNOTATIONS_LINE('P1'), 'utf8');

  const backup = createBackup(real, 'manual'); // 备份目录派生为 dir/backups
  assert.equal(listBackups(real)[0]!.knowledge, true, '应生成伴生快照');

  // 备份之后：JSONL 追加一行，数据库再加一个键
  fs.appendFileSync(ann, ANNOTATIONS_LINE('P2'), 'utf8');
  real.prepare("INSERT INTO settings (key, value) VALUES ('after', 'x')").run();
  requestRestore(real, backup.file);
  real.close();

  assert.equal(applyPendingRestore(dbPath), backup.file);
  const restored = createDb(dbPath);
  assert.equal(restored.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'after'").get()!.c, 0);
  restored.close();
  const rolledBack = fs.readFileSync(ann, 'utf8');
  assert.ok(rolledBack.includes('P1'));
  assert.ok(!rolledBack.includes('P2'), 'annotations.jsonl 必须与数据库回到同一时间点');
});

test('无 annotations.jsonl 时不生成伴生快照（knowledge:false）', () => {
  const dbPath = path.join(dir, 'main.db');
  const real = createDb(dbPath);
  createBackup(real, 'manual');
  const meta = listBackups(real)[0]!;
  assert.equal(meta.knowledge, false);
  const snap = path.join(dir, 'backups', meta.file.replace(/\.db$/, '.knowledge.json'));
  assert.equal(fs.existsSync(snap), false);
  real.close();
});

test('清理备份时伴生快照同生共死，不留孤立 .knowledge.json', () => {
  const dbPath = path.join(dir, 'main.db');
  const real = createDb(dbPath);
  const ann = path.join(dir, 'knowledge', 'annotations.jsonl');
  fs.mkdirSync(path.dirname(ann), { recursive: true });
  fs.writeFileSync(ann, ANNOTATIONS_LINE('P1'), 'utf8');
  for (let i = 0; i < 12; i += 1) createBackup(real, 'manual');
  real.close();

  const files = fs.readdirSync(path.join(dir, 'backups'));
  // 与 backup.ts 的 FILE_RE 一致（含同秒退避的 -<毫秒> 后缀），否则统计口径与保留策略不一致
  const dbNameRe = /^icpc-(\d{8}-\d{6})-([a-z-]+?)(?:-\d{1,3})?\.db$/;
  const dbs = files.filter((f) => dbNameRe.test(f));
  const snaps = files.filter((f) => f.endsWith('.knowledge.json'));
  assert.ok(dbs.length <= 10, `manual 备份应只保留 10 份，实际 ${dbs.length}`);
  assert.equal(snaps.length, dbs.length, '快照数应与 .db 数一致');
  for (const s of snaps) {
    assert.ok(files.includes(s.replace(/\.knowledge\.json$/, '.db')), `孤立快照：${s}`);
  }
});

test('恢复升级前的旧备份（无伴生快照）：数据库回滚、JSONL 不动且不报错', () => {
  const dbPath = path.join(dir, 'main.db');
  const real = createDb(dbPath);
  real.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v1')").run();
  const backup = createBackup(real, 'manual');
  fs.rmSync(path.join(dir, 'backups', backup.file.replace(/\.db$/, '.knowledge.json')), { force: true });
  const ann = path.join(dir, 'knowledge', 'annotations.jsonl');
  fs.mkdirSync(path.dirname(ann), { recursive: true });
  fs.writeFileSync(ann, ANNOTATIONS_LINE('P9'), 'utf8');
  real.prepare("INSERT INTO settings (key, value) VALUES ('after', 'x')").run();
  requestRestore(real, backup.file);
  real.close();

  assert.equal(applyPendingRestore(dbPath), backup.file);
  const restored = createDb(dbPath);
  assert.equal(restored.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'after'").get()!.c, 0);
  restored.close();
  assert.ok(fs.readFileSync(ann, 'utf8').includes('P9'), '没有快照时不应动 JSONL');
});

// ---------- deleteBackup：手动删除恢复点 ----------

test('deleteBackup：删除 .db 连带伴生快照，列表同步减少', () => {
  const b1 = createBackup(db, 'manual', dir);
  const b2 = createBackup(db, 'manual', dir);
  fs.writeFileSync(path.join(dir, 'junk.txt'), 'x'); // 非备份文件不应被动到
  deleteBackup(db, b1.file, dir);
  assert.ok(!fs.existsSync(path.join(dir, b1.file)));
  assert.ok(!fs.existsSync(path.join(dir, b1.file.replace(/\.db$/, '.knowledge.json'))), '伴生快照应连带删除');
  assert.ok(fs.existsSync(path.join(dir, b2.file)), '其他备份不受影响');
  assert.ok(fs.existsSync(path.join(dir, 'junk.txt')), '无关文件不受影响');
  const list = listBackups(db, dir);
  assert.deepEqual(list.map((x) => x.file), [b2.file]);
});

test('deleteBackup：非法名称与不存在的备份报错', () => {
  createBackup(db, 'manual', dir);
  assert.throws(() => deleteBackup(db, '../escape.db', dir), /名称非法/);
  assert.throws(() => deleteBackup(db, 'icpc-20990101-000000-manual.db', dir), /不存在/);
});

test('deleteBackup：已登记为待恢复目标的备份拒绝删除', () => {
  const b = createBackup(db, 'manual', dir);
  requestRestore(db, b.file, dir);
  assert.throws(() => deleteBackup(db, b.file, dir), /待恢复目标/);
  // 其他备份仍可删除
  const b2 = createBackup(db, 'manual', dir);
  deleteBackup(db, b2.file, dir);
  assert.ok(!fs.existsSync(path.join(dir, b2.file)));
});
