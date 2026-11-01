/**
 * chatStore.createNewSession 淘汰逻辑回归。
 *
 * 旧写法 `unpinned.pop()` 先弹出再判断 victim 是否活跃会话：一旦最旧的未置顶会话
 * 正是当前打开的会话，它已被弹出数组，消息随之静默丢失（且 break 后计数仍可能超限）。
 * 修复后：先定位最旧的「非活跃」会话再移除，绝不淘汰活跃会话。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// node:test 无 DOM/localStorage：注入内存实现（chatStore 及其依赖在模块级读写它）
const store = new Map<string, string>()
const localStorageStub: Storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  get length() {
    return store.size
  },
}
;(globalThis as Record<string, unknown>).localStorage = localStorageStub

const chatStore = await import('../src/pages/chatStore.ts')
const { setChatState, createNewSession, createSession, MAX_SESSIONS } = chatStore

// s0 最新 … s{n-1} 最旧（createNewSession 把新会话插到最前）
const mk = (id: string, pinned = false) => {
  const s = createSession()
  s.id = id
  s.pinned = pinned
  return s
}
const seed = (sessions: ReturnType<typeof mk>[], activeId: string) =>
  setChatState(() => ({ sessions, activeId, input: '', sendingIds: new Set() }))
// chatState 是 export let：必须经命名空间实时读取（解构会拿到导入时的旧引用）
const ids = () => chatStore.chatState.sessions.map((s) => s.id)

describe('createNewSession 容量淘汰', () => {
  beforeEach(() => {
    store.clear()
  })

  it('最旧未置顶会话正是活跃会话时，不得把它淘汰（修复前消息静默丢失）', () => {
    const sessions = Array.from({ length: MAX_SESSIONS }, (_, i) => mk(`s${i}`))
    seed(sessions, `s${MAX_SESSIONS - 1}`) // 活跃 = 最旧
    createNewSession()
    assert.ok(ids().includes(`s${MAX_SESSIONS - 1}`), '活跃会话必须保留')
    assert.ok(!ids().includes(`s${MAX_SESSIONS - 2}`), '应改淘汰最旧的非活跃会话')
    assert.ok(ids().length <= MAX_SESSIONS, `总数不应超上限，实际 ${ids().length}`)
    assert.equal(chatStore.chatState.activeId, ids()[0], '新会话成为活跃会话')
  })

  it('活跃会话在中间时，仍从最旧的非活跃会话开始淘汰', () => {
    const sessions = Array.from({ length: MAX_SESSIONS }, (_, i) => mk(`s${i}`))
    seed(sessions, 's10')
    createNewSession()
    assert.ok(ids().includes('s10'), '活跃会话保留')
    assert.ok(!ids().includes(`s${MAX_SESSIONS - 1}`), '最旧非活跃被淘汰')
    assert.ok(ids().length <= MAX_SESSIONS)
  })

  it('置顶会话永远保留，淘汰只发生在未置顶组', () => {
    const pinned = Array.from({ length: 5 }, (_, i) => mk(`p${i}`, true))
    const unpinned = Array.from({ length: MAX_SESSIONS - 5 }, (_, i) => mk(`u${i}`))
    seed([...pinned, ...unpinned], `u${unpinned.length - 1}`) // 活跃 = 最旧未置顶
    createNewSession()
    for (const p of pinned) assert.ok(ids().includes(p.id), `置顶 ${p.id} 必须保留`)
    assert.ok(ids().includes(`u${unpinned.length - 1}`), '活跃未置顶会话保留')
    assert.ok(!ids().includes(`u${unpinned.length - 2}`), '淘汰最旧的非活跃未置顶会话')
  })

  it('未置顶组只剩活跃会话时宁可暂超上限也不丢数据', () => {
    const pinned = Array.from({ length: MAX_SESSIONS - 1 }, (_, i) => mk(`p${i}`, true))
    seed([...pinned, mk('only')], 'only')
    createNewSession()
    assert.ok(ids().includes('only'), '唯一未置顶且活跃的会话不得被淘汰')
  })

  it('未达上限时不淘汰任何会话', () => {
    const sessions = Array.from({ length: 3 }, (_, i) => mk(`s${i}`))
    seed(sessions, 's2')
    createNewSession()
    for (const s of sessions) assert.ok(ids().includes(s.id))
    assert.equal(ids().length, 4)
  })
})