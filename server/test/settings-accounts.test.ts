import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, type Db } from '../src/db/index.ts';
import { settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DEFAULT_USER_ID } from '../src/constants.ts';

let db: Db;

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/settings`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

test('binding a new handle on a bound platform adds a second account, existing data untouched', async () => {
  await withServer(async (db, base) => {
    // 模拟旧账号已同步成功过（多账号 v0.8：新绑定不再替换/清空旧账号）
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled)
       VALUES (?, 'codeforces', 'alice', ?, 1)`,
    ).run(DEFAULT_USER_ID, '2026-01-01T00:00:00.000Z');

    const res = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'bob' }),
    });
    assert.equal(res.status, 200);

    const rows = db
      .prepare('SELECT handle, last_sync_at, enabled FROM platform_accounts WHERE platform = ? ORDER BY id')
      .all('codeforces') as Array<{ handle: string; last_sync_at: string | null; enabled: number }>;
    assert.equal(rows.length, 2, '同平台两个账号并存');
    assert.deepEqual(rows.map((r) => r.handle), ['alice', 'bob']);
    assert.equal(rows[0]!.last_sync_at, '2026-01-01T00:00:00.000Z', '旧账号增量起点不动');
    assert.equal(rows[1]!.last_sync_at, null, '新账号从未同步 → 下次全量');
    assert.equal(rows[1]!.enabled, 1);
  });
});

test('rebinding the same handle keeps last_sync_at (re-enables only)', async () => {
  await withServer(async (db, base) => {
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled)
       VALUES (?, 'codeforces', 'alice', ?, 0)`,
    ).run(DEFAULT_USER_ID, '2026-01-01T00:00:00.000Z');

    const res = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'alice' }),
    });
    assert.equal(res.status, 200);

    const acc = db
      .prepare("SELECT last_sync_at, enabled FROM platform_accounts WHERE platform = 'codeforces'")
      .get() as { last_sync_at: string | null; enabled: number };
    assert.equal(acc.last_sync_at, '2026-01-01T00:00:00.000Z'); // 增量起点保留
    assert.equal(acc.enabled, 1); // 重复绑定 = 重新启用
  });
});

test('first-time binding creates account with null last_sync_at', async () => {
  await withServer(async (db, base) => {
    const res = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'atcoder', handle: 'newbie' }),
    });
    assert.equal(res.status, 200);
    const acc = db
      .prepare("SELECT handle, last_sync_at FROM platform_accounts WHERE platform = 'atcoder'")
      .get() as { handle: string; last_sync_at: string | null };
    assert.equal(acc.handle, 'newbie');
    assert.equal(acc.last_sync_at, null);
  });
});

test('disable / re-enable an account', async () => {
  await withServer(async (db, base) => {
    await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'alice' }),
    });

    // 停用 → 不参与同步，但绑定行与历史都在
    const off = await fetch(`${base}/accounts/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'alice', enabled: false }),
    });
    assert.equal(off.status, 200);
    const acc = db
      .prepare("SELECT enabled FROM platform_accounts WHERE platform = 'codeforces'")
      .get() as { enabled: number };
    assert.equal(acc.enabled, 0);

    // 非法 body → 400
    const bad = await fetch(`${base}/accounts/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'alice', enabled: 'yes' }),
    });
    assert.equal(bad.status, 400);

    // 重新启用
    const on = await fetch(`${base}/accounts/enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'alice', enabled: true }),
    });
    assert.equal(on.status, 200);
  });
});

