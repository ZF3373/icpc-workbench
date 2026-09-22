/**
 * 全局按域名请求节流层（防触发平台风控）。
 *
 * 背景：各平台适配器只在自己内部 `sleep`，互不感知；同一出口 IP 上的
 * 提交同步、难度回填、题库拉取、赛事中心可以同时打同一个站点。本模块把
 * 「同一域名两次请求的最小间隔」收敛到传输层一处，用最小改动整体降低请求频率：
 * 单个适配器的 URL / 头部 / 重试 / 分页逻辑都不必改动。
 *
 * 语义：
 * - **预约时间片**：每次请求先按 `max(now, 该域上次预约 + 间隔)` 占位，再等到该时刻发出。
 *   并发发起的同域请求因此天然按顺序错开，不会同时打同一站点。
 * - **间隔是下限而非叠加**：调用方本来就等够了（适配器自身的页间 sleep 更慢时）不会额外等待。
 * - **按域名分桶**：各平台节奏互相独立；子域沿用父域配置（`mirror.codeforces.com` → `codeforces.com`）。
 * - **只等一个间隔**：不排队等长任务，预约等待最长一个间隔（1× 时 ≤2.5s），
 *   因此调用点自带的 `AbortSignal.timeout` 超时语义基本不受影响。
 * - **空闲桶首请求也按节奏（仅倍率 >1×）**：先等 `(倍率-1)×基准` 再发首请求。
 *   增量同步常态下「每站点只发 1 次请求」，若首请求立即发出，倍率将毫无可观测效果；
 *   1× 时该前置等待恒为 0，安全下限不额外增加启动延迟。
 *
 * 已知取舍：
 * - 等待时长不计入 `sync_runs.waited_ms`（那里统计的是适配器自身 sleep 与限流退避）；
 * - 等待中被中止会抛出中止原因，已预约的时间片不回收（最多让下一次少等一个间隔的误差）；
 * - 无法解析的 URL 落到同一个兜底桶，按默认间隔限速。
 */
import { sleep as defaultSleep } from '../adapters/http.ts';

export interface HostThrottleOptions {
  /** 每域最小请求间隔（毫秒）；键为域名，子域自动沿用 */
  minIntervalMs?: Record<string, number>;
  /** 未登记域名的兜底间隔（毫秒） */
  defaultMinIntervalMs?: number;
  /** 注入时钟（测试用） */
  now?: () => number;
  /** 注入睡眠实现（测试用） */
  sleep?: (ms: number) => Promise<void>;
}

export interface HostThrottle {
  /** 节流后的 fetch：可直接注入 createHttpClient / 路由的 fetchFn */
  fetch: typeof fetch;
  /** 该域名当前生效的最小间隔（毫秒，已含全局拉取速度倍率），供诊断与断言 */
  intervalFor(host: string): number;
  /**
   * 该节奏桶的累计统计（单调递增，进程内）：
   * - `requests`：真正发出的请求数（含重试的每一次尝试）；
   * - `lastRequestAt`：最近一次真正发出的时刻（毫秒时间戳；从未发出为 0）。
   *
   * 用途：同步进度展示（「本窗口对该站点请求了 N 次 / 最后一次 X 秒前」）——
   * 让用户看见请求确实在流动。调用方取窗口前后的差值即可。
   */
  stats(host: string): { requests: number; lastRequestAt: number };
  /** 清空预约状态（测试用） */
  reset(): void;
}

