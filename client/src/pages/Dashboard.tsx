import { useEffect, useState } from 'react'
import {
  Card,
  Col,
  Empty,
  Row,
  Spin,
  Table,
} from 'antd'
import { CheckCircleOutlined, SendOutlined, TrophyOutlined } from '@ant-design/icons'
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
import type { ColumnsType } from 'antd/es/table'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { rateColor } from '../ui'
import { get } from '../api'
import type { DifficultyStat, OverallStats, PlatformStat, TrendPoint, WeaknessProfile } from '../types'
import type { PlatformId } from '../../../shared/src/index.ts'

const CHART_COLORS = {
  ac: '#10b981',
  failed: '#d4d4dc',
  attempts: '#3b82f6',
  rate: '#f59e0b',
}

const AXIS_TICK = { fontSize: 11.5, fill: '#9a9ab0' }
const GRID_STROKE = 'rgba(23, 23, 43, 0.06)'
const LEGEND_STYLE = { fontSize: 12, iconType: 'circle', iconSize: 8 } as const

const TOOLTIP_STYLE = {
  contentStyle: {
    borderRadius: 10,
    border: '1px solid rgba(23, 23, 43, 0.08)',
    boxShadow: '0 8px 24px rgba(15, 15, 35, 0.1)',
    fontSize: 12,
  },
  labelStyle: { fontWeight: 600, color: '#17172b' },
} as const

function gapColorHex(gap: number): string {
  if (gap > 15) return '#ef4444'
  if (gap > 5) return '#f59e0b'
  if (gap > 0) return '#eab308'
  return '#10b981'
}

export default function Dashboard() {
  const [stats, setStats] = useState<OverallStats | null>(null)
  const [weak, setWeak] = useState<WeaknessProfile | null>(null)
  const [trend, setTrend] = useState<TrendPoint[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
  if (!stats || stats.attempts === 0) {
    return (
      <div>
        <PageHeader title="数据概览" description="追踪你的训练进度和薄弱环节" />
        <Card>
          <Empty
            description="暂无刷题数据 —— 请到「设置」绑定平台账号并同步，或到「题目管理」手动导入"
            style={{ padding: '48px 0' }}
          />
        </Card>
      </div>
    )
  }

  const platformCols: ColumnsType<PlatformStat> = [
    {
      title: '平台',
      dataIndex: 'platform',
      render: (v: PlatformId) => <PlatformTag id={v} />,
    },
    { title: '提交', dataIndex: 'attempts', align: 'right' },
    { title: 'AC', dataIndex: 'ac', align: 'right' },
    {
      title: 'AC 率',
      dataIndex: 'acRate',
      align: 'right',
      render: (v: number) => (
        <span className="mono" style={{ color: rateColor(v), fontWeight: 600 }}>
          {v}%
        </span>
      ),
    },
    { title: '已解', dataIndex: 'solved', align: 'right' },
  ]

  const diffData = stats.byDifficulty.map((d: DifficultyStat) => ({
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
      <PageHeader title="数据概览" description="追踪你的训练进度和薄弱环节" />

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={8}>
          <Card className="stat-card stat-card-blue" styles={{ body: { position: 'relative' } }}>
            <SendOutlined className="stat-card-icon" />
            <div className="stat-card-title">总提交</div>
            <div className="stat-card-value">{stats.attempts}</div>
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card className="stat-card stat-card-green" styles={{ body: { position: 'relative' } }}>
            <CheckCircleOutlined className="stat-card-icon" />
            <div className="stat-card-title">AC 率</div>
            <div className="stat-card-value">
              {stats.acRate.toFixed(1)}
              <span className="stat-card-suffix">%</span>
            </div>
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card className="stat-card stat-card-purple" styles={{ body: { position: 'relative' } }}>
            <TrophyOutlined className="stat-card-icon" />
            <div className="stat-card-title">已解题目</div>
            <div className="stat-card-value">{stats.solvedProblems}</div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} xl={10}>
          <Card title="平台分布" size="small">
            <Table size="small" rowKey="platform" columns={platformCols} dataSource={stats.byPlatform} pagination={false} />
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title="难度分布（提交数，按 AC / 未通过 堆叠）" size="small">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={diffData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
                <XAxis dataKey="bucket" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: 'rgba(134, 59, 255, 0.04)' }} />
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
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v, name) => (name === 'gap' ? [`${Number(v) > 0 ? '+' : ''}${Number(v)}`, 'AC 率偏差'] : [String(v), String(name)])} cursor={{ fill: 'rgba(134, 59, 255, 0.04)' }} />
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
                <XAxis dataKey="week" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis yAxisId="left" allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis yAxisId="right" orientation="right" domain={[0, 100]} unit="%" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: 'rgba(134, 59, 255, 0.04)' }} />
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
