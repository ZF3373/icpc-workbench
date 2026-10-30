/**
 * 同步进度注册表（src/adapters/syncProgress.ts）单元测试。
 *
 * 关键不变量：
 * 1. 同步期间能被看到（平台/阶段/已用时/站点请求数/最后请求距今），结束后必定清空；
 * 2. 抛错路径同样清空（否则前端会永久显示一个幽灵进度）；
 * 3. 请求数是「本窗口内的增量」，不是站点累计值；
 * 4. 批量（一键同步）给出 platforms/current/completed，且失败项带错误原因；
 * 5. 不同平台并发互不干扰。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __resetSyncProgressForTest,
  beginBatch,
  beginSync,
  completeBatchItem,
  configureSyncProgress,
  endBatch,
  endSync,
  jobSiteRequests,
  setSyncPhase,
  snapshot,
} from '../src/adapters/syncProgress.ts';

/** 假节流统计：按域名累加，供注入 */
function fakeStats() {
  const byHost = new Map<string, { requests: number; lastRequestAt: number }>();
  return {
    bump(host: string, at: number): void {
      const cur = byHost.get(host) ?? { requests: 0, lastRequestAt: 0 };
      byHost.set(host, { requests: cur.requests + 1, lastRequestAt: at });
    },
    statsOf: (host: string) => byHost.get(host) ?? { requests: 0, lastRequestAt: 0 },
  };
}

let clockMs = Date.parse('2026-09-15T00:00:00.000Z');
function setup(): ReturnType<typeof fakeStats> {
  __resetSyncProgressForTest();
  clockMs = Date.parse('2026-09-15T00:00:00.000Z');
  const stats = fakeStats();
  configureSyncProgress({ now: () => clockMs, statsOf: stats.statsOf });
  return stats;
}

test('syncProgress: 牛客合计 ACM 与在线编程接口请求数', () => {
  const stats = setup();
  stats.bump('gw-c.nowcoder.com', clockMs);
  beginSync({ platform: 'nowcoder', handle: '123', mode: 'incremental' });
  stats.bump('ac.nowcoder.com', clockMs);
  clockMs += 1000;
  stats.bump('gw-c.nowcoder.com', clockMs);
  clockMs += 500;
  assert.equal(snapshot().jobs[0].siteRequests, 2);
  assert.equal(snapshot().jobs[0].lastRequestAgoMs, 500);
  assert.equal(jobSiteRequests('nowcoder'), 2);
  endSync('nowcoder');
});

test('syncProgress: 同步期间可读，请求数按窗口增量统计，结束后清空', () => {
  const stats = setup();
  // 窗口前该站点已有 7 次请求（例如上一轮同步/回填留下的累计值）
  for (let i = 0; i < 7; i += 1) stats.bump('codeforces.com', clockMs);

  beginSync({ platform: 'codeforces', handle: 'tourist', mode: 'incremental', maxSubmissions: 300 });
  clockMs += 1_500;
  assert.deepEqual(snapshot().jobs.map((j) => j.platform), ['codeforces']);
  let job = snapshot().jobs[0]!;
  assert.equal(job.handle, 'tourist');
  assert.equal(job.phase, 'fetching');
  assert.equal(job.mode, 'incremental');
  assert.equal(job.maxSubmissions, 300);
  assert.equal(job.elapsedMs, 1_500);
  assert.equal(job.siteRequests, 0, '窗口内还没发请求');
  assert.equal(job.lastRequestAgoMs, null, '从未发出请求 → null（等待上游）');

  // 窗口内发出 3 次请求，最后一次在 +3s
  for (let i = 0; i < 3; i += 1) stats.bump('codeforces.com', clockMs);
  clockMs += 3_000;
  stats.bump('codeforces.com', clockMs);
  clockMs += 2_000;

  job = snapshot().jobs[0]!;
  assert.equal(job.siteRequests, 4, '只算窗口内的增量（7 次历史不计）');
  assert.equal(job.lastRequestAgoMs, 2_000);

  setSyncPhase('codeforces', 'saving');
  assert.equal(snapshot().jobs[0]!.phase, 'saving');

  endSync('codeforces');
  assert.deepEqual(snapshot(), { jobs: [], batch: null });
});

test('syncProgress: 失败路径（异常后 endSync）不留幽灵进度', () => {
  const stats = setup();
  beginSync({ platform: 'luogu', handle: 'u', mode: 'backfill' });
  assert.equal(snapshot().jobs.length, 1);
  // 模拟 finally 清理：无论成功或抛错都必须走这一步
  try {
    throw new Error('上游 403');
  } catch {
    endSync('luogu');
  }
  assert.deepEqual(snapshot().jobs, []);
  assert.equal(stats.statsOf('www.luogu.com.cn').requests, 0);
});