/**
 * 生产间隔表 ＝ 全局「安全下限」（拉取速度倍率 1× 时各域名的最小请求间隔）。
 *
 * 这里的每个值都是**用户把速度滑块拉到最快端（1×）时仍会生效的下限**，因此刻意取得
 * 很保守：对每个站点都留出官方要求的 2–4 倍裕度（AtCoder ≥1s → 2.5s；CF ≤2req/s
 * 即 ≥500ms → 2s；kenkoooo ≥1s → 2s），其余无明确官方阈值的站点也统一抬到 1.5s 上下。
 * 目的是「即便用户滑到最短间隔也绝不会触发平台风控」——倍率只能调慢（见
 * MIN_REQUEST_INTERVAL_SCALE），没有任何途径让间隔低于本表。
 *
 * 洛谷（www.luogu.com.cn）取全表最严一档：其风控在各平台中最严，请求稍密即下发
 * 人机校验挑战（适配器层另有 fetchWithChallenge 兜底），故间隔必须最长而非最短。
 *
 * 同时每个值都显著高于对应适配器自带的页间延迟（CF 500ms / AtCoder 1000ms / 洛谷 300ms /
 * 牛客 500ms / QOJ 1000ms / 力扣 300ms / 代码源 400ms / 计蒜客 400ms）；由于节流间隔是
 * 「下限而非叠加」，本表事实上就是各平台拉取的有效节奏总闸。
 */
export const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  'codeforces.com': 2000,
  'atcoder.jp': 2500,
  'www.luogu.com.cn': 4000,
  'ac.nowcoder.com': 2000,
  'qoj.ac': 2500,
  'leetcode.cn': 1500,
  'bs.daimayuan.top': 1500,
  'www.jisuanke.com': 1500,
  'kenkoooo.com': 2000,
};

/** 未登记域名的兜底间隔：同样作为安全下限，保守但不至于拖慢一次性请求 */
export const DEFAULT_HOST_MIN_INTERVAL_MS = 1200;

/**
 * 全局「拉取速度」倍率取值域：对所有域名间隔等比缩放。
 * - 下限 1× ＝ HOST_MIN_INTERVAL_MS 的安全下限（最快端，已保证不触发风控）；
 * - 越大越慢越稳；只允许调慢，不允许调到安全下限以下。
 * 单一全局值，满足「统一一个值」的同时保留各域名的相对安全调参。
 */
export const MIN_REQUEST_INTERVAL_SCALE = 1;
export const MAX_REQUEST_INTERVAL_SCALE = 5;
export const DEFAULT_REQUEST_INTERVAL_SCALE = 1;

/**
 * 当前全局倍率（模块级可变单例）：生产节流单例与 QOJ 自定义传输层共用同一份，
 * 因此设置页改一次即对所有平台请求生效。`intervalFor` 每次请求实时读取本值，
 * 故 setter 调用后**无需重启、无需重建节流单例**即生效。默认 1× = 安全下限。
 */
let intervalScale = DEFAULT_REQUEST_INTERVAL_SCALE;

/** 设置全局倍率；越界或非法（NaN/Infinity）收敛到合法值，返回最终生效值。 */
export function setRequestIntervalScale(scale: number): number {
  intervalScale = Number.isFinite(scale)
    ? Math.min(MAX_REQUEST_INTERVAL_SCALE, Math.max(MIN_REQUEST_INTERVAL_SCALE, scale))
    : DEFAULT_REQUEST_INTERVAL_SCALE;
  return intervalScale;
}

/** 读取当前全局倍率（诊断/测试用） */
export function getRequestIntervalScale(): number {
  return intervalScale;
}

