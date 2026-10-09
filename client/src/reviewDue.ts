/**
 * 复习到期展示口径（今日训练 / 日历板块共用）。
 *
 * 抽成纯函数是为了让「哪天算到期、逾期怎么显示、排序按什么」只有一处定义：
 * 三个界面（复习库 / 今日训练 / 日历）对同一条目给出不同说法，用户就无从判断该信谁。
 */
import dayjs from 'dayjs'
import type { ReviewItem } from './types'

export interface DueText {
  /** 展示文案 */
  text: string
  /** 是否属于「现在就该做」（今日到期或已逾期） */
  due: boolean
  /** 已逾期（到期日早于今天） */
  overdue: boolean
}

/**
 * 到期文案。用本地日（dayjs）与日历页「今天」一致——
 * 用 toISOString() 取 UTC 日会让 UTC+8 用户在本地 0–8 点把「今日到期」判成逾期。
 */
export function dueText(item: ReviewItem, today = dayjs().format('YYYY-MM-DD')): DueText {
  if (item.nextDueOn < today) return { text: `逾期 ${item.nextDueOn}`, due: true, overdue: true }
  if (item.nextDueOn === today) return { text: '今日到期', due: true, overdue: false }
  return { text: item.nextDueOn, due: false, overdue: false }
}

/**
 * 排序：逾期最前（欠得越久越靠前），其次今日到期，再按到期日升序。
 * 同到期日按难度升序（先热身再做难的），难度未知沉底。
 */
export function sortDueItems(items: ReviewItem[], today = dayjs().format('YYYY-MM-DD')): ReviewItem[] {
  const rank = (i: ReviewItem): number => (i.nextDueOn < today ? 0 : i.nextDueOn === today ? 1 : 2)
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.nextDueOn.localeCompare(b.nextDueOn) ||
      (a.difficulty ?? Number.MAX_SAFE_INTEGER) - (b.difficulty ?? Number.MAX_SAFE_INTEGER) ||
      a.id - b.id,
  )
}

/** 统计「现在就该做」的数量（今日到期 + 逾期），与复习库页 dueCount 同口径 */
export function countDue(items: ReviewItem[], today = dayjs().format('YYYY-MM-DD')): number {
  return items.filter((i) => i.nextDueOn <= today).length
}

/** 反馈按钮的元信息：与复习库页共用同一套文案与档位后果说明 */
export const FEEDBACK_META = [
  { key: 'hard' as const, label: '困难', tip: '困难 · 退回两档（不是从头再来）', danger: true },
  { key: 'ok' as const, label: '掌握', tip: '掌握 · 前进一档', danger: false },
  { key: 'easy' as const, label: '轻松', tip: '轻松 · 跳进两档', danger: false },
]
