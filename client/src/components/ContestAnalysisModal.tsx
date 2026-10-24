/**
 * 单场赛时分析弹窗：赛事中心「我参加的」每张卡片的「赛事分析」入口。
 *
 * 从原独立页面（/contest-analysis）融合而来：按 contestKey 请求单场投影
 * （GET /api/contests/analysis?contestKey=），弹窗内还原原页面的单场内容——
 * 比赛元信息、逐题赛时/赛后结果、赛时标签编辑（乐观更新 + 失败回滚，与原页面同款）。
 * 该场缺少可靠归属数据时后端返回 404，弹窗展示说明而不是空白。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Empty, Modal, Select, Tag, App as AntdApp } from 'antd'
import type { ContestAnalysisContest, ContestAnalysisProblem, PlatformId } from '../../../shared/src/index.ts'
import { TAG_SYNONYM_GROUPS } from '../../../shared/src/index.ts'
import { api } from '../api'
import EmptyState from './EmptyState'
import InlineError from './InlineError'
import PlatformTag from './PlatformTag'
import { platformName } from '../ui'
const PARTICIPATION_LABEL: Record<string, string> = {
  contest: '现场参赛', virtual: '虚拟赛', 'key-pattern': '平台参赛题目',
  'calendar-window': '官方赛程匹配', 'joined-list': '平台参赛记录',
}

const RATING_LABEL: Record<ContestAnalysisContest['ratingStatus'], { color: string; label: string }> = {
  rated: { color: 'green', label: 'Rated 正式参赛' },
  unrated: { color: 'default', label: '非正式参赛' },
  pending: { color: 'gold', label: 'Rating 待确认' },
}

function isStuck(problem: ContestAnalysisProblem): boolean {
  return problem.attemptCount > 0 && !problem.contestAccepted
}

/** 标签长度上限与服务端 MAX_ANALYSIS_TAG_LENGTH 对齐 */
const MAX_TAG_LENGTH = 40

/**
 * 默认标签候选：赛时卡壳常见原因（词表体系外，复盘专用）+
 * 全部知识点规范名（与题库/掌握度地图同词表，取自 TAG_SYNONYM_GROUPS 的 name，
 * 约 200 项；选择框支持搜索，不影响挑选）。自定义输入仍然可用。
 */
const DEFAULT_TAG_OPTIONS: string[] = [
  '实现细节写挂', '思路不清', '时间不够', '读错题意', '复杂度超限', '边界情况遗漏',
  ...TAG_SYNONYM_GROUPS.map(group => group.name),
]

function dateLabel(iso: string | null, approximate = false): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '时间待确认'
  const label = new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  return approximate ? `约 ${label}` : label
}

