/**
 * AI 助手会话状态栏（对齐 ZCode 风格）的纯逻辑：
 *
 * - 「N 轮 · M 消息 · X tok/s」：轮数/消息数从历史推导，tok/s 优先用
 *   上一轮的真实值（usage.completion_tokens ÷ 实测生成时长），流式进行中用
 *   近 3 秒采样窗口估算（token 数拿不到精确值，按字符数折算）。
 * - 「Y tok · 缓存命中 Z%」：累计 usage 求和；缓存命中 = Σcached / Σprompt，
 *   上游（DeepSeek / OpenAI 等）没回 prompt_tokens_details.cached_tokens 时不算。
 * - 「上下文 C%」：最后一轮 prompt_tokens ÷ 上下文窗口（与设置页 AI 配置同一来源）。
 *
 * 纯逻辑、无 React/DOM 依赖，便于单测。
 */

/** 参与「会话统计」的最小消息形态（与 Assistant 的 ChatMsg 结构兼容） */
export interface UsageBearingTurn {
  role: 'user' | 'assistant'
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  /** 本轮流式生成实测时长（首 delta → 末 delta，毫秒）；缺省 = 无法折算 tok/s */
  durationMs?: number
}

/** 流式速率估算的字符→token 折算系数：中英混排 + 代码块的经验值（仅估算用，完成即换成真实值） */
export const CHARS_PER_TOKEN = 3.5

/** 活跃采样窗口长度（毫秒）：只统计近这段时间的字符，老样本滑出窗口 */
const SPEED_WINDOW_MS = 3_000

/**
 * 单轮流式速率采样器：每次 delta 到达时记一笔 (时间, 字符数)，
 * tok/s = 窗口内字符数 ÷ 窗口秒数 ÷ CHARS_PER_TOKEN。
 * 同时记录首/末 delta 时刻，供 finalize() 得出整轮实测时长（配 usage 算真实 tok/s）。
 */
export class SpeedTracker {
  private samples: Array<{ t: number; chars: number }> = []
  private firstDeltaAt = 0
  private lastDeltaAt = 0

  /** 记录一段增量（正文或思维链都算——模型确实生成了这些 token） */
  push(chars: number): void {
    if (chars <= 0) return
    const now = Date.now()
    if (this.firstDeltaAt === 0) this.firstDeltaAt = now
    this.lastDeltaAt = now
    this.samples.push({ t: now, chars })
    // 窗口滑除：留一点余量给整轮时长计算，samples 只服务速率估算
    while (this.samples.length > 0 && now - this.samples[0]!.t > SPEED_WINDOW_MS * 2) {
      this.samples.shift()
    }
  }

  /** 近窗口的估算 tok/s；还没有样本时返回 null（界面据此不显示速度段） */
  liveTokPerSec(): number | null {
    const now = Date.now()
    const cutoff = now - SPEED_WINDOW_MS
    let chars = 0
    let span = 0
    for (const s of this.samples) {
      if (s.t < cutoff) continue
      chars += s.chars
      span = Math.max(span, now - s.t)
    }
    if (chars <= 0) return null
    // span 至少 250ms：刚推了一小段就除以 0.01s 会给出夸张的速度
    const seconds = Math.max(span, 250) / 1000
    return chars / seconds / CHARS_PER_TOKEN
  }

  /** 整轮实测生成时长（首 delta → 末 delta，毫秒）；单帧流给 250ms 下限防除零 */
  finalizeDurationMs(): number {
    if (this.firstDeltaAt === 0) return 0
    return Math.max(this.lastDeltaAt - this.firstDeltaAt, 250)
  }
}

/** 会话状态栏聚合结果（数值缺省 = 无数据，界面按段隐藏） */
export interface SessionStats {
  /** 轮数 = user 消息条数 */
  rounds: number
  /** 消息总数（user + assistant） */
  msgCount: number
  /** 累计 token（Σ usage.total_tokens，缺 total 时按 prompt+completion 补） */
  totalTokens: number
  /** 缓存命中率 0-1；上游未返回 cached_tokens 时为 null */
  cacheHit: number | null
  /** 最后一轮的输入 token（上下文占用的分子）；无 usage 时为 null */
  lastPromptTokens: number | null
  /** 上一轮真实 tok/s（completion_tokens ÷ durationMs）；无实测时长时为 null */
  lastTokPerSec: number | null
}

export function aggregateSessionStats(messages: UsageBearingTurn[]): SessionStats {
  let rounds = 0
  let totalTokens = 0
  let cachedTokens = 0
  let cachedPromptDenom = 0
  let lastPromptTokens: number | null = null
  let lastTokPerSec: number | null = null
  for (const m of messages) {
    if (m.role === 'user') rounds++
    const u = m.usage
    if (!u) continue
    const prompt = Math.max(0, u.prompt_tokens ?? 0)
    const completion = Math.max(0, u.completion_tokens ?? 0)
    totalTokens += Math.max(0, u.total_tokens ?? prompt + completion)
    const cached = u.prompt_tokens_details?.cached_tokens
    if (typeof cached === 'number' && Number.isFinite(cached) && prompt > 0) {
      // 分母只取「网关确实返回了明细」的轮次：中途才开始返回时，拿全部轮次当分母会把命中率压低成假象
      cachedPromptDenom += prompt
      cachedTokens += Math.min(Math.max(0, cached), prompt)
    }
    lastPromptTokens = prompt
    if (typeof u.completion_tokens === 'number' && (m.durationMs ?? 0) > 0) {
      lastTokPerSec = completion / (m.durationMs! / 1000)
    }
  }
  return {
    rounds,
    msgCount: messages.length,
    totalTokens,
    cacheHit: cachedPromptDenom > 0 ? cachedTokens / cachedPromptDenom : null,
    lastPromptTokens,
    lastTokPerSec,
  }
}

/** 上下文占用百分比（0-100，一位小数截尾）；窗口未知或无 usage 时返回 null */
export function contextPercent(
  lastPromptTokens: number | null,
  contextWindow: number | undefined,
): number | null {
  if (lastPromptTokens === null || !Number.isFinite(lastPromptTokens)) return null
  const win = contextWindow && contextWindow > 0 ? contextWindow : 0
  if (win <= 0) return null
  return Math.min(100, Math.floor((lastPromptTokens / win) * 1000) / 10)
}

/** token 数格式化：999 以内原样，1 万内带分隔，更大按 K / M 一位小数（对齐 ZCode 的 44.2M 风格） */
export function fmtTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(2)}K`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** tok/s 显示值：整数化并夹到合理区间（估算毛刺不放大到界面） */
export function fmtTokPerSec(v: number | null): string | null {
  if (v === null || !Number.isFinite(v) || v <= 0) return null
  return String(Math.round(v))
}
