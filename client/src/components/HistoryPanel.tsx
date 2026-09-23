/**
 * 写题历史查询面板（issue #19）：按平台/结果/时间/关键词查历史刷题记录。
 * 数据源为后端 submissions ⋈ problems（平台同步 / 导入写入），本面板只读。
 * 嵌在「数据概览」内，不单独占一个侧边栏板块。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, DatePicker, Input, Select, Table, Tag, Tooltip, Typography, App as AntdApp } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ClearOutlined, CheckOutlined, ReadOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS } from '../../../shared/src/index.ts'
import { del, get, post } from '../api'
import PlatformTag from './PlatformTag'
import { difficultyColor } from '../ui'

type View = 'problem' | 'submission'
type ResultFilter = 'all' | 'ac' | 'failed'

interface ProblemItem {
  problemId: number
  platform: PlatformId
  problemKey: string
  title: string
  difficulty: number | null
  url: string | null
  attempts: number
  acCount: number
  lastSubmittedAt: string
  /** 已在复习队列时为复习条目 id（用于移出），旧服务端可能缺省 */
  reviewItemId?: number | null
}

interface SubmissionItem {
  id: number
  platform: PlatformId
  problemKey: string
  title: string
  verdict: string
  language: string | null
  submittedAt: string
  url: string | null
  reviewItemId?: number | null
}

/** 两种视图的行形状不同，按视图各自取字段 */
type HistoryItem = Partial<ProblemItem & SubmissionItem>

interface PlatformAgg {
  platform: PlatformId
  platformName: string
  submissions: number
  problems: number
}

interface HistoryPage {
  view: View
  items: HistoryItem[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
  platforms: PlatformAgg[]
}

const PAGE_SIZE = 20

const VIEW_TABS: Array<{ key: View; label: string }> = [
  { key: 'problem', label: '按题目' },
  { key: 'submission', label: '逐条提交' },
]

const RESULT_TABS: Array<{ key: ResultFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'ac', label: 'AC' },
  { key: 'failed', label: '未通过' },
]

/** verdict 着色：AC 绿、跳过灰、其余红 */
function verdictColor(v: string): string {
  if (v === 'AC') return 'green'
  if (v === 'SKIPPED') return 'default'
  return 'red'
}

const fmtTime = (iso: string) => dayjs(iso).format('YYYY-MM-DD HH:mm')

const ProblemLink = ({ url, children }: { url?: string | null; children: ReactNode }) =>
  url ? <a href={url} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>

