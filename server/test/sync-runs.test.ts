import { test, beforeEach, afterEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import express from 'express';
import type {
  NormalizedSubmission,
} from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { register } from '../src/adapters/index.ts';
import { syncPlatform, classifySyncError } from '../src/adapters/sync.ts';
import { ManualImportRequiredError, SyncError, type FetchOptions, type PlatformAdapter } from '../src/adapters/types.ts';
import { pagedFetch } from '../src/adapters/pagination.ts';
import { syncRoutes } from '../src/routes/sync.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

function sub(key: string, externalId: string, submittedAt = '2026-09-01T00:00:00.000Z'): NormalizedSubmission {
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
    submittedAt,
    externalId,
  };
}

interface FakeCapture {
  handle: string;
  since?: string;
  windowSince?: string;
  maxSubmissions?: number;
}
let fakeCalls: FakeCapture[] = [];
function makeFake(rows: NormalizedSubmission[], behavior?: (e: Error) => never) {
  fakeCalls = [];
  const fake: PlatformAdapter = {
    platform: 'codeforces',
    async fetchUserSubmissions(handle, opts) {
      fakeCalls.push({ handle, since: opts?.since, windowSince: opts?.windowSince, maxSubmissions: opts?.maxSubmissions });
      if (behavior) behavior(new Error('fake'));
      return rows;
    },
    problemUrl() {
      return 'https://codeforces.com/';
    },
  };
  register(fake);
}

// ---------- sync_runs 记录与错误分类 ----------

test('成功同步写入 sync_runs：mode/status/imported/下次推荐时间', async () => {
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'tourist');
  const row = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.equal(row.status, 'ok');
  assert.equal(row.mode, 'full'); // 首次同步账号从未成功同步 → 全量语义（多账号 v0.8 的 fullMode 判定）
  assert.equal(row.imported, 1);
  assert.equal(row.skipped, 0);
  assert.equal(row.triggered_by, 'manual');
  assert.ok(row.finished_at);
  assert.ok(row.next_suggested_sync_at, '成功后应给出下次推荐同步时间');
});

test('第二次同步 mode=incremental；days 窗口 mode=days 且不改账号状态', async () => {
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'tourist');
  makeFake([sub('1919B', 'e2')]);
  const r = await syncPlatform(db, 'codeforces', 'tourist');
  assert.equal(r.imported, 1);
  assert.equal(fakeCalls[0].windowSince, undefined, '常规增量不得注入时间截断');
  let row = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.equal(row.mode, 'incremental');

  // days 窗口：携带 since（约 7 天前），不改 platform_accounts，不写 next_suggested_sync_at
  makeFake([sub('1919C', 'e3')]);
  const rd = await syncPlatform(db, 'codeforces', 'tourist', { days: 7, triggeredBy: 'days' });
  assert.ok(rd.note);
  assert.ok(fakeCalls[0].since, 'days 窗口应携带 since');
  assert.ok(fakeCalls[0].windowSince, 'days 窗口应注入 windowSince（分页窗口终止依据）');
  const sinceMs = Date.parse(fakeCalls[0].since!);
  assert.ok(Math.abs(Date.now() - 7 * 86_400_000 - sinceMs) < 60_000, 'since 应约等于 7 天前');
  row = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.equal(row.mode, 'days');
  assert.equal(row.status, 'ok');
  assert.equal(row.next_suggested_sync_at, null);
  const acc = db.prepare("SELECT last_sync_at FROM platform_accounts WHERE platform='codeforces'").get() as { last_sync_at: string };
  assert.ok(acc.last_sync_at, '账号状态在 days 模式下保持不变');
});

