import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  App as AntdApp,
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BookOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  CompressOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DownOutlined,
  EditOutlined,
  ExpandOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  FileMarkdownOutlined,
  FilePdfOutlined,
  ImportOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RightOutlined,
  SyncOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { TEMPLATE_TIER_OPTIONS, templateTierLabel } from '../../../shared/src/templateTiers.ts'
import PageHeader from '../components/PageHeader'
import StatStrip from '../components/StatStrip'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import Markdown from '../components/Markdown'
import CodeEditor from '../components/CodeEditor'
import TemplateDocument from '../components/TemplateDocument'
import NoteEditor from '../components/NoteEditor'
import NoteCardButton from '../components/NoteCardButton'
import IndentSwitch from '../components/IndentSwitch'
import { tagColor } from '../ui'
import { BP, useMediaQuery } from '../useMediaQuery'
import { saveUrlAsFile } from '../download'
import { del, get, patch, post, put } from '../api'
import { TEMPLATE_EXPORT_OPTIONS, type TemplateExportFormat } from '../templateExport'
import { readJson, writeJson } from '../persistence.ts'
import { readTemplateViewState, writeTemplateViewState } from '../templateView.ts'
import type { TemplateCategoryInfo, TemplateContentInfo, TemplateExampleInfo, TemplateItemInfo, TemplatesResponse, TemplateStatus } from '../types'

const STATUS_META: Array<{ key: TemplateStatus; label: string; icon: typeof CheckCircleOutlined }> = [
  { key: 'todo', label: '未学', icon: PlayCircleOutlined },
  { key: 'learning', label: '学习中', icon: FieldTimeOutlined },
  { key: 'mastered', label: '已掌握', icon: CheckCircleOutlined },
]

/** 分类拖拽顺序持久化（localStorage，与侧边栏菜单同模式） */
const CAT_ORDER_KEY = 'icpc-cat-order-v1'
function getCatOrder(): string[] | null {
  return readJson<string[]>(CAT_ORDER_KEY)
}
function saveCatOrder(keys: string[]): void {
  writeJson(CAT_ORDER_KEY, keys)
}

interface CustomFormValues {
  categoryKey: string
  name: string
  difficulty: number
  tags?: string[]
  complexity?: string
  url?: string
  idea?: string
  code?: string
}

interface CategoryFormValues {
  name: string
  description?: string
}

/** 模板条目的有效内容：自建模板用自身字段，内置条目用用户写入的 content */
function contentOf(t: TemplateItemInfo): TemplateContentInfo {
  if (t.custom) {
    return { code: t.code || null, idea: t.idea || null, complexity: t.complexity || null, url: t.url || null }
  }
  return t.content ?? { code: null, idea: null, complexity: null, url: null }
}

/** 一键导出自己写过的模板（自建模板 + 内置条目里写过内容的笔记） */
const downloadTemplates = async (
  format: TemplateExportFormat,
  setExporting: (value: boolean) => void,
): Promise<void> => {
  setExporting(true)
  try {
    const stamp = new Date().toISOString().slice(0, 10)
    const isPdf = format === 'pdf'
    await saveUrlAsFile({
      url: isPdf ? '/api/templates/export.pdf' : '/api/templates/export.md',
      filename: `icpc-templates-${stamp}.${isPdf ? 'pdf' : 'md'}`,
      mime: isPdf ? 'application/pdf' : 'text/markdown;charset=utf-8',
      binary: isPdf,
      successText: isPdf ? 'PDF 已导出' : '模板已导出',
    })
  } finally {
    setExporting(false)
  }
}