export default function HistoryPanel() {
  const { message } = AntdApp.useApp()
  const [view, setView] = useState<View>('problem')
  const [platform, setPlatform] = useState<PlatformId>()
  const [result, setResult] = useState<ResultFilter>('all')
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [q, setQ] = useState<string>()
  const [qInput, setQInput] = useState('')
  const [rows, setRows] = useState<HistoryItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [platforms, setPlatforms] = useState<PlatformAgg[]>([])
  const [loading, setLoading] = useState(false)

  const params = useMemo(() => {
    const p = new URLSearchParams()
    p.set('view', view)
    if (platform) p.set('platform', platform)
    if (result !== 'all') p.set('result', result)
    // 时间窗按「用户本地日界」下发为 ISO 时刻：表格里显示的是本地时间，
    // 若直发 YYYY-MM-DD 会被后端当 UTC 日界，本地 00:00–07:59 的提交会掉出所选当天
    if (range?.[0]) p.set('from', range[0].startOf('day').toISOString())
    if (range?.[1]) p.set('to', range[1].add(1, 'day').startOf('day').toISOString())
    if (q) p.set('q', q)
    return p
  }, [view, platform, result, range, q])

  // 只允许「最新一次请求」落地：连点筛选/翻页时会有多个请求在途，
  // 晚到的旧响应若照常写回，会把旧视图的行 + 它的 total/page 一起盖上去，
  // 且之后没有新请求来自愈纠正（界面就长期停在错的数据上）。
  const reqSeq = useRef(0)

  const load = useCallback(
    (nextPage: number) => {
      const seq = (reqSeq.current += 1)
      setLoading(true)
      // 切换视图时先清空：否则旧形状的行会套上新列，rowKey 撞车导致 DOM 残留
      setRows([])
      const p = new URLSearchParams(params)
      p.set('page', String(nextPage))
      p.set('pageSize', String(PAGE_SIZE))
      get<HistoryPage>(`/api/history/submissions?${p.toString()}`)
        .then((res) => {
          if (seq !== reqSeq.current) return
          setRows(res.items)
          setTotal(res.total)
          setPage(res.page)
          setPlatforms(res.platforms)
        })
        .catch((e: Error) => {
          if (seq === reqSeq.current) message.error(e.message)
        })
        .finally(() => {
          if (seq === reqSeq.current) setLoading(false)
        })
    },
    [params, message],
  )

  // 条件变化 → 回到第 1 页重新取数
  const queryKey = params.toString()
  useEffect(() => {
    load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey])

  const resetFilters = () => {
    setPlatform(undefined)
    setResult('all')
    setRange(null)
    setQ(undefined)
    setQInput('')
  }

  const addToReview = async (r: HistoryItem) => {
    try {
      await post('/api/reviews', { platform: r.platform, problemKey: r.problemKey })
      message.success(`「${r.problemKey}」已加入复习队列`)
      load(page)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeFromReview = async (r: HistoryItem) => {
    if (r.reviewItemId == null) return
    try {
      await del(`/api/reviews/${r.reviewItemId}`)
      message.success(`「${r.problemKey}」已移出复习队列`)
      load(page)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 复习队列按钮：已在队列显示绿色对勾（点击移出），否则书本图标（点击加入） */
  const reviewCell = (r: HistoryItem) =>
    r.reviewItemId != null ? (
      <Tooltip title="已加入复习队列，点击移出">
        <Button
          size="small"
          type="text"
          className="review-added-btn"
          icon={<CheckOutlined />}
          onClick={() => void removeFromReview(r)}
        />
      </Tooltip>
    ) : (
      <Tooltip title="加入复习队列（间隔复习）">
        <Button size="small" type="text" icon={<ReadOutlined />} onClick={() => void addToReview(r)} />
      </Tooltip>
    )

  const keyCell = (r: HistoryItem) => (
    <span className="mono">
      <ProblemLink url={r.url}>{r.problemKey}</ProblemLink>
    </span>
  )

  const problemCols: ColumnsType<HistoryItem> = [
    {
      title: '最近提交',
      dataIndex: 'lastSubmittedAt',
      width: 140,
      render: (v: string | undefined) => <span className="mono">{v ? fmtTime(v) : '-'}</span>,
    },
    { title: '平台', dataIndex: 'platform', width: 100, render: (v: PlatformId) => <PlatformTag id={v} /> },
    { title: '题号', dataIndex: 'problemKey', width: 120, render: (_v, r) => keyCell(r) },
    {
      title: '标题',
      dataIndex: 'title',
      ellipsis: true,
      render: (v: string, r) => <ProblemLink url={r.url}>{v}</ProblemLink>,
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 76,
      align: 'right',
      render: (v: number | null | undefined) =>
        v == null ? (
          <span style={{ color: 'var(--text-3)' }}>-</span>
        ) : (
          <span className="rating-pill mono" style={{ color: difficultyColor(v) }}>{v}</span>
        ),
    },
    {
      title: '提交/AC',
      key: 'counts',
      width: 92,
      align: 'right',
      render: (_v, r) => (
        <span>
          {r.attempts} / <span style={{ color: (r.acCount ?? 0) > 0 ? 'var(--green)' : undefined }}>{r.acCount ?? 0}</span>
        </span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 56,
      render: (_v, r) => reviewCell(r),
    },
  ]

  const submissionCols: ColumnsType<HistoryItem> = [
    {
      title: '时间',
      dataIndex: 'submittedAt',
      width: 140,
      render: (v: string | undefined) => <span className="mono">{v ? fmtTime(v) : '-'}</span>,
    },
    { title: '平台', dataIndex: 'platform', width: 100, render: (v: PlatformId) => <PlatformTag id={v} /> },
    { title: '题号', dataIndex: 'problemKey', width: 120, render: (_v, r) => keyCell(r) },
    { title: '标题', dataIndex: 'title', ellipsis: true },
    {
      title: '结果',
      dataIndex: 'verdict',
      width: 88,
      render: (v: string | undefined) => (v ? <Tag color={verdictColor(v)}>{v}</Tag> : '-'),
    },
    {
      title: '语言',
      dataIndex: 'language',
      width: 110,
      ellipsis: true,
      // 洛谷接口只给数字 langId（无公开名称字典），原样显示会被误读成语言名；
      // 带上 ".0" 尾巴的历史值同样要识别（迁移前的旧库、旧版桌面端写入）
      render: (v: string | null | undefined) =>
        v == null || v === '' ? (
          '-'
        ) : /^\d+(\.\d+)?$/.test(v) ? (
          <Tooltip title="洛谷接口只返回平台语言 ID，暂无 ID→语言名 的公开映射">
            <span style={{ color: 'var(--text-3)' }}>ID {v}</span>
          </Tooltip>
        ) : (
          v
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 56,
      render: (_v, r) => reviewCell(r),
    },
  ]

  return (
    <div className="history-panel">
      <div className="history-platform-bar">
        {platforms.length === 0 ? (
          <Typography.Text type="secondary">当前条件下没有写题记录</Typography.Text>
        ) : (
          platforms.map((p) => (
            <Tag
              key={p.platform}
              className={`history-platform-chip${platform === p.platform ? ' is-active' : ''}`}
              onClick={() => setPlatform(platform === p.platform ? undefined : p.platform)}
            >
              {p.platformName} · {p.problems} 题 / {p.submissions} 次
            </Tag>
          ))
        )}
      </div>

      <div className="filter-row">
        <div className="status-tabs">
          {VIEW_TABS.map((t) => (
            <button key={t.key} type="button" className={view === t.key ? 'is-active' : ''} onClick={() => setView(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="status-tabs">
          {RESULT_TABS.map((t) => (
            <button key={t.key} type="button" className={result === t.key ? 'is-active' : ''} onClick={() => setResult(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <Select
          allowClear
          placeholder="平台"
          style={{ width: 120 }}
          value={platform}
          onChange={setPlatform}
          options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))}
        />
        <DatePicker.RangePicker
          value={range as [Dayjs, Dayjs] | null}
          onChange={(v) => setRange(v && v[0] && v[1] ? [v[0], v[1]] : null)}
          allowClear
          placeholder={['开始日期', '结束日期']}
        />
        <Input.Search
          allowClear
          placeholder="搜索题号 / 标题"
          style={{ width: 180 }}
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          onSearch={(v) => setQ(v || undefined)}
        />
        <Button icon={<ClearOutlined />} onClick={resetFilters}>
          重置
        </Button>
      </div>

      <Table<HistoryItem>
        // rowKey 按数据自身形状派生（problem 行有 problemId，submission 行有 id），
        // 不依赖 view：视图切换瞬间旧行也不会与新行撞 key
        rowKey={(r) => (r.problemId != null ? `p-${r.problemId}` : `s-${r.id}`)}
        size="small"
        loading={loading}
        columns={view === 'problem' ? problemCols : submissionCols}
        dataSource={rows}
        // 逐条提交视图列宽合计约 764px，略放宽避免最后一列出横向滚动抖动
        scroll={{ x: view === 'problem' ? 760 : 820 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} ${view === 'problem' ? '题' : '条提交'}`,
          onChange: (next) => load(next),
        }}
        locale={{
          emptyText: (
            <div style={{ padding: '20px 0' }}>
              <p>没有匹配的写题记录。</p>
              <Typography.Text type="secondary">
                历史记录来自各平台同步或导入的提交数据，可在「题目管理 → 导入题目」中补充后再来查看。
              </Typography.Text>
            </div>
          ),
        }}
      />
    </div>
  )
}
