/**
 * sessionFiles.ts（会话级附件内容缓存）单元测试。
 * 验证：记忆/取回、会话隔离、删除清理、容量淘汰（LRU）与超大文件跳过。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// node:test 无 DOM/localStorage：注入内存实现
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

// 动态 import 在 stub 注入后执行（模块级 cache 变量按首次 load 初始化）
const { rememberSessionFiles, getSessionFileText, forgetSessionFiles } = await import(
  '../src/pages/sessionFiles.ts'
)

describe('sessionFiles 附件内容缓存', () => {
  beforeEach(() => {
    store.clear()
    forgetSessionFiles('s1')
    forgetSessionFiles('s2')
    forgetSessionFiles('s3')
  })

  it('记忆后任意轮次可取回全文', () => {
    rememberSessionFiles('s1', [{ fileId: 'doc-1', textContent: '题目：A+B' }])
    assert.equal(getSessionFileText('s1', 'doc-1'), '题目：A+B')
    // 覆盖更新
    rememberSessionFiles('s1', [{ fileId: 'doc-1', textContent: '题目：A+B（v2）' }])
    assert.equal(getSessionFileText('s1', 'doc-1'), '题目：A+B（v2）')
  })

  it('会话之间隔离，删除会话后清理', () => {
    rememberSessionFiles('s1', [{ fileId: 'f1', textContent: 'A' }])
    rememberSessionFiles('s2', [{ fileId: 'f1', textContent: 'B' }])
    assert.equal(getSessionFileText('s1', 'f1'), 'A')
    assert.equal(getSessionFileText('s2', 'f1'), 'B')
    forgetSessionFiles('s1')
    assert.equal(getSessionFileText('s1', 'f1'), undefined)
    assert.equal(getSessionFileText('s2', 'f1'), 'B')
  })

  it('无 textContent 或空文本的附件不缓存', () => {
    rememberSessionFiles('s1', [{ fileId: 'img-1' }, { fileId: 'doc-2', textContent: '' }])
    assert.equal(getSessionFileText('s1', 'img-1'), undefined)
    assert.equal(getSessionFileText('s1', 'doc-2'), undefined)
  })

  it('超出总容量时优先淘汰最旧会话，当前会话保留', () => {
    // 构造超过 256KB 总量的三个会话：s1 最旧、s3 最新
    const big = 'x'.repeat(120 * 1024) // 单文件 120KB（低于单文件上限）
    rememberSessionFiles('s1', [{ fileId: 'a', textContent: big }])
    rememberSessionFiles('s2', [{ fileId: 'b', textContent: big }])
    // s3 触发总量超限（120×3 = 360KB > 256KB）：s1 应被淘汰
    rememberSessionFiles('s3', [{ fileId: 'c', textContent: big }])
    assert.equal(getSessionFileText('s1', 'a'), undefined, '最旧会话应被淘汰')
    assert.equal(getSessionFileText('s2', 'b'), big)
    assert.equal(getSessionFileText('s3', 'c'), big, '当前（最新）会话保留')
  })

  it('超大单文件不进缓存（发送轮仍带全文，后续轮次退化为文件名占位）', () => {
    const huge = 'y'.repeat(121 * 1024)
    rememberSessionFiles('s1', [{ fileId: 'big', textContent: huge }])
    assert.equal(getSessionFileText('s1', 'big'), undefined)
  })
})
