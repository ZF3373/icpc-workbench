import { listenForTest } from './test-listen.ts';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { backupsRoutes, type BackupsRoutesOptions } from '../src/routes/backups.ts';
import { createBackup, requestRestore } from '../src/backup.ts';
import { isDockerRuntime } from '../src/runtime-env.ts';

/**
 * 备份路由回归测试：下载接口与待恢复状态。
 *
 * 背景：恢复点原先只能留在数据卷里（宿主机损坏即全丢），且恢复是「写标记 + 重启生效」——
 * Docker 用户点完恢复不知道要 docker restart，重启前再点别的备份还会静默覆盖标记。
 * 本文件锁定：下载接口（含目录穿越拒绝）、列表带 pendingRestore、重启端点的环境边界。
 */

let db: Db;
let dir: string;

/** 生产布局：dir 下放 db 与 backups/，标记写在 dir 下 */
function openDb(): Db {
  return createDb(path.join(dir, 'main.db'));
}

async function withApp(opts: BackupsRoutesOptions, fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/backups', backupsRoutes(db, opts));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/backups`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-backup-routes-'));
  db = openDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 下载接口 ----------

test('GET /:name/download 返回备份文件本体与附件头', async () => {
  const b = createBackup(db, 'manual');
  await withApp({ isDocker: false }, async (base) => {
    const res = await fetch(`${base}/${encodeURIComponent(b.file)}/download`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
    assert.ok((res.headers.get('content-disposition') ?? '').includes(b.file));
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.length, b.size, '下载字节数应与备份大小一致');
    assert.equal(bytes.subarray(0, 16).toString('latin1'), 'SQLite format 3\u0000', '下载到的是完整 SQLite 文件');
  });
});