test('remove account deletes its submissions, creates a restore point, other accounts untouched', async () => {
  // 删除前要创建恢复点（VACUUM INTO 需要文件路径），用临时文件库
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-acct-'));
  const db = createDb(path.join(dir, 'icpc.db'));
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/settings`;
  try {
    await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'alice' }),
    });
    await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'bob' }),
    });
    db.prepare(
      `INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1919A', 'T 1919A')`,
    ).run();
    const insSub = db.prepare(
      `INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id)
       VALUES (?, 'codeforces', ?, (SELECT id FROM problems WHERE platform='codeforces' AND problem_key='1919A'), 'AC', '2026-01-01T00:00:00.000Z', ?)`,
    );
    insSub.run(DEFAULT_USER_ID, 'alice', 'e-alice-1');
    insSub.run(DEFAULT_USER_ID, 'alice', 'e-alice-2');
    insSub.run(DEFAULT_USER_ID, 'bob', 'e-bob-1');
    insSub.run(DEFAULT_USER_ID, '', 'manual-1'); // 手动导入（无账号来源）

    // 删除 alice：绑定行与 alice 的 2 条提交一起删除；bob 与手动导入保留
    const rm = await fetch(`${base}/accounts/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'alice' }),
    });
    assert.equal(rm.status, 200);
    const body = (await rm.json()) as { ok: boolean; deletedSubmissions: number; backupFile: string };
    assert.equal(body.ok, true);
    assert.equal(body.deletedSubmissions, 2);
    assert.ok(body.backupFile.includes('pre-account-delete'));
    assert.ok(fs.existsSync(path.join(dir, 'backups', body.backupFile)), '恢复点文件应存在');

    const handles = db
      .prepare('SELECT handle FROM platform_accounts WHERE platform = ? ORDER BY id')
      .all('codeforces') as Array<{ handle: string }>;
    assert.deepEqual(handles.map((h) => h.handle), ['bob']);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE account = 'alice'").get() as { c: number }).c,
      0,
      'alice 的提交记录已删除',
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE account = 'bob'").get() as { c: number }).c,
      1,
      'bob 的提交记录不受影响',
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM submissions WHERE account = ''").get() as { c: number }).c,
      1,
      '手动导入（无账号来源）不受影响',
    );

    // 删除不存在的账号 → 404
    const rm2 = await fetch(`${base}/accounts/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', handle: 'ghost' }),
    });
    assert.equal(rm2.status, 404);
  } finally {
    srv.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Cookie 检测接口 ----------

import { register, getAdapter } from '../src/adapters/registry.ts';
import type { PlatformAdapter } from '../src/adapters/types.ts';

function fakeLuoguAdapter(
  checkAuth: PlatformAdapter['checkAuth'],
): PlatformAdapter {
  return {
    platform: 'luogu',
    async fetchUserSubmissions() {
      return [];
    },
    problemUrl: () => 'https://www.luogu.com.cn/problem/P1001',
    ...(checkAuth ? { checkAuth } : {}),
  };
}

test('POST /cookies/check uses body cookie when provided', async () => {
  const original = getAdapter('luogu');
  register(fakeLuoguAdapter(async (opts) => ({
    ok: opts.cookie === 'fresh',
    message: opts.cookie === 'fresh' ? 'Cookie 有效' : '过期',
  })));
  await withServer(async (_db, base) => {
    const res = await fetch(`${base}/cookies/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'luogu', cookie: 'fresh' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, message: 'Cookie 有效' });
  });
  if (original) register(original);
});

test('POST /cookies/check falls back to saved cookie in settings', async () => {
  const original = getAdapter('luogu');
  let seenCookie = '';
  register(
    fakeLuoguAdapter(async (opts) => {
      seenCookie = opts.cookie;
      return { ok: true, message: 'ok' };
    }),
  );
  await withServer(async (db, base) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('cookie.luogu', 'saved-cookie')").run();
    const res = await fetch(`${base}/cookies/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'luogu' }),
    });
    assert.equal(res.status, 200);
    assert.equal(seenCookie, 'saved-cookie'); // 未传 cookie 时读已保存的
  });
  if (original) register(original);
});

test('POST /cookies/check reports missing cookie and unsupported platform', async () => {
  const original = getAdapter('luogu');
  register(fakeLuoguAdapter(async () => ({ ok: true, message: 'ok' })));
  await withServer(async (_db, base) => {
    const missing = await fetch(`${base}/cookies/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'luogu' }),
    });
    const body = (await missing.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, false);
    assert.match(body.message, /尚未填写/);

    // codeforces 无 checkAuth（公开 API 平台）→ 提示不支持（不报错）
    const cf = await fetch(`${base}/cookies/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', cookie: 'x' }),
    });
    const cfBody = (await cf.json()) as { ok: boolean; message: string };
    assert.equal(cf.status, 200);
    assert.match(cfBody.message, /无需登录|不支持/);
  });
  if (original) register(original);
});

