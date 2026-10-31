import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Button, Card, Checkbox, Col, Dropdown, Empty, Row, Space, App as AntdApp, Tooltip as AntTooltip } from 'antd'
import {
  IconArrowDown,
  IconArrowUp,
  IconCheckCircle,
  IconChevronDown,
  IconChevronUp,
  IconGrip,
  IconRadar,
  IconReset,
  IconSend,
  IconSync,
  IconTrophy,
  IconUndo,
} from '../components/icons'
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
import { useSyncProgress } from '../syncProgressCore'
import { applyModuleOrder, loadModuleOrder, saveModuleOrder, type ModuleId } from '../moduleOrder'
import { readJson, writeJson } from '../persistence.ts'
import { platformName, useTokenColors, type TokenName } from '../ui'
import { get, post } from '../api'
import type { PlatformId, SyncResult } from '../../../shared/src/index.ts'
import { compareDifficultyBuckets } from '../../../shared/src/difficulty.ts'

interface SyncAllResponse {
  results: Array<SyncResult & { durationMs?: number }>
}

/** 平台卡片拖拽顺序持久化（localStorage，与侧边栏菜单/模板分类同模式） */
const PLATFORM_ORDER_KEY = 'icpc-platform-card-order-v1'
function getPlatformOrder(): string[] | null {
  return readJson<string[]>(PLATFORM_ORDER_KEY)
}
function savePlatformOrder(keys: string[]): void {
  writeJson(PLATFORM_ORDER_KEY, keys)
}

/**
 * 模块折叠态持久化：存「已折叠」的 id 数组。
 * 与 moduleOrder.ts 的顺序 key 各存一份，互不影响（折叠不该改动顺序，反之亦然）。
 */
const COLLAPSED_KEY = 'icpc-dashboard-module-collapsed-v1'
/**
 * 次要模块默认折叠：首屏保留热力图 / 平台分布 / 难度分布 / 弱项 / 趋势这五块主视图，
 * 只有「写题历史」按需展开（它是查询工具，不是"看一眼"的数据）。
 * 热力图从默认折叠改为默认展开：它是本页最直观的训练密度视图，
 * 极简重构后卡片更矮、留白更足，展开也不会把首屏撑长。
 */
const COLLAPSED_BY_DEFAULT = new Set<string>(['history'])
function loadCollapsedModules(): string[] | null {
  return readJson<string[]>(COLLAPSED_KEY)
}
function saveCollapsedModules(ids: string[]): void {
  writeJson(COLLAPSED_KEY, ids)
}

/**
 * 「同步数据」勾选账号持久化：存勾选过的「platform/handle」数组。
 * null（无记录）= 从未操作过 → 全选；[] = 用户手动全取消过（与「无记录」区分开）。
 * 失效勾选（账号后来被解绑/停用）不回写清理，渲染时按当前账号列表过滤即可——
 * 留着它，账号重新绑定后勾选意图自动恢复。
 */
const SYNC_CHECKED_KEY = 'icpc-dashboard-sync-checked-v1'
function loadSyncChecked(): Set<string> | null {
  const saved = readJson<string[]>(SYNC_CHECKED_KEY)
  return saved ? new Set(saved) : null
}
function saveSyncChecked(keys: ReadonlySet<string>): void {
  writeJson(SYNC_CHECKED_KEY, [...keys])
}

/**
 * AC 率的语义分档（只影响文字颜色）：
 * ≥50% 判为正向（绿）、30~50% 判为中性（深灰）、<30% 判为偏弱（橙）。
 * 阈值与 uiFormat.rateTone 一致，但这里只做「颜色类名」映射，
 * 不改变任何统计口径。
 */
