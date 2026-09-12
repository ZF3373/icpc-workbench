import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Button, Card, Col, Empty, Row, Spin, App as AntdApp } from 'antd'
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
import StatStrip from '../components/StatStrip'
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

export default function Dashboard() {
  const { message } = AntdApp.useApp()
  const [stats, setStats] = useState<OverallStats | null>(null)
  const [weak, setWeak] = useState<WeaknessProfile | null>(null)
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [platformOrder, setPlatformOrder] = useState<string[] | null>(getPlatformOrder)
  const [dragPlatform, setDragPlatform] = useState<PlatformId | null>(null)
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

  // 一键同步所有已绑定账号（增量），完成后刷新概览数据
  const doSync = async () => {
    if (syncing) return
    setSyncing(true)
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
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const syncButton = (
    <Button icon={<SyncOutlined spin={syncing} />} loading={syncing} onClick={doSync}>
      同步数据
    </Button>
  )

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
  if (!stats || stats.attempts === 0) {
    return (
      <div>
        <PageHeader title="数据概览" description="追踪你的训练进度和薄弱环节" extra={syncButton} />
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
    ? weak.items.slice(0, 10).map((i) => ({ tag: i.tag, gap: i.gap, acRate: i.acRate }))
    : []

  const trendData = (trend ?? []).map((t) => ({
    week: t.week,
    attempts: t.attempts,
    AC: t.ac,
    acRate: t.attempts ? Math.round((t.ac / t.attempts) * 1000) / 10 : 0,
  }))

  return (
    <div>
      <PageHeader
        title="数据概览"
        description="追踪你的训练进度和薄弱环节"
        extra={syncButton}
      />

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

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={10}>
          <Card
            title="平台分布"
            size="small"
            extra={<span style={{ fontSize: 12, color: 'var(--text-3)' }}>拖动卡片可排序</span>}
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
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title="难度分布（提交数，按 AC / 未通过 堆叠）" size="small">
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
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={12}>
          <Card title="弱项标签（相对自身平均的 AC 率偏差，越大越弱）" size="small">
            {weakData.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={weakData} layout="vertical" margin={{ top: 8, right: 24, left: 40, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={GRID_STROKE} />
                  <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="tag" width={90} tick={{ fontSize: 12, fill: '#6f6f85' }} axisLine={false} tickLine={false} />
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v, name) => (name === 'gap' ? [`${Number(v) > 0 ? '+' : ''}${Number(v)}`, 'AC 率偏差'] : [String(v), String(name)])} cursor={{ fill: 'rgba(134, 168, 255, 0.05)' }} />
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
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card title="近 12 周趋势（提交量与 AC 率）" size="small">
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
          </Card>
        </Col>
      </Row>
    </div>
  )
}