test('cookies/check passes bound account handle to adapter checkAuth', async () => {
  await withServer(async (db, base) => {
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, enabled)
       VALUES (?, 'daimayuan', '5441', 1)`,
    ).run(DEFAULT_USER_ID);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('cookie.daimayuan', 'sid=tok')",
    ).run();

    // 通过临时替换 daimayuan 适配器捕获 checkAuth 收到的参数
    const { register, getAdapter } = await import('../src/adapters/registry.ts');
    const { initAdapters } = await import('../src/adapters/index.ts');
    initAdapters(); // 本文件其他测试未初始化适配器注册表
    const seen: Array<{ cookie?: string; handle?: string }> = [];
    const real = getAdapter('daimayuan')!;
    register({
      ...real,
      checkAuth: async (opts) => {
        seen.push(opts);
        return { ok: true, message: 'captured' };
      },
    });
    try {
      const res = await fetch(`${base}/cookies/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'daimayuan' }),
      });
      const body = (await res.json()) as { ok: boolean; message: string };
      assert.equal(body.ok, true);
      assert.deepEqual(seen, [{ cookie: 'sid=tok', handle: '5441' }]);
    } finally {
      register(real); // 还原，避免污染其他测试
    }
  });
});

test('GET / returns sync.maxSubmissions default; POST /sync saves and validates', async () => {
  await withServer(async (db, base) => {
    // 默认值 300（保守）
    const get1 = (await (await fetch(`${base}/`)).json()) as { sync: { maxSubmissions: number } };
    assert.equal(get1.sync.maxSubmissions, 300);

    // 保存合法值
    const res = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxSubmissions: 800 }),
    });
    assert.equal(res.status, 200);
    // 响应带完整的 sync 设置（Task 8 起含 autoContinueRounds，未传时保持默认 3；
    // Task 9 起含 jisuankePracticeSync，键缺失 = 默认开启；拉取速度起含 requestIntervalScale/
    // requestIntervalBase，未传倍率时保持默认 1×）。只断言本用例关心的字段，避免与新增字段强耦合。
    const saved = (await res.json()) as {
      maxSubmissions: number;
      autoContinueRounds: number;
      jisuankePracticeSync: boolean;
      requestIntervalScale: number;
    };
    assert.equal(saved.maxSubmissions, 800);
    assert.equal(saved.autoContinueRounds, 3);
    assert.equal(saved.jisuankePracticeSync, true);
    assert.equal(saved.requestIntervalScale, 1);
    // 持久化到 settings 表
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sync.maxSubmissions'").get() as { value: string };
    assert.equal(row.value, '800');
    // GET 回读已保存值
    const get2 = (await (await fetch(`${base}/`)).json()) as { sync: { maxSubmissions: number } };
    assert.equal(get2.sync.maxSubmissions, 800);

    // 越界值拒绝（< 100 下限 / > 1500 上限）
    const badLow = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxSubmissions: 50 }),
    });
    assert.equal(badLow.status, 400);
    const badHigh = await fetch(`${base}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxSubmissions: 2000 }),
    });
    assert.equal(badHigh.status, 400);
  });
});

test('cookies/check injects saved browser UA (QOJ cf_clearance 绑定 UA)', async () => {
  await withServer(async (db, base) => {
    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, enabled)
       VALUES (?, 'qoj', 'hieZF123', 1)`,
    ).run(DEFAULT_USER_ID);
    db.prepare("INSERT INTO settings (key, value) VALUES ('cookie.qoj', 'UOJSESSID=tok; cf_clearance=cf')").run();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    db.prepare("INSERT INTO settings (key, value) VALUES ('ua.qoj', ?)").run(ua);

    const { register, getAdapter } = await import('../src/adapters/registry.ts');
    const { initAdapters } = await import('../src/adapters/index.ts');
    initAdapters();
    const seen: Array<{ cookie?: string; handle?: string; ua?: string }> = [];
    const real = getAdapter('qoj')!;
    register({
      ...real,
      checkAuth: async (opts) => {
        seen.push(opts);
        return { ok: true, message: 'captured' };
      },
    });
    try {
      const res = await fetch(`${base}/cookies/check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'qoj' }),
      });
      const body = (await res.json()) as { ok: boolean };
      assert.equal(body.ok, true);
      // 检测与同步必须用同一个 UA 来源，否则 cf_clearance 校验必然失败
      assert.deepEqual(seen, [{ cookie: 'UOJSESSID=tok; cf_clearance=cf', handle: 'hieZF123', ua }]);
    } finally {
      register(real);
    }
  });
});

// ---------- Cookie 字段级合并保存 ----------

/** 提交单字段合并请求，返回响应体 */
async function saveFields(
  base: string,
  platform: string,
  cookieFields: Record<string, string>,
): Promise<{ status: number; body: { ok?: boolean; fields?: string[]; hasUa?: boolean; configured?: boolean; error?: string } }> {
  const res = await fetch(`${base}/cookies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform, cookieFields }),
  });
  return { status: res.status, body: (await res.json()) as { ok?: boolean; fields?: string[]; hasUa?: boolean; configured?: boolean; error?: string } };
}

