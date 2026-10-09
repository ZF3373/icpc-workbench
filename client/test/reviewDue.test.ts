/**
 * reviewDue.ts 纯函数单元测试（node:test 运行）。
 *
 * 这三个界面（复习库 / 今日训练 / 日历）对同一条目必须给出同一套说法，
 * 因此把「哪天算到期、逾期怎么显示、排序按什么」的口径钉在这里。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { countDue, dueText, sortDueItems, FEEDBACK_META } from '../src/reviewDue.ts'
import type { ReviewItem } from '../src/types.ts'

const TODAY = '2026-10-07'

function item(over: Partial<ReviewItem> & { id: number; nextDueOn: string }): ReviewItem {
  return {
    platform: 'codeforces',
    problemKey: `P${over.id}`,
    title: `题 ${over.id}`,
    difficulty: 1500,
    url: null,
    tags: [],
    stage: 0,
    intervalDays: 1,
    reviewCount: 0,
    lapseCount: 0,
    note: null,
    lastReviewedAt: null,
    addedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  } as ReviewItem
}

describe('dueText', () => {
  it('到期日早于今天 → 逾期，并显示原定日期', () => {
    const r = dueText(item({ id: 1, nextDueOn: '2026-10-04' }), TODAY)
    assert.equal(r.overdue, true)
    assert.equal(r.due, true)
    assert.equal(r.text, '逾期 2026-10-04')
  })

  it('到期日等于今天 → 今日到期', () => {
    const r = dueText(item({ id: 1, nextDueOn: TODAY }), TODAY)
    assert.equal(r.overdue, false)
    assert.equal(r.due, true)
    assert.equal(r.text, '今日到期')
  })

  it('到期日在未来 → 显示日期本身，不算「现在就该做」', () => {
    const r = dueText(item({ id: 1, nextDueOn: '2026-10-20' }), TODAY)
    assert.equal(r.due, false)
    assert.equal(r.overdue, false)
    assert.equal(r.text, '2026-10-20')
  })
})

describe('sortDueItems', () => {
  it('逾期最前（欠得越久越靠前），其次今日，再按到期日升序', () => {
    const items = [
      item({ id: 1, nextDueOn: '2026-10-20' }),
      item({ id: 2, nextDueOn: TODAY }),
      item({ id: 3, nextDueOn: '2026-10-02' }),
      item({ id: 4, nextDueOn: '2026-10-05' }),
      item({ id: 5, nextDueOn: '2026-10-12' }),
    ]
    assert.deepEqual(
      sortDueItems(items, TODAY).map((i) => i.id),
      [3, 4, 2, 5, 1],
    )
  })

  it('同到期日按难度升序，难度未知沉底，再按 id 稳定排序', () => {
    const items = [
      item({ id: 1, nextDueOn: TODAY, difficulty: 1800 }),
      item({ id: 2, nextDueOn: TODAY, difficulty: null }),
      item({ id: 3, nextDueOn: TODAY, difficulty: 1200 }),
      item({ id: 4, nextDueOn: TODAY, difficulty: 1200 }),
    ]
    assert.deepEqual(
      sortDueItems(items, TODAY).map((i) => i.id),
      [3, 4, 1, 2],
    )
  })

  it('不修改传入数组（调用方可能直接持有 state）', () => {
    const items = [item({ id: 1, nextDueOn: '2026-10-20' }), item({ id: 2, nextDueOn: TODAY })]
    const before = items.map((i) => i.id)
    sortDueItems(items, TODAY)
    assert.deepEqual(items.map((i) => i.id), before)
  })
})

describe('countDue', () => {
  it('只数今日到期与逾期，与复习库页 dueCount 同口径', () => {
    const items = [
      item({ id: 1, nextDueOn: '2026-10-01' }), // 逾期
      item({ id: 2, nextDueOn: TODAY }), // 今日
      item({ id: 3, nextDueOn: '2026-10-08' }), // 明天
      item({ id: 4, nextDueOn: '2026-11-01' }), // 未来
    ]
    assert.equal(countDue(items, TODAY), 2)
  })

  it('空列表为 0', () => {
    assert.equal(countDue([], TODAY), 0)
  })
})

describe('FEEDBACK_META', () => {
  it('三个反馈档位齐全，且困难标红', () => {
    assert.deepEqual(FEEDBACK_META.map((f) => f.key), ['hard', 'ok', 'easy'])
    assert.equal(FEEDBACK_META.find((f) => f.key === 'hard')?.danger, true)
    assert.equal(FEEDBACK_META.find((f) => f.key === 'ok')?.danger, false)
  })
})
