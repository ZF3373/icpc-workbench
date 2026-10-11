import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSuggestedOrder } from '../src/listOrder'

const items = [
  { id: 1, key: 'A' },
  { id: 2, key: 'B' },
  { id: 3, key: 'C' },
  { id: 4, key: 'D' },
]

test('mergeSuggestedOrder: 建议顺序生效，漏排的按原相对顺序接尾', () => {
  // AI 只排了 3、1：2、4 保持原有相对顺序接在后面
  assert.deepEqual(
    mergeSuggestedOrder([3, 1], items).map((i) => i.id),
    [3, 1, 2, 4],
  )
})

test('mergeSuggestedOrder: 生成后新增/删除的题不会让重排失败', () => {
  // 建议里引用了已删除的 id(9)，且漏掉新加的 4
  assert.deepEqual(
    mergeSuggestedOrder([9, 2, 1], items).map((i) => i.id),
    [2, 1, 3, 4],
  )
})

test('mergeSuggestedOrder: 重复 id 只取首次出现', () => {
  assert.deepEqual(
    mergeSuggestedOrder([2, 2, 1], items).map((i) => i.id),
    [2, 1, 3, 4],
  )
})

test('mergeSuggestedOrder: 空建议 = 原顺序原样返回', () => {
  assert.deepEqual(
    mergeSuggestedOrder([], items).map((i) => i.id),
    [1, 2, 3, 4],
  )
})