export default function ContestAnalysisModal({ contest, onClose }: {
  /** 赛事中心「我参加的」列表项；key 用作单场过滤参数 */
  contest: { key: string; name?: string | null; platform: PlatformId }
  onClose: () => void
}) {
  const { message } = AntdApp.useApp()
  const [item, setItem] = useState<ContestAnalysisContest | null>(null)
  const [usedTags, setUsedTags] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  // 请求序号护栏：连续开关弹窗时慢的旧响应不得覆盖后打开的那场
  const reqSeq = useRef(0)

  const load = useCallback(async (contestKey: string) => {
    const seq = ++reqSeq.current
    setLoading(true)
    setError(null)
    setMissing(false)
    try {
      const response = await api<{ contests: ContestAnalysisContest[]; usedTags?: string[] }>(
        `/api/contests/analysis?contestKey=${encodeURIComponent(contestKey)}`)
      if (seq !== reqSeq.current) return
      setItem(response.contests[0] ?? null)
      if (response.usedTags) setUsedTags(response.usedTags)
    } catch (cause) {
      if (seq !== reqSeq.current) return
      // 404 = 该场不满足可靠归属（证据不足 / 时间窗缺失），展示说明而非报错
      if ((cause as Error).message.includes('无法生成赛时分析')) {
        setMissing(true)
        setItem(null)
      } else {
        setError((cause as Error).message)
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void load(contest.key) }, [contest.key, load])
  useEffect(() => () => { ++reqSeq.current }, [])

  // 标签乐观更新（与原独立页面同款：setData 函数式更新 + 失败提示后重载）
  const persistTag = useCallback(async (problem: ContestAnalysisProblem, tag: string, add: boolean) => {
    const body = JSON.stringify({ contestKey: problem.contestKey, platform: problem.platform, problemKey: problem.problemKey, tag })
    const nextTags = add
      ? [...new Set([...problem.tags, tag.trim()])]
      : problem.tags.filter(existing => existing !== tag)
    const patch = (tags: string[]) => setItem(current => current && ({
      ...current,
      problems: current.problems.map(row => row.problemKey === problem.problemKey ? { ...row, tags } : row),
      untaggedStuckCount: current.problems.filter(row => isStuck(row)
        && (row.problemKey === problem.problemKey ? tags.length === 0 : row.tags.length === 0)).length,
    }))
    patch(nextTags)
    try {
      const response = await api<{ tags: string[]; usedTags?: string[] }>('/api/contests/analysis/tags', {
        method: add ? 'PUT' : 'DELETE', body,
      })
      patch(response.tags)
      if (response.usedTags) setUsedTags(response.usedTags)
    } catch (cause) {
      message.error(`赛时标签保存失败：${(cause as Error).message}`)
      void load(contest.key)
    }
  }, [contest.key, load, message])

  const title = contest.name ?? `${platformName(contest.platform)} · ${contest.key}`

  return <Modal
    open
    onCancel={onClose}
    footer={null}
    width={860}
    className="contest-analysis-modal"
    title={<span className="contest-analysis-modal-title">{title}</span>}
  >
    <div className="contest-analysis-modal-body" aria-busy={loading}>
      {!item && loading ? <Card size="small"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="正在加载赛时分析…" /></Card>
        : missing ? <EmptyState title="这场比赛暂无赛时分析"
          description="这场比赛缺少可靠的赛时归属数据（参赛证据不足或时间窗未知），无法逐题区分赛时与赛后提交。"
          action={{ label: '关闭', onClick: onClose, type: 'primary' }} />
        : error && !item ? <InlineError message={error} hint="赛时分析加载失败，请重试。" onRetry={() => void load(contest.key)} retrying={loading} />
          : error && item ? <Alert type="warning" showIcon message={`刷新失败，保留已加载内容：${error}`}
            action={<Button size="small" onClick={() => void load(contest.key)}>重试</Button>} />
            : item ? <ContestAnalysisBody item={item} usedTags={usedTags}
              onAddTag={(problem, tag) => persistTag(problem, tag, true)}
              onRemoveTag={(problem, tag) => persistTag(problem, tag, false)} />
              : null}
    </div>
  </Modal>
}

const ContestAnalysisBody = ({ item, usedTags, onAddTag, onRemoveTag }: {
  item: ContestAnalysisContest
  usedTags: string[]
  onAddTag: (problem: ContestAnalysisProblem, tag: string) => void
  onRemoveTag: (problem: ContestAnalysisProblem, tag: string) => void
}) => {
  const status = RATING_LABEL[item.ratingStatus]
  const contest = item.contest
  const stuck = item.problems.filter(isStuck)
  const upsolved = stuck.filter(problem => problem.postContestAccepted)
  const postContestAttempts = item.problems.reduce((sum, problem) => sum + problem.postContestAttemptCount, 0)
  return <>
    <div className="contest-analysis-card-title contest-analysis-modal-head">
      <PlatformTag id={contest.platform} />
      {contest.url ? <a href={contest.url} target="_blank" rel="noreferrer">{contest.name ?? `${platformName(contest.platform)} · ${contest.contestId}`} ↗</a>
        : <span>{contest.name ?? `${platformName(contest.platform)} · ${contest.contestId}`}</span>}
      <Tag>{PARTICIPATION_LABEL[contest.evidence] ?? '参赛记录'}</Tag>
      <Tag color={status.color}>{status.label}</Tag>
    </div>
    <div className="contest-analysis-card-meta">
      <span>{dateLabel(contest.startTimeIso, contest.timeIsApproximate)}</span>
      <span>{item.problems.length} 题</span>
      <span>赛时提交题目 {item.problems.filter(problem => problem.attemptCount > 0).length}</span>
      <span>赛时未通过 {stuck.length}</span>
      <span>其中赛后通过 {upsolved.length}</span>
      <span>赛后补题提交 {postContestAttempts}</span>
      <span>未标记 {item.untaggedStuckCount}</span>
    </div>
    {item.problems.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无逐题提交或题单信息" />
      : <div className="contest-analysis-problems">
        {item.problems.map(problem => <ProblemRow key={`${problem.platform}:${problem.problemKey}`} problem={problem}
          options={problemOptions(item, usedTags)} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />)}
      </div>}
  </>
}

/**
 * 一场的候选标签：默认候选 + 本场各题已用标签 + 历史已用标签（用得多的排前）。
 * 默认候选项在前（选择框按顺序展示），避免高频知识点被使用次数顶出首屏。
 */
function problemOptions(item: ContestAnalysisContest, usedTags: string[]): Array<{ value: string; label: string }> {
  const seen = new Set<string>()
  const values: string[] = []
  const push = (tag: string) => {
    if (seen.has(tag)) return
    seen.add(tag)
    values.push(tag)
  }
  for (const tag of DEFAULT_TAG_OPTIONS) push(tag)
  for (const problem of item.problems) for (const tag of problem.tags) push(tag)
  for (const tag of usedTags) push(tag)
  return values.map(value => ({ value, label: value }))
}

const ProblemRow = ({ problem, options, onAddTag, onRemoveTag }: {
  problem: ContestAnalysisProblem
  options: Array<{ value: string; label: string }>
  onAddTag: (problem: ContestAnalysisProblem, tag: string) => void
  onRemoveTag: (problem: ContestAnalysisProblem, tag: string) => void
}) => {
  // 选择框勾选/反选与自定义输入统一走 onChange 差分：新增的逐个 PUT、移除的逐个 DELETE
  const handleChange = (next: string[]) => {
    const current = new Set(problem.tags)
    for (const tag of next) {
      if (!current.has(tag)) onAddTag(problem, tag)
    }
    for (const tag of problem.tags) {
      if (!next.includes(tag)) onRemoveTag(problem, tag)
    }
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
    <Select
      className="contest-analysis-tag-select"
      mode="tags"
      size="small"
      value={problem.tags}
      options={options}
      onChange={handleChange}
      placeholder="选择或输入赛时标签"
      aria-label={`为 ${problem.problemKey} 选择赛时标签`}
      maxLength={MAX_TAG_LENGTH}
      tokenSeparators={[',', ' ']}
      maxTagCount="responsive"
      filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.trim().toLowerCase())}
      allowClear={false}
      suffixIcon={null}
    />
  </div>
}
