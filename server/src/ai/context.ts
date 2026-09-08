import type { ChatContentBlock, ChatMessage } from './provider.ts';
import type { AiProvider } from './provider.ts';

/**
 * 粗略估算 token 数：中英混合内容按每 2 字符约 1 token 估算。
 * 对中文偏保守（实际约 1.5 字/token），对英文偏高估（实际约 4 字/token），
 * 宁可多裁一点也不超限触发 API 报错。
 *
 * 多模态内容块（file / image_url）的实际 token 开销随文件内容变化，
 * 按固定值保守估算，保证带附件的对话更早触发裁剪而不是超限报错。
 */
const FILE_BLOCK_TOKENS = 1024;

export function estimateTokens(content: string | ChatContentBlock[]): number {
  if (typeof content === 'string') return Math.ceil(content.length / 2);
  let total = 0;
  for (const b of content) {
    if (b.type === 'text') total += Math.ceil(b.text.length / 2);
    else total += FILE_BLOCK_TOKENS;
  }
  return total;
}

export interface TrimResult {
  /** 裁剪后保留的消息（不含 system，仅 user/assistant 轮次） */
  messages: ChatMessage[];
  /** 被裁掉的消息条数 */
  trimmed: number;
}

/**
 * 按模型上下文窗口裁剪对话历史：保留 system 提示 + 最近能放下的消息，
 * 从最早的消息开始丢弃。budget = contextWindow - maxTokens - systemTokens。
 *
 * - budget ≤ 0（system+输出预留已超窗口）：仅保留最后一条消息，尽量降低超限风险
 * - 正常情况：从最新消息往前累计 token，超 budget 处截断
 * - 截断后若首条是 assistant 消息则一并丢弃（部分 API 拒绝以 assistant 开头）
 */
export function trimContext(
  systemTokens: number,
  messages: ChatMessage[],
  contextWindow: number,
  maxTokens: number,
): TrimResult {
  const budget = contextWindow - maxTokens - systemTokens;

  // system + 输出预留已超出窗口：保留最后一条，尽量不触发 API 超限错误
  if (budget <= 0) {
    if (messages.length <= 1) return { messages, trimmed: 0 };
    return { messages: messages.slice(-1), trimmed: messages.length - 1 };
  }

  // 从最新消息往前累计 token，找到可保留的最早位置
  let used = 0;
  let keepFrom = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    used += estimateTokens(messages[i].content);
    if (used > budget) {
      keepFrom = i + 1;
      break;
    }
  }

  if (keepFrom === 0) return { messages, trimmed: 0 };

  let trimmed = keepFrom;
  let result = messages.slice(keepFrom);
  // 避免以 assistant 消息开头（部分模型/API 会报错）
  while (result.length > 1 && result[0].role === 'assistant') {
    result = result.slice(1);
    trimmed++;
  }
  return { messages: result, trimmed };
}

// ---------- 上下文自动摘要 ----------
// 参考 opencode 的 Auto Compact 机制：被裁剪的消息不直接丢弃，而是生成摘要注入对话，
// 保留用户的关键信息（能力水平、弱项、训练目标、已讨论的结论）。
// 仅当被裁消息较多时才值得摘要（少量裁剪直接丢弃更高效）。

/** 触发摘要的被裁消息阈值：少于此数直接丢弃不值得摘要开销 */
export const SUMMARIZE_THRESHOLD = 6;

/** 摘要提示词：压缩被裁对话历史为一段紧凑摘要 */
const SUMMARIZE_PROMPT = `请将以下对话历史压缩为一段简洁摘要，保留用户的关键信息（能力水平、弱项、训练目标、已讨论的结论、已应用的能力值调整）。不超过 300 字。仅输出摘要正文，不要前缀标签。

对话历史：`;

/** 将被裁剪的消息转换为可读文本（供摘要提示词使用） */
function messagesToText(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role;
      const text = typeof m.content === 'string' ? m.content : '';
      return `[${role}] ${text}`;
    })
    .join('\n\n');
}

/**
 * 对被裁剪的消息生成摘要，用于替代直接丢弃。
 * 摘要失败时返回 null，调用方降级为直接丢弃（不阻断对话）。
 *
 * @param provider AI provider 实例（用非流式 chat 生成摘要）
 * @param droppedMessages 被裁剪的消息列表
 * @param timeoutMs 摘要请求超时（默认 30 秒，比正常对话短）
 */
export async function summarizeContext(
  provider: Pick<AiProvider, 'chat' | 'enabled'>,
  droppedMessages: ChatMessage[],
  timeoutMs = 30_000,
): Promise<string | null> {
  if (droppedMessages.length === 0) return null;
  if (!provider.enabled) return null;

  try {
    const conversationText = messagesToText(droppedMessages);
    const summary = await provider.chat(
      [
        { role: 'system', content: SUMMARIZE_PROMPT },
        { role: 'user', content: conversationText },
      ],
      {
        temperature: 0.1,
        maxTokens: 512,
        // 摘要请求使用独立的较短超时，避免长时间阻塞对话
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return summary.trim() || null;
  } catch {
    // 摘要生成失败：降级为直接丢弃，不阻断对话
    return null;
  }
}
