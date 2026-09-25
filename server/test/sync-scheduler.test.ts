import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { register } from '../src/adapters/registry.ts';
import { syncPlatform } from '../src/adapters/sync.ts';
import {
  __resetSyncSchedulerForTest,
  cancelAutoContinue,
  configureSyncScheduler,
  getAutoContinueRounds,
  listAutoContinue,
  scheduleAutoContinue,
} from '../src/adapters/syncScheduler.ts';

/** 多账号 v0.8：调度器每轮校验绑定行存在且启用，测试先补绑定再注册续拉 */
function bindAccount(db: Db, platform: string, handle: string): void {
  db.prepare('INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (1, ?, ?, 1)').run(platform, handle);
}

function setup(runResults: boolean[]) {
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const runs: string[] = [];
  configureSyncScheduler({
    db,
    now: () => new Date('2026-09-15T00:00:00.000Z').getTime(),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: () => {},
    run: async (platform, handle) => {
      runs.push(`${platform}:${handle}`);
      const truncated = runResults.shift() ?? false;
      return { platform, handle, imported: 1, skipped: 0, errors: [], truncated, ...(truncated ? { note: '分批' } : {}) };
    },
  });
  return { db, timers, runs };
}

test('续拉：默认 3 轮上限，按平台节奏排期，轮次耗尽后不再排期', async () => {
  __resetSyncSchedulerForTest();
  // runResults 按「每次实际执行的一轮」依次出队：第 1 轮仍截断 → 再排期；第 2 轮自然结束 → 清空。
  // （brief 原稿此处写 [true, true, false]，但原稿自身注释要求第 2 轮「自然结束」——第二轮取到的
  //   第二个 true 会继续排期，与断言的 listAutoContinue().length === 0 矛盾；按注释意图取 [true, false]。）
  const { db, timers, runs } = setup([true, false]);
  bindAccount(db, 'luogu', '1892580');
  const st = scheduleAutoContinue(db, 'luogu', '1892580');
  assert.ok(st);
  assert.equal(st.maxRounds, 3);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 90_000); // 洛谷节奏
  // 第 1 轮：仍截断 → 再排期
  await timers[0].fn();
  assert.equal(runs.length, 1);
  assert.equal(timers.length, 2);
  // 第 2 轮：自然结束 → 队列清空
  await timers[1].fn();
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：可取消；取消后不再执行', async () => {
  __resetSyncSchedulerForTest();
  const { db, timers, runs } = setup([true]);
  scheduleAutoContinue(db, 'nowcoder', '713093328');
  assert.equal(cancelAutoContinue('nowcoder'), true);
  assert.equal(listAutoContinue().length, 0);
  assert.equal(cancelAutoContinue('nowcoder'), false);
  assert.equal(timers.length, 1);
  assert.equal(runs.length, 0);
  db.close();
});

test('续拉轮数设置与关闭（0 = 关）', () => {
  __resetSyncSchedulerForTest();
  const { db } = setup([]);
  db.prepare("INSERT INTO settings (key, value) VALUES ('sync.autoContinueRounds', ?)").run('0');
  assert.equal(getAutoContinueRounds(db), 0);
  assert.equal(scheduleAutoContinue(db, 'luogu', 'u'), null);
  db.close();
});

