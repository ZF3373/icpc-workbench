/**
 * 外部请求统一层：超时 + 有限重试（指数退避 + Retry-After）。
 *
 * 背景（见项目优化方案 P1-5）：7 个适配器此前各自 `fetchFn(url, { signal: AbortSignal.timeout(n) })`，
 * 只有超时、**没有任何重试** —— 平台偶发一次 5xx/网络抖动就让整次同步失败；
 * 而 AI provider 单独实现了一套指数退避。本模块把这层收敛为一处。
 *
 * 设计取舍：
 * - **默认不重试**（`retries: 0`）。适配器测试用单次响应的 mock fetch，
 *   默认重试会让失败用例变慢且改变调用次数语义；生产装配（adapters/index.ts）显式打开重试。
 * - 错误消息保持既有格式（`${label} HTTP ${status}` / 直接抛出网络错误），
 *   否则 `sync.ts` 的 error_code 分类与既有测试断言会失配。
 * - 传 `recordWait` 时把退避等待计入 `opts.waitedMs`，同步中心据此展示限速等待耗时。
 */

/** 视为可重试的 HTTP 状态：限流 + 服务端错误 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export interface HttpOptions {
  /** 单次尝试超时（毫秒），默认 20000 */
  timeoutMs?: number;
  /** 额外重试次数（不含首次），默认 0 = 不重试 */
  retries?: number;
  /** 退避基数（毫秒），第 n 次重试等待 base * 2^(n-1)，默认 500 */
  retryBaseMs?: number;
  /** 退避上限（毫秒），默认 8000 */
  retryMaxMs?: number;
  /** 错误消息前缀，如 'Codeforces API' → `Codeforces API HTTP 503` */
  label?: string;
  /** 附加请求头（与 init.headers 合并，后者优先） */
  headers?: Record<string, string>;
  /** 计入限速等待耗时（同步层 opts 载体）；缺省不回传 */
  recordWait?: (ms: number) => void;
  /** 判定某次失败是否重试（缺省：状态码在 RETRYABLE_STATUS 内，或网络层异常） */
  shouldRetry?: (info: { status?: number; error?: unknown; attempt: number }) => boolean;
}

export interface HttpClient {
  /** 单次请求（含超时；按 opts 决定是否重试） */
  fetch(url: string, init?: RequestInit, opts?: HttpOptions): Promise<Response>;
  /** 请求 + JSON 解析 + ok 校验（非 ok 抛 `${label} HTTP ${status}`） */
  json<T>(url: string, init?: RequestInit, opts?: HttpOptions): Promise<T>;
}

export type HttpInit = typeof fetch | HttpClient;

/** 是否已经是本模块封装过的客户端（避免重复包装） */
export function isHttpClient(v: unknown): v is HttpClient {
  return typeof v === 'object' && v !== null && typeof (v as HttpClient).fetch === 'function';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 解析 Retry-After（秒数或 HTTP 日期），无法解析返回 null */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return null;
}

/**
 * 该响应是否带 Cloudflare 托管挑战标记（`cf-mitigated: challenge`）。
 *
 * 用途：部分站点（如 qoj.ac）对非浏览器指纹的请求**间歇性**下发挑战——
 * 同一凭据、同一头部连续请求会实测出「403 挑战 / 200 正常」交替。
 * 挑战属于可重试的瞬时状态（下一次请求即可能放行），因此这类平台的传输层
 * 应在自己的重试里把它当作可重试；本函数只提供判定，不改变默认策略。
 *
 * 只依据响应头判定：响应体在重试位置读取会消耗掉调用方要用的流。
 */
export function hasCloudflareChallenge(res: Response): boolean {
  return (res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge';
}

/** 指数退避 + 抖动，并尊重 Retry-After（取二者较大值） */
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jittered = exp / 2 + random() * (exp / 2); // 半抖动：避免同刻集中重试
  // 服务端下发的 Retry-After 不被 maxMs 钳制：限流窗口（如 30s）比本地退避上限（8s）长时，
  // 只等 8s 就重试会全部撞回 429、把重试次数烧光（与函数注释「取二者较大值」一致）
  if (retryAfterMs !== null) return Math.max(jittered, retryAfterMs);
  return Math.min(maxMs, jittered);
}

