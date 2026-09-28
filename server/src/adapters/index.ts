import { createAtcoderAdapter } from './atcoder.ts';
import { createCodeforcesAdapter } from './codeforces.ts';
import { createDaimayuanAdapter } from './daimayuan.ts';
import { createJisuankeAdapter } from './jisuanke.ts';
import { createLeetcodeAdapter } from './leetcode.ts';
import { createLuoguAdapter } from './luogu.ts';
import { createNowcoderAdapter } from './nowcoder.ts';
import { createQojAdapter } from './qoj.ts';
import { register } from './registry.ts';
import { createHttpClient, PROD_RETRY } from './http.ts';
import { qojTransportFetch } from '../net/qojTransport.ts';
import { throttledFetch } from '../net/hostThrottle.ts';

// 各平台适配器统一在此注册；平台级开关（enabled）由同步 API 按 settings 过滤。
let initialized = false;

/**
 * 在 server 启动时调用一次，传入 dataDir 供适配器做资源缓存。
 * 适配器共享同一个 HttpClient：生产环境显式开启有限重试（偶发 5xx / 限流自动退避重试 2 次）。
 * 适配器工厂本身默认不重试，以保证单测注入单次响应 mock 时的调用次数语义不变（见 http.ts）。
 *
 * 传输层统一注入 `throttledFetch`（net/hostThrottle.ts）：各平台适配器一行不改，
 * 所有平台请求都被「按域名最小间隔 + 同域顺序错开」节流，整体降低触发平台风控的概率。
 */
export function initAdapters(dataDir?: string): void {
  if (initialized) return;
  initialized = true;
  const http = createHttpClient(throttledFetch, PROD_RETRY);
  register(createCodeforcesAdapter(http));
  register(createAtcoderAdapter(dataDir, http));
  register(createLuoguAdapter(http));
  register(createNowcoderAdapter(http));
  register(createDaimayuanAdapter(http));
  register(createLeetcodeAdapter(http));
  register(createJisuankeAdapter(http));
  // QOJ 必须走 HTTP/1.1：Cloudflare 对 h2 请求恒定下发托管挑战（详见 http1.ts 与 qoj.ts 注释）。
  // 传输层取自共享单例（net/qojTransport.ts）：难度回填读 QOJ 比赛页也走同一个节奏桶，
  // 否则两条路径各建一个节流桶 → 对 qoj.ac 的实际频率翻倍。
  register(createQojAdapter(createHttpClient(qojTransportFetch(), PROD_RETRY)));
}
export * from './registry.ts';
export type { PlatformAdapter } from './types.ts';