function rateClass(rate: number): string {
  if (rate >= 50) return 'is-rate-good'
  if (rate >= 30) return 'is-rate-fair'
  return 'is-rate-poor'
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
/** 卡片头的内边距（antd Card size="small"） */
const CARD_HEAD_PAD = 12
/** 普通模块头部的键盘控件右偏移 */
const HEAD_CONTROLS_RIGHT = CARD_HEAD_PAD
/**
 * 热力图头部的右偏移：与普通卡片一致。
 *
 * 旧实现把控件整体左移到切换器左侧（硬编码 190px），但切换器宽度随字号/缩放变化，
 * 一旦变宽就会被按钮压住。现在统一改成「控件贴右，卡片头留出固定的右侧通道」
 * （见 index.css 的 .dash-module .ant-card-head-wrapper 内边距），
 * 切换器无论多宽都在通道左侧换行或收窄，不会和按钮重叠。
 */
const HEATMAP_CONTROLS_RIGHT = CARD_HEAD_PAD

/**
 * 图例统一样式：**顶部右对齐**（设计规范：图例移到图表顶部右侧）。
 * recharts 的 Legend 支持 verticalAlign/align，直接交给它排版，
 * 比用 CSS 去挪 absolute 定位的容器可靠得多。
 */
const LEGEND_STYLE = {
  fontSize: 12,
  iconType: 'circle',
  iconSize: 8,
  verticalAlign: 'top',
  align: 'right',
  // 顶部图例与绘图区之间留一点空气，避免贴住柱顶
  wrapperStyle: { paddingBottom: 12 },
} as const

/**
 * 弱项柱的填充色：**语义化的三段色阶**。
 *
 * 这里是"警示"语义的正主：缺口 >15 用柔和红、>5 用柔和橙、否则用低饱和绿。
 * 与 AC 率、同步健康度共用同一套四色，读者不需要重新学配色。
 * 之所以仍然克制：三档都是低饱和版本，柱长本身已经编码了程度，
 * 颜色只是让"哪几个标签最该补"在扫视时跳出来。
 * 取的是**具体色值**——recharts 把 fill 写进 SVG 表现属性，var() 在其中不生效。
 */
function gapShade(gap: number, t: Record<TokenName, string>): string {
  if (gap > 15) return t.chartFillDanger
  if (gap > 5) return t.chartFillWarn
  return t.chartFillPositive
}

/**
 * 模块卡片在 xl 布局的宽度（24 = 整行）；拖拽只改顺序，不改宽度。
 *
 * 极简重构后的网格：整行模块（热力图 / 平台分布 / 趋势 / 历史）与
 * 并排两列（难度分布 + 弱项标签）交替，形成规整的卡片式网格；
 * 平台分布改为整行后，9 个平台卡按 auto-fill 排成 2 行而不是竖着堆 5 行。
 */
const MODULE_SPANS: Record<ModuleId, number> = {
  heatmap: 24,
  platforms: 24,
  difficulty: 12,
  weakness: 12,
  trend: 24,
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
        <IconArrowUp size={13} />
      </button>
      <button
        type="button"
        className="reorder-btn"
        disabled={!canDown}
        title={`下移「${label}」`}
        aria-label={`下移「${label}」`}
        onClick={() => onMove(1)}
      >
        <IconArrowDown size={13} />
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
      {collapsed ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
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
          <IconGrip size={14} className="module-drag-handle" />
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
  /** 「同步数据」下拉勾选的账号（platform/handle），null = 尚未操作过 → 视为全选；localStorage 持久化 */
  const [syncChecked, setSyncChecked] = useState<Set<string> | null>(loadSyncChecked)
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
  /**
   * 图表配色：AC 用低饱和绿（唯一保留的彩色），「未通过 / 提交量」用中性灰，
   * 折线（AC 率）用深灰 —— 极简扁平化下图表只保留一个彩色维度，
   * 其余信息靠明度阶梯区分，避免三色混战。
   */
  const chartColors = useMemo(
    () => ({ ac: t.chartFillPositive, failed: t.chartNeutral1, attempts: t.chartNeutral2, rate: t.text2 }),
    [t],
  )
  const axisTick = useMemo(() => ({ fontSize: 11.5, fill: t.text3 }), [t])
  /** 图表网格线：直接是字符串，不需要 useMemo */
  const gridStroke = t.chartGrid
  const chartCursor = useMemo(() => ({ fill: t.chartCursor }), [t])
  const tooltipStyle = useMemo(
    () => ({
      contentStyle: {
        borderRadius: 12,
        border: `1px solid ${t.line}`,
        background: t.surface2,
        // 扁平化：浮层不给投影（亮色下 --shadow 已是 none，暗色保留原有层次）
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
              icon={<IconUndo size={13} />}
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

  // useCallback：被 handlePlatformMouseUp（useCallback）与拖拽 effect 引用，保持稳定引用
  const clearPlatformDrag = useCallback(() => {
    dragPlatformRef.current = null
    setDragPlatform(null)
  }, [])

  // 拖拽中松手在卡片外时也要落盘并清除状态
  useEffect(() => {
    if (dragPlatform === null) return
    const onUp = () => {
      persistPlatformOrder()
      clearPlatformDrag()
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [dragPlatform, persistPlatformOrder, clearPlatformDrag])

  // useCallback：moduleNodes 的 useMemo 引用这些拖拽入口，不包稳定则 memo 每帧失效。
  // 实际拖拽状态走 ref + setState，不依赖渲染闭包
  const handlePlatformMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>, key: PlatformId) => {
    // 卡片内的键盘排序按钮是独立控件：按它不该发起拖拽（拖拽仍从卡片其他位置发起）
    if ((e.target as HTMLElement).closest('button, .reorder-controls')) return
    e.preventDefault() // 阻止默认行为避免拖拽时选中文本
    platformOrderBeforeRef.current = orderedPlatforms.map((p) => p.platform)
    dragPlatformRef.current = key
    setDragPlatform(key)
  }, [orderedPlatforms])

  // 悬停到其他卡片时实时重排（被拖卡片移动到目标位置，其余顺延）
  const handlePlatformMouseEnter = useCallback((key: PlatformId) => {
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
  }, [orderedPlatforms])

  const handlePlatformMouseUp = useCallback(() => {
    persistPlatformOrder()
    clearPlatformDrag()
  }, [persistPlatformOrder, clearPlatformDrag])

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

  const handleModuleMouseDown = useCallback((e: ReactMouseEvent<HTMLDivElement>, id: ModuleId) => {
    const target = e.target as HTMLElement
    // 只允许从卡片头部发起拖拽：图表/表格等卡片主体的交互不受影响
    if (!target.closest('.ant-card-head')) return
    // 头部内的控件（热力图范围切换、键盘排序/折叠按钮等）照常点击
    if (target.closest('input, button, a, label, .ant-segmented')) return
    e.preventDefault() // 避免拖拽时选中标题文字
    moduleOrderBeforeRef.current = orderedModules.slice()
    dragModuleRef.current = id
    setDragModule(id)
  }, [orderedModules])

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

  // 一键同步已绑定账号（增量），完成后刷新概览数据
  const { refresh: refreshProgress, statuses: syncStatuses } = useSyncProgress()
  /** 可勾选同步的账号清单：只列已启用的绑定（停用的账号即使勾了后端也会拒绝） */
  const syncAccountOptions = useMemo(
    () =>
      syncStatuses.flatMap((s) =>
        (s.accounts ?? [])
          .filter((a) => a.enabled)
          .map((a) => ({
            key: `${s.platform}/${a.handle}`,
            platform: s.platform,
            handle: a.handle,
          })),
      ),
    [syncStatuses],
  )
  /** 有效勾选集：未操作过（null）= 全选；操作过则剔除已解绑/停用的失效勾选 */
  const effectiveChecked = useMemo(() => {
    if (syncChecked === null) return new Set(syncAccountOptions.map((o) => o.key))
    const valid = new Set(syncAccountOptions.map((o) => o.key))
    return new Set([...syncChecked].filter((k) => valid.has(k)))
  }, [syncChecked, syncAccountOptions])
  const allChecked =
    syncAccountOptions.length > 0 && effectiveChecked.size === syncAccountOptions.length
  const doSync = async (targets?: Array<{ platform: PlatformId; handle: string }>) => {
    if (syncing) return
    // targets 省略 = 同步全部启用账号（主按钮，保持原一键语义）；
    // 传入 = 只同步勾选账号（下拉菜单「同步选中」）。勾选缓存可能过期
    // （账号被解绑/停用），后端会再校验一次，对不上直接 400。
    if (targets !== undefined && targets.length === 0) {
      message.warning('请先勾选要同步的账号')
      return
    }
    setSyncing(true)
    // 立刻拉一次进度：让「同步中」在点下去的下一个渲染就出现，不必等轮询周期
    refreshProgress()
    try {
      const r = await post<SyncAllResponse>(
        '/api/sync/all',
        targets === undefined ? undefined : { accounts: targets },
      )
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

  const toggleSyncChecked = (key: string, checked: boolean) => {
    // 首次操作从「全选」开始改动：null（未操作过）与全选集同义，但不能直接在 null 上增减
    const base = syncChecked === null ? new Set(syncAccountOptions.map((o) => o.key)) : new Set(syncChecked)
    if (checked) base.add(key)
    else base.delete(key)
    setSyncChecked(base)
    saveSyncChecked(base)
  }
  const setAllSyncChecked = (checked: boolean) => {
    const next = checked ? new Set(syncAccountOptions.map((o) => o.key)) : new Set<string>()
    setSyncChecked(next)
    saveSyncChecked(next)
  }
  /** 部分勾选时主按钮文案带上数量，让用户点之前就知道这次同步的不是全平台 */
  const syncButtonLabel =
    syncChecked !== null && !allChecked && effectiveChecked.size > 0
      ? `同步选中（${effectiveChecked.size}）`
      : '同步数据'

  /** 下拉勾选面板：复用全局同步状态里的账号列表（与「同步状态」卡同源，不额外发请求） */
  const syncPickerContent = (
    <div className="sync-picker-panel" style={{ minWidth: 240, maxWidth: 320 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <Checkbox
          checked={allChecked}
          indeterminate={effectiveChecked.size > 0 && !allChecked}
          onChange={(e) => setAllSyncChecked(e.target.checked)}
        >
          全选
        </Checkbox>
        <span style={{ fontSize: 12, color: t.text3 }}>
          {effectiveChecked.size}/{syncAccountOptions.length} 个账号
        </span>
      </div>
      {syncAccountOptions.length === 0 ? (
        <div style={{ fontSize: 12, color: t.text3 }}>
          暂无已启用的账号绑定，到「设置 → 平台账号与适配器」绑定后即可勾选同步
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {syncAccountOptions.map((o) => (
            <Checkbox
              key={o.key}
              checked={effectiveChecked.has(o.key)}
              onChange={(e) => toggleSyncChecked(o.key, e.target.checked)}
            >
              <PlatformTag id={o.platform} />
              <span style={{ marginLeft: 6 }}>{o.handle}</span>
            </Checkbox>
          ))}
        </div>
      )}
      <div style={{ marginTop: 10, textAlign: 'right' }}>
        <Button
          size="small"
          type="primary"
          disabled={effectiveChecked.size === 0 || syncing}
          onClick={() =>
            void doSync(
              syncAccountOptions
                .filter((o) => effectiveChecked.has(o.key))
                .map((o) => ({ platform: o.platform, handle: o.handle })),
            )
          }
        >
          同步选中（{effectiveChecked.size}）
        </Button>
      </div>
    </div>
  )

  const syncButton = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <Space.Compact>
        <AntTooltip
          title="频繁拉取可能触发风控，如刷题记录过多请间隔分次逐渐拉取"
          placement="left"
        >
          <Button
            type="primary"
            icon={<IconSync size={15} className={syncing ? 'icon-spin' : undefined} />}
            loading={syncing}
            onClick={() =>
              void doSync(
                // 用户在勾选面板里做过取舍就按勾选范围同步；从未碰过勾选 = 保持原「一键全部」
                syncChecked === null || allChecked
                  ? undefined
                  : syncAccountOptions
                      .filter((o) => effectiveChecked.has(o.key))
                      .map((o) => ({ platform: o.platform, handle: o.handle })),
              )
            }
          >
            {syncButtonLabel}
          </Button>
        </AntTooltip>
        <Dropdown
          dropdownRender={() => syncPickerContent}
          trigger={['click']}
          placement="bottomRight"
        >
          <Button icon={<IconChevronDown size={14} />} aria-label="选择要同步的账号" />
        </Dropdown>
      </Space.Compact>
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
  const focusGap = focusWeak ? (focusWeak.evidenceGap ?? focusWeak.gap) : 0

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
    ? weak.items.slice(0, 10).map((i) => ({ tag: i.tag, gap: i.evidenceGap ?? i.gap, acRate: i.acRate, attempts: i.attempts, sampleSize: i.evidence?.sampleSize ?? i.attempts }))
    : []

  /**
   * 「近 4 周 AC 率」相对「总 AC 率」的差值（百分点）—— 一个真正有信息量的对照。
   *
   * 为什么不是「与各平台均值比」：AC 率本身就是 ac/attempts，按提交量加权后
   * 恰好等于总 AC 率，差值恒为 0，属于**看起来有、实际为零**的假指标。
   * 改成"最近 vs 整体"才有意义：正数 = 近期在进步（绿），负数 = 近期在下滑（橙）。
   * 样本太小（近期提交 < 10 次）时不显示，避免用噪声给出误导性的红绿结论。
   */
  const acDelta = (() => {
    if (!trend || trend.length === 0 || stats.attempts < 20) return null
    const recent = trend.slice(-4)
    const attempts = recent.reduce((s, p) => s + p.attempts, 0)
    if (attempts < 10) return null
    const ac = recent.reduce((s, p) => s + p.ac, 0)
    const recentRate = (ac / attempts) * 100
    const delta = recentRate - stats.acRate
    // 差值为 0（或小到读不出意义）时不显示徽章
    return Math.abs(delta) < 0.5 ? null : delta
  })()

  const trendData = (trend ?? []).map((p) => ({
    week: p.week,
    attempts: p.attempts,
    AC: p.ac,
    acRate: p.attempts ? Math.round((p.ac / p.attempts) * 1000) / 10 : 0,
  }))

  // 注意：不能给这份约 190 行的 JSX 记录套 useMemo —— 它在 loading/错误/空态三个
  // early return 之后（rules-of-hooks：Hooks 必须无条件调用）。拖拽换位的重渲染开销
  // 由下方 useCallback 化的拖拽入口与 recharts 自身的数据 diff 兜住大半。
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
          // 右间距让开绝对定位的键盘排序/折叠控件（它们贴在卡片头部右上角）。
          // 极简重构后这句提示收进 title 属性，卡片头部只留标题，不再有第二行文字抢视线。
          <span className="card-head-hint" title="拖动卡片头部可排序" aria-hidden="true" />
        }
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'platforms')}
      >
        <div className="platform-card-grid" style={{ userSelect: dragPlatform !== null ? 'none' : undefined }}>
          {orderedPlatforms.map((p, index) => (
            <div
              key={p.platform}
              className={`platform-stat-card reorder-host${dragPlatform === p.platform ? ' is-dragging' : ''}${p.attempts === 0 ? ' is-empty' : ''}`}
              style={{ position: 'relative' }}
              onMouseDown={(e) => handlePlatformMouseDown(e, p.platform)}
              onMouseEnter={() => handlePlatformMouseEnter(p.platform)}
              onMouseUp={handlePlatformMouseUp}
            >
              {/* 头部：平台名在左，AC 率贴右。
                  AC 率放这里而不是跟三项主数据并排 —— 它是"比率"，与"计数"不同量纲，
                  并排会让数值行按内容长度换行，卡片高度就参差不齐了。 */}
              <div className="platform-stat-head">
                <PlatformTag id={p.platform} />
                {/* AC 率按高低着色：≥50% 绿、30~50% 中性、<30% 橙 —— 一眼看出哪个平台拖后腿 */}
                <span className={`mono is-rate ${rateClass(p.acRate)}`}>{p.acRate}%</span>
                <IconGrip size={13} className="platform-drag-handle" />
              </div>
              {/* 三项主数据：数值大而粗、标签小而灰，一行排开不换行（规范 §2） */}
              <div className="platform-stat-nums">
                <span className="platform-stat-num">
                  <strong className="mono">{p.attempts}</strong>
                  <em className="platform-stat-unit">提交</em>
                </span>
                <span className="platform-stat-num">
                  <strong className="mono">{p.ac}</strong>
                  <em className="platform-stat-unit">AC</em>
                </span>
                <span className="platform-stat-num">
                  <strong className="mono is-solved">{p.solved}</strong>
                  <em className="platform-stat-unit">已解</em>
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
        <ResponsiveContainer width="100%" height={300}>
          {/* 顶部留 44px 给图例（图例移到顶部右侧后需要额外垂直空间） */}
          <BarChart data={diffData} margin={{ top: 44, right: 8, left: 0, bottom: 0 }} barCategoryGap="32%">
            {/* 横向虚线网格已移除（规范：移除或淡化 Y 轴数值与横向虚线网格）。
                竖向网格本来就没有，这里整块不渲染 CartesianGrid */}
            <XAxis
              dataKey="bucket"
              tick={{ fontSize: 11, fill: t.text3 }}
              interval={0}
              axisLine={false}
              tickLine={false}
              /* 难度标签紧凑横向排列：不换行、不倾斜，靠缩小字号塞下 */
              tickMargin={10}
              height={28}
            />
            {/* Y 轴数值同样移除：柱高本身编码了提交量，刻度只增加噪声 */}
            <Tooltip {...tooltipStyle} cursor={chartCursor} />
            <Legend {...LEGEND_STYLE} />
            {/* isAnimationActive={false}：Recharts 的柱体生长动画用 rAF 驱动 SVG 属性插值，
                每次 load() 刷新都会重播一轮（三张图叠加），期间 GPU 持续重绘。
                数据概览是「看数」不是「看动效」，直接关掉省一整段合成开销 */}
            {/* 统一小圆角：两段都写 6px 顶角。堆叠时上段（未通过）盖住下段（AC）的圆角，
                所以看上去仍是"整根柱子一个圆顶"；当未通过为 0 时 AC 独自成柱，
                圆角正好露出来 —— 两种情况都是圆顶，不会出现半截方头 */}
            <Bar dataKey="AC" stackId="a" fill={chartColors.ac} radius={[6, 6, 0, 0]} maxBarSize={30} isAnimationActive={false} />
            <Bar dataKey="未通过" stackId="a" fill={chartColors.failed} radius={[6, 6, 0, 0]} maxBarSize={30} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ModuleCard>
    ),
    weakness: (
      <ModuleCard
        title="弱项标签（综合 AC 率、卡点与复习证据）"
        collapsed={collapsedSet.has('weakness')}
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'weakness')}
      >
        {weakData.length > 0 ? (
          <>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={weakData} layout="vertical" margin={{ top: 8, right: 24, left: 40, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={gridStroke} />
              <XAxis type="number" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="tag"
                width={116}
                tick={{ fontSize: 12, fill: t.text3 }}
                axisLine={false}
                tickLine={false}
                // 样本不足用尾随的中性圆点标记，不用 emoji：极简界面里彩色 emoji
                // 会在灰阶图表中跳出来，且与"低饱和"的配色纪律冲突
                tickFormatter={(tag: string, index: number) => {
                  const d = weakData[index];
                  return d && d.sampleSize < 5 ? `${tag} ·` : tag;
                }}
              />
              <Tooltip
                {...tooltipStyle}
                formatter={(v, name) =>
                  name === 'gap'
                    ? [`${Number(v) > 0 ? '+' : ''}${Number(v)}`, '补强缺口（百分点）']
                    : [String(v), String(name)]
                }
                labelFormatter={(label: React.ReactNode) => {
                  const d = weakData.find((x) => x.tag === label)
                  return d ? `${String(label)}（去重样本 ${d.sampleSize} 题，AC 率 ${d.acRate}%${d.sampleSize < 5 ? '，样本不足' : ''}）` : label
                }}
                cursor={chartCursor}
              />
              <Bar dataKey="gap" radius={[0, 5, 5, 0]} maxBarSize={16} isAnimationActive={false}>
                {weakData.map((d) => (
                  // 语义色阶：红(>15) / 橙(>5) / 绿(其余)，与全站四色体系一致
                  <Cell key={d.tag} fill={gapShade(d.gap, t)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {/* 图例说明：把「·」的含义写清楚，替代原先坐标轴上的 emoji 警告 */}
          <p className="chart-caption">· 表示该标签的去重样本不足 5 题，结论仅供参考</p>
          </>
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
            {/* 扁平化：AC 率面积不再用自上而下的渐变，改为单一低透明度实色 */}
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
            <Bar yAxisId="left" dataKey="attempts" name="提交" fill={chartColors.attempts} radius={[5, 5, 0, 0]} maxBarSize={16} isAnimationActive={false} />
            <Bar yAxisId="left" dataKey="AC" name="AC" fill={chartColors.ac} radius={[5, 5, 0, 0]} maxBarSize={16} isAnimationActive={false} />
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="acRate"
              name="AC 率 %"
              stroke={chartColors.rate}
              strokeWidth={2}
              fill={chartColors.rate}
              // 曲线下面积：0.08 曾淡到与卡片底几乎无差，提到 0.12 让"覆盖范围"可辨
              fillOpacity={0.12}
              isAnimationActive={false}
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
    <div className="dash-page">
      <PageHeader
        title="数据概览"
        description="追踪你的训练进度和薄弱环节"
        extra={
          <Space align="start" wrap>
            <AccountScopePicker value={scope} onChange={setScope} />
            <Button icon={<IconReset size={14} />} onClick={restoreDefaultLayout}>
              恢复默认布局
            </Button>
            {syncButton}
          </Space>
        }
      />

      {/*
        今日聚焦（§5.1）：把「今天去哪练、最近弱在哪、比赛在哪看」提到首屏，降低决策成本。
        数据源只用本页已经拉到的 weak，不再发新请求。
        极简重构后它从「一张带边框的卡」变成页头下的**扁平信息条**：左侧一句提示 +
        中间弱项读数 + 右侧两个动作，不再占一张卡片的视觉权重（首屏的主角是数据）。
      */}
      <section className="focus-strip">
        <div className="focus-strip-copy">
          <span className="focus-strip-label">今日聚焦</span>
          <span className="focus-strip-text">
            最近弱项：
            {focusWeak ? (
              <>
                <strong className="focus-strip-tag">{focusWeak.tag}</strong>
                <span className={`focus-strip-gap ${focusGap > 5 ? 'is-warn' : 'is-ok'}`}>
                  补强缺口 {focusGap > 0 ? '+' : ''}
                  {Math.round(focusGap * 10) / 10}
                </span>
              </>
            ) : loadError ? (
              // 弱项接口失败 ≠ 样本不够：不能让失败伪装成「多刷几十题」的结论
              '弱项统计没拉起来，稍后可点右上角「同步数据」重试'
            ) : (
              '样本还不够，先多刷几十题'
            )}
          </span>
        </div>
        <div className="focus-strip-actions">
          <Button type="primary" onClick={() => nav('/today')}>
            今日训练
          </Button>
          <Button onClick={() => nav('/contests')}>查看赛事中心</Button>
        </div>
      </section>

      {/* 同步状态：进行中显示逐平台进度；空闲显示上次同步结果（含历史抽屉入口） */}
      <SyncStatusCard />

      {/* 核心指标：四张独立白卡（大留白、无竖线分隔），数值用字号 + 字重拉层级 */}
      <section className="dash-stats">
        <StatStrip
          items={[
            // 四个指标各自承担一种语义：核心量（蓝）/ 正向率（绿）/ 正向成果（绿）/ 中性规模（黑）
            {
              label: '总提交',
              value: stats.attempts,
              icon: <IconSend size={16} />,
              tone: 'blue',
              valueTone: 'core',
            },
            {
              label: 'AC 率',
              value: (
                <>
                  {stats.acRate.toFixed(1)}
                  <span className="stat-suffix">%</span>
                </>
              ),
              icon: <IconCheckCircle size={16} />,
              tone: 'green',
              valueTone: 'positive',
              // 与「平台平均 AC 率」的差值：正 = 高于平均（绿），负 = 低于平均（橙）
              // 徽章语义：近 4 周相对总体的变化（+ 进步 / − 下滑），title 说明口径
              badge:
                acDelta === null ? undefined : (
                  <span
                    className={`stat-delta ${acDelta >= 0 ? 'is-up' : 'is-down'}`}
                    title={`近 4 周 AC 率相对总体 ${acDelta >= 0 ? '高' : '低'} ${Math.abs(acDelta).toFixed(1)} 个百分点`}
                  >
                    {acDelta >= 0 ? '+' : ''}
                    {acDelta.toFixed(1)}
                  </span>
                ),
            },
            {
              label: '已解题目',
              value: stats.solvedProblems,
              icon: <IconTrophy size={16} />,
              tone: 'cyan',
              valueTone: 'positive',
            },
            {
              label: '活跃平台',
              value: (
                <>
                  {stats.byPlatform.filter((p) => p.attempts > 0).length}
                  <span className="stat-suffix">个</span>
                </>
              ),
              icon: <IconRadar size={16} />,
              tone: 'amber',
              valueTone: 'neutral',
            },
          ]}
        />
      </section>

      {/* 模块卡片：按住标题栏拖拽可排序，或用头部右上角的按钮键盘排序；
          两条路径都持久化到 localStorage，折叠态单独存一份 */}
      {/* gutter：[横向 24, 纵向 32]。纵向就是"三大区块之间的垂直间距"，
          与 --grid-gap / --section-gap 同源（亮暗共用同一组几何值） */}
      <Row gutter={[24, 32]} className="dash-grid">
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