/**
 * 创建统一请求客户端。
 * @param fn 底层 fetch（测试注入 mock 即可）
 * @param defaults 该客户端的默认选项（调用处显式传入的 opts 优先）。
 *   生产装配用 `PROD_RETRY` 打开有限重试；缺省不重试，便于单测保持单次响应语义。
 */
export function createHttpClient(fn: typeof fetch = fetch, defaults: HttpOptions = {}): HttpClient {
  const request = async (url: string, init: RequestInit = {}, callOpts: HttpOptions = {}): Promise<Response> => {
    const opts: HttpOptions = { ...defaults, ...callOpts };
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const retries = Math.max(0, opts.retries ?? 0);
    const baseMs = opts.retryBaseMs ?? 500;
    const maxMs = opts.retryMaxMs ?? 8000;
    const label = opts.label;

    const headers = { ...(opts.headers ?? {}), ...((init.headers as Record<string, string> | undefined) ?? {}) };

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let res: Response | undefined;
      try {
        // 合并调用方 signal 与超时：既遵守「调用方断连可取消」的语义，又保证单次请求有硬超时。
        // 之前这里写死 AbortSignal.timeout 会覆盖 init.signal，与 http1.ts / hostThrottle.ts 不一致。
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
        res = await fn(url, { ...init, headers, signal });
      } catch (error) {
        lastError = error;
        const retryable =
          opts.shouldRetry?.({ error, attempt: attempt + 1 }) ?? attempt < retries;
        if (!retryable || attempt === retries) throw error;
        await waitBeforeRetry(attempt + 1, baseMs, maxMs, null, opts);
        continue;
      }

      if (res.ok) return res;

      // 非 2xx：先按可重试性决定是否退避重试；确实不再重试时才收尾。
      // 重试判定早于收尾，是因为「限流重试」与「把响应交给调用方」是两件事。
      // 该状态本身是否需要吞掉/转成错误，见 finish()。
      const retryable =
        opts.shouldRetry?.({ status: res.status, attempt: attempt + 1 }) ??
        (RETRYABLE_STATUS.has(res.status) && attempt < retries);
      if (!retryable || attempt === retries) return finish(res);
      await waitBeforeRetry(attempt + 1, baseMs, maxMs, parseRetryAfter(res.headers.get('retry-after')), opts);
    }
    throw lastError instanceof Error ? lastError : new Error('请求失败');

    /**
     * 收尾：**带 label 才抛错**。
     *
     * 各适配器要自己分流状态码（302 = 未登录、401/403 = 凭据失效、403/404 = 跳过该比赛、
     * 504 = 挑战重试超限……），因此无 label 时原样返回 Response，由调用方的 `if (!res.ok)`
     * 分支抛它自己的业务消息 —— 绝不能在这里抢先拦截，否则 302 会变成 `HTTP 302`
     * 而绕过适配器的登录跳转判定。
     * 仅 `json()` 这类通用入口（会带 label）在此抛出 `${label} HTTP ${status}`。
     */
    function finish(response: Response): Response {
      if (label === undefined) return response;
      throw new Error(`${label} HTTP ${response.status}`);
    }
  };

  return {
    fetch: request,
    /**
     * 取 JSON：通用入口没有适配器自己的状态码分流，非 2xx 直接抛
     * `HTTP ${status}`（调用方可传 label 定制前缀）。
     */
    async json<T>(url: string, init?: RequestInit, opts?: HttpOptions): Promise<T> {
      const res = await request(url, init, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    },
  };
}

async function waitBeforeRetry(
  attempt: number,
  baseMs: number,
  maxMs: number,
  retryAfterMs: number | null,
  opts: HttpOptions,
): Promise<void> {
  const ms = backoffDelayMs(attempt, baseMs, maxMs, retryAfterMs);
  opts.recordWait?.(ms);
  await sleep(ms);
}

/**
 * 把「fetch 或 HttpClient」统一成 HttpClient。
 * 让既有适配器工厂（接收 `typeof fetch`，测试注入 mock）能不改签名地接入本层。
 */
export function asHttpClient(fn: HttpInit): HttpClient {
  return isHttpClient(fn) ? fn : createHttpClient(fn);
}

/** 生产装配用的默认重试策略：偶发 5xx / 限流自动重试 2 次 */
export const PROD_RETRY: HttpOptions = {
  retries: 2,
  retryBaseMs: 800,
  retryMaxMs: 8000,
};
