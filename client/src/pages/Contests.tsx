import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Empty, message, Row, Select, Space, Spin, Tag } from 'antd'
import { ClockCircleOutlined, RedoOutlined } from '@ant-design/icons'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { get } from '../api'
import type { ContestInfo } from '../types'
import type { PlatformId } from '../../../shared/src/index.ts'

/** 分类展示色（未命中走 default） */
const CATEGORY_COLOR: Record<string, string> = {
  'Div. 1': 'volcano',
  'Div. 2': 'geekblue',
  'Div. 3': 'cyan',
  'Div. 4': 'green',
  Educational: 'purple',
  Global: 'gold',
  ICPC: 'magenta',
  ABC: 'blue',
  ARC: 'orange',
  AGC: 'red',
  AHC: 'lime',
  月赛: 'magenta',
  入门赛: 'green',
  重现赛: 'default',
  训练: 'processing',
  周赛: 'gold',
  小白月赛: 'cyan',
  挑战赛: 'volcano',
  练习赛: 'blue',
  校赛: 'geekblue',
}

type ContestType = 'upcoming' | 'finished'

function fmtStart(iso: string | null): string {
  if (!iso) return '时间待定'
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function countdown(iso: string | null): string {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return '已开始'
  const d = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (d > 0) return `${d} 天 ${h} 小时后`
  if (h > 0) return `${h} 小时 ${m} 分后`
  return `${m} 分钟后`
}

function fmtDuration(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分钟`
}

interface ContestsResponse {
  contests: ContestInfo[]
  failures: Partial<Record<PlatformId, string>>
}

export default function Contests() {
  const [data, setData] = useState<ContestsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ContestType>('upcoming')
  const [platform, setPlatform] = useState<PlatformId | undefined>()

  const load = useCallback(
    (t: ContestType, p: PlatformId | undefined) => {
      setLoading(true)
      const params = new URLSearchParams({ type: t, limit: '60' })
      if (p) params.set('platform', p)
      get<ContestsResponse>(`/api/contests?${params.toString()}`)
        .then(setData)
        .catch((e: Error) => message.error(e.message))
        .finally(() => setLoading(false))
    },
    [],
  )

  useEffect(() => {
    load(tab, platform)
  }, [tab, platform, load])

  const items = data?.contests ?? []
  const failures = data?.failures ?? {}

  return (
    <div>
      <PageHeader
        title="赛事中心"
        description="Codeforces / AtCoder / 洛谷 / 牛客 场次一览 —— 赛前选场，赛后补题（公开数据，各源缓存 30 分钟）"
        extra={
          <Space>
            <Button type={tab === 'upcoming' ? 'primary' : 'default'} onClick={() => setTab('upcoming')}>
              即将开始
            </Button>
            <Button type={tab === 'finished' ? 'primary' : 'default'} onClick={() => setTab('finished')}>
              最近结束
            </Button>
            <Select
              allowClear
              placeholder="全部平台"
              style={{ width: 140 }}
              value={platform}
              onChange={setPlatform}
              options={PLATFORM_OPTIONS}
            />
            <Button icon={<RedoOutlined />} loading={loading} onClick={() => load(tab, platform)}>
              刷新
            </Button>
          </Space>
        }
      />

      {Object.keys(failures).length > 0 && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message={`部分数据源暂不可用：${Object.keys(failures).join('、')}（其余平台已正常返回）`}
        />
      )}

      {loading && !data ? (
        <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
      ) : items.length === 0 ? (
        <Card>
          <Empty
            description={
              tab === 'upcoming' ? '暂无已排期的比赛' : '暂无近期比赛记录 —— 洛谷仅返回最近两页赛事'
            }
          />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {items.map((c) => (
            <Col xs={24} md={12} xl={8} key={c.id}>
              <Card size="small" className="contest-card">
                <div className="today-problem-head">
                  <PlatformTag id={c.platform} />
                  <Tag color={CATEGORY_COLOR[c.category] ?? 'default'}>{c.category}</Tag>
                </div>
                <a className="today-problem-title" href={c.url} target="_blank" rel="noreferrer">
                  {c.name} ↗
                </a>
                <div className="contest-meta">
                  <span>
                    <ClockCircleOutlined /> {fmtDuration(c.durationMinutes)}
                  </span>
                  <span>{fmtStart(c.startTimeIso)}</span>
                </div>
                {tab === 'upcoming' && c.startTimeIso && (
                  <div className="contest-countdown">{countdown(c.startTimeIso)}</div>
                )}
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  )
}

const PLATFORM_OPTIONS = [
  { value: 'codeforces' as const, label: 'Codeforces' },
  { value: 'atcoder' as const, label: 'AtCoder' },
  { value: 'luogu' as const, label: '洛谷' },
  { value: 'nowcoder' as const, label: '牛客' },
]
