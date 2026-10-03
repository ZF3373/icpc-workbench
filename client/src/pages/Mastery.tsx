import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Drawer,
  Input,
  Progress,
  Row,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { StarOutlined, SearchOutlined, TrophyOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import PageSkeleton from '../components/PageSkeleton'
import CardSkeleton from '../components/CardSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import AccountScopePicker from '../components/AccountScopePicker'
import { useAccountScope, withScope } from '../accountScope'
import { pct } from '../ui'
import { get } from '../api'
import { MASTERY_LEVEL_LABELS } from '../types'
import type { MasteryPoint, MasteryReport } from '../types'

/** Drawer 内「对应题目」列表的行（GET /api/problems?tag= 的返回结构子集） */
interface TagProblem {
  problem_key: string
  platform: string
  title: string
  difficulty: number | null
  url: string | null
  status: 'ac' | 'tried' | 'none'
}

/** Drawer 内最多展示的题目条数（全量在题目管理按标签查看） */
const DRAWER_PROBLEM_LIMIT = 12

/** 题目行按难度升序（从可练的简单题开始），未知难度排最后 */
function byDifficultyAsc(a: TagProblem, b: TagProblem): number {
  if (a.difficulty === null && b.difficulty === null) return 0
  if (a.difficulty === null) return 1
  if (b.difficulty === null) return -1
  return a.difficulty - b.difficulty
}

const PROBLEM_STATUS_META: Record<TagProblem['status'], { color: string; label: string }> = {
  ac: { color: 'success', label: '已AC' },
  tried: { color: 'warning', label: '尝试过' },
  none: { color: 'default', label: '未做' },
}

/** 档位视觉（与 Dashboard 图表色系一致） */
const LEVEL_META: Record<number, { color: string; hint: string }> = {
  4: { color: 'var(--green)', hint: 'AC 率高、题量充足，保持手感即可' },
  3: { color: 'var(--blue)', hint: '有一定积累，继续刷中高档题巩固' },
  2: { color: 'var(--cyan)', hint: '刚起步，建议配合模板课程系统练' },
  1: { color: 'var(--amber)', hint: '只是碰到过，尽快回炉对应模板' },
  0: { color: 'var(--text-3)', hint: '尚未通过任何题目 —— 练过没做出来的优先补，没碰过的从模板课开始' },
}

const LEVEL_ORDER = [4, 3, 2, 1, 0]

/** 升入下一档所需的通过题数（与后端 levelFor 阈值一致；4 = 满级） */
const NEXT_LEVEL_SOLVED: Record<number, number | null> = { 0: 1, 1: 5, 2: 10, 3: 20, 4: null }

/** localStorage：上次访问时各知识点的档位快照（用于检测「新达成」） */
const PREV_LEVELS_KEY = 'mastery-levels-prev'
/** localStorage：用户已点开看过的「新达成」知识点 */
const NEWLY_SEEN_KEY = 'mastery-newly-seen'

// acRate / gap 的单位约定（百分数，非比例，与后端 rate() 同量纲）与格式化统一在
// client/src/ui.ts 的 pct()：这里不再各留一份实现——历史上正是"各写一份"让设置页把
// 已经是百分数的 acRate/gap 又乘了一次 100，显示成 1430% / 4330.0%。

/** 读取 localStorage 中的 JSON（不可用时返回 null，调用方静默降级） */
function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export default function Mastery() {
  // React 19 下 antd 静态 message 静默失效，必须用 App 上下文实例
  const { message } = AntdApp.useApp()
  const nav = useNavigate()
  /** 账号视角：与数据概览共用同一个 localStorage 值 */
  const [scope, setScope] = useAccountScope()
  const [report, setReport] = useState<MasteryReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [onlyWeak, setOnlyWeak] = useState(false)
  /** 课程大纲里从未练过的知识点（0 提交、无关联题目）默认不进地图，避免淹没真实练习画像 */
  const [showUntouched, setShowUntouched] = useState(false)
  const [active, setActive] = useState<MasteryPoint | null>(null)
  /** 当前抽屉知识点的对应题目（null = 加载中） */
  const [tagProblems, setTagProblems] = useState<TagProblem[] | null>(null)
  /**
   * 抽屉「对应题目」的取数失败原因。
   * 旧实现是 `.catch(() => setTagProblems([]))` —— 把请求失败伪装成「题库里还没有该知识点的题目」，
   * 用户会以为自己真的没题可练，实际只是这次查询挂了。失败与空必须分开。
   */
  const [tagError, setTagError] = useState<string | null>(null)
  /** 抽屉内「重试」的触发器：effect 依赖 active，重试同一知识点需要额外一次自增 */
  const [tagRetry, setTagRetry] = useState(0)
  /** 相对上次访问新升档的知识点（🎉 标记，点开抽屉后消失） */
  const [newly, setNewly] = useState<Set<string>>(new Set())

  // 切换知识点时拉取该标签对应的题目（服务端含同义英文别名命中，bank=1 含题库未做题）
  // 只认最后一次切换的结果：切走后旧请求返回不得再写 tagProblems（否则显示成上一个知识点的题）
  useEffect(() => {
    if (!active) return
    let current = true
    setTagProblems(null)
    setTagError(null)
    get<TagProblem[]>(`/api/problems?tag=${encodeURIComponent(active.tag)}&bank=1`)
      .then((rows) => {
        if (!current) return
        setTagProblems(rows.sort(byDifficultyAsc))
        setTagError(null)
      })
      .catch((e: Error) => {
        if (!current) return
        setTagError(e.message)
        setTagProblems([])
      })
    return () => {
      current = false
    }
  }, [active, tagRetry])

  // 只允许「最新一次请求」落地：切换账号视角时旧 scope 的慢响应会晚到盖掉新数据。
  const reqSeq = useRef(0)

  const load = useCallback(() => {
    const seq = (reqSeq.current += 1)
    setLoading(true)
    setLoadError(null)
    get<MasteryReport>(withScope('/api/stats/mastery', scope))
      .then((r) => {
        if (seq !== reqSeq.current) return
        setReport(r)
        setLoadError(null)
      })
      // 失败 ≠ 没有数据：掌握度是重查询、最容易超时。旧实现只弹一个 toast，report 仍是 null，
      // 渲染分支于是把「请求失败」当成「还没有刷题数据 —— 去题目管理」，等于告诉有几千条
      // 提交的用户「你没有记录」。这里落到 loadError，由 InlineError 出错误态 + 重试。
      .catch((e: Error) => {
        if (seq !== reqSeq.current) return
        setLoadError(e.message)
        setReport(null)
        message.error(e.message)
      })
      .finally(() => {
        if (seq === reqSeq.current) setLoading(false)
      })
  }, [message, scope])

  useEffect(() => {
    load()
  }, [load])

  // 与上次访问的档位快照对比，标记新升档的知识点；随后写入本次快照。
  // 首次访问（无快照）不庆祝，避免满屏 🎉 稀释反馈。
  useEffect(() => {
    if (!report) return
    const cur: Record<string, number> = {}
    for (const p of report.points) cur[p.tag] = p.level
    const prev = readJson<Record<string, number>>(PREV_LEVELS_KEY)
    if (prev) {
      const seen = new Set(readJson<string[]>(NEWLY_SEEN_KEY) ?? [])
      const fresh: string[] = []
      for (const [tag, lv] of Object.entries(cur)) {
        if (lv > 0 && lv > (prev[tag] ?? 0) && !seen.has(tag)) fresh.push(tag)
      }
      setNewly(new Set(fresh))
    }
    try {
      localStorage.setItem(PREV_LEVELS_KEY, JSON.stringify(cur))
    } catch {
      /* 存储不可用时跳过持久化，仅本次会话内生效 */
    }
  }, [report])

  /** 点开抽屉即视为已知晓该「新达成」 */
  const markNewlySeen = useCallback((tag: string) => {
    setNewly((s) => {
      if (!s.has(tag)) return s
      const next = new Set(s)
      next.delete(tag)
      return next
    })
    try {
      const seen = new Set(readJson<string[]>(NEWLY_SEEN_KEY) ?? [])
      seen.add(tag)
      // 防止 seen 集合无限增长：超过上限时重置（误重置的代价只是多显示一次 🎉）
      localStorage.setItem(NEWLY_SEEN_KEY, JSON.stringify(seen.size > 500 ? [tag] : [...seen]))
    } catch {
      /* 忽略 */
    }
  }, [])

  const points = useMemo(
    () => (report?.points ?? []).filter((p) => showUntouched || p.attempts > 0),
    [report, showUntouched],
  )
  const untouchedCount = (report?.points ?? []).length - points.length
  const byLevel = useMemo(() => {
    const map = new Map<number, MasteryPoint[]>()
    for (const p of points) {
      if (onlyWeak && !(p.gap >= 2 && p.attempts >= 5)) continue
      const list = map.get(p.level) ?? []
      list.push(p)
      map.set(p.level, list)
    }
    return map
  }, [points, onlyWeak])

  const matched = (p: MasteryPoint): boolean => !q || p.tag.toLowerCase().includes(q.toLowerCase())

  const total = points.length
  const masteredCount = points.filter((p) => p.level >= 3).length

  return (
    <div>
      <PageHeader
        title="掌握度地图"
        description="把刷题记录、弱项画像与模板课程串成一张图 —— 每个知识点的题量、AC 率与对应课程，点开直达模板库"
        extra={
          <Space wrap>
            <AccountScopePicker value={scope} onChange={setScope} />
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索知识点"
              style={{ width: 180 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Space size={4}>
              <Typography.Text type="secondary">只看弱项</Typography.Text>
              <Switch size="small" checked={onlyWeak} onChange={setOnlyWeak} />
            </Space>
            {untouchedCount > 0 && (
              <Tooltip title="课程大纲涉及、但还没有做过任何题的知识点（学习盲区）">
                <Space size={4}>
                  <Typography.Text type="secondary">显示未练习（{untouchedCount}）</Typography.Text>
                  <Switch size="small" checked={showUntouched} onChange={setShowUntouched} />
                </Space>
              </Tooltip>
            )}
          </Space>
        }
      />

      {/* 首屏骨架：页面真实结构是「统计带（知识点/档位计数）→ 若干张档位卡片」，
          所以 stats 保留、用 4 个中等高度的块占位档位卡；比整页居中转圈少一次布局跳动。
          这里不像 Problems/Contests 那样卡 `!report`：本页没有「点一下就静默重拉」的局部动作，
          load() 只由挂载 / 换账号视角 / 重试触发，而这三种情况下屏上的旧地图都属于另一个数据口径，
          盖住它比继续展示更诚实（与 Dashboard 的 `if (loading) return <PageSkeleton />` 同判） */}
      {loading ? (
        <PageSkeleton blocks={4} blockHeight={140} />
      ) : loadError ? (
        /* 失败 ≠ 空态：接口失败时给可重试的错误态，而不是「还没有刷题数据」 */
        <InlineError
          message={loadError}
          hint="这块本来显示的是你的知识点掌握度地图（题量、AC 率与关联模板课程）"
          onRetry={load}
          retrying={loading}
        />
      ) : total === 0 ? (
        <Card>
          {untouchedCount > 0 ? (
            /* 「有数据却显示空」：知识点全是课程大纲里没练过的，被默认开关藏起来了。
               这里的出路不是让用户去同步（他本来就有数据），而是把隐藏的部分显示出来 */
            <EmptyState
              title="暂无可展示的练习画像"
              description={`${untouchedCount} 个知识点都还没有提交记录，默认不显示以免淹没真实画像。打开「显示未练习」即可看到课程大纲里的这些学习盲区。`}
              actions={[
                { label: `显示未练习（${untouchedCount}）`, type: 'primary', onClick: () => setShowUntouched(true) },
                { label: '去题目管理刷题', type: 'default', onClick: () => nav('/problems') },
              ]}
            />
          ) : (
            /* description 只解释「为什么是空的」，出路交给两个真按钮（旧实现只有一句文字指引） */
            <EmptyState
              title="还没有刷题数据"
              description="掌握度由已同步的提交记录推导。绑定平台账号同步数据，或到题目管理手动导入后，知识点地图会自动生成。"
              actions={[
                { label: '去题目管理', type: 'primary', onClick: () => nav('/problems') },
                { label: '去设置绑定账号', type: 'default', onClick: () => nav('/settings') },
              ]}
            />
          )}
        </Card>
      ) : (
        <>
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space wrap size="large">
              <Typography.Text strong>知识点 {total}</Typography.Text>
              {LEVEL_ORDER.map((lv) => {
                const n = points.filter((p) => p.level === lv).length
                return (
                  <span key={lv}>
                    <Tag color={LEVEL_META[lv].color}>{MASTERY_LEVEL_LABELS[lv as 0 | 1 | 2 | 3 | 4]}</Tag>
                    <Typography.Text strong>{n}</Typography.Text>
                  </span>
                )
              })}
              <Typography.Text type="secondary">
                {masteredCount > 0 && '🏆 '}
                达到「掌握」及以上 {masteredCount} 个（{pct(masteredCount / total)}）
              </Typography.Text>
            </Space>
          </Card>

          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {LEVEL_ORDER.map((lv) => {
              const list = (byLevel.get(lv) ?? []).filter(matched)
              if (list.length === 0) return null
              return (
                <Card
                  key={lv}
                  size="small"
                  title={
                    <Space>
                      <Tag color={LEVEL_META[lv].color}>{MASTERY_LEVEL_LABELS[lv as 0 | 1 | 2 | 3 | 4]}</Tag>
                      <Typography.Text type="secondary">{LEVEL_META[lv].hint}</Typography.Text>
                    </Space>
                  }
                >
                  <Row gutter={[8, 8]}>
                    {list.map((p) => {
                      const nextSolved = NEXT_LEVEL_SOLVED[p.level]
                      const nextLabel = MASTERY_LEVEL_LABELS[Math.min(4, p.level + 1) as 0 | 1 | 2 | 3 | 4]
                      const progress = nextSolved === null ? 100 : Math.min(100, (p.solved / nextSolved) * 100)
                      return (
                        <Col key={p.tag} xs={12} md={8} xl={6}>
                          <button
                            type="button"
                            className="mastery-tag"
                            onClick={() => {
                              setActive(p)
                              markNewlySeen(p.tag)
                            }}
                            style={{ borderLeft: `3px solid ${LEVEL_META[p.level].color}` }}
                          >
                            <b>
                              {p.level === 4 && <TrophyOutlined style={{ color: 'var(--amber)', marginInlineEnd: 4 }} />}
                              {p.level === 3 && <StarOutlined style={{ color: 'var(--blue)', marginInlineEnd: 4 }} />}
                              {p.tag}
                              {newly.has(p.tag) && <span style={{ marginInlineStart: 4 }}>🎉</span>}
                            </b>
                            <span className="mastery-tag-meta">
                              {p.solved} 题 · {p.attempts > 0 ? pct(p.acRate) : '—'}
                              {p.templates.length > 0 && ` · 课 ×${p.templates.length}`}
                            </span>
                            <span
                              title={
                                nextSolved === null
                                  ? '已达最高档「熟练」'
                                  : `距离「${nextLabel}」还差 ${Math.max(0, nextSolved - p.solved)} 题（${p.solved}/${nextSolved}）`
                              }
                            >
                              <Progress
                                percent={progress}
                                size="small"
                                showInfo={false}
                                strokeColor={nextSolved === null ? 'var(--amber)' : LEVEL_META[p.level].color}
                                style={{ margin: 0, lineHeight: 1 }}
                              />
                            </span>
                          </button>
                        </Col>
                      )
                    })}
                  </Row>
                </Card>
              )
            })}
          </Space>
        </>
      )}

      <Drawer
        open={!!active}
        onClose={() => setActive(null)}
        width={480}
        title={active ? <Tag color={LEVEL_META[active.level].color}>{active.tag}</Tag> : null}
      >
        {active && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {/* 掌握/熟练的庆祝横幅：肯定已达成的努力，给继续刷下去的正反馈 */}
            {active.level >= 3 && (
              <Card
                size="small"
                style={
                  active.level === 4
                    ? { background: 'var(--green-soft)', borderColor: 'var(--green-line)' }
                    : { background: 'var(--brand-soft)', borderColor: 'var(--brand-line)' }
                }
              >
                <Space align="center">
                  {active.level === 4 ? (
                    <TrophyOutlined style={{ color: 'var(--amber)', fontSize: 22 }} />
                  ) : (
                    <StarOutlined style={{ color: 'var(--blue)', fontSize: 22 }} />
                  )}
                  <Space direction="vertical" size={0}>
                    <b>{active.level === 4 ? '🏆 熟练掌握！' : '🎖 已掌握！'}</b>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {active.solved} 题通过 · AC 率 {pct(active.acRate)}
                      {active.level === 4
                        ? ' —— 已是你的稳定得分项，定期保持手感即可'
                        : ` —— 距「熟练」还差 ${Math.max(0, 20 - active.solved)} 题，继续冲`}
                    </Typography.Text>
                  </Space>
                </Space>
              </Card>
            )}

            <Card size="small">
              <Space wrap size="large">
                <span>
                  通过 <b>{active.solved}</b> 题
                </span>
                <span>
                  提交 <b>{active.attempts}</b> 次
                </span>
                <span>
                  AC 率 <b>{active.attempts > 0 ? pct(active.acRate) : '—'}</b>
                </span>
                <span>
                  近 8 周 <b>{active.recentSolved}</b> 题
                </span>
              </Space>
              {active.attempts >= 5 && (
                <div style={{ marginTop: 8 }}>
                  {active.gap >= 2 ? (
                    <Typography.Text type="danger">
                      低于你自身平均 AC 率（{pct(active.avgAcRate)}）约 {pct(active.gap)} —— 建议优先补强
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">不低于自身平均 AC 率（{pct(active.avgAcRate)}）</Typography.Text>
                  )}
                </div>
              )}
            </Card>

            <Card
              size="small"
              title="对应题目"
              extra={
                tagProblems && tagProblems.length > 0 ? (
                  <Button type="link" size="small" onClick={() => nav(`/problems?tag=${encodeURIComponent(active.tag)}`)}>
                    查看全部（{tagProblems.length}）
                  </Button>
                ) : undefined
              }
            >
              {tagError ? (
                /* 失败 ≠ 空：这块本来显示的是该知识点在题库里的对应题目 */
                <InlineError
                  compact
                  message={tagError}
                  hint="这块本来显示的是该知识点在题库里的对应题目（含题库未做题）。"
                  onRetry={() => setTagRetry((n) => n + 1)}
                />
              ) : tagProblems === null ? (
                <CardSkeleton variant="list" rows={3} />
              ) : tagProblems.length === 0 ? (
                <EmptyState
                  compact
                  title="题库里还没有该知识点的题目"
                  description="到「题目管理」同步提交记录，或拉取题库（洛谷/牛客）后，这里就能直接点开练题。"
                  action={{ label: '去题目管理', type: 'primary', onClick: () => nav('/problems') }}
                />
              ) : (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {tagProblems.slice(0, DRAWER_PROBLEM_LIMIT).map((p) => (
                    <Button
                      key={`${p.platform}:${p.problem_key}`}
                      type="text"
                      block
                      style={{ justifyContent: 'flex-start', padding: '4px 8px', height: 'auto' }}
                      disabled={!p.url}
                      onClick={() => p.url && window.open(p.url, '_blank')}
                    >
                      <Space wrap size={8}>
                        <Tag color={PROBLEM_STATUS_META[p.status].color} style={{ marginInlineEnd: 0 }}>
                          {PROBLEM_STATUS_META[p.status].label}
                        </Tag>
                        <span>
                          {p.problem_key} · {p.title}
                        </span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {p.difficulty ?? '难度未知'}
                        </Typography.Text>
                      </Space>
                    </Button>
                  ))}
                  {tagProblems.length > DRAWER_PROBLEM_LIMIT && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      仅显示难度最低的 {DRAWER_PROBLEM_LIMIT} 题，其余在题目管理查看
                    </Typography.Text>
                  )}
                </Space>
              )}
            </Card>

            <Card size="small" title="关联模板课程">
              {active.templates.length === 0 ? (
                <Typography.Text type="secondary">课程大纲中没有直接关联该标签的模板</Typography.Text>
              ) : (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {active.templates.map((t) => (
                    <Button
                      key={t.id}
                      type="text"
                      style={{ justifyContent: 'flex-start', padding: '4px 8px', height: 'auto' }}
                      onClick={() => nav('/templates')}
                      block
                    >
                      <Space wrap>
                        {t.status === 'mastered' ? (
                          <Tag color="success">已掌握</Tag>
                        ) : t.status === 'learning' ? (
                          <Tag color="processing">学习中</Tag>
                        ) : (
                          <Tag>未学</Tag>
                        )}
                        <span>{t.name}</span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t.categoryName}
                        </Typography.Text>
                      </Space>
                    </Button>
                  ))}
                </Space>
              )}
            </Card>

            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              掌握度由练习数据推导：1 题接触 → 5 题入门 → 10 题掌握 → 20 题 + AC 率 70% 熟练；与模板学习状态互相独立。
            </Typography.Text>
          </Space>
        )}
      </Drawer>
    </div>
  )
}
