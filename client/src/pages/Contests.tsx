import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Empty, Row, Select, Space, Spin, Tag, App as AntdApp } from 'antd'
import { ClockCircleOutlined, RedoOutlined, RobotOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { get, post } from '../api'
import { platformName } from '../ui'
import type { ContestInfo, ParticipatedContest } from '../types'
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

type ContestType = 'upcoming' | 'running' | 'finished' | 'participated'

/** 参赛判定依据 → 展示标签（与后端 participated.ts 的 evidence 对应） */
const EVIDENCE_TAG: Record<string, { color: string; label: string }> = {
  contest: { color: 'green', label: '现场参赛' },
  virtual: { color: 'blue', label: '虚拟赛' },
  gym: { color: 'geekblue', label: 'gym 训练' },
  'key-pattern': { color: 'cyan', label: '比赛提交' },
  'calendar-window': { color: 'default', label: '时间窗匹配' },
  heuristic: { color: 'default', label: '疑似参赛' },
  'joined-list': { color: 'purple', label: '平台记录' },
}

/** Rating 变化展示：+32 / -6（无变化不显示括号） */
function fmtRatingChange(change: number | null | undefined): string {
  if (!change) return ''
  return `（${change > 0 ? '+' : ''}${change}）`
}

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

/** 进行中的比赛：距结束还有多久（结束的瞬间会显示为「即将结束」） */
function remaining(iso: string, durationMinutes: number): string {
  const diff = new Date(iso).getTime() + durationMinutes * 60_000 - Date.now()
  if (diff <= 0) return '即将结束'
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  return h > 0 ? `剩 ${h} 小时 ${m} 分结束` : `剩 ${m} 分钟结束`
}

function fmtDuration(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分钟`
}

interface ContestsResponse {
  contests: ContestInfo[]
  failures: Partial<Record<PlatformId, string>>
}

interface ParticipatedResponse {
  contests: ParticipatedContest[]
  sourceFailures?: Partial<Record<PlatformId, string>>
  /** 正在后台增量刷新的平台（本次响应仍是库内数据，稍后自动更新） */
  refreshing?: PlatformId[]
}

/** 参赛记录前端缓存：5 分钟内切页签/回页面直接复用，「刷新」按钮强制重新拉取 */
const PARTICIPATED_CACHE_TTL = 5 * 60_000
let participatedCache: { at: number; data: ParticipatedResponse } | null = null

export default function Contests() {
  const { message } = AntdApp.useApp()
  const nav = useNavigate()
  const [data, setData] = useState<ContestsResponse | null>(null)
  const [participated, setParticipated] = useState<ParticipatedContest[] | null>(null)
  const [sourceFailures, setSourceFailures] = useState<Partial<Record<PlatformId, string>>>({})
  const [backgroundRefreshing, setBackgroundRefreshing] = useState<PlatformId[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<ContestType>('upcoming')
  const [platform, setPlatform] = useState<PlatformId | undefined>()

  const load = useCallback(
    (t: ContestType, p: PlatformId | undefined, force = false) => {
      setLoading(true)
      if (t === 'participated') {
        // 我参加的：本地提交推导 + 平台参赛记录（后端落库，读库秒出；过期平台后台增量刷新）。
        // 5 分钟内复用前端缓存；「刷新」按钮走 POST 强制同步拉取
        if (!force && participatedCache && Date.now() - participatedCache.at < PARTICIPATED_CACHE_TTL) {
          setParticipated(participatedCache.data.contests)
          setSourceFailures(participatedCache.data.sourceFailures ?? {})
          setBackgroundRefreshing(participatedCache.data.refreshing ?? [])
          setLoading(false)
          return
        }
        const request = force
          ? post<ParticipatedResponse>('/api/contests/participated/refresh')
          : get<ParticipatedResponse>('/api/contests/participated')
        request
          .then((r) => {
            participatedCache = { at: Date.now(), data: r }
            setParticipated(r.contests)
            setData(null)
            setSourceFailures(r.sourceFailures ?? {})
            setBackgroundRefreshing(r.refreshing ?? [])
          })
          .catch((e: Error) => message.error(e.message))
          .finally(() => setLoading(false))
        return
      }
      setParticipated(null)
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
  const participatedItems = (participated ?? []).filter(
    (c) => !platform || c.platform === platform,
  )

  return (
    <div>
      <PageHeader
        title="赛事中心"
        description="Codeforces / AtCoder / 洛谷 / 牛客 场次一览 —— 赛前选场，赛后复盘（公开数据，各源缓存 30 分钟）"
        extra={
          <Space>
            <Button type={tab === 'upcoming' ? 'primary' : 'default'} onClick={() => setTab('upcoming')}>
              即将开始
            </Button>
            <Button type={tab === 'running' ? 'primary' : 'default'} onClick={() => setTab('running')}>
              进行中
            </Button>
            <Button type={tab === 'finished' ? 'primary' : 'default'} onClick={() => setTab('finished')}>
              最近结束
            </Button>
            <Button type={tab === 'participated' ? 'primary' : 'default'} onClick={() => setTab('participated')}>
              我参加的
            </Button>
            <Select
              allowClear
              placeholder="全部平台"
              style={{ width: 140 }}
              value={platform}
              onChange={setPlatform}
              options={PLATFORM_OPTIONS}
            />
            <Button icon={<RedoOutlined />} loading={loading} onClick={() => load(tab, platform, true)}>
              刷新
            </Button>
          </Space>
        }
      />

      {tab === 'participated' ? (
        backgroundRefreshing.length > 0 && (
          <Alert
            style={{ marginBottom: 16 }}
            type="info"
            showIcon
            message={`正在后台更新参赛记录：${backgroundRefreshing.join('、')}（本次展示已存档数据，稍后刷新可见最新）`}
          />
        )
      ) : null}
      {tab === 'participated' ? (
        Object.keys(sourceFailures).length > 0 && (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            message={`部分平台参赛记录拉取失败：${Object.keys(sourceFailures).join('、')}（其余平台已正常返回）`}
          />
        )
      ) : (
        Object.keys(failures).length > 0 && (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            message={`部分数据源暂不可用：${Object.keys(failures).join('、')}（其余平台已正常返回）`}
          />
        )
      )}

      {/* 参赛页签首次加载显示转圈；重新拉取时保留旧列表，不再闪「暂无参赛记录」 */}
      {loading && tab === 'participated' && !participated ? (
        <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
      ) : loading && tab !== 'participated' && !data ? (
        <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
      ) : tab === 'participated' ? (
        participatedItems.length === 0 ? (
          <Card>
            <Empty description="暂无参赛记录 —— 先到「题目管理」绑定账号并同步各平台提交（牛客仅依赖绑定 uid）" />
          </Card>
        ) : (
          <Row gutter={[16, 16]}>
            {participatedItems.map((c) => {
              const evidence = EVIDENCE_TAG[c.evidence] ?? { color: 'default', label: c.evidence }
              return (
                <Col xs={24} md={12} xl={8} key={c.key}>
                  <Card size="small" className="contest-card">
                    <div className="today-problem-head">
                      <PlatformTag id={c.platform} />
                      <Tag color={evidence.color}>{evidence.label}</Tag>
                    </div>
                    <a
                      className="today-problem-title"
                      href={c.url || undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {c.name ?? `${platformName(c.platform)} · ${c.contestId}`} ↗
                    </a>
                    <div className="contest-meta">
                      <span>
                        <ClockCircleOutlined /> {fmtStart(c.startTimeIso)}
                      </span>
                      <span>
                        {c.submissionCount > 0
                          ? `${c.problemCount} 题 · AC ${c.acProblemCount} · ${c.submissionCount} 次提交`
                          : '未同步逐条提交'}
                      </span>
                    </div>
                    {(c.source?.rank != null || c.source?.rating != null) && (
                      <div className="contest-countdown">
                        {c.source?.rank != null ? `排名 ${c.source.rank}` : ''}
                        {c.source?.rank != null && c.source?.rating != null ? ' · ' : ''}
                        {c.source?.rating != null
                          ? `Rating ${c.source.rating}${fmtRatingChange(c.source.ratingChange)}`
                          : ''}
                      </div>
                    )}
                    <Button
                      size="small"
                      type="link"
                      icon={<RobotOutlined />}
                      style={{ padding: 0, marginTop: 4 }}
                      onClick={() => nav(`/ai?contest=${encodeURIComponent(c.key)}`)}
                    >
                      去 AI 复盘
                    </Button>
                  </Card>
                </Col>
              )
            })}
          </Row>
        )
      ) : items.length === 0 ? (
        <Card>
          <Empty
            description={
              tab === 'upcoming'
                ? '暂无已排期的比赛'
                : tab === 'running'
                  ? '当前没有进行中的比赛'
                  : '暂无近期比赛记录 —— 洛谷仅返回最近两页赛事'
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
                {tab === 'running' && c.startTimeIso && (
                  <div className="contest-countdown">{remaining(c.startTimeIso, c.durationMinutes)}</div>
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
