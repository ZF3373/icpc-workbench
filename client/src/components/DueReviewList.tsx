import { useState } from 'react'
import { Button, Space, Tag, Tooltip, App as AntdApp } from 'antd'
import { ReadOutlined } from '@ant-design/icons'
import PlatformTag from './PlatformTag'
import { difficultyColor } from '../ui'
import { post } from '../api'
import { dueText, FEEDBACK_META } from '../reviewDue'
import type { ReviewFeedback, ReviewItem } from '../types'

/**
 * 到期复习条目列表（今日训练 / 日历板块共用）。
 *
 * 两处都需要「看到期题 → 点链接去做 → 就地反馈推进排期」这条链路，
 * 复制一份会出现两套反馈文案与两套到期判定；这里收敛成一个组件。
 * 反馈成功后调 onChanged 让调用方重取数据（排期已变，本地改状态会与后端不一致）。
 */
export default function DueReviewList({
  items,
  onChanged,
  compact = false,
}: {
  items: ReviewItem[]
  /** 反馈成功后的重取回调 */
  onChanged: () => void
  /** 紧凑模式（日历侧栏用）：隐藏题名以外的次要信息 */
  compact?: boolean
}) {
  const { message } = AntdApp.useApp()
  const [pending, setPending] = useState<number | null>(null)

  const feedback = async (item: ReviewItem, f: ReviewFeedback) => {
    setPending(item.id)
    try {
      const r = await post<{ nextDueOn: string }>(`/api/reviews/${item.id}/feedback`, { feedback: f })
      message.success(`「${item.problemKey}」下次复习：${r.nextDueOn}`)
      onChanged()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  if (items.length === 0) return null

  return (
    <div className="due-review-list">
      {items.map((item) => {
        const due = dueText(item)
        return (
          <div className="due-review-row" key={item.id}>
            <div className="due-review-main">
              <Space size={6} wrap>
                <PlatformTag id={item.platform} />
                {item.difficulty != null && (
                  <span className="rating-pill mono" style={{ color: difficultyColor(item.difficulty) }}>
                    {item.difficulty}
                  </span>
                )}
                <Tag className="dot-tag" color={due.overdue ? 'error' : due.due ? 'processing' : 'default'}>
                  {due.text}
                </Tag>
                {!compact && (
                  <Tooltip
                    title={`间隔 ${item.intervalDays} 天 · 第 ${item.stage + 1} 档 · 已复习 ${item.reviewCount} 次${
                      item.lapseCount > 0 ? `（其中 ${item.lapseCount} 次判为困难）` : ''
                    }`}
                  >
                    <span className="due-review-meta">
                      第 {item.stage + 1} 档 / {item.intervalDays} 天
                      {item.lapseCount > 0 ? ` · 失手 ${item.lapseCount} 次` : ''}
                    </span>
                  </Tooltip>
                )}
              </Space>
              {item.url ? (
                <a className="today-problem-title" href={item.url} target="_blank" rel="noreferrer">
                  [{item.problemKey}] {item.title} ↗
                </a>
              ) : (
                <span className="today-problem-title">
                  [{item.problemKey}] {item.title}
                </span>
              )}
            </div>
            <Space size={6} wrap className="due-review-actions">
              {FEEDBACK_META.map((f) => (
                <Tooltip key={f.key} title={f.tip}>
                  <Button
                    size="small"
                    type={f.key === 'ok' ? 'primary' : 'default'}
                    danger={f.danger}
                    loading={pending === item.id}
                    onClick={() => void feedback(item, f.key)}
                  >
                    {f.label}
                  </Button>
                </Tooltip>
              ))}
            </Space>
          </div>
        )
      })}
      <p className="muted-note" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
        <ReadOutlined /> 反馈即推进复习排期：困难 → 退回两档；掌握 → 前进一档；轻松 → 跳进两档。
      </p>
    </div>
  )
}
