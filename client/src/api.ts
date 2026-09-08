/** 后端 API 封装：统一 JSON 请求与错误提取。 */

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let needConfig = false;
    try {
      const body = (await res.json()) as { error?: string; needConfig?: boolean };
      if (body.error) msg = body.error;
      if (body.needConfig) needConfig = true;
    } catch {
      /* 非 JSON 响应，保留默认消息 */
    }
    const err = new Error(msg) as Error & { needConfig?: boolean };
    if (needConfig) err.needConfig = true;
    throw err;
  }
  return (await res.json()) as T;
}

export const get = <T>(path: string): Promise<T> => api<T>(path);

export const post = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const patch = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, {
    method: 'PATCH',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const put = <T>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, {
    method: 'PUT',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const del = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });

// ---------- AI 助手（全局，含训练计划讨论/修改） ----------

export interface PlanChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface PlanApplyResult {
  ok: boolean
  added: number
  removed: number
  kept: number
  checkinsKept: number
}

export const applyPlanModification = <T>(planId: number, raw: string): Promise<T> =>
  post<T>(`/api/plans/${planId}/apply`, { raw })

export const chatWithAssistant = <T>(body: { messages: PlanChatTurn[]; planId?: number }): Promise<T> =>
  post<T>('/api/ai/chat', body)

/**
 * 流式 AI 对话：逐 delta 回调，不缓冲全部内容。
 * 服务端以 SSE（text/event-stream）返回，每帧 data: {"delta": "..."} 或 data: [DONE]。
 * 非 200 响应（含 needConfig）走与 api() 一致的错误解析。
 */
export async function chatWithAssistantStream(
  body: { messages: PlanChatTurn[]; planId?: number },
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<{ truncated: boolean; contextTrimmed: number; sources: Array<{ title: string; url: string }> }> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let needConfig = false;
    try {
      const errBody = (await res.json()) as { error?: string; needConfig?: boolean };
      if (errBody.error) msg = errBody.error;
      if (errBody.needConfig) needConfig = true;
    } catch { /* 非 JSON 响应，保留默认消息 */ }
    const err = new Error(msg) as Error & { needConfig?: boolean };
    if (needConfig) err.needConfig = true;
    throw err;
  }
  if (!res.body) throw new Error('服务端未返回流式响应体');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let truncated = false;
  let contextTrimmed = 0;
  const sources: Array<{ title: string; url: string }> = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return { truncated, contextTrimmed, sources };
        try {
          const obj = JSON.parse(payload) as {
            delta?: string;
            error?: string;
            truncated?: boolean;
            contextTrimmed?: number;
            searching?: boolean;
            query?: string;
            sources?: Array<{ title: string; url: string }>;
          };
          if (obj.delta) onDelta(obj.delta);
          if (obj.error) throw new Error(obj.error);
          if (obj.truncated) truncated = true;
          if (typeof obj.contextTrimmed === 'number') contextTrimmed = obj.contextTrimmed;
          if (Array.isArray(obj.sources)) sources.push(...obj.sources);
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { truncated, contextTrimmed, sources };
}

export type AbilityInfo = {
  computed: number
  override: { level: number; reason?: string; updatedAt: string } | null
  effective: number
}

export const applyAbility = <T>(body: { level: number; reason?: string } | { reset: true }): Promise<T> =>
  post<T>('/api/ai/ability', body)
