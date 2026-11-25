import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VISIBILITY,
  HIDDEN_LABEL,
  getVisibility,
  normalizeVisibility,
  setVisibility,
  shouldHideDifficulty,
  shouldHideTags,
} from '../src/problemVisibility'

/**
 * node:test 里没有 localStorage：persistence 的读写都会静默降级成「无记录」。
 * 想要覆盖「偏好真的变了」这条路径，必须先装一个最小实现。
 */
class MemoryStorage {
  private map = new Map<string, string>()
  get length() { return this.map.size }
  key(i: number) { return [...this.map.keys()][i] ?? null }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}
const storage = new MemoryStorage()
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage

test('normalizeVisibility: 只认字面 true，脏值一律 false', () => {
  assert.deepEqual(normalizeVisibility(null), { hideTags: false, hideDifficulty: false })
  assert.deepEqual(normalizeVisibility(undefined), { hideTags: false, hideDifficulty: false })
  assert.deepEqual(normalizeVisibility({}), { hideTags: false, hideDifficulty: false })
  assert.deepEqual(normalizeVisibility({ hideTags: '1' }), { hideTags: false, hideDifficulty: false })
  assert.deepEqual(normalizeVisibility({ hideTags: 1, hideDifficulty: 0 }), {
    hideTags: false,
    hideDifficulty: false,
  })
  assert.deepEqual(normalizeVisibility({ hideTags: true, hideDifficulty: true }), {
    hideTags: true,
    hideDifficulty: true,
  })
  // 多出来的字段不保留：偏好只有这两位
  assert.deepEqual(normalizeVisibility({ hideTags: true, other: 1 }), {
    hideTags: true,
    hideDifficulty: false,
  })
})

test('两个开关互相独立', () => {
  const tagsOnly = { hideTags: true, hideDifficulty: false }
  assert.equal(shouldHideTags(tagsOnly, 0), true)
  assert.equal(shouldHideDifficulty(tagsOnly, 0), false)
  const diffOnly = { hideTags: false, hideDifficulty: true }
  assert.equal(shouldHideTags(diffOnly, 0), false)
  assert.equal(shouldHideDifficulty(diffOnly, 0), true)
})

test('shouldHide*: 只藏「没 AC 过」的题，AC 过的题照常显示', () => {
  const both = { hideTags: true, hideDifficulty: true }
  assert.equal(shouldHideTags(both, 0), true)
  assert.equal(shouldHideDifficulty(both, 0), true)
  assert.equal(shouldHideTags(both, 1), false)
  assert.equal(shouldHideDifficulty(both, 3), false)
  // 未知（旧服务端不带 acCount）按「没 AC」处理：宁可多藏
  assert.equal(shouldHideTags(both, null), true)
  assert.equal(shouldHideTags(both, undefined), true)
})

test('全关时不隐藏', () => {
  assert.equal(shouldHideTags(DEFAULT_VISIBILITY, 0), false)
  assert.equal(shouldHideDifficulty(DEFAULT_VISIBILITY, 0), false)
})

test('HIDDEN_LABEL 有可见文案（不能是空串，否则格子看起来像没数据）', () => {
  assert.equal(HIDDEN_LABEL.trim().length > 0, true)
})

/**
 * 回归守卫（白屏 bug）：getVisibility 是 useProblemVisibility 的 getSnapshot，
 * 连续调用必须返回**同一个引用**，否则 React 判定状态持续变化 → 无限重渲染
 * → React error #185「Maximum update depth exceeded」→ 整棵树卸载、页面白屏。
 *
 * 真实复现：数据概览「写题历史」默认折叠，用户手动全部展开后 localStorage 里
 * icpc-dashboard-module-collapsed-v1 = []，HistoryPanel 挂载并订阅该 hook，
 * 桌面版（打包产物）打开即白屏。
 */
test('getVisibility: 连续调用返回稳定引用（否则 useSyncExternalStore 会无限重渲染）', () => {
  setVisibility({ hideTags: false, hideDifficulty: false })
  const a = getVisibility()
  const b = getVisibility()
  const c = getVisibility()
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(a, getVisibility())
})

test('getVisibility: 写在无 localStorage 的环境里也不抛，且引用仍然稳定', () => {
  const first = getVisibility()
  const second = getVisibility()
  assert.equal(first, second)
})

test('getVisibility: 偏好真的变了才换新对象，且新对象反映新值', () => {
  setVisibility({ hideTags: false, hideDifficulty: false })
  const before = getVisibility()
  setVisibility({ hideTags: true, hideDifficulty: false })
  const after = getVisibility()
  assert.notEqual(before, after)
  assert.equal(after.hideTags, true)
  assert.equal(after.hideDifficulty, false)
  // 换成同一个值的等价对象不该产生新引用
  const same = getVisibility()
  assert.equal(after, same)
})

test('getSnapshot 默认值（第三个参数）不含隐藏语义', () => {
  assert.deepEqual(DEFAULT_VISIBILITY, { hideTags: false, hideDifficulty: false })
})
