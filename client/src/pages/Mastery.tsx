import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Input,
  message,
  Progress,
  Row,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { StarOutlined, SearchOutlined, TrophyOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
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
  4: { color: '#52c41a', hint: 'AC 率高、题量充足，保持手感即可' },
  3: { color: '#1677ff', hint: '有一定积累，继续刷中高档题巩固' },
  2: { color: '#13c2c2', hint: '刚起步，建议配合模板课程系统练' },
  1: { color: '#faad14', hint: '只是碰到过，尽快回炉对应模板' },
  0: { color: '#bfbfbf', hint: '尚未通过任何题目 —— 练过没做出来的优先补，没碰过的从模板课开始' },
}

const LEVEL_ORDER = [4, 3, 2, 1, 0]

/** 升入下一档所需的通过题数（与后端 levelFor 阈值一致；4 = 满级） */
const NEXT_LEVEL_SOLVED: Record<number, number | null> = { 0: 1, 1: 5, 2: 10, 3: 20, 4: null }

/** localStorage：上次访问时各知识点的档位快照（用于检测「新达成」） */
const PREV_LEVELS_KEY = 'mastery-levels-prev'
/** localStorage：用户已点开看过的「新达成」知识点 */
const NEWLY_SEEN_KEY = 'mastery-newly-seen'

/** acRate / gap 与后端 rate() 同量纲：百分数（45.3 = 45.3%） */
function pct(v: number): string {
  return `${Math.round(v * 10) / 10}%`
}

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
  const nav = useNavigate()
  const [report, setReport] = useState<MasteryReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [onlyWeak, setOnlyWeak] = useState(false)
  /** 课程大纲里从未练过的知识点（0 提交、无关联题目）默认不进地图，避免淹没真实练习画像 */
  const [showUntouched, setShowUntouched] = useState(false)
  const [active, setActive] = useState<MasteryPoint | null>(null)
  /** 当前抽屉知识点的对应题目（null = 加载中） */
  const [tagProblems, setTagProblems] = useState<TagProblem[] | null>(null)
  /** 相对上次访问新升档的知识点（🎉 标记，点开抽屉后消失） */
  const [newly, setNewly] = useState<Set<string>>(new Set())

  // 切换知识点时拉取该标签对应的题目（服务端含同义英文别名命中，bank=1 含题库未做题）
  useEffect(() => {
    if (!active) return
    setTagProblems(null)
    get<TagProblem[]>(`/api/problems?tag=${encodeURIComponent(active.tag)}&bank=1`)
      .then((rows) => setTagProblems(rows.sort(byDifficultyAsc)))
      .catch(() => setTagProblems([]))
  }, [active])

  const load = useCallback(() => {
    setLoading(true)
    get<MasteryReport>('/api/stats/mastery')
      .then(setReport)
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [])

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

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin />
        </div>
      ) : total === 0 ? (
        <Card>
          <Empty description="还没有刷题数据 —— 先到「题目管理」同步或导入提交记录，掌握度会自动生成" />
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
                              {p.level === 4 && <TrophyOutlined style={{ color: '#faad14', marginInlineEnd: 4 }} />}
                              {p.level === 3 && <StarOutlined style={{ color: '#1677ff', marginInlineEnd: 4 }} />}
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
                                strokeColor={nextSolved === null ? '#faad14' : LEVEL_META[p.level].color}
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
                    ? { background: '#f6ffed', borderColor: '#b7eb8f' }
                    : { background: '#e6f4ff', borderColor: '#91caff' }
                }
              >
                <Space align="center">
                  {active.level === 4 ? (
                    <TrophyOutlined style={{ color: '#faad14', fontSize: 22 }} />
                  ) : (
                    <StarOutlined style={{ color: '#1677ff', fontSize: 22 }} />
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
              {tagProblems === null ? (
                <div style={{ textAlign: 'center', padding: 16 }}>
                  <Spin />
                </div>
              ) : tagProblems.length === 0 ? (
                <Space direction="vertical" size={4}>
                  <Typography.Text type="secondary">
                    题库里还没有该知识点的题目 —— 到「题目管理」同步提交记录或拉取题库（洛谷/牛客）后即可在这里练题
                  </Typography.Text>
                  <Button size="small" style={{ alignSelf: 'flex-start' }} onClick={() => nav('/problems')}>
                    去题目管理
                  </Button>
                </Space>
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
