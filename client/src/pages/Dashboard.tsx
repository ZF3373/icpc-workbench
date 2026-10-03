import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Button, Card, Col, Empty, Row, Space, App as AntdApp, Tooltip as AntTooltip } from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  DownOutlined,
  HolderOutlined,
  RadarChartOutlined,
  SendOutlined,
  SyncOutlined,
  TrophyOutlined,
  UndoOutlined,
  UpOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { DifficultyStat, OverallStats, PlatformStat, TrendPoint, WeaknessProfile } from '../types'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import HistoryPanel from '../components/HistoryPanel'
import StatStrip from '../components/StatStrip'
import ActivityHeatmap from '../components/ActivityHeatmap'
import SyncStatusCard from '../components/SyncStatusCard'
import AccountScopePicker from '../components/AccountScopePicker'
import { useAccountScope, withScope } from '../accountScope'
import SyncProgressHint from '../components/SyncProgressHint'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import { useSyncProgress } from '../syncProgressContext'
import { applyModuleOrder, loadModuleOrder, saveModuleOrder, type ModuleId } from '../moduleOrder'
import { TONE_VAR, gapColor, platformName, rateColor, useTokenColors, type TokenName } from '../ui'
import { get, post } from '../api'
import type { PlatformId, SyncResult } from '../../../shared/src/index.ts'
import { compareDifficultyBuckets } from '../../../shared/src/difficulty.ts'

interface SyncAllResponse {
  results: Array<SyncResult & { durationMs?: number }>
}

/** 平台卡片拖拽顺序持久化（localStorage，与侧边栏菜单/模板分类同模式） */
const PLATFORM_ORDER_KEY = 'icpc-platform-card-order-v1'
function getPlatformOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(PLATFORM_ORDER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}
function savePlatformOrder(keys: string[]): void {
  try {
    localStorage.setItem(PLATFORM_ORDER_KEY, JSON.stringify(keys))
  } catch {
    // 隐私模式写入失败忽略
  }
}

/**
 * 模块折叠态持久化：存「已折叠」的 id 数组。
 * 与 moduleOrder.ts 的顺序 key 各存一份，互不影响（折叠不该改动顺序，反之亦然）。
 */
const COLLAPSED_KEY = 'icpc-dashboard-module-collapsed-v1'
/** 次要模块默认折叠：首屏只留「平台分布 / 难度分布 / 弱项 / 趋势」，历史与热力图按需展开 */
const COLLAPSED_BY_DEFAULT = new Set<string>(['history', 'heatmap'])
function loadCollapsedModules(): string[] | null {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return raw ? (JSON.parse(raw) as string[]) : null
  } catch {
    // 隐私模式或无 localStorage
    return null
  }
}
function saveCollapsedModules(ids: string[]): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids))
  } catch {
    // 写入失败忽略
  }
}

/** 模块卡片的可读名：键盘排序/折叠按钮的 aria-label 与 title 用它（例：上移「难度分布」） */
const MODULE_LABELS: Record<ModuleId, string> = {
  heatmap: '刷题热力图',
  platforms: '平台分布',
  difficulty: '难度分布',
  weakness: '弱项标签',
  trend: '近 12 周趋势',
  history: '写题历史',
}

/* ---------------------------------------------------------------
   卡片头部键盘控件的几何
   index.css 的 `.reorder-host:hover > .reorder-controls` 要求控件是重排宿主的**直接子元素**
   （套一层 wrapper 就失效，键盘用户 Tab 到按钮时看不见焦点），所以控件用绝对定位贴在
   卡片头部右上角，而不是塞进 antd 的 .ant-card-head 里。折叠按钮常显在最右，
   上移/下移在它左侧、hover 或获得焦点时显形。
   --------------------------------------------------------------- */
const HEAD_BTN_SIZE = 22
const HEAD_BTN_GAP = 4
/** 上移/下移两个按钮的总宽 */
const REORDER_CONTROLS_W = HEAD_BTN_SIZE * 2 + 2
/** 卡片头的内边距（antd Card size="small"） */
const CARD_HEAD_PAD = 12
/** 普通模块头部的键盘控件右偏移 */
const HEAD_CONTROLS_RIGHT = CARD_HEAD_PAD
/**
 * 热力图头部的右偏移：热力图卡片头的 extra 是 ActivityHeatmap 自带的范围切换器
 * （任选近3月/近半年/近1年，宽度约 174px），本切片不能改那个文件，
 * 所以键盘控件右移让开它而不是压在切换器上。
 */
const HEATMAP_CONTROLS_RIGHT = 190
/** 键盘控件占用的总宽（折叠 + 间隙 + 上移/下移） */
const HEAD_CONTROLS_W = HEAD_BTN_SIZE + HEAD_BTN_GAP + REORDER_CONTROLS_W
/** 模块卡自带 extra 要留出的右间距，避免被绝对定位的键盘控件压住 */
const HEAD_EXTRA_RESERVE = HEAD_CONTROLS_W + HEAD_BTN_GAP