test('续拉：轮次耗尽（一直截断）后不再排期，共执行 maxRounds 轮', async () => {
  __resetSyncSchedulerForTest();
  const { db, timers, runs } = setup([true, true, true, true, true, true, true, true]);
  bindAccount(db, 'codeforces', 'tourist');
  const st = scheduleAutoContinue(db, 'codeforces', 'tourist');
  assert.equal(st?.maxRounds, 3);
  assert.equal(timers[0].ms, 40_000); // CF 节奏
  for (let i = 0; i < timers.length; i += 1) await timers[i].fn();
  assert.equal(runs.length, 3); // 第 3 轮后 round=4 > 3 → 停止
  assert.equal(timers.length, 3);
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：任一轮报错（鉴权/限流）立即停止，不再排期', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let calls = 0;
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: () => {},
    run: async (platform, handle) => {
      calls += 1;
      return { platform, handle, imported: 0, skipped: 0, errors: ['[jisuanke] 登录态已失效'], truncated: true };
    },
  });
  bindAccount(db, 'jisuanke', 'u');
  scheduleAutoContinue(db, 'jisuanke', 'u');
  assert.equal(timers[0].ms, 180_000); // 计蒜客节奏
  await timers[0].fn();
  assert.equal(calls, 1);
  assert.equal(timers.length, 1); // 失败 → 不再排期
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：执行器抛错同样停止续拉（不外抛到定时器回调）', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: () => {},
    run: async () => { throw new Error('boom'); },
  });
  scheduleAutoContinue(db, 'atcoder', 'u');
  await timers[0].fn(); // 不得 reject
  assert.equal(timers.length, 1);
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：同平台串行——重复注册被忽略（不叠加定时器，返回既有状态）', () => {
  __resetSyncSchedulerForTest();
  const { db, timers } = setup([true]);
  const first = scheduleAutoContinue(db, 'qoj', 'Qingyu');
  const second = scheduleAutoContinue(db, 'qoj', 'Qingyu');
  assert.equal(second, first);
  assert.equal(timers.length, 1);
  // 不同平台互不影响（各自独立的节奏与队列）
  const other = scheduleAutoContinue(db, 'leetcode', 'u');
  assert.equal(other?.platform, 'leetcode');
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 120_000);
  db.close();
});

test('续拉：取消会清掉已排期的定时器，且状态带 pending 时间', () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const cancelled: unknown[] = [];
  let timerId = 0;
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (_fn, _ms) => { timerId += 1; return timerId; },
    cancelTimer: (id) => { cancelled.push(id); },
    run: async (platform, handle) => ({ platform, handle, imported: 0, skipped: 0, errors: [], truncated: false }),
  });
  const st = scheduleAutoContinue(db, 'daimayuan', 'u');
  assert.equal(st?.nextAt, '2026-09-15T00:02:00.000Z'); // 120s 后
  assert.equal(st?.running, false);
  assert.equal(st?.round, 1);
  assert.equal(cancelAutoContinue('daimayuan'), true);
  assert.deepEqual(cancelled, [1]); // 定时器被清除
  assert.equal(listAutoContinue().length, 0);
  db.close();
});

test('续拉：未装配调度器（脚本直接调 syncPlatform）时注册返回 null 而非抛错', () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  assert.equal(scheduleAutoContinue(db, 'luogu', 'u'), null);
  db.close();
});

test('sync 层：截断且 manual 触发注册续拉；days 窗口与 auto 触发均不注册', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: () => {},
    run: async (platform, handle) => ({ platform, handle, imported: 0, skipped: 0, errors: [], truncated: false }),
  });
  // 假适配器：每次同步都回写截断 + 游标（所有平台通用的截断语义）
  register({
    platform: 'jisuanke',
    knownIdsFilter: true,
    async fetchUserSubmissions(_handle, opts) {
      if (opts) {
        opts.truncated = true;
        opts.backfillReachedPage = -1;
      }
      return [];
    },
    problemUrl: ({ problemKey }) => `https://www.jisuanke.com/problem/${problemKey}`,
  });

  // 手动同步被截断 → 注册续拉（状态随结果回传，供同步中心展示）
  const manual = await syncPlatform(db, 'jisuanke', 'hieZF123', { triggeredBy: 'manual' });
  assert.equal(manual.truncated, true);
  assert.equal(manual.autoContinue?.round, 1);
  assert.equal(manual.autoContinue?.maxRounds, 3);
  assert.equal(manual.autoContinue?.nextAt, '2026-09-15T00:03:00.000Z'); // 计蒜客 180s 后
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 180_000);
  assert.equal(listAutoContinue().length, 1);
  const run = db.prepare("SELECT triggered_by FROM sync_runs ORDER BY id DESC LIMIT 1").get() as { triggered_by: string };
  assert.equal(run.triggered_by, 'manual');

  // days 窗口补充拉取：即便被截断也不注册
  cancelAutoContinue('jisuanke');
  const days = await syncPlatform(db, 'jisuanke', 'hieZF123', { days: 7, triggeredBy: 'days' });
  assert.equal(days.autoContinue, undefined);
  assert.equal(listAutoContinue().length, 0);

  // auto（后台续拉自身）再次截断：不再注册，避免无限续拉；triggered_by 记为 auto
  const auto = await syncPlatform(db, 'jisuanke', 'hieZF123', { triggeredBy: 'auto' });
  assert.equal(auto.autoContinue, undefined);
  assert.equal(listAutoContinue().length, 0);
  const autoRun = db.prepare("SELECT triggered_by FROM sync_runs ORDER BY id DESC LIMIT 1").get() as { triggered_by: string };
  assert.equal(autoRun.triggered_by, 'auto');
  db.close();
});

