import type { ChatMessage } from './provider.ts';

/**
 * 粗略估算 token 数：中英混合内容按每 2 字符约 1 token 估算。
 * 对中文偏保守（实际约 1.5 字/token），对英文偏高估（实际约 4 字/token），
 * 宁可多裁一点也不超限触发 API 报错。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
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
