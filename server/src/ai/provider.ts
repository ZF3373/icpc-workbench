import type { AiConfig } from '../config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
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
        max_tokens: opts.maxTokens ?? 4000,
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw friendlyHttpError(res.status, text);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content || content.trim() === '') {
      throw new Error('AI API 返回空内容');
    }
    return content;
  }

  /**
   * 流式对话：逐 delta yield content 片段。
   * 使用 OpenAI 兼容的 SSE stream 协议（stream: true）。
   * 调用方通过 for-await-of 消费每个 delta 字符串。
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
        max_tokens: opts.maxTokens ?? 4000,
        stream: true,
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
          if (payload === '[DONE]') return;
          try {
            const obj = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = obj.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // 单帧解析失败跳过（部分实现会发心跳注释行）
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
