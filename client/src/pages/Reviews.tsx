import { useCallback, useEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { Button, Card, Input, Modal, Popconfirm, Select, Space, Tag, Tooltip, App as AntdApp } from 'antd'
import { DeleteOutlined, EditOutlined, HistoryOutlined, ReadOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import PlatformTag from '../components/PlatformTag'
import NoteEditor from '../components/NoteEditor'
import NoteCardButton from '../components/NoteCardButton'
import ReviewHistoryDrawer from '../components/ReviewHistoryDrawer'
import { difficultyColor, platformName } from '../ui'
import { del, get, patch } from '../api'
import { useReviewFeedback } from '../useReviewFeedback'
import { FEEDBACK_META, dueText, filterReviewItems } from '../reviewDue'
import type { ReviewItem } from '../types'
import { PLATFORMS, type PlatformId } from '../../../shared/src/index.ts'

export default function Reviews() {
  const { message } = AntdApp.useApp()
  const nav = useNavigate()
  const [items, setItems] = useState<ReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'due' | 'all'>('due')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [historyItem, setHistoryItem] = useState<ReviewItem | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [editing, setEditing] = useState<ReviewItem | null>(null)
  const [noteDraft, setNoteDraft] = useState('')

  const load = useCallback((f: 'due' | 'all') => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setLoadError(null)
    get<ReviewItem[]>(`/api/reviews${f === 'due' ? '?due=1' : ''}`, { signal: ctrl.signal })
      .then((r) => {
        if (ctrl.signal.aborted) return
        setItems(r)
        setLoadError(null)
      })
      // 失败 ≠ 没有数据：接口失败时 items 保持空，旧实现会被下面的空态渲染成
      // 「复习队列还是空的 —— 到题目管理加题」，把一次超时误导成用户自己的问题。
      // 这里落到 loadError，由 InlineError 出错误态 + 重试（重试沿用当前筛选）。
      .catch((e: Error) => {
        if (ctrl.signal.aborted) return
        setLoadError(e.message)
        message.error(e.message)
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
  }, [message])

  useEffect(() => {
    load(filter)
    return () => { abortRef.current?.abort() }
  }, [filter, load])

  const { feedback, pending } = useReviewFeedback(() => load(filter))

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
  const filteredItems = filterReviewItems(items, query, platform === 'all' ? undefined : platform)
  const hasFilters = query.trim() !== '' || platform !== 'all'
  const clearFilters = () => { setQuery(''); setPlatform('all') }

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

      {(items.length > 0 || hasFilters) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Input value={query} onChange={event => setQuery(event.target.value)} allowClear prefix={<SearchOutlined />}
            placeholder="搜索题号、题名、知识点或笔记" aria-label="搜索复习队列"
            style={{ flex: '1 1 260px', maxWidth: 420 }} />
          <Select<PlatformId | 'all'> value={platform} onChange={setPlatform} aria-label="筛选复习平台" style={{ width: 160 }}
            options={[{ value: 'all', label: '全部平台' }, ...PLATFORMS.map(p => ({ value: p.id, label: p.name }))]} />
          {hasFilters && <Button type="link" onClick={clearFilters}>清除筛选</Button>}
          <span className="muted-note" role="status">显示 {filteredItems.length} / {items.length} 道</span>
        </div>
      )}

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
      ) : hasFilters && filteredItems.length === 0 ? (
        <Card><EmptyState title="没有匹配的复习题" description="筛选仅作用于当前队列，可清除条件，或切换到全部队列查看。"
          actions={[
            { label: '清除筛选', type: 'primary', onClick: clearFilters },
            ...(filter === 'due' ? [{ label: '查看全部队列', type: 'default' as const, onClick: () => setFilter('all') }] : []),
          ]} /></Card>
      ) : items.length === 0 ? (
        <Card>
          {/* description 只解释「为什么是空的」，出路给成真按钮：去题目管理加题 / 切到另一个筛选 */}
          {filter === 'due' ? (
            <EmptyState
              title="暂无到期的复习"
              description="复习项会按 3/7/14/30/60/120/240/480 天的间隔排期，今天没有到期的说明都还在间隔期内。也可以直接看整个队列。"
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
          {filteredItems.map((item) => {
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
                      <Tag className="dot-tag" color={due.overdue ? 'error' : due.due ? 'processing' : 'default'}>
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
                  {/* 笔记入口：点击弹出笔记查看卡片（仿赛事中心弹窗），卡片内可直接进入编辑 */}
                  {item.note && (
                    <NoteCardButton
                      kind="review"
                      subject={`[${item.problemKey}] ${item.title}`}
                      text={item.note}
                      meta={(
                        <>
                          <span>{platformName(item.platform)}</span>
                          <span>{due.text}</span>
                          <span>间隔 {item.intervalDays} 天 · 第 {item.stage + 1} 档</span>
                          {item.reviewCount > 0 && <span>已复习 {item.reviewCount} 次</span>}
                        </>
                      )}
                      onEdit={() => {
                        setEditing(item)
                        setNoteDraft(item.note ?? '')
                      }}
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
                          loading={pending === item.id}
                          disabled={pending !== null && pending !== item.id}
                          onClick={() => feedback(item, f.key)}
                        >
                          {f.label}
                        </Button>
                      </Tooltip>
                    ))}
                    <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryItem(item)}>记录</Button>
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
            <ReadOutlined /> 反馈节奏：困难 → 退回两档；掌握 → 进入下一档间隔（3/7/14/30/60/120/240/480 天）；轻松 → 跳进两档。
          </p>
        </div>
      )}

      <ReviewHistoryDrawer key={historyItem?.id ?? 'closed'} item={historyItem} onClose={() => setHistoryItem(null)} />

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
