/**
 * 全局按域名节流层（src/net/hostThrottle.ts）单元测试。
 *
 * 目标：把「同一站点的请求最小间隔」收敛到传输层一处，从而在不改各平台适配器的前提下
 * 整体降低请求频率（防触发平台风控）。关键不变量：
 * 1. 同域两次请求的开始时刻至少相隔该域最小间隔（并发发起也一样，按预约顺序错开）；
 * 2. 异域互不影响（各平台节奏独立）；
 * 3. 子域沿用父域配置；
 * 4. 调用方本来就等够了时不再额外等待（间隔是下限，不是叠加）；
 * 5. 等待期间 signal 中止 → 立即抛出且不发起请求。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHostThrottle,
  HOST_MIN_INTERVAL_MS,
  DEFAULT_HOST_MIN_INTERVAL_MS,
  DEFAULT_REQUEST_INTERVAL_SCALE,
  MAX_REQUEST_INTERVAL_SCALE,
  MIN_REQUEST_INTERVAL_SCALE,
  getRequestIntervalScale,
  setRequestIntervalScale,
} from '../src/net/hostThrottle.ts';

/** 可控时钟 + 假睡眠（不真正等待，睡眠即推进时钟），并记录每次睡眠时长 */
function fakeClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
  sleeps: number[];
} {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

/** 记录「底层请求被真正发出的时刻」的 mock fetch */
function recordingFetch(
  clock: { now: () => number },
  calls: Array<{ url: string; at: number; init: RequestInit | undefined }>,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), at: clock.now(), init });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

test('hostThrottle: 同域两次请求至少相隔该域最小间隔', async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; at: number; init: RequestInit | undefined }> = [];
  const throttle = createHostThrottle(recordingFetch(clock, calls), {
    minIntervalMs: { 'a.test': 1000 },
    now: clock.now,
    sleep: clock.sleep,
  });

  await throttle.fetch('https://a.test/1');
  await throttle.fetch('https://a.test/2');

  assert.deepEqual(calls.map((c) => c.at), [0, 1000], '第二次请求应被推迟到首个请求 + 1000ms');
  assert.deepEqual(clock.sleeps, [1000]);
});

test('hostThrottle: 异域互不影响（各平台节奏独立）', async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; at: number }> = [];
  const throttle = createHostThrottle(
    (async (input: string | URL | Request) => {
      calls.push({ url: String(input), at: clock.now() });
      return new Response('{}');
    }) as unknown as typeof fetch,
    { minIntervalMs: { 'a.test': 1000, 'b.test': 1000 }, now: clock.now, sleep: clock.sleep },
  );

  await throttle.fetch('https://a.test/1');
  await throttle.fetch('https://b.test/1');
  await throttle.fetch('https://a.test/2');

  assert.deepEqual(calls.map((c) => c.at), [0, 0, 1000], 'b.test 不应等 a.test');
  assert.deepEqual(clock.sleeps, [1000], '只有 a.test 的第二次请求需要等待');
});

test('hostThrottle: 并发发起的同域请求按预约顺序错开（不并发打同一站点）', async () => {
  // 该不变量只能在真实定时器下观测：假时钟的睡眠在微任务里推进，无法体现「同时发起」的语义。
  // 断言刻意宽松：事件循环抖动/负载只会让**间隔变大**（超时是往后推的），
  // 所以用「顺序严格递增 + 总跨度 ≥ 1.6 个间隔」来判定"被错开了"，
  // 不去卡每一段都恰好 ≈ interval（那会在 CI 上偶发失败）。精确间隔由假时钟用例断言。
  const interval = 50;
  const t0 = Date.now();
  const calls: Array<{ url: string; at: number }> = [];
  const throttle = createHostThrottle(
    (async (input: string | URL | Request) => {
      calls.push({ url: String(input), at: Date.now() - t0 });
      return new Response('{}');
    }) as unknown as typeof fetch,
    { minIntervalMs: { 'a.test': interval } },
  );

  await Promise.all([
    throttle.fetch('https://a.test/1'),
    throttle.fetch('https://a.test/2'),
    throttle.fetch('https://a.test/3'),
  ]);

  assert.equal(calls.length, 3);
  const [first, second, third] = calls.map((c) => c.at);
  assert.ok(second! > first!, `第 2 次应晚于第 1 次（实际 ${first}→${second}）`);
  assert.ok(third! > second!, `第 3 次应晚于第 2 次（实际 ${second}→${third}）`);
  assert.ok(
    third! - first! >= interval * 1.6,
    `首尾应至少错开 1.6 个间隔（实际 ${third! - first!}ms）`,
  );
});

