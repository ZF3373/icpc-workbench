/**
 * OpenAI 系请求（auth.openai.com / api.openai.com）的网络代理装配（issue 67）。
 *
 * 背景：Sign in with ChatGPT / Codex CLI 的请求目标都在 OpenAI 侧，OpenAI 按**出口 IP**
 * 的地理位置拒绝不支持地区的访问（unsupported_country_region_territory，用户实测）。
 * 浏览器侧走系统代理即可，但 Node 的全局 fetch 既不读系统代理也不读 HTTP(S)_PROXY
 * 环境变量 —— 服务端直连时「浏览器能打开授权页、token 交换却必然被地区封锁」。
 * 这里统一给 OpenAI 系请求装一个代理感知的 fetch：
 * - 显式代理（提供商设置里的 proxy 字段）优先；
 * - 缺省回退环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（大小写都认）；
 * - 测试注入的 fetchFn 优先于代理（桩不该被真实代理改变行为）。
 * 仅 keyless 类提供商（chatgpt/codex）接入；chat 类提供商的第三方网关（DeepSeek 等
 * 国内可达）不读环境变量，避免无谓地改变既有网络路径。
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

/** 显式代理 → 环境变量回退；两者都没有返回 undefined（直连） */
export function resolveProxyUrl(explicit?: string | null): string | undefined {
  const v = explicit?.trim();
  if (v) return v;
  const env = (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    ''
  ).trim();
  return env || undefined;
}

/** ProxyAgent 按 URI 缓存复用（每个登录/对话都新建会泄漏连接池） */
const proxyAgents = new Map<string, ProxyAgent>();

function proxyAgentFor(uri: string): ProxyAgent {
  let agent = proxyAgents.get(uri);
  if (!agent) {
    agent = new ProxyAgent({ uri });
    proxyAgents.set(uri, agent);
  }
  return agent;
}

/**
 * 组装代理感知的 fetch：proxyUrl 存在时经 undici ProxyAgent 发出（HTTPS 目标走
 * CONNECT 隧道）；无代理回落到注入的 fetchFn（测试）或全局 fetch。
 */
export function proxyFetch(proxyUrl: string | undefined, fetchFn?: typeof fetch): typeof fetch {
  if (fetchFn) return fetchFn; // 测试注入优先于代理
  const resolved = resolveProxyUrl(proxyUrl);
  if (!resolved) return fetch;
  const agent = proxyAgentFor(resolved);
  // undici 的 fetch 与全局 fetch 同源（Node 内置即 undici），Response 形态一致；
  // 仅 dispatcher 是 undici 扩展项，跨类型系统一按 typeof fetch 使用
  const proxied = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    }) as unknown as Promise<Response>;
  return proxied;
}

/** 仅测试使用：清空代理连接池（切换代理地址后强制重建） */
export function clearProxyAgentsForTest(): void {
  proxyAgents.clear();
}
