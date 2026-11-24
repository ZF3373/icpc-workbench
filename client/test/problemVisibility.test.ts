import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VISIBILITY,
  HIDDEN_LABEL,
  normalizeVisibility,
  shouldHideDifficulty,
  shouldHideTags,
} from '../src/problemVisibility'

test('normalizeVisibility: 只认字面 true，脏值一律 false', () => {
  assert.deepEqual(normalizeVisibility(null), { hideTags: false, hideDifficulty: false })
  assert.deepEqual(normalizeVisibility(undefined), { hideTags: false, hideDifficulty: false })
  assert.deepEqual(normalizeVisibility({}), { hideTags: false, hideDifficulty: false })
  assert.deepEqual(normalizeVisibility({ hideTags: '1' }), { hideTags: false, hideDifficulty: false })
  assert.deepEqual(normalizeVisibility({ hideTags: 1, hideDifficulty: 0 }), {
    hideTags: false,
    hideDifficulty: false,
  })
  assert.deepEqual(normalizeVisibility({ hideTags: true, hideDifficulty: true }), {
    hideTags: true,
    hideDifficulty: true,
  })
  // 多出来的字段不保留：偏好只有这两位
  assert.deepEqual(normalizeVisibility({ hideTags: true, other: 1 }), {
    hideTags: true,
    hideDifficulty: false,
  })
})

test('两个开关互相独立', () => {
  const tagsOnly = { hideTags: true, hideDifficulty: false }
  assert.equal(shouldHideTags(tagsOnly, 0), true)
  assert.equal(shouldHideDifficulty(tagsOnly, 0), false)
  const diffOnly = { hideTags: false, hideDifficulty: true }
  assert.equal(shouldHideTags(diffOnly, 0), false)
  assert.equal(shouldHideDifficulty(diffOnly, 0), true)
})

test('shouldHide*: 只藏「没 AC 过」的题，AC 过的题照常显示', () => {
  const both = { hideTags: true, hideDifficulty: true }
  assert.equal(shouldHideTags(both, 0), true)
  assert.equal(shouldHideDifficulty(both, 0), true)
  assert.equal(shouldHideTags(both, 1), false)
  assert.equal(shouldHideDifficulty(both, 3), false)
  // 未知（旧服务端不带 acCount）按「没 AC」处理：宁可多藏
  assert.equal(shouldHideTags(both, null), true)
  assert.equal(shouldHideTags(both, undefined), true)
})

test('全关时不隐藏', () => {
  assert.equal(shouldHideTags(DEFAULT_VISIBILITY, 0), false)
  assert.equal(shouldHideDifficulty(DEFAULT_VISIBILITY, 0), false)
})

test('HIDDEN_LABEL 有可见文案（不能是空串，否则格子看起来像没数据）', () => {
  assert.equal(HIDDEN_LABEL.trim().length > 0, true)
})
