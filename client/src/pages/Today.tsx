import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button, Card, Col, Empty, Progress, Row, Space, Tag, Tooltip, App as AntdApp } from 'antd'
import {
  BulbOutlined,
  CheckCircleOutlined,
  FireOutlined,
  RedoOutlined,
  ReadOutlined,
  SendOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import { difficultyColor, tagColor } from '../ui'
import { del, get, post } from '../api'
import type { StreakInfo, TodayPlan, TodayBandKey, TodayProblem } from '../types'
import type { AbilityLevelDetail, PlatformId } from '../../../shared/src/index.ts'

/** 每档题量（与后端默认一致；「换一批」在同一档内轮换） */
const BAND_TONE: Record<TodayBandKey, string> = {
  consolidation: 'var(--blue)',
  core: 'var(--brand)',
  challenge: 'var(--amber)',
}

/** 换一批的进度按**本地日**存：刷新页面不该退回第一批，换日自动归零。
 *  不能用 toISOString()（UTC 日）——UTC+8 用户本地 0–8 点会拿到「昨天」，换日不归零，
 *  与服务端 recommended_on 的本地日口径错位（ Reminder.tsx 同款结论） */
const ROTATE_KEY = 'today.rotate.v1'

const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readStoredRotate(): number {
  try {
    const raw = localStorage.getItem(ROTATE_KEY)
    if (!raw) return 0
    const s = JSON.parse(raw) as { date?: unknown; rotate?: unknown }
    return s.date === localToday() && Number.isInteger(s.rotate) && (s.rotate as number) > 0
      ? Math.min(500, s.rotate as number) // 与服务端 rotate 上限一致，防止 localStorage 无界增长
      : 0
  } catch {
    return 0
  }
}

function writeStoredRotate(rotate: number): void {
  try {
    localStorage.setItem(ROTATE_KEY, JSON.stringify({ date: localToday(), rotate }))
  } catch {
    /* 隐私模式下写不了 localStorage，换一批照样能用 */
  }
}

/** 能力值构成 tooltip：解题口径 → 赛事 rating 混合 → 目标值，逐项拆开让用户核对 */
function levelDetailTip(detail?: AbilityLevelDetail): string | undefined {
  if (!detail || detail.base == null) return undefined
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`
  const parts = [`难度基数 ${detail.base}`, `通过率校准 ${signed(detail.performanceAdj)} → 解题口径 ${detail.solveTarget}`]
  if (detail.ratingAnchor !== null) {
    const conv =
      detail.ratingAnchorRaw !== null && detail.ratingAnchorRaw !== detail.ratingAnchor
        ? ` 原分 ${detail.ratingAnchorRaw} 换算`
        : ''
    parts.push(
      `rating 锚点 ${detail.ratingAnchor}（${detail.ratingAnchorPlatform ?? '赛事中心'}${conv}，${detail.ratingSamples} 场，权重 ${Math.round(detail.ratingWeight * 100)}%，多平台换算后取最高）`,
    )
  }
  if (detail.ratingTrendAdj !== 0) {
    parts.push(`其余平台分差趋势 ${signed(detail.ratingTrendAdj)}`)
  }
  parts.push(`目标 ${detail.target}`, `新证据 ${detail.newEvidence} 条（提交 + 参赛场次）`)
  return parts.join(' · ')
}

export default function Today() {
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()
  const [plan, setPlan] = useState<TodayPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rotate, setRotate] = useState<number>(readStoredRotate)
  const [streak, setStreak] = useState<StreakInfo | null>(null)
  /** 正在同步的平台集合（按 platform 维度去重，同一平台同时只同步一次） */
  const [syncingPlatforms, setSyncingPlatforms] = useState<Set<string>>(new Set())
  /** 已绑定的平台账号 handle 映射（同步时需要） */
  const [accountHandles, setAccountHandles] = useState<Record<string, string>>({})

  // 只认最新一次请求：连点「换一批」会有多个 rotate 请求在途，旧响应晚到会把新一批盖掉
  const reqSeq = useRef(0)

  const load = useCallback(
    (rot: number, silent = false) => {
      const seq = (reqSeq.current += 1)
      if (!silent) {
        setLoading(true)
        setLoadError(null)
      }
      get<TodayPlan>(`/api/today?rotate=${rot}`)
        .then((res) => {
          if (seq === reqSeq.current) {
            setPlan(res)
            setLoadError(null)
          }
        })
        .catch((e: Error) => {
          if (seq === reqSeq.current) {
            setLoadError(e.message)
            setPlan(null)
          }
        })
        .finally(() => {
          // 只看「是否最新一次请求」，不看 silent：静默重拉晚于一次普通刷新返回时，
          // 数据已经落地，loading 也必须收掉，否则顶部刷新圈会一直转
          if (seq === reqSeq.current) setLoading(false)
        })
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
    // 加载已绑定的平台账号（同步按钮需要 handle）
    get<{ accounts: Array<{ platform: string; handle: string }> }>('/api/settings')
      .then((d) => {
        const map: Record<string, string> = {}
        for (const a of d.accounts) map[a.platform] = a.handle
        setAccountHandles(map)
      })
      .catch(() => undefined)
  }, [])

  /** 是否已在复习队列（以服务端 reviewItemId 为准，增删后立即静默重拉） */
  const isQueued = (p: TodayProblem) => p.reviewItemId != null

  const toggleReview = async (p: TodayProblem) => {
    try {
      if (p.reviewItemId != null) {
        await del(`/api/reviews/${p.reviewItemId}`)
        message.success(`「${p.problemKey}」已移出复习队列`)
      } else {
        const res = await post<{ alreadyInQueue: boolean; nextDueOn: string }>('/api/reviews', {
          platform: p.platform,
          problemKey: p.problemKey,
        })
        message.success(
          `「${p.problemKey}」${res.alreadyInQueue ? '已在复习队列' : '已加入复习队列'}，下次到期 ${res.nextDueOn}`,
        )
      }
      // 静默重拉：让 reviewItemId 回到真实值，再点一次才是「移出」而不是「重复加入」
      load(rotate, true)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 同步单个平台的提交记录（做完题后立即拉取最新 AC 状态） */
  const syncPlatform = async (platform: PlatformId) => {
    const handle = accountHandles[platform]
    if (!handle) {
      message.warning(`未绑定 ${platform} 账号，请到「设置 → 平台账号」绑定后再同步`)
      return
    }
    setSyncingPlatforms((s) => new Set(s).add(platform))
    try {
      const r = await post<{ imported: number; skipped: number; errors: string[] }>(
        `/api/sync/${platform}`,
        { handle },
      )
      if (r.errors.length > 0) {
        message.warning(`${platform}：${r.errors[0]}`, 6)
      }
      if (r.imported > 0) {
        message.success(`${platform} 同步完成：新增 ${r.imported} 条提交`)
        // 同步到新数据后刷新今日推荐（推荐基于最新 AC 记录）
        load(rotate)
      } else {
        message.info(`${platform} 同步完成：暂无新提交`)
      }
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSyncingPlatforms((s) => {
        const next = new Set(s)
        next.delete(platform)
        return next
      })
    }
  }

  const refreshBand = () => {
    setRotate((r) => {
      const next = r + 1
      writeStoredRotate(next)
      return next
    })
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
        <PageSkeleton stats blocks={3} />
      ) : loadError ? (
        <InlineError
          message={loadError}
          hint="今日推荐加载失败；重试即可。"
          onRetry={() => load(rotate)}
          retrying={loading}
        />
      ) : !plan ? (
        <Card>
          <EmptyState
            title="暂无今日推荐"
            description="推荐依赖已同步的刷题记录。先到「设置」绑定平台账号并同步数据，或到「题目管理」手动导入题目。"
            action={{ label: '去题目管理', type: 'primary', onClick: () => navigate('/problems') }}
          />
        </Card>
      ) : plan.bands.length === 0 ? (
        <Card>
          <EmptyState
            title="暂无今日推荐"
            description="当前题库样本不足，无法生成三档推荐。同步更多平台提交或导入题目后再试。"
            action={{ label: '换一批试试', type: 'primary', onClick: refreshBand }}
          />
        </Card>
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
                <ReadOutlined style={{ color: 'var(--brand)' }} />
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
                      <span className="band-range mono" style={{ color: BAND_TONE[band.key] }}>
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
                            {/* key 必须带来源前缀：这两组 Tag 是同一个 <Space> 的兄弟子节点，
                                React 按同一个 key 命名空间对齐它们。两边都用裸标签名时，
                                同一标签既是「弱项」又是普通标签就会撞 key（控制台报
                                duplicate key，且重复/丢项的渲染行为不受支持）。 */}
                            {p.weakTags.map((t) => (
                              <Tooltip title={`弱项标签：相对你的平均 AC 率偏低`} key={`weak:${t}`}>
                                <Tag className="weak-tag" color={tagColor(t)}>
                                  弱 · {t}
                                </Tag>
                              </Tooltip>
                            ))}
                            {p.tags.slice(0, 2).map((t) => (
                              <Tag key={`tag:${t}`}>{t}</Tag>
                            ))}
                          </Space>
                          <Space size={4}>
                            <Tooltip title={isQueued(p) ? '已在复习队列，点击移出' : '加入复习队列（间隔复习）'}>
                              <Button
                                size="small"
                                type="text"
                                className={isQueued(p) ? 'review-added-btn' : undefined}
                                icon={isQueued(p) ? <CheckCircleOutlined /> : <ReadOutlined />}
                                onClick={() => void toggleReview(p)}
                              >
                                {isQueued(p) ? '已加入' : '复习'}
                              </Button>
                            </Tooltip>
                            <Tooltip title={`同步 ${p.platform} 的提交记录（做完题后点此拉取最新 AC 状态）`}>
                              <Button
                                size="small"
                                type="text"
                                icon={<SyncOutlined spin={syncingPlatforms.has(p.platform)} />}
                                disabled={syncingPlatforms.has(p.platform)}
                                onClick={() => syncPlatform(p.platform as PlatformId)}
                              >
                                同步
                              </Button>
                            </Tooltip>
                          </Space>
                        </div>
                      </Card>
                    ))
                  )}
                  {band.relaxed && (
                    <p className="band-desc" style={{ color: 'var(--amber)' }}>
                      {band.relaxed}
                    </p>
                  )}
                </Card>
              </Col>
            ))}
          </Row>

          <Card size="small" style={{ marginTop: 16 }}>
            <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
              <span
                style={{ color: 'var(--text-3)', fontSize: 12 }}
                title={levelDetailTip(plan.levelDetail)}
              >
                <SendOutlined />{' '}
                {`能力值由解题难度与独立完成度加权估算，并按赛事中心同步到的 rating 记录纠偏；近 ${plan.cooldownDays} 天推荐过的题不再重复出现，做完题后同步数据，推荐会随之进化。`}
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
