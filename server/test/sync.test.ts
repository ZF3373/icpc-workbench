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

test('second account sync coexists with the first (no clearing, full mode for new account)', async () => {
  makeFake([sub('1919A', 'e1'), sub('1919B', 'e2')]);
  await syncPlatform(db, 'codeforces', 'alice');
  const before = db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number };
  assert.equal(before.c, 2);

  makeFake([sub('2048A', 'x1'), sub('2048B', 'x2')]);
  const result = await syncPlatform(db, 'codeforces', 'bob');
  assert.equal(result.imported, 2);
  assert.equal(fakeCalls.at(-1)!.since, undefined); // 新账号从未同步 → 全量重拉
  // 多账号（v0.8）：两个账号的数据按 account 隔离共存，不再有任何清库路径
  const rows = db
    .prepare(
      `SELECT s.account, p.problem_key FROM submissions s JOIN problems p ON s.problem_id = p.id
       ORDER BY s.account, p.problem_key`,
    )
    .all() as Array<{ account: string | null; problem_key: string }>;
  assert.deepEqual(
    rows.map((r) => `${r.account}:${r.problem_key}`),
    ['alice:1919A', 'alice:1919B', 'bob:2048A', 'bob:2048B'],
  );
  const handles = db
    .prepare("SELECT handle FROM platform_accounts WHERE platform='codeforces' ORDER BY id")
    .all() as Array<{ handle: string }>;
  assert.deepEqual(handles.map((h) => h.handle), ['alice', 'bob']);
});

test('sync injects cookie/csrf from settings into adapter', async () => {
  db.prepare("INSERT INTO settings (key, value) VALUES ('cookie.codeforces', 'session=abc')").run();
  db.prepare("INSERT INTO settings (key, value) VALUES ('csrf.codeforces', 'tok123')").run();
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'u');
  assert.equal(fakeCalls[0].cookie, 'session=abc');
  assert.equal(fakeCalls[0].csrf, 'tok123');
});

test('sync failure keeps all accounts data intact', async () => {
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'alice');
  // 另一账号同步失败：不得影响任何已有数据（原子性）
  makeFake([], 'manual-required');
  const result = await syncPlatform(db, 'codeforces', 'bob');
  assert.equal(result.errors.length, 1);
  const c = db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number };
  assert.equal(c.c, 1);
  const accs = db
    .prepare("SELECT handle FROM platform_accounts WHERE platform='codeforces' ORDER BY id")
    .all() as Array<{ handle: string }>;
  // bob 同步失败（manual-required）→ 不建绑定行；alice 绑定不受影响
  assert.deepEqual(accs.map((h) => h.handle), ['alice']);
});

test('new account with zero submissions binds without touching other accounts', async () => {
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'alice');
  makeFake([]); // 新账号确实无提交（适配器正常返回空）
  const result = await syncPlatform(db, 'codeforces', 'empty');
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 0);
  const c = db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number };
  assert.equal(c.c, 1, '其他账号数据保留');
  const accs = db
    .prepare("SELECT handle FROM platform_accounts WHERE platform='codeforces' ORDER BY id")
    .all() as Array<{ handle: string }>;
  assert.deepEqual(accs.map((h) => h.handle), ['alice', 'empty']);
});

