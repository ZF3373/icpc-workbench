import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Col, Row, Segmented, Select, Tag, App as AntdApp, Tooltip } from 'antd'
import { ClockCircleOutlined, RedoOutlined, RobotOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState, { type EmptyStateAction } from '../components/EmptyState'
import InlineError from '../components/InlineError'
import { get, post } from '../api'
import { platformName } from '../ui'
import { endedAgo, fmtTimeHm, groupContestsByDay } from './contestsView'
import type { ContestInfo, ParticipatedContest } from '../types'
import type { PlatformId } from '../../../shared/src/index.ts'

/**
 * 分类展示色（未命中走 default）。
 *
 * ⚠ 这些是 antd 的**预设色名**，不是硬编码 hex —— 不要「顺手 Token 化」成 `var(--…)`。
 * 预设色由 ConfigProvider 的 `theme.algorithm`（`themeContext.tsx` 里按亮/暗切
 * `defaultAlgorithm` / `darkAlgorithm`）在运行时解析成带配对前景/边框色的
 * 「底色 + 文字色」组合；换成 CSS 变量会丢掉这层配对，Tag 只剩一块色底。
 * 全站硬编码色的审计结论见 `docs/UI-Optimization-Report.md` §8。
 */
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

/** 参赛判定依据 → 展示标签（与后端 participated.ts 的 evidence 对应；色值同为 antd 预设色名，见上） */
const EVIDENCE_TAG: Record<string, { color: string; label: string }> = {
  contest: { color: 'green', label: '现场参赛' },
  virtual: { color: 'blue', label: '虚拟赛' },
  gym: { color: 'geekblue', label: 'gym 训练' },
  'key-pattern': { color: 'cyan', label: '比赛提交' },
  'calendar-window': { color: 'default', label: '时间窗匹配' },
  heuristic: { color: 'default', label: '疑似参赛' },
  'joined-list': { color: 'purple', label: '平台记录' },
}

function fmtStart(iso: string | null): string {
  if (!iso) return '时间待定'
  // 秒数对「选场」没有信息量，去掉后日期/时间在卡片里短一截
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
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

/** 失败明细「平台中文名：原因」——只列 id 会让用户看不出是 Cookie 失效还是限流 */
function fmtFailures(failures: Partial<Record<PlatformId, string>>): string {
  return Object.entries(failures)
    .filter(([, m]) => m)
    .map(([p, m]) => `${platformName(p as PlatformId)}：${m}`)
    .join('；')
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

/** 后台刷新完成跟进的轮询间隔 */
const BACKGROUND_REFRESH_POLL_MS = 20_000
/** 倒计时重算 / 阶段跨界检测的 tick 间隔 */
const PHASE_TICK_MS = 30_000

export default function Contests() {
  const { message } = AntdApp.useApp()
  const nav = useNavigate()
  const [data, setData] = useState<ContestsResponse | null>(null)
  const [participated, setParticipated] = useState<ParticipatedContest[] | null>(null)
  const [sourceFailures, setSourceFailures] = useState<Partial<Record<PlatformId, string>>>({})
  const [backgroundRefreshing, setBackgroundRefreshing] = useState<PlatformId[]>([])
  const [loading, setLoading] = useState(true)
  /** 取数失败原因：与「这个页签本来就没有场次」严格区分（失败给 InlineError 重试，不冒充空态） */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tab, setTab] = useState<ContestType>('upcoming')
  const [platform, setPlatform] = useState<PlatformId | undefined>()
  /** 请求序号：切页签/平台时旧响应晚到不得覆盖新视图（与其他页面的 reqSeq 同一护栏）。
   *  「即将开始」首拉要聚合各平台源、可能秒级耗时，没有护栏时快速切换必然串台 */
  const reqSeq = useRef(0)

  const load = useCallback(
    (t: ContestType, p: PlatformId | undefined, force = false) => {
      const seq = ++reqSeq.current
      const stale = (): boolean => seq !== reqSeq.current
      setLoading(true)
      // 新一轮取数开始即清掉上一次的失败原因：否则重试成功后错误态会残留
      setLoadError(null)
      if (t === 'participated') {
        // 我参加的：本地提交推导 + 平台参赛记录（后端落库，读库秒出；过期平台后台增量刷新）。
        // 5 分钟内复用前端缓存；「刷新」按钮走 POST 强制同步拉取
        if (!force && participatedCache && Date.now() - participatedCache.at < PARTICIPATED_CACHE_TTL) {
          if (stale()) return
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
            if (stale()) return
            participatedCache = { at: Date.now(), data: r }
            setParticipated(r.contests)
            setData(null)
            setSourceFailures(r.sourceFailures ?? {})
            setBackgroundRefreshing(r.refreshing ?? [])
            setLoadError(null)
          })
          .catch((e: Error) => {
            if (stale()) return
            // 失败 ≠ 空：记下原因交给 InlineError 带重试，而不是让「暂无参赛记录」冒充结论
            setLoadError(e.message)
            message.error(e.message)
          })
          .finally(() => {
            if (stale()) return
            setLoading(false)
          })
        return
      }
      setParticipated(null)
      const params = new URLSearchParams({ type: t, limit: '60' })
      if (p) params.set('platform', p)
      get<ContestsResponse>(`/api/contests?${params.toString()}`)
        .then((r) => {
          if (stale()) return
          setData(r)
          setLoadError(null)
        })
        .catch((e: Error) => {
          if (stale()) return
          // 同上：日历页签取数失败也是失败态，不是「暂无已排期的比赛」
          setLoadError(e.message)
          message.error(e.message)
        })
        .finally(() => {
          if (stale()) return
          setLoading(false)
        })
    },
    [],
  )

  useEffect(() => {
    load(tab, platform)
  }, [tab, platform, load])

  /** 后台刷新跟进：参赛记录正在后台增量刷新时轮询读库，刷新完成（refreshing 清空）
   *  即静默换入新数据——旧实现只提示「稍后刷新可见最新」，用户唯一的动作是点「刷新」，
   *  而那会走 force POST 重拉全部平台、与在跑的后台刷新重复打外网 */
  useEffect(() => {
    if (tab !== 'participated' || backgroundRefreshing.length === 0) return
    const id = window.setInterval(() => {
      // 只在期间没有用户发起的加载时落地（用户点「刷新」/切页签的请求序号更大）
      const seq = reqSeq.current
      void get<ParticipatedResponse>('/api/contests/participated')
        .then((r) => {
          if (seq !== reqSeq.current) return
          participatedCache = { at: Date.now(), data: r }
          setParticipated(r.contests)
          setSourceFailures(r.sourceFailures ?? {})
          setBackgroundRefreshing(r.refreshing ?? [])
        })
        .catch(() => {
          /* 单次轮询失败静默：下一拍再试 */
        })
    }, BACKGROUND_REFRESH_POLL_MS)
    return () => window.clearInterval(id)
  }, [tab, backgroundRefreshing.length])

  /** 倒计时 tick + 阶段跨界重拉：倒计时文本随 tick 重算；开赛/完赛跨过阶段边界时
   *  静默重拉当前页签（服务端在请求时归类），让比赛挪去正确的页签而不是停在原地 */
  const [, setTick] = useState(0)
  const dataRef = useRef(data)
  dataRef.current = data
  useEffect(() => {
    if (tab === 'participated') return
    const id = window.setInterval(() => {
      setTick((t) => t + 1)
      const list = dataRef.current?.contests ?? []
      const now = Date.now()
      const crossed = list.some((c) => {
        if (!c.startTimeIso) return false
        const start = new Date(c.startTimeIso).getTime()
        const end = start + c.durationMinutes * 60_000
        return tab === 'upcoming' ? start <= now : end <= now
      })
      if (crossed) load(tab, platform)
    }, PHASE_TICK_MS)
    return () => window.clearInterval(id)
  }, [tab, platform, load])

  /** 切页签时清掉新页签不支持的筛选（QOJ 只在「我参加的」有记录，日历页签选它恒为空） */
  const switchTab = (t: ContestType) => {
    setTab(t)
    if (t !== 'participated' && platform === 'qoj') setPlatform(undefined)
  }

  const items = data?.contests ?? []
  const failures = data?.failures ?? {}
  const participatedItems = (participated ?? []).filter(
    (c) => !platform || c.platform === platform,
  )
  const platformOptions =
    tab === 'participated'
      ? [...CALENDAR_PLATFORM_OPTIONS, { value: 'qoj' as const, label: 'QOJ' }]
      : CALENDAR_PLATFORM_OPTIONS

  /** 参赛页签空态的出口：有平台筛选先给「清筛选」，否则给「去设置绑定账号」；都兜一个「重新加载」 */
  const participatedEmptyActions: EmptyStateAction[] = [
    platform
      ? { label: '查看全部平台', type: 'primary', onClick: () => setPlatform(undefined) }
      : { label: '去设置绑定账号', type: 'primary', onClick: () => nav('/settings') },
    { label: '重新加载', onClick: () => load(tab, platform) },
  ]

  /** 日历页签空态的出口：筛选优先，其次「进行中 ↔ 即将开始」互跳，最后兜「重新加载」 */
  const calendarEmptyActions: EmptyStateAction[] = platform
    ? [
        { label: '查看全部平台', type: 'primary', onClick: () => setPlatform(undefined) },
        { label: '重新加载', onClick: () => load(tab, platform) },
      ]
    : tab === 'upcoming'
      ? [
          { label: '查看进行中的', type: 'primary', onClick: () => switchTab('running') },
          { label: '重新加载', onClick: () => load(tab, platform) },
        ]
      : tab === 'running'
        ? [
            { label: '看看即将开始的', type: 'primary', onClick: () => switchTab('upcoming') },
            { label: '重新加载', onClick: () => load(tab, platform) },
          ]
        : [{ label: '重新加载', type: 'primary', onClick: () => load(tab, platform) }]

  return (
    <div>
      <PageHeader
        title="赛事中心"
        description="各平台场次一览 —— 赛前选场，赛后复盘。"
        extra={
          <>
            {/* Segmented 而不是四个按钮：页签是「视图切换」不是「动作」，控件语义先分清 */}
            <Segmented
              value={tab}
              onChange={(v) => switchTab(v as ContestType)}
              options={[
                { label: '即将开始', value: 'upcoming' },
                { label: '进行中', value: 'running' },
                { label: '最近结束', value: 'finished' },
                { label: '我参加的', value: 'participated' },
              ]}
            />
            <Select
              allowClear
              placeholder="全部平台"
              style={{ width: 140 }}
              value={platform}
              onChange={setPlatform}
              options={platformOptions}
            />
            {/* 缓存节奏是实现细节，从页头描述挪到这里：想知道的人自然会悬停「刷新」 */}
            <Tooltip title="公开数据各源缓存 60 分钟、参赛记录 30 分钟增量刷新；点击立即强制重拉。">
              <Button icon={<RedoOutlined />} loading={loading} onClick={() => load(tab, platform, true)}>
                刷新
              </Button>
            </Tooltip>
          </>
        }
      />

      {tab === 'participated' ? (
        backgroundRefreshing.length > 0 && (
          <Alert
            style={{ marginBottom: 16 }}
            type="info"
            showIcon
            message={`正在后台更新参赛记录：${backgroundRefreshing.map(platformName).join('、')}（更新完成后自动刷新，无需手动操作）`}
          />
        )
      ) : null}
      {tab === 'participated' ? (
        Object.keys(sourceFailures).length > 0 && (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            message={`部分平台参赛记录拉取失败：${fmtFailures(sourceFailures)}（其余平台已正常返回）`}
          />
        )
      ) : (
        Object.keys(failures).length > 0 && (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            message={`部分数据源暂不可用：${fmtFailures(failures)}（其余平台已正常返回）`}
          />
        )
      )}

      {/* 首屏骨架：这两个分支都只是「本页签第一次取数还没落地」，不存在「未绑定账号」这类前置门
          —— 页面不读账号绑定状态，未绑定时照样请求、只是返回空列表（那是下面的空态）。
          真实首屏是页头 + 一屏比赛卡片，故用 stats={false} 的卡片网格占位：xl 三列与
          .page-skeleton-grid 的 auto-fit(minmax(320px)) 一致，数据落地只有内容变化、无布局跳动。
          重新拉取时保留旧列表（participated / data 还在），不会退回骨架 */}
      {loading && (tab === 'participated' ? !participated : !data) ? (
        <PageSkeleton stats={false} blocks={3} blockHeight={230} />
      ) : loadError && (tab === 'participated' ? !participated : !data) ? (
        // 失败 ≠ 空：取数失败给可重试的错误态，而不是让「暂无参赛记录」冒充结论
        <Card>
          <InlineError
            message={loadError}
            hint={
              tab === 'participated'
                ? '这块本来显示的是你在各平台的参赛记录与 AI 复盘入口。'
                : '这块本来显示的是各平台的比赛日历；平台源偶发限流也会返回失败，重试即可。'
            }
            onRetry={() => load(tab, platform)}
            retrying={loading}
          />
        </Card>
      ) : tab === 'participated' ? (
        participatedItems.length === 0 ? (
          <Card>
            <EmptyState
              title={platform ? `没有 ${platformName(platform)} 的参赛记录` : '暂无参赛记录'}
              description={
                platform
                  ? '当前按平台筛选，该平台下没有命中的场次；清掉筛选可以看到其他平台的参赛记录（也可能确实还没有记录）。'
                  : '参赛记录由已绑定账号的提交记录与平台参赛页推导。到「设置 → 平台账号与适配器」绑定账号并同步提交后，这里会列出参赛场次（牛客仅依赖绑定 uid）。'
              }
              actions={participatedEmptyActions}
            />
          </Card>
        ) : (
          /* 卡片列：lg(≥992) 两列、xl(≥1200) 三列。antd 的 md 是 min-width:768px，
             用 md={12} 会在 768px 正好落成两列，而验收要求「≤768px 单列」，
             所以两列的起点改用 lg —— 768/640 下均为 xs={24} 单列 */
          <Row gutter={[16, 16]}>
            {participatedItems.map((c) => {
              const evidence = EVIDENCE_TAG[c.evidence] ?? { color: 'default', label: c.evidence }
              // 总题数只在平台参赛记录给出权威值时展示分母（牛客/洛谷）；CF/AtCoder 的
              // problemCount 兜底是「本地交过的题数」，当分母会把「剩 N 题」算错
              const totalProblems =
                c.source?.problemCount != null && c.source.problemCount > 0
                  ? c.source.problemCount
                  : null
              const upsolveDone = totalProblems != null && c.acProblemCount >= totalProblems
              return (
                <Col xs={24} lg={12} xl={8} key={c.key}>
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
                      {c.submissionCount > 0 ? (
                        <span>{c.submissionCount} 次提交</span>
                      ) : c.problemCount > 0 ? (
                        // 零提交但平台记录给了总题数：如实显示「报名未交题」，
                        // 区别于数据未同步（无逐条提交记录）
                        <span>报名未交题 · 共 {c.problemCount} 题</span>
                      ) : (
                        <span>无逐条提交记录</span>
                      )}
                    </div>
                    {(c.submissionCount > 0 || c.source?.rank != null || c.source?.rating != null) && (
                      /* 一行横向迷你统计替代「纵向大数字 + 排名/Rating 药丸」：补题进度仍是核心
                         （当前 AC 带分母与剩题/已补完），排名/Rating 并进同一行后少一层胶囊，
                         多场次的成果可以左右扫着比。没有的项不渲染，间距由 flex 承担 */
                      <div className="contest-statgrid">
                        {c.submissionCount > 0 && (
                          <div className="contest-stat">
                            <span className="contest-stat-label">当前 AC</span>
                            <span
                              className={`contest-stat-value${upsolveDone ? ' contest-stat-done' : ''}`}
                            >
                              {c.acProblemCount}
                              {totalProblems != null && (
                                <span className="contest-stat-denom">/{totalProblems}</span>
                              )}
                            </span>
                            {totalProblems != null &&
                              (upsolveDone ? (
                                <span className="contest-stat-sub contest-stat-sub-done">已补完</span>
                              ) : (
                                <span className="contest-stat-sub">
                                  剩 {totalProblems - c.acProblemCount} 题
                                </span>
                              ))}
                          </div>
                        )}
                        {c.submissionCount > 0 && c.inContestAcProblemCount != null && (
                          <div className="contest-stat">
                            <span className="contest-stat-label">赛中 AC</span>
                            <span className="contest-stat-value contest-stat-value-dim">
                              {c.inContestAcProblemCount}
                            </span>
                          </div>
                        )}
                        {c.source?.rank != null && (
                          <div className="contest-stat">
                            <span className="contest-stat-label">排名</span>
                            <span className="contest-stat-value contest-stat-value-dim">
                              {c.source.rank}
                            </span>
                          </div>
                        )}
                        {c.source?.rating != null && (
                          <div className="contest-stat">
                            <span className="contest-stat-label">Rating</span>
                            <span className="contest-stat-value contest-stat-value-dim">
                              {c.source.rating}
                              {c.source.ratingChange ? (
                                <span
                                  className={`contest-stat-delta ${
                                    c.source.ratingChange > 0
                                      ? 'contest-stat-delta-up'
                                      : 'contest-stat-delta-down'
                                  }`}
                                >
                                  {c.source.ratingChange > 0 ? '+' : ''}
                                  {c.source.ratingChange}
                                </span>
                              ) : null}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                    {c.accounts && c.accounts.length > 1 && (
                      /* 多账号说明是脚注不是状态：灰色小字即可，不占用品牌色药丸 */
                      <div className="contest-footnote">
                        多账号参赛：{c.accounts.join('、')}（成绩属于提交较多的账号，复盘明细按账号标注）
                      </div>
                    )}
                    <Button
                      size="small"
                      type="link"
                      icon={<RobotOutlined />}
                      style={{ padding: 0 }}
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
          <EmptyState
            title={
              tab === 'upcoming'
                ? '暂无已排期的比赛'
                : tab === 'running'
                  ? '当前没有进行中的比赛'
                  : '暂无近期比赛记录'
            }
            description={
              platform
                ? `当前按「${platformName(platform)}」筛选，该平台没有命中本页签的场次；清掉筛选可以看到全部平台。`
                : tab === 'upcoming'
                  ? '各平台日历源都没有返回未来的场次（洛谷仅返回最近两页赛事）；换个页签或稍后重试。'
                  : tab === 'running'
                    ? '现在没有正在进行的比赛 —— 可以去「即将开始」挑一场排期。'
                    : '各平台日历源都没有返回近期已结束的场次（洛谷仅返回最近两页赛事）；稍后重试可能拿到更新的赛程。'
            }
            actions={calendarEmptyActions}
          />
        </Card>
      ) : tab === 'running' ? (
        // 进行中通常只有个位数场次，按天分组收益为负；平铺并保留完整时刻
        // （比赛可能昨天就开跑了，「昨天 20:00」必须带日期才读得懂）
        <Row gutter={[16, 16]}>
          {items.map((c) => (
            <Col xs={24} lg={12} xl={8} key={c.id}>
              <ContestCalendarCard contest={c} mode="running" />
            </Col>
          ))}
        </Row>
      ) : (
        // 即将开始 / 最近结束按天分组：几十场平铺成一堵卡片墙时，「哪天有什么」
        // 要逐卡读时刻才能拼出来；日期上提到组头后，卡内只留 时:分 + 倒计时药丸
        groupContestsByDay(items).map((g) => (
          <section className="contest-day-section" key={g.key}>
            <div className="contest-day-head">
              <span className="contest-day-title">{g.label}</span>
              <span className="contest-day-count">{g.items.length} 场</span>
            </div>
            <Row gutter={[16, 16]}>
              {g.items.map((c) => (
                <Col xs={24} lg={12} xl={8} key={c.id}>
                  <ContestCalendarCard contest={c} mode={tab} />
                </Col>
              ))}
            </Row>
          </section>
        ))
      )}
    </div>
  )
}

/** 日历页签的比赛卡：三态共用一张卡，差一点只在 meta 时刻与底部状态药丸 */
function ContestCalendarCard({
  contest: c,
  mode,
}: {
  contest: ContestInfo
  mode: Exclude<ContestType, 'participated'>
}) {
  return (
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
        {/* 分组页签的日期由组头承担，卡内只留 时:分；进行中平铺展示完整时刻 */}
        <span>{mode === 'running' ? fmtStart(c.startTimeIso) : fmtTimeHm(c.startTimeIso)}</span>
      </div>
      {mode === 'upcoming' && c.startTimeIso && (
        <div className="contest-countdown">{countdown(c.startTimeIso)}</div>
      )}
      {mode === 'running' && c.startTimeIso && (
        <div className="contest-countdown">{remaining(c.startTimeIso, c.durationMinutes)}</div>
      )}
      {mode === 'finished' && c.startTimeIso && (
        <div className="contest-countdown contest-countdown-dim">
          {endedAgo(c.startTimeIso, c.durationMinutes)}
        </div>
      )}
    </Card>
  )
}

/** 平台筛选：日历页签 5 平台（后端聚合含计蒜客，此前筛选漏了它）；「我参加的」
 *  追加 QOJ——它没有赛事日历源（日历页签选了恒为空），但参赛记录可以含 QOJ 场次 */
const CALENDAR_PLATFORM_OPTIONS = [
  { value: 'codeforces' as const, label: 'Codeforces' },
  { value: 'atcoder' as const, label: 'AtCoder' },
  { value: 'luogu' as const, label: '洛谷' },
  { value: 'nowcoder' as const, label: '牛客' },
  { value: 'jisuanke' as const, label: '计蒜客' },
]
