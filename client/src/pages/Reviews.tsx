import { useCallback, useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { Button, Card, Modal, Popconfirm, Space, Tag, Tooltip, App as AntdApp } from 'antd'
import { DeleteOutlined, EditOutlined, ReadOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import PlatformTag from '../components/PlatformTag'
import NoteEditor from '../components/NoteEditor'
import NotePreview from '../components/NotePreview'
import { difficultyColor } from '../ui'
import { del, get, patch, post } from '../api'
import { FEEDBACK_META } from '../reviewDue'
import type { ReviewFeedback, ReviewItem } from '../types'

function dueText(item: ReviewItem): { text: string; overdue: boolean } {
  // 本地日界（dayjs）：与日历页「今天」一致；UTC 取日会让本地 0–8 点的「今日到期」错位一天
  const today = dayjs().format('YYYY-MM-DD')
  if (item.nextDueOn < today) return { text: `逾期 ${item.nextDueOn}`, overdue: true }
  if (item.nextDueOn === today) return { text: '今日到期', overdue: true }
  return { text: item.nextDueOn, overdue: false }
}

export default function Reviews() {
  const { message } = AntdApp.useApp()
  const nav = useNavigate()
  const [items, setItems] = useState<ReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'due' | 'all'>('due')
  const [editing, setEditing] = useState<ReviewItem | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  // 展开的笔记条目 id：状态提升到页面持有，因为「展开/收起」按钮要放在右侧操作列（编辑按钮下方）
  const [openNoteIds, setOpenNoteIds] = useState<ReadonlySet<number>>(new Set())

  const load = useCallback((f: 'due' | 'all') => {
    setLoading(true)
    setLoadError(null)
    get<ReviewItem[]>(`/api/reviews${f === 'due' ? '?due=1' : ''}`)
      .then((r) => {
        setItems(r)
        setLoadError(null)
        // 每次重取列表后回到默认收起（列表重挂载，展开状态不跨刷新保留）
        setOpenNoteIds(new Set())
      })
      // 失败 ≠ 没有数据：接口失败时 items 保持空，旧实现会被下面的空态渲染成
      // 「复习队列还是空的 —— 到题目管理加题」，把一次超时误导成用户自己的问题。
      // 这里落到 loadError，由 InlineError 出错误态 + 重试（重试沿用当前筛选）。
      .catch((e: Error) => {
        setLoadError(e.message)
        message.error(e.message)
      })
      .finally(() => setLoading(false))
  }, [])

  const toggleNoteOpen = (id: number) =>
    setOpenNoteIds((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

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

  const dueCount = items.filter((i) => i.nextDueOn <= dayjs().format('YYYY-MM-DD')).length

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

      {/* 首屏骨架：复习库是「一列复习卡」的列表页（没有统计带），用表格行占位贴近真实首屏。
          只在「还没有任何一行可显示」时占位：本页每次反馈 / 移除 / 存笔记都会重拉列表，
          若 loading 就整页退回骨架，点一下按钮全页闪一次。与 Problems / Contests 同款判断。 */}
      {loading && items.length === 0 ? (
        <PageSkeleton stats={false} table rows={4} />
      ) : loadError ? (
        /* 失败 ≠ 空态：接口失败时给可重试的错误态，而不是「复习队列还是空的」 */
        <InlineError
          message={loadError}
          hint="这块本来显示的是你的复习队列（到期时间、间隔档位与笔记），重试即按当前筛选重新拉取"
          onRetry={() => load(filter)}
          retrying={loading}
        />
      ) : items.length === 0 ? (
        <Card>
          {/* description 只解释「为什么是空的」，出路给成真按钮：去题目管理加题 / 切到另一个筛选 */}
          {filter === 'due' ? (
            <EmptyState
              title="暂无到期的复习"
              description="复习项会按 1/3/7/14/30/60 天的间隔排期，今天没有到期的说明都还在间隔期内。也可以直接看整个队列。"
              actions={[
                { label: '去题目管理加题', type: 'primary', onClick: () => nav('/problems') },
                { label: '查看全部队列', type: 'default', onClick: () => setFilter('all') },
              ]}
            />
          ) : (
            <EmptyState
              title="复习队列还是空的"
              description="复习队列靠手动加入：在题目管理里把错题和值得重做的题加进来，或到今日训练把推荐题加入复习。"
              actions={[
                { label: '去题目管理', type: 'primary', onClick: () => nav('/problems') },
                { label: '去看今日训练', type: 'default', onClick: () => nav('/today') },
              ]}
            />
          )}
        </Card>
      ) : (
        /* 卡片列表显式单列：列向 flex（任何断点下都不会被挤成多列或撑出横向滚动），
           gap 给出相邻复习卡之间的间距 —— 此前是默认块级堆叠、卡片紧贴无间距 */
        <div className="review-list" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {items.map((item) => {
            const due = dueText(item)
            return (
              <Card
                key={item.id}
                size="small"
                className="review-item"
                // ≤768px：卡片内「内容 | 操作」这一行转纵向，操作组整体下沉到内容下方
                // （@media(max-width:720px) 的老规则只覆盖 ≤720，这里用同一 class 统一到 768）
                classNames={{ body: 'card-actions-row' }}
              >
                <div className="review-item-main">
                  <div className="today-problem-head">
                    <PlatformTag id={item.platform} />
                    {item.difficulty != null && (
                      <span className="rating-pill mono" style={{ color: difficultyColor(item.difficulty) }}>
                        {item.difficulty}
                      </span>
                    )}
                    <Tooltip
                      title={`间隔 ${item.intervalDays} 天 · 第 ${item.stage + 1} 档 · 已复习 ${item.reviewCount} 次${
                        item.lapseCount > 0 ? `（其中 ${item.lapseCount} 次判为困难）` : ''
                      }`}
                    >
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
                  {/* issue #27：折叠时整段隐藏；展开按钮由操作列渲染（编辑按钮下方），进入页面默认收起 */}
                  {item.note && (
                    <NotePreview
                      text={item.note}
                      collapseMode="hidden"
                      expanded={openNoteIds.has(item.id)}
                      onToggleExpanded={() => toggleNoteOpen(item.id)}
                    />
                  )}
                </div>
                <div className="review-item-actions">
                  {/* ≤768px：反馈 / 编辑 / 移除按钮行由横排转竖排下沉，避免窄屏被压成两行截断 */}
                  <Space size={6} wrap className="card-actions-row">
                    {FEEDBACK_META.map((f) => (
                      <Tooltip key={f.key} title={f.tip}>
                        <Button
                          size="small"
                          type={f.key === 'ok' ? 'primary' : 'default'}
                          danger={f.danger}
                          onClick={() => feedback(item, f.key)}
                        >
                          {f.label}
                        </Button>
                      </Tooltip>
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
                  {/* 笔记展开/收起：右对齐到图标按钮下方（编辑按钮正下方，issue #27） */}
                  {item.note && (
                    <button
                      type="button"
                      className="note-preview-toggle"
                      onClick={() => toggleNoteOpen(item.id)}
                    >
                      {openNoteIds.has(item.id) ? '收起' : '展开'}
                    </button>
                  )}
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
        width={880}
      >
        {editing && (
          /* key 换条目时重挂编辑器：预览模式等界面状态回到默认，光标清零 */
          <NoteEditor
            key={editing.id}
            value={noteDraft}
            onChange={setNoteDraft}
            height={420}
            maxLength={20000}
            placeholder="关键观察、易错点、下次复习先看什么……（Markdown 语法，可直接粘贴 / 拖入截图）"
          />
        )}
      </Modal>
    </div>
  )
}