test('hostThrottle: 子域沿用父域配置（mirror.codeforces.com → codeforces.com）', async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; at: number }> = [];
  const throttle = createHostThrottle(
    (async (input: string | URL | Request) => {
      calls.push({ url: String(input), at: clock.now() });
      return new Response('{}');
    }) as unknown as typeof fetch,
    { minIntervalMs: { 'codeforces.com': 1200 }, now: clock.now, sleep: clock.sleep },
  );

  assert.equal(throttle.intervalFor('mirror.codeforces.com'), 1200);
  assert.equal(throttle.intervalFor('codeforces.com'), 1200);
  await throttle.fetch('https://codeforces.com/1');
  await throttle.fetch('https://mirror.codeforces.com/2');
  assert.deepEqual(calls.map((c) => c.at), [0, 1200], '父子域共享同一节奏桶');
});

test('hostThrottle: 未登记域名用默认间隔；无法解析的 URL 不抛错', async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; at: number }> = [];
  const throttle = createHostThrottle(
    (async (input: string | URL | Request) => {
      calls.push({ url: String(input), at: clock.now() });
      return new Response('{}');
    }) as unknown as typeof fetch,
    { minIntervalMs: {}, defaultMinIntervalMs: 600, now: clock.now, sleep: clock.sleep },
  );

  assert.equal(throttle.intervalFor('unknown.test'), 600);
  await throttle.fetch('https://unknown.test/1');
  await throttle.fetch('https://unknown.test/2');
  assert.deepEqual(calls.map((c) => c.at), [0, 600]);

  // 相对/非法 URL：不应抛错，落到「同一兜底桶」限速
  await throttle.fetch('not-a-url');
  assert.equal(calls.length, 3);
  assert.doesNotThrow(() => throttle.intervalFor('not-a-url'));
});

test('hostThrottle: 调用方本来就等够了则不再额外等待（间隔是下限而非叠加）', async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; at: number }> = [];
  const throttle = createHostThrottle(
    (async (input: string | URL | Request) => {
      calls.push({ url: String(input), at: clock.now() });
      return new Response('{}');
    }) as unknown as typeof fetch,
    { minIntervalMs: { 'a.test': 1000 }, now: clock.now, sleep: clock.sleep },
  );

  await throttle.fetch('https://a.test/1');
  clock.advance(5000); // 适配器自身的页间 sleep / 人工间隔
  await throttle.fetch('https://a.test/2');

  assert.deepEqual(calls.map((c) => c.at), [0, 5000]);
  assert.deepEqual(clock.sleeps, [], '不应产生额外睡眠');
});

test('hostThrottle: 等待期间 signal 中止 → 立即抛出且不发起请求', async () => {
  const realClock = { t: 0 };
  const calls: string[] = [];
  const controller = new AbortController();
  // 用真实 sleep，但等待被 abort 打断（不依赖假时钟推进）
  const throttle = createHostThrottle(
    (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response('{}');
    }) as unknown as typeof fetch,
    { minIntervalMs: { 'a.test': 1000 }, now: () => realClock.t, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  );

  const first = throttle.fetch('https://a.test/1');
  const second = throttle.fetch('https://a.test/2', { signal: controller.signal });
  controller.abort(new Error('已取消'));
  await first;
  await assert.rejects(() => second, /已取消/);
  assert.deepEqual(calls, ['https://a.test/1'], '中止的请求不得真正发出');
});

test('hostThrottle: 原样透传 init 与响应；retries 等上层语义不受影响', async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; at: number; init: RequestInit | undefined }> = [];
  const throttle = createHostThrottle(recordingFetch(clock, calls), {
    minIntervalMs: { 'a.test': 100 },
    now: clock.now,
    sleep: clock.sleep,
  });

  const init: RequestInit = { method: 'POST', headers: { 'x-y': '1' }, body: 'b' };
  const res = await throttle.fetch('https://a.test/x', init);
  assert.equal(res.status, 200);
  assert.equal(calls[0]!.init, init, 'init 应原样透传（不重建对象）');
  assert.equal(calls[0]!.url, 'https://a.test/x');
});