const LEGEND_STYLE = { fontSize: 12, iconType: 'circle', iconSize: 8 } as const

/**
 * gapColor() 返回的是 CSS 变量表达式（inline style 里可用），但 recharts 把 Cell 的 fill 写进
 * SVG **表现属性**，var() 在其中不会被解析（表现为柱子掉色）。这里只把语义色调名映射到
 * useTokenColors() 的计算值，5/15 两个分档判断仍然只有 `ui.ts` 一份。
 */
const GAP_TONE_BY_VAR: Record<string, TokenName> = {
  [TONE_VAR.danger]: 'danger',
  [TONE_VAR.warning]: 'warning',
  [TONE_VAR.success]: 'success',
}

/** 模块卡片在 xl 布局的宽度（24 = 整行）；拖拽只改顺序，不改宽度 */
const MODULE_SPANS: Record<ModuleId, number> = {
  heatmap: 24,
  platforms: 10,
  difficulty: 14,
  weakness: 12,
  trend: 12,
  history: 24,
}

/**
 * 键盘排序控件：与相邻项交换一格（§6.2 拖拽的无障碍替代）。
 * 必须是「重排宿主」的直接子元素，见上面 HEAD_* 常量的说明。
 */
function ReorderButtons({
  label,
  canUp,
  canDown,
  onMove,
  style,
}: {
  /** 卡片名，用于 aria-label / title */
  label: string
  canUp: boolean
  canDown: boolean
  onMove: (delta: -1 | 1) => void
  style?: CSSProperties
}) {
  return (
    <span className="reorder-controls" style={style}>
      <button
        type="button"
        className="reorder-btn"
        disabled={!canUp}
        title={`上移「${label}」`}
        aria-label={`上移「${label}」`}
        onClick={() => onMove(-1)}
      >
        <ArrowUpOutlined />
      </button>
      <button
        type="button"
        className="reorder-btn"
        disabled={!canDown}
        title={`下移「${label}」`}
        aria-label={`下移「${label}」`}
        onClick={() => onMove(1)}
      >
        <ArrowDownOutlined />
      </button>
    </span>
  )
}

/** 折叠/展开按钮（常显，不参与 hover 显隐）：折叠次要模块后首屏更短（§5.1） */
function CollapseToggle({
  label,
  collapsed,
  onToggle,
  style,
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  style?: CSSProperties
}) {
  const text = collapsed ? `展开「${label}」` : `折叠「${label}」`
  return (
    <button
      type="button"
      className="reorder-btn"
      style={style}
      aria-expanded={!collapsed}
      aria-label={text}
      title={text}
      onClick={onToggle}
    >
      {collapsed ? <DownOutlined /> : <UpOutlined />}
    </button>
  )
}

/**
 * 模块卡片统一外壳：标题前放拖拽把手，卡片根上的 mousedown 由模块拖拽逻辑过滤（仅头部发起）。
 * 折叠态只渲染卡片头：children（图表/表格）不挂载，省掉一次无谓的渲染与请求。
 */
function ModuleCard({
  title,
  extra,
  collapsed = false,
  onHeadMouseDown,
  children,
}: {
  title: ReactNode
  extra?: ReactNode
  collapsed?: boolean
  onHeadMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void
  children?: ReactNode
}) {
  return (
    <Card
      size="small"
      title={
        <>
          <HolderOutlined className="module-drag-handle" />
          {title}
        </>
      }
      extra={extra}
      onMouseDown={onHeadMouseDown}
      // 折叠态：children 不挂载，Card 的空 body 也一起收起，卡片只剩头部
      styles={collapsed ? { body: { display: 'none' } } : undefined}
    >
      {collapsed ? null : children}
    </Card>
  )
}

