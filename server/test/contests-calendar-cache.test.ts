import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContestInfo } from '../../shared/src/index.ts';
import type { AllContests } from '../src/contests/index.ts';
import { createCalendarCache } from '../src/contests/calendarCache.ts';
import { createDb } from '../src/db/index.ts';

/**
 * 赛事日历持久化缓存（calendarCache.ts）。
 *
 * 背景：「我参加的」列表的参赛记录本身落库秒出，但路由要先 await 完整赛事
 * 日历（给本地推导补赛名/时间窗）——而日历缓存只存在于进程内存，软件每次
 * 重启即空，首屏就要等 5 个平台源的网络请求（单源超时 15s）。
 *
 * 这里验证落库缓存的三档语义：
 *   · 新鲜（<60min）：直接用，零网络 —— 重启后首屏秒开的核心保证；
 *   · 过期：立即返回库内旧值（归因的是历史比赛，分钟级陈旧无影响），
 *     后台刷新完成后下一次打开拿到新值；失败保留旧值并 5 分钟退避；
 *   · 库里没有（首次使用）：阻塞拉取一次并落库，全挂降级 undefined（原行为）。
 */

const CAL: ContestInfo[] = [
  {
    id: 'cf-1877',
    platform: 'codeforces',
    name: 'Codeforces Round 900 (Div. 2)',
    category: 'Div. 2',
    startTimeIso: '2026-09-20T14:00:00.000Z',
    durationMinutes: 130,
    phase: 'FINISHED',
    url: 'https://codeforces.com/contest/1877',
  },
];

const CAL2: ContestInfo[] = [
  {
    id: 'cf-1888',
    platform: 'codeforces',
    name: 'Codeforces Round 904 (Div. 2)',
    category: 'Div. 2',
    startTimeIso: '2026-09-25T14:00:00.000Z',
    durationMinutes: 130,
    phase: 'FINISHED',
    url: 'https://codeforces.com/contest/1888',
  },
];

interface FetchAllStub {
  fetchAll: () => Promise<AllContests>;
  calls: () => number;
}

/** 按调用次序依次给出响应（末位重复）；Error 项表示该次调用整体失败 */
function makeFetchAllStub(sequence: Array<AllContests | Error>): FetchAllStub {
  let calls = 0;
  const fetchAll = ((): Promise<AllContests> => {
    const next = sequence[Math.min(calls, sequence.length - 1)]!;
    calls += 1;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }) as unknown as () => Promise<AllContests>;
  return { fetchAll, calls: () => calls };
}

function seedCalendarRow(db: ReturnType<typeof createDb>, fetchedAtMsAgo: number, contests: ContestInfo[]): void {
  db.prepare('INSERT INTO calendar_cache (id, fetched_at, contests) VALUES (1, ?, ?)').run(
    new Date(Date.now() - fetchedAtMsAgo).toISOString(),
    JSON.stringify(contests),
  );
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('首次使用（库里没有日历）：阻塞拉取一次并落库，内存热后不再发请求', async () => {
  const db = createDb(':memory:');
  const cache = createCalendarCache();
  const { fetchAll, calls } = makeFetchAllStub([{ contests: CAL, failures: {} }]);

  assert.deepEqual(await cache.load(db, fetchAll), CAL);
  assert.equal(calls(), 1);
  const row = db.prepare('SELECT contests FROM calendar_cache WHERE id = 1').get() as
    | { contests: string }
    | undefined;
  assert.ok(row, '日历应落库（下次重启直接用）');
  assert.deepEqual(JSON.parse(row.contests), CAL);

  // 进程内存已热：60 分钟内重复读取零请求
  assert.deepEqual(await cache.load(db, fetchAll), CAL);
  assert.equal(calls(), 1);
});

test('核心回归：重启后（内存空）库内缓存新鲜 → 直接读库，零网络请求', async () => {
  const db = createDb(':memory:');
  seedCalendarRow(db, 5 * 60_000, CAL); // 5 分钟前落库 = 新鲜
  const cache = createCalendarCache(); // 新实例 = 模拟进程重启后内存为空
  const { fetchAll, calls } = makeFetchAllStub([new Error('不应发起任何网络请求')]);

  assert.deepEqual(await cache.load(db, fetchAll), CAL);
  assert.equal(calls(), 0, '日历新鲜时应完全不走网络（冷启动秒开）');
});

test('过期缓存：立即返回库内旧值（不等网络），后台刷新完成后下一次拿到新值', async () => {
  const db = createDb(':memory:');
  seedCalendarRow(db, 2 * 60 * 60_000, CAL); // 2 小时前 = 过期
  const cache = createCalendarCache();
  const { fetchAll, calls } = makeFetchAllStub([{ contests: CAL2, failures: {} }]);

  // 返回的是旧值 CAL 而不是网络上的新值 CAL2 —— 证明没有阻塞等刷新
  assert.deepEqual(await cache.load(db, fetchAll), CAL);
  await tick(30);
  assert.equal(calls(), 1, '过期后应触发一次后台刷新');
  const row = db.prepare('SELECT contests FROM calendar_cache WHERE id = 1').get() as { contests: string };
  assert.deepEqual(JSON.parse(row.contests), CAL2, '后台刷新应把新日历写回库');
  assert.deepEqual(await cache.load(db, fetchAll), CAL2, '之后的打开拿到新日历');
  assert.equal(calls(), 1, '刷新成功后不再重拉');
});

test('后台刷新失败：旧值保留不写坏，5 分钟内不反复重试', async () => {
  const db = createDb(':memory:');
  seedCalendarRow(db, 2 * 60 * 60_000, CAL);
  const cache = createCalendarCache();
  const { fetchAll, calls } = makeFetchAllStub([new Error('网络挂了')]);

  assert.deepEqual(await cache.load(db, fetchAll), CAL);
  await tick(30);
  assert.equal(calls(), 1);
  const row = db.prepare('SELECT contests FROM calendar_cache WHERE id = 1').get() as { contests: string };
  assert.deepEqual(JSON.parse(row.contests), CAL, '失败的刷新不得破坏库内旧值');

  // 退避期内重复读取：继续用旧值，不再发请求
  assert.deepEqual(await cache.load(db, fetchAll), CAL);
  assert.equal(calls(), 1);
});

test('库里没有缓存且拉取全挂：降级 undefined（原行为），库不落坏数据', async () => {
  const db = createDb(':memory:');
  const cache = createCalendarCache();
  const { fetchAll, calls } = makeFetchAllStub([new Error('全部源失败')]);

  assert.equal(await cache.load(db, fetchAll), undefined);
  assert.equal(calls(), 1);
  const n = db.prepare('SELECT COUNT(*) AS n FROM calendar_cache').get() as { n: number };
  assert.equal(n.n, 0, '拉取失败不落库');

  // 失败同样计入退避：紧接着的读取不再阻塞重试网络
  assert.equal(await cache.load(db, fetchAll), undefined);
  assert.equal(calls(), 1);
});
