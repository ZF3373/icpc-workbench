import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as review from '../src/reviewDue.ts'
import type { ReviewItem } from '../src/types.ts'

const items = [
  { id: 1, platform: 'codeforces', problemKey: '1234A', title: 'Binary Search', tags: ['二分'], note: '边界需要注意' },
  { id: 2, platform: 'luogu', problemKey: 'P1000', title: '入门', tags: ['模拟'], note: null },
  { id: 3, platform: 'atcoder', problemKey: 'abc300_a', title: 'Search for solution', tags: ['数学'], note: '二分答案' },
] as ReviewItem[]

test('复习筛选支持题号/标题/知识点/笔记和不区分大小写的多关键词，并与平台条件组合', () => {
  assert.equal(typeof review.filterReviewItems, 'function', '缺少复习检索功能')
  assert.deepEqual(review.filterReviewItems(items, '  SEARCH  二分 ').map(i => i.id), [1, 3])
  assert.deepEqual(review.filterReviewItems(items, '1234a').map(i => i.id), [1])
  assert.deepEqual(review.filterReviewItems(items, '边界').map(i => i.id), [1])
  assert.deepEqual(review.filterReviewItems(items, '二分', 'atcoder').map(i => i.id), [3])
  assert.deepEqual(review.filterReviewItems(items, '', 'luogu').map(i => i.id), [2])
  assert.deepEqual(review.filterReviewItems(items, '不存在'), [])
  assert.deepEqual(review.filterReviewItems(items, '   '), items)
  assert.deepEqual(items.map(i => i.id), [1, 2, 3], '筛选不能改变到期顺序或修改原队列')
})

test('历史逾期按复习时的本地日计算，跨 UTC 日和闰日仍按日历天数显示', () => {
  assert.equal(typeof review.reviewTimingText, 'function', '缺少历史到期状态解释')
  const localMidnight = new Date(2026, 9, 15, 0, 30).toISOString()
  assert.equal(review.reviewTimingText(localMidnight, '2026-10-14'), '逾期 1 天')
  assert.equal(review.reviewTimingText(localMidnight, '2026-10-15'), '按期复习')
  assert.equal(review.reviewTimingText(localMidnight, '2026-10-18'), '提前 3 天')
  assert.equal(review.reviewTimingText(new Date(2028, 2, 1, 23, 30).toISOString(), '2028-02-28'), '逾期 2 天')
  assert.equal(review.reviewTimingText('invalid', '2026-10-14'), '日期未知')
})
