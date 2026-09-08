import type { AiConfig } from '../config.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
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
}

/** baseURL → chat/completions 端点：容忍用户直接粘贴完整端点地址 */
export function chatUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
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

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    if (!this.enabled) {
      throw new Error('AI 未配置：请在设置中填写 API Key 并开启（或导出数据包后手动喂给任意 AI）');
    }
    const res = await this.fetchFn(chatUrl(this.cfg.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 8192,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw friendlyHttpError(res.status, text);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] }; finish_reason?: string | null }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const toolCalls = choice?.message?.tool_calls;
    opts.onFinish?.(choice?.finish_reason ?? null, toolCalls);
    if (toolCalls && toolCalls.length > 0) {
      // 工具调用时 content 可能为空，返回占位符避免上层判空报错
      return content ?? '';
    }
    if (!content || content.trim() === '') {
      throw new Error('AI API 返回空内容');
    }
    return content;
  }

  /**
   * 流式对话：逐 delta yield content 片段。
   * 使用 OpenAI 兼容的 SSE stream 协议（stream: true）。
   * 调用方通过 for-await-of 消费每个 delta 字符串。
   * 若 AI 发起 tool_calls，content delta 不再 yield（工具参数在内部累积，通过 onFinish 回传）。
   */
  async *chatStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<string, void, void> {
    if (!this.enabled) {
      throw new Error('AI 未配置：请在设置中填写 API Key 并开启（或导出数据包后手动喂给任意 AI）');
    }
    const res = await this.fetchFn(chatUrl(this.cfg.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 8192,
        stream: true,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw friendlyHttpError(res.status, text);
    }
    if (!res.body) throw new Error('AI API 未返回流式响应体');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason: string | null = null;
    /** 按 index 累积 tool_calls 片段（流式 delta 分片到达） */
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
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
            opts.onFinish?.(finishReason, accumToToolCalls(toolCallAccum));
            return;
          }
          try {
            const obj = JSON.parse(payload) as {
              choices?: Array<{
                delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
                finish_reason?: string | null;
              }>;
            };
            const choice = obj.choices?.[0];
            const delta = choice?.delta;
            // content delta 正常 yield 给调用方
            if (delta?.content) yield delta.content;
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
          } catch {
            // 单帧解析失败跳过（部分实现会发心跳注释行）
          }
        }
      }
    } finally {
      reader.releaseLock();
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
