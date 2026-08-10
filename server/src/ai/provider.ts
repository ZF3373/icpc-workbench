import type { AiConfig } from '../config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

function chatUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
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
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI API HTTP ${res.status}: ${text.slice(0, 200)}`);
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
}
