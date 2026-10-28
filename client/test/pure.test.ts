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

  /**
   * 回归：`idea` 里再写一段 ```cpp 围栏时，旧的懒匹配正则会在内层 ``` 处收尾，
   * JSON 被截成半截 → 解析失败 → 块退化成正文里点不动的代码卡。
   * 闭合围栏按 Markdown 语义必须独占一行，内层 ```cpp 不是闭合围栏。
   */
  it('keeps parsing when the JSON contains a nested ```cpp fence', async () => {
    const { extractTemplateAdd, stripTemplateAdd } = await import('../src/aiBlocks.ts')
    const nested = [
      '说明正文',
      '```template-add',
      '{',
      '  "categoryKey": "graph",',
      '  "templateId": "graph-dijkstra",',
      '  "name": "堆优化 Dijkstra",',
      '  "difficulty": 3,',
      '  "tags": ["图论", "最短路"],',
      '  "code": "void dij(int s) {}",',
      '  "idea": "## 适用\\n\\n```cpp\\nfor (int i = 1; i <= n; i++) {\\n  relax(i);\\n}\\n```\\n",',
      '  "complexity": "O((n+m) log m)",',
      '  "url": "https://www.luogu.com.cn/problem/P4779"',
      '}',
      '```',
    ].join('\n')

    const drafts = extractTemplateAdd(nested)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.name, '堆优化 Dijkstra')
    assert.equal(drafts[0]!.templateId, 'graph-dijkstra')
    assert.match(drafts[0]!.idea ?? '', /```cpp/)
    // 整块（含内层围栏）都被剥离，正文不留残余
    assert.equal(stripTemplateAdd(nested), '说明正文')
  })

  it('accepts ~~~ fences, 4+ backtick fences and upper-case block names', async () => {
    const { extractTemplateAdd, stripTemplateAdd } = await import('../src/aiBlocks.ts')
    const body = '{"name":"A*","categoryKey":"search"}'
    const variants = [
      `前\n~~~template-add\n${body}\n~~~\n后`,
      `前\n\`\`\`\`template-add\n${body}\n\`\`\`\`\n后`,
      `前\n\`\`\`TEMPLATE-ADD\n${body}\n\`\`\`\n后`,
      `前\n\`\`\`Template-Add\n${body}\n\`\`\`\n后`,
    ]
    for (const v of variants) {
      assert.equal(extractTemplateAdd(v).length, 1, `应能解析：${JSON.stringify(v.slice(0, 20))}`)
      assert.equal(stripTemplateAdd(v), '前\n\n后')
    }
  })

  it('repairs raw newlines and trailing commas inside the JSON', async () => {
    const { extractTemplateAdd } = await import('../src/aiBlocks.ts')
    const rawNewlines = [
      '```template-add',
      '{',
      '  "categoryKey": "dp",',
      '  "name": "区间 DP",',
      '  "code": "#include <bits/stdc++.h>',
      'int main() {',
      '  return 0;',
      '}",',
      '  "idea": "转移：dp[i][j]",',
      '  "difficulty": 3,',
      '}',
      '```',
    ].join('\n')

    const drafts = extractTemplateAdd(rawNewlines)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.name, '区间 DP')
    assert.match(drafts[0]!.code, /int main\(\) \{/)
    assert.match(drafts[0]!.code, /\n/) // 裸换行按真换行还原
  })

  it('recovers code containing unescaped double quotes', async () => {
    const { extractTemplateAdd } = await import('../src/aiBlocks.ts')
    const sloppy = [
      '```template-add',
      '{',
      '  "categoryKey": "basic",',
      '  "name": "读入输出",',
      '  "difficulty": 1,',
      '  "tags": ["输入输出"],',
      '  "code": "printf("%d\\n", x);",',
      '  "idea": "用 printf 输出",',
      '}',
      '```',
    ].join('\n')

    const drafts = extractTemplateAdd(sloppy)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.name, '读入输出')
    assert.equal(drafts[0]!.code, 'printf("%d\n", x);')
    assert.equal(drafts[0]!.idea, '用 printf 输出')
  })

  it('does not corrupt string content that looks like a trailing comma', async () => {
    const { extractTemplateAdd } = await import('../src/aiBlocks.ts')
    // code 里有裸换行 → 走「修补后 JSON」这条路；idea 里的 `, ]` 不能被当成尾逗号删掉
    const text = [
      '```template-add',
      '{',
      '  "name": "边界写法",',
      '  "code": "int a;',
      'int b;",',
      '  "idea": "看到 a, ] 这种写法时别慌",',
      '}',
      '```',
    ].join('\n')

    const drafts = extractTemplateAdd(text)
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0]!.idea, '看到 a, ] 这种写法时别慌')
    assert.match(drafts[0]!.code, /int a;\nint b;/)
  })

  it('tolerates CRLF output and JSON written on the fence line', async () => {
    const { extractTemplateAdd, stripTemplateAdd } = await import('../src/aiBlocks.ts')
    const crlf = '前\r\n```template-add\r\n{"name":"T","categoryKey":"ds"}\r\n```\r\n后'
    assert.equal(extractTemplateAdd(crlf).length, 1)
    assert.equal(extractTemplateAdd(crlf)[0]!.name, 'T')
    assert.equal(stripTemplateAdd(crlf).replace(/\r/g, ''), '前\n\n后')

    const inline = '前\n```template-add {"name":"T2","categoryKey":"ds"}\n```\n后'
    assert.equal(extractTemplateAdd(inline)[0]!.name, 'T2')
    assert.equal(stripTemplateAdd(inline), '前\n\n后')
  })

  it('does not fabricate a draft from a truncated block, but keeps its text', async () => {
    const { extractTemplateAdd } = await import('../src/aiBlocks.ts')
    const { parseMessageBlocks } = await import('../src/components/assistant/messageBlocks.ts')
    const truncated = [
      '说明正文',
      '```template-add',
      '{',
      '  "name": "堆优化 Dijkstra",',
      '  "code": "void dij(int s) {',
      '    // 输出到此被 token 上限截断',
    ].join('\n')

    assert.deepEqual(extractTemplateAdd(truncated), [])
    // 解析不了就别静默删掉：正文里保留原文，用户还能看到/复制
    const { text, issues } = parseMessageBlocks(truncated)
    assert.match(text, /template-add/)
    assert.equal(issues.length, 1) // 用来提示「为什么没有写入按钮」
    assert.equal(issues[0]!.name, 'template-add')
    assert.match(issues[0]!.reason, /没有闭合|截断/)
  })

  it('keeps an unparseable block visible while valid siblings still get buttons', async () => {
    const { parseMessageBlocks } = await import('../src/components/assistant/messageBlocks.ts')
    const mixed = [
      '```template-add',
      '{ this is not json }',
      '```',
      '```template-add',
      '{"name":"有效模板","categoryKey":"search"}',
      '```',
      '结尾',
    ].join('\n')

    const { tplAdds, text } = parseMessageBlocks(mixed)
    assert.equal(tplAdds.length, 1)
    assert.equal(tplAdds[0]!.name, '有效模板')
    assert.match(text, /this is not json/) // 坏块留在正文，好块被剥离
    assert.doesNotMatch(text, /有效模板/)
    assert.equal(tplAdds.length, 1)
  })
})