test('hostThrottle: 统计每域累计请求数与最近一次请求时刻（同步进度的 liveness 来源）', async () => {
  const clock = fakeClock();
  clock.advance(1_000); // 让 lastRequestAt 有个非 0 起点
  const throttle = createHostThrottle(
    (async () => new Response('{}')) as unknown as typeof fetch,
    { minIntervalMs: { 'a.test': 100, 'codeforces.com': 1200 }, now: clock.now, sleep: clock.sleep },
  );

  // 与节流无关的另一个域：各自独立计数
  assert.deepEqual(throttle.stats('a.test'), { requests: 0, lastRequestAt: 0 });
  assert.deepEqual(throttle.stats('unknown.test'), { requests: 0, lastRequestAt: 0 });

  await throttle.fetch('https://a.test/1');
  assert.deepEqual(throttle.stats('a.test'), { requests: 1, lastRequestAt: 1_000 });

  clock.advance(2_000); // 调用方自己等够了 → 无额外睡眠，但计数继续
  await throttle.fetch('https://a.test/2');
  assert.deepEqual(throttle.stats('a.test'), { requests: 2, lastRequestAt: 3_000 });

  // 子域与父域共用桶 → 统计合并（进度里按站点看请求数）
  await throttle.fetch('https://mirror.codeforces.com/api');
  assert.equal(throttle.stats('codeforces.com').requests, 1);
  assert.equal(throttle.stats('mirror.codeforces.com').requests, 1, '查询任一域名都读到同一桶');

  throttle.reset();
  assert.deepEqual(throttle.stats('a.test'), { requests: 0, lastRequestAt: 0 }, 'reset 同时清空统计');
});

test('hostThrottle: 生产间隔表覆盖 8 个平台且不低于各适配器自带页间延迟', () => {
  // 各适配器自带的页间延迟（server/src/adapters/*.ts），节流层必须是更慢的下限
  const adapterPageDelay: Record<string, number> = {
    'codeforces.com': 500,
    'atcoder.jp': 1000,
    'www.luogu.com.cn': 300,
    'ac.nowcoder.com': 500,
    'qoj.ac': 1000,
    'leetcode.cn': 300,
    'bs.daimayuan.top': 400,
    'www.jisuanke.com': 400,
  };
  for (const [host, delay] of Object.entries(adapterPageDelay)) {
    const interval = HOST_MIN_INTERVAL_MS[host];
    assert.equal(typeof interval, 'number', `${host} 应有显式间隔配置`);
    assert.ok(interval! >= delay * 1.5, `${host} 的节流间隔(${interval})应显著高于适配器自带延迟(${delay})`);
  }
  assert.ok(DEFAULT_HOST_MIN_INTERVAL_MS > 0);
});

test('hostThrottle: 安全下限足够保守（1× 时各站均 ≥ 官方要求的 2 倍裕度）', () => {
  // 用户把速度滑块拉到最快端（1×）时仍会生效的下限，必须显著高于各站官方阈值，
  // 以保证「滑到最短也绝不触发风控」。official = 各站官方/反爬要求的最小间隔。
  const officialMin: Record<string, number> = {
    'atcoder.jp': 1000, // kenkoooo/AtCoder 官方要求 ≥1s
    'codeforces.com': 500, // CF 建议 ≤2 req/s
    'kenkoooo.com': 1000, // ≥1s
  };
  for (const [host, min] of Object.entries(officialMin)) {
    assert.ok(
      HOST_MIN_INTERVAL_MS[host]! >= min * 2,
      `${host} 安全下限(${HOST_MIN_INTERVAL_MS[host]})应 ≥ 官方要求(${min})的 2 倍`,
    );
  }
  // 其余无明确官方阈值的站点也统一抬到 ≥1.5s
  for (const [host, interval] of Object.entries(HOST_MIN_INTERVAL_MS)) {
    if (officialMin[host] === undefined) {
      assert.ok(interval >= 1500, `${host} 安全下限(${interval})应 ≥1500ms`);
    }
  }
  assert.ok(MIN_REQUEST_INTERVAL_SCALE === 1, '倍率下限必须为 1：不允许调到安全下限以下');
  // 洛谷风控在各平台中最严：间隔必须取全表最长一档，不得回落到短间隔组
  const luogu = HOST_MIN_INTERVAL_MS['www.luogu.com.cn']!;
  for (const [host, interval] of Object.entries(HOST_MIN_INTERVAL_MS)) {
    assert.ok(luogu >= interval!, `洛谷间隔(${luogu})应不短于任一平台（${host}=${interval}）`);
  }
});

