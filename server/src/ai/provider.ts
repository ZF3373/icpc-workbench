import type { AiConfig } from '../config.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** token 用量信息（OpenAI 兼容 usage 字段） */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * user 消息的多模态内容块（OpenAI 兼容格式）。
 * file 块引用 Files API 上传得到的 file_id（形如 file-api-...）。
 */
export type ChatContentBlock =
  | { type: 'text'; text: string }
  | { type: 'file'; file_id: string; filename?: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentBlock[];
  /** assistant 消息携带的 tool_calls（AI 请求调用工具时填充） */
  tool_calls?: ToolCall[];
  /** tool 角色消息对应的 tool_call_id（工具执行结果回传时填充） */
  tool_call_id?: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 可用工具定义，传入后 AI 可在回复中发起 tool_calls */
  tools?: ToolDefinition[];
  /** 流结束时回调，传入 OpenAI 兼容的 finish_reason（"stop"|"length"|"tool_calls"|null）与累积的 tool_calls */
  onFinish?: (reason: string | null, toolCalls?: ToolCall[]) => void;
  /** 推理内容（reasoning_content）回调：DeepSeek-R1 / o1 等模型的思维链增量 */
  onReasoning?: (chunk: string) => void;
  /** token 用量回调：流式模式下需配合 stream_options.include_usage */
  onUsage?: (usage: TokenUsage) => void;
  /** 调用方提供的 AbortSignal（如客户端中断），与超时信号组合后传入 fetch */
  signal?: AbortSignal;
  /** 是否解析 DSML 标记为 tool_calls（默认 true；二轮流式设为 false 避免 DeepSeek 误触发） */
  parseDsmlTools?: boolean;
  /** 流式读取的空闲超时（毫秒，默认 STREAM_STALL_TIMEOUT_MS；测试可注入小值） */
  stallTimeoutMs?: number;
}

/**
 * 流式读取的空闲看门狗阈值。
 *
 * 为什么需要：正文读取阶段故意不受 timeoutMs 约束（AI 生成可能耗时数分钟），
 * 但上游「连上了却再也不发数据」（聚合网关挂住、中间设备吞流、连接半开）时
 * reader.read() 永不返回 —— 前端表现为「正文已经输出完，按钮却一直停在停止生成」
 * 且没有任何错误可看（issue 36）。空闲超过这个阈值就掐断并抛出可读错误。
 * 阈值取 120s：远大于正常 token 间隔（含长思考、工具执行之间的间隙），不会误杀。
 */
export const STREAM_STALL_TIMEOUT_MS = 120_000;

/** baseURL → chat/completions 端点：容忍用户直接粘贴完整端点地址 */
export function chatUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

/**
 * baseURL → Files 端点：同样容忍粘贴 chat/completions、/models 或 /files 结尾的地址。
 * 对应 OpenAI 兼容 /files 资源（DeepSeek Files API：上传/列出/查询/删除文件）。
 */
export function filesUrl(base: string): string {
  let trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    trimmed = trimmed.slice(0, -'/chat/completions'.length);
  } else if (trimmed.endsWith('/models')) {
    trimmed = trimmed.slice(0, -'/models'.length);
  }
  if (trimmed.endsWith('/files')) return trimmed;
  return `${trimmed}/files`;
}

/**
 * 错误 → 可读文案：把 error.cause 拼进 message。
 * Node undici 网络层失败的 message 只有一句「fetch failed」，真实原因（DNS 解析失败 /
 * 连接被拒 / 重定向超限 / TLS 证书）全在 cause 里 —— 不拼上它，用户只能看到一句
 * 无法定位的报错（联网搜索报「AI 调用失败：fetch failed」却查不到原因，2026-09-30）。
 */
export function describeError(e: unknown): string {
  const err = e as Error & { cause?: unknown };
  const main = err?.message || String(e);
  const cause = err?.cause;
  if (cause === undefined || cause === null) return main;
  const causeMsg = cause instanceof Error ? cause.message : String(cause);
  if (causeMsg === '' || main.includes(causeMsg)) return main;
  return `${main}（${causeMsg}）`;
}

/** HTTP 错误信息友好化：524/504 网关超时给出可操作建议 */
function friendlyHttpError(status: number, body: string): Error {
  if (status === 524 || status === 504) {
    return new Error(
      `AI 服务端超时（HTTP ${status}）——AI 接口处理时间过长被中间网关切断，建议缩短问题或更换响应更快的模型（如 DeepSeek）`,
    );
  }
  return new Error(`AI API HTTP ${status}: ${body.slice(0, 200)}`);
}

