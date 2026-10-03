/**
 * 强制 HTTP/1.1 的请求传输层。
 *
 * 背景（2026-09 实测 QOJ）：Cloudflare 托管挑战对 **HTTP/2 请求**恒定下发
 * （`403` + `cf-mitigated: challenge`），而同一份 Cookie / UA / 头部换成
 * **HTTP/1.1** 即放行（`200` + 完整页面）。Node 内置 `fetch`（undici）默认通过
 * ALPN 协商到 h2，所以适配器直连必被拦；本模块用 `node:https` 以 1.1 发出，
 * 在不引入任何新依赖的前提下拿到与浏览器导航请求一致的协议版本。
 *
 * 只在确实需要时按平台启用（见 adapters/index.ts），不改变其它适配器的行为。
 */

import https from 'node:https';
import http from 'node:http';
import { hasCloudflareChallenge } from './http.ts';

export interface Http1FetchOptions {
  /** 单次请求超时（毫秒），默认 20000 */
  timeoutMs?: number;
  /**
   * 遇到 Cloudflare 托管挑战（`cf-mitigated: challenge`）时的额外重试次数，默认 2。
   *
   * 为什么需要：qoj.ac 对非浏览器指纹的请求**间歇性**下发挑战——实测同一凭据、
   * 同一 Cookie/UA/头部连续请求会出现「403 挑战 / 200 正常」交替（约 1/8 被拦）。
   * 挑战是可重试的瞬时状态，原地重试即大概率放行。放在传输层而非
   * `HttpClient.shouldRetry`，是因为后者只能看到响应头，而这里已经读完了响应体，
   * 重试不会消耗调用方要用的数据流。
   */
  retryOnChallenge?: number;
}

/**
 * 创建只走 HTTP/1.1 的 fetch 兼容函数。
 *
 * 兼容性说明：
 * - 返回标准 `Response`（含 `ok` / `status` / `headers` / `text()` / `json()`），
 *   因此可直接替换 `fetch` 注入到适配器，`createHttpClient` 的重试与退避逻辑照常生效；
 * - **遵守 `init.signal`**：`createHttpClient` 每轮都会注入 `AbortSignal.timeout(...)`，
 *   忽略它会让超时与取消语义失效（外部中止后请求仍挂在连接上）；
 * - 请求头原样透传（Cookie / User-Agent 等不被改写），并在缺省时补
 *   `Accept-Encoding: identity`：这里不做响应解压，让服务端按 identity 返回，
 *   比引入 zlib/brotli 处理路径更稳（UOJ 页面仅 20~60KB）；
 * - 不跟随重定向（`redirect` 由适配器自行判定：登录失效 = 302）；
 * - 仅支持 http/https 绝对 URL。
 */
export function createHttp1Fetch(options: Http1FetchOptions = {}): typeof fetch {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const challengeRetries = Math.max(0, options.retryOnChallenge ?? 2);

  const send = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    // 显式要求不压缩：响应体不做解压，避免引入 zlib/brotli 处理路径
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept-encoding')) {
      headers['Accept-Encoding'] = 'identity';
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const signal = init?.signal ?? null;

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('请求已被取消'));
        return;
      }
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port !== '' ? Number(url.port) : isHttps ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
          headers,
          // 不跟随重定向：状态码与 Location 交给适配器判定（登录失效 = 302）
          ...(isHttps ? { ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2' } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const responseHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') responseHeaders.set(k, v);
              else if (Array.isArray(v)) for (const item of v) responseHeaders.append(k, item);
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 502,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders,
              }),
            );
          });
          // 响应体中途被断开（连接在正文流中 reset）时 res 会发 'error'，req 的 error 监听接不住；
          // 不挂监听会变成 unhandled 'error' 直接打崩进程。
          res.on('error', reject);
        },
      );
      const onAbort = (): void => {
        req.destroy(signal?.reason instanceof Error ? signal.reason : new Error('请求已被取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal?.removeEventListener('abort', onAbort));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`HTTP/1.1 请求超时（${timeoutMs}ms）`));
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };

  /** 挑战重试：包一层，命中托管挑战就原地重发（响应体已缓冲，可安全重试） */
  const fetchWithChallengeRetry = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let res = await send(input, init);
    for (let attempt = 1; attempt <= challengeRetries; attempt += 1) {
      if (!hasCloudflareChallenge(res)) return res;
      if (init?.signal?.aborted) return res;
      await new Promise<void>((r) => setTimeout(r, 250 * attempt));
      res = await send(input, init);
    }
    return res;
  };

  return fetchWithChallengeRetry as typeof fetch;
}
