import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BulbOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  HolderOutlined,
  PlusOutlined,
  TagsOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import type { PlatformId } from '../../../shared/src/index.ts'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import Markdown from '../components/Markdown'
import CardSkeleton from '../components/CardSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import { del, get, patch, post } from '../api'
import { difficultyColor } from '../ui'

/**
 * 题单整理（issue #4）：导入平台题单（粘贴文本自动识别题号/链接），
 * 按知识点分类（题库 tags 规则 / AI / 手动），AI 读取题单内容给练习建议。
 */

interface ListItemRow {
  id: number
  title: string
  source_url: string | null
  created_at: string
  item_count: number
  category_count: number
  solved_count: number
}

interface ListItem {
  id: number
  platform: string
  problem_key: string
  title: string | null
  url: string | null
  category: string
  position: number
  difficulty: number | null
  tags: string[]
  solved: boolean
}

interface ListDetail {
  id: number
  title: string
  source_url: string | null
  created_at: string
  aiSuggestion: string | null
  aiSuggestionAt: string | null
  items: ListItem[]
}

export default function Lists() {
  // React 19 下 antd 静态 message 静默失效，必须用 App 上下文实例
  const { message } = AntdApp.useApp()
  const [lists, setLists] = useState<ListItemRow[]>([])
  const [loading, setLoading] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [detail, setDetail] = useState<ListDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // 正在进行的操作（classify/ai-classify/ai-suggest）
  const [suggest, setSuggest] = useState<string | null>(null) // AI 建议内容
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [addItemOpen, setAddItemOpen] = useState(false) // 向已有题单追加题目
  const [importForm] = Form.useForm()
  const [addItemForm] = Form.useForm()
  /** 列表取数失败原因：与「一道题单都没有」严格区分（失败给重试，空给下一步动作） */
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    get<ListItemRow[]>('/api/lists')
      .then(setLists)
      .catch((e: Error) => {
        setLoadError(e.message)
        message.error(e.message)
      })
      .finally(() => setLoading(false))
  }, [message])

  useEffect(load, [load])

  const openDetail = async (id: number) => {
    setDetailLoading(true)
    setDetailOpen(true)
    try {
      const d = await get<ListDetail>(`/api/lists/${id}`)
      setDetail(d)
      // 从 DB 缓存恢复 AI 建议（有缓存则直接显示，无需重新调 AI）
      setSuggest(d.aiSuggestion)
    } catch (e) {
      message.error((e as Error).message)
      setDetailOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const reloadDetail = () => detail && openDetail(detail.id)

  const submitImport = async () => {
    const v = (await importForm.validateFields().catch(() => null)) as unknown as {
      title: string
      sourceUrl?: string
      raw: string
    } | null
    if (!v) return
    setBusy('import')
    try {
      const r = await post<{ id: number; imported: number; unrecognized: number }>('/api/lists', {
        title: v.title,
        raw: v.raw,
        sourceUrl: v.sourceUrl || undefined,
      })
      message.success(
        `已导入 ${r.imported} 道题${r.unrecognized > 0 ? `（${r.unrecognized} 行未识别已跳过）` : ''}`,
      )
      importForm.resetFields()
      setImportOpen(false)
      load()
      void openDetail(r.id)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // 向已有题单追加题目：与导入同格式（每行一题），服务端按身份去重跳过已存在的题
  const submitAddItems = async () => {
    if (!detail) return
    const v = (await addItemForm.validateFields().catch(() => null)) as unknown as { raw: string } | null
    if (!v) return
    setBusy('add-items')
    try {
      const r = await post<{ added: number; duplicates: number; unrecognized: number }>(
        `/api/lists/${detail.id}/items`,
        { raw: v.raw },
      )
      const extra: string[] = []
      if (r.duplicates > 0) extra.push(`${r.duplicates} 道已在题单中`)
      if (r.unrecognized > 0) extra.push(`${r.unrecognized} 行未识别`)
      const tail = extra.length > 0 ? `（${extra.join('，')}）` : ''
      if (r.added > 0) message.success(`已添加 ${r.added} 道题${tail}`)
      else message.info(`没有新题目${tail || '：题目均已存在'}`)
      addItemForm.resetFields()
      setAddItemOpen(false)
      reloadDetail()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const runClassify = async (mode: 'rule' | 'ai') => {    if (!detail) return
    setBusy(mode === 'rule' ? 'classify' : 'ai-classify')
    try {
      const r = await post<{ updated: number; total: number }>(`/api/lists/${detail.id}/${mode === 'rule' ? 'classify' : 'ai-classify'}`, {})
      message.success(mode === 'rule' ? `按题库分类完成：更新 ${r.updated}/${r.total} 道` : `AI 分类完成：更新 ${r.updated}/${r.total} 道`)
      reloadDetail()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const runSuggest = async (force = false) => {
    if (!detail) return
    // 有缓存且非强制刷新：直接打开 Modal 显示缓存内容，不重新请求
    if (!force && suggest) {
      setSuggestOpen(true)
      return
    }
    setBusy('ai-suggest')
    setSuggestOpen(true)
    setSuggest(null)
    try {
      const r = await post<{ reply: string; cached?: boolean; cachedAt?: string }>(
        `/api/lists/${detail.id}/ai-suggest`,
        force ? { force: true } : {},
      )
      setSuggest(r.reply)
    } catch (e) {
      if (!force) setSuggestOpen(false)
      message.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const removeList = async (id: number) => {
    try {
      await del(`/api/lists/${id}`)
      message.success('题单已删除')
      if (detail?.id === id) setDetailOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const changeCategory = async (itemId: number, category: string) => {
    try {
      await patch(`/api/lists/items/${itemId}`, { category })
      reloadDetail()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeItem = async (itemId: number) => {
    try {
      await del(`/api/lists/items/${itemId}`)
      reloadDetail()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // ---------- 拖拽排序（mouse 事件方案，与 SiderMenu / WebView2 兼容做法一致） ----------
  // 拖动行首手柄可把任意题移到任意位置（跨分类组也算），position 全量持久化到服务端；
  // 分类不受影响，分组视图由 position + category 派生。
  const [dragItemId, setDragItemId] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<{ id: number; pos: 'before' | 'after' } | null>(null)
  const dragIdRef = useRef<number | null>(null)
  const dragOverRef = useRef<{ id: number; pos: 'before' | 'after' } | null>(null)
  /** 释放后短暂高亮的行 id（配合 .list-item-row.is-just-dropped，900ms 后清除） */
  const [justDroppedId, setJustDroppedId] = useState<number | null>(null)
  const dropFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 释放后的高亮定时器必须在卸载时清掉，否则会往已卸载组件里 setState
  useEffect(
    () => () => {
      if (dropFlashTimer.current !== null) clearTimeout(dropFlashTimer.current)
      dropFlashTimer.current = null
    },
    [],
  )

  const flashJustDropped = (id: number) => {
    if (dropFlashTimer.current !== null) clearTimeout(dropFlashTimer.current)
    setJustDroppedId(id)
    dropFlashTimer.current = setTimeout(() => {
      dropFlashTimer.current = null
      setJustDroppedId(null)
    }, 900)
  }

  const clearDrag = () => {
    dragIdRef.current = null
    dragOverRef.current = null
    setDragItemId(null)
    setDragOver(null)
  }

  /** 撤销提示的 key：连续排序时先销毁上一条，避免提示堆叠刷屏 */
  const msgKeyRef = useRef(0)

  /**
   * 把新顺序落库，并在成功后给出 3 秒「撤销」提示。
   * 用函数式 setDetail，不依赖 detail 闭包，避免 Drawer 关闭/重开后操作到旧引用。
   */
  const commitReorder = useCallback(
    async (nextItems: ListItem[], prevItems: ListItem[], listId: number) => {
      const sameOrder =
        nextItems.map((i) => i.id).join('\u0000') === prevItems.map((i) => i.id).join('\u0000')
      if (sameOrder) return
      setDetail((current) => (current && current.id === listId ? { ...current, items: nextItems } : current))
      try {
        await post(`/api/lists/${listId}/reorder`, { orderedIds: nextItems.map((i) => i.id) })
        const key = `list-reorder-${(msgKeyRef.current += 1)}`
        message.destroy(key)
        message.open({
          key,
          type: 'success',
          duration: 3,
          content: (
            <span>
              已调整做题顺序
              <Button
                type="link"
                size="small"
                icon={<UndoOutlined />}
                onClick={() => {
                  message.destroy(key)
                  setDetail((current) =>
                    current && current.id === listId ? { ...current, items: prevItems } : current,
                  )
                  post(`/api/lists/${listId}/reorder`, { orderedIds: prevItems.map((i) => i.id) })
                    .then(() => message.info('已恢复排序前的顺序'))
                    .catch((err) => message.error((err as Error).message))
                }}
              >
                撤销
              </Button>
            </span>
          ),
        })
      } catch (e) {
        message.error((e as Error).message)
        setDetail((current) => (current && current.id === listId ? { ...current, items: prevItems } : current))
      }
    },
    [message],
  )

  const applyReorder = useCallback(
    async (dragId: number, targetId: number, pos: 'before' | 'after') => {
      if (!detail || dragId === targetId) return
      const items = [...detail.items]
      const from = items.findIndex((i) => i.id === dragId)
      if (from === -1) return
      const [moved] = items.splice(from, 1)
      const to = items.findIndex((i) => i.id === targetId)
      if (to === -1) return
      items.splice(pos === 'after' ? to + 1 : to, 0, moved)
      await commitReorder(items, detail.items, detail.id)
    },
    [detail, commitReorder],
  )

  /** 键盘排序：在全局 position 列表中上移/下移一格（跨分类也允许） */
  const moveItemBy = useCallback(
    async (itemId: number, delta: -1 | 1) => {
      if (!detail) return
      const items = [...detail.items]
      const from = items.findIndex((i) => i.id === itemId)
      if (from === -1) return
      const to = from + delta
      if (to < 0 || to >= items.length) return
      const [moved] = items.splice(from, 1)
      items.splice(to, 0, moved)
      await commitReorder(items, detail.items, detail.id)
    },
    [detail, commitReorder],
  )

  // 拖拽中松手：按最近 hover 的落点执行重排（松手在列表外则丢弃）
  useEffect(() => {
    if (dragItemId === null) return
    const onUp = () => {
      const dragId = dragIdRef.current
      const over = dragOverRef.current
      clearDrag()
      if (dragId !== null && over && over.id !== dragId) {
        // 视觉反馈：落点行 900ms 高亮；落点判定逻辑本身不变
        flashJustDropped(over.id)
        void applyReorder(dragId, over.id, over.pos)
      }
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [dragItemId, applyReorder])

  const startDrag = (e: ReactMouseEvent, itemId: number) => {
    e.preventDefault() // 阻止默认行为避免拖拽时选中文本
    if (dropFlashTimer.current !== null) {
      clearTimeout(dropFlashTimer.current)
      dropFlashTimer.current = null
    }
    setJustDroppedId(null)
    dragIdRef.current = itemId
    setDragItemId(itemId)
  }

  // 落点上下半区在进入行与行内移动时都要更新：长行里指针从下半滑到上半不会重新触发 enter
  const rowDragEnter = (e: ReactMouseEvent, itemId: number) => {
    if (dragIdRef.current === null || dragIdRef.current === itemId) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pos: 'before' | 'after' = e.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
    if (dragOverRef.current?.id === itemId && dragOverRef.current?.pos === pos) return
    dragOverRef.current = { id: itemId, pos }
    setDragOver({ id: itemId, pos })
  }

  // 按分类分组：同分类合并成一组，组序 = 该分类在题单中的首次出现位置，组内保持原顺序。
  // 分类（按题库/AI）只改 category 不动 position——分组视图因此不会打乱导入时的整体先后关系。
  const groups: Array<{ category: string; items: ListItem[] }> = []
  if (detail) {
    const byCategory = new Map<string, ListItem[]>()
    for (const it of detail.items) {
      const arr = byCategory.get(it.category)
      if (arr) arr.push(it)
      else byCategory.set(it.category, [it])
    }
    for (const [category, items] of byCategory) groups.push({ category, items })
  }

  return (
    <div>
      <PageHeader
        title="题单整理"
        description="导入平台题单（支持洛谷 / Codeforces / AtCoder / 代码源 / 牛客的题号或链接，每行一题），按知识点分类；AI 可读取题单内容结合你的弱项给出练习建议。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            导入题单
          </Button>
        }
      />
      {loading && lists.length === 0 ? (
        // 首屏用骨架屏占住卡片区：数据落地时只有内容变化，没有整页位移（§6.3）
        <Card>
          <CardSkeleton variant="list" rows={6} />
        </Card>
      ) : lists.length > 0 ? (
        // 题单卡片化（P6-3）：题数 / 分类数 / 已掌握进度 / 时间一眼可见，点卡片进详情。
        // 字段全部来自既有 GET /api/lists（item_count / category_count / solved_count / created_at），未新增请求。
        <Spin spinning={loading}>
          <div className="list-card-grid">
            {lists.map((l) => {
              const pct = l.item_count > 0 ? Math.round((l.solved_count / l.item_count) * 100) : 0
              const active = detailOpen && detail?.id === l.id
              return (
                <div
                  key={l.id}
                  className={`list-card${active ? ' is-active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`打开题单「${l.title}」详情`}
                  onClick={() => void openDetail(l.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      void openDetail(l.id)
                    }
                  }}
                >
                  <div className="list-card-title" title={l.title}>
                    {l.title}
                  </div>
                  <div className="list-card-meta">
                    <span className="mono">{l.item_count} 题</span>
                    <span className="mono">{l.category_count} 个分类</span>
                    <span className="mono">
                      已掌握 {l.solved_count}/{l.item_count} · {pct}%
                    </span>
                  </div>
                  {/* 进度条只是上面那行数字的可视化，读屏不必重复读一次 */}
                  <div
                    aria-hidden="true"
                    style={{ height: 4, borderRadius: 2, background: 'var(--line)', overflow: 'hidden' }}
                  >
                    <div style={{ width: `${pct}%`, height: '100%', background: 'var(--green)' }} />
                  </div>
                  <div className="list-card-meta">
                    <span className="mono">创建 {dayjs(l.created_at).format('YYYY-MM-DD')}</span>
                    {l.source_url ? (
                      <a href={l.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        来源 ↗
                      </a>
                    ) : (
                      <span>粘贴导入</span>
                    )}
                  </div>
                  {/* 卡内操作：阻止冒泡，避免点删除/详情时又触发一次卡片点击 */}
                  <div
                    style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    role="presentation"
                  >
                    <Button size="small" type="link" onClick={() => void openDetail(l.id)}>
                      详情
                    </Button>
                    <Popconfirm
                      title="删除题单"
                      description="将删除题单及其全部条目"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => removeList(l.id)}
                    >
                      <Button size="small" danger type="link">
                        删除
                      </Button>
                    </Popconfirm>
                  </div>
                </div>
              )
            })}
          </div>
        </Spin>
      ) : null}
      {/* 加载失败 ≠ 没有题单：失败给可重试的错误态，空给真实的下一步动作 */}
      {!loading && loadError && (
        <Card style={{ marginTop: 16 }}>
          <InlineError
            message={loadError}
            hint="题单列表没能取回来；重试即可，已导入的题单没有改动。"
            onRetry={load}
            retrying={loading}
          />
        </Card>
      )}
      {!loading && !loadError && lists.length === 0 && (
        <Card style={{ marginTop: 16 }}>
          <EmptyState
            title="还没有题单"
            description="导入平台题单后可以按知识点分类，AI 还能结合你的弱项给出练习建议。支持洛谷 / Codeforces / AtCoder / 代码源 / 牛客的题号或链接，每行一题。"
            action={{ label: '导入题单', type: 'primary', icon: <PlusOutlined />, onClick: () => setImportOpen(true) }}
          />
        </Card>
      )}

      <Drawer
        title={detail?.title}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={720}
        extra={
          <Space wrap>
            <Button size="small" icon={<PlusOutlined />} loading={busy === 'add-items'} onClick={() => setAddItemOpen(true)}>
              添加题目
            </Button>
            <Button size="small" icon={<TagsOutlined />} loading={busy === 'classify'} onClick={() => void runClassify('rule')}>
              按题库分类
            </Button>
            <Button size="small" icon={<ExperimentOutlined />} loading={busy === 'ai-classify'} onClick={() => void runClassify('ai')}>
              AI 分类
            </Button>
            <Button size="small" type="primary" ghost icon={<BulbOutlined />} loading={busy === 'ai-suggest'} onClick={() => void runSuggest()}>
              AI 建议
            </Button>
          </Space>
        }
      >
        {detailLoading && <Spin style={{ display: 'block', margin: '40px auto' }} />}
        {!detailLoading && detail && (
          <>
            <p style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 12 }}>
              共 {detail.items.length} 题 · 已完成 {detail.items.filter((i) => i.solved).length} 题；同分类合并成组（按首次出现排序），组内保持导入原顺序；
              「按题库分类」依据已同步题库的标签，覆盖不到的用「AI 分类」或手动调整。拖动行首手柄可调整做题顺序，「添加题目」可向题单追加新题。
            </p>
            <div style={{ userSelect: dragItemId !== null ? 'none' : undefined }}>
            {groups.map((g) => (
              <div key={g.category} style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  <Tag color="geekblue">{g.category}</Tag>
                  <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{g.items.length} 题</span>
                </div>
                {g.items.map((it) => {
                  const link = it.url
                  // 无题名（或历史数据里解析残留的 "https://" 假题名）时直接显示题号，
                  // 此时旁边不再重复展示小字题号
                  const rawTitle = it.title?.trim()
                  const hasTitle = !!rawTitle && !/^https?:\/\//i.test(rawTitle)
                  const name = hasTitle ? rawTitle : it.problem_key
                  const isDragging = dragItemId === it.id
                  const isDropTarget = dragOver?.id === it.id && dragItemId !== null && dragItemId !== it.id
                  const isJustDropped = justDroppedId === it.id
                  const rowClass = [
                    'list-item-row',
                    isDragging ? 'is-dragging' : '',
                    isDropTarget ? 'is-drop-target' : '',
                    isJustDropped ? 'is-just-dropped' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <div
                      key={it.id}
                      className={rowClass}
                      // 行内不再写临时高亮：拖拽态交给上面的 class（.is-dragging 也是 opacity，
                      // 所以拖起时让出内联 opacity，否则已 AC 行的 0.55 会盖掉 .is-dragging）
                      style={isDragging ? undefined : { opacity: it.solved ? 0.55 : 1 }}
                      onMouseEnter={(e) => rowDragEnter(e, it.id)}
                      onMouseMove={(e) => rowDragEnter(e, it.id)}
                    >
                      <Space size={8} wrap style={{ flex: 1 }}>
                        <span className="list-item-reorder" title="拖拽排序">
                          <span className="drag-handle" onMouseDown={(e) => startDrag(e, it.id)}>
                            <HolderOutlined />
                          </span>
                          <Tooltip title="上移">
                            <Button
                              type="text"
                              size="small"
                              className="reorder-btn"
                              icon={<ArrowUpOutlined />}
                              disabled={detail?.items.findIndex((i) => i.id === it.id) === 0}
                              onClick={() => void moveItemBy(it.id, -1)}
                              aria-label="上移该题"
                            />
                          </Tooltip>
                          <Tooltip title="下移">
                            <Button
                              type="text"
                              size="small"
                              className="reorder-btn"
                              icon={<ArrowDownOutlined />}
                              disabled={detail?.items.findIndex((i) => i.id === it.id) === (detail?.items.length ?? 0) - 1}
                              onClick={() => void moveItemBy(it.id, 1)}
                              aria-label="下移该题"
                            />
                          </Tooltip>
                        </span>
                        <PlatformTag id={it.platform as PlatformId} />
                        {link ? (
                          <a href={link} target="_blank" rel="noreferrer">
                            <b>{name}</b>
                          </a>
                        ) : (
                          <b>{name}</b>
                        )}
                        {hasTitle && rawTitle !== it.problem_key && (
                          <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                            {it.problem_key}
                          </span>
                        )}
                        {it.difficulty !== null && (
                          <span className="mono" style={{ fontSize: 12, color: difficultyColor(it.difficulty) }}>
                            {it.difficulty}
                          </span>
                        )}
                        {it.solved && <Tag color="success">已AC</Tag>}
                      </Space>
                      <Space size={4}>
                        <Select
                          size="small"
                          style={{ minWidth: 110 }}
                          value={it.category}
                          showSearch
                          onChange={(v) => void changeCategory(it.id, v)}
                          options={[...new Set([...groups.map((x) => x.category), '其他'])].map((c) => ({ value: c, label: c }))}
                        />
                        <Popconfirm title="移除该题" okText="移除" cancelText="取消" onConfirm={() => void removeItem(it.id)}>
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    </div>
                  )
                })}
              </div>
            ))}
            </div>
          </>
        )}
      </Drawer>

      <Modal
        title="导入题单"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={submitImport}
        okText="导入"
        cancelText="取消"
        confirmLoading={busy === 'import'}
        width={640}
      >
        <Form form={importForm} layout="vertical">
          <Form.Item name="title" label="题单名称" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="如：二分专题 20 题" />
          </Form.Item>
          <Form.Item name="sourceUrl" label="来源链接（可选）">
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item
            name="raw"
            label="题目列表（每行一题）"
            rules={[{ required: true, message: '请粘贴题目列表' }]}
          >
            <Input.TextArea
              rows={10}
              placeholder={
                '支持题号或链接，自动识别平台：\nP1001 A+B Problem\nhttps://www.luogu.com.cn/problem/P1001\nCF1234A\nhttps://codeforces.com/contest/1234/problem/A\nabc300_a\nhttps://bs.daimayuan.top/p/7'
              }
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="从平台题单页全选复制粘贴即可；无法识别的行会自动跳过并在导入结果中提示。"
          />
        </Form>
      </Modal>

      <Modal
        title={detail ? `添加题目到「${detail.title}」` : '添加题目'}
        open={addItemOpen}
        onCancel={() => setAddItemOpen(false)}
        onOk={submitAddItems}
        okText="添加"
        cancelText="取消"
        confirmLoading={busy === 'add-items'}
        width={640}
      >
        <Form form={addItemForm} layout="vertical">
          <Form.Item
            name="raw"
            label="题目列表（每行一题）"
            rules={[{ required: true, message: '请粘贴题目列表' }]}
          >
            <Input.TextArea
              rows={6}
              placeholder={
                '与导入题单相同的格式，支持题号或链接：\nCF1234A\nhttps://www.luogu.com.cn/problem/P1001\nabc300_a\nhttps://bs.daimayuan.top/p/7'
              }
            />
          </Form.Item>
        </Form>
        <Alert
          type="info"
          showIcon
          message="新题目会追加到题单末尾并自动分类；已在题单中的题（含镜像同题）会自动跳过。"
        />
      </Modal>

      <Modal
        title="AI 练习建议"
        open={suggestOpen}
        onCancel={() => setSuggestOpen(false)}
        footer={
          suggest ? (
            <Button
              size="small"
              loading={busy === 'ai-suggest'}
              onClick={() => void runSuggest(true)}
            >
              重新生成
            </Button>
          ) : null
        }
        width={640}
      >
        {suggest === null ? (
          <Spin style={{ display: 'block', margin: '32px auto' }} tip="AI 正在结合你的练习数据分析题单…" />
        ) : (
          <>
            <Markdown text={suggest} breaks />
            {detail?.aiSuggestionAt && (
              <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 12, textAlign: 'right' }}>
                生成于 {new Date(detail.aiSuggestionAt + 'Z').toLocaleString('zh-CN')}
              </p>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}