// ---------- max_tokens 超限自动降级 ----------
// 部分聚合网关（如免费 LLM 中转）按 max_tokens 路由模型：请求的 max_tokens 超过
// 目录内所有模型的上限时返回 429/400 + routing_error（"All models exhausted"）。
// 此时沿阶梯逐级降低 max_tokens 重试。注意不能一步降到太小：推理模型的思考过程
// 也计入输出预算，max_tokens 太小会导致思考耗尽预算、正文被截断。

const MAX_TOKENS_LADDER = [65536, 16384, 8192];

/** 返回阶梯中小于 cur 的下一档；没有更小的档位时返回 null */
function nextMaxTokensLimit(cur: number): number | null {
  for (const l of MAX_TOKENS_LADDER) {
    if (l < cur) return l;
  }
  return null;
}

/** 判断是否为「max_tokens 超出网关模型上限」类路由错误（friendlyHttpError 会把状态码与响应体拼进 message） */
function isMaxTokensRoutingError(errText: string): boolean {
  if (!/HTTP (429|400)\b/.test(errText)) return false;
  return /routing_error|all models exhausted|exceeds?.*(limit|maximum)|max_tokens.*too (large|big)/i.test(errText);
}

// ---------- HTTP 重试（指数退避） ----------
// 参考opencode的shouldRetry策略：429/5xx可重试错误用指数退避+jitter，尊重Retry-After header。
// 桌面应用用户在等待，基础间隔比opencode更短（1s vs 2s），最大重试3次（vs 8次）。

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 524]);
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

/** 判断是否应该重试，并返回应等待的毫秒数 */
function shouldRetry(status: number, retryAfterHeader: string | null, attempt: number): number | null {
  if (attempt >= MAX_RETRIES) return null;
  if (!RETRYABLE_STATUS.has(status)) return null;
  // 尊重 Retry-After header（秒数）
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 30_000); // 上限30秒
    }
  }
  // 指数退避 + 20% jitter
  const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  const jitter = backoff * 0.2 * Math.random();
  return Math.round(backoff + jitter);
}

/** sleep 可被 AbortSignal 中断 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 带重试的 fetch：仅对可重试 HTTP 状态码进行指数退避重试。
 * 流式响应仅重试连接阶段（res.ok 为 false），流开始后由调用方处理。
 */
async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  // 组合调用方信号与超时信号
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(url, { ...init, signal: combinedSignal });
    if (res.ok) return res;

    // 不可重试的错误直接抛出
    const retryAfter = res.headers.get('retry-after');
    const waitMs = shouldRetry(res.status, retryAfter, attempt);
    if (waitMs === null) {
      const text = await res.text().catch(() => '');
      throw friendlyHttpError(res.status, text);
    }

    // 可重试：等待后重试（等待期间可被调用方中断）
    try {
      await sleep(waitMs, callerSignal);
    } catch {
      // 调用方中断：抛出原始 HTTP 错误而非 AbortError
      const text = await res.text().catch(() => '');
      throw friendlyHttpError(res.status, text);
    }
    // 继续下一轮重试
  }
}

// ---------- DSML 协议标记过滤 ----------
// DeepSeek 模型调用工具时，内部 DSML 标记（<｜DSML｜tool_calls>…</｜DSML｜tool_calls>）
// 有时未被 API 层正确解析为结构化 tool_calls，而是作为 content 文本泄漏到流中。
// 这些标记对用户是噪音，需要实时检测并过滤，同时从中解析出工具调用信息。
// ｜ 为 U+FF5C 全角竖线，正常文本中几乎不会出现，可作为可靠哨兵。

const DSML_OPEN = '<｜DSML｜';
const DSML_TOOL_CALLS_END = '</｜DSML｜tool_calls>';

/** 从完整 DSML tool_calls 块中解析出工具调用（name + arguments JSON） */
function parseDsmlToolCalls(dsml: string): Array<{ name: string; args: string }> {
  const results: Array<{ name: string; args: string }> = [];
  const invokeRe = /<｜DSML｜invoke\s+name="([^"]*)">([\s\S]*?)<\/｜DSML｜invoke>/g;
  let m: RegExpExecArray | null;
  while ((m = invokeRe.exec(dsml)) !== null) {
    const name = m[1];
    const body = m[2];
    const params: Record<string, string> = {};
    const paramRe = /<｜DSML｜parameter\s+name="([^"]*)"(?:\s+[^>]*)?>([\s\S]*?)<\/｜DSML｜parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(body)) !== null) {
      params[pm[1]] = pm[2];
    }
    results.push({ name, args: JSON.stringify(params) });
  }
  return results;
}

