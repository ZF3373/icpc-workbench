import { useEffect, useState } from 'react'
import {
  Card,
  Col,
  Empty,
  Row,
  Spin,
  Statistic,
  Table,
} from 'antd'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ColumnsType } from 'antd/es/table'
import { get } from '../api'
import type { DifficultyStat, OverallStats, PlatformStat, TrendPoint, WeaknessProfile } from '../types'

const CHART_COLORS = {
  ac: '#52c41a',
  failed: '#bfbfbf',
  attempts: '#1677ff',
  rate: '#fa8c16',
}

function gapColorHex(gap: number): string {
  if (gap > 15) return '#f5222d'
  if (gap > 5) return '#fa8c16'
  if (gap > 0) return '#faad14'
  return '#52c41a'
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
    return <Empty description="暂无刷题数据 —— 请到「设置」绑定平台账号并同步，或到「题目管理」手动导入" />
  }

  const platformCols: ColumnsType<PlatformStat> = [
    { title: '平台', dataIndex: 'platform' },
    { title: '提交', dataIndex: 'attempts' },
    { title: 'AC', dataIndex: 'ac' },
    { title: 'AC 率', dataIndex: 'acRate', render: (v: number) => `${v}%` },
    { title: '已解', dataIndex: 'solved' },
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
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Card>
            <Statistic title="总提交" value={stats.attempts} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="AC 率" value={stats.acRate} suffix="%" precision={1} />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="已解题目" value={stats.solvedProblems} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={10}>
          <Card title="平台分布" size="small">
            <Table size="small" rowKey="platform" columns={platformCols} dataSource={stats.byPlatform} pagination={false} />
          </Card>
        </Col>
        <Col span={14}>
          <Card title="难度分布（提交数，按 AC / 未通过 堆叠）" size="small">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={diffData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Bar dataKey="AC" stackId="a" fill={CHART_COLORS.ac} />
                <Bar dataKey="未通过" stackId="a" fill={CHART_COLORS.failed} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title="弱项标签（相对自身平均的 AC 率偏差，越大越弱）" size="small">
            {weakData.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={weakData} layout="vertical" margin={{ top: 8, right: 24, left: 40, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="tag" width={90} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v, name) => (name === 'gap' ? [`${Number(v) > 0 ? '+' : ''}${Number(v)}`, 'AC 率偏差'] : [String(v), String(name)])} />
                  <Bar dataKey="gap" radius={[0, 4, 4, 0]}>
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
        <Col span={12}>
          <Card title="近 12 周趋势（提交量与 AC 率）" size="small">
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={trendData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" allowDecimals={false} />
                <YAxis yAxisId="right" orientation="right" domain={[0, 100]} unit="%" />
                <Tooltip />
                <Legend />
                <Bar yAxisId="left" dataKey="attempts" name="提交" fill={CHART_COLORS.attempts} radius={[4, 4, 0, 0]} />
                <Bar yAxisId="left" dataKey="AC" name="AC" fill={CHART_COLORS.ac} radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" dataKey="acRate" name="AC 率 %" stroke={CHART_COLORS.rate} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
