/** 后端 API 封装：统一 JSON 请求与错误提取。 */

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 非 JSON 响应，保留默认消息 */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const get = <T>(path: string): Promise<T> => api<T>(path);

export const post = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const del = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });
