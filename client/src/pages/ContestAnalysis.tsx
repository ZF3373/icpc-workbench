import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Select, Space, Tag, App as AntdApp } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { ContestAnalysisContest, ContestAnalysisProblem, ContestAnalysisResponse, ContestRatingStatus, PlatformId } from '../../../shared/src/index.ts'
import { api } from '../api'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import PageHeader from '../components/PageHeader'
import PageSkeleton from '../components/PageSkeleton'
import PlatformTag from '../components/PlatformTag'
import { platformName } from '../ui'
import './ContestAnalysis.css'

const RATING_LABEL: Record<ContestRatingStatus, { color: string; label: string }> = {
  rated: { color: 'green', label: 'Rated 正式参赛' },
  unrated: { color: 'default', label: '非正式参赛' },
  pending: { color: 'gold', label: 'Rating 待确认' },
}
const PARTICIPATION_LABEL: Record<string, string> = {
  contest: '现场参赛', virtual: '虚拟赛', 'key-pattern': '平台参赛题目',
  'calendar-window': '官方赛程匹配', 'joined-list': '平台参赛记录',
}

type Filters = { platform?: PlatformId; ratingStatus?: ContestRatingStatus; query: string }

function isStuck(problem: ContestAnalysisProblem): boolean {
  return problem.attemptCount > 0 && !problem.contestAccepted
}

function dateLabel(iso: string | null, approximate = false): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '时间待确认'
  const label = new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  return approximate ? `约 ${label}` : label
}