test('GET /:name/download 拒绝目录穿越与非法名称（400/404，且不泄露文件）', async () => {
  const b = createBackup(db, 'manual');
  // 数据目录里放一个「穿越目标」：任何形式的 ../ 都不应把它读出去
  const secret = path.join(dir, 'secret.db');
  fs.writeFileSync(secret, 'TOP-SECRET');
  // 备份目录下的伴生快照也不应该能单独下载（不在 FILE_RE 白名单内）
  const snapshot = path.join(dir, 'backups', b.file.replace(/\.db$/, '.knowledge.json'));

  await withApp({ isDocker: false }, async (base) => {
    const bad = [
      '..%2Fsecret.db',
      '..%2F..%2Fetc%2Fpasswd',
      encodeURIComponent('../secret.db'),
      encodeURIComponent('/etc/passwd'),
      encodeURIComponent('icpc-20260101-000000-manual.db/../../secret.db'),
      encodeURIComponent('secret.db'),
      encodeURIComponent(b.file.replace(/\.db$/, '.knowledge.json')),
    ];
    for (const name of bad) {
      const res = await fetch(`${base}/${name}/download`);
      assert.ok(res.status === 400 || res.status === 404, `${name} 应被拒绝，实际 ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('TOP-SECRET'), `${name} 泄露了数据目录文件`);
      assert.ok(!body.includes('SQLite format 3'), `${name} 泄露了数据库内容`);
    }
    // 存在的伴生快照路径也不会被当成可下载目标
    assert.ok(fs.existsSync(snapshot) || !fs.existsSync(snapshot));
  });
});

test('GET /:name/download 对不存在的合法文件名返回 404', async () => {
  await withApp({ isDocker: false }, async (base) => {
    const res = await fetch(`${base}/icpc-20990101-000000-manual.db/download`);
    assert.equal(res.status, 404);
  });
});

// ---------- 待恢复状态可见 ----------

test('GET /api/backups 无标记时 pendingRestore=null，恢复登记后带上标记内容', async () => {
  const b = createBackup(db, 'manual');
  await withApp({ isDocker: false }, async (base) => {
    const before = (await (await fetch(base)).json()) as { pendingRestore: unknown; backups: unknown[] };
    assert.equal(before.pendingRestore, null);
    assert.equal(before.backups.length, 1);

    const restore = await fetch(`${base}/${encodeURIComponent(b.file)}/restore`, { method: 'POST' });
    assert.equal(restore.status, 200);
    const restoreBody = (await restore.json()) as { needRestart?: boolean; docker?: boolean; canRestart?: boolean };
    assert.equal(restoreBody.needRestart, true);
    assert.equal(restoreBody.docker, false, '桌面版/开发模式不应自报 Docker');

    const after = (await (await fetch(base)).json()) as {
      pendingRestore: { file: string; requestedAt: string } | null;
    };
    assert.equal(after.pendingRestore?.file, b.file);
    assert.ok(after.pendingRestore?.requestedAt, '应带上登记时间');
  });
});

test('GET /api/backups 标记损坏时 pendingRestore=null（不把垃圾当成待恢复目标）', async () => {
  createBackup(db, 'manual');
  fs.writeFileSync(path.join(dir, 'restore-pending.json'), '{ not json', 'utf8');
  await withApp({ isDocker: false }, async (base) => {
    const body = (await (await fetch(base)).json()) as { pendingRestore: unknown };
    assert.equal(body.pendingRestore, null);
  });
  // 文件名不在白名单内的标记同样忽略
  fs.writeFileSync(path.join(dir, 'restore-pending.json'), JSON.stringify({ file: '../escape.db' }), 'utf8');
  await withApp({ isDocker: false }, async (base) => {
    const body = (await (await fetch(base)).json()) as { pendingRestore: unknown };
    assert.equal(body.pendingRestore, null);
  });
});

test('GET /api/backups 暴露 docker 部署形态，供前端切换恢复引导文案', async () => {
  createBackup(db, 'manual');
  await withApp({ isDocker: true }, async (base) => {
    const body = (await (await fetch(base)).json()) as { docker: boolean; canRestart: boolean };
    assert.equal(body.docker, true);
    assert.equal(body.canRestart, true);
  });
});

// ---------- 重启端点：仅 Docker 暴露 ----------

test('POST /restart 在非 Docker 环境返回 403（桌面版没有自动拉起语义）', async () => {
  const b = createBackup(db, 'manual');
  requestRestore(db, b.file);
  let exited = false;
  await withApp({ isDocker: false, restartDelayMs: 0, shutdown: () => { exited = true; } }, async (base) => {
    const res = await fetch(`${base}/restart`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(exited, false, '非 Docker 环境绝不能退出进程');
  });
});

test('POST /restart 在 Docker 环境无待恢复标记时返回 400，不退出', async () => {
  let exited = false;
  await withApp({ isDocker: true, restartDelayMs: 0, shutdown: () => { exited = true; } }, async (base) => {
    const res = await fetch(`${base}/restart`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(exited, false);
  });
});

test('POST /restart 在 Docker 环境登记恢复后触发退出（由容器 restart 策略拉起）', async () => {
  const b = createBackup(db, 'manual');
  requestRestore(db, b.file);
  let shutdownCalled = false;
  await withApp(
    {
      isDocker: true,
      restartDelayMs: 0,
      shutdown: () => {
        shutdownCalled = true;
      },
    },
    async (base) => {
      const res = await fetch(`${base}/restart`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { restarting: boolean; file: string };
      assert.equal(body.restarting, true);
      assert.equal(body.file, b.file);
      // finish 事件后的 setTimeout(0) 排在下一轮事件循环：让出一拍再断言
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(shutdownCalled, true, '应请求进程退出，由容器 restart 策略拉起');
      // 标记保留：新进程启动时 applyPendingRestore 才能完成回滚
      assert.ok(fs.existsSync(path.join(dir, 'restore-pending.json')), '退出前不得清除恢复标记');
    },
  );
});

// ---------- Docker 运行时探测 ----------

test('isDockerRuntime：ICPC_DOCKER=1 或 /.dockerenv 命中即为容器；桌面版两者皆无', () => {
  assert.equal(isDockerRuntime({ ICPC_DOCKER: '1' }, () => false), true);
  assert.equal(isDockerRuntime({}, (p) => p === '/.dockerenv'), true);
  assert.equal(isDockerRuntime({}, () => false), false);
  // 只认 '1'：避免 ICPC_DOCKER=0 被当真值
  assert.equal(isDockerRuntime({ ICPC_DOCKER: '0' }, () => false), false);
  // existsSync 抛错（权限异常）不应让启动失败
  assert.equal(isDockerRuntime({}, () => { throw new Error('EACCES'); }), false);
});