test('syncProgress: days 窗口模式带上天数（前端文案「仅最近 N 天」）', () => {
  setup();
  beginSync({ platform: 'nowcoder', handle: 'u', mode: 'days', days: 7 });
  const job = snapshot().jobs[0]!;
  assert.equal(job.mode, 'days');
  assert.equal(job.days, 7);
});

test('syncProgress: 不同平台并发互不干扰，各自统计自己的站点', () => {
  const stats = setup();
  beginSync({ platform: 'codeforces', handle: 'a', mode: 'incremental' });
  beginSync({ platform: 'luogu', handle: 'b', mode: 'incremental' });
  stats.bump('www.luogu.com.cn', clockMs);
  stats.bump('www.luogu.com.cn', clockMs);
  stats.bump('codeforces.com', clockMs);
  clockMs += 1_000;

  const jobs = snapshot().jobs;
  assert.deepEqual(jobs.map((j) => j.platform).sort(), ['codeforces', 'luogu']);
  assert.equal(jobs.find((j) => j.platform === 'codeforces')!.siteRequests, 1);
  assert.equal(jobs.find((j) => j.platform === 'luogu')!.siteRequests, 2);

  endSync('codeforces');
  assert.deepEqual(snapshot().jobs.map((j) => j.platform), ['luogu']);
});

test('syncProgress: 批量（一键同步）给出 platforms/current/completed，失败项带原因', () => {
  setup();
  beginBatch(['codeforces', 'luogu', 'nowcoder']);
  let batch = snapshot().batch!;
  assert.deepEqual(batch.platforms, ['codeforces', 'luogu', 'nowcoder']);
  assert.equal(batch.current, null, '尚未开始第一个平台前 current 为 null');
  assert.deepEqual(batch.completed, []);
  assert.equal(batch.elapsedMs, 0);
  assert.equal(batch.finishedAt, null, '进行中 → finishedAt 为 null');

  // 第 1 个平台开始
  beginSync({ platform: 'codeforces', handle: 'a', mode: 'incremental' });
  batch = snapshot().batch!;
  assert.equal(batch.current, 'codeforces');

  // 第 1 个完成（成功），第 2 个开始后失败
  clockMs += 5_000;
  endSync('codeforces');
  completeBatchItem('codeforces', { status: 'ok', imported: 12 });
  beginSync({ platform: 'luogu', handle: 'b', mode: 'incremental' });
  clockMs += 4_000;
  endSync('luogu');
  completeBatchItem('luogu', { status: 'failed', imported: 0, error: 'HTTP 403' });
  batch = snapshot().batch!;
  assert.equal(batch.current, null, '两个都跑完（无进行中的 job）→ current 回落为 null');
  assert.equal(batch.elapsedMs, 9_000);
  assert.deepEqual(batch.completed, [
    { platform: 'codeforces', status: 'ok', imported: 12 },
    { platform: 'luogu', status: 'failed', imported: 0, error: 'HTTP 403' },
  ]);

  // 整批结束：**不立刻消失**（否则前端永远看不到收尾状态），标记 finishedAt 后保留一段时间
  endBatch();
  const finished = snapshot().batch!;
  assert.equal(finished.finishedAt, new Date(clockMs).toISOString());
  assert.deepEqual(finished.completed.length, 2);
  // 超期（5 分钟）后自行丢弃，接口不再报旧批次
  clockMs += 5 * 60 * 1000 + 1;
  assert.equal(snapshot().batch, null);
  // 新一轮批量开始时会丢弃上一批残留
  beginBatch(['qoj']);
  assert.deepEqual(snapshot().batch!.completed, []);
});

test('syncProgress: 未开始任何同步时快照为空（前端据此自停轮询）', () => {
  setup();
  assert.deepEqual(snapshot(), { jobs: [], batch: null });
});

test('syncProgress: jobSiteRequests 给出本次窗口内的站点请求数（未在同步中为 null）', () => {
  const stats = setup();
  assert.equal(jobSiteRequests('codeforces'), null, '未在同步中 → null');
  beginSync({ platform: 'codeforces', handle: 'u', mode: 'backfill' });
  assert.equal(jobSiteRequests('codeforces'), 0, '刚开始 → 0 次');
  stats.bump('codeforces.com', clockMs);
  stats.bump('codeforces.com', clockMs);
  assert.equal(jobSiteRequests('codeforces'), 2);
  assert.equal(jobSiteRequests('luogu'), null, '其它平台不受影响');
  endSync('codeforces');
  assert.equal(jobSiteRequests('codeforces'), null, '结束后归 null');
});

test('syncProgress: 空批量（未绑定账号的 /all）不产生幽灵批次', () => {
  setup();
  beginBatch([]);
  assert.equal(snapshot().batch, null);
  endBatch(); // 空批次时收尾同样安全
  assert.equal(snapshot().batch, null);
});
