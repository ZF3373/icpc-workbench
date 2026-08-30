import { useCallback, useEffect, useState } from 'react'
import { Button, Card, Empty, Input, message, Modal, Popconfirm, Space, Spin, Tag, Tooltip } from 'antd'
import { DeleteOutlined, EditOutlined, ReadOutlined } from '@ant-design/icons'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { difficultyColor } from '../ui'
import { del, get, patch, post } from '../api'
import type { ReviewFeedback, ReviewItem } from '../types'

const FEEDBACK_META: Array<{ key: ReviewFeedback; label: string; tone: 'danger' | 'primary' | 'default' }> = [
  { key: 'hard', label: '困难 · 明天再来', tone: 'danger' },
  { key: 'ok', label: '掌握 · 按计划推进', tone: 'primary' },
  { key: 'easy', label: '轻松 · 跳进两档', tone: 'default' },
]

function dueText(item: ReviewItem): { text: string; overdue: boolean } {
  const today = new Date().toISOString().slice(0, 10)
  if (item.nextDueOn < today) return { text: `逾期 ${item.nextDueOn}`, overdue: true }
  if (item.nextDueOn === today) return { text: '今日到期', overdue: true }
  return { text: item.nextDueOn, overdue: false }
}

export default function Reviews() {
  const [items, setItems] = useState<ReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'due' | 'all'>('due')
  const [editing, setEditing] = useState<ReviewItem | null>(null)
  const [noteDraft, setNoteDraft] = useState('')

  const load = useCallback((f: 'due' | 'all') => {
    setLoading(true)
    get<ReviewItem[]>(`/api/reviews${f === 'due' ? '?due=1' : ''}`)
      .then(setItems)
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(filter)
  }, [filter, load])

  const feedback = async (item: ReviewItem, f: ReviewFeedback) => {
    try {
      const r = await post<{ stage: number; nextDueOn: string }>(`/api/reviews/${item.id}/feedback`, { feedback: f })
      message.success(`下次复习：${r.nextDueOn}`)
      load(filter)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const remove = async (item: ReviewItem) => {
    try {
      await del(`/api/reviews/${item.id}`)
      message.success('已移出复习队列')
      load(filter)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveNote = async () => {
    if (!editing) return
    try {
      await patch(`/api/reviews/${editing.id}`, { note: noteDraft })
      message.success('笔记已保存')
      setEditing(null)
      load(filter)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const dueCount = items.filter((i) => i.nextDueOn <= new Date().toISOString().slice(0, 10)).length

  return (
    <div>
      <PageHeader
        title="复习库"
        description="AC 不等于从此记住 —— 间隔复习把短暂理解变成稳定能力"
        extra={
          <Space>
            <Button type={filter === 'due' ? 'primary' : 'default'} onClick={() => setFilter('due')}>
              到期复习{dueCount > 0 ? ` · ${dueCount}` : ''}
            </Button>
            <Button type={filter === 'all' ? 'primary' : 'default'} onClick={() => setFilter('all')}>
              全部队列
            </Button>
          </Space>
        }
      />

      {loading ? (
        <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
      ) : items.length === 0 ? (
        <Card>
          <Empty
            description={
              filter === 'due'
                ? '没有到期的复习 —— 到「题目管理」或「今日训练」把值得重做的题加入队列'
                : '复习队列还是空的 —— 到「题目管理」把错题和值得重做的题加入队列'
            }
          />
        </Card>
      ) : (
        <div className="review-list">
          {items.map((item) => {
            const due = dueText(item)
            return (
              <Card key={item.id} size="small" className="review-item">
                <div className="review-item-main">
                  <div className="today-problem-head">
                    <PlatformTag id={item.platform} />
                    {item.difficulty != null && (
                      <span className="rating-pill mono" style={{ color: difficultyColor(item.difficulty) }}>
                        {item.difficulty}
                      </span>
                    )}
                    <Tooltip title={`间隔 ${item.intervalDays} 天 · 第 ${item.stage + 1} 档`}>
                      <Tag className="dot-tag" color={due.overdue ? 'error' : 'processing'}>
                        {due.text}
                      </Tag>
                    </Tooltip>
                  </div>
                  {item.url ? (
                    <a className="today-problem-title" href={item.url} target="_blank" rel="noreferrer">
                      [{item.problemKey}] {item.title} ↗
                    </a>
                  ) : (
                    <span className="today-problem-title">
                      [{item.problemKey}] {item.title}
                    </span>
                  )}
                  {item.note && <p className="task-note">{item.note}</p>}
                </div>
                <div className="review-item-actions">
                  <Space size={6} wrap>
                    {FEEDBACK_META.map((f) => (
                      <Button
                        key={f.key}
                        size="small"
                        type={f.key === 'ok' ? 'primary' : f.key === 'hard' ? 'default' : 'default'}
                        danger={f.key === 'hard'}
                        onClick={() => feedback(item, f.key)}
                      >
                        {f.label.split(' · ')[0]}
                      </Button>
                    ))}
                    <Button
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      title="编辑笔记"
                      onClick={() => {
                        setEditing(item)
                        setNoteDraft(item.note ?? '')
                      }}
                    />
                    <Popconfirm title="移出复习队列？" okText="移除" cancelText="取消" onConfirm={() => remove(item)}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} title="移出队列" />
                    </Popconfirm>
                  </Space>
                </div>
              </Card>
            )
          })}
          <p className="muted-note" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ReadOutlined /> 反馈节奏：困难 → 明天重来；掌握 → 进入下一档间隔（1/3/7/14/30/60 天）；轻松 → 跳进两档。
          </p>
        </div>
      )}

      <Modal
        title={`复习笔记 · ${editing?.problemKey ?? ''}`}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={saveNote}
        okText="保存"
        cancelText="取消"
      >
        <Input.TextArea
          rows={4}
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="关键观察、易错点、下次复习先看什么……"
        />
      </Modal>
    </div>
  )
}