export default function Templates() {
  // React 19 下 antd 静态 message 静默失效，必须用 App 上下文实例
  const { message, modal } = AntdApp.useApp()
  const [data, setData] = useState<TemplatesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  /** 首屏取数失败原因：与「模板库本来就是空的」严格区分（失败给 InlineError，空给 EmptyState） */
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 上次离开模板库时的分类与滚动位置（只在挂载时读一次，之后由 scroll/view 快照跟上） */
  const [savedView] = useState(readTemplateViewState)
  const [activeCat, setActiveCat] = useState<string | undefined>(() => savedView?.categoryKey ?? undefined)
  /** 当前正在阅读的模板：弹窗展示渲染后的连续正文（点击卡片打开） */
  const [viewingId, setViewingId] = useState<string>()
  const [noteDraft, setNoteDraft] = useState('')
  const [noteEditing, setNoteEditing] = useState<TemplateItemInfo | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [editingCustom, setEditingCustom] = useState<TemplateItemInfo | null>(null)
  const [customForm] = Form.useForm<CustomFormValues>()
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [categoryForm] = Form.useForm<CategoryFormValues>()
  const [contentEditing, setContentEditing] = useState<TemplateItemInfo | null>(null)
  const [writerFullscreen, setWriterFullscreen] = useState(false)
  const [examplesEditing, setExamplesEditing] = useState<TemplateItemInfo | null>(null)
  const [exampleRaw, setExampleRaw] = useState('')
  const [contentDraft, setContentDraft] = useState<TemplateContentInfo>({ code: '', idea: '', complexity: '', url: '' })
  const [syncingId, setSyncingId] = useState<string>()
  const [exporting, setExporting] = useState(false)
  const [dragCat, setDragCat] = useState<string | null>(null)
  const [dragOverCat, setDragOverCat] = useState<{ key: string; pos: 'before' | 'after' } | null>(null)
  /** 拖拽源分类 key（ref 即时读写，不依赖 state 异步更新） */
  const dragCatRef = useRef<string | null>(null)
  /** 撤销提示的 key：连续排序时先销毁上一条，避免提示堆叠刷屏 */
  const catMsgKeyRef = useRef(0)
  /** 命令面板深链参数：/templates?q=模板名 */
  const [searchParams] = useSearchParams()
  /** ≤920px：课程分类改为顶部 Select（§5.5 / P3-2），与 Problems 的分类栏同一套策略 */
  const narrowTaxonomy = useMediaQuery(BP.narrowTaxonomy)
  /** 视图快照：分类、滚动位置；用 ref 是为了滚动事件与卸载清理都能读到最新值 */
  const viewSnapshotRef = useRef<{ categoryKey: string | null; scrollTop: number }>({
    categoryKey: savedView?.categoryKey ?? null,
    scrollTop: savedView?.scrollTop ?? 0,
  })
  const scrollRestoredRef = useRef(false)

  const persistView = useCallback(() => {
    writeTemplateViewState({ ...viewSnapshotRef.current })
  }, [])

  /** 立即滚到指定位置并同步快照：全局 html 有 scroll-behavior:smooth，不能让恢复过程慢滚 */
  const setPageScroll = useCallback((top: number) => {
    const root = document.documentElement
    const previousBehavior = root.style.scrollBehavior
    root.style.scrollBehavior = 'auto'
    window.scrollTo(0, Math.max(0, top))
    root.style.scrollBehavior = previousBehavior
    viewSnapshotRef.current.scrollTop = Math.max(0, Math.round(window.scrollY))
  }, [])

  /** 按 localStorage 持久化顺序重排分类，新增的分类追加到末尾 */
  const sortedCategories = useMemo(() => {
    if (!data?.categories) return []
    const saved = getCatOrder()
    if (!saved) return data.categories
    const map = new Map(data.categories.map((c) => [c.key, c]))
    const ordered = saved.map((k) => map.get(k)).filter(Boolean) as typeof data.categories
    for (const c of data.categories) {
      if (!ordered.includes(c)) ordered.push(c)
    }
    return ordered
  }, [data])

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    get<TemplatesResponse>('/api/templates')
      .then((res) => {
        setData(res)
        setLoadError(null)
      })
      .catch((e: Error) => {
        // 失败 ≠ 空：旧实现只弹一条 toast，首屏没数据时页面停在 `!data` 分支渲染
        // 「模板课程加载失败」的空态 —— 有结论没出路。这里记下原因交给 InlineError 带重试。
        // 已有 data 时不打回错误态（局部刷新失败不该清空整页），toast 仍保留。
        setLoadError(e.message)
        message.error(e.message)
      })
      .finally(() => setLoading(false))
  }, [message])

  useEffect(() => {
    load()
  }, [load])

  // 首次加载后选中上次的分类；分类被删除 / 本地快照失效时回退到第一个分类
  useEffect(() => {
    if (!data?.categories.length) return
    if (activeCat && data.categories.some((c) => c.key === activeCat)) return
    // 快照里的分类已经不存在了：保留它的滚动位置没有意义，从新分类顶部开始
    setPageScroll(0)
    setActiveCat(data.categories[0].key)
  }, [data, activeCat, setPageScroll])

  // 分类变化即落盘：滚动位置由 scroll 快照提供，因此这里不需要读 window.scrollY
  useEffect(() => {
    viewSnapshotRef.current.categoryKey = activeCat ?? null
    persistView()
  }, [activeCat, persistView])

  // 滚动位置节流落盘；页面卸载 / 切到后台时立即补一次，覆盖 Ctrl+滚轮缩放后直接切页的情况
  useEffect(() => {
    let timer: number | undefined
    const captureScroll = () => {
      viewSnapshotRef.current.scrollTop = Math.max(0, Math.round(window.scrollY))
    }
    const onScroll = () => {
      captureScroll()
      if (timer !== undefined) return
      timer = window.setTimeout(() => {
        timer = undefined
        persistView()
      }, 250)
    }
    const flush = () => {
      captureScroll()
      persistView()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (timer !== undefined) window.clearTimeout(timer)
      // 卸载时不要重新读 window.scrollY：路由切换后的新页面可能已把滚动重置到顶部
      persistView()
    }
  }, [persistView])

  /**
   * 全局命令面板的深链：`/templates?q=<模板名>`。
   * 直接跳到该模板所在分类并展开它，省掉「先进模板库、再切分类、再找条目」三步 ——
   * 这正是命令面板存在的意义（§4.3）。
   *
   * 用 urlQ 而不是「只跑一次」的 ref 做去重：应用内从 /templates 再跳 /templates?q=… 时
   * 组件不会重挂载，只跑一次的写法会在第二次跳转时静默失效。
   */
  const urlQ = searchParams.get('q') ?? ''

  /**
   * 恢复上次退出时的页面位置。
   *
   * 必须等 data + 分类都就绪后再滚：数据未回来时列表还是骨架屏，浏览器会把过大的
   * scrollTop 夹到 0；分类快照失效时也不能滚，否则会在回退到第一个分类的过程中先跳一下。
   * 带 `?q=` 时是命令面板的显式深链，优先级高于上次位置，不恢复。
   */
  useLayoutEffect(() => {
    if (scrollRestoredRef.current) return
    if (!data?.categories.length || !activeCat) return
    if (!data.categories.some((c) => c.key === activeCat)) return
    scrollRestoredRef.current = true
    if (urlQ || viewSnapshotRef.current.scrollTop <= 0) return
    setPageScroll(viewSnapshotRef.current.scrollTop)
  }, [data, activeCat, urlQ, setPageScroll])
  const deepLinkAppliedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!urlQ || !data?.categories.length) return
    if (deepLinkAppliedRef.current === urlQ) return
    deepLinkAppliedRef.current = urlQ
    const wanted = urlQ.trim().toLowerCase()
    for (const cat of data.categories) {
      const hit =
        cat.templates.find((t) => t.name.toLowerCase() === wanted) ??
        cat.templates.find((t) => t.name.toLowerCase().includes(wanted))
      if (hit) {
        // 显式深链是一次新的定位：不要沿用旧分类的滚动位置，下次正常进入从本次分类顶部开始
        setPageScroll(0)
        setActiveCat(cat.key)
        setViewingId(hit.id)
        return
      }
    }
  }, [data, urlQ, setPageScroll])

  const setStatus = async (t: TemplateItemInfo, status: TemplateStatus) => {
    try {
      await post(`/api/templates/${t.id}/status`, { status })
      message.success(status === 'mastered' ? `「${t.name}」已掌握 🎉` : '学习状态已更新')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveNote = async () => {
    if (!noteEditing) return
    try {
      await patch(`/api/templates/${noteEditing.id}/note`, { note: noteDraft })
      message.success('笔记已保存')
      setNoteEditing(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const jumpNext = () => {
    if (!data?.next) return
    for (const cat of data.categories) {
      const found = cat.templates.find((t) => t.id === data.next!.id)
      if (found) {
        setPageScroll(0)
        setActiveCat(cat.key)
        setViewingId(found.id)
        return
      }
    }
  }

  // ---------- 自建模板 ----------

  const openCategoryCreate = () => {
    categoryForm.resetFields()
    setCategoryOpen(true)
  }

  const submitCategory = async () => {
    const values = await categoryForm.validateFields().catch(() => null)
    if (!values) return
    try {
      const created = await post<{ key: string; name: string }>('/api/templates/categories', values)
      message.success(`标签「${created.name}」已创建`)
      setCategoryOpen(false)
      setActiveCat(created.key)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const openCreate = (categoryKey?: string) => {
    setEditingCustom(null)
    customForm.resetFields()
    customForm.setFieldsValue({
      categoryKey: categoryKey ?? activeCat ?? 'basic',
      difficulty: 3,
    })
    setCustomOpen(true)
  }

  const openEdit = (t: TemplateItemInfo) => {
    setEditingCustom(t)
    customForm.setFieldsValue({
      categoryKey: activeCat,
      name: t.name,
      difficulty: t.difficulty,
      tags: t.tags,
      complexity: t.complexity || undefined,
      url: t.url || undefined,
      idea: t.idea || undefined,
      code: t.code,
    })
    setCustomOpen(true)
  }

  const submitCustom = async () => {
    const v = await customForm.validateFields().catch(() => null)
    if (!v) return
    try {
      if (editingCustom) {
        const dbId = editingCustom.id.slice(2)
        await patch(`/api/templates/custom/${dbId}`, v)
        message.success('模板已更新')
      } else {
        await post('/api/templates/custom', v)
        message.success(`「${v.name}」已加入模板库`)
      }
      setCustomOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeCustom = async (t: TemplateItemInfo) => {
    try {
      await del(`/api/templates/custom/${t.id.slice(2)}`)
      message.success('已删除自建模板')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /**
   * 删除自建标签（用户反馈：新建标签后无法删除）。
   *
   * 有模板时先说明会连带删除模板与学习进度 —— 删除是显式动作，接口侧同样要求 force=1，
   * 不在这里做静默级联（服务端对没带 force 的请求返回 409 + count）。
   */
  const removeCategory = (category: TemplateCategoryInfo) => {
    const count = category.templates.length
    modal.confirm({
      title: `删除标签「${category.name}」？`,
      content:
        count > 0
          ? `该标签下有 ${count} 个自建模板，删除标签会一并删除这些模板及其学习进度，且无法恢复。`
          : '该标签下还没有模板，删除后如需可重新「新建标签」。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await del<{ deletedTemplates: number }>(
            `/api/templates/categories/${encodeURIComponent(category.key)}${count > 0 ? '?force=1' : ''}`,
          )
          message.success(
            r.deletedTemplates > 0
              ? `标签「${category.name}」已删除（含 ${r.deletedTemplates} 个模板）`
              : `标签「${category.name}」已删除`,
          )
          if (activeCat === category.key) setActiveCat(undefined)
          load()
        } catch (e) {
          message.error((e as Error).message)
        }
      },
    })
  }

  // ---------- 例题练习 ----------

  const collectExample = async (t: TemplateItemInfo, ex: TemplateExampleInfo) => {
    try {
      await post('/api/templates/examples/collect', {
        platform: ex.platform,
        key: ex.key,
        title: ex.title,
        url: ex.url,
        tags: t.tags,
      })
      message.success(`「${ex.key}」已入库，可到「题目管理」追踪 AC 状态`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 例题写完后一键同步：按例题涉及平台拉取最新提交，刷新 AC 状态
  const syncExamples = async (t: TemplateItemInfo) => {
    setSyncingId(t.id)
    try {
      const { results } = await post<{ results: Array<{ imported: number; errors: string[] }> }>(
        '/api/templates/examples/sync',
        { templateId: t.id },
      )
      const errors = results.flatMap((r) => r.errors)
      const imported = results.reduce((sum, r) => sum + r.imported, 0)
      if (errors.length) {
        message.warning(`部分平台未同步成功：${errors.join('；')}`)
      } else if (imported > 0) {
        message.success(`同步完成，新增 ${imported} 条提交记录`)
      } else {
        message.success('已是最新，例题暂无新提交')
      }
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSyncingId(undefined)
    }
  }

  const addExample = async () => {
    if (!examplesEditing) return
    try {
      await post(`/api/templates/${encodeURIComponent(examplesEditing.id)}/examples`, { raw: exampleRaw })
      message.success('例题已添加')
      setExampleRaw('')
      setExamplesEditing(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeExample = async (t: TemplateItemInfo, index: number) => {
    try {
      await del(`/api/templates/${encodeURIComponent(t.id)}/examples/${index}`)
      message.success('例题已删除')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // ---------- 分类拖拽排序（mouse 事件方案，兼容 WebView2/WKWebView） ----------

  const clearCatDrag = () => {
    dragCatRef.current = null
    setDragCat(null)
    setDragOverCat(null)
  }

  // 拖拽中松手在列表外时清除状态
  useEffect(() => {
    if (dragCat === null) return
    document.addEventListener('mouseup', clearCatDrag)
    return () => document.removeEventListener('mouseup', clearCatDrag)
  }, [dragCat])

  const handleCatMouseDown = (e: ReactMouseEvent<HTMLButtonElement>, key: string) => {
    e.stopPropagation() // 阻止冒泡到 onClick（防止按下即切换分类）
    e.preventDefault() // 阻止默认行为避免选中文本
    dragCatRef.current = key
    setDragCat(key)
  }

  const handleCatMouseEnter = (e: ReactMouseEvent<HTMLButtonElement>, key: string) => {
    if (dragCatRef.current === null || dragCatRef.current === key) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pos: 'before' | 'after' = e.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
    if (dragOverCat?.key === key && dragOverCat?.pos === pos) return
    setDragOverCat({ key, pos })
  }

  const handleCatMouseUp = () => {
    if (dragCatRef.current !== null && dragOverCat) {
      const keys = sortedCategories.map((c) => c.key)
      const fromIdx = keys.indexOf(dragCatRef.current)
      const toIdx = keys.indexOf(dragOverCat.key)
      if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
        const before = [...keys]
        keys.splice(fromIdx, 1)
        let insertAt = keys.indexOf(dragOverCat.key)
        if (dragOverCat.pos === 'after') insertAt += 1
        keys.splice(insertAt, 0, dragCatRef.current)
        saveCatOrder(keys)
        // 触发 sortedCategories 重算（data 引用不变，需要手动触发）
        setData((d) => (d ? { ...d } : d))
        showCatUndo(before)
      }
    }
    clearCatDrag()
  }

  /**
   * 键盘排序（§6.2 / P6-1）：与相邻分类交换一格。
   * 与 mouse 拖拽共用 saveCatOrder + 同一份 key 顺序，落盘格式完全一致；
   * 端点（无处可动）直接返回，按钮本身也会 disabled。
   */
  const moveCat = (key: string, delta: -1 | 1) => {
    const keys = sortedCategories.map((c) => c.key)
    const from = keys.indexOf(key)
    const to = from + delta
    if (from === -1 || to < 0 || to >= keys.length) return
    const before = [...keys]
    keys.splice(from, 1)
    keys.splice(to, 0, key)
    saveCatOrder(keys)
    setData((d) => (d ? { ...d } : d))
    showCatUndo(before)
  }

  /** 排序后的 3 秒「撤销」提示（§6.2 验收标准）。连续操作先销毁上一条，避免提示堆叠 */
  const showCatUndo = (before: string[]) => {
    const key = `cat-order-${(catMsgKeyRef.current += 1)}`
    message.destroy()
    message.open({
      key,
      type: 'success',
      duration: 3,
      content: (
        <span>
          已调整分类顺序
          <Button
            type="link"
            size="small"
            icon={<UndoOutlined />}
            onClick={() => {
              message.destroy(key)
              saveCatOrder(before)
              setData((d) => (d ? { ...d } : d))
              message.info('已恢复排序前的顺序')
            }}
          >
            撤销
          </Button>
        </span>
      ),
    })
  }

  // ---------- 内置条目：写入自己的模板内容 ----------

  const openContentEditor = (t: TemplateItemInfo) => {
    setViewingId(undefined)
    setWriterFullscreen(false)
    setContentEditing(t)
    setContentDraft({ ...(contentOf(t) as Required<TemplateContentInfo>) })
  }

  const closeContentEditor = () => {
    setContentEditing(null)
    setWriterFullscreen(false)
  }

  const submitContent = async () => {
    if (!contentEditing) return
    try {
      await put(`/api/templates/${contentEditing.id}/content`, {
        code: contentDraft.code ?? '',
        idea: contentDraft.idea ?? '',
        complexity: contentDraft.complexity ?? '',
        url: contentDraft.url ?? '',
      })
      message.success(`「${contentEditing.name}」的模板已保存`)
      const savedId = contentEditing.id
      closeContentEditor()
      setViewingId(savedId)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const cat = useMemo(() => data?.categories.find((c) => c.key === activeCat), [data, activeCat])

  /** 阅读弹窗按 id 派生：保存状态 / 例题同步后 load() 会换 data 引用，弹窗内容随之更新 */
  const viewingTemplate = useMemo(() => {
    if (!viewingId) return null
    for (const category of data?.categories ?? []) {
      const hit = category.templates.find((t) => t.id === viewingId)
      if (hit) return hit
    }
    return null
  }, [data, viewingId])

  // 首屏骨架屏占住「统计带 → 分类导航 → 条目列表」的真实结构，避免整页 Spin 的布局跳动
  if (loading && !data) return <PageSkeleton stats={false} blocks={3} blockHeight={220} />
  if (!data) {
    // 失败与空态分流：失败可重试，空态给真实的下一步（重新加载）
    return loadError ? (
      <Card>
        <InlineError
          message={loadError}
          hint="模板课程清单没能取回来；重试即可，已保存的自建模板与笔记不会丢失。"
          onRetry={load}
          retrying={loading}
        />
      </Card>
    ) : (
      <Card>
        <EmptyState
          title="模板课程清单为空"
          description="内置课程由服务端下发。如果是本地首次启动，重新加载一次通常即可恢复。"
          action={{ label: '重新加载', type: 'primary', onClick: load }}
        />
      </Card>
    )
  }

  return (
    <div>
      <PageHeader
        title="模板库"
        description="系统学习竞赛算法模板 —— 支持自建模板与例题实战追踪"
        extra={
          <Space wrap>
            <IndentSwitch />
            {data.next && (
              <Tooltip title={`${templateTierLabel(data.next.difficulty)} · 难度 ${data.next.difficulty}/5`}>
                <Button type="primary" icon={<RightOutlined />} onClick={jumpNext}>
                  下一课：{data.next.name}
                </Button>
              </Tooltip>
            )}
            <Button icon={<PlusOutlined />} onClick={() => openCreate()}>
              新建模板
            </Button>
            <Dropdown
              trigger={['click']}
              menu={{
                items: TEMPLATE_EXPORT_OPTIONS.map((option) => ({
                  key: option.format,
                  icon: option.format === 'pdf' ? <FilePdfOutlined /> : <FileMarkdownOutlined />,
                  label: option.label,
                })),
                onClick: ({ key }) => void downloadTemplates(key as TemplateExportFormat, setExporting),
              }}
            >
              <Button icon={<DownloadOutlined />} loading={exporting}>
                导出模板 <DownOutlined />
              </Button>
            </Dropdown>
          </Space>
        }
      />

      <StatStrip
        items={[
          {
            label: '课程模板',
            value: (
              <>
                {data.mastered}
                <span className="stat-suffix">/ {data.total} 已掌握</span>
              </>
            ),
            icon: <CodeOutlined />,
            tone: 'cyan',
          },
          {
            label: '学习中',
            value: data.learning,
            icon: <FieldTimeOutlined />,
            tone: 'amber',
          },
          {
            label: '自建模板',
            value: (
              <>
                {data.customCount}
                <span className="stat-suffix">个</span>
              </>
            ),
            icon: <EditOutlined />,
            tone: 'green',
          },
          {
            label: '下一课',
            value: data.next?.name ?? '已全部完成',
            icon: <RightOutlined />,
            tone: 'blue',
          },
        ]}
      />

      {/* ≤920px：课程分类改为顶部 Select（P3-2），窄屏下不再横排出需要滚动的窄条 */}
      {narrowTaxonomy && (
        <div className="taxonomy-select-bar" style={{ marginTop: 16 }}>
          <span className="taxonomy-select-label">课程分类</span>
          <Select
            style={{ flex: '1 1 220px', minWidth: 0, maxWidth: 420 }}
            aria-label="选择课程分类"
            value={activeCat}
            onChange={(v: string) => {
              setActiveCat(v)
              setViewingId(undefined)
            }}
            options={sortedCategories.map((c) => {
              const mastered = c.templates.filter((t) => t.status === 'mastered').length
              return { value: c.key, label: `${c.name}（${mastered}/${c.templates.length}）` }
            })}
          />
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={openCategoryCreate}>
            新建标签
          </Button>
        </div>
      )}

      <div className="workbench" style={{ marginTop: 16, gridTemplateColumns: narrowTaxonomy ? 'minmax(0, 1fr)' : '190px minmax(0, 1fr)' }}>
        {/* 左栏：分类导航 + 进度（≤920px 由上面的 Select 代替） */}
        {!narrowTaxonomy && (
          <aside className="taxonomy-panel">
            <div className="section-label">课程分类</div>
            <div className="taxonomy-list" style={{ userSelect: dragCat !== null ? 'none' : undefined }}>
              {sortedCategories.map((c, i) => {
                const mastered = c.templates.filter((t) => t.status === 'mastered').length
                const isDragging = dragCat === c.key
                const dropTarget = dragOverCat?.key === c.key
                return (
                  // reorder-host 必须是 .reorder-controls 的**直接**父元素（CSS 用 `>`）
                  <div className="taxonomy-row reorder-host" key={c.key}>
                    <button
                      type="button"
                      className={`taxonomy-item${activeCat === c.key ? ' is-active' : ''}${isDragging ? ' is-dragging' : ''}${dropTarget && dragOverCat?.pos === 'before' ? ' is-drag-over-before' : ''}${dropTarget && dragOverCat?.pos === 'after' ? ' is-drag-over-after' : ''}`}
                      onClick={() => {
                        setActiveCat(c.key)
                        setViewingId(undefined)
                      }}
                      onMouseDown={(e) => handleCatMouseDown(e, c.key)}
                      onMouseEnter={(e) => handleCatMouseEnter(e, c.key)}
                      onMouseUp={handleCatMouseUp}
                    >
                      <span className="taxonomy-item__marker" style={{ background: tagColor(c.key) }} />
                      <span className="taxonomy-item__name">{c.name}</span>
                      <span className="taxonomy-item__count">
                        {mastered}/{c.templates.length}
                      </span>
                    </button>
                    <span className="reorder-controls">
                      <button
                        type="button"
                        className="reorder-btn"
                        disabled={i === 0}
                        title={`上移「${c.name}」`}
                        aria-label={`上移「${c.name}」`}
                        onClick={() => moveCat(c.key, -1)}
                      >
                        <ArrowUpOutlined />
                      </button>
                      <button
                        type="button"
                        className="reorder-btn"
                        disabled={i === sortedCategories.length - 1}
                        title={`下移「${c.name}」`}
                        aria-label={`下移「${c.name}」`}
                        onClick={() => moveCat(c.key, 1)}
                      >
                        <ArrowDownOutlined />
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="taxonomy-footer">
              <Button size="small" type="text" icon={<PlusOutlined />} onClick={openCategoryCreate}>
                新建标签
              </Button>
            </div>
          </aside>
        )}

        {/* 右栏：当前分类模板列表 */}
        <section>
          {cat && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <p className="band-desc" style={{ margin: 0, flex: 1 }}>
                  {cat.description}
                </p>
                {/* 自建标签可删除（内置课程分类不可删，服务端同样拒绝） */}
                {cat.custom && (
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeCategory(cat)}
                  >
                    删除该标签
                  </Button>
                )}
              </div>
              {cat.templates.length === 0 ? (
                <Card>
                  {/* 空态给出路：直接落在「新建模板」上，并把当前分类预选好，省掉一次选择 */}
                  <EmptyState
                    title="该分类暂无模板"
                    description="这个标签下还没有内容。新建模板时会把当前分类预选好，也可以先看看其他分类的内置课程。"
                    action={{
                      label: '新建模板',
                      type: 'primary',
                      icon: <PlusOutlined />,
                      onClick: () => openCreate(cat.key),
                    }}
                  />
                </Card>
              ) : (
                cat.templates.map((t, idx) => {
                  const acCount = t.examples.filter((ex) => ex.ac).length
                  const content = contentOf(t)
                  const hasContent = !!(content.code?.trim() || content.idea?.trim())
                  return (
                    <Card
                      key={t.id}
                      size="small"
                      hoverable
                      className={`template-card${t.status === 'mastered' ? ' template-mastered' : ''}`}
                      style={{ marginBottom: 10 }}
                      onClick={(e) => {
                        // 卡片整体可点开阅读卡片；标题栏里的按钮 / 链接保持自己的动作
                        if ((e.target as HTMLElement).closest('button, a, input, .ant-popconfirm')) return
                        setViewingId(t.id)
                      }}
                      title={
                        <span className="today-problem-head">
                          <span className="mono template-ordinal">{String(idx + 1).padStart(2, '0')}</span>
                          <span
                            className="today-problem-title"
                            role="button"
                            tabIndex={0}
                            onClick={() => setViewingId(t.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                setViewingId(t.id)
                              }
                            }}
                          >
                            {t.name}
                          </span>
                          <span className="template-stars" title={`难度 ${t.difficulty}/5`}>
                            {'★'.repeat(t.difficulty)}
                          </span>
                          <span className="template-tier">{templateTierLabel(t.difficulty)}</span>
                          {t.custom && <Tag color="geekblue">自建</Tag>}
                          {t.status === 'mastered' && (
                            <Tag color="success" className="dot-tag">
                              已掌握
                            </Tag>
                          )}
                          {t.status === 'learning' && (
                            <Tag color="processing" className="dot-tag">
                              学习中
                            </Tag>
                          )}
                        </span>
                      }
                      extra={
                        <Space size={0} onClick={(e) => e.stopPropagation()}>
                          {!t.custom && (
                            <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openContentEditor(t)}>
                              {hasContent ? '编辑' : '写入'}
                            </Button>
                          )}
                          {t.custom && (
                            <>
                              <Tooltip title="编辑模板">
                                <Button size="small" type="text" icon={<EditOutlined />} aria-label="编辑模板" onClick={() => openEdit(t)} />
                              </Tooltip>
                              <Popconfirm title="删除该自建模板？" okText="删除" cancelText="取消" onConfirm={() => removeCustom(t)}>
                                <Tooltip title="删除模板">
                                  <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除模板" />
                                </Tooltip>
                              </Popconfirm>
                            </>
                          )}
                          <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => setViewingId(t.id)}>
                            查看
                          </Button>
                        </Space>
                      }
                    >
                      <div className="template-brief">
                        {t.tags.slice(0, 4).map((tag) => (
                          <Tag key={tag} color={tagColor(tag)}>
                            {tag}
                          </Tag>
                        ))}
                        {t.examples.length > 0 && (
                          <Tag className={acCount > 0 ? 'template-brief-ac' : undefined}>
                            例题 {acCount > 0 ? `${acCount}/${t.examples.length} AC` : t.examples.length}
                          </Tag>
                        )}
                        {!t.custom && !hasContent && <Tag color="warning">待写入</Tag>}
                        <span className="template-brief-text">
                          {(t.custom ? t.idea : (t.outline ?? '')).slice(0, 70)}…
                        </span>
                      </div>
                    </Card>
                  )
                })
              )}
            </>
          )}
        </section>
      </div>

      {/* 模板阅读弹窗：点击卡片直接看渲染后的正文，整篇上下连续滚动 */}
      <Modal
        open={viewingTemplate !== null}
        onCancel={() => setViewingId(undefined)}
        width={920}
        className="template-viewer-modal"
        destroyOnHidden
        title={
          viewingTemplate && (
            <div className="template-viewer-head">
              <div className="template-viewer-heading">
                <span className="template-viewer-kicker">模板 · {templateTierLabel(viewingTemplate.difficulty)}</span>
                <span className="template-viewer-name">{viewingTemplate.name}</span>
              </div>
              <div className="template-viewer-tags">
                {viewingTemplate.custom && <Tag color="geekblue">自建</Tag>}
                {viewingTemplate.tags.slice(0, 4).map((tag) => (
                  <Tag key={tag} color={tagColor(tag)}>
                    {tag}
                  </Tag>
                ))}
              </div>
            </div>
          )
        }
        footer={
          viewingTemplate && (
            <div className="template-viewer-footer">
              <Space size={8} wrap>
                {STATUS_META.map((s) => (
                  <Button
                    key={s.key}
                    size="small"
                    type={viewingTemplate.status === s.key ? 'primary' : 'default'}
                    icon={<s.icon />}
                    onClick={() => setStatus(viewingTemplate, s.key)}
                  >
                    {s.label}
                  </Button>
                ))}
                <Button
                  size="small"
                  type="text"
                  icon={<EditOutlined />}
                  onClick={() => {
                    setNoteEditing(viewingTemplate)
                    setNoteDraft(viewingTemplate.note ?? '')
                  }}
                >
                  {viewingTemplate.note ? '改笔记' : '记笔记'}
                </Button>
                {viewingTemplate.status === 'mastered' && (
                  <Link to="/reviews" className="template-review-hint">
                    <BookOutlined /> 到复习库保持手感 →
                  </Link>
                )}
              </Space>
              <Space size={8}>
                {!viewingTemplate.custom ? (
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => openContentEditor(viewingTemplate)}
                  >
                    {contentOf(viewingTemplate).code?.trim() || contentOf(viewingTemplate).idea?.trim() ? '编辑我的模板' : '写入我的模板'}
                  </Button>
                ) : (
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => {
                      setViewingId(undefined)
                      openEdit(viewingTemplate)
                    }}
                  >
                    编辑模板
                  </Button>
                )}
                <Button type="primary" onClick={() => setViewingId(undefined)}>
                  关闭
                </Button>
              </Space>
            </div>
          )
        }
      >
        {viewingTemplate && (
          <div className="template-viewer-body">
            <TemplateDocument
              name={viewingTemplate.name}
              custom={viewingTemplate.custom}
              tags={viewingTemplate.tags}
              difficulty={viewingTemplate.difficulty}
              status={viewingTemplate.status}
              outline={viewingTemplate.outline}
              content={contentOf(viewingTemplate)}
              showHead={false}
            />

            <section className="template-viewer-examples">
              <div className="template-doc-label">
                <span>例题实战（点击做题，入库后自动追踪 AC）</span>
                <Space size={4}>
                  <Button
                    size="small"
                    type="text"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      setExamplesEditing(viewingTemplate)
                      setExampleRaw('')
                    }}
                  >
                    添加例题
                  </Button>
                  <Tooltip title="拉取例题平台的最新提交，自动刷新 AC 状态">
                    <Button
                      size="small"
                      type="text"
                      icon={<SyncOutlined />}
                      loading={syncingId === viewingTemplate.id}
                      disabled={viewingTemplate.examples.length === 0}
                      onClick={() => syncExamples(viewingTemplate)}
                    >
                      同步 AC
                    </Button>
                  </Tooltip>
                </Space>
              </div>
              {viewingTemplate.examples.length > 0 ? (
                <div className="template-examples">
                  {viewingTemplate.examples.map((ex, index) => (
                    <div className="template-example-row" key={`${ex.platform}-${ex.key}`}>
                      {ex.url ? (
                        <a href={ex.url} target="_blank" rel="noreferrer" className="template-example">
                          <LinkOutlined /> [{ex.key}] {ex.title} ↗
                        </a>
                      ) : (
                        <span className="template-example">[{ex.key}] {ex.title}</span>
                      )}
                      {ex.ac ? (
                        <Tag color="success" className="dot-tag">已 AC</Tag>
                      ) : ex.inBank ? (
                        <Link to="/problems">
                          <Tag color="processing" className="dot-tag template-example-action">已入库 · 未 AC</Tag>
                        </Link>
                      ) : (
                        <Button size="small" type="text" icon={<ImportOutlined />} onClick={() => collectExample(viewingTemplate, ex)}>
                          入库
                        </Button>
                      )}
                      <Popconfirm
                        title={`从「${viewingTemplate.name}」移除这道例题？`}
                        onConfirm={() => void removeExample(viewingTemplate, index)}
                        okText="移除"
                        cancelText="取消"
                      >
                        <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`移除例题 ${ex.key}`} />
                      </Popconfirm>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="template-viewer-empty-line">还没有例题，可以先添加一道正在练的题。</p>
              )}
            </section>

            {viewingTemplate.note && (
              <div className="template-viewer-note">
                <div className="template-doc-label">学习笔记</div>
                <div className="template-viewer-note-body" data-note-zoom>
                  <Markdown text={viewingTemplate.note} />
                </div>
                <NoteCardButton
                  kind="template"
                  subject={viewingTemplate.name}
                  text={viewingTemplate.note}
                  meta={<span>{STATUS_META.find((s) => s.key === viewingTemplate.status)?.label ?? ''}</span>}
                  onEdit={() => {
                    setNoteEditing(viewingTemplate)
                    setNoteDraft(viewingTemplate.note ?? '')
                  }}
                />
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 学习笔记弹窗：与复习笔记同款编辑器（Markdown 工具栏 + 粘贴图片 + 预览） */}
      <Modal
        title={`学习笔记 · ${noteEditing?.name ?? ''}`}
        open={noteEditing !== null}
        onCancel={() => setNoteEditing(null)}
        onOk={saveNote}
        okText="保存"
        cancelText="取消"
        width={880}
      >
        {noteEditing && (
          <NoteEditor
            key={noteEditing.id}
            readingZoom
            value={noteDraft}
            onChange={setNoteDraft}
            height={420}
            maxLength={20000}
            placeholder="自己的理解、踩过的坑、与哪些题联系紧密……（Markdown 语法，可直接粘贴 / 拖入截图）"
          />
        )}
      </Modal>

      <Modal
        title={`添加例题 · ${examplesEditing?.name ?? ''}`}
        open={examplesEditing !== null}
        onCancel={() => setExamplesEditing(null)}
        onOk={addExample}
        okText="添加"
        cancelText="取消"
      >
        <Input.TextArea
          value={exampleRaw}
          onChange={(event) => setExampleRaw(event.target.value)}
          rows={3}
          placeholder={'每次添加一道题，输入题号或链接：\nP1001 A+B Problem\nCF1234A\nhttps://atcoder.jp/contests/abc300/tasks/abc300_a'}
        />
      </Modal>

      {/* 自建模板新建 / 编辑弹窗 */}
      <Modal
        title={editingCustom ? '编辑自建模板' : '新建自建模板'}
        open={customOpen}
        onCancel={() => setCustomOpen(false)}
        onOk={submitCustom}
        okText={editingCustom ? '保存' : '创建'}
        cancelText="取消"
        width={720}
      >
        <Form form={customForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="categoryKey" label="分类" rules={[{ required: true, message: '选择分类' }]} style={{ width: 160 }}>
              <Select
                options={(data?.categories ?? []).map((c) => ({ value: c.key, label: c.name }))}
              />
            </Form.Item>
            <Form.Item name="name" label="模板名称" rules={[{ required: true, message: '填写名称' }]} style={{ flex: 1, minWidth: 240 }}>
              <Input placeholder="如：线段树二分（自用版）" maxLength={100} />
            </Form.Item>
            <Form.Item name="difficulty" label="难度段位" rules={[{ required: true }]} style={{ width: 130 }}>
              <Select options={TEMPLATE_TIER_OPTIONS} />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label="标签（与刷题标签同词表，回车添加）">
            <Select mode="tags" open={false} tokenSeparators={[',', '|']} placeholder="线段树 / 二分 …" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="complexity" label="复杂度" style={{ width: 200 }}>
              <Input placeholder="O(n log n)" maxLength={200} />
            </Form.Item>
            <Form.Item name="url" label="模板出处 / 讲解链接" style={{ flex: 1, minWidth: 280 }}>
              <Input placeholder="https://..." maxLength={500} />
            </Form.Item>
          </Space>
          <Form.Item name="idea" label="思路与备注">
            <CodeEditor
              language="markdown"
              height={140}
              maxLength={5000}
              placeholder="自己的理解、适用边界……（Markdown 语法：列表 / 表格 / 代码块）"
            />
          </Form.Item>
          <Form.Item name="code" label="模板代码">
            <CodeEditor
              language="cpp"
              height={320}
              maxLength={20000}
              placeholder="粘贴 / 编写你的 C++ 模板……（语法高亮，支持 Tab 缩进）"
            />
          </Form.Item>
        </Form>
      </Modal>
      {/* 模板分类新建弹窗 */}
      <Modal
        title="新建标签"
        open={categoryOpen}
        onCancel={() => setCategoryOpen(false)}
        onOk={submitCategory}
        okText="创建"
        cancelText="取消"
      >
        <Form form={categoryForm} layout="vertical">
          <Form.Item
            name="name"
            label="标签名称"
            rules={[{ required: true, message: '填写标签名称' }]}
          >
            <Input placeholder="如：网络流" maxLength={30} />
          </Form.Item>
          <Form.Item name="description" label="说明（可选）">
            <Input.TextArea
              rows={3}
              maxLength={200}
              placeholder="这个标签下准备积累哪些模板"
            />
          </Form.Item>
        </Form>
      </Modal>
      {/* 内置条目：写入我的模板内容弹窗（可全屏为三栏实时预览） */}
      <Modal
        title={
          <div className="template-writer-title">
            <span className="template-writer-kicker">{writerFullscreen ? '沉浸写作' : '写入我的模板'}</span>
            <span className="template-writer-name">{contentEditing?.name ?? ''}</span>
          </div>
        }
        open={contentEditing !== null}
        onCancel={closeContentEditor}
        width={writerFullscreen ? 'var(--app-viewport-width)' : 760}
        className={`template-writer-modal${writerFullscreen ? ' is-fullscreen' : ''}`}
        destroyOnHidden
        footer={
          <div className="template-writer-footer">
            <Button
              type="text"
              icon={writerFullscreen ? <CompressOutlined /> : <ExpandOutlined />}
              onClick={() => setWriterFullscreen((v) => !v)}
              aria-pressed={writerFullscreen}
            >
              {writerFullscreen ? '退出全屏' : '全屏编辑'}
            </Button>
            <Space size={8}>
              <Button onClick={closeContentEditor}>取消</Button>
              <Button type="primary" onClick={submitContent}>保存</Button>
            </Space>
          </div>
        }
      >
        {contentEditing && (
          <div className={`template-writer${writerFullscreen ? ' is-fullscreen' : ''}`}>
            {writerFullscreen ? (
              <>
                <div className="template-writer-strip">
                  <p className="template-writer-outline">
                    <span className="template-writer-outline-label">大纲要点</span>
                    {contentEditing.outline}
                  </p>
                  <div className="template-writer-fields">
                    <label className="template-writer-field">
                      <span>复杂度</span>
                      <Input
                        size="small"
                        value={contentDraft.complexity ?? ''}
                        onChange={(e) => setContentDraft((d) => ({ ...d, complexity: e.target.value }))}
                        placeholder="O(n log n)"
                        maxLength={200}
                      />
                    </label>
                    <label className="template-writer-field is-wide">
                      <span>参考链接</span>
                      <Input
                        size="small"
                        value={contentDraft.url ?? ''}
                        onChange={(e) => setContentDraft((d) => ({ ...d, url: e.target.value }))}
                        placeholder="https://...（题解 / 笔记）"
                        maxLength={500}
                      />
                    </label>
                  </div>
                </div>

                <div className="template-writer-grid">
                  <section className="template-writer-pane" aria-label="Markdown 说明写入区">
                    <div className="template-writer-pane-head">
                      <span className="template-writer-pane-title">
                        <span className="template-writer-pane-index">01</span>
                        MD 说明
                      </span>
                      <span className="template-writer-pane-meta">{(contentDraft.idea ?? '').length} 字</span>
                    </div>
                    <div className="template-writer-pane-body">
                      <CodeEditor
                        fill
                        language="markdown"
                        maxLength={5000}
                        value={contentDraft.idea ?? ''}
                        onChange={(v) => setContentDraft((d) => ({ ...d, idea: v }))}
                        placeholder="写清楚什么时候用、关键观察、边界条件……（Markdown：列表 / 表格 / 代码块）"
                      />
                    </div>
                  </section>

                  <section className="template-writer-pane is-preview" aria-label="模板实时渲染预览">
                    <div className="template-writer-pane-head">
                      <span className="template-writer-pane-title">
                        <span className="template-writer-pane-index">02</span>
                        实时预览
                      </span>
                      <span className="template-writer-live"><i aria-hidden />跟随改动</span>
                    </div>
                    <div className="template-writer-preview-scroll">
                      <TemplateDocument
                        name={contentEditing.name}
                        tags={contentEditing.tags}
                        difficulty={contentEditing.difficulty}
                        content={contentDraft}
                        preview
                      />
                    </div>
                  </section>

                  <section className="template-writer-pane" aria-label="模板代码写入区">
                    <div className="template-writer-pane-head">
                      <span className="template-writer-pane-title">
                        <span className="template-writer-pane-index">03</span>
                        C++ 代码
                      </span>
                      <span className="template-writer-pane-meta">
                        {(contentDraft.code ?? '').split('\n').length} 行
                      </span>
                    </div>
                    <div className="template-writer-pane-body">
                      <CodeEditor
                        fill
                        language="cpp"
                        maxLength={20000}
                        value={contentDraft.code ?? ''}
                        onChange={(v) => setContentDraft((d) => ({ ...d, code: v }))}
                        placeholder="粘贴 / 编写你的 C++ 模板……（语法高亮，支持 Tab 缩进）"
                      />
                    </div>
                  </section>
                </div>
              </>
            ) : (
              <>
                <p className="band-desc template-writer-outline-brief">
                  <span className="template-writer-outline-label">大纲要点</span>
                  {contentEditing.outline}
                </p>
                <Form layout="vertical">
                  <Form.Item label="我的思路（什么时候用 / 关键观察）" style={{ marginBottom: 12 }}>
                    <CodeEditor
                      language="markdown"
                      height={140}
                      maxLength={5000}
                      value={contentDraft.idea ?? ''}
                      onChange={(v) => setContentDraft((d) => ({ ...d, idea: v }))}
                      placeholder="用自己的话写下来，Markdown 语法（列表 / 表格 / 代码块）——复习时只看这一段……"
                    />
                  </Form.Item>
                  <Form.Item label="模板代码" style={{ marginBottom: 12 }}>
                    <CodeEditor
                      language="cpp"
                      height={320}
                      maxLength={20000}
                      value={contentDraft.code ?? ''}
                      onChange={(v) => setContentDraft((d) => ({ ...d, code: v }))}
                      placeholder="粘贴 / 编写你的 C++ 模板……（语法高亮，支持 Tab 缩进）"
                    />
                  </Form.Item>
                  <Space size={12} style={{ display: 'flex' }}>
                    <Form.Item label="复杂度" style={{ marginBottom: 0, width: 200 }}>
                      <Input
                        value={contentDraft.complexity ?? ''}
                        onChange={(e) => setContentDraft((d) => ({ ...d, complexity: e.target.value }))}
                        placeholder="O(n log n)"
                        maxLength={200}
                      />
                    </Form.Item>
                    <Form.Item label="参考链接" style={{ marginBottom: 0, flex: 1, minWidth: 260 }}>
                      <Input
                        value={contentDraft.url ?? ''}
                        onChange={(e) => setContentDraft((d) => ({ ...d, url: e.target.value }))}
                        placeholder="https://...（题解 / 笔记）"
                        maxLength={500}
                      />
                    </Form.Item>
                  </Space>
                </Form>
                <p className="template-writer-hint">打开「全屏编辑」后是三栏布局：左边写说明、中间实时渲染、右边写代码。</p>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
