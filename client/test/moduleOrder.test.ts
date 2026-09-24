/**
 * moduleOrder.ts 纯函数单元测试（node:test 运行）。
 * 覆盖：无存档回默认、重排 + 缺失补尾、未知/重复 id 丢弃、完整排列透传。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyModuleOrder, DEFAULT_MODULE_IDS } from '../src/moduleOrder.ts'

describe('applyModuleOrder', () => {
  it('returns defaults when nothing (or empty) is saved', () => {
    assert.deepEqual(applyModuleOrder(null), [...DEFAULT_MODULE_IDS])
    assert.deepEqual(applyModuleOrder([]), [...DEFAULT_MODULE_IDS])
  })

  it('reorders saved ids and appends missing ones in default order', () => {
    assert.deepEqual(applyModuleOrder(['trend', 'heatmap']), [
      'trend',
      'heatmap',
      'platforms',
      'difficulty',
      'weakness',
      'history',
    ])
  })

  it('drops unknown and duplicate ids', () => {
    assert.deepEqual(applyModuleOrder(['nope', 'trend', 'trend', 'history']), [
      'trend',
      'history',
      'heatmap',
      'platforms',
      'difficulty',
      'weakness',
    ])
  })

  it('passes a full permutation through verbatim', () => {
    const perm = ['history', 'trend', 'weakness', 'difficulty', 'platforms', 'heatmap']
    assert.deepEqual(applyModuleOrder(perm), perm)
  })
})
