import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTemplateViewState } from '../src/templateView.ts'

describe('normalizeTemplateViewState：模板库视图快照', () => {
  it('接受合法的分类与滚动位置', () => {
    assert.deepEqual(
      normalizeTemplateViewState({ categoryKey: 'graph', scrollTop: 842 }),
      { categoryKey: 'graph', scrollTop: 842 },
    )
  })

  it('没有记录 / 非对象 / 数组一律视为无快照', () => {
    for (const raw of [null, undefined, 0, 'graph', [], true]) {
      assert.equal(normalizeTemplateViewState(raw), null)
    }
  })

  it('分类 key 去首尾空白；空串按未选分类处理', () => {
    assert.deepEqual(
      normalizeTemplateViewState({ categoryKey: '  dp  ', scrollTop: 10 }),
      { categoryKey: 'dp', scrollTop: 10 },
    )
    assert.deepEqual(
      normalizeTemplateViewState({ categoryKey: '   ', scrollTop: 10 }),
      { categoryKey: null, scrollTop: 10 },
    )
  })

  it('滚动位置取整并夹到 [0, 上限]，NaN/Infinity 归零', () => {
    assert.equal(normalizeTemplateViewState({ categoryKey: 'dp', scrollTop: 42.9 })?.scrollTop, 42)
    assert.equal(normalizeTemplateViewState({ categoryKey: 'dp', scrollTop: -8 })?.scrollTop, 0)
    assert.equal(normalizeTemplateViewState({ categoryKey: 'dp', scrollTop: Number.NaN })?.scrollTop, 0)
    assert.equal(normalizeTemplateViewState({ categoryKey: 'dp', scrollTop: Number.POSITIVE_INFINITY })?.scrollTop, 0)
    assert.equal(normalizeTemplateViewState({ categoryKey: 'dp', scrollTop: 20_000_000 })?.scrollTop, 10_000_000)
  })

  it('空分类 + 0 滚动没有可恢复内容，返回 null', () => {
    assert.equal(normalizeTemplateViewState({ categoryKey: '', scrollTop: 0 }), null)
    assert.equal(normalizeTemplateViewState({}), null)
  })
})