// ---------- 修复轮 1：改绑作废 / 同平台互斥 / 手动同步抢占 ----------

test('续拉：注册后账号被改绑 → 该轮作废（不执行、不写游标、不改回旧 handle）', async () => {
  __resetSyncSchedulerForTest();
  const { db, timers, runs } = setup([true]);
  // 真实前提：注册续拉前该平台刚同步成功，platform_accounts 已有该 handle（DEFAULT_USER_ID=1）
  db.prepare("INSERT INTO platform_accounts (user_id, platform, handle) VALUES (1, 'luogu', 'old-user')").run();
  const st = scheduleAutoContinue(db, 'luogu', 'old-user');
  assert.equal(st?.handle, 'old-user');
  assert.equal(listAutoContinue().length, 1);

  // 用户在设置页改绑 handle（routes/settings.ts 的 /accounts 同时把 last_sync_at 置空）
  db.prepare("UPDATE platform_accounts SET handle = 'new-user', last_sync_at = NULL WHERE platform = 'luogu'").run();

  await timers[0].fn();
  assert.deepEqual(runs, []); // 执行器从未被调用（不会用旧 handle 触发换账号全量重置）
  assert.equal(listAutoContinue().length, 0); // 任务作废出队
  const acc = db.prepare("SELECT handle, last_sync_at FROM platform_accounts WHERE platform='luogu'").get() as
    { handle: string; last_sync_at: string | null };
  assert.equal(acc.handle, 'new-user'); // 旧 handle 没有被写回
  assert.equal(acc.last_sync_at, null); // 用户的改绑（含增量起点重置）保持原样
  assert.equal(timers.length, 1); // 作废的轮次不再排期
  db.close();
});

test('续拉：handle 未变更时照常执行（改绑作废只针对不一致的绑定）', async () => {
  __resetSyncSchedulerForTest();
  const { db, timers, runs } = setup([false]);
  db.prepare("INSERT INTO platform_accounts (user_id, platform, handle) VALUES (1, 'luogu', 'same-user')").run();
  scheduleAutoContinue(db, 'luogu', 'same-user');
  await timers[0].fn();
  assert.deepEqual(runs, ['luogu:same-user']);
  db.close();
});

test('sync 层：非 auto 触发的同步抢占（取消）待续拉；auto 自身不清队列', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const cancelled: unknown[] = [];
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: (id) => { cancelled.push(id); },
    run: async (platform, handle) => ({ platform, handle, imported: 0, skipped: 0, errors: [], truncated: false }),
  });
  // 每次同步都截断：便于观察「抢占取消 → 末尾重新注册」
  register({
    platform: 'codeforces',
    knownIdsFilter: true,
    async fetchUserSubmissions(_handle, opts) {
      if (opts) {
        opts.truncated = true;
        opts.backfillReachedPage = 5;
      }
      return [];
    },
    problemUrl: () => 'https://codeforces.com/',
  });

  const st = scheduleAutoContinue(db, 'codeforces', 'u');
  assert.equal(listAutoContinue().length, 1);
  const manual = await syncPlatform(db, 'codeforces', 'u', { triggeredBy: 'manual' });
  assert.deepEqual(cancelled, [1]); // 待续拉的定时器被取消（旧任务被抢占）
  assert.equal(manual.autoContinue?.round, 1); // 本次截断后在末尾重新注册第 1 轮
  assert.equal(listAutoContinue().length, 1);
  assert.equal(timers.length, 2);
  assert.notEqual(st, listAutoContinue()[0]); // 是新任务，不是被取消的旧任务

  // auto（后台续拉自身）不取消自己的队列，也不回传 autoContinue（续拉轮次由调度器自身排期）
  cancelled.length = 0;
  const auto = await syncPlatform(db, 'codeforces', 'u', { triggeredBy: 'auto' });
  assert.deepEqual(cancelled, []); // auto 不抢占自己
  assert.equal(auto.truncated, true);
  assert.equal(auto.autoContinue, undefined);
  assert.equal(listAutoContinue().length, 1); // 队列里的任务保持原样
  assert.equal(timers.length, 2); // 没有新增/取消定时器
  db.close();
  __resetSyncSchedulerForTest();
});