/**
 * 非流式：从 content 中剥离 DSML 标记，返回干净文本与解析出的工具调用。
 * content 不含 DSML 时原样返回（零开销）。
 */
function stripDsml(content: string): { clean: string; toolCalls: ToolCall[] } {
  if (!content.includes('｜DSML｜')) return { clean: content, toolCalls: [] };
  const parsed = parseDsmlToolCalls(content);
  const toolCalls: ToolCall[] = parsed.map((p, i) => ({
    id: `call_dsml_${i}`,
    type: 'function',
    function: { name: p.name, arguments: p.args },
  }));
  // 移除所有 DSML 块及散落的 DSML 标签
  const clean = content
    .replace(/<｜DSML｜tool_calls>[\s\S]*?<\/｜DSML｜tool_calls>/g, '')
    .replace(/<｜DSML｜[^>]*>/g, '')
    .replace(/<\/｜DSML｜[^>]*>/g, '')
    .trim();
  return { clean, toolCalls };
}

/** 检查字符串末尾是否是 '<｜DSML｜' 的前缀，返回需暂扣的字符数 */
function dsmlPartialPrefixLen(s: string): number {
  const marker = DSML_OPEN;
  const max = Math.min(s.length, marker.length);
  for (let i = max; i >= 1; i--) {
    if (s.endsWith(marker.slice(0, i))) return i;
  }
  return 0;
}

/** Files API 文件对象（OpenAI 兼容格式，purpose 当前固定为 user_data） */
export interface AiFileObject {
  id: string;
  object: 'file';
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  /** 仅在上传时设置了过期时间才出现（Unix 秒） */
  expires_at?: number;
}

export interface UploadFileOptions {
  filename: string;
  contentType?: string;
  /** 文件字节（须为独立 ArrayBuffer 的 Uint8Array，见 Blob 构造约束） */
  data: Uint8Array<ArrayBuffer>;
  /** 有效期（秒），3600-2592000；不传则永久有效 */
  expiresAfterSeconds?: number;
}

/**
 * OpenAI 兼容 chat/completions 客户端。
 * 通过 baseURL 可对接 DeepSeek / OpenAI / 智谱 / Ollama(OpenAI 兼容端口) 等。
 */
export class AiProvider {
  constructor(
    private readonly cfg: AiConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.cfg.enabled && this.cfg.apiKey.trim() !== '';
  }

  private ensureEnabled(): void {
    if (!this.enabled) {
      throw new Error('AI 未配置：请在设置中填写 API Key 并开启（或导出数据包后手动喂给任意 AI）');
    }
  }

