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

// ---------- aiBlocks.ts：template-add 块（AI 模板库写入建议） ----------

describe('aiBlocks.ts template-add', () => {
  const block = [
    '讲解正文',
    '```template-add',
    JSON.stringify({
      categoryKey: 'dp',
      name: '斜率优化 DP',
      difficulty: 4,
      tags: ['DP', '优化'],
      code: 'for (int j = 1; j <= n; j++) { ... }',
      idea: '决策单调性 + 凸壳',
      complexity: 'O(n)',
      url: 'https://www.luogu.com.cn/problem/P3195',
    }),
    '```',
  ].join('\n')

  it('extracts full draft from a template-add block', async () => {
    const { extractTemplateAdd } = await import('../src/aiBlocks.ts')
    const d = extractTemplateAdd(block)
    assert.ok(d)
    assert.equal(d.categoryKey, 'dp')
    assert.equal(d.name, '斜率优化 DP')
    assert.equal(d.difficulty, 4)
    assert.deepEqual(d.tags, ['DP', '优化'])
    assert.equal(d.idea, '决策单调性 + 凸壳')
    assert.equal(d.url, 'https://www.luogu.com.cn/problem/P3195')
  })

  it('fills defaults for optional fields and rejects missing name', async () => {
    const { extractTemplateAdd } = await import('../src/aiBlocks.ts')
    const minimal = extractTemplateAdd('```template-add\n{"name":"A*","categoryKey":"search"}\n```')
    assert.ok(minimal)
    assert.equal(minimal.difficulty, 3) // 缺省难度兜底 3
    assert.deepEqual(minimal.tags, [])
    assert.equal(minimal.code, '')

    assert.equal(extractTemplateAdd('```template-add\n{"code":"x"}\n```'), null) // 缺 name
    assert.equal(extractTemplateAdd('```template-add\n{not json}\n```'), null) // 非法 JSON
    assert.equal(extractTemplateAdd('没有块的回复'), null)
  })

  it('strips the block from visible text and tolerates json-fenced variant', async () => {
    const { extractTemplateAdd, stripTemplateAdd } = await import('../src/aiBlocks.ts')
    assert.equal(stripTemplateAdd(block), '讲解正文')

    const variant = '前文\n```json template-add\n{"name":"T","categoryKey":"ds"}\n```\n后文'
    assert.ok(extractTemplateAdd(variant))
    assert.equal(stripTemplateAdd(variant), '前文\n\n后文') // 块剥离后两端换行保留，Markdown 渲染时折叠
  })
})
