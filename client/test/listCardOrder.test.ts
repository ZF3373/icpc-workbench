/**
 * listCardOrder.ts 纯函数单元测试（node:test 运行）。
 * 覆盖：前插/后插、拖到自己、目标/源不存在、顺序没变时返回同一引用、swap 越界与边界。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { moveListCard, swapListCard } from '../src/listCardOrder.ts'

const lists = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
const ids = (rows: readonly { id: number }[]) => rows.map((r) => r.id)

describe('moveListCard', () => {
  it('drops before the target', () => {
    assert.deepEqual(ids(moveListCard(lists, 4, 2, 'before')), [1, 4, 2, 3])
  })

  it('drops after the target', () => {
    assert.deepEqual(ids(moveListCard(lists, 1, 3, 'after')), [2, 3, 1, 4])
  })

  it('handles moving backwards and forwards over the same target', () => {
    // 向下拖：目标在拖拽项之后，索引前移一位后仍要落在目标后面
    assert.deepEqual(ids(moveListCard(lists, 1, 4, 'after')), [2, 3, 4, 1])
    // 向上拖：目标在拖拽项之前
    assert.deepEqual(ids(moveListCard(lists, 4, 1, 'before')), [4, 1, 2, 3])
  })

  it('does not mutate the input array', () => {
    const before = ids(lists)
    moveListCard(lists, 1, 3, 'after')
    assert.deepEqual(ids(lists), before)
  })

  it('returns the same reference when dragging onto itself', () => {
    assert.equal(moveListCard(lists, 2, 2, 'after'), lists)
  })

  it('returns the same reference when an id is missing', () => {
    assert.equal(moveListCard(lists, 99, 2, 'before'), lists)
    assert.equal(moveListCard(lists, 2, 99, 'before'), lists)
  })

  it('returns the same reference when the order would not change', () => {
    // 1 拖到 2 前面 / 2 拖到 1 后面：都是原位
    assert.equal(moveListCard(lists, 1, 2, 'before'), lists)
    assert.equal(moveListCard(lists, 2, 1, 'after'), lists)
  })

  it('returns a new array for a real move', () => {
    const next = moveListCard(lists, 1, 2, 'after')
    assert.notEqual(next, lists)
  })
})

describe('swapListCard', () => {
  it('swaps with the previous neighbour', () => {
    assert.deepEqual(ids(swapListCard(lists, 3, -1)), [1, 3, 2, 4])
  })

  it('swaps with the next neighbour', () => {
    assert.deepEqual(ids(swapListCard(lists, 2, 1)), [1, 3, 2, 4])
  })

  it('returns the same reference at the boundaries', () => {
    assert.equal(swapListCard(lists, 1, -1), lists)
    assert.equal(swapListCard(lists, 4, 1), lists)
  })

  it('returns the same reference for an unknown id', () => {
    assert.equal(swapListCard(lists, 99, 1), lists)
  })

  it('does not mutate the input and returns a new array', () => {
    const before = ids(lists)
    const next = swapListCard(lists, 1, 1)
    assert.deepEqual(ids(lists), before)
    assert.notEqual(next, lists)
  })
})