test('失败同步写入 status=failed 与可解释 error_code', async () => {
  makeFake([], () => {
    throw new Error('Codeforces API HTTP 429');
  });
  const r = await syncPlatform(db, 'codeforces', 'tourist');
  assert.ok(r.errors.length > 0);
  let row = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.equal(row.status, 'failed');
  assert.equal(row.error_code, 'rate_limited');

  // 洛谷风格 403 → auth_expired
  makeFake([], () => {
    throw new Error('洛谷 API HTTP 403（Cookie 可能已过期或触发风控）');
  });
  await syncPlatform(db, 'codeforces', 'tourist');
  row = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.equal(row.error_code, 'auth_expired');

  // 无公开 API → manual_required（引导而非网络故障）
  makeFake([], () => {
    throw new ManualImportRequiredError('codeforces', '需要手动导入');
  });
  await syncPlatform(db, 'codeforces', 'tourist');
  row = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.equal(row.error_code, 'manual_required');

  // 页面结构变化 → schema_changed
  makeFake([], () => {
    throw new Error('牛客首页解析到 0 行（页面结构变化）');
  });
  await syncPlatform(db, 'codeforces', 'tourist');
  row = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
  assert.equal(row.error_code, 'schema_changed');
});

test('classifySyncError 覆盖显式 SyncError 与网络层错误', () => {
  assert.equal(classifySyncError(new SyncError('rate_limited', 'x')), 'rate_limited');
  assert.equal(classifySyncError(new Error('fetch failed')), 'network');
  assert.equal(classifySyncError(new Error('某个奇怪错误')), 'unknown');
});

// ---------- pagedFetch 的 since 窗口早停与限速等待记录 ----------

test('pagedFetch：降序分页遇到早于 since 的行即终止且不计截断', async () => {
  const opts: FetchOptions = {};
  const rows = [
    mkRow('1', '2026-09-10T00:00:00.000Z'),
    mkRow('2', '2026-09-05T00:00:00.000Z'), // 早于 since=09-08 → 终止
    mkRow('3', '2026-08-01T00:00:00.000Z'),
  ];
  let pages = 0;
  const out = await pagedFetch<typeof rows[number]>({
    since: '2026-09-08T00:00:00.000Z',
    pageSize: 10,
    perSyncMax: 5,
    opts,
    fetchPage: async () => {
      pages += 1;
      return rows;
    },
    externalIdOf: (r) => r.externalId,
    normalize: (r) => r,
  });
  assert.equal(pages, 1, '第一页即触达窗口起点，不再翻页');
  assert.equal(out.length, 1, '只保留窗口内的提交');
  assert.equal(opts.truncated, undefined, '窗口终止不是截断');
});

test('pagedFetch：页间 sleep 计入 waitedMs', async () => {
  const opts: FetchOptions = {};
  await pagedFetch<NormalizedSubmission>({
    pageSize: 2,
    perSyncMax: 3,
    pageDelayMs: 5,
    opts,
    fetchPage: async () => [mkRow('1', '2026-09-01T00:00:00.000Z'), mkRow('2', '2026-09-01T00:00:00.000Z')],
    externalIdOf: (r) => r.externalId,
    normalize: (r) => r,
  });
  assert.ok((opts.waitedMs ?? 0) >= 5, `页间限速应计入 waitedMs，实际 ${opts.waitedMs}`);
});

function mkRow(externalId: string, submittedAt: string): NormalizedSubmission {
  return { ...sub('X', externalId), submittedAt };
}

// ---------- 同步中心路由 ----------

test('GET /api/sync/runs、/status、/diagnostics', async () => {
  // 造两条历史：一次成功一次失败
  makeFake([sub('1919A', 'e1')]);
  await syncPlatform(db, 'codeforces', 'tourist');
  makeFake([], () => {
    throw new Error('洛谷 API HTTP 403（Cookie 可能已过期或触发风控）');
  });
  await syncPlatform(db, 'codeforces', 'tourist');

  const app = express();
  app.use('/api/sync', syncRoutes(db));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/sync`;
  try {
    const runs = (await (await fetch(`${base}/runs`)).json()) as Array<Record<string, unknown>>;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, 'failed'); // 新→旧
    assert.equal(runs[0].errorCode, 'auth_expired');

    const status = (await (await fetch(`${base}/status`)).json()) as {
      statuses: Array<{ platform: string; status: string; latestRun: { errorCode: string } | null }>;
    };
    assert.equal(status.statuses.length, 1);
    assert.equal(status.statuses[0].status, 'auth_expired');

    const diag = await (await fetch(`${base}/diagnostics`)).text();
    assert.match(diag, /同步诊断报告/);
    assert.match(diag, /auth_expired/);
    assert.doesNotMatch(diag, /cookie\./i, '诊断报告不得包含 Cookie 原文');
  } finally {
    srv.close();
  }
});