export default function ContestAnalysis() {
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()
  const [data, setData] = useState<ContestAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>({ query: '' })
  // 请求序号护栏（与 Dashboard/Mastery 的 reqSeq 同款）：连点「刷新」或保存标签失败
  // 自动重试时，慢的旧响应会后到并覆盖新数据
  const reqSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(null)
    try {
      const next = await api<ContestAnalysisResponse>('/api/contests/analysis')
      if (seq !== reqSeq.current) return
      setData(next)
    } catch (cause) {
      if (seq !== reqSeq.current) return
      setError((cause as Error).message)
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const contests = useMemo(() => {
    const query = filters.query.normalize('NFKC').trim().toLocaleLowerCase()
    return (data?.contests ?? []).filter(item => {
      if (filters.platform && item.contest.platform !== filters.platform) return false
      if (filters.ratingStatus && item.ratingStatus !== filters.ratingStatus) return false
      if (!query) return true
      return [item.contest.name, item.contest.contestId, item.contest.platform, platformName(item.contest.platform)]
        .filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase().includes(query)
    })
  }, [data, filters])

  const problems = contests.flatMap(item => item.problems)
  const attempted = problems.filter(problem => problem.attemptCount > 0)
  const stuck = attempted.filter(isStuck)
  const upsolved = stuck.filter(problem => problem.postContestAccepted)
  const postContestAttempts = problems.reduce((sum, problem) => sum + problem.postContestAttemptCount, 0)
  const tagCounts = new Map<string, number>()
  for (const problem of stuck) for (const tag of problem.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  const platformOptions = [...new Set((data?.contests ?? []).map(item => item.contest.platform))]
    .map(platform => ({ value: platform, label: platformName(platform) }))

  // 乐观更新全部走 setData 函数式更新，不读组件作用域状态 → 依赖恒空；
  // 稳定引用让 memo 的 ContestCard/ProblemRow 不因每次渲染新回调而全量重渲染
  const persistTag = useCallback(async (problem: ContestAnalysisProblem, tag: string, add: boolean) => {
    const path = '/api/contests/analysis/tags'
    const body = JSON.stringify({ contestKey: problem.contestKey, platform: problem.platform, problemKey: problem.problemKey, tag })
    const optimistic = (current: ContestAnalysisResponse | null, tags: string[]) => current && ({
      contests: current.contests.map(item => ({
        ...item,
        problems: item.problems.map(row => row.contestKey === problem.contestKey && row.platform === problem.platform && row.problemKey === problem.problemKey
          ? { ...row, tags }
          : row),
        untaggedStuckCount: item.problems.filter(row => row.contestKey === item.contest.key && isStuck(row)
          && (row.contestKey === problem.contestKey && row.platform === problem.platform && row.problemKey === problem.problemKey ? tags.length === 0 : row.tags.length === 0)).length,
      })),
    })
    const nextTags = add
      ? [...new Set([...problem.tags, tag.trim()])]
      : problem.tags.filter(existing => existing !== tag)
    setData(current => optimistic(current, nextTags))
    try {
      const response = await api<{ tags: string[] }>(path, {
        method: add ? 'PUT' : 'DELETE',
        body,
      })
      setData(current => optimistic(current, response.tags))
    } catch (cause) {
      message.error(`赛时标签保存失败：${(cause as Error).message}`)
      void load()
    }
  }, [load, message])

  return <div className="contest-analysis-page" aria-busy={loading}>
    <PageHeader title="赛时分析" description="单独查看比赛期间卡住的题目和赛后补题，不影响日常薄弱项分析。" extra={
      <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
    } />

    <div className="contest-analysis-toolbar" role="search" aria-label="筛选赛时分析">
      <Input allowClear placeholder="搜索比赛名称或编号" value={filters.query}
        onChange={event => setFilters(current => ({ ...current, query: event.target.value }))} />
      <Select allowClear placeholder="全部平台" value={filters.platform}
        options={platformOptions} onChange={platform => setFilters(current => ({ ...current, platform }))} />
      <Select allowClear placeholder="全部参赛类型" value={filters.ratingStatus}
        options={(Object.entries(RATING_LABEL) as Array<[ContestRatingStatus, { color: string; label: string }]>).map(([value, item]) => ({ value, label: item.label }))}
        onChange={ratingStatus => setFilters(current => ({ ...current, ratingStatus }))} />
    </div>

    {error && data && <Alert type="warning" showIcon message={`刷新失败，保留已加载内容：${error}`} action={<Button size="small" onClick={() => void load()}>重试</Button>} />}
    {!data && loading ? <PageSkeleton stats={true} blocks={2} blockHeight={220} />
      : !data && error ? <Card><InlineError message={error} hint="赛时分析加载失败，请重试。" onRetry={() => void load()} retrying={loading} /></Card>
        : !contests.length ? <Card><EmptyState title={data?.contests.length ? '没有符合筛选的比赛' : '暂无可分析的比赛'}
          description={data?.contests.length ? '试试其他平台、参赛类型或关键词。' : '同步已参加的比赛后，这里会显示能可靠匹配到比赛时间的题目。'}
          action={data?.contests.length
            ? { label: '清除筛选', onClick: () => setFilters({ query: '' }), type: 'primary' }
            : { label: '查看已参加比赛', onClick: () => navigate('/contests?tab=participated'), type: 'primary' }} />
        </Card> : <>
          <div className="contest-analysis-summary" aria-live="polite">
            <Card size="small"><span>赛时提交题目</span><strong>{attempted.length}</strong></Card>
            <Card size="small"><span>赛时通过</span><strong>{attempted.filter(problem => problem.contestAccepted).length}</strong></Card>
            <Card size="small"><span>赛时未通过</span><strong>{stuck.length}</strong></Card>
            <Card size="small"><span>赛后补题提交</span><strong>{postContestAttempts}</strong></Card>
            <Card size="small"><span>赛后补题通过</span><strong>{upsolved.length}</strong></Card>
            <Card size="small"><span>未打赛时标签</span><strong>{stuck.filter(problem => problem.tags.length === 0).length}</strong></Card>
          </div>

          {tagCounts.size > 0 && <Card size="small" className="contest-analysis-tags-overview" title="赛时未通过题目的标签分布">
            <Space wrap>{[...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) =>
              <Tag key={tag} color="blue">{tag} · {count}</Tag>)}</Space>
          </Card>}

          <div className="contest-analysis-list">
            {contests.map(item => <ContestCard key={item.contest.key} item={item} onAddTag={(problem, tag) => persistTag(problem, tag, true)}
              onRemoveTag={(problem, tag) => persistTag(problem, tag, false)} />)}
          </div>
        </>}
  </div>
}

// memo：搜索框每击键都会重建整页，比赛卡片与题目行只依赖自己的 item/problem
const ContestCard = memo(function ContestCard({ item, onAddTag, onRemoveTag }: {
  item: ContestAnalysisContest
  onAddTag: (problem: ContestAnalysisProblem, tag: string) => void
  onRemoveTag: (problem: ContestAnalysisProblem, tag: string) => void
}) {
  const status = RATING_LABEL[item.ratingStatus]
  const contest = item.contest
  return <Card className="contest-analysis-card" size="small" title={<div className="contest-analysis-card-title">
    <PlatformTag id={contest.platform} />
    {contest.url ? <a href={contest.url} target="_blank" rel="noreferrer">{contest.name ?? `${platformName(contest.platform)} · ${contest.contestId}`} ↗</a>
      : <span>{contest.name ?? `${platformName(contest.platform)} · ${contest.contestId}`}</span>}
    <Tag>{PARTICIPATION_LABEL[contest.evidence] ?? '参赛记录'}</Tag>
    <Tag color={status.color}>{status.label}</Tag>
  </div>}>
    <div className="contest-analysis-card-meta">
      <span>{dateLabel(contest.startTimeIso, contest.timeIsApproximate)}</span>
      <span>{item.problems.length} 题</span>
      <span>赛时未通过 {item.problems.filter(isStuck).length}</span>
      <span>其中赛后通过 {item.problems.filter(problem => isStuck(problem) && problem.postContestAccepted).length}</span>
      <span>未标记 {item.untaggedStuckCount}</span>
    </div>
    {item.problems.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无逐题提交或题单信息" />
      : <div className="contest-analysis-problems">
        {item.problems.map(problem => <ProblemRow key={`${problem.platform}:${problem.problemKey}`} problem={problem} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />)}
      </div>}
  </Card>
})

const ProblemRow = memo(function ProblemRow({ problem, onAddTag, onRemoveTag }: {
  problem: ContestAnalysisProblem
  onAddTag: (problem: ContestAnalysisProblem, tag: string) => void
  onRemoveTag: (problem: ContestAnalysisProblem, tag: string) => void
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const tag = draft.trim()
    if (!tag || problem.tags.includes(tag) || Array.from(tag).length > 40) return
    onAddTag(problem, tag)
    setDraft('')
  }
  const outcome = problem.attemptCount === 0
    ? { color: 'default', label: '未尝试' }
    : problem.contestAccepted ? { color: 'green', label: '赛时通过' } : { color: 'volcano', label: '赛时未通过' }
  return <div className="contest-analysis-problem-row">
    <div className="contest-analysis-problem-name">
      <span className="contest-analysis-problem-id">{problem.problemKey}</span>
      {problem.url ? <a href={problem.url} target="_blank" rel="noreferrer">{problem.title} ↗</a> : <span>{problem.title}</span>}
    </div>
    <div className="contest-analysis-problem-result">
      <Tag color={outcome.color}>{outcome.label}</Tag>
      {problem.attemptCount > 0 && <span>{problem.attemptCount} 次赛时提交</span>}
      {problem.postContestAttemptCount > 0 && <span>{problem.postContestAttemptCount} 次赛后补题</span>}
      {isStuck(problem) && problem.postContestAccepted && <Tag color="blue">赛后通过</Tag>}
    </div>
    <div className="contest-analysis-problem-tags">
      {problem.tags.map(tag => <Tag key={tag} closable onClose={event => { event.preventDefault(); onRemoveTag(problem, tag) }}>{tag}</Tag>)}
      <Input size="small" maxLength={40} aria-label={`为 ${problem.problemKey} 添加赛时标签`} placeholder="添加赛时标签" value={draft}
        onChange={event => setDraft(event.target.value)} onPressEnter={event => { event.preventDefault(); add() }} />
      {draft.trim() && <Button size="small" type="link" onClick={add}>添加</Button>}
    </div>
  </div>
})
