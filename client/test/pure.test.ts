/**
 * api.ts / ui.ts 纯函数单元测试。
 * 用 node:test 运行（Node 22 内置，无需额外依赖）。
 * api.ts 的 fetch 逻辑用全局 stub 验证错误提取行为。
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { difficultyColor, rateColor, tagColor, platformName } from '../src/ui.ts'

// ---------- ui.ts 纯展示函数 ----------

describe('ui.ts', () => {
  describe('difficultyColor', () => {
    it('returns gray for null/undefined', () => {
      assert.equal(difficultyColor(null), '#8993a2')
      assert.equal(difficultyColor(undefined), '#8993a2')
    })
    it('maps rating ranges to CF-style colors', () => {
      assert.equal(difficultyColor(800), '#aab6c2')   // new
      assert.equal(difficultyColor(1200), '#55d990')  // pupil (boundary)
      assert.equal(difficultyColor(1399), '#55d990')  // pupil (just under)
      assert.equal(difficultyColor(1400), '#45d5e5')  // specialist
      assert.equal(difficultyColor(1899), '#58a3ff')  // expert
      assert.equal(difficultyColor(1900), '#a887ff')  // candidate master
      assert.equal(difficultyColor(2399), '#ffbd61')  // master
      assert.equal(difficultyColor(2400), '#ff5d70')  // grandmaster+
    })
  })

  describe('rateColor', () => {
    it('returns green for high AC rate', () => {
      assert.equal(rateColor(55), '#69d7a5')
      assert.equal(rateColor(90), '#69d7a5')
    })
    it('returns yellow for medium AC rate', () => {
      assert.equal(rateColor(40), '#f2c46d')
      assert.equal(rateColor(54.9), '#f2c46d')
    })
    it('returns red for low AC rate', () => {
      assert.equal(rateColor(0), '#ff7b84')
      assert.equal(rateColor(39.9), '#ff7b84')
    })
  })

  describe('tagColor', () => {
    it('is deterministic — same tag always same color', () => {
      assert.equal(tagColor('dp'), tagColor('dp'))
      assert.equal(tagColor('greedy'), tagColor('greedy'))
    })
    it('different tags can map to different colors', () => {
      const colors = new Set(['dp', 'greedy', 'math', 'graphs', 'dfs'].map(tagColor))
      assert.ok(colors.size > 1, 'expected at least 2 distinct colors')
    })
  })

  describe('platformName', () => {
    it('returns display name for known platforms', () => {
      assert.equal(platformName('codeforces'), 'Codeforces')
      assert.equal(platformName('luogu'), '洛谷')
    })
    it('falls back to id for unknown platform', () => {
      assert.equal(platformName('unknown' as never), 'unknown')
    })
  })
})

// ---------- api.ts fetch 封装 ----------

describe('api.ts', () => {
  const origFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = origFetch
  })

  it('returns parsed JSON on success', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, data: 42 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch

    const { api } = await import('../src/api.ts')
    const result = await api<{ ok: boolean; data: number }>('/test')
    assert.equal(result.ok, true)
    assert.equal(result.data, 42)
  })

  it('extracts error message from JSON body on failure', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'handle 必填' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch

    const { api } = await import('../src/api.ts')
    await assert.rejects(
      () => api('/test'),
      (err: Error) => err.message === 'handle 必填',
    )
  })

  it('falls back to HTTP status when body is not JSON', async () => {
    globalThis.fetch = (async () =>
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      })) as typeof fetch

    const { api } = await import('../src/api.ts')
    await assert.rejects(
      () => api('/test'),
      (err: Error) => err.message === 'HTTP 500',
    )
  })
})