test('cookieFields: QOJ 两个 Cookie 按名分框（UOJSESSID / cf_clearance）+ 浏览器 UA 单字段增量保存', async () => {
  await withServer(async (db, base) => {
    // ① 只把整段 Cookie 粘进 cf_clearance 框：后端按名字分派，UOJSESSID 也自动落位
    const fullCookie = 'cf_clearance=cf-tok; UOJSESSID=sess-tok';
    const r1 = await saveFields(base, 'qoj', { clearance: fullCookie });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.fields, ['UOJSESSID', 'cf_clearance']);
    assert.equal(r1.body.hasUa, false);
    assert.equal(
      (db.prepare("SELECT value FROM settings WHERE key='cookie.qoj'").get() as { value: string }).value,
      'UOJSESSID=sess-tok; cf_clearance=cf-tok',
      '整段粘贴应被分派成两个按名 Cookie 项',
    );

    // ② 再补 UA：两项 Cookie 必须原样保留（这是「只改一个字段」的核心回归）
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
    const r2 = await saveFields(base, 'qoj', { ua });
    assert.equal(r2.body.hasUa, true);
    assert.equal(
      (db.prepare("SELECT value FROM settings WHERE key='cookie.qoj'").get() as { value: string }).value,
      'UOJSESSID=sess-tok; cf_clearance=cf-tok',
      'UA 不得写进 Cookie 头，且 Cookie 头不得被改动',
    );
    assert.equal((db.prepare("SELECT value FROM settings WHERE key='ua.qoj'").get() as { value: string }).value, ua);

    // ③ 字段总数 = 3（两个 Cookie 按名分框 + 一个 configOnly 的 UA）
    const { cookieFieldsOf } = await import('../../shared/src/index.ts');
    assert.deepEqual(cookieFieldsOf('qoj').map((f: { key: string }) => f.key), ['uojsessid', 'clearance', 'ua']);

    // ④ 只提交旧键名 `session`（历史残留，已改名 uojsessid）应被拒绝，避免前端残留旧字段名时静默写坏数据
    const bad = await saveFields(base, 'qoj', { session: 'sess-only' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error ?? '', /未知 Cookie 字段/);
  });
});

test('cookieFields: 只补填一项时另一项保留（不再被空值覆盖）', async () => {
  await withServer(async (db, base) => {
    // 用洛谷双字段（_uid + __client_id）做这条回归：QOJ 的两项分别由独立输入框提交，
    // 逐项合并语义与洛谷一致，这里用洛谷即可覆盖同一段服务端逻辑。
    await saveFields(base, 'luogu', { clientId: 'abc-123' });
    assert.equal(
      (db.prepare("SELECT value FROM settings WHERE key='cookie.luogu'").get() as { value: string }).value,
      '__client_id=abc-123',
    );
    // 关键回归：只补填 _uid，已保存的 __client_id 必须保留
    const r2 = await saveFields(base, 'luogu', { uid: '1892580' });
    assert.equal(r2.status, 200);
    const saved = (db.prepare("SELECT value FROM settings WHERE key='cookie.luogu'").get() as { value: string }).value;
    assert.equal(saved, '_uid=1892580; __client_id=abc-123');
    assert.deepEqual(r2.body.fields, ['_uid', '__client_id']);

    // 覆盖其中一项：另一项仍保留
    const r3 = await saveFields(base, 'luogu', { clientId: 'xyz-999' });
    const saved3 = (db.prepare("SELECT value FROM settings WHERE key='cookie.luogu'").get() as { value: string }).value;
    assert.equal(saved3, '_uid=1892580; __client_id=xyz-999');
    assert.equal(r3.body.ok, true);
  });
});

