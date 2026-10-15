import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Drawer, Pagination, Skeleton, Space, Tag, Timeline } from 'antd'
import { api } from '../api'
import { FEEDBACK_META, reviewTimingText } from '../reviewDue'
import type { ReviewHistory, ReviewItem } from '../../../shared/src/index.ts'
import EmptyState from './EmptyState'
import InlineError from './InlineError'
import PlatformTag from './PlatformTag'

const PAGE_SIZE = 20

/** 复习库、今日训练、日历共用；关闭或换页时中止旧请求，避免串题。 */
export default function ReviewHistoryDrawer({ item, onClose }: { item: ReviewItem | null; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const [history, setHistory] = useState<ReviewHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const itemId = item?.id

  useEffect(() => {
    if (itemId === undefined) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setHistory(null)
    api<ReviewHistory>(`/api/reviews/${itemId}/history?page=${page}&pageSize=${PAGE_SIZE}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setHistory(result) })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [itemId, page, retry])

  return (
    <Drawer title="复习记录" open={item !== null} onClose={onClose} width={640}>
      {item && <p style={{ marginTop: 0, overflowWrap: 'anywhere' }}><b>[{item.problemKey}] {item.title}</b></p>}
      <p className="muted-note">包含原题与镜像的复习记录，最近的记录排在前面。</p>
      {loading ? <Skeleton active title={false} paragraph={{ rows: 5 }} /> : error ? (
        <InlineError message={error} hint="复习记录加载失败，可重试或关闭后重新打开。"
          onRetry={() => setRetry(value => value + 1)} retrying={loading} />
      ) : history && history.total === 0 ? (
        <EmptyState title="还没有复习记录" description="完成一次复习并选择反馈后，就能在这里回看排期变化。"
          action={{ label: '返回复习', onClick: onClose }} compact />
      ) : history && (
        <>
          <Space size={12} wrap style={{ marginBottom: 24 }}>
            <span>共复习 <b className="mono">{history.total}</b> 次</span>
            <span>其中困难 <b className="mono">{history.lapseCount}</b> 次</span>
          </Space>
          <Timeline items={history.items.map(event => {
            const meta = FEEDBACK_META.find(feedback => feedback.key === event.feedback)
            const color = event.feedback === 'hard' ? 'red' : event.feedback === 'easy' ? 'green' : 'blue'
            return {
              key: event.id,
              color,
              children: <div>
                <Space size={6} wrap>
                  <time dateTime={event.reviewedAt} className="mono">{dayjs(event.reviewedAt).format('YYYY-MM-DD HH:mm')}</time>
                  <Tag color={color}>{meta?.label ?? event.feedback}</Tag>
                  <span>{reviewTimingText(event.reviewedAt, event.dueOn)}</span>
                </Space>
                <p style={{ margin: '8px 0' }}>第 {event.stageBefore + 1} 档 → 第 {event.stageAfter + 1} 档 · 当时安排 {event.intervalDays} 天后复习</p>
                <p className="muted-note" style={{ margin: '4px 0' }}>
                  原定到期 {event.dueOn} · 留存系数 ×{event.factor.toFixed(2)}
                </p>
                <Space size={6} wrap><PlatformTag id={event.platform} /><span className="mono">{event.problemKey}</span></Space>
              </div>,
            }
          })} />
          <Pagination current={page} pageSize={PAGE_SIZE} total={history.total} size="small"
            showSizeChanger={false} hideOnSinglePage onChange={setPage} />
          <p className="muted-note">间隔与留存系数展示的是本次反馈时的结果，后续复习不会改写这些记录。</p>
        </>
      )}
    </Drawer>
  )
}
