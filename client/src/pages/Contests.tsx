import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Col, Input, Pagination, Row, Segmented, Select, Tag, Tooltip } from 'antd'
import { ClockCircleOutlined, RedoOutlined, RobotOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import { api } from '../api'
import { platformName } from '../ui'
import {
  contestViewParams, endedAgo, filterParticipated, fmtTimeHm, groupContestsByDay,
  readContestView, upsolveProgress,
  type ContestTab, type ContestView, type EvidenceFilter, type ProgressFilter,
} from './contestsView'
import type { ContestInfo, ParticipatedContest } from '../types'
import type { PlatformId } from '../../../shared/src/index.ts'

// antd 预设色由 theme.algorithm 配对亮暗前景与底色，不替换成 CSS 变量。
const CATEGORY_COLOR: Record<string, string> = {
  'Div. 1': 'volcano', 'Div. 2': 'geekblue', 'Div. 3': 'cyan', 'Div. 4': 'green',
  Educational: 'purple', Global: 'gold', ICPC: 'magenta', ABC: 'blue', ARC: 'orange',
  AGC: 'red', AHC: 'lime', 月赛: 'magenta', 入门赛: 'green', 重现赛: 'default',
  训练: 'processing', 周赛: 'gold', 小白月赛: 'cyan', 挑战赛: 'volcano', 练习赛: 'blue', 校赛: 'geekblue',
}
const EVIDENCE_TAG: Record<string, { color: string; label: string; detail: string }> = {
  contest: { color: 'green', label: '现场参赛', detail: 'Codeforces 明确标记为比赛期间的正式或非正式参赛提交。' },
  virtual: { color: 'blue', label: '虚拟赛', detail: 'Codeforces 明确标记为虚拟赛提交。' },
  gym: { color: 'geekblue', label: 'gym 训练', detail: '根据短时间集中作答推测的 gym 训练，不能确认是否实际组队参赛。' },
  'key-pattern': { color: 'cyan', label: '比赛提交', detail: '来自计蒜客参赛同步记录；QOJ 的比赛题号本身不作为参赛证据。' },
  'calendar-window': { color: 'default', label: '赛时提交', detail: '根据该场比赛的官方赛程与赛时提交匹配。' },
  heuristic: { color: 'default', label: '疑似参赛', detail: '缺少官方赛程，根据集中提交推测，可能是练习或补题。' },
  'joined-list': { color: 'purple', label: '平台记录', detail: '平台参赛历史中有这场记录；逐条提交可能尚未同步。' },
}
const CALENDAR_PLATFORMS = [
  { value: 'codeforces', label: 'Codeforces' }, { value: 'atcoder', label: 'AtCoder' },
  { value: 'luogu', label: '洛谷' }, { value: 'nowcoder', label: '牛客' }, { value: 'jisuanke', label: '计蒜客' },
]
const PAGE_SIZE = 18
const PARTICIPATED_CACHE_TTL = 5 * 60_000
interface ContestsResponse {
  contests: ContestInfo[]
  total?: number
  categories?: string[]
  failures: Partial<Record<PlatformId, string>>
}
interface ParticipatedResponse {
  contests: ParticipatedContest[]
  sourceFailures?: Partial<Record<PlatformId, string>>
  refreshing?: PlatformId[]
}
let participatedCache: { at: number; data: ParticipatedResponse } | null = null

function fmtStart(iso: string | null): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '时间待定'
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}
function fmtDuration(minutes: number): string {
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}` : `${minutes} 分钟`
}
function countdown(iso: string): string {
  const diff = Date.parse(iso) - Date.now()
  if (diff <= 0) return '已开始'
  const days = Math.floor(diff / 86_400_000)
  const hours = Math.floor((diff % 86_400_000) / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  if (days > 0) return `${days} 天 ${hours} 小时后`
  if (hours > 0) return `${hours} 小时 ${minutes} 分后`
  return minutes > 0 ? `${minutes} 分钟后` : '即将开始'
}
function remaining(iso: string, minutes: number): string {
  const diff = Date.parse(iso) + minutes * 60_000 - Date.now()
  if (diff <= 0) return '已结束'
  const hours = Math.floor(diff / 3_600_000)
  const mins = Math.floor((diff % 3_600_000) / 60_000)
  return hours > 0 ? `剩 ${hours} 小时 ${mins} 分结束` : mins > 0 ? `剩 ${mins} 分钟结束` : '即将结束'
}
function fmtFailures(failures: Partial<Record<PlatformId, string>>): string {
  return Object.entries(failures).filter(([, value]) => value).map(([id, value]) => `${platformName(id as PlatformId)}：${value}`).join('；')
}

export default function Contests() {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const view = readContestView(params)
  const { tab, platform, query, category, progress, evidence, sort } = view
  const setView = (patch: Partial<ContestView>) => {
    const next = readContestView(contestViewParams({ ...view, ...patch, page: patch.page ?? 1 }))
    setParams(contestViewParams(next), { replace: patch.query !== undefined })
  }
  const clearFilters = () => setView({ platform: undefined, query: '', category: '', progress: 'all', evidence: 'all', sort: 'date' })
  const hasFilters = !!(platform || query.trim() || category || progress !== 'all' || evidence !== 'all')
  const [debouncedQuery, setDebouncedQuery] = useState(query)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const calendarParams = new URLSearchParams({ type: tab, limit: String(PAGE_SIZE), offset: String((view.page - 1) * PAGE_SIZE) })
  if (platform) calendarParams.set('platform', platform)
  if (debouncedQuery.trim()) calendarParams.set('q', debouncedQuery.trim())
  if (category) calendarParams.set('category', category)
  // 参赛页的筛选和分页全部在已同步的快照上完成，不触发额外的平台拉取。
  const requestKey = tab === 'participated' ? 'participated' : `/api/contests?${calendarParams}`
  const [calendarState, setCalendarState] = useState<{ key: string; data: ContestsResponse } | null>(null)
  const data = calendarState?.key === requestKey && query === debouncedQuery ? calendarState.data : null
  const [participated, setParticipated] = useState<ParticipatedResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const loadError = error?.key === requestKey ? error.message : null
  const reqSeq = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)

  const load = useCallback(async (key: string, force = false) => {
    const seq = ++reqSeq.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setLoading(true)
    setError(null)
    try {
      if (key === 'participated') {
        const cached = !force && participatedCache && Date.now() - participatedCache.at < PARTICIPATED_CACHE_TTL ? participatedCache : null
        const result = cached
          ? cached.data
          : await api<ParticipatedResponse>(force ? '/api/contests/participated/refresh' : '/api/contests/participated', {
            method: force ? 'POST' : 'GET', signal: controller.signal,
          })
        if (seq !== reqSeq.current) return
        if (!cached) participatedCache = { at: Date.now(), data: result }
        setParticipated(result)
      } else {
        const result = await api<ContestsResponse>(force ? `${key}&refresh=1` : key, { signal: controller.signal })
        if (seq !== reqSeq.current) return
        setCalendarState({ key, data: result })
      }
    } catch (cause) {
      if (seq === reqSeq.current && !controller.signal.aborted) setError({ key, message: (cause as Error).message })
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])
  useEffect(() => { void load(requestKey) }, [requestKey, load])
  useEffect(() => () => { ++reqSeq.current; activeRequest.current?.abort() }, [])

  const refreshing = participated?.refreshing ?? []
  useEffect(() => {
    if (tab !== 'participated' || refreshing.length === 0 || loading) return
    const controller = new AbortController()
    let inFlight = false
    const seq = reqSeq.current
    const timer = window.setInterval(async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      try {
        const result = await api<ParticipatedResponse>('/api/contests/participated', { signal: controller.signal })
        if (seq !== reqSeq.current || controller.signal.aborted) return
        participatedCache = { at: Date.now(), data: result }
        setParticipated(result)
      } catch { /* 轮询失败保留已加载记录，下次重试。 */ }
      finally { inFlight = false }
    }, 20_000)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [tab, refreshing.length, loading])

  const [, setTick] = useState(0)
  const dataRef = useRef(data)
  dataRef.current = data
  useEffect(() => {
    if (tab === 'participated') return
    const timer = window.setInterval(() => {
      setTick(value => value + 1)
      if (tab === 'finished' || loading || document.hidden) return
      const crossed = dataRef.current?.contests.some(c => {
        if (!c.startTimeIso) return false
        const start = Date.parse(c.startTimeIso)
        return tab === 'upcoming' ? start <= Date.now() : start + c.durationMinutes * 60_000 <= Date.now()
      })
      if (crossed) void load(requestKey)
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [tab, loading, requestKey, load])

  // 从旧链接打开超出范围的页，或刷新后总数减少时，回到最后一个有效页。
  useEffect(() => {
    if (tab === 'participated' || query !== debouncedQuery || data?.total == null || view.page <= Math.max(1, Math.ceil(data.total / PAGE_SIZE))) return
    setParams(previous => contestViewParams({ ...readContestView(previous), page: Math.max(1, Math.ceil(data.total! / PAGE_SIZE)) }), { replace: true })
  }, [tab, query, debouncedQuery, data?.total, view.page, setParams])

  const history = filterParticipated(participated?.contests ?? [], view)
  const total = tab === 'participated' ? history.length : data?.total ?? data?.contests.length ?? 0
  const page = Math.min(view.page, Math.max(1, Math.ceil(total / PAGE_SIZE)))
  const historyPage = history.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const items = data?.contests ?? []
  const ready = tab === 'participated' ? participated !== null : data !== null
  const failures = tab === 'participated' ? participated?.sourceFailures ?? {} : data?.failures ?? {}
  const categories = data?.categories ?? [...new Set(items.map(c => c.category))]
  const platformOptions = tab === 'participated' ? [...CALENDAR_PLATFORMS, { value: 'qoj', label: 'QOJ' }] : CALENDAR_PLATFORMS
  const reload = () => void load(requestKey, true)

  return (
    <div className="contests-page" aria-busy={loading}>
      <PageHeader title="赛事中心" description="挑选下一场比赛，回顾参赛表现，跟进补题。" extra={
        <Tooltip title={tab === 'participated' ? '重新同步各平台参赛记录，已有列表在更新期间保留。' : '重新获取各平台赛事日程。'}>
          <Button icon={<RedoOutlined />} loading={loading} onClick={reload}>刷新</Button>
        </Tooltip>
      } />
      <div className="contest-tabs">
        <Segmented block value={tab} onChange={value => setView({ tab: value as ContestTab, category: '' })} options={[
          { label: '即将开始', value: 'upcoming' }, { label: '进行中', value: 'running' },
          { label: '最近结束', value: 'finished' }, { label: '我参加的', value: 'participated' },
        ]} />
      </div>
      <div className="contest-toolbar" role="search" aria-label="筛选赛事">
        <Input className="contest-search" aria-label="搜索赛事" placeholder="搜索比赛名称或场次号" maxLength={200}
          prefix={<SearchOutlined />} allowClear value={query} onChange={event => setView({ query: event.target.value })} />
        <Select aria-label="筛选平台" allowClear placeholder="全部平台" value={platform} options={platformOptions}
          onChange={value => setView({ platform: value, category: '' })} />
        {tab === 'participated' ? <>
          <Select aria-label="补题进度" value={progress} onChange={value => setView({ progress: value as ProgressFilter })} options={[
            { value: 'all', label: '全部补题进度' }, { value: 'pending', label: '还有题待补' },
            { value: 'complete', label: '已全部 AC' }, { value: 'unknown', label: '进度待确认' },
          ]} />
          <Select aria-label="参赛依据" value={evidence} onChange={value => setView({ evidence: value as EvidenceFilter })} options={[
            { value: 'all', label: '全部参赛依据' }, { value: 'recorded', label: '平台记录与赛时提交' }, { value: 'inferred', label: '训练与推测记录' },
          ]} />
          <Select aria-label="历史排序" value={sort} onChange={value => setView({ sort: value })} options={[
            { value: 'date', label: '最近参赛优先' }, { value: 'activity', label: '最近补题 / 活动优先' },
          ]} />
        </> : <Select aria-label="比赛分类" allowClear placeholder="全部分类" value={category || undefined}
          options={[...new Set([...categories, ...(category ? [category] : [])])].map(value => ({ value, label: value }))}
          onChange={value => setView({ category: value ?? '' })} />}
        {hasFilters && <Button type="text" onClick={clearFilters}>清除筛选</Button>}
      </div>
      <div className="contest-results-bar" aria-live="polite">
        <span>{ready ? <>共 <strong>{total}</strong> 场{hasFilters ? '符合筛选' : tab === 'participated' ? '参赛与训练记录' : '比赛'}</> : '正在加载赛事…'}</span>
        <span>{tab === 'participated' ? '补题进度以已同步记录为准' : tab === 'upcoming' ? '按开赛时间排序 · 时间按本地时区显示' : tab === 'running' ? '即将结束的比赛优先' : '最近结束的比赛优先'}</span>
      </div>

      {tab === 'participated' && refreshing.length > 0 && <Alert className="contest-alert" type="info" showIcon
        message={`正在更新赛事记录与题目总数：${refreshing.map(platformName).join('、')}，完成后自动显示。`} />}
      {Object.keys(failures).length > 0 && <Alert className="contest-alert" type="warning" showIcon
        message={`部分平台暂不可用：${fmtFailures(failures)}。当前仅显示已取得的数据。`} />}
      {loadError && ready && <Alert className="contest-alert" type="warning" showIcon message={`更新失败，保留已加载记录：${loadError}`}
        action={<Button size="small" onClick={reload}>重试</Button>} />}

      {!ready && !loadError ? <PageSkeleton stats={false} blocks={3} blockHeight={230} />
        : !ready && loadError ? <Card><InlineError message={loadError} hint="赛事加载失败，请重试。" onRetry={reload} retrying={loading} /></Card>
        : total === 0 ? <Card><EmptyState
          title={hasFilters ? '没有符合筛选的比赛' : tab === 'participated' ? '暂无参赛记录' : tab === 'running' ? '当前没有进行中的比赛' : tab === 'finished' ? '暂无近期比赛记录' : '暂无已排期的比赛'}
          description={platform === 'qoj'
            ? 'QOJ 的比赛题号只能确定题目归属，缺少可靠参赛证据的场次不会列入。补题记录仍可在「题目管理」中查看。'
            : hasFilters ? tab === 'participated' ? '试试其他关键词或清除筛选；缺少官方总题数或逐条提交的场次归入「进度待确认」。' : '试试其他关键词、平台或分类，也可以清除筛选。'
              : tab === 'participated' ? '绑定平台账号并同步提交后，可查看参赛历史。平台记录与训练推测会分别标明。'
                : '当前数据源未返回这个阶段的比赛，可以切换页签或稍后刷新。'}
          actions={[
            hasFilters ? { label: '清除筛选', type: 'primary', onClick: clearFilters }
              : tab === 'participated' ? { label: '绑定与同步账号', type: 'primary', onClick: () => nav('/settings') }
                : { label: tab === 'upcoming' ? '查看进行中的比赛' : '查看即将开始的比赛', type: 'primary', onClick: () => setView({ tab: tab === 'upcoming' ? 'running' : 'upcoming' }) },
            { label: '重新加载', onClick: reload },
          ]} /></Card>
          : tab === 'participated' ? <Row gutter={[16, 16]}>{historyPage.map(c => <Col xs={24} lg={12} xl={8} key={c.key}>
            <ParticipationCard contest={c} onReview={() => nav(`/ai?contest=${encodeURIComponent(c.key)}`)} />
          </Col>)}</Row>
            : tab === 'running' ? <Row gutter={[16, 16]}>{items.map(c => <Col xs={24} lg={12} xl={8} key={c.id}>
              <CalendarCard contest={c} mode={tab} />
            </Col>)}</Row>
              : groupContestsByDay(items).map(group => <section className="contest-day-section" key={group.key}>
                <div className="contest-day-head"><span className="contest-day-title">{group.label}</span><span className="contest-day-count">{group.items.length} 场</span></div>
                <Row gutter={[16, 16]}>{group.items.map(c => <Col xs={24} lg={12} xl={8} key={c.id}><CalendarCard contest={c} mode={tab} /></Col>)}</Row>
              </section>)}
      {ready && total > PAGE_SIZE && <div className="contest-pagination"><Pagination current={page} total={total} pageSize={PAGE_SIZE}
        showSizeChanger={false} showLessItems onChange={value => setView({ page: value })} showTotal={count => `共 ${count} 场`} /></div>}
    </div>
  )
}

function ParticipationCard({ contest: c, onReview }: { contest: ParticipatedContest; onReview: () => void }) {
  const progress = upsolveProgress(c)
  const evidence = EVIDENCE_TAG[c.evidence] ?? { color: 'default', label: '依据待确认', detail: '暂无法识别这条参赛记录的依据。' }
  return <Card size="small" className="contest-card">
    <div className="today-problem-head"><PlatformTag id={c.platform} /><Tooltip title={evidence.detail}><Tag color={evidence.color}>{evidence.label}</Tag></Tooltip></div>
    {c.url ? <a className="today-problem-title" href={c.url} target="_blank" rel="noreferrer">{c.name ?? `${platformName(c.platform)} · ${c.contestId}`} ↗</a>
      : <span className="today-problem-title">{c.name ?? `${platformName(c.platform)} · ${c.contestId}`}</span>}
    <div className="contest-meta"><Tooltip title={c.timeIsApproximate ? '时间来自提交活动近似，完整官方赛程未知。' : '官方比赛时间'}><span><ClockCircleOutlined /> {c.timeIsApproximate ? '约 ' : ''}{fmtStart(c.startTimeIso)}</span></Tooltip><span>{c.submissionCount > 0 ? `${c.submissionCount} 次提交` : '逐条提交未同步'}</span></div>
    <div className="contest-statgrid">
      {(c.submissionCount > 0 || c.source?.acceptedCount != null) && <div className="contest-stat"><span className="contest-stat-label">{(c.accounts?.length ?? 0) > 1 ? '合并 AC' : '当前 AC'}</span>
        <span className={`contest-stat-value${progress.status === 'complete' ? ' contest-stat-done' : ''}`}>{c.acCountIsLowerBound ? '≥' : ''}{c.acProblemCount}
          {progress.total !== null && <span className="contest-stat-denom">/{progress.total}</span>}</span>
      </div>}
      {c.submissionCount === 0 && c.source?.acceptedCount == null && progress.total !== null && <div className="contest-stat"><span className="contest-stat-label">总题数</span><span className="contest-stat-value">{progress.total}</span></div>}
      {c.inContestAcProblemCount !== null && <div className="contest-stat"><span className="contest-stat-label">赛中 AC</span><span className="contest-stat-value contest-stat-value-dim">{c.inContestAcProblemCount}</span></div>}
      {c.source?.rank != null && <div className="contest-stat"><span className="contest-stat-label">排名</span><span className="contest-stat-value contest-stat-value-dim">{c.source.rank}</span></div>}
      {c.source?.rating != null && <div className="contest-stat"><span className="contest-stat-label">Rating</span><span className="contest-stat-value contest-stat-value-dim">{c.source.rating}
        {!!c.source.ratingChange && <span className={`contest-stat-delta ${c.source.ratingChange > 0 ? 'contest-stat-delta-up' : 'contest-stat-delta-down'}`}>{c.source.ratingChange > 0 ? '+' : ''}{c.source.ratingChange}</span>}</span></div>}
    </div>
    <div className={`contest-progress-note${progress.status === 'complete' ? ' is-complete' : progress.status === 'pending' ? ' is-pending' : ''}`}>
      {progress.status === 'complete' ? '已全部 AC' : progress.status === 'pending' ? `还有 ${progress.remaining} 题待补` : c.acCountIsLowerBound ? '提交明细不全，AC 为已知下限，补题进度待确认' : c.submissionCount === 0 ? '缺少逐条提交，补题进度待确认' : '总题数未同步，补题进度待确认'}
    </div>
    {c.accounts && c.accounts.length > 1 && <div className="contest-footnote">合并账号：{c.accounts.join('、')}；{c.source?.account ? `排名、Rating 与赛中 AC 来自 ${c.source.account}` : '赛中 AC 按账号合并'}。</div>}
    <Button size="small" type="link" icon={<RobotOutlined />} className="contest-review-action" onClick={onReview}>去 AI 复盘</Button>
  </Card>
}

function CalendarCard({ contest: c, mode }: { contest: ContestInfo; mode: Exclude<ContestTab, 'participated'> }) {
  return <Card size="small" className="contest-card">
    <div className="today-problem-head"><PlatformTag id={c.platform} /><Tag color={CATEGORY_COLOR[c.category] ?? 'default'}>{c.category}</Tag></div>
    <a className="today-problem-title" href={c.url} target="_blank" rel="noreferrer">{c.name} ↗</a>
    <div className="contest-meta"><span><ClockCircleOutlined /> {fmtDuration(c.durationMinutes)}</span><span>{mode === 'running' ? fmtStart(c.startTimeIso) : fmtTimeHm(c.startTimeIso)}</span></div>
    {c.startTimeIso && <div className={`contest-countdown${mode === 'finished' ? ' contest-countdown-dim' : ''}`}>
      {mode === 'upcoming' ? countdown(c.startTimeIso) : mode === 'running' ? remaining(c.startTimeIso, c.durationMinutes) : endedAgo(c.startTimeIso, c.durationMinutes)}
    </div>}
  </Card>
}
