/**
 * api.ts / ui.ts 纯函数单元测试。
 * 用 node:test 运行（Node 22 内置，无需额外依赖）。
 * api.ts 的 fetch 逻辑用全局 stub 验证错误提取行为。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  difficultyColor,
  difficultyTone,
  gapColor,
  rateColor,
  rateTone,
  tagColor,
  platformName,
  toneVar,
} from '../src/ui.ts'
import { assembleCookie, buildCookieItem, mergeCookieFields, splitCookieFields, type CookieFieldDef } from '../src/cookies.ts'

// ---------- ui.ts 纯展示函数 ----------

describe('ui.ts', () => {
  describe('difficultyTone / difficultyColor', () => {
    it('returns unknown for null/undefined', () => {
      assert.equal(difficultyTone(null), 'unknown')
      assert.equal(difficultyTone(undefined), 'unknown')
      assert.equal(difficultyColor(null), 'var(--text-3)')
      assert.equal(difficultyColor(undefined), 'var(--text-3)')
    })
    it('maps rating ranges to CF-style tones (boundaries)', () => {
      assert.equal(difficultyTone(800), 'new')
      assert.equal(difficultyTone(1200), 'pupil') // pupil (boundary)
      assert.equal(difficultyTone(1399), 'pupil') // pupil (just under)
      assert.equal(difficultyTone(1400), 'specialist')
      assert.equal(difficultyTone(1899), 'expert')
      assert.equal(difficultyTone(1900), 'candidate-master')
      assert.equal(difficultyTone(2399), 'master')
      assert.equal(difficultyTone(2400), 'grandmaster')
    })
    it('resolves every tone to a CSS variable, never a hex', () => {
      const tones = [null, 800, 1200, 1400, 1600, 1900, 2100, 2400] as const
      for (const d of tones) {
        const value = difficultyColor(d)
        assert.match(value, /^var\(--[a-z0-9-]+\)$/, `difficultyColor(${String(d)}) = ${value}`)
      }
    })
  })

  describe('rateTone / rateColor', () => {
    it('returns good tone for high AC rate', () => {
      assert.equal(rateTone(55), 'good')
      assert.equal(rateTone(90), 'good')
      assert.equal(rateColor(55), 'var(--green)')
    })
    it('returns fair tone for medium AC rate', () => {
      assert.equal(rateTone(40), 'fair')
      assert.equal(rateTone(54.9), 'fair')
      assert.equal(rateColor(40), 'var(--amber)')
    })
    it('returns poor tone for low AC rate', () => {
      assert.equal(rateTone(0), 'poor')
      assert.equal(rateTone(39.9), 'poor')
      assert.equal(rateColor(0), 'var(--red)')
    })
  })

  describe('gapColor', () => {
    it('三段语义色：明显偏弱 / 偏弱 / 不弱', () => {
      assert.equal(gapColor(20), toneVar('danger'))
      assert.equal(gapColor(16), toneVar('danger'))
      assert.equal(gapColor(15), toneVar('warning')) // 边界：>15 才算明显偏弱
      assert.equal(gapColor(6), toneVar('warning'))
      assert.equal(gapColor(5), toneVar('success')) // 边界：>5 才算偏弱
      assert.equal(gapColor(0), toneVar('success'))
      assert.equal(gapColor(-12), toneVar('success'))
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
    assert.equal(d.length, 1)
    assert.equal(d[0]!.categoryKey, 'dp')
    assert.equal(d[0]!.name, '斜率优化 DP')
    assert.equal(d[0]!.difficulty, 4)
    assert.deepEqual(d[0]!.tags, ['DP', '优化'])
    assert.equal(d[0]!.idea, '决策单调性 + 凸壳')
    assert.equal(d[0]!.url, 'https://www.luogu.com.cn/problem/P3195')
  })

  it('fills defaults for optional fields and rejects missing name', async () => {
    const { extractTemplateAdd } = await import('../src/aiBlocks.ts')
    const minimal = extractTemplateAdd('```template-add\n{"name":"A*","categoryKey":"search"}\n```')
    assert.ok(minimal)
    assert.equal(minimal[0]!.difficulty, 3) // 缺省难度兜底 3
    assert.deepEqual(minimal[0]!.tags, [])
    assert.equal(minimal[0]!.code, '')

    assert.deepEqual(extractTemplateAdd('```template-add\n{"code":"x"}\n```'), []) // 缺 name
    assert.deepEqual(extractTemplateAdd('```template-add\n{not json}\n```'), []) // 非法 JSON
    assert.deepEqual(extractTemplateAdd('没有块的回复'), [])
  })

  it('extracts multiple template-add blocks in one reply', async () => {
    const { extractTemplateAdd, stripTemplateAdd } = await import('../src/aiBlocks.ts')
    const multi = [
      '按分类整理一批模板：',
      '```template-add',
      JSON.stringify({ categoryKey: 'graph', name: 'Dijkstra', difficulty: 2, code: 'dij()' }),
      '```',
      '```template-add',
      JSON.stringify({ categoryKey: 'ds', name: '并查集', difficulty: 1, code: 'uf()' }),
      '```',
      '```template-add',
      JSON.stringify({ categoryKey: 'dp', name: '背包 DP', difficulty: 3, code: 'knapsack()' }),
      '```',
      '讲解结束',
    ].join('\n')
    const drafts = extractTemplateAdd(multi)
    assert.equal(drafts.length, 3)
    assert.equal(drafts[0]!.name, 'Dijkstra')
    assert.equal(drafts[1]!.name, '并查集')
    assert.equal(drafts[2]!.name, '背包 DP')
    // 全部块都被剥离
    assert.equal(stripTemplateAdd(multi), '按分类整理一批模板：\n\n\n\n讲解结束')
  })

  it('skips invalid blocks but keeps valid ones when mixed', async () => {
    const { extractTemplateAdd } = await import('../src/aiBlocks.ts')
    const mixed = [
      '```template-add',
      '{not json}',
      '```',
      '```template-add',
      JSON.stringify({ name: '有效模板', categoryKey: 'search' }),
      '```',
    ].join('\n')
    const drafts = extractTemplateAdd(mixed)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.name, '有效模板')
  })

  it('strips the block from visible text and tolerates json-fenced variant', async () => {
    const { extractTemplateAdd, stripTemplateAdd } = await import('../src/aiBlocks.ts')
    assert.equal(stripTemplateAdd(block), '讲解正文')

    const variant = '前文\n```json template-add\n{"name":"T","categoryKey":"ds"}\n```\n后文'
    assert.equal(extractTemplateAdd(variant).length, 1)
    assert.equal(stripTemplateAdd(variant), '前文\n\n后文') // 块剥离后两端换行保留，Markdown 渲染时折叠
  })
})

// ---------- editorSettings.ts：缩进偏好（localStorage） ----------

describe('editorSettings.ts', () => {
  // Node 无全局 localStorage，测试内挂一个内存实现
  const store = new Map<string, string>()
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }

  beforeEach(() => {
    store.clear()
    ;(globalThis as { localStorage: unknown }).localStorage = stub
  })
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('normalizeIndent only accepts 2 or 4, else 2', async () => {
    const { normalizeIndent } = await import('../src/editorSettings.ts')
    assert.equal(normalizeIndent(2), 2)
    assert.equal(normalizeIndent(4), 4)
    assert.equal(normalizeIndent(3), 2)
    assert.equal(normalizeIndent(0), 2)
    assert.equal(normalizeIndent(null), 2)
    assert.equal(normalizeIndent(undefined), 2)
    assert.equal(normalizeIndent('4'), 4)
    assert.equal(normalizeIndent('2'), 2)
    assert.equal(normalizeIndent('garbage'), 2)
  })

  it('getIndentSize defaults to 2 when unset or invalid', async () => {
    const { getIndentSize, INDENT_KEY } = await import('../src/editorSettings.ts')
    assert.equal(getIndentSize(), 2) // 未设置
    store.set(INDENT_KEY, 'bogus')
    assert.equal(getIndentSize(), 2) // 非法值回退
    store.set(INDENT_KEY, '3')
    assert.equal(getIndentSize(), 2) // 非 2/4 回退
  })

  it('getIndentSize reads stored 2 or 4', async () => {
    const { getIndentSize, INDENT_KEY } = await import('../src/editorSettings.ts')
    store.set(INDENT_KEY, '4')
    assert.equal(getIndentSize(), 4)
    store.set(INDENT_KEY, '2')
    assert.equal(getIndentSize(), 2)
  })

  it('setIndentSize writes value and getIndentSize reflects it', async () => {
    const { setIndentSize, getIndentSize, INDENT_KEY } = await import('../src/editorSettings.ts')
    setIndentSize(4)
    assert.equal(store.get(INDENT_KEY), '4')
    assert.equal(getIndentSize(), 4)
    setIndentSize(2)
    assert.equal(store.get(INDENT_KEY), '2')
    assert.equal(getIndentSize(), 2)
  })
})

// ---------- cookies.ts：raw 透传（计蒜客整段粘贴） ----------

describe('cookies.ts assembleCookie raw', () => {
  it('passes full header through as-is, stripping Cookie: prefix', () => {
    const def = [{ key: 'cookie', cookieName: 'cookie', placeholder: '', raw: true }]
    const header = 'acw_tc=x; s=eyJabc; XSRF-TOKEN=tok; remember_web_x=yz'
    assert.equal(assembleCookie(def, { cookie: 'Cookie: ' + header }), header)
    assert.equal(assembleCookie(def, { cookie: header }), header)
  })

  it('wraps a bare session value with the cookie name (s=)', () => {
    const def = [{ key: 'cookie', cookieName: 's', placeholder: '', raw: true }]
    assert.equal(assembleCookie(def, { cookie: 'eyJabc%3D' }), 's=eyJabc%3D')
    // 含 = 的整段（哪怕只有一对）按完整头透传，不补前缀
    assert.equal(assembleCookie(def, { cookie: 'eyJabc%3D; extra=1' }), 'eyJabc%3D; extra=1')
    assert.equal(assembleCookie(def, { cookie: 'k=v' }), 'k=v')
  })

  it('keeps named-field extraction behavior unchanged', () => {
    const def = [
      { key: 'uid', cookieName: '_uid', placeholder: '' },
      { key: 'clientId', cookieName: '__client_id', placeholder: '' },
    ]
    assert.equal(
      assembleCookie(def, { uid: '1892580', clientId: 'abc-123' }),
      '_uid=1892580; __client_id=abc-123',
    )
  })
})

describe('cookies.ts 计蒜客双框拼装（s + JSKUSS）', () => {
  const def = [
    { key: 's', cookieName: 's', placeholder: '', raw: true },
    { key: 'jskuss', cookieName: 'JSKUSS', placeholder: '', raw: true },
  ]

  it('两框分别只填值：各自补名字前缀后拼接', () => {
    const out = assembleCookie(def, { s: 'session-value', jskuss: 'eyJjskuss' })
    assert.equal(out, 's=session-value; JSKUSS=eyJjskuss')
  })

  it('JSKUSS 框整对粘贴（name=value）原样透传', () => {
    const out = assembleCookie(def, {
      s: 'session-value',
      jskuss: 'JSKUSS=eyJpdiI',
    })
    assert.equal(out, 's=session-value; JSKUSS=eyJpdiI')
  })

  it('只填 s、JSKUSS 留空：不产生空片段', () => {
    assert.equal(assembleCookie(def, { s: 'only-s' }), 's=only-s')
    assert.equal(assembleCookie(def, {}), '')
  })

  it('旧流程兼容：完整 Cookie 头整段贴进 s 框仍原样透传', () => {
    const header = 's=abc; XSRF-TOKEN=tok; remember_web_59ba36=yz'
    assert.equal(assembleCookie(def, { s: 'Cookie: ' + header }), header)
  })
})

describe('cookies.ts 单字段合并（只改一个字段不清空另一个）', () => {
  // 与生产字段表一致：QOJ = 两项 Cookie 按名分框（UOJSESSID / cf_clearance）+ 浏览器 UA（configOnly）
  const qojDefs: CookieFieldDef[] = [
    { key: 'uojsessid', cookieName: 'UOJSESSID' },
    { key: 'clearance', cookieName: 'cf_clearance' },
    { key: 'ua', cookieName: '__ua', configOnly: true },
  ]
  const FULL = 'UOJSESSID=sess-tok; cf_clearance=cf-tok'

  it('补填 UA 时两项 Cookie 原样保留（历史缺陷回归：只改一项曾把另一项截断/清空）', () => {
    const out = mergeCookieFields(FULL, qojDefs, { ua: 'Mozilla/5.0 (Windows NT 10.0) Chrome/153' })
    assert.equal(out, FULL)
  })

  it('只覆盖 cf_clearance 时 UOJSESSID 保留、UA 不写进 Cookie 头', () => {
    const out = mergeCookieFields(FULL, qojDefs, { clearance: 'new-cf', ua: 'Mozilla/5.0 Chrome/153' })
    assert.equal(out, 'UOJSESSID=sess-tok; cf_clearance=new-cf')
  })

  it('整段 Cookie 粘进任一框：后端按名字分派到各字段', () => {
    // 用户把 F12 里的整段 Cookie 粘到「UOJSESSID」框，cf_clearance 也应自动落位
    const out = mergeCookieFields('', qojDefs, { uojsessid: 'Cookie: cf_clearance=cf-tok; UOJSESSID=sess-tok' })
    assert.equal(out, 'UOJSESSID=sess-tok; cf_clearance=cf-tok')
    // 反向：粘到 cf_clearance 框同样分派
    assert.equal(
      mergeCookieFields('', qojDefs, { clearance: 'cf_clearance=cf-2; UOJSESSID=sess-2' }),
      'UOJSESSID=sess-2; cf_clearance=cf-2',
    )
    // 显式填写的字段优先于分派结果
    assert.equal(
      mergeCookieFields('', qojDefs, { clearance: 'cf_clearance=cf-3; UOJSESSID=ignored', uojsessid: 'mine' }),
      'UOJSESSID=mine; cf_clearance=cf-3',
    )
  })

  it('未做任何改动时原样保留已保存的头', () => {
    assert.equal(mergeCookieFields(FULL, qojDefs, {}), FULL)
  })

  it('显式空串清空单个 Cookie 项，其余保留', () => {
    assert.equal(mergeCookieFields(FULL, qojDefs, { clearance: '' }), 'UOJSESSID=sess-tok')
    assert.equal(mergeCookieFields(FULL, qojDefs, { uojsessid: '', clearance: '' }), '')
  })

  it('raw 框（整段透传语义）单独使用时原样保留已存头', () => {
    const rawDefs: CookieFieldDef[] = [{ key: 'sid', cookieName: 'sid', raw: true }]
    assert.equal(mergeCookieFields('sid=abc', rawDefs, {}), 'sid=abc')
    assert.equal(mergeCookieFields('', rawDefs, { sid: 'Cookie: sid=abc' }), 'sid=abc')
  })

  it('逐项字段（洛谷 _uid + __client_id）按顺序合并且互不覆盖', () => {
    const defs: CookieFieldDef[] = [
      { key: 'uid', cookieName: '_uid' },
      { key: 'clientId', cookieName: '__client_id' },
    ]
    assert.equal(mergeCookieFields('__client_id=abc', defs, { uid: '1892580' }), '_uid=1892580; __client_id=abc')
    assert.equal(
      mergeCookieFields('_uid=1892580; __client_id=abc', defs, { clientId: 'xyz' }),
      '_uid=1892580; __client_id=xyz',
    )
    // 显式空串只清一项
    assert.equal(mergeCookieFields('_uid=1892580; __client_id=abc', defs, { uid: '' }), '__client_id=abc')
  })

  it('buildCookieItem：裸值补前缀、整段剥前缀、configOnly 原样', () => {
    assert.equal(buildCookieItem({ key: 's', cookieName: 'sid', raw: true }, 'raw-sid'), 'sid=raw-sid')
    assert.equal(buildCookieItem({ key: 's', cookieName: 'sid', raw: true }, 'Cookie: sid=raw-sid'), 'sid=raw-sid')
    assert.equal(buildCookieItem({ key: 'u', cookieName: 'UOJSESSID' }, 'tok-1'), 'UOJSESSID=tok-1')
    assert.equal(buildCookieItem({ key: 'u', cookieName: 'UOJSESSID' }, ''), '')
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0'
    assert.equal(buildCookieItem({ key: 'ua', cookieName: '__ua', configOnly: true }, ua), ua)
  })

  it('splitCookieFields：已保存头拆回各字段裸值', () => {
    const stored = 'UOJSESSID=sess-1; cf_clearance=cf-2'
    assert.deepEqual(
      splitCookieFields(stored, [
        { key: 'uojsessid', cookieName: 'UOJSESSID' },
        { key: 'clearance', cookieName: 'cf_clearance' },
      ]),
      { uojsessid: 'sess-1', clearance: 'cf-2' },
    )
    assert.deepEqual(splitCookieFields('', qojDefs), {})
  })
})
