/**
 * 更新检查节流：24 小时（成功）/ 30 分钟（失败）两种间隔必须各自生效。
 *
 * 回归背景：旧实现只用一个「上次检查时刻」判定，且判定恒用 30 分钟的重试间隔，
 * 24 小时常量从未参与比较 —— 成功检查后 30 分钟重开应用就会再打一次上游，
 * 与「应用打开时 24 小时检查一次」的承诺不符。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  nextUpdateCheckAt,
  shouldCheckUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RETRY_INTERVAL_MS,
} from '../src/updateThrottle.ts'

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0)

describe('更新检查节流', () => {
  it('成功 → 节流 24 小时；第 30 分钟仍被拦住（旧实现会放行）', () => {
    const stamp = String(nextUpdateCheckAt(T0, true))
    assert.equal(shouldCheckUpdate(T0 + UPDATE_RETRY_INTERVAL_MS, stamp), false, '30 分钟后不得再检查')
    assert.equal(shouldCheckUpdate(T0 + 60 * 60 * 1000, stamp), false, '1 小时后不得再检查')
    assert.equal(shouldCheckUpdate(T0 + UPDATE_CHECK_INTERVAL_MS - 1, stamp), false)
  })

  it('成功 → 24 小时后放行', () => {
    const stamp = String(nextUpdateCheckAt(T0, true))
    assert.equal(shouldCheckUpdate(T0 + UPDATE_CHECK_INTERVAL_MS, stamp), true)
  })

  it('失败 → 30 分钟后即可重试，但不早于 30 分钟', () => {
    const stamp = String(nextUpdateCheckAt(T0, false))
    assert.equal(shouldCheckUpdate(T0 + UPDATE_RETRY_INTERVAL_MS - 1, stamp), false)
    assert.equal(shouldCheckUpdate(T0 + UPDATE_RETRY_INTERVAL_MS, stamp), true)
  })

  it('读不出 / 非法值 / 旧格式（过去时刻）一律视为可检查', () => {
    assert.equal(shouldCheckUpdate(T0, null), true)
    assert.equal(shouldCheckUpdate(T0, ''), true)
    assert.equal(shouldCheckUpdate(T0, 'not-a-number'), true)
    // 旧版本写的是「上次检查时刻」，必然是过去 → 升级后最多多检查一次即自愈
    assert.equal(shouldCheckUpdate(T0, String(T0 - 1000)), true)
  })

  it('本地时钟回拨：未到点仍然拦住，不会因为时钟倒退而反复请求', () => {
    const stamp = String(nextUpdateCheckAt(T0, true))
    assert.equal(shouldCheckUpdate(T0 - 5 * 60 * 1000, stamp), false)
  })
})