  /** Files API 统一请求：Bearer 头 + 超时 + 错误友好化。path 形如 '' | '?limit=5' | '/:fileId' */
  private async filesRequest<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.fetchFn(`${filesUrl(this.cfg.baseURL)}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        // Content-Type 由 fetch 依据 FormData 自动设置（含 multipart boundary），不可手动覆盖
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw friendlyHttpError(res.status, text);
    }
    return (await res.json()) as T;
  }

  /**
   * 上传文件到 Files API（multipart/form-data），返回文件对象。
   * purpose 固定 user_data（DeepSeek 当前唯一取值）；file_id 可在对话补全中以 file 内容块引用。
   */
  async uploadFile(opts: UploadFileOptions): Promise<AiFileObject> {
    this.ensureEnabled();
    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob([opts.data], { type: opts.contentType || 'application/octet-stream' }), opts.filename);
    if (opts.expiresAfterSeconds !== undefined) {
      form.append('expires_after[anchor]', 'created_at');
      form.append('expires_after[seconds]', String(opts.expiresAfterSeconds));
    }
    return this.filesRequest('', { method: 'POST', body: form });
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    this.ensureEnabled();
    const timeoutMs = this.cfg.timeoutMs ?? 120000;
    const maxTokens = opts.maxTokens ?? 393216;
    const buildInit = (limit: number): RequestInit => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: limit,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      }),
    });
    let res: Response;
    let limit = maxTokens;
    for (;;) {
      try {
        res = await fetchWithRetry(this.fetchFn, chatUrl(this.cfg.baseURL), buildInit(limit), timeoutMs, opts.signal);
        break;
      } catch (e) {
        // 聚合网关按 max_tokens 路由模型时，超大 max_tokens 会把所有模型排除在外 → 沿阶梯降级重试
        const next = nextMaxTokensLimit(limit);
        if (next !== null && isMaxTokensRoutingError((e as Error).message ?? '')) {
          limit = next;
        } else {
          throw e;
        }
      }
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; tool_calls?: ToolCall[]; reasoning_content?: string; reasoning?: string };
        finish_reason?: string | null;
      }>;
      usage?: TokenUsage;
    };
    const choice = data.choices?.[0];
    const rawContent = choice?.message?.content;
    let toolCalls = choice?.message?.tool_calls;

    // 推理内容（DeepSeek-R1 用 reasoning_content，OpenRouter 风格网关用 reasoning）
    const reasoningText = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
    if (reasoningText) {
      opts.onReasoning?.(reasoningText);
    }

    // token 用量
    if (data.usage) {
      opts.onUsage?.(data.usage);
    }

    // 部分聚合网关会把完整推理文本重复一份塞进 content（reasoning 与正文完全同文），
    // 剥离开头与推理重复的部分，避免思考过程混进正文
    let cleanContent = rawContent;
    if (typeof cleanContent === 'string' && reasoningText && cleanContent.startsWith(reasoningText)) {
      cleanContent = cleanContent.slice(reasoningText.length);
    }

    // DeepSeek 有时将工具调用以 DSML 标记泄漏到 content 中，需剥离并解析为结构化 tool_calls
    if (typeof cleanContent === 'string' && cleanContent.includes('｜DSML｜')) {
      const stripped = stripDsml(cleanContent);
      cleanContent = stripped.clean;
      if (stripped.toolCalls.length > 0 && (!toolCalls || toolCalls.length === 0)) {
        toolCalls = stripped.toolCalls;
      }
    }

    const finishReason = toolCalls && toolCalls.length > 0 ? 'tool_calls' : (choice?.finish_reason ?? null);
    opts.onFinish?.(finishReason, toolCalls);
    if (toolCalls && toolCalls.length > 0) {
      // 工具调用时 content 可能为空，返回占位符避免上层判空报错
      return cleanContent ?? '';
    }
    if (!cleanContent || cleanContent.trim() === '') {
      throw new Error('AI API 返回空内容');
    }
    return cleanContent;
  }

  /**
   * 流式对话：逐 delta yield content 片段。
   * 使用 OpenAI 兼容的 SSE stream 协议（stream: true）。
   * 调用方通过 for-await-of 消费每个 delta 字符串。
   * 若 AI 发起 tool_calls，content delta 不再 yield（工具参数在内部累积，通过 onFinish 回传）。
   * 推理内容（reasoning_content）通过 opts.onReasoning 回调传出，不混入 content delta。
   * token 用量通过 opts.onUsage 回调传出（需 stream_options.include_usage 支持）。
   */
  async *chatStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string, void, void> {
    this.ensureEnabled();
    const timeoutMs = this.cfg.timeoutMs ?? 120000;
    // 流式请求：超时只约束「建立连接 + 等待响应头」；流式读取阶段不受 timeoutMs 限制
    // （AI 生成回复可能耗时数分钟，不应被超时中断；仅受调用方 signal 控制）
    // 实现注意：fetch 的 signal 会同时作用于响应体读取，AbortSignal.timeout 组合进去
    // 会在流中途触发超时掐断输出（实际线上 bug），因此用手动 timer + 独立 controller
    const connectController = new AbortController();
    const onCallerAbort = () => connectController.abort();
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const connectTimer = setTimeout(
      () => connectController.abort(new DOMException(`AI 连接超时（${Math.ceil(timeoutMs / 1000)}s 内未收到响应头）`, 'TimeoutError')),
      timeoutMs,
    );
    const maxTokens = opts.maxTokens ?? 393216;
    const buildBody = (limit: number): string =>
      JSON.stringify({
        model: this.cfg.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: limit,
        stream: true,
        // 请求 token 用量统计（OpenAI/DeepSeek 支持；不支持的 API 会忽略此字段，不影响兼容性）
        stream_options: { include_usage: true },
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      });
    let limit = maxTokens;
    let res: Response;
    try {
      for (;;) {
        res = await this.fetchFn(chatUrl(this.cfg.baseURL), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`,
          },
          body: buildBody(limit),
          signal: connectController.signal,
        });
        if (res.ok) break;
        const text = await res.text().catch(() => '');
        // 聚合网关按 max_tokens 路由模型时，超大 max_tokens 会把所有模型排除在外 → 沿阶梯降级重试
        const next = nextMaxTokensLimit(limit);
        if (next !== null && isMaxTokensRoutingError(`HTTP ${res.status}: ${text}`)) {
          limit = next;
          continue;
        }
        // 连接阶段可重试的错误（429/5xx）：由上层重试逻辑处理
        // 这里直接抛出友好化错误，非流式 chat() 的重试已覆盖此场景
        throw friendlyHttpError(res.status, text);
      }
    } finally {
      // 响应头已到达（或连接最终失败）：关闭连接超时计时器，正文读取只受调用方中断控制
      clearTimeout(connectTimer);
    }
    if (!res.body) throw new Error('AI API 未返回流式响应体');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: string | null = null;
    /** 按 index 累积 tool_calls 片段（流式 delta 分片到达） */
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();

    // DSML 过滤状态：contentBuf 暂存未 yield 的文本，dsmlMode 标记是否在 DSML 块内
    let contentBuf = '';
    let dsmlMode = false;
    // parseDsmlTools 为 false 时不解析 DSML 标记（二轮流式用，避免 DeepSeek 误触发 tool_calls）
    const enableDsml = opts.parseDsmlTools !== false;

    // 思考重复门控：部分聚合网关会把完整推理文本再重复一份塞进 content。
    // 推理先行流完，正文 delta 一到就与已积累的推理文本比对——开头一致的部分剥离，
    // 出现分歧后恢复正常流式；整个 content 都是推理前缀时（生成被截断的极端情况）
    // 在流结束处兜底冲刷。reasoningText 为空（无思考模型）时零开销。
    let reasoningText = '';
    let dupDecided = false;
    /** 剥离 contentBuf 开头与推理重复的部分。返回 true 表示整个 buffer 仍是推理前缀，需继续暂扣 */
    const stripDupPrefix = (): boolean => {
      const max = Math.min(contentBuf.length, reasoningText.length);
      let k = 0;
      while (k < max && contentBuf[k] === reasoningText[k]) k++;
      if (k === contentBuf.length && contentBuf.length <= reasoningText.length) return true;
      if (k > 0) contentBuf = contentBuf.slice(k);
      return false;
    };

    /** 将 DSML tool_calls 块解析为工具调用并写入累积 Map */
    const flushDsmlBlock = (block: string): void => {
      const parsed = parseDsmlToolCalls(block);
      for (const p of parsed) {
        const idx = toolCallAccum.size;
        toolCallAccum.set(idx, { id: `call_dsml_${idx}`, name: p.name, args: p.args });
      }
    };

    /** 处理 contentBuf：正常文本 yield，DSML 块缓冲（enableDsml=true 解析为 tool_calls，false 丢弃） */
    const processContentBuf = function* (): Generator<string, void, void> {
      while (contentBuf) {
        if (dsmlMode) {
          // DSML 模式：寻找闭合标签
          const endIdx = contentBuf.indexOf(DSML_TOOL_CALLS_END);
          if (endIdx !== -1) {
            // enableDsml=true：解析为 tool_calls；false：静默丢弃（不 yield 不解析）
            if (enableDsml) {
              flushDsmlBlock(contentBuf.slice(0, endIdx + DSML_TOOL_CALLS_END.length));
            }
            contentBuf = contentBuf.slice(endIdx + DSML_TOOL_CALLS_END.length);
            dsmlMode = false;
            continue;
          }
          // 闭合标签未到，继续缓冲（不 yield）
          break;
        }
        // 正常模式：检测 DSML 开标记
        const dsmlIdx = contentBuf.indexOf(DSML_OPEN);
        if (dsmlIdx !== -1) {
          if (dsmlIdx > 0) yield contentBuf.slice(0, dsmlIdx);
          contentBuf = contentBuf.slice(dsmlIdx);
          dsmlMode = true;
          continue;
        }
        // 无 DSML：检查末尾是否有 DSML 开标记的前缀（如孤立 '<'），暂扣以防下一段是 DSML
        const hold = dsmlPartialPrefixLen(contentBuf);
        if (hold > 0) {
          const yieldLen = contentBuf.length - hold;
          if (yieldLen > 0) {
            yield contentBuf.slice(0, yieldLen);
            contentBuf = contentBuf.slice(yieldLen);
          }
          break; // 保留前缀字符，等下一段 delta 判定
        }
        // 全部安全，清空并 yield
        yield contentBuf;
        contentBuf = '';
        break;
      }
    };

    // 空闲看门狗：每收到一段数据就重置；长时间没有数据即掐断（见 STREAM_STALL_TIMEOUT_MS 注释）
    const stallMs = opts.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStall = (): void => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const armStall = (): void => {
      clearStall();
      stallTimer = setTimeout(() => {
        connectController.abort(
          new DOMException(`AI 响应中断（${Math.ceil(stallMs / 1000)}s 内未收到任何数据）`, 'TimeoutError'),
        );
      }, stallMs);
    };

    try {
      for (;;) {
        armStall();
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } finally {
          clearStall();
        }
        if (chunk.done) break;
        const value = chunk.value;
        buffer += decoder.decode(value, { stream: true });

        // SSE 帧以双换行分隔，逐帧解析
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = frame.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            // 流结束：冲刷剩余的正常文本（DSML 模式下未闭合的残片丢弃，不 yield）
            if (!dsmlMode && contentBuf) {
              for (const s of processContentBuf()) yield s;
            }
            if (toolCallAccum.size > 0 && finishReason !== 'tool_calls') {
              finishReason = 'tool_calls';
            }
            opts.onFinish?.(finishReason, accumToToolCalls(toolCallAccum));
            return;
          }
          try {
            const obj = JSON.parse(payload) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  reasoning?: string;
                  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
                };
                finish_reason?: string | null;
              }>;
              usage?: TokenUsage;
            };
            const choice = obj.choices?.[0];
            const delta = choice?.delta;
            // 推理内容（思维链）：DeepSeek 用 reasoning_content，OpenRouter 风格网关用 reasoning
            const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
            if (reasoningDelta) {
              reasoningText += reasoningDelta;
              opts.onReasoning?.(reasoningDelta);
            }
            // content delta：先入缓冲；若网关把推理文本重复进了正文开头，剥离后再 yield
            if (delta?.content) {
              contentBuf += delta.content;
              let gated = false;
              if (!dupDecided && reasoningText && contentBuf) {
                gated = stripDupPrefix();
                if (!gated) dupDecided = true; // 已出现分歧，之后正文正常流式
              }
              if (!gated) {
                for (const s of processContentBuf()) yield s;
              }
            }
            // tool_calls delta：按 index 累积 id/name/arguments 片段
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = toolCallAccum.get(tc.index);
                if (existing) {
                  if (tc.function?.arguments) existing.args += tc.function.arguments;
                } else {
                  toolCallAccum.set(tc.index, {
                    id: tc.id ?? '',
                    name: tc.function?.name ?? '',
                    args: tc.function?.arguments ?? '',
                  });
                }
              }
            }
            // 捕获 finish_reason（"stop"=正常结束，"length"=截断，"tool_calls"=请求工具调用）
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            // 捕获 token 用量（通常在最后一个 choices:[] 的帧中）
            if (obj.usage) {
              opts.onUsage?.(obj.usage);
            }
          } catch {
            // 单帧解析失败跳过（部分实现会发心跳注释行）
          }
        }
      }
    } finally {
      clearStall();
      reader.releaseLock();
      // 流结束后移除调用方中断监听（用户点「停止」时 controller 已 abort，这里兜底防泄漏）
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }
    // 流自然结束（未收到 [DONE]）：同样冲刷剩余文本
    if (!dsmlMode && contentBuf) {
      for (const s of processContentBuf()) yield s;
    }
    if (toolCallAccum.size > 0 && finishReason !== 'tool_calls') {
      finishReason = 'tool_calls';
    }
    opts.onFinish?.(finishReason, accumToToolCalls(toolCallAccum));
  }
}

/** 将按 index 累积的 tool_calls 片段组装为 ToolCall[] */
function accumToToolCalls(accum: Map<number, { id: string; name: string; args: string }>): ToolCall[] {
  if (accum.size === 0) return [];
  const result: ToolCall[] = [];
  for (const [, v] of accum) {
    if (v.name) {
      result.push({
        id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: v.name, arguments: v.args || '{}' },
      });
    }
  }
  return result;
}
