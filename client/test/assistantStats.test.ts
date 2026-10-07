/**
 * AI 助手会话状态栏的纯逻辑：用量聚合、缓存命中率、上下文占用百分比、
 * token 数格式化与流式速率采样（对齐 ZCode 状态栏：N 轮 M 消息 · X tok/s · Y tok 缓存命中 Z% · 上下文 C%）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateSessionStats,
  contextPercent,
  fmtTokenCount,
  fmtTokPerSec,
  SpeedTracker,
  type UsageBearingTurn,
} from '../src/pages/assistantStats.ts'

function msg(partial: Partial<UsageBearingTurn> & { role: 'user' | 'assistant' }): UsageBearingTurn {
  return partial
}

test('aggregateSessionStats: 轮数只数 user 消息，消息数含双方', () => {
  const s = aggregateSessionStats([
    msg({ role: 'user' }),
    msg({ role: 'assistant' }),
    msg({ role: 'user' }),
    msg({ role: 'assistant' }),
    msg({ role: 'assistant' }),
  ])
  assert.equal(s.rounds, 2)
  assert.equal(s.msgCount, 5)
})

test('aggregateSessionStats: 累计 token 求和；缺 total 时按 prompt+completion 补', () => {
  const s = aggregateSessionStats([
    msg({ role: 'user' }),
    msg({ role: 'assistant', usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
    msg({ role: 'assistant', usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 } }),
    msg({ role: 'assistant', usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  ])
  assert.equal(s.totalTokens, 150 + 260 + 15)
})

test('aggregateSessionStats: 缓存命中 = Σcached ÷ Σ(返回过明细的轮次 prompt)', () => {
  const s = aggregateSessionStats([
    msg({ role: 'user' }),
    msg({
      role: 'assistant',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 10,
        total_tokens: 1010,
        prompt_tokens_details: { cached_tokens: 990 },
      },
    }),
    // 网关中途才开始返回明细：这轮不进分母，否则命中率被压低成假象
    msg({ role: 'assistant', usage: { prompt_tokens: 5000, completion_tokens: 10, total_tokens: 5010 } }),
  ])
  assert.equal(s.cacheHit, 0.99)
})

test('aggregateSessionStats: 无 cached_tokens 明细时命中率为 null（不编造 0%）', () => {
  const s = aggregateSessionStats([
    msg({ role: 'user' }),
    msg({ role: 'assistant', usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }),
  ])
  assert.equal(s.cacheHit, null)
})

test('aggregateSessionStats: cached 超过 prompt 的异常值被夹住', () => {
  const s = aggregateSessionStats([
    msg({
      role: 'assistant',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 0,
        total_tokens: 100,
        prompt_tokens_details: { cached_tokens: 5000 },
      },
    }),
  ])
  assert.equal(s.cacheHit, 1)
})

test('aggregateSessionStats: 上一轮 tok/s = completion ÷ durationMs（秒）', () => {
  const s = aggregateSessionStats([
    msg({ role: 'user' }),
    msg({ role: 'assistant', usage: { prompt_tokens: 10, completion_tokens: 300, total_tokens: 310 }, durationMs: 1500 }),
  ])
  assert.equal(s.lastTokPerSec, 200)
})

test('aggregateSessionStats: 没有 usage/durationMs 的会话各统计段为空值', () => {
  const s = aggregateSessionStats([msg({ role: 'user' }), msg({ role: 'assistant' })])
  assert.equal(s.totalTokens, 0)
  assert.equal(s.cacheHit, null)
  assert.equal(s.lastPromptTokens, null)
  assert.equal(s.lastTokPerSec, null)
})

test('contextPercent: prompt ÷ 窗口，一位小数向下截；窗口未知/无 usage 返回 null', () => {
  assert.equal(contextPercent(360000, 1024000), 35.1)
  assert.equal(contextPercent(1024000, 1024000), 100)
  assert.equal(contextPercent(2_000_000, 1024000), 100) // 超限夹到 100
  assert.equal(contextPercent(100, undefined), null)
  assert.equal(contextPercent(null, 1024000), null)
  assert.equal(contextPercent(100, 0), null)
})

test('fmtTokenCount: 对齐 ZCode 的 44.2M 风格', () => {
  assert.equal(fmtTokenCount(0), '0')
  assert.equal(fmtTokenCount(999), '999')
  assert.equal(fmtTokenCount(4420), '4.42K')
  assert.equal(fmtTokenCount(44200), '44.2K')
  assert.equal(fmtTokenCount(44_200_000), '44.2M')
  assert.equal(fmtTokenCount(-5), '0')
})

test('fmtTokPerSec: 非法/非正值不显示，正常值取整', () => {
  assert.equal(fmtTokPerSec(null), null)
  assert.equal(fmtTokPerSec(0), null)
  assert.equal(fmtTokPerSec(-3), null)
  assert.equal(fmtTokPerSec(NaN), null)
  assert.equal(fmtTokPerSec(253.4), '253')
})

test('SpeedTracker: 采样窗口内的估算 tok/s；finalize 给出整轮时长', async () => {
  const t = new SpeedTracker()
  assert.equal(t.liveTokPerSec(), null) // 还没有样本
  assert.equal(t.finalizeDurationMs(), 0) // 没有任何 delta
  t.push(350)
  const v = t.liveTokPerSec()
  assert.ok(v !== null && v > 0, '采样后应给出正的估算速度')
  // 单帧流时长被 250ms 下限夹住，tok/s 不出现除零爆炸
  const dur = t.finalizeDurationMs()
  assert.ok(dur >= 250, `时长下限 250ms，实际 ${dur}`)
})

test('SpeedTracker: 零字符增量不计入样本（空正文推思维链之外的帧不污染速度）', () => {
  const t = new SpeedTracker()
  t.push(0)
  assert.equal(t.liveTokPerSec(), null)
  assert.equal(t.finalizeDurationMs(), 0)
})
