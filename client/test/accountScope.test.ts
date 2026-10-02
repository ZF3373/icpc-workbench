/**
 * accountScope.ts 纯逻辑单元测试（node:test 运行）。
 * 覆盖：脏值归一（account 必须与 platform 成对）、URL 拼接、切换器可见性、
 * localStorage 读写与「全部账号」时清键。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL_ACCOUNTS,
  isAllAccounts,
  normalizeScope,
  pickerVisible,
  readScope,
  withScope,
  writeScope,
} from '../src/accountScope'

/** 最小 localStorage 替身（模块在函数内取用，测试可随时替换） */
function stubStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  }
  return store
}

describe('normalizeScope', () => {
  it('接受合法 platform + account 成对值', () => {
    assert.deepEqual(normalizeScope({ platform: 'codeforces', account: 'hieZF123' }), {
      platform: 'codeforces',
      account: 'hieZF123',
    })
  })

  it('account 缺 platform 时整体回退全部账号（服务端对半截作用域 400）', () => {
    assert.deepEqual(normalizeScope({ account: 'main' }), {})
    assert.deepEqual(normalizeScope({ platform: 'codeforces' }), {})
    assert.deepEqual(normalizeScope({ platform: 'codeforces', account: '' }), {})
  })

  it('脏值（未知平台 / 非对象 / account 非字符串）一律回退全部账号', () => {
    assert.deepEqual(normalizeScope({ platform: 'notaplatform', account: 'x' }), {})
    assert.deepEqual(normalizeScope(null), {})
    assert.deepEqual(normalizeScope('codeforces'), {})
    assert.deepEqual(normalizeScope({ platform: 'luogu', account: 123 }), {})
  })
})

describe('withScope', () => {
  it('全部账号时不改 URL', () => {
    assert.equal(withScope('/api/stats', ALL_ACCOUNTS), '/api/stats')
    assert.equal(withScope('/api/stats/trend?weeks=12', {}), '/api/stats/trend?weeks=12')
  })

  it('有作用域时按 ? / & 正确追加', () => {
    const scope = { platform: 'codeforces' as const, account: 'main' }
    assert.equal(withScope('/api/stats', scope), '/api/stats?platform=codeforces&account=main')
    assert.equal(
      withScope('/api/stats/heatmap?days=90', scope),
      '/api/stats/heatmap?days=90&platform=codeforces&account=main',
    )
  })

  it('handle 里的特殊字符按 URL 编码（服务端 query 解析后仍是原值）', () => {
    const scope = { platform: 'codeforces' as const, account: 'a b&c=d' }
    assert.equal(
      withScope('/api/stats', scope),
      '/api/stats?platform=codeforces&account=a%20b%26c%3Dd',
    )
  })
})

describe('isAllAccounts / pickerVisible', () => {
  it('半截作用域也算「全部」，避免拼出服务端会拒绝的请求', () => {
    assert.equal(isAllAccounts({ account: 'main' }), true)
    assert.equal(isAllAccounts({ platform: 'luogu' }), true)
    assert.equal(isAllAccounts({ platform: 'luogu', account: '1892580' }), false)
  })

  it('0 或 1 个账号不显示切换器（没有可比对象）', () => {
    assert.equal(pickerVisible([]), false)
    assert.equal(pickerVisible([{ platform: 'codeforces', account: 'main' }]), false)
    assert.equal(
      pickerVisible([
        { platform: 'codeforces', account: 'main' },
        { platform: 'codeforces', account: 'alt' },
      ]),
      true,
    )
  })
})

describe('readScope / writeScope', () => {
  beforeEach(() => stubStorage())

  it('写入具体账号、读回归一后的作用域', () => {
    writeScope({ platform: 'nowcoder', account: '713093328' })
    assert.deepEqual(readScope(), { platform: 'nowcoder', account: '713093328' })
  })

  it('切回全部账号时清掉键，不留脏值', () => {
    writeScope({ platform: 'nowcoder', account: '713093328' })
    writeScope(ALL_ACCOUNTS)
    assert.equal(readScope().platform, undefined)
  })

  it('localStorage 里是坏 JSON 时回退全部账号而不是抛错', () => {
    ;(globalThis as { localStorage?: { setItem: (k: string, v: string) => void } }).localStorage!
      .setItem('icpc-account-scope-v1', '{坏掉的存档')
    assert.deepEqual(readScope(), {})
  })
})
