/**
 * intentOptions.ts 纯逻辑测试。
 * 把 UI 契约（卡点选项、请求 URL / body、tag → code 映射）钉在可独立运行的单元测试里，
 * 不依赖 DOM 测试框架。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INTENT_OPTIONS,
  codeOptionsFromTags,
  intentPath,
  buildIntentBody,
  type IntentOutcome,
} from '../src/intentOptions.ts'

/** 与服务端 routes/problems.ts 的 INTENT_OUTCOMES 白名单逐字一致 */
const SERVER_ALLOWED: readonly string[] = ['cant_start', 'editorial', 'wrong_approach', 'implementation', 'slight_bug']

describe('INTENT_OPTIONS', () => {
  it('value 集合与服务端白名单完全一致', () => {
    assert.deepEqual(
      INTENT_OPTIONS.map((o) => o.value).sort(),
      [...SERVER_ALLOWED].sort(),
    )
  })

  it('每项都有非空中文标签与提示', () => {
    for (const o of INTENT_OPTIONS) {
      assert.ok(o.label.trim().length > 0, `${o.value} 缺 label`)
      assert.ok(o.hint.trim().length > 0, `${o.value} 缺 hint`)
    }
  })

  it('label 不重复（用户能区分选项）', () => {
    const labels = INTENT_OPTIONS.map((o) => o.label)
    assert.equal(new Set(labels).size, labels.length)
  })

  it('类型 IntentOutcome 覆盖全部 value', () => {
    const values: IntentOutcome[] = INTENT_OPTIONS.map((o) => o.value)
    assert.equal(values.length, 5)
  })
})

describe('codeOptionsFromTags', () => {
  it('把知识点展示名映射为 taxonomy code', () => {
    const options = codeOptionsFromTags(['数论', '数学（综合）'])
    assert.deepEqual(options, [
      { value: 'math.number-theory', label: '数论' },
      { value: 'math.general', label: '数学（综合）' },
    ])
  })

  it('丢弃无法映射到 code 的标签', () => {
    const options = codeOptionsFromTags(['数论', '完全不存在标签', '贪心'])
    assert.deepEqual(options, [
      { value: 'math.number-theory', label: '数论' },
      { value: 'basic.greedy', label: '贪心' },
    ])
  })

  it('按出现顺序对 code 去重并保留第一次出现的 label', () => {
    // 「数学」与「数学（综合）」都落到 math.general，应只保留先出现的
    const options = codeOptionsFromTags(['数论', '数学', '数论', '数学（综合）'])
    assert.deepEqual(options, [
      { value: 'math.number-theory', label: '数论' },
      { value: 'math.general', label: '数学' },
    ])
  })

  it('返回空数组当没有任何可映射标签时', () => {
    assert.deepEqual(codeOptionsFromTags(['未知标签']), [])
  })
})

describe('请求契约', () => {
  it('intentPath 对平台和题号都做 encodeURIComponent（支持空格、斜杠等特殊字符）', () => {
    assert.equal(
      intentPath('codeforces', '1 / 2'),
      '/api/problems/codeforces/1%20%2F%202/intent',
    )
  })

  it('buildIntentBody 仅在有 code 时才带上 code 字段', () => {
    assert.deepEqual(buildIntentBody('wrong_approach'), { outcome: 'wrong_approach' })
    assert.deepEqual(buildIntentBody('implementation', ''), { outcome: 'implementation' })
    assert.deepEqual(buildIntentBody('cant_start', 'basic.greedy'), {
      outcome: 'cant_start',
      code: 'basic.greedy',
    })
  })
})
