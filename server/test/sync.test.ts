import { test, beforeEach, afterEach } from 'node:test';
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