test('hostThrottle: setRequestIntervalScale 越界/非法值收敛到合法域', () => {
  try {
    assert.equal(setRequestIntervalScale(2.5), 2.5, '合法值原样生效');
    assert.equal(getRequestIntervalScale(), 2.5);
    assert.equal(setRequestIntervalScale(0.2), MIN_REQUEST_INTERVAL_SCALE, '低于下限 → 收敛到 1×');
    assert.equal(setRequestIntervalScale(99), MAX_REQUEST_INTERVAL_SCALE, '高于上限 → 收敛到 5×');
    assert.equal(setRequestIntervalScale(Number.NaN), DEFAULT_REQUEST_INTERVAL_SCALE, 'NaN → 默认 1×');
    assert.equal(
      setRequestIntervalScale(Number.POSITIVE_INFINITY),
      DEFAULT_REQUEST_INTERVAL_SCALE,
      'Infinity → 默认 1×',
    );
  } finally {
    setRequestIntervalScale(DEFAULT_REQUEST_INTERVAL_SCALE);
  }
});

test('hostThrottle: 全局倍率实时缩放有效间隔（setter 后下一次请求即生效）', async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; at: number }> = [];
  const throttle = createHostThrottle(
    (async (input: string | URL | Request) => {
      calls.push({ url: String(input), at: clock.now() });
      return new Response('{}');
    }) as unknown as typeof fetch,
    { minIntervalMs: { 'a.test': 1000 }, now: clock.now, sleep: clock.sleep },
  );
  try {
    assert.equal(throttle.intervalFor('a.test'), 1000, '默认 1× 时等于基准');
    setRequestIntervalScale(2);
    assert.equal(throttle.intervalFor('a.test'), 2000, '倍率即时反映到 intervalFor（无需重建）');

    await throttle.fetch('https://a.test/1');
    await throttle.fetch('https://a.test/2');
    assert.deepEqual(
      calls.map((c) => c.at),
      [1000, 3000],
      '2×：空闲桶首请求先等 (2-1)×基准，请求间距为 2× 间隔',
    );
  } finally {
    setRequestIntervalScale(DEFAULT_REQUEST_INTERVAL_SCALE);
  }
});

test('hostThrottle: 倍率 >1 时空闲桶首请求也按节奏；1× 首请求立即发出', async () => {
  const clock = fakeClock();
  const calls: Array<{ url: string; at: number }> = [];
  const throttle = createHostThrottle(
    (async (input: string | URL | Request) => {
      calls.push({ url: String(input), at: clock.now() });
      return new Response('{}');
    }) as unknown as typeof fetch,
    { minIntervalMs: { 'a.test': 1000 }, now: clock.now, sleep: clock.sleep },
  );
  try {
    setRequestIntervalScale(1);
    await throttle.fetch('https://a.test/warm');
    assert.equal(calls[0]!.at, 0, '1×：首请求不前置等待');

    setRequestIntervalScale(3);
    clock.advance(60_000); // 桶空闲（距上次预约远超间隔）
    await throttle.fetch('https://a.test/1');
    assert.equal(calls[1]!.at, 62_000, '3×：空闲桶首请求先等 (3-1)×1000');
    await throttle.fetch('https://a.test/2');
    assert.equal(calls[2]!.at, 65_000, '请求间距仍为完整 3× 间隔');

    //  burst 进行中（桶未空闲）不叠加前置等待：紧接着并发一次，只按预约错开
    await throttle.fetch('https://a.test/3');
    assert.equal(calls[3]!.at, 68_000, '非空闲桶只按预约间隔错开，不另加前置等待');
  } finally {
    setRequestIntervalScale(DEFAULT_REQUEST_INTERVAL_SCALE);
  }
});
