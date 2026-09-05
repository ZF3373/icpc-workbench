import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Input,
  message,
  Row,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import { get } from '../api'
import { MASTERY_LEVEL_LABELS } from '../types'
import type { MasteryPoint, MasteryReport } from '../types'

/** 档位视觉（与 Dashboard 图表色系一致） */
const LEVEL_META: Record<number, { color: string; hint: string }> = {
  4: { color: '#52c41a', hint: 'AC 率高、题量充足，保持手感即可' },
  3: { color: '#1677ff', hint: '有一定积累，继续刷中高档题巩固' },
  2: { color: '#13c2c2', hint: '刚起步，建议配合模板课程系统练' },
  1: { color: '#faad14', hint: '只是碰到过，尽快回炉对应模板' },
  0: { color: '#bfbfbf', hint: '尚未通过任何题目 —— 练过没做出来的优先补，没碰过的从模板课开始' },
}

const LEVEL_ORDER = [4, 3, 2, 1, 0]

/** acRate / gap 与后端 rate() 同量纲：百分数（45.3 = 45.3%） */
function pct(v: number): string {
  return `${Math.round(v * 10) / 10}%`
}

export default function Mastery() {
  const nav = useNavigate()
  const [report, setReport] = useState<MasteryReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [onlyWeak, setOnlyWeak] = useState(false)
  const [active, setActive] = useState<MasteryPoint | null>(null)

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

  const points = report?.points ?? []
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
                    {list.map((p) => (
                      <Col key={p.tag} xs={12} md={8} xl={6}>
                        <button
                          type="button"
                          className="mastery-tag"
                          onClick={() => setActive(p)}
                          style={{ borderLeft: `3px solid ${LEVEL_META[p.level].color}` }}
                        >
                          <b>{p.tag}</b>
                          <span className="mastery-tag-meta">
                            {p.solved} 题 · {p.attempts > 0 ? pct(p.acRate) : '—'}
                            {p.templates.length > 0 && ` · 课 ×${p.templates.length}`}
                          </span>
                        </button>
                      </Col>
                    ))}
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
