import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Button, Card, Col, Empty, Row, Spin, App as AntdApp, Tooltip as AntTooltip } from 'antd'
import {
  CheckCircleOutlined,
  HolderOutlined,
  RadarChartOutlined,
  SendOutlined,
  SyncOutlined,
  TrophyOutlined,
} from '@ant-design/icons'
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
import SyncProgressHint from '../components/SyncProgressHint'
import { useSyncProgress } from '../syncProgressContext'
import { applyModuleOrder, loadModuleOrder, saveModuleOrder, type ModuleId } from '../moduleOrder'
import { platformName, rateColor } from '../ui'
import { get, post } from '../api'
import type { PlatformId, SyncResult } from '../../../shared/src/index.ts'

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

const CHART_COLORS = {
  ac: '#69d7a5',
  failed: '#3a424f',
  attempts: '#58a3ff',
  rate: '#f2c46d',
}

const AXIS_TICK = { fontSize: 11.5, fill: '#8993a2' }
const GRID_STROKE = 'rgba(255, 255, 255, 0.06)'
const LEGEND_STYLE = { fontSize: 12, iconType: 'circle', iconSize: 8 } as const

const TOOLTIP_STYLE = {
  contentStyle: {
    borderRadius: 10,
    border: '1px solid #2a3039',
    background: '#1d212a',
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.4)',
    fontSize: 12,
  },
  labelStyle: { fontWeight: 600, color: '#f5f7fb' },
  itemStyle: { color: '#c4cad4' },
} as const

