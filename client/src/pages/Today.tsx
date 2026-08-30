import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, Col, Empty, message, Progress, Row, Space, Spin, Tag, Tooltip } from 'antd'
import {
  BulbOutlined,
  CheckCircleOutlined,
  FireOutlined,
  RedoOutlined,
  ReadOutlined,
  SendOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { difficultyColor, tagColor } from '../ui'
import { get, post } from '../api'
import type { StreakInfo, TodayPlan, TodayBandKey } from '../types'

/** 每档题量（与后端默认一致；「换一批」在同一档内轮换） */
const BAND_TONE: Record<TodayBandKey, string> = {
  consolidation: '#58a3ff',
  core: '#86a8ff',
  challenge: '#ffbd61',
}

export default function Today() {
  const [plan, setPlan] = useState<TodayPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [rotate, setRotate] = useState(0)
  const [streak, setStreak] = useState<StreakInfo | null>(null)
  const [queued, setQueued] = useState<Set<number>>(new Set())

  const load = useCallback(
    (rot: number) => {
      setLoading(true)
      get<TodayPlan>(`/api/today?rotate=${rot}`)
        .then(setPlan)
        .catch((e: Error) => message.error(e.message))
        .finally(() => setLoading(false))
    },
    [],
  )

  useEffect(() => {
    load(rotate)
  }, [rotate, load])

  useEffect(() => {
    get<StreakInfo>('/api/checkins/streak')
      .then(setStreak)
      .catch(() => undefined)
  }, [])

  const addToReview = async (p: { id: number; platform: string; problemKey: string }) => {
    try {
      await post('/api/reviews', { platform: p.platform, problemKey: p.problemKey })
      message.success(`「${p.problemKey}」已加入复习队列`)
      setQueued((s) => new Set(s).add(p.id))
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const refreshBand = () => {
    setRotate((r) => r + 1)
  }

  return (
    <div>
      <PageHeader
        title="今日训练"
        description="按你的能力水平自动分三档推荐 —— 不用纠结今天做什么"
        extra={
          <Button icon={<RedoOutlined />} onClick={refreshBand} loading={loading}>
            全部换一批
          </Button>
        }
      />

      {loading && !plan ? (
        <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
      ) : !plan ? (
        <Empty description="今日推荐加载失败" />
      ) : (
        <>
          {/* 能力概览条 */}
          <div className="stats-strip" style={{ marginBottom: 16 }}>
            <div className="stat-item">
              <span className="stat-strip-icon stat-icon-violet">
                <BulbOutlined />
              </span>
              <div className="stat-text">
                <span className="stat-label">估算能力值</span>
                <strong>{plan.level}</strong>
              </div>
            </div>
            <div className="stat-item">
              <span className="stat-strip-icon stat-icon-amber">
                <ReadOutlined />
              </span>
              <div className="stat-text">
                <span className="stat-label">到期复习</span>
                <strong>{plan.dueReviews}</strong>
              </div>
            </div>
            <div className="stat-item">
              <span className="stat-strip-icon stat-icon-blue">
                <FireOutlined />
              </span>
              <div className="stat-text">
                <span className="stat-label">连续打卡</span>
                <strong>
                  {streak?.current ?? 0}
                  <span className="stat-suffix">天</span>
                </strong>
              </div>
            </div>
            <div className="stat-item">
              <span className="stat-strip-icon stat-icon-green">
                <CheckCircleOutlined />
              </span>
              <div className="stat-text">
                <span className="stat-label">今日计划</span>
                <strong>
                  {plan.planProgress ? (
                    <>
                      {plan.planProgress.checked}/{plan.planProgress.total}
                      <span className="stat-suffix">项</span>
                    </>
                  ) : (
                    '—'
                  )}
                </strong>
              </div>
            </div>
          </div>

          {plan.dueReviews > 0 && (
            <Card size="small" style={{ marginBottom: 16 }}>
              <Space>
                <ReadOutlined style={{ color: '#86a8ff' }} />
                <span>
                  有 <b>{plan.dueReviews}</b> 道题到了复习时间 ——
                  <Link to="/reviews">去复习库处理 →</Link>
                </span>
              </Space>
            </Card>
          )}

          <Row gutter={[16, 16]}>
            {plan.bands.map((band) => (
              <Col xs={24} lg={8} key={band.key}>
                <Card
                  title={
                    <span className="band-title">
                      <span className="band-dot" style={{ background: BAND_TONE[band.key] }} />
                      {band.label}
                      <span className="band-range mono">
                        {band.range[0]}–{band.range[1]}
                      </span>
                    </span>
                  }
                  size="small"
                  style={{ height: '100%' }}
                  styles={{ body: { display: 'flex', flexDirection: 'column', gap: 8 } }}
                >
                  <p className="band-desc">{band.description}</p>
                  {band.problems.length === 0 ? (
                    <Empty
                      description={`该难度段暂无候选题（题库 ${band.pool} 道）——可到「题目管理 → 拉取题库」扩充`}
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                    />
                  ) : (
                    band.problems.map((p) => (
                      <Card key={p.id} size="small" className="today-problem">
                        <div className="today-problem-head">
                          {p.difficulty != null && (
                            <span className="rating-pill mono" style={{ color: difficultyColor(p.difficulty) }}>
                              {p.difficulty}
                            </span>
                          )}
                          <PlatformTag id={p.platform as never} />
                        </div>
                        {p.url ? (
                          <a className="today-problem-title" href={p.url} target="_blank" rel="noreferrer">
                            {p.title} ↗
                          </a>
                        ) : (
                          <span className="today-problem-title">{p.title}</span>
                        )}
                        <div className="today-problem-foot">
                          <Space size={4} wrap>
                            {p.weakTags.map((t) => (
                              <Tooltip title={`弱项标签：相对你的平均 AC 率偏低`} key={t}>
                                <Tag className="weak-tag" color={tagColor(t)}>
                                  弱 · {t}
                                </Tag>
                              </Tooltip>
                            ))}
                            {p.tags.slice(0, 2).map((t) => (
                              <Tag key={t}>{t}</Tag>
                            ))}
                          </Space>
                          <Button
                            size="small"
                            type="text"
                            icon={<ReadOutlined />}
                            disabled={queued.has(p.id)}
                            onClick={() => addToReview(p)}
                          >
                            {queued.has(p.id) ? '已加入' : '复习'}
                          </Button>
                        </div>
                      </Card>
                    ))
                  )}
                </Card>
              </Col>
            ))}
          </Row>

          <Card size="small" style={{ marginTop: 16 }}>
            <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              <span style={{ color: '#8993a2', fontSize: 12 }}>
                <SendOutlined /> 能力值由近 60 天 AC 难度中位数估算；做完题后同步数据，推荐会随之进化。
              </span>
              {plan.planProgress && (
                <Progress
                  className="gradient-progress"
                  style={{ width: 200, margin: 0 }}
                  percent={Math.round((plan.planProgress.checked / plan.planProgress.total) * 100)}
                  size="small"
                />
              )}
            </Space>
          </Card>
        </>
      )}
    </div>
  )
}
