import { useEffect, useState } from 'react'
import {
  Card,
  Col,
  Empty,
  Row,
  Spin,
  Statistic,
  Table,
  Tag,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { get } from '../api'
import type { DifficultyStat, OverallStats, PlatformStat, TrendPoint, WeaknessProfile } from '../types'

function weakColor(gap: number): string {
  if (gap > 15) return 'red'
  if (gap > 5) return 'orange'
  if (gap > 0) return 'gold'
  return 'green'
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
  const diffCols: ColumnsType<DifficultyStat> = [
    { title: '难度区间', dataIndex: 'bucket' },
    { title: '提交', dataIndex: 'attempts' },
    { title: 'AC', dataIndex: 'ac' },
    { title: 'AC 率', dataIndex: 'acRate', render: (v: number) => `${v}%` },
  ]
  const trendCols: ColumnsType<TrendPoint> = [
    { title: '周', dataIndex: 'week' },
    { title: '提交', dataIndex: 'attempts' },
    { title: 'AC', dataIndex: 'ac' },
    { title: 'AC 率', dataIndex: 'ac', render: (_v, r) => `${r.attempts ? Math.round((r.ac / r.attempts) * 1000) / 10 : 0}%` },
    { title: 'AC 均难度', dataIndex: 'avgDifficulty', render: (v: number | null) => v ?? '-' },
  ]

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
        <Col span={12}>
          <Card title="平台分布" size="small">
            <Table size="small" rowKey="platform" columns={platformCols} dataSource={stats.byPlatform} pagination={false} />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="难度分布" size="small">
            <Table size="small" rowKey="bucket" columns={diffCols} dataSource={stats.byDifficulty} pagination={false} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card title="弱项标签（相对自身平均的 AC 率偏差）" size="small">
            {weak && weak.items.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {weak.items.map((i) => (
                  <Tag key={i.tag} color={weakColor(i.gap)}>
                    {i.tag} · {i.acRate}% (gap {i.gap > 0 ? '+' : ''}{i.gap})
                  </Tag>
                ))}
              </div>
            ) : (
              <Empty description="暂无足够样本（各标签至少 5 次提交）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>
        </Col>
        <Col span={12}>
          <Card title="近 12 周趋势" size="small">
            <Table size="small" rowKey="week" columns={trendCols} dataSource={trend ?? []} pagination={false} />
          </Card>
        </Col>
      </Row>
    </div>
  )
}
