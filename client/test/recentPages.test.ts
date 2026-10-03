/**
 * recentPages.ts 纯逻辑单元测试（node:test 运行）。
 * 「最近访问」是命令面板的第一个分组：顺序必须新→旧、去重、有上限，
 * 并且 localStorage 里是脏数据时不能抛错（隐私模式 / 用户手改存档）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_RECENT,
  clearRecentPages,
  loadRecentPages,
  mergeRecent,
  pushRecentPage,
} from '../src/recentPages'

const STORAGE_KEY = 'icpc-recent-pages-v1'

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  return store
}

describe('mergeRecent（纯函数）', () => {
  it('新访问排在最前', () => {
    assert.deepEqual(mergeRecent(['/a', '/b'], '/c'), ['/c', '/a', '/b'])
  })

  it('重复访问提到最前而不是出现两次', () => {
    assert.deepEqual(mergeRecent(['/a', '/b', '/c'], '/c'), ['/c', '/a', '/b'])
  })

  it('超过上限时截断最旧的', () => {
    const existing = Array.from({ length: MAX_RECENT }, (_, i) => `/p${i}`)
    const next = mergeRecent(existing, '/new')
    assert.equal(next.length, MAX_RECENT)
    assert.equal(next[0], '/new')
    assert.ok(!next.includes(`/p${MAX_RECENT - 1}`), '最旧的一项应被挤出')
  })

  it('空 key 不写入', () => {
    assert.deepEqual(mergeRecent(['/a'], ''), ['/a'])
  })
})

describe('pushRecentPage / loadRecentPages', () => {
  beforeEach(() => stubStorage())
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('无存档时返回空数组', () => {
    assert.deepEqual(loadRecentPages(), [])
  })

  it('连续访问的顺序是新→旧', () => {
    pushRecentPage('/today')
    pushRecentPage('/problems')
    pushRecentPage('/today')
    assert.deepEqual(loadRecentPages(), ['/today', '/problems'])
  })

  it('clearRecentPages 清空', () => {
    pushRecentPage('/today')
    clearRecentPages()
    assert.deepEqual(loadRecentPages(), [])
  })

  it('坏 JSON / 非数组 / 含非字符串项时回退，不抛错', () => {
    const store = stubStorage()
    store.set(STORAGE_KEY, '{坏掉的存档')
    assert.deepEqual(loadRecentPages(), [])
    store.set(STORAGE_KEY, '{"not":"array"}')
    assert.deepEqual(loadRecentPages(), [])
    store.set(STORAGE_KEY, '["/a", 123, null, "/b"]')
    assert.deepEqual(loadRecentPages(), ['/a', '/b'])
  })

  it('localStorage 不可用时读写都不抛错（隐私模式）', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }
    assert.deepEqual(loadRecentPages(), [])
    assert.doesNotThrow(() => pushRecentPage('/today'))
    assert.doesNotThrow(() => clearRecentPages())
  })
})
