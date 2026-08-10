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

let fakeCalls: Array<{ handle: string; since?: string }> = [];
function makeFake(rows: NormalizedSubmission[], mode: 'normal' | 'manual-required' = 'normal') {
  fakeCalls = [];
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(handle, opts) {
      fakeCalls.push({ handle, since: opts?.since });
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