export default function Dashboard() {
  const { message } = AntdApp.useApp()
  const nav = useNavigate()
  /**
   * 图表配色必须取「具体色值」：recharts 把 fill/stroke/stopColor 写进 SVG 表现属性，
   * 表现属性里的 var() 不会被解析（取到空值 = 图表整片掉色）。useTokenColors() 读的是
   * documentElement 上的计算值，并用 MutationObserver 跟随亮/暗切换。
   */
  const t = useTokenColors()
  /** 账号视角：绑了多个账号时，统计族接口按 platform+account 收窄（默认全部账号） */
  const [scope, setScope] = useAccountScope()
  const [stats, setStats] = useState<OverallStats | null>(null)
  const [weak, setWeak] = useState<WeaknessProfile | null>(null)
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)
  const [loading, setLoading] = useState(true)
  /** 统计接口加载失败的原因：与「确实没有数据」分开渲染，不能让失败伪装成空态 */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [platformOrder, setPlatformOrder] = useState<string[] | null>(getPlatformOrder)
  const [dragPlatform, setDragPlatform] = useState<PlatformId | null>(null)
  /** 同步完成后自增，驱动热力图等自带请求的子卡片重新拉数 */
  const [syncTick, setSyncTick] = useState(0)
  const [moduleOrder, setModuleOrder] = useState<string[] | null>(loadModuleOrder)
  /** 折叠态：null = 没有用户记录 → 用默认折叠集合；[] = 用户手动全部展开过（与「无记录」区分开） */
  const [collapsedModules, setCollapsedModules] = useState<string[] | null>(loadCollapsedModules)
  const [dragModule, setDragModule] = useState<ModuleId | null>(null)
  /** 拖拽源平台（ref 即时读写，不依赖 state 异步更新） */
  const dragPlatformRef = useRef<PlatformId | null>(null)
  /** 最新顺序镜像：mousemove 是连续事件，渲染会延迟一帧，mouseup 落盘必须读 ref 而非渲染闭包 */
  const orderRef = useRef<string[] | null>(platformOrder)
  /** 拖拽开始前的顺序快照：撤销提示要回滚到它 */
  const platformOrderBeforeRef = useRef<string[] | null>(null)
  const dragModuleRef = useRef<ModuleId | null>(null)
  const moduleOrderRef = useRef<string[] | null>(moduleOrder)
  /** 模块拖拽开始前的顺序快照（撤销用） */
  const moduleOrderBeforeRef = useRef<string[] | null>(null)
  /** 撤销提示的序号：连续排序时先销毁上一条，避免提示堆叠刷屏 */
  const msgKeyRef = useRef(0)

  /* ---------- 图表常量：模块级常量要拿 Token 就得搬进组件，用 useMemo 跟着主题重算 ---------- */
  const chartColors = useMemo(
    () => ({ ac: t.success, failed: t.surface3, attempts: t.info, rate: t.warning }),
    [t],
  )
  const axisTick = useMemo(() => ({ fontSize: 11.5, fill: t.text3 }), [t])
  /** 图表网格线：直接是字符串，不需要 useMemo */
  const gridStroke = t.chartGrid
  const chartCursor = useMemo(() => ({ fill: t.chartCursor }), [t])
  const tooltipStyle = useMemo(
    () => ({
      contentStyle: {
        borderRadius: 10,
        border: `1px solid ${t.line}`,
        background: t.surface2,
        // 这是 inline style（不是 SVG 表现属性），var() 可用：阴影跟着主题的 --shadow 走
        boxShadow: 'var(--shadow)',
        fontSize: 12,
      },
      labelStyle: { fontWeight: 600, color: t.text },
      itemStyle: { color: t.text2 },
    }),
    [t],
  )

  /** 按持久化顺序重排平台卡片，新平台追加到末尾 */
  const orderedPlatforms = useMemo(() => {
    if (!stats) return []
    if (!platformOrder) return stats.byPlatform
    const map = new Map(stats.byPlatform.map((p) => [p.platform, p]))
    const ordered = platformOrder.map((k) => map.get(k as PlatformId)).filter(Boolean) as PlatformStat[]
    for (const p of stats.byPlatform) {
      if (!ordered.includes(p)) ordered.push(p)
    }
    return ordered
  }, [stats, platformOrder])

  /** 当前折叠的模块集合：没有用户记录时用默认折叠集合 */
  const collapsedSet = useMemo(() => new Set<string>(collapsedModules ?? COLLAPSED_BY_DEFAULT), [collapsedModules])

  // 只允许「最新一次请求」落地：切换账号视角时旧 scope 的慢响应会晚到，若照常写回会把
  // 新账号的数据盖成旧账号的。与 Problems/Today/Calendar/Contests 的 reqSeq 护栏同款。
  const reqSeq = useRef(0)

  const load = useCallback(() => {
    const seq = (reqSeq.current += 1)
    setLoading(true)
    setLoadError(null)
    // 三个统计接口彼此独立，用 allSettled 分别落地。旧实现是 Promise.all「全成功才落地」
    // 且 catch 只 console.error：任一接口失败（弱项统计是重查询、最易超时）就让三个结果全不落地，
    // 整页退化成「暂无刷题数据 —— 去绑定平台账号」，有数千条提交的用户被告知没数据，
    // 而屏幕上没有任何报错提示（只有 DevTools console）
    Promise.allSettled([
      get<OverallStats>(withScope('/api/stats', scope)),
      get<WeaknessProfile>(withScope('/api/stats/weakness', scope)),
      get<TrendPoint[]>(withScope('/api/stats/trend?weeks=12', scope)),
    ])
      .then(([s, w, t2]) => {
        if (seq !== reqSeq.current) return
        if (s.status === 'fulfilled') setStats(s.value)
        if (w.status === 'fulfilled') setWeak(w.value)
        if (t2.status === 'fulfilled') setTrend(t2.value)
        const failed = [s, w, t2].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
        const msg = failed ? ((failed.reason as Error)?.message ?? '统计数据加载失败') : null
        setLoadError(msg)
        if (msg) message.error(`统计数据加载失败：${msg}`)
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false)
      })
  }, [message, scope])

  useEffect(() => {
    load()
  }, [load])

  // ---------- 排序落盘后的「撤销」提示（§6.2 验收：3 秒内可撤销） ----------

  /**
   * restore 是本次排序前的整份顺序快照：整份写回比记录单次交换更简单，
   * 连续排序产生的中间态也不会漏。连点排序时先 destroy 再 open，避免提示叠成一摞。
   */
  const showOrderUndo = useCallback(
    (restore: () => void) => {
      const key = `dashboard-order-${(msgKeyRef.current += 1)}`
      message.destroy()
      message.open({
        key,
        type: 'success',
        duration: 3,
        content: (
          <span>
            已调整顺序
            <Button
              type="link"
              size="small"
              icon={<UndoOutlined />}
              onClick={() => {
                message.destroy(key)
                restore()
              }}
            >
              撤销
            </Button>
          </span>
        ),
      })
    },
    [message],
  )

  // ---------- 平台卡片拖拽排序（mouse 事件方案，兼容 WebView2/WKWebView） ----------

  const persistPlatformOrder = useCallback(() => {
    const before = platformOrderBeforeRef.current
    const next = orderRef.current
    if (next) savePlatformOrder(next)
    if (before && next && before.join('\u0000') !== next.join('\u0000')) {
      showOrderUndo(() => {
        orderRef.current = before
        setPlatformOrder(before)
        savePlatformOrder(before)
      })
    }
    platformOrderBeforeRef.current = null
  }, [showOrderUndo])

  const clearPlatformDrag = () => {
    dragPlatformRef.current = null
    setDragPlatform(null)
  }

  // 拖拽中松手在卡片外时也要落盘并清除状态
  useEffect(() => {
    if (dragPlatform === null) return
    const onUp = () => {
      persistPlatformOrder()
      clearPlatformDrag()
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [dragPlatform, persistPlatformOrder])

  const handlePlatformMouseDown = (e: ReactMouseEvent<HTMLDivElement>, key: PlatformId) => {
    // 卡片内的键盘排序按钮是独立控件：按它不该发起拖拽（拖拽仍从卡片其他位置发起）
    if ((e.target as HTMLElement).closest('button, .reorder-controls')) return
    e.preventDefault() // 阻止默认行为避免拖拽时选中文本
    platformOrderBeforeRef.current = orderedPlatforms.map((p) => p.platform)
    dragPlatformRef.current = key
    setDragPlatform(key)
  }

  // 悬停到其他卡片时实时重排（被拖卡片移动到目标位置，其余顺延）
  const handlePlatformMouseEnter = (key: PlatformId) => {
    const drag = dragPlatformRef.current
    if (drag === null || drag === key) return
    const keys = orderedPlatforms.map((p) => p.platform)
    const fromIdx = keys.indexOf(drag)
    const toIdx = keys.indexOf(key)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return
    keys.splice(fromIdx, 1)
    keys.splice(toIdx, 0, drag)
    orderRef.current = keys
    setPlatformOrder(keys)
  }

  const handlePlatformMouseUp = () => {
    persistPlatformOrder()
    clearPlatformDrag()
  }

  /** 键盘排序：与相邻平台卡片交换一格，落盘格式与 mouse 拖拽一致（整份 key 数组） */
  const movePlatformCard = (key: PlatformId, delta: -1 | 1) => {
    const keys = orderedPlatforms.map((p) => p.platform)
    const from = keys.indexOf(key)
    const to = from + delta
    if (from < 0 || to < 0 || to >= keys.length) return
    const before = keys.slice()
    keys[from] = before[to]
    keys[to] = before[from]
    orderRef.current = keys
    setPlatformOrder(keys)
    savePlatformOrder(keys)
    showOrderUndo(() => {
      orderRef.current = before
      setPlatformOrder(before)
      savePlatformOrder(before)
    })
  }

  // ---------- 模块卡片拖拽排序（与平台卡片同款 mouse 方案，从卡片头部发起） ----------

  /** 当前渲染顺序：存档顺序 → 未知/重复 id 丢弃 → 缺失模块按默认序补尾 */
  const orderedModules = useMemo(() => applyModuleOrder(moduleOrder), [moduleOrder])

  const handleModuleMouseDown = (e: ReactMouseEvent<HTMLDivElement>, id: ModuleId) => {
    const target = e.target as HTMLElement
    // 只允许从卡片头部发起拖拽：图表/表格等卡片主体的交互不受影响
    if (!target.closest('.ant-card-head')) return
    // 头部内的控件（热力图范围切换、键盘排序/折叠按钮等）照常点击
    if (target.closest('input, button, a, label, .ant-segmented')) return
    e.preventDefault() // 避免拖拽时选中标题文字
    moduleOrderBeforeRef.current = orderedModules.slice()
    dragModuleRef.current = id
    setDragModule(id)
  }

  /** 悬停到其他模块时实时交换位置（被拖模块移到目标位置，其余顺延） */
  const handleModuleMouseEnter = (id: ModuleId) => {
    const drag = dragModuleRef.current
    if (drag === null || drag === id) return
    const ids = orderedModules.slice()
    const from = ids.indexOf(drag)
    const to = ids.indexOf(id)
    if (from === -1 || to === -1 || from === to) return
    ids.splice(from, 1)
    ids.splice(to, 0, drag)
    moduleOrderRef.current = ids
    setModuleOrder(ids)
  }

  const clearModuleDrag = () => {
    dragModuleRef.current = null
    setDragModule(null)
  }

  // 拖拽中松手（任意位置）落盘并清除状态；顺序真的变了才给撤销提示
  useEffect(() => {
    if (dragModule === null) return
    const onUp = () => {
      const before = moduleOrderBeforeRef.current
      const next = moduleOrderRef.current
      if (next) saveModuleOrder(next)
      if (before && next && before.join('\u0000') !== next.join('\u0000')) {
        showOrderUndo(() => {
          moduleOrderRef.current = before
          setModuleOrder(before)
          saveModuleOrder(before)
        })
      }
      moduleOrderBeforeRef.current = null
      clearModuleDrag()
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [dragModule, showOrderUndo])

  /** 键盘排序：与相邻模块交换一格（拖拽之外的并行路径）；落盘格式与拖拽一致（整份 id 数组） */
  const moveModule = (id: ModuleId, delta: -1 | 1) => {
    const ids = orderedModules.slice()
    const from = ids.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= ids.length) return
    const before = ids.slice()
    ids[from] = before[to]
    ids[to] = before[from]
    moduleOrderRef.current = ids
    setModuleOrder(ids)
    saveModuleOrder(ids)
    showOrderUndo(() => {
      moduleOrderRef.current = before
      setModuleOrder(before)
      saveModuleOrder(before)
    })
  }

  /** 折叠/展开一个模块：立刻落盘（[] 也是有效记录 = 用户手动把次要模块都展开过） */
  const toggleModuleCollapsed = (id: ModuleId) => {
    const next = new Set(collapsedSet)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    const ids = [...next]
    setCollapsedModules(ids)
    saveCollapsedModules(ids)
  }

  /**
   * 恢复默认布局：模块顺序 + 折叠记录 + 平台卡片顺序全部清掉。
   *
   * 按钮叫「恢复默认布局」，就该把这一页的可排序状态都还原 —— 只清模块而留下平台卡片的
   * 自定义顺序，用户点完仍会看到「乱着」的平台分布，与按钮承诺不符。
   * 模块顺序的 key 由 moduleOrder.ts 管，写空数组等价于「没有记录」
   * （applyModuleOrder([]) 返回默认序），因此不必在这里重复它的私有 key 字符串。
   */
  const restoreDefaultLayout = () => {
    setModuleOrder(null)
    saveModuleOrder([])
    setCollapsedModules(null)
    setPlatformOrder(null)
    orderRef.current = null
    try {
      localStorage.removeItem(COLLAPSED_KEY)
      localStorage.removeItem(PLATFORM_ORDER_KEY)
    } catch {
      // 隐私模式忽略
    }
    message.success('已恢复默认布局')
  }

  // 一键同步所有已绑定账号（增量），完成后刷新概览数据
  const { refresh: refreshProgress } = useSyncProgress()
  const doSync = async () => {
    if (syncing) return
    setSyncing(true)
    // 立刻拉一次进度：让「同步中」在点下去的下一个渲染就出现，不必等轮询周期
    refreshProgress()
    try {
      const r = await post<SyncAllResponse>('/api/sync/all')
      if (r.results.length === 0) {
        message.info('尚未绑定平台账号 —— 到「设置 → 平台账号与适配器」绑定后即可一键同步')
        return
      }
      const ok = r.results.filter((x) => x.errors.length === 0)
      if (ok.length > 0) {
        message.success(
          `同步完成：${ok
            .map(
              (x) =>
                `${platformName(x.platform)} ${x.imported > 0 ? `+${x.imported} 条` : '无新提交'}${x.incremental ? '' : '（全量）'}`,
            )
            .join(' · ')}`,
        )
      }
      for (const x of r.results) {
        if (x.errors.length > 0) message.warning(`${platformName(x.platform)}：${x.errors[0]}`, 6)
      }
      // 截断提示：提交记录过多已分批同步，提示用户再次同步可继续补全历史
      const truncated = r.results.filter((x) => x.truncated)
      if (truncated.length > 0) {
        message.warning(
          `${truncated.map((x) => platformName(x.platform)).join('、')}：提交记录较多，已分批同步以防触发平台风控；再次点击「同步数据」可继续补全更早的历史记录`,
          8,
        )
      }
      load()
      setSyncTick((t2) => t2 + 1)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSyncing(false)
      // 收尾也立刻刷新一次：让面板显示「已完成 N/M」而不是等下一个轮询周期
      refreshProgress()
    }
  }

  const syncButton = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <AntTooltip
        title="频繁拉取可能触发风控，如刷题记录过多请间隔分次逐渐拉取"
        placement="left"
      >
        <Button icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={doSync}>
          同步数据
        </Button>
      </AntTooltip>
      <SyncProgressHint />
    </div>
  )

  if (loading) return <PageSkeleton />

  if (!stats && loadError) {
    // 加载失败 ≠ 没有数据：旧实现把两者合并成同一个空态，等于给有数据的用户
    // 下「你还没绑定账号」的结论。这里给可重试的错误态，而不是误导性的空态。
    return (
      <div>
        <PageHeader title="数据概览" description="追踪你的训练进度和薄弱环节" extra={syncButton} />
        <SyncStatusCard />
        <Card>
          <InlineError
            message={loadError}
            hint="这块本来显示的是你的训练进度与薄弱环节"
            onRetry={load}
          />
        </Card>
      </div>
    )
  }
  if (!stats || stats.attempts === 0) {
    return (
      <div>
        <PageHeader title="数据概览" description="追踪你的训练进度和薄弱环节" extra={syncButton} />
        {/* 首次同步（还没有任何数据）时也要看得见进度：这正是最容易误以为卡住的时刻 */}
        <SyncStatusCard />
        <Card>
          <EmptyState
            title="暂无刷题数据"
            description="到「设置」绑定平台账号后点右上角「同步数据」，或到「题目管理」手动导入"
            action={{ label: '去绑定平台账号', type: 'primary', onClick: () => nav('/settings') }}
          />
        </Card>
      </div>
    )
  }

  /** 今日聚焦用的最近弱项：只吃本页已拉到的 weak，不再发请求 */
  const focusWeak = weak && weak.items.length > 0 ? weak.items[0] : null

  const diffData = stats.byDifficulty
    .slice()
    // 横轴必须按难度升序（未知最后）：服务端已按档位排序，这里再排一次是为了
    // 兼容旧服务端/本地缓存响应的数据顺序 —— 旧版图里 1400-1599 会排在 1200-1399 前（issue 37）
    .sort((a, b) => compareDifficultyBuckets(a.bucket, b.bucket))
    .map((d: DifficultyStat) => ({
      bucket: d.bucket,
      AC: d.ac,
      未通过: d.attempts - d.ac,
    }))

  const weakData = weak
    ? weak.items.slice(0, 10).map((i) => ({ tag: i.tag, gap: i.gap, acRate: i.acRate, attempts: i.attempts }))
    : []

  const trendData = (trend ?? []).map((p) => ({
    week: p.week,
    attempts: p.attempts,
    AC: p.ac,
    acRate: p.attempts ? Math.round((p.ac / p.attempts) * 1000) / 10 : 0,
  }))

  const moduleNodes: Record<ModuleId, ReactNode> = {
    heatmap: collapsedSet.has('heatmap') ? (
      // 折叠态：热力图卡片头长在 ActivityHeatmap 内部（本切片不改那个文件），这里用同款外壳只渲染头部
      <ModuleCard title="刷题热力图" collapsed onHeadMouseDown={(e) => handleModuleMouseDown(e, 'heatmap')} />
    ) : (
      <ActivityHeatmap
        refreshKey={syncTick}
        scope={scope}
        draggable={{ onMouseDown: (e) => handleModuleMouseDown(e, 'heatmap') }}
      />
    ),
    platforms: (
      <ModuleCard
        title="平台分布"
        collapsed={collapsedSet.has('platforms')}
        extra={
          // 右间距让开绝对定位的键盘排序/折叠控件（它们贴在卡片头部右上角）
          <span style={{ fontSize: 12, color: 'var(--text-3)', marginRight: HEAD_EXTRA_RESERVE }}>
            拖动卡片可排序
          </span>
        }
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'platforms')}
      >
        <div className="platform-card-grid" style={{ userSelect: dragPlatform !== null ? 'none' : undefined }}>
          {orderedPlatforms.map((p, index) => (
            <div
              key={p.platform}
              className={`platform-stat-card reorder-host${dragPlatform === p.platform ? ' is-dragging' : ''}`}
              style={{ position: 'relative' }}
              onMouseDown={(e) => handlePlatformMouseDown(e, p.platform)}
              onMouseEnter={() => handlePlatformMouseEnter(p.platform)}
              onMouseUp={handlePlatformMouseUp}
            >
              <div className="platform-stat-head">
                <PlatformTag id={p.platform} />
                <HolderOutlined className="platform-drag-handle" />
              </div>
              <div className="platform-stat-nums">
                <span>
                  <strong className="mono">{p.attempts}</strong> 提交
                </span>
                <span>
                  <strong className="mono">{p.ac}</strong> AC
                </span>
                <span className="mono" style={{ color: rateColor(p.acRate), fontWeight: 600 }}>
                  {p.acRate}%
                </span>
                <span>
                  <strong className="mono" style={{ color: 'var(--green)' }}>
                    {p.solved}
                  </strong>{' '}
                  已解
                </span>
              </div>
              <ReorderButtons
                label={platformName(p.platform)}
                canUp={index > 0}
                canDown={index < orderedPlatforms.length - 1}
                onMove={(d) => movePlatformCard(p.platform, d)}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
              />
            </div>
          ))}
        </div>
      </ModuleCard>
    ),
    difficulty: (
      <ModuleCard
        title="难度分布（提交数，按 AC / 未通过 堆叠）"
        collapsed={collapsedSet.has('difficulty')}
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'difficulty')}
      >
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={diffData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridStroke} />
            <XAxis dataKey="bucket" tick={axisTick} interval={0} axisLine={false} tickLine={false} />
            <YAxis allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
            <Tooltip {...tooltipStyle} cursor={chartCursor} />
            <Legend {...LEGEND_STYLE} />
            <Bar dataKey="AC" stackId="a" fill={chartColors.ac} radius={[0, 0, 0, 0]} maxBarSize={34} />
            <Bar dataKey="未通过" stackId="a" fill={chartColors.failed} radius={[5, 5, 0, 0]} maxBarSize={34} />
          </BarChart>
        </ResponsiveContainer>
      </ModuleCard>
    ),
    weakness: (
      <ModuleCard
        title="弱项标签（相对自身平均的 AC 率偏差，越大越弱）"
        collapsed={collapsedSet.has('weakness')}
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'weakness')}
      >
        {weakData.length > 0 ? (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={weakData} layout="vertical" margin={{ top: 8, right: 24, left: 40, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={gridStroke} />
              <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="tag"
                width={110}
                tick={{ fontSize: 12, fill: t.text3 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(tag: string, index: number) => {
                  const d = weakData[index];
                  return d && d.attempts < 20 ? `${tag} ⚠️` : tag;
                }}
              />
              <Tooltip
                {...tooltipStyle}
                formatter={(v, name) =>
                  name === 'gap'
                    ? [`${Number(v) > 0 ? '+' : ''}${Number(v)}`, 'AC 率偏差']
                    : [String(v), String(name)]
                }
                labelFormatter={(label: React.ReactNode) => {
                  const d = weakData.find((x) => x.tag === label)
                  return d ? `${String(label)}（样本 ${d.attempts}）` : label
                }}
                cursor={chartCursor}
              />
              <Bar dataKey="gap" radius={[0, 5, 5, 0]} maxBarSize={16}>
                {weakData.map((d) => (
                  // gapColor() 给的是 var(--*)，Cell 的 fill 走 SVG 表现属性不解析 var()，
                  // 所以按语义色调名换成当前主题的计算值
                  <Cell key={d.tag} fill={t[GAP_TONE_BY_VAR[gapColor(d.gap)] ?? 'warning']} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <Empty description="暂无足够样本（各标签至少 5 次提交）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </ModuleCard>
    ),
    trend: (
      <ModuleCard
        title="近 12 周趋势（提交量与 AC 率）"
        collapsed={collapsedSet.has('trend')}
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'trend')}
      >
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={trendData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="rateArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={t.warning} stopOpacity={0.25} />
                <stop offset="100%" stopColor={t.warning} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridStroke} />
            <XAxis
              dataKey="week"
              tick={axisTick}
              tickFormatter={(w: string) => w.slice(5)}
              interval={0}
              axisLine={false}
              tickLine={false}
            />
            <YAxis yAxisId="left" allowDecimals={false} tick={axisTick} axisLine={false} tickLine={false} />
            <YAxis yAxisId="right" orientation="right" domain={[0, 100]} unit="%" tick={axisTick} axisLine={false} tickLine={false} />
            <Tooltip {...tooltipStyle} cursor={chartCursor} />
            <Legend {...LEGEND_STYLE} />
            <Bar yAxisId="left" dataKey="attempts" name="提交" fill={chartColors.attempts} radius={[5, 5, 0, 0]} maxBarSize={16} />
            <Bar yAxisId="left" dataKey="AC" name="AC" fill={chartColors.ac} radius={[5, 5, 0, 0]} maxBarSize={16} />
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="acRate"
              name="AC 率 %"
              stroke={chartColors.rate}
              strokeWidth={2}
              fill="url(#rateArea)"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ModuleCard>
    ),
    history: (
      <ModuleCard
        title="写题历史"
        collapsed={collapsedSet.has('history')}
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'history')}
      >
        {/* 写题历史查询（issue #19）：概览页内直接查「我在哪些平台写过哪些题」，不另开板块 */}
        <HistoryPanel />
      </ModuleCard>
    ),
  }

  return (
    <div>
      <PageHeader
        title="数据概览"
        description="追踪你的训练进度和薄弱环节"
        extra={
          <Space align="start" wrap>
            <AccountScopePicker value={scope} onChange={setScope} />
            <Button size="small" onClick={restoreDefaultLayout}>
              恢复默认布局
            </Button>
            {syncButton}
          </Space>
        }
      />

      {/* 今日聚焦（§5.1）：把「今天去哪练、最近弱在哪、比赛在哪看」提到首屏，降低决策成本。
          数据源只用本页已经拉到的 weak，不再发新请求 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>今日聚焦</span>
          <Button type="primary" onClick={() => nav('/today')}>
            今日训练
          </Button>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            最近弱项：
            {focusWeak ? (
              <>
                <strong style={{ color: 'var(--text)' }}>{focusWeak.tag}</strong>
                <span style={{ color: gapColor(focusWeak.gap), fontWeight: 600 }}>
                  {' '}
                  AC 率偏差 {focusWeak.gap > 0 ? '+' : ''}
                  {Math.round(focusWeak.gap * 10) / 10}
                </span>
              </>
            ) : loadError ? (
              // 弱项接口失败 ≠ 样本不够：不能让失败伪装成「多刷几十题」的结论
              '弱项统计没拉起来，稍后可点右上角「同步数据」重试'
            ) : (
              '样本还不够，先多刷几十题'
            )}
          </span>
          <Button onClick={() => nav('/contests')}>查看赛事中心</Button>
        </div>
      </Card>

      {/* 同步状态：进行中显示逐平台进度；空闲显示上次同步结果（含历史抽屉入口） */}
      <SyncStatusCard />

      <StatStrip
        items={[
          { label: '总提交', value: stats.attempts, icon: <SendOutlined />, tone: 'blue' },
          {
            label: 'AC 率',
            value: (
              <>
                {stats.acRate.toFixed(1)}
                <span className="stat-suffix">%</span>
              </>
            ),
            icon: <CheckCircleOutlined />,
            tone: 'green',
          },
          { label: '已解题目', value: stats.solvedProblems, icon: <TrophyOutlined />, tone: 'violet' },
          {
            label: '活跃平台',
            value: (
              <>
                {stats.byPlatform.filter((p) => p.attempts > 0).length}
                <span className="stat-suffix">个</span>
              </>
            ),
            icon: <RadarChartOutlined />,
            tone: 'amber',
          },
        ]}
      />

      {/* 模块卡片：按住标题栏拖拽可排序，或用头部右上角的按钮键盘排序；
          两条路径都持久化到 localStorage，折叠态单独存一份 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {orderedModules.map((id, index) => {
          const collapsed = collapsedSet.has(id)
          // 热力图展开态的卡片头带范围切换器，键盘控件右移让开它
          const controlsRight = id === 'heatmap' && !collapsed ? HEATMAP_CONTROLS_RIGHT : HEAD_CONTROLS_RIGHT
          return (
            <Col
              key={id}
              xs={24}
              xl={MODULE_SPANS[id]}
              className={`dash-module reorder-host${dragModule === id ? ' is-dragging' : ''}`}
              style={{ position: 'relative' }}
              onMouseEnter={() => handleModuleMouseEnter(id)}
            >
              {/* 键盘路径：与 mouse 拖拽并行，控件是 .reorder-host 的直接子元素 */}
              <ReorderButtons
                label={MODULE_LABELS[id]}
                canUp={index > 0}
                canDown={index < orderedModules.length - 1}
                onMove={(d) => moveModule(id, d)}
                style={{ position: 'absolute', top: 8, right: controlsRight + HEAD_BTN_SIZE + HEAD_BTN_GAP, zIndex: 3 }}
              />
              <CollapseToggle
                label={MODULE_LABELS[id]}
                collapsed={collapsed}
                onToggle={() => toggleModuleCollapsed(id)}
                style={{ position: 'absolute', top: 8, right: controlsRight, zIndex: 3 }}
              />
              {moduleNodes[id]}
            </Col>
          )
        })}
      </Row>
    </div>
  )
}