test('rebound account (fresh row, last_sync_at NULL) does full sync without clearing', async () => {
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'alice');
  // 模拟解绑后重绑：新绑定行 last_sync_at 为 NULL，但历史提交保留（account = alice）
  db.prepare("DELETE FROM platform_accounts WHERE handle = 'alice'").run();
  db.prepare(
    "INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (1, 'codeforces', 'alice', 1)",
  ).run();
  makeFake([sub('2048A', 'x1')]);
  const result = await syncPlatform(db, 'codeforces', 'alice');
  assert.equal(result.imported, 1);
  assert.equal(fakeCalls.at(-1)!.since, undefined); // 全量重拉而非沿用旧起点
  const rows = db
    .prepare(
      `SELECT p.problem_key FROM submissions s JOIN problems p ON s.problem_id = p.id
       ORDER BY p.problem_key`,
    )
    .all() as Array<{ problem_key: string }>;
  // 旧账号历史保留（account 相同去重兜底），新拉数据照常入库
  assert.deepEqual(rows.map((r) => r.problem_key), ['1919A', '2048A']);
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

// ---------- 分批同步（防封号）：截断 + 补全模式 ----------

/** 模拟触及上限后截断的适配器：回写 opts.truncated + opts.backfillReachedPage，返回给定行 */
function makeTruncatingFake(allRows: NormalizedSubmission[], cap: number) {
  let callCount = 0;
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    knownIdsFilter: true,
    async fetchUserSubmissions(handle, opts) {
      callCount += 1;
      fakeCalls.push({ handle, since: opts?.since });
      // 模拟新增上限：返回前 cap 条，并回写截断信号
      const slice = allRows.slice(0, cap);
      if (opts) {
        opts.truncated = true;
        opts.backfillReachedPage = 10;
      }
      return slice;
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
  return { getCallCount: () => callCount };
}

test('truncated sync marks result.truncated + note, sets sync_truncated=1, keeps last_sync_at', async () => {
  const rows = Array.from({ length: 3 }, (_, i) =>
    sub(`1919${String.fromCharCode(65 + i)}`, `e${i + 1}`),
  );
  const { getCallCount } = makeTruncatingFake(rows, 3);
  const result = await syncPlatform(db, 'codeforces', 'tourist');
  assert.equal(result.imported, 3);
  assert.equal(result.truncated, true);
  assert.match(result.note ?? '', /分批同步/);
  assert.equal(getCallCount(), 1);
  const acc = db.prepare(
    "SELECT sync_truncated, backfill_page FROM platform_accounts WHERE platform='codeforces'",
  ).get() as { sync_truncated: number; backfill_page: number | null };
  assert.equal(acc.sync_truncated, 1);
  assert.equal(acc.backfill_page, 10);
});

test('backfill mode: truncated state injects backfill=true + backfillFromPage, clears on completion', async () => {
  // 第一次同步：截断，留下 sync_truncated=1 + backfill_page=10
  const rows1 = Array.from({ length: 3 }, (_, i) =>
    sub(`1919${String.fromCharCode(65 + i)}`, `e${i + 1}`),
  );
  makeTruncatingFake(rows1, 3);
  await syncPlatform(db, 'codeforces', 'tourist');

  // 第二次同步：模拟补全 —— 不再截断，返回剩余新行
  let seenBackfill: boolean | undefined;
  let seenFromPage: number | undefined;
  const rows2 = [sub('2048A', 'e4')];
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    knownIdsFilter: true,
    async fetchUserSubmissions(handle, opts) {
      seenBackfill = opts?.backfill;
      seenFromPage = opts?.backfillFromPage;
      fakeCalls.push({ handle, since: opts?.since });
      return rows2; // 不置 truncated = 补全完成
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
  const result = await syncPlatform(db, 'codeforces', 'tourist');
  assert.equal(seenBackfill, true);
  assert.equal(seenFromPage, 10); // 从上次截断游标续拉
  assert.equal(result.imported, 1);
  assert.equal(result.truncated, undefined); // 补全完成，未截断
  const acc = db.prepare(
    "SELECT sync_truncated, backfill_page FROM platform_accounts WHERE platform='codeforces'",
  ).get() as { sync_truncated: number; backfill_page: number | null };
  assert.equal(acc.sync_truncated, 0); // 补全完成清零
  assert.equal(acc.backfill_page, null); // 游标清空
});

test('sync.maxSubmissions setting overrides default cap (100–1500)', async () => {
  // 设为 100（下限）：注入适配器的 maxSubmissions 应为 100
  let seenMax: number | undefined;
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(handle, opts) {
      seenMax = opts?.maxSubmissions;
      fakeCalls.push({ handle });
      return [sub('1919A', 'e1')];
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
  db.prepare("INSERT INTO settings (key, value) VALUES ('sync.maxSubmissions', '100')").run();
  await syncPlatform(db, 'codeforces', 'u');
  assert.equal(seenMax, 100);
});

test('sync.maxSubmissions out-of-range falls back to default 300', async () => {
  let seenMax: number | undefined;
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(handle, opts) {
      seenMax = opts?.maxSubmissions;
      fakeCalls.push({ handle });
      return [];
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
  // 50 低于下限 100 → 回退默认 300
  db.prepare("INSERT INTO settings (key, value) VALUES ('sync.maxSubmissions', '50')").run();
  await syncPlatform(db, 'codeforces', 'u');
  assert.equal(seenMax, 300);
});

test('sync.maxSubmissions above upper bound 1500 falls back to default 300', async () => {
  let seenMax: number | undefined;
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(handle, opts) {
      seenMax = opts?.maxSubmissions;
      fakeCalls.push({ handle });
      return [];
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
  // 5000 超过上限 1500 → 回退默认 300
  db.prepare("INSERT INTO settings (key, value) VALUES ('sync.maxSubmissions', '5000')").run();
  await syncPlatform(db, 'codeforces', 'u');
  assert.equal(seenMax, 300);
});

test('backfill state is per account: another account full sync does not resume or reset it', async () => {
  // 先建立一个截断状态
  makeTruncatingFake([sub('1919A', 'e1')], 1);
  await syncPlatform(db, 'codeforces', 'alice');
  const acc1 = db.prepare(
    "SELECT sync_truncated FROM platform_accounts WHERE platform='codeforces' AND handle='alice'",
  ).get() as { sync_truncated: number };
  assert.equal(acc1.sync_truncated, 1);

  // 另一账号首次同步：全量重拉，不注入 backfill，也不动 alice 的补全游标
  let seenBackfill: boolean | undefined;
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(handle, opts) {
      seenBackfill = opts?.backfill;
      fakeCalls.push({ handle, since: opts?.since });
      return [sub('2048A', 'x1')];
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
  await syncPlatform(db, 'codeforces', 'bob');
  assert.equal(seenBackfill, undefined); // 新账号全量，不补全
  const aliceTruncated = db.prepare(
    "SELECT sync_truncated FROM platform_accounts WHERE platform='codeforces' AND handle='alice'",
  ).get() as { sync_truncated: number };
  assert.equal(aliceTruncated.sync_truncated, 1, 'alice 的补全游标不受其他账号同步影响');
  const acc2 = db.prepare(
    "SELECT sync_truncated FROM platform_accounts WHERE platform='codeforces' AND handle='bob'",
  ).get() as { sync_truncated: number };
  assert.equal(acc2.sync_truncated, 0); // bob 全量完成，无截断
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
      assert.ok(!r.incremental, '首刷全量，不标增量');
      assert.ok(typeof r.durationMs === 'number');
    }
  } finally {
    srv.close();
  }
});

test('sync: days 窗口触及单次上限时如实上报截断（不谎报「已同步完成」）', async () => {
  // days 模式不注入 knownExternalIds，窗口内所有行都吃 maxSubmissions 预算：
  // 活跃账号窗口内 >300 条 → rowCapped → 必须如实回写 truncated，否则用户被告知
  // 「已同步最近 N 天」而窗口内更早的历史被静默丢弃。
  let call = 0;
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(_handle, opts) {
      call += 1;
      if (opts) opts.truncated = true; // 适配器触及新增上限
      return [sub('1919A', `days-${call}`)];
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
  const result = await syncPlatform(db, 'codeforces', 'tourist', { days: 30, triggeredBy: 'days' });
  assert.equal(result.truncated, true, 'days 模式截断必须体现在结果里');
  assert.match(result.note ?? '', /上限|未覆盖|再次/);
  const run = db
    .prepare("SELECT truncated FROM sync_runs WHERE mode = 'days' ORDER BY id DESC LIMIT 1")
    .get() as { truncated: number };
  assert.equal(run.truncated, 1, 'sync_runs 也要如实记录截断');
  // days 模式不注册后台续拉、不改账号状态（语义不变）
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM platform_accounts').get()!.c, 0);
});