// ---------- 结构化块严格校验（各工具接口） ----------

describe('结构化块严格校验', () => {
  /** 拼一条「正文 + 一个块」的回复 */
  const wrap = (name: string, body: string): string => ['说明正文', '```' + name, body, '```', '结尾'].join('\n')

  it('ability-update：level 必须是 800–3500 的 100 整数倍', async () => {
    const { parseMessageBlocks } = await import('../src/components/assistant/messageBlocks.ts')

    const ok = parseMessageBlocks(wrap('ability-update', '{"level": 1900, "reason": "稳定 AC 1900"}'))
    assert.equal(ok.abilityUpd?.level, 1900)
    assert.equal(ok.issues.length, 0)

    for (const bad of ['1850', '700', '4000', '"1900"']) {
      const r = parseMessageBlocks(wrap('ability-update', `{"level": ${bad}}`))
      assert.equal(r.abilityUpd, null, `level=${bad} 不应生成按钮`)
      assert.equal(r.issues.length, 1)
      assert.equal(r.issues[0]!.name, 'ability-update')
      assert.match(r.text, /ability-update/) // 原文保留
    }
  })

  it('plan-modify：缺 tasks / 任务字段不全一律不生成按钮', async () => {
    const { parseMessageBlocks } = await import('../src/components/assistant/messageBlocks.ts')

    const ok = parseMessageBlocks(
      wrap('plan-modify', '{"tasks": [{"date": "2026-10-28", "title": "练图论", "kind": "topic"}]}'),
    )
    assert.ok(ok.modify)
    assert.equal(ok.issues.length, 0)
    assert.doesNotMatch(ok.text, /plan-modify/)

    const noTasks = parseMessageBlocks(wrap('plan-modify', '{"title": "冲刺"}'))
    assert.equal(noTasks.modify, null)
    assert.match(noTasks.issues[0]!.reason, /tasks/)

    const badTask = parseMessageBlocks(wrap('plan-modify', '{"tasks": [{"title": "没有日期"}]}'))
    assert.equal(badTask.modify, null)
    assert.match(badTask.issues[0]!.reason, /有效任务/)

    const notJson = parseMessageBlocks(wrap('plan-modify', '{ tasks: 不是 JSON }'))
    assert.equal(notJson.modify, null)
    assert.match(notJson.issues[0]!.reason, /JSON/)
  })

  it('plan-modify：重复块只认第一个并给出说明', async () => {
    const { parseMessageBlocks } = await import('../src/components/assistant/messageBlocks.ts')
    const reply = [
      '```plan-modify',
      '{"tasks": [{"date": "2026-10-28", "title": "A"}]}',
      '```',
      '```plan-modify',
      '{"tasks": [{"date": "2026-10-29", "title": "B"}]}',
      '```',
    ].join('\n')
    const r = parseMessageBlocks(reply)
    assert.ok(r.modify)
    assert.equal(r.issues.length, 1)
    assert.match(r.issues[0]!.reason, /重复/)
    // 重复块也不该留在正文里（两份 JSON 同时出现会让用户困惑）
    assert.doesNotMatch(r.text, /plan-modify/)
  })

  it('plan-create：标题与 tasks 都必填；日期格式不合法时忽略该字段但不作废整块', async () => {
    const { parseMessageBlocks } = await import('../src/components/assistant/messageBlocks.ts')
    const ok = parseMessageBlocks(
      wrap(
        'plan-create',
        '{"title": "四周冲刺", "startDate": "2026-10-28", "days": 28, "tasks": [{"date": "2026-10-28", "title": "热身"}]}',
      ),
    )
    assert.equal(ok.planDraft?.title, '四周冲刺')
    assert.equal(ok.planDraft?.days, 28)
    assert.equal(ok.issues.length, 0)

    const noTitle = parseMessageBlocks(wrap('plan-create', '{"tasks": [{"date": "2026-10-28", "title": "热身"}]}'))
    assert.equal(noTitle.planDraft, null)
    assert.match(noTitle.issues[0]!.reason, /title/)

    const badDate = parseMessageBlocks(
      wrap('plan-create', '{"title": "T", "startDate": "10/28", "tasks": [{"date": "2026-10-28", "title": "热身"}]}'),
    )
    assert.equal(badDate.planDraft?.title, 'T')
    assert.equal(badDate.planDraft?.startDate, undefined) // 非法日期被丢弃，但整块仍可用
  })

  it('list-create：title 与 raw 都必填', async () => {
    const { parseMessageBlocks } = await import('../src/components/assistant/messageBlocks.ts')
    const ok = parseMessageBlocks(wrap('list-create', '{"title": "图论 20 题", "raw": "P4779\\nP3371"}'))
    assert.equal(ok.listDraft?.title, '图论 20 题')
    assert.equal(ok.listDraft?.raw, 'P4779\nP3371')
    assert.equal(ok.issues.length, 0)

    const noRaw = parseMessageBlocks(wrap('list-create', '{"title": "空题单"}'))
    assert.equal(noRaw.listDraft, null)
    assert.match(noRaw.issues[0]!.reason, /raw/)
  })

  it('围栏写法不规范（~~~ / 4 个反引号 / 大写）同样按严格校验解析', async () => {
    const { parseMessageBlocks } = await import('../src/components/assistant/messageBlocks.ts')
    const variants = [
      '说明\n~~~ABILITY-UPDATE\n{"level": 1800}\n~~~',
      '说明\n````ability-update\n{"level": 1800}\n````',
    ]
    for (const v of variants) {
      const r = parseMessageBlocks(v)
      assert.equal(r.abilityUpd?.level, 1800)
      assert.equal(r.issues.length, 0)
      assert.equal(r.text, '说明')
    }
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
