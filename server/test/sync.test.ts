import { test, beforeEach, afterEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import type {
  NormalizedSubmission,
  PlatformId,
} from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { register } from '../src/adapters/index.ts';
import { syncPlatform } from '../src/adapters/sync.ts';
import { ManualImportRequiredError } from '../src/adapters/types.ts';
import type { PlatformAdapter } from '../src/adapters/types.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

function sub(key: string, externalId: string): NormalizedSubmission {
  return {
    problem: {
      platform: 'codeforces',
      problemKey: key,
      title: `T ${key}`,
      difficulty: 1500,
      url: `https://codeforces.com/contest/${key}`,
      tags: ['dp'],
    },
    verdict: 'AC',
    language: 'C++',
    submittedAt: '2024-01-01T00:00:00.000Z',
    externalId,
  };
}

let fakeCalls: Array<{ handle: string; since?: string; cookie?: string; csrf?: string }> = [];
function makeFake(rows: NormalizedSubmission[], mode: 'normal' | 'manual-required' = 'normal') {
  fakeCalls = [];
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(handle, opts) {
      fakeCalls.push({ handle, since: opts?.since, cookie: opts?.cookie, csrf: opts?.csrf });
      if (mode === 'manual-required') {
        throw new ManualImportRequiredError('codeforces', '需要手动导入');
      }
      return rows;
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
}

test('first sync imports, upserts account, records last_sync_at', async () => {
  makeFake([sub('1919A', 'e1'), sub('1919B', 'e2')]);
  const result = await syncPlatform(db, 'codeforces', 'tourist');
  assert.deepEqual(result, { platform: 'codeforces', handle: 'tourist', imported: 2, skipped: 0, errors: [] });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM submissions').get()!.c, 2);
  const acc = db
    .prepare("SELECT handle, last_sync_at FROM platform_accounts WHERE platform='codeforces'")
    .get() as { handle: string; last_sync_at: string | null };
  assert.equal(acc.handle, 'tourist');
  assert.ok(acc.last_sync_at);
  // 首次同步无 since
  assert.equal(fakeCalls[0].since, undefined);
});

test('second sync passes since and dedupes identical submissions', async () => {
  makeFake([sub('1919A', 'e1'), sub('1919B', 'e2')]);
  await syncPlatform(db, 'codeforces', 'tourist');
  const firstSyncAt = (db.prepare("SELECT last_sync_at FROM platform_accounts WHERE platform='codeforces'").get() as { last_sync_at: string }).last_sync_at;
  makeFake([sub('1919A', 'e1'), sub('1919C', 'e3')]);
  const result = await syncPlatform(db, 'codeforces', 'tourist');
  assert.equal(result.imported, 1); // 仅 e3 新增
  assert.equal(result.skipped, 1);  // e1 去重
  assert.ok(fakeCalls[0].since, '第二次同步应携带 since');
  assert.ok(fakeCalls[0].since! >= firstSyncAt);
});

test('manual-required error becomes guidance in errors, no account created', async () => {
  makeFake([], 'manual-required');
  const result = await syncPlatform(db, 'codeforces', 'u');
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /手动导入/);
  const acc = db.prepare("SELECT COUNT(*) AS c FROM platform_accounts WHERE platform='codeforces'").get() as { c: number };
  assert.equal(acc.c, 0);
});

test('switching handle clears old submissions and does full sync', async () => {
  makeFake([sub('1919A', 'e1'), sub('1919B', 'e2')]);
  await syncPlatform(db, 'codeforces', 'alice');
  const before = db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number };
  assert.equal(before.c, 2);

  makeFake([sub('2048A', 'x1'), sub('2048B', 'x2')]);
  const result = await syncPlatform(db, 'codeforces', 'bob');
  assert.equal(result.imported, 2);
  assert.equal(fakeCalls[0].since, undefined); // 换账号全量重拉
  // 旧账号数据已清空，只剩新账号的 2 条
  const rows = db
    .prepare(
      `SELECT p.problem_key FROM submissions s JOIN problems p ON s.problem_id = p.id
       ORDER BY p.problem_key`,
    )
    .all() as Array<{ problem_key: string }>;
  assert.deepEqual(rows.map((r) => r.problem_key), ['2048A', '2048B']);
  const acc = db.prepare("SELECT handle FROM platform_accounts WHERE platform='codeforces'").get() as { handle: string };
  assert.equal(acc.handle, 'bob');
});

test('sync injects cookie/csrf from settings into adapter', async () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('cookie.codeforces', 'session=abc')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('csrf.codeforces', 'tok123')").run();
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'u');
  assert.equal(fakeCalls[0].cookie, 'session=abc');
  assert.equal(fakeCalls[0].csrf, 'tok123');
});

test('sync failure keeps old data when handle changed', async () => {
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'alice');
  // 换账号但拉取失败：不得清空旧数据（原子性）
  makeFake([], 'manual-required');
  const result = await syncPlatform(db, 'codeforces', 'bob');
  assert.equal(result.errors.length, 1);
  const c = db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number };
  assert.equal(c.c, 1);
});

