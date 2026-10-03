/**
 * assistantSessionOrder.ts 单元测试：会话列表键盘排序 / 撤销的纯函数。
 *
 * 这些边界正是「按了没反应却弹撤销」和「撤销把顺序弄坏」的高发区：
 * 首尾越界、id 不存在、撤销窗口内新建/删除会话、快照里出现重复 id ——
 * 都必须返回 null 让调用方拒绝操作，而不是做半截搬运。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  moveSessionBy,
  pinFirstOrder,
  restoreSessionOrder,
  sessionIdOrder,
} from '../src/pages/assistantSessionOrder.ts'

interface Row {
  id: string
  title: string
}

interface PinnedRow {
  id: string
  title: string
  pinned: boolean
}

const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id, title: `会话 ${id}` }))
const ids = (list: readonly Row[]) => list.map((r) => r.id)
// p() 建置顶行，u() 建未置顶行
const p = (id: string): PinnedRow => ({ id, title: `会话 ${id}`, pinned: true })
const u = (id: string): PinnedRow => ({ id, title: `会话 ${id}`, pinned: false })

describe('moveSessionBy', () => {
  it('上移一格：与前一格交换位置', () => {
    const next = moveSessionBy(rows('a', 'b', 'c'), 'b', -1)
    assert.deepEqual(ids(next!), ['b', 'a', 'c'])
  })

  it('下移一格：与后一格交换位置', () => {
    const next = moveSessionBy(rows('a', 'b', 'c'), 'b', 1)
    assert.deepEqual(ids(next!), ['a', 'c', 'b'])
  })

  it('不改动原数组（React 状态必须靠新引用触发重渲染）', () => {
    const before = rows('a', 'b', 'c')
    const next = moveSessionBy(before, 'c', -1)
    assert.deepEqual(ids(before), ['a', 'b', 'c'])
    assert.notEqual(next, before)
  })

  it('保留元素对象本身，而不是重建', () => {
    const before = rows('a', 'b')
    const b = before[1]
    assert.equal(moveSessionBy(before, 'b', -1)![0], b)
  })

  it('首项上移 / 末项下移返回 null（越界，调用方据此不弹撤销）', () => {
    assert.equal(moveSessionBy(rows('a', 'b'), 'a', -1), null)
    assert.equal(moveSessionBy(rows('a', 'b'), 'b', 1), null)
  })

  it('单个会话时上移下移都返回 null', () => {
    assert.equal(moveSessionBy(rows('a'), 'a', -1), null)
    assert.equal(moveSessionBy(rows('a'), 'a', 1), null)
  })

  it('id 不存在返回 null', () => {
    assert.equal(moveSessionBy(rows('a', 'b'), 'zz', 1), null)
  })

  it('空列表不抛异常', () => {
    assert.equal(moveSessionBy([], 'a', 1), null)
  })
})

describe('restoreSessionOrder', () => {
  it('按 id 序列还原顺序（撤销）', () => {
    // 用户把 b 上移后的样子：b,a,c；快照是 a,b,c
    const current = rows('b', 'a', 'c')
    const restored = restoreSessionOrder(current, ['a', 'b', 'c'])
    assert.deepEqual(ids(restored!), ['a', 'b', 'c'])
  })

  it('保留元素对象本身（消息内容不会因撤销而丢）', () => {
    const current = rows('b', 'a')
    const restored = restoreSessionOrder(current, ['a', 'b'])!
    assert.equal(restored[0], current[1])
    assert.equal(restored[1], current[0])
  })

  it('数量不一致（窗口内新建/删除过会话）返回 null', () => {
    assert.equal(restoreSessionOrder(rows('a', 'b', 'c'), ['a', 'b']), null)
    assert.equal(restoreSessionOrder(rows('a'), ['a', 'b']), null)
  })

  it('快照含陌生 id 返回 null', () => {
    assert.equal(restoreSessionOrder(rows('a', 'b'), ['a', 'zz']), null)
  })

  it('快照含重复 id 返回 null（否则会复制同一会话）', () => {
    assert.equal(restoreSessionOrder(rows('a', 'b'), ['a', 'a']), null)
  })

  it('顺序本就一致时返回等价数组，不报错', () => {
    const current = rows('a', 'b')
    assert.deepEqual(ids(restoreSessionOrder(current, ['a', 'b'])!), ['a', 'b'])
  })
})

describe('pinFirstOrder', () => {
  it('置顶会话整体排到未置顶之前', () => {
    const next = pinFirstOrder([u('a'), p('b'), u('c')])
    assert.deepEqual(ids(next), ['b', 'a', 'c'])
  })

  it('组内保持原有手动顺序（置顶与未置顶各自保序）', () => {
    const next = pinFirstOrder([u('a'), p('x'), u('b'), p('y'), u('c')])
    assert.deepEqual(ids(next), ['x', 'y', 'a', 'b', 'c'])
  })

  it('不改动原数组（React 状态必须靠新引用触发重渲染）', () => {
    const before = [u('a'), p('b')]
    const next = pinFirstOrder(before)
    assert.deepEqual(ids(before), ['a', 'b'])
    assert.notEqual(next, before)
  })

  it('保留元素对象本身，而不是重建', () => {
    const before = [u('a'), p('b')]
    assert.equal(pinFirstOrder(before)[0], before[1])
  })

  it('全部置顶 / 全部未置顶 / 空列表：顺序不变', () => {
    assert.deepEqual(ids(pinFirstOrder([p('a'), p('b')])), ['a', 'b'])
    assert.deepEqual(ids(pinFirstOrder([u('a'), u('b')])), ['a', 'b'])
    assert.deepEqual(pinFirstOrder([]), [])
  })
})

describe('sessionIdOrder + 往返', () => {
  it('快照只取 id，长度与顺序一致', () => {
    assert.deepEqual(sessionIdOrder(rows('a', 'b', 'c')), ['a', 'b', 'c'])
  })

  it('移动后撤销可回到原顺序（多次连续移动）', () => {
    const before = rows('a', 'b', 'c', 'd')
    const snapshot = sessionIdOrder(before)
    // 连续两次键盘下移：a 到末尾
    let cur = moveSessionBy(before, 'a', 1)!
    cur = moveSessionBy(cur, 'a', 1)!
    assert.deepEqual(ids(cur), ['b', 'c', 'a', 'd'])
    const restored = restoreSessionOrder(cur, snapshot)!
    assert.deepEqual(ids(restored), ['a', 'b', 'c', 'd'])
  })
})