/** 从 fetch 入参解析域名；无法解析返回空串（落到兜底桶） */
export function hostOf(input: string | URL | Request): string {
  try {
    const raw =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 该域名归属的节奏桶：命中配置的域名本身（子域归到父域键），未命中则用自己的域名。
 * 父子域共用同一桶 → `codeforces.com` 与 `mirror.codeforces.com` 不会被同时打。
 */
export function bucketOf(host: string, table: Record<string, number>): string {
  if (host === '') return '';
  if (table[host] !== undefined) return host;
  for (const key of Object.keys(table)) {
    if (host.endsWith(`.${key}`)) return key;
  }
  return host;
}

/** 精确匹配优先，其次按「子域」后缀匹配（点边界），最后兜底 */
export function intervalForHost(
  host: string,
  table: Record<string, number>,
  fallback: number,
): number {
  if (host === '') return fallback;
  const exact = table[host];
  if (exact !== undefined) return exact;
  for (const key of Object.keys(table)) {
    if (host.endsWith(`.${key}`)) return table[key]!;
  }
  return fallback;
}

/** 可被 signal 打断的等待：等待期间中止 → 立即抛出且不发起请求 */
async function sleepInterruptible(
  ms: number,
  signal: AbortSignal | null | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error('请求已被取消');
  if (!signal) {
    await sleep(ms);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('请求已被取消'));
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 创建按域名节流的 fetch 包装。
 * @param fn 底层 fetch（测试注入 mock 即可）
 * @param options 间隔表 / 时钟 / 睡眠实现
 */
export function createHostThrottle(
  fn: typeof fetch = fetch,
  options: HostThrottleOptions = {},
): HostThrottle {
  const table = options.minIntervalMs ?? HOST_MIN_INTERVAL_MS;
  const fallback = options.defaultMinIntervalMs ?? DEFAULT_HOST_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  /** 节奏桶（子域归父域） → 下次可发出请求的最早时刻（时间片预约） */
  const nextAllowedAt = new Map<string, number>();
  /** 节奏桶 → 累计请求数 / 最近一次请求时刻（仅统计，不影响节流判定） */
  const statsByBucket = new Map<string, { requests: number; lastRequestAt: number }>();

  // 全局倍率实时作用于每次请求：intervalScale 是模块级可变值，setter 改后下一次请求即生效
  const intervalFor = (host: string): number =>
    Math.round(intervalForHost(host, table, fallback) * intervalScale);

  const throttledFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const host = hostOf(input as string | URL | Request);
    const bucket = bucketOf(host, table);
    const base = intervalForHost(host, table, fallback);
    const interval = Math.round(base * intervalScale);
    const t = now();
    const prevAllowed = nextAllowedAt.get(bucket);
    // 倍率 >1 时空闲桶的首请求也按节奏：先等 (倍率-1)×基准 再发。
    // 否则「每站点仅 1 次请求」的增量同步里首请求恒立即发出，倍率毫无可观测效果；
    // 1× 时 preWait 恒为 0，安全下限不增加启动延迟。
    const idle = prevAllowed === undefined || prevAllowed <= t;
    const preWait =
      idle && intervalScale > MIN_REQUEST_INTERVAL_SCALE
        ? Math.round(base * (intervalScale - MIN_REQUEST_INTERVAL_SCALE))
        : 0;
    const startAt = Math.max(t + preWait, prevAllowed ?? 0);
    nextAllowedAt.set(bucket, startAt + interval);
    const wait = startAt - t;
    if (wait > 0) await sleepInterruptible(wait, init?.signal, sleep);
    const stat = statsByBucket.get(bucket) ?? { requests: 0, lastRequestAt: 0 };
    statsByBucket.set(bucket, { requests: stat.requests + 1, lastRequestAt: now() });
    return fn(input, init);
  }) as typeof fetch;

  return {
    fetch: throttledFetch,
    intervalFor,
    stats: (host: string) => {
      const stat = statsByBucket.get(bucketOf(host, table));
      return stat ? { ...stat } : { requests: 0, lastRequestAt: 0 };
    },
    reset: () => {
      nextAllowedAt.clear();
      statsByBucket.clear();
    },
  };
}

/**
 * 生产单例：装配处（adapters/index.ts、路由默认 fetchFn）统一注入它。
 * 全局共享一份预约状态，才能覆盖「同步 + 回填 + 赛事」等所有并行路径。
 */
export const hostThrottle: HostThrottle = createHostThrottle(fetch, {
  minIntervalMs: HOST_MIN_INTERVAL_MS,
  defaultMinIntervalMs: DEFAULT_HOST_MIN_INTERVAL_MS,
});

export const throttledFetch: typeof fetch = hostThrottle.fetch;
