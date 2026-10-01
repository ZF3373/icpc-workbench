/**
 * GET /api/sync/progress 路由测试：进行中的同步进度与一键同步整批进度。
 *
 * 用「卡在适配器里的假适配器」制造真实的长同步窗口，断言：
 * - 同步期间能读到 job（模式/阶段/已用时/站点请求数/心跳），结束后立即为空；
 * - /api/sync/all 期间给出 platforms / current / completed（含失败原因），结束后批次清空。
 */
import { listenForTest } from './test-listen.ts';
import { test, beforeEach, afterEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import express from 'express';
import type { SyncProgressSnapshot } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { register } from '../src/adapters/index.ts';
import { syncPlatform } from '../src/adapters/sync.ts';
import { syncRoutes } from '../src/routes/sync.ts';
import type { PlatformAdapter } from '../src/adapters/types.ts';
import {
  __resetSyncProgressForTest,
  configureSyncProgress,
} from '../src/adapters/syncProgress.ts';

let db: Db;
/** 站点请求计数（模拟节流层累计），供 configureSyncProgress 注入 */
let hostRequests: Map<string, { requests: number; lastRequestAt: number }>;

beforeEach(() => {
  db = createDb(':memory:');
  hostRequests = new Map();
  __resetSyncProgressForTest();
  configureSyncProgress({
    statsOf: (host) => hostRequests.get(host) ?? { requests: 0, lastRequestAt: 0 },
  });
});
afterEach(() => {
  db.close();
  __resetSyncProgressForTest();
});

/** 模拟一次真实上行请求：节流层计数 +1 */
function outbound(host: string): void {
  const cur = hostRequests.get(host) ?? { requests: 0, lastRequestAt: 0 };
  hostRequests.set(host, { requests: cur.requests + 1, lastRequestAt: Date.now() });
}

function bindAccount(platform: string, handle: string): void {
  db.prepare(
    "INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled) VALUES (1, ?, ?, '2026-09-01T00:00:00.000Z', 1)",
  ).run(platform, handle);
}

/**
 * 卡在闸门上的假适配器：每次同步先发一次上行请求，然后等放行（可选放行后抛错模拟失败）。
 * `release()` 可在适配器尚未到达闸门时先记一次「预放行」，避免测试与适配器进度的竞态。
 */
function makeGatedFake(
  platform: string,
  host: string,
  opts: { failAfterGate?: boolean } = {},
): { release: () => void; entered: () => number } {
  const gates: Array<() => void> = [];
  let preReleased = 0;
  let entered = 0;
  const adapter: PlatformAdapter = {
    platform: platform as PlatformAdapter['platform'],
    async fetchUserSubmissions() {
      entered += 1;
      outbound(host);
      if (preReleased > 0) {
        preReleased -= 1;
      } else {
        await new Promise<void>((resolve) => gates.push(resolve));
      }
      if (opts.failAfterGate) throw new Error(`${host} 假失败：HTTP 403`);
      return [];
    },
    problemUrl: () => `https://${host}/`,
  };
  register(adapter);
  return {
    release: () => {
      const next = gates.shift();
      if (next) next();
      else preReleased += 1;
    },
    entered: () => entered,
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/sync`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

const readProgress = async (base: string): Promise<SyncProgressSnapshot> =>
  (await (await fetch(`${base}/progress`)).json()) as SyncProgressSnapshot;

test('GET /api/sync/progress: 无同步时为空快照', async () => {
  await withServer(async (base) => {
    assert.deepEqual(await readProgress(base), { jobs: [], batch: null });
  });
});

test('GET /api/sync/progress: 同步期间可见（阶段/已用时/站点请求数/心跳），结束后清空', async () => {
  bindAccount('codeforces', 'tourist');
  const gate = makeGatedFake('codeforces', 'codeforces.com');
  await withServer(async (base) => {
    const pending = fetch(`${base}/codeforces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'tourist' }),
    });
    await waitFor(async () => (gate.entered() === 1 ? true : undefined), '适配器被调用');
    const mid = await waitFor(
      async () => {
        const s = await readProgress(base);
        return s.jobs.length === 1 ? s : undefined;
      },
      '进度中出现 job',
    );
    const job = mid.jobs[0]!;
    assert.equal(job.platform, 'codeforces');
    assert.equal(job.handle, 'tourist');
    assert.equal(job.mode, 'incremental');
    assert.equal(job.phase, 'fetching');
    assert.equal(job.siteRequests, 1, '假适配器已发出 1 次上行请求');
    assert.ok(job.elapsedMs >= 0);
    assert.ok(job.lastRequestAgoMs !== null, '窗口内发过请求 → 有心跳时间');

    gate.release();
    const res = await pending;
    assert.equal(res.status, 200);
    // 结束后立即清空（GET 是同步读取，无需轮询）
    assert.deepEqual(await readProgress(base), { jobs: [], batch: null });
  });
});