test('switching to account with zero submissions clears old data', async () => {
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'alice');
  makeFake([]); // 新账号确实无提交（适配器正常返回空）
  const result = await syncPlatform(db, 'codeforces', 'empty');
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 0);
  const c = db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number };
  assert.equal(c.c, 0); // 旧账号数据被清空
});

test('rebound account (settings handle change, last_sync_at NULL) does full sync + clears old data', async () => {
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'alice');
  // 模拟设置页改绑：handle 已更新但 last_sync_at 被重置为 NULL
  db.prepare("UPDATE platform_accounts SET handle = 'alice2', last_sync_at = NULL WHERE platform = 'codeforces'").run();
  makeFake([sub('2048A', 'x1')]);
  const result = await syncPlatform(db, 'codeforces', 'alice2');
  assert.equal(result.imported, 1);
  assert.equal(fakeCalls[0].since, undefined); // 全量重拉而非沿用旧起点
  const rows = db
    .prepare(
      `SELECT p.problem_key FROM submissions s JOIN problems p ON s.problem_id = p.id
       ORDER BY p.problem_key`,
    )
    .all() as Array<{ problem_key: string }>;
  assert.deepEqual(rows.map((r) => r.problem_key), ['2048A']); // 旧账号数据被清空
});

test('disabled platform is skipped via settings', async () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('adapter.codeforces.enabled', 'false')").run();
  makeFake([sub('1919A', 'e1')]);
  const result = await syncPlatform(db, 'codeforces', 'u');
  assert.equal(result.imported, 0);
  assert.match(result.errors[0], /已禁用/);
});

test('unregistered platform returns error', async () => {
  const result = await syncPlatform(db, 'unknown' as PlatformId, 'u');
  assert.match(result.errors[0], /未注册适配器/);
  assert.equal(result.imported, 0);
});

test('knownIdsFilter adapter receives known external ids and marks incremental', async () => {
  let seenIds: Set<string> | undefined;
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    knownIdsFilter: true,
    async fetchUserSubmissions(handle, opts) {
      seenIds = opts?.knownExternalIds;
      fakeCalls.push({ handle, since: opts?.since });
      return [sub('1919D', 'e4')];
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
  // 首次同步：库中无该平台提交 → 传入空集合（无害），不算增量
  await syncPlatform(db, 'codeforces', 'tourist');
  assert.ok(seenIds instanceof Set);
  assert.equal(seenIds.size, 0);
  // 第二次同步：注入已知 id，标记增量
  const result = await syncPlatform(db, 'codeforces', 'tourist');
  const seen = seenIds as Set<string> | undefined; // 赋值发生在闭包内，TS 收窄需要显式断言
  assert.ok(seen instanceof Set);
  assert.ok(seen.has('e4')); // 首刷入库的提交号出现在已知集合中
  assert.equal(result.incremental, true);
});

test('POST /api/sync/all syncs every bound account and reports incremental', async () => {
  const { default: express } = await import('express');
  const { syncRoutes } = await import('../src/routes/sync.ts');
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRoutes(db));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/sync`;

  try {
    // 未绑定账号 → results 为空数组
    const empty = (await (await fetch(`${base}/all`, { method: 'POST' })).json()) as { results: unknown[] };
    assert.equal(empty.results.length, 0);

    // 注册 atcoder fake（codeforces fake 已由上一个用例注册）
    register({
      platform: 'atcoder',
      async fetchUserSubmissions() {
        return [
          {
            problem: {
              platform: 'atcoder',
              problemKey: 'abc321_a',
              title: 'T abc321_a',
              difficulty: 300,
              url: 'https://atcoder.jp/contests/abc321/tasks/abc321_a',
              tags: [],
            },
            verdict: 'AC',
            language: 'C++',
            submittedAt: '2024-01-01T00:00:00.000Z',
            externalId: 'at1',
          },
        ];
      },
      problemUrl() {
        return 'https://atcoder.jp/';
      },
    });
    // 绑定两个账号
    db.prepare(
      "INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (1, 'codeforces', 'tourist', 1)",
    ).run();
    db.prepare(
      "INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (1, 'atcoder', 'tourist_ap', 1)",
    ).run();
    const res = await fetch(`${base}/all`, { method: 'POST' });
    const body = (await res.json()) as {
      results: Array<{ platform: string; imported: number; incremental?: boolean; durationMs?: number }>;
    };
    assert.equal(body.results.length, 2);
    assert.deepEqual(body.results.map((r) => r.platform).sort(), ['atcoder', 'codeforces']);
    for (const r of body.results) {
      assert.equal(r.imported, 1);
      assert.equal(r.incremental, undefined); // 首刷全量，不标增量
      assert.ok(typeof r.durationMs === 'number');
    }
  } finally {
    srv.close();
  }
});
