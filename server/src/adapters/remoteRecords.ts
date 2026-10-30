import type { HttpClient } from './http.ts';
import { SyncError } from './types.ts';

/** Keep authentication failures distinct from a genuinely empty history. */
export async function recordsJson<T>(http: HttpClient, url: string, init?: RequestInit): Promise<T> {
  const response = await http.fetch(url, init, { timeoutMs: 20000 });
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'auth_expired'
      : response.status === 429 || response.status === 503 ? 'rate_limited' : 'network';
    throw new SyncError(code, `记录接口 HTTP ${response.status}，请检查登录状态或稍后重试`);
  }
  try { return await response.json() as T; }
  catch { throw new SyncError('schema_changed', '记录接口未返回 JSON，可能需要登录或完成网站验证'); }
}

export function numericUid(handle: string, platform: 'nowcoder' | 'lanqiao'): string {
  const value = handle.trim();
  if (/^[1-9]\d*$/.test(value)) return value;
  try {
    const url = new URL(value);
    const hosts = platform === 'nowcoder' ? ['www.nowcoder.com', 'ac.nowcoder.com'] : ['www.lanqiao.cn'];
    const match = platform === 'nowcoder' ? /^\/(?:users|acm\/contest\/profile|acm\/home)\/(\d+)\/?$/ : /^\/users\/(\d+)\/?$/;
    if (url.protocol === 'https:' && hosts.includes(url.hostname) && match.test(url.pathname)) return match.exec(url.pathname)![1];
  } catch { /* Show a useful binding error below. */ }
  throw new SyncError('schema_changed', `${platform === 'nowcoder' ? '牛客' : '蓝桥云课'}需要数字 UID 或个人主页链接，请在设置中修改账号`);
}

export function recordTime(value: unknown): string | null {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 && ms < 8640000000000000 ? new Date(ms).toISOString() : null;
}