test('sync 层：days 窗口同步不抢占待续拉队列（剩余轮次不得被静默丢弃）', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const cancelled: unknown[] = [];
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: (id) => { cancelled.push(id); },
    run: async (platform, handle) => ({ platform, handle, imported: 0, skipped: 0, errors: [], truncated: false }),
  });
  register({
    platform: 'luogu',
    knownIdsFilter: true,
    async fetchUserSubmissions(_handle, opts) {
      if (opts) {
        opts.truncated = true;
        opts.backfillReachedPage = 5;
      }
      return [];
    },
    problemUrl: ({ problemKey }) => `https://www.luogu.com.cn/problem/${problemKey}`,
  });
  const account = () =>
    db.prepare("SELECT sync_truncated, backfill_page FROM platform_accounts WHERE platform='luogu'").get() as
      { sync_truncated: number; backfill_page: number | null };

  // 前置：手动同步被截断 → 注册第 1 轮续拉，DB 标 sync_truncated=1 / backfill_page=5
  const manual = await syncPlatform(db, 'luogu', 'u', { triggeredBy: 'manual' });
  assert.equal(manual.autoContinue?.round, 1);
  assert.equal(listAutoContinue().length, 1);
  assert.equal(account().sync_truncated, 1);
  assert.equal(account().backfill_page, 5);
  const timersBefore = timers.length;
  cancelled.length = 0;

  // days 是补充拉取：不改 platform_accounts、末尾也不重新注册 → 更不能取消待续拉，
  // 否则 DB 仍宣称 sync_truncated=1 而队列已空，剩余轮次无人接续（静默丢失）
  const days = await syncPlatform(db, 'luogu', 'u', { days: 7, triggeredBy: 'days' });
  assert.equal(days.autoContinue, undefined);
  assert.deepEqual(cancelled, []); // 定时器未被取消
  assert.equal(listAutoContinue().length, 1); // 队列里的任务原样保留
  assert.equal(listAutoContinue()[0].round, 1);
  assert.equal(timers.length, timersBefore); // 既未取消也未新增
  assert.equal(account().sync_truncated, 1); // DB 状态未被 days 改动
  assert.equal(account().backfill_page, 5);

  // 未声明来源的调用方（如模板页「例题一键同步」）同样不抢占
  await syncPlatform(db, 'luogu', 'u');
  assert.deepEqual(cancelled, []);
  assert.equal(listAutoContinue().length, 1);
  db.close();
  __resetSyncSchedulerForTest();
});

