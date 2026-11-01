/**
 * sessionFiles.load 脏数据容错回归。
 *
 * localStorage 可能被旧版本/手工改库写入脏值（如 {"sid":null}）。旧实现直接
 * Object.entries(files) 遇到 null 抛 TypeError，而调用点在 send() 的 try 之外，
 * 异常变成未处理 rejection——消息发不出且无提示。修复后逐层校验、脏条目跳过。
 *
 * 本文件在 import 前就把脏数据写进 localStorage，确保首次 load 命中脏值
 * （node:test 每文件独立进程，模块级 cache 是全新的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const KEY = 'icpc-ai-session-files-v1'
const store = new Map<string, string>()
store.set(
  KEY,
  JSON.stringify({
    good: { f1: '正文A' },
    nullFiles: null, // 曾让 Object.entries(null) 抛错
    strFiles: 'not-an-object',
    arrFiles: ['x'],
    badValue: { f2: 123, f3: '正文B' }, // 非字符串值跳过，合法值保留
  }),
)
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

const { getSessionFileText, rememberSessionFiles } = await import('../src/pages/sessionFiles.ts')

test('load 遇脏数据不抛错：合法条目保留，非法结构跳过', () => {
  assert.equal(getSessionFileText('good', 'f1'), '正文A')
  assert.equal(getSessionFileText('nullFiles', 'x'), undefined)
  assert.equal(getSessionFileText('strFiles', 'x'), undefined)
  assert.equal(getSessionFileText('arrFiles', '0'), undefined)
  assert.equal(getSessionFileText('badValue', 'f2'), undefined, '非字符串值应跳过')
  assert.equal(getSessionFileText('badValue', 'f3'), '正文B', '同会话内的合法值仍保留')
})

test('脏数据加载后仍可正常记忆新附件（不阻断发送）', () => {
  assert.doesNotThrow(() => rememberSessionFiles('good', [{ fileId: 'f4', textContent: '新正文' }]))
  assert.equal(getSessionFileText('good', 'f4'), '新正文')
})