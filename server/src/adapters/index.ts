import { createAtcoderAdapter } from './atcoder.ts';
import { createCodeforcesAdapter } from './codeforces.ts';
import { createDaimayuanAdapter } from './daimayuan.ts';
import { createDashojAdapter } from './dashoj.ts';
import { createJisuankeAdapter } from './jisuanke.ts';
import { createLeetcodeAdapter } from './leetcode.ts';
import { createLuoguAdapter } from './luogu.ts';
import { createNowcoderAdapter } from './nowcoder.ts';
import { createVjudgeAdapter } from './vjudge.ts';
import { createQojAdapter } from './qoj.ts';
import { fetchPageViaAgent } from './qojAgent.ts';
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
  register(createVjudgeAdapter(http));
  register(createDaimayuanAdapter(http));
  register(createDashojAdapter(http));
  register(createLeetcodeAdapter(http));
  register(createJisuankeAdapter(http));
  // QOJ 提交页走 WebView 同源代理（qojAgent.ts）：2026-10 起站点 Cloudflare 把 cf_clearance
  // 绑定到签发客户端的 TLS 指纹，Node 重放 Cookie 必被拦——唯一稳健通道是壳内 WebView 同源抓取。
  // 难度回填读 QOJ 比赛页仍走 HTTP/1.1 直连（公开页 + 重试兜底），与提交页互不依赖。
  register(
    createQojAdapter(createHttpClient(qojTransportFetch(), PROD_RETRY), {
      fetchPage: (url, timeoutMs) => fetchPageViaAgent(url, timeoutMs),
    }),
  );
}
export * from './registry.ts';
export type { PlatformAdapter } from './types.ts';
