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
  /** 已上传到 AI 服务 Files API 的文件引用（仅 user 消息；服务端转换为 file 内容块） */
  attachments?: ChatFileAttachment[]
}

/** Files API 文件引用元数据（localStorage 持久化用，不含文件内容） */
export interface ChatFileAttachment {
  fileId: string
  filename?: string
  bytes?: number
  /** 文本类附件的文件内容（图片附件无此字段；服务端将其以代码块拼接到消息文本） */
  textContent?: string
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

/** token 用量信息（服务端 SSE usage 事件） */
export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

/**
 * 流式 AI 对话：逐 delta 回调，不缓冲全部内容。
 * 服务端以 SSE（text/event-stream）返回，每帧 data: {"delta": "..."} 或 data: [DONE]。
 * 非 200 响应（含 needConfig）走与 api() 一致的错误解析。
 *
 * @param onDelta 正文内容增量回调
 * @param onReasoning 推理内容（思维链）增量回调，与正文分离渲染
 * @param signal AbortSignal，用户停止生成时中断
 */
export async function chatWithAssistantStream(
  body: { messages: PlanChatTurn[]; planId?: number },
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
  onReasoning?: (chunk: string) => void,
): Promise<{
  truncated: boolean;
  contextTrimmed: number;
  summarized: boolean;
  droppedCount: number;
  sources: Array<{ title: string; url: string }>;
  usage: TokenUsage | null;
}> {
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
  let summarized = false;
  let droppedCount = 0;
  let usage: TokenUsage | null = null;
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
        if (payload === '[DONE]') return { truncated, contextTrimmed, summarized, droppedCount, sources, usage };
        try {
          const obj = JSON.parse(payload) as {
            delta?: string;
            reasoning?: string;
            error?: string;
            debug?: string;
            truncated?: boolean;
            contextTrimmed?: number;
            summarized?: boolean;
            droppedCount?: number;
            searching?: boolean;
            query?: string;
            sources?: Array<{ title: string; url: string }>;
            usage?: TokenUsage;
          };
          if (obj.delta) onDelta(obj.delta);
          if (obj.reasoning && onReasoning) onReasoning(obj.reasoning);
          if (obj.error) throw new Error(obj.error);
          if (obj.debug) console.warn('[AI debug]', obj.debug);
          if (obj.truncated) truncated = true;
          if (typeof obj.contextTrimmed === 'number') contextTrimmed = obj.contextTrimmed;
          if (obj.summarized) summarized = true;
          if (typeof obj.droppedCount === 'number') droppedCount = obj.droppedCount;
          if (Array.isArray(obj.sources)) sources.push(...obj.sources);
          if (obj.usage) usage = obj.usage;
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { truncated, contextTrimmed, summarized, droppedCount, sources, usage };
}

/** 生成会话标题：取对话前 1-2 轮调用轻量 LLM 生成 6-12 字标题 */
export async function generateSessionTitle(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const res = await post<{ title: string }>('/api/ai/title', { messages });
  return res.title;
}

export type AbilityInfo = {
  computed: number
  override: { level: number; reason?: string; updatedAt: string } | null
  effective: number
}

export const applyAbility = <T>(body: { level: number; reason?: string } | { reset: true }): Promise<T> =>
  post<T>('/api/ai/ability', body)

// ---------- AI Files API（OpenAI 兼容 /files：仅上传，供图片附件引用） ----------

export interface AiFileObject {
  id: string
  object: 'file'
  bytes: number
  created_at: number
  filename: string
  purpose: string
  /** 仅上传时设置了过期时间才出现（Unix 秒） */
  expires_at?: number
}

/** Files API 单文件上限 64 MiB（仅图片：JPEG/PNG/GIF/WebP） */
export const MAX_AI_FILE_BYTES = 64 * 1024 * 1024

/**
 * 上传文件到 AI 服务 Files API。
 * 客户端读出原始字节后直传（Content-Type 为文件自身类型），服务端再组装
 * multipart/form-data 转发上游，避免浏览器直接与上游跨域交互。
 */
export async function uploadAiFile(
  file: File,
  opts?: { expiresAfterSeconds?: number },
  signal?: AbortSignal,
): Promise<AiFileObject> {
  if (file.size > MAX_AI_FILE_BYTES) throw new Error('文件超过 64 MiB 上限（DeepSeek Files API 限制）')
  const buf = await file.arrayBuffer()
  const headers: Record<string, string> = {
    'Content-Type': file.type || 'application/octet-stream',
    'x-file-name': encodeURIComponent(file.name),
  }
  if (opts?.expiresAfterSeconds !== undefined) headers['x-expires-seconds'] = String(opts.expiresAfterSeconds)
  const res = await fetch('/api/ai/files', { method: 'POST', headers, body: buf, signal })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    let needConfig = false
    try {
      const errBody = (await res.json()) as { error?: string; needConfig?: boolean }
      if (errBody.error) msg = errBody.error
      if (errBody.needConfig) needConfig = true
    } catch { /* 非 JSON 响应，保留默认消息 */ }
    const err = new Error(msg) as Error & { needConfig?: boolean }
    if (needConfig) err.needConfig = true
    throw err
  }
  return (await res.json()) as AiFileObject
}

/**
 * 提取文档文本（支持 PDF/Word/Excel/PPT/HTML/CSV/JSON/XML/EPub）。
 * 客户端读出原始字节后直传服务端 /api/ai/extract-text，服务端按文件类型
 * 提取文本或转 Markdown 返回，用于上传文档附件时将内容注入对话。
 */
export async function extractDocumentText(
  file: File,
  signal?: AbortSignal,
): Promise<{ text: string; pages?: number; warning?: string }> {
  const buf = await file.arrayBuffer()
  const headers: Record<string, string> = {
    // 固定 octet-stream：避免 express.json() 全局中间件拦截 application/json 等类型
    // 导致 req.body 被提前解析为对象而非原始字节流；服务端按文件扩展名识别格式
    'Content-Type': 'application/octet-stream',
    'x-file-name': encodeURIComponent(file.name),
  }
  const res = await fetch('/api/ai/extract-text', { method: 'POST', headers, body: buf, signal })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const errBody = (await res.json()) as { error?: string }
      if (errBody.error) msg = errBody.error
    } catch { /* 非 JSON 响应，保留默认消息 */ }
    throw new Error(msg)
  }
  return (await res.json()) as { text: string; pages?: number; warning?: string }
}