function gapColorHex(gap: number): string {
  if (gap > 15) return '#ff5d70'
  if (gap > 5) return '#ffbd61'
  if (gap > 0) return '#f2c46d'
  return '#69d7a5'
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

/** 模块卡片统一外壳：标题前放拖拽把手，卡片根上的 mousedown 由模块拖拽逻辑过滤（仅头部发起） */
function ModuleCard({
  title,
  extra,
  onHeadMouseDown,
  children,
}: {
  title: ReactNode
  extra?: ReactNode
  onHeadMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => void
  children: ReactNode
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
    >
      {children}
    </Card>
  )
}

export default function Dashboard() {
  const { message } = AntdApp.useApp()
  const [stats, setStats] = useState<OverallStats | null>(null)
  const [weak, setWeak] = useState<WeaknessProfile | null>(null)
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [platformOrder, setPlatformOrder] = useState<string[] | null>(getPlatformOrder)
  const [dragPlatform, setDragPlatform] = useState<PlatformId | null>(null)
  /** 同步完成后自增，驱动热力图等自带请求的子卡片重新拉数 */
  const [syncTick, setSyncTick] = useState(0)
  /** 拖拽源平台（ref 即时读写，不依赖 state 异步更新） */
  const dragPlatformRef = useRef<PlatformId | null>(null)
  /** 最新顺序镜像：mousemove 是连续事件，渲染会延迟一帧，mouseup 落盘必须读 ref 而非渲染闭包 */
  const orderRef = useRef<string[] | null>(platformOrder)

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

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      get<OverallStats>('/api/stats'),
      get<WeaknessProfile>('/api/stats/weakness'),
      get<TrendPoint[]>('/api/stats/trend?weeks=12'),
    ])
      .then(([s, w, t]) => {
        setStats(s)
        setWeak(w)
        setTrend(t)
      })
      .catch((e: Error) => console.error(e))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // ---------- 平台卡片拖拽排序（mouse 事件方案，兼容 WebView2/WKWebView） ----------

  const persistPlatformOrder = () => {
    if (orderRef.current) savePlatformOrder(orderRef.current)
  }

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
  }, [dragPlatform])

  const handlePlatformMouseDown = (e: ReactMouseEvent<HTMLDivElement>, key: PlatformId) => {
    e.preventDefault() // 阻止默认行为避免拖拽时选中文本
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

  // ---------- 模块卡片拖拽排序（与平台卡片同款 mouse 方案，从卡片头部发起） ----------

  const [moduleOrder, setModuleOrder] = useState<string[] | null>(loadModuleOrder)
  const [dragModule, setDragModule] = useState<ModuleId | null>(null)
  const dragModuleRef = useRef<ModuleId | null>(null)
  const moduleOrderRef = useRef<string[] | null>(moduleOrder)

  /** 当前渲染顺序：存档顺序 → 未知/重复 id 丢弃 → 缺失模块按默认序补尾 */
  const orderedModules = useMemo(() => applyModuleOrder(moduleOrder), [moduleOrder])

  const handleModuleMouseDown = (e: ReactMouseEvent<HTMLDivElement>, id: ModuleId) => {
    const target = e.target as HTMLElement
    // 只允许从卡片头部发起拖拽：图表/表格等卡片主体的交互不受影响
    if (!target.closest('.ant-card-head')) return
    // 头部内的控件（热力图范围切换等）照常点击
    if (target.closest('input, button, a, label, .ant-segmented')) return
    e.preventDefault() // 避免拖拽时选中标题文字
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

  // 拖拽中松手（任意位置）落盘并清除状态
  useEffect(() => {
    if (dragModule === null) return
    const onUp = () => {
      if (moduleOrderRef.current) saveModuleOrder(moduleOrderRef.current)
      clearModuleDrag()
    }
    document.addEventListener('mouseup', onUp)
    return () => document.removeEventListener('mouseup', onUp)
  }, [dragModule])

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
      setSyncTick((t) => t + 1)
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

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
  if (!stats || stats.attempts === 0) {
    return (
      <div>
        <PageHeader title="数据概览" description="追踪你的训练进度和薄弱环节" extra={syncButton} />
        {/* 首次同步（还没有任何数据）时也要看得见进度：这正是最容易误以为卡住的时刻 */}
        <SyncStatusCard />
        <Card>
          <Empty
            description="暂无刷题数据 —— 到「设置」绑定平台账号后点右上角「同步数据」，或到「题目管理」手动导入"
            style={{ padding: '48px 0' }}
          />
        </Card>
      </div>
    )
  }

  const diffData = stats.byDifficulty
    .slice()
    .sort((a, b) => {
      // "未知" 排到最后
      if (a.bucket === '未知' && b.bucket !== '未知') return 1
      if (a.bucket !== '未知' && b.bucket === '未知') return -1
      return 0
    })
    .map((d: DifficultyStat) => ({
      bucket: d.bucket,
      AC: d.ac,
      未通过: d.attempts - d.ac,
    }))

  const weakData = weak
    ? weak.items.slice(0, 10).map((i) => ({ tag: i.tag, gap: i.gap, acRate: i.acRate, attempts: i.attempts }))
    : []

  const trendData = (trend ?? []).map((t) => ({
    week: t.week,
    attempts: t.attempts,
    AC: t.ac,
    acRate: t.attempts ? Math.round((t.ac / t.attempts) * 1000) / 10 : 0,
  }))

  const moduleNodes: Record<ModuleId, ReactNode> = {
    heatmap: (
      <ActivityHeatmap
        refreshKey={syncTick}
        draggable={{ onMouseDown: (e) => handleModuleMouseDown(e, 'heatmap') }}
      />
    ),
    platforms: (
      <ModuleCard
        title="平台分布"
        extra={<span style={{ fontSize: 12, color: 'var(--text-3)' }}>拖动卡片可排序</span>}
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'platforms')}
      >
        <div className="platform-card-grid" style={{ userSelect: dragPlatform !== null ? 'none' : undefined }}>
          {orderedPlatforms.map((p) => (
            <div
              key={p.platform}
              className={`platform-stat-card${dragPlatform === p.platform ? ' is-dragging' : ''}`}
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
            </div>
          ))}
        </div>
      </ModuleCard>
    ),
    difficulty: (
      <ModuleCard
        title="难度分布（提交数，按 AC / 未通过 堆叠）"
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'difficulty')}
      >
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={diffData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="bucket" tick={AXIS_TICK} interval={0} axisLine={false} tickLine={false} />
            <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} />
            <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: 'rgba(134, 168, 255, 0.05)' }} />
            <Legend {...LEGEND_STYLE} />
            <Bar dataKey="AC" stackId="a" fill={CHART_COLORS.ac} radius={[0, 0, 0, 0]} maxBarSize={34} />
            <Bar dataKey="未通过" stackId="a" fill={CHART_COLORS.failed} radius={[5, 5, 0, 0]} maxBarSize={34} />
          </BarChart>
        </ResponsiveContainer>
      </ModuleCard>
    ),
    weakness: (
      <ModuleCard
        title="弱项标签（相对自身平均的 AC 率偏差，越大越弱）"
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'weakness')}
      >
        {weakData.length > 0 ? (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={weakData} layout="vertical" margin={{ top: 8, right: 24, left: 40, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={GRID_STROKE} />
              <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <YAxis
                type="category"
                dataKey="tag"
                width={110}
                tick={{ fontSize: 12, fill: '#6f6f85' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(tag: string, index: number) => {
                  const d = weakData[index];
                  return d && d.attempts < 20 ? `${tag} ⚠️` : tag;
                }}
              />
              <Tooltip
                {...TOOLTIP_STYLE}
                formatter={(v, name) =>
                  name === 'gap'
                    ? [`${Number(v) > 0 ? '+' : ''}${Number(v)}`, 'AC 率偏差']
                    : [String(v), String(name)]
                }
                labelFormatter={(label: React.ReactNode) => {
                  const d = weakData.find((x) => x.tag === label)
                  return d ? `${String(label)}（样本 ${d.attempts}）` : label
                }}
                cursor={{ fill: 'rgba(134, 168, 255, 0.05)' }}
              />
              <Bar dataKey="gap" radius={[0, 5, 5, 0]} maxBarSize={16}>
                {weakData.map((d) => (
                  <Cell key={d.tag} fill={gapColorHex(d.gap)} />
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
        onHeadMouseDown={(e) => handleModuleMouseDown(e, 'trend')}
      >
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={trendData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="rateArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
            <XAxis
              dataKey="week"
              tick={AXIS_TICK}
              tickFormatter={(w: string) => w.slice(5)}
              interval={0}
              axisLine={false}
              tickLine={false}
            />
            <YAxis yAxisId="left" allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} />
            <YAxis yAxisId="right" orientation="right" domain={[0, 100]} unit="%" tick={AXIS_TICK} axisLine={false} tickLine={false} />
            <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: 'rgba(134, 168, 255, 0.05)' }} />
            <Legend {...LEGEND_STYLE} />
            <Bar yAxisId="left" dataKey="attempts" name="提交" fill={CHART_COLORS.attempts} radius={[5, 5, 0, 0]} maxBarSize={16} />
            <Bar yAxisId="left" dataKey="AC" name="AC" fill={CHART_COLORS.ac} radius={[5, 5, 0, 0]} maxBarSize={16} />
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="acRate"
              name="AC 率 %"
              stroke={CHART_COLORS.rate}
              strokeWidth={2}
              fill="url(#rateArea)"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ModuleCard>
    ),
    history: (
      <ModuleCard title="写题历史" onHeadMouseDown={(e) => handleModuleMouseDown(e, 'history')}>
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
        extra={syncButton}
      />

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

      {/* 模块卡片：按住标题栏拖拽可排序，顺序持久化到 localStorage */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {orderedModules.map((id) => (
          <Col
            key={id}
            xs={24}
            xl={MODULE_SPANS[id]}
            className={`dash-module${dragModule === id ? ' is-dragging' : ''}`}
            onMouseEnter={() => handleModuleMouseEnter(id)}
          >
            {moduleNodes[id]}
          </Col>
        ))}
      </Row>
    </div>
  )
}