test('GET /api/sync/progress: POST /all 期间给出 platforms/current/completed，含失败原因', async () => {
  bindAccount('codeforces', 'a');
  bindAccount('luogu', 'b');
  const cf = makeGatedFake('codeforces', 'codeforces.com');
  const lg = makeGatedFake('luogu', 'www.luogu.com.cn', { failAfterGate: true });
  await withServer(async (base) => {
    const pending = fetch(`${base}/all`, { method: 'POST' });

    // 第 1 个平台（codeforces）进行中
    const duringFirst = await waitFor(async () => {
      const s = await readProgress(base);
      return s.batch?.current === 'codeforces' ? s : undefined;
    }, '批量进入第 1 个平台');
    assert.deepEqual(duringFirst.batch!.platforms, ['codeforces', 'luogu']);
    assert.deepEqual(duringFirst.batch!.completed, []);
    assert.equal(duringFirst.jobs[0]!.platform, 'codeforces');

    // 放行第 1 个 → 进入第 2 个（luogu），completed 记录第 1 个
    cf.release();
    await waitFor(async () => (lg.entered() === 1 ? true : undefined), '第 2 个平台进入适配器');
    const duringSecond = await waitFor(async () => {
      const s = await readProgress(base);
      return s.batch?.current === 'luogu' ? s : undefined;
    }, '批量进入第 2 个平台');
    assert.deepEqual(duringSecond.batch!.completed, [
      { platform: 'codeforces', status: 'ok', imported: 0 },
    ]);
    assert.deepEqual(duringSecond.jobs.map((j) => j.platform), ['luogu']);

    // 第 2 个平台失败（抛错 → syncPlatform 归类为失败结果）
    lg.release();
    const res = await pending;
    assert.equal(res.status, 200);

    // 整批结束后批次**仍可见一小段时间**（前端据此展示「已完成 N/M」的收尾状态）
    const done = await readProgress(base);
    assert.deepEqual(done.jobs, [], '同步进程已全部结束');
    assert.equal(done.batch?.current, null);
    assert.equal(done.batch?.finishedAt !== null && done.batch?.finishedAt !== undefined, true);
    assert.equal(done.batch!.completed.length, 2);
    assert.equal(done.batch!.completed[1]!.status, 'failed');
    assert.match(done.batch!.completed[1]!.error ?? '', /HTTP 403/, '失败项带首条错误原因');
  });
});

test('sync 层：补全轮次一无所获时给出「本次仅做检查 + 请求次数」的结果说明', async () => {
  // 前置：该平台上次同步被截断（sync_truncated=1）→ 本次进入补全模式
  db.prepare(
    "INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled, sync_truncated) VALUES (1, 'codeforces', 'tourist', '2026-09-01T00:00:00.000Z', 1, 1)",
  ).run();
  register({
    platform: 'codeforces',
    knownIdsFilter: true,
    async fetchUserSubmissions(_handle, opts) {
      // 模拟适配器在补全轮次里发出的 2 次上行请求（节流层计数），且没有拉到任何新记录
      outbound('codeforces.com');
      outbound('codeforces.com');
      if (opts) opts.backfillReachedPage = 2;
      return [];
    },
    problemUrl: () => 'https://codeforces.com/',
  });

  const result = await syncPlatform(db, 'codeforces', 'tourist', { triggeredBy: 'manual' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.imported, 0);
  assert.equal(result.truncated, undefined, '补全到尽头不算截断');
  assert.match(result.note ?? '', /未发现更早的历史记录/);
  assert.match(result.note ?? '', /共发出 2 次请求/, '把这次检查的实际请求开销写进结果说明');
  const acc = db.prepare("SELECT sync_truncated FROM platform_accounts WHERE platform='codeforces'").get() as { sync_truncated: number };
  assert.equal(acc.sync_truncated, 0, '补全完成 → 清标记，下次回到 1 次请求的增量');
});

test('syncProgress 与同步入口接线：失败的同步同样不留幽灵进度', async () => {  bindAccount('codeforces', 'tourist');
  register({
    platform: 'codeforces',
    async fetchUserSubmissions() {
      throw new Error('Codeforces API HTTP 403');
    },
    problemUrl: () => 'https://codeforces.com/',
  });
  const result = await syncPlatform(db, 'codeforces', 'tourist');
  assert.equal(result.errors.length, 1);
  await withServer(async (base) => {
    assert.deepEqual(await readProgress(base), { jobs: [], batch: null });
  });
});