test('sync 层：被互斥锁拒绝的重复触发不抢占待续拉队列（链不得被杀死）', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const cancelled: unknown[] = [];
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  register({
    platform: 'codeforces',
    knownIdsFilter: true,
    async fetchUserSubmissions(_handle, opts) {
      entered += 1;
      if (entered === 1) await gate; // 第一轮（后台续拉）卡在适配器里 → 锁被持有
      if (opts) {
        opts.truncated = true;
        opts.backfillReachedPage = 3;
      }
      return [];
    },
    problemUrl: () => 'https://codeforces.com/',
  });
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    cancelTimer: (id) => { cancelled.push(id); },
    // 真执行器：续拉轮次真的走 syncPlatform（triggeredBy='auto'），锁是真锁
    run: (platform, handle) => syncPlatform(db, platform, handle, { triggeredBy: 'auto' }),
  });

  bindAccount(db, 'codeforces', 'u');
  const st = scheduleAutoContinue(db, 'codeforces', 'u');
  assert.equal(listAutoContinue().length, 1);
  timers[0].fn(); // 第 1 轮开跑（内部持锁并卡在适配器；排期回调本身不返回 Promise）
  assert.equal(entered, 1);

  // 此刻用户手动点同步：被锁拒绝（没有发出任何请求），不得取消待续拉
  const rejected = await syncPlatform(db, 'codeforces', 'u', { triggeredBy: 'manual' });
  assert.match(rejected.errors[0], /正在同步中/);
  assert.deepEqual(cancelled, []); // 定时器未被取消
  assert.equal(listAutoContinue().length, 1);
  assert.equal(listAutoContinue()[0], st); // 还是原来那个任务

  // 让第 1 轮跑完：settle 时必须仍能续排第 2 轮（旧实现会因队列被清空而静默断链）
  release();
  await new Promise((resolve) => setImmediate(resolve)); // 排空微任务，等这一轮 settle
  assert.equal(timers.length, 2);
  assert.equal(listAutoContinue().length, 1);
  assert.equal(listAutoContinue()[0].round, 2);
  assert.equal(timers[1].ms, 40_000); // CF 节奏
  db.close();
  __resetSyncSchedulerForTest();
});

test('sync 层：同平台并发触发被内存锁拒绝（不产生请求、不写 sync_runs、锁会释放）', async () => {
  __resetSyncSchedulerForTest();
  const db = createDb(':memory:');
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  register({
    platform: 'atcoder',
    async fetchUserSubmissions() {
      started += 1;
      await gate; // 卡住第一轮，模拟「正在同步中」
      return [];
    },
    problemUrl: () => 'https://atcoder.jp/',
  });

  const first = syncPlatform(db, 'atcoder', 'u');
  assert.equal(started, 1); // 第一个调用已进入适配器（锁已持有）
  const second = await syncPlatform(db, 'atcoder', 'u');
  assert.equal(started, 1); // 第二个调用未触达适配器 → 没有并发请求
  assert.match(second.errors[0], /正在同步中/);
  assert.equal(second.imported, 0);
  const rejected = db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE platform='atcoder'").get() as { n: number };
  assert.equal(rejected.n, 0); // 被拒绝的触发不写 sync_runs（含不写失败行）

  release();
  const firstResult = await first;
  assert.deepEqual(firstResult.errors, []);
  const okRows = db.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE platform='atcoder'").get() as { n: number };
  assert.equal(okRows.n, 1); // 只有真正跑过的那次留下记录

  // 锁已释放：同平台可再次同步（若未在 finally 释放，这里会被再次拒绝）
  const third = await syncPlatform(db, 'atcoder', 'u');
  assert.deepEqual(third.errors, []);
  assert.equal(started, 2);

  // 不同平台互不影响：atcoder 未完成也不阻塞 daimayuan
  register({
    platform: 'daimayuan',
    async fetchUserSubmissions() { started += 1; await gate; return []; },
    problemUrl: () => 'https://bs.daimayuan.top/',
  });
  const other = syncPlatform(db, 'daimayuan', 'u');
  assert.equal(started, 3);
  await other;
  db.close();
  __resetSyncSchedulerForTest();
});

test('sync 层：执行体抛错（库不可用）同样释放互斥锁，换库后同平台可再同步', async () => {
  __resetSyncSchedulerForTest();
  const broken = createDb(':memory:');
  const ok = createDb(':memory:');
  register({
    platform: 'luogu',
    async fetchUserSubmissions() { return []; },
    problemUrl: () => 'https://www.luogu.com.cn/',
  });
  broken.close(); // 进入执行体后立刻抛错（settings 查询）
  await assert.rejects(() => syncPlatform(broken, 'luogu', 'u'));
  const after = await syncPlatform(ok, 'luogu', 'u'); // 锁泄漏的话这里会返回「正在同步中」
  assert.deepEqual(after.errors, []);
  ok.close();
  __resetSyncSchedulerForTest();
});
