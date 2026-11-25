/**
 * 全 store 快照稳定性守卫。
 *
 * 背景（白屏 bug）：`problemVisibility.getVisibility` 是 useSyncExternalStore 的
 * getSnapshot，却每次调用都新建对象。React 用 Object.is 比引用，于是「取快照 → 判定变了
 * → 重渲染 → 再取快照」死循环，直到 React error #185「Maximum update depth exceeded」
 * 把整棵树卸载 —— 用户看到的是一片白屏。
 *
 * 这类 bug 的特征：**纯函数单测全绿、typecheck 全绿、打包也成功**，只有真正有人
 * 订阅那个 hook 时才炸。所以这里不测业务语义，只钉住唯一的硬约束：
 * 同一个 getSnapshot 连续调用，在底层数据没变时必须返回**同一个引用**。
 *
 * 新增 store 时请把它的 getSnapshot 加进下面的表里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 这些 store 都直接读 localStorage。node:test 里没有它，readJson 会静默降级成
 * 「无记录」—— 那正好是「什么都没变」的状态，足以验证引用稳定性。
 * 仍然装一个最小实现，让「值确实变了」的路径也能覆盖到。
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
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })

interface SnapshotCase {
  /** store 名，失败时直接指出是哪个 */
  name: string
  /** 取快照（动态 import，保证上面的 localStorage 桩先就位） */
  get: () => Promise<() => unknown>
  /** 改写底层数据（可选）：用来验证「真的变了必须换新引用」 */
  mutate?: () => Promise<void>
}

const CASES: SnapshotCase[] = [
  {
    name: 'problemVisibility.getVisibility',
    get: async () => (await import('../src/problemVisibility')).getVisibility,
    mutate: async () => {
      const m = await import('../src/problemVisibility')
      m.setVisibility({ hideTags: true, hideDifficulty: true })
    },
  },
  {
    name: 'recentPages.getRecentPagesSnapshot',
    get: async () => (await import('../src/recentPages')).getRecentPagesSnapshot,
  },
  {
    name: 'chatStore.getChatViewSnapshot',
    get: async () => (await import('../src/pages/chatStore')).getChatViewSnapshot,
  },
  {
    name: 'zoomPreferences.getZoomPreferences',
    get: async () => (await import('../src/zoomPreferences')).getZoomPreferences,
  },
]

for (const c of CASES) {
  test(`${c.name}: 连续调用返回稳定引用（useSyncExternalStore 的硬约束）`, async () => {
    const snap = await c.get()
    const a = snap()
    const b = snap()
    const d = snap()
    assert.equal(a, b, `${c.name} 第二次调用换了引用：每次新建对象会让 React 死循环直到 #185 白屏`)
    assert.equal(b, d, `${c.name} 第三次调用换了引用`)
  })
}

test('problemVisibility.getVisibility: 偏好真的写入后才换引用，且新值可见', async () => {
  const m = await import('../src/problemVisibility')
  m.setVisibility({ hideTags: false, hideDifficulty: false })
  const before = m.getVisibility()
  // 同值重写不该产生新引用
  m.setVisibility({ hideTags: false, hideDifficulty: false })
  assert.equal(m.getVisibility(), before, '写成相同的值不该换引用')

  m.setVisibility({ hideTags: true, hideDifficulty: true })
  const after = m.getVisibility()
  assert.notEqual(after, before, '偏好真的变了必须换新引用，否则界面不更新')
  assert.equal(after.hideTags, true)
  assert.equal(after.hideDifficulty, true)
})