test('cookieFields: configOnly 字段（浏览器 UA）单独存储且不出现在 Cookie 头', async () => {
  await withServer(async (db, base) => {
    await saveFields(base, 'qoj', { clearance: 'cf_clearance=cf-tok; UOJSESSID=sess-token' });
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const r = await saveFields(base, 'qoj', { ua });
    assert.equal(r.status, 200);
    assert.equal(r.body.hasUa, true);

    const cookie = (db.prepare("SELECT value FROM settings WHERE key='cookie.qoj'").get() as { value: string }).value;
    assert.equal(cookie, 'UOJSESSID=sess-token; cf_clearance=cf-tok', 'UA 不得写进 Cookie 头');
    const stored = (db.prepare("SELECT value FROM settings WHERE key='ua.qoj'").get() as { value: string }).value;
    assert.equal(stored, ua);

    // GET 必须告知前端 UA 已配置（否则表单会误判未配置）
    const get1 = (await (await fetch(`${base}/`)).json()) as { cookies: Record<string, { configured: boolean; hasUa?: boolean }> };
    assert.equal(get1.cookies.qoj?.configured, true);
    assert.equal(get1.cookies.qoj?.hasUa, true);

    // 显式清空 UA：只删 UA，Cookie 保留
    const r2 = await saveFields(base, 'qoj', { ua: '' });
    assert.equal(r2.body.hasUa, false);
    const afterClear = db.prepare("SELECT value FROM settings WHERE key='ua.qoj'").get();
    assert.equal(afterClear, undefined);
    assert.equal(
      (db.prepare("SELECT value FROM settings WHERE key='cookie.qoj'").get() as { value: string }).value,
      'UOJSESSID=sess-token; cf_clearance=cf-tok',
    );
  });
});

test('cookieFields: 显式空串清空单个 Cookie 项；未知字段被拒绝', async () => {
  await withServer(async (db, base) => {
    await saveFields(base, 'luogu', { uid: '1892580' });

    // 空串 = 显式清空该项（其余保留）
    const r = await saveFields(base, 'luogu', { clientId: '' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.fields, ['_uid'], '显式空串只清空该项，_uid 保留');

    // 全部清空 → 记录被删除
    const r2 = await saveFields(base, 'luogu', { uid: '' });
    assert.equal(r2.body.configured, false);
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='cookie.luogu'").get(), undefined);

    // 未知字段名 → 400（两端字段表必须一致，防止前端改名后静默写错）
    const bad = await saveFields(base, 'qoj', { nope: 'x' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error ?? '', /未知 Cookie 字段/);

    // 旧键名 `session`（UOJSESSID 已改名为 uojsessid）→ 400（防止前端残留旧字段名写坏数据）
    const legacy = await saveFields(base, 'qoj', { session: 'sess-only' });
    assert.equal(legacy.status, 400);
    assert.match(legacy.body.error ?? '', /未知 Cookie 字段/);

    // 未定义字段表的平台 → 400 并提示改用整条提交
    const noForm = await saveFields(base, 'codeforces', { session: 'x' });
    assert.equal(noForm.status, 400);
    assert.match(noForm.body.error ?? '', /未定义字段化 Cookie 表单/);
  });
});

test('cookieFields: 洛谷/代码源字段同样支持单字段增量保存', async () => {
  await withServer(async (db, base) => {
    // 洛谷两项：先只填 clientId，再补 uid
    await saveFields(base, 'luogu', { clientId: 'abc-123' });
    const mid = (db.prepare("SELECT value FROM settings WHERE key='cookie.luogu'").get() as { value: string }).value;
    assert.equal(mid, '__client_id=abc-123');
    await saveFields(base, 'luogu', { uid: '1892580' });
    const final = (db.prepare("SELECT value FROM settings WHERE key='cookie.luogu'").get() as { value: string }).value;
    assert.equal(final, '_uid=1892580; __client_id=abc-123');

    // 代码源 raw 字段：裸值与「Cookie: name=value」整段粘贴都能处理，
    // 且前缀剥离必须发生在前端拼装之后（否则会得到 sid=Cookie: sid=x）
    await saveFields(base, 'daimayuan', { sid: 'Cookie: sid=raw-sid-value' });
    assert.equal(
      (db.prepare("SELECT value FROM settings WHERE key='cookie.daimayuan'").get() as { value: string }).value,
      'sid=raw-sid-value',
    );
    // 只传裸值（前端已剥前缀的正常路径）
    await saveFields(base, 'daimayuan', { sid: 'raw-sid-2' });
    assert.equal(
      (db.prepare("SELECT value FROM settings WHERE key='cookie.daimayuan'").get() as { value: string }).value,
      'sid=raw-sid-2',
    );
  });
});
