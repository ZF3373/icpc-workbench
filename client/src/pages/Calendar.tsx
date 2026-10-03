import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Calendar, Card, Col, Row, Space, Tag, App as AntdApp } from 'antd'
import { CheckOutlined, FieldTimeOutlined, FireOutlined, TrophyOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import StatStrip from '../components/StatStrip'
import CardSkeleton from '../components/CardSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import { get, post, del } from '../api'
import type { DayPlanInfo, DayTask, StreakInfo } from '../types'

const KIND_LABEL: Record<DayTask['kind'], string> = {
  practice: '练习',
  review: '回顾',
  topic: '专题',
  contest: '模拟赛',
}
const KIND_COLOR: Record<DayTask['kind'], string> = {
  practice: 'geekblue',
  review: 'purple',
  topic: 'cyan',
  contest: 'volcano',
}

export default function CalendarPage() {
  const { message } = AntdApp.useApp()
  const navigate = useNavigate()
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [monthData, setMonthData] = useState<Record<string, DayPlanInfo>>({})
  const [selected, setSelected] = useState(dayjs().format('YYYY-MM-DD'))
  const [tasks, setTasks] = useState<DayTask[]>([])
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [streak, setStreak] = useState<StreakInfo>({ current: 0, longest: 0, totalDays: 0 })
  /** 月历 / 当天任务各自的取数失败原因：失败不能伪装成「这天没有任务」 */
  const [monthError, setMonthError] = useState<string | null>(null)
  const [dayError, setDayError] = useState<string | null>(null)

  // 只认最新一次请求：快速切换月份/日期会有多个请求在途，旧响应晚到会盖掉新视图
  //（与 Today.tsx / HistoryPanel 的 reqSeq 护栏同款）
  const monthSeq = useRef(0)
  const loadMonth = useCallback((m: string) => {
    const seq = (monthSeq.current += 1)
    setMonthError(null)
    get<DayPlanInfo[]>(`/api/checkins?month=${m}`)
      .then((rows) => {
        if (seq !== monthSeq.current) return
        const map: Record<string, DayPlanInfo> = {}
        for (const r of rows) map[r.date] = r
        setMonthData(map)
      })
      .catch((e: Error) => {
        // 月历取不回来时格子里全成了「无任务」，只弹 toast 会让用户以为这个月真的没安排
        if (seq === monthSeq.current) setMonthError(e.message)
        message.error(e.message)
      })
  }, [])

  const daySeq = useRef(0)
  const loadDay = useCallback((d: string) => {
    const seq = (daySeq.current += 1)
    setLoadingTasks(true)
    setDayError(null)
    get<DayTask[]>(`/api/checkins/date/${d}`)
      .then((rows) => {
        if (seq !== daySeq.current) return
        setTasks(rows)
      })
      .catch((e: Error) => {
        // 同时清空 tasks：否则「上一天的任务」会留在卡片里，被当成这一天的安排
        if (seq === daySeq.current) {
          setDayError(e.message)
          setTasks([])
        }
        message.error(e.message)
      })
      .finally(() => {
        if (seq === daySeq.current) setLoadingTasks(false)
      })
  }, [])

  const loadStreak = useCallback(() => {
    get<StreakInfo>('/api/checkins/streak')
      .then(setStreak)
      .catch(() => undefined) // 统计失败不打扰打卡主流程
  }, [])

  useEffect(() => {
    loadMonth(month)
    loadStreak()
  }, [month, loadMonth, loadStreak])

  useEffect(() => {
    loadDay(selected)
  }, [selected, loadDay])

  const toggle = async (t: DayTask) => {
    try {
      if (t.checked) {
        await del(`/api/checkins/${t.id}`)
        message.success('已取消打卡')
      } else {
        await post('/api/checkins', { taskId: t.id })
        message.success('打卡成功 ✓')
      }
      loadDay(selected)
      loadMonth(month)
      loadStreak()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const today = dayjs().format('YYYY-MM-DD')

  // 本月全勤摘要（卡片头展示）
  const monthInfos = Object.values(monthData).filter((i) => i.total > 0)
  const doneDays = monthInfos.filter((i) => i.checked === i.total).length

  // 完成度圆环几何：r=15.5 在 36×36 视图里留出 stroke 呼吸空间
  const RING_R = 15.5
  const RING_CIRC = 2 * Math.PI * RING_R

  // fullCellRender(date, info) 的 info 用不上：本格子的日期/完成度全部来自 monthData
  const renderCell = (date: Dayjs) => {
    const key = date.format('YYYY-MM-DD')
    const info = monthData[key]
    const isSelected = key === selected
    const hasTasks = Boolean(info && info.total > 0)
    const done = hasTasks && info.checked === info.total
    const pct = hasTasks ? Math.round((info.checked / info.total) * 100) : 0
    // 有任务的日期弧线至少显示 8%：0/N 未开打也要有蓝色标识，否则与「无任务」无法区分
    const arcPct = done ? 100 : Math.max(pct, 8)
    const cellCls = [
      'calendar-cell',
      isSelected ? 'calendar-cell-selected' : '',
      done ? 'calendar-cell-done' : '',
      key === today ? 'calendar-today' : '',
      date.format('YYYY-MM') !== month ? 'calendar-cell-muted' : '',
    ]
      .filter(Boolean)
      .join(' ')
    return (
      <div className={cellCls} title={hasTasks ? `${info.checked}/${info.total} 已打卡` : undefined}>
        <span className="cell-ring-wrap">
          <svg className="cell-ring" viewBox="0 0 36 36" aria-hidden>
            <circle className="cell-ring-track" cx="18" cy="18" r={RING_R} />
            {hasTasks && (
              <circle
                className={`cell-ring-value${done ? ' cell-ring-done' : ''}`}
                cx="18"
                cy="18"
                r={RING_R}
                strokeDasharray={`${((arcPct / 100) * RING_CIRC).toFixed(2)} ${RING_CIRC.toFixed(2)}`}
              />
            )}
          </svg>
          <span className="cell-date">{date.date()}</span>
        </span>
        {hasTasks && (
          <span className="cell-count">
            {done && <span className="cell-count-check">✓ </span>}
            {info.checked}/{info.total}
          </span>
        )}
      </div>
    )
  }

  return (
    <div>
      <PageHeader title="日历打卡" description="每日训练打卡与连续记录" />
      <div style={{ marginBottom: 16 }}>
        <StatStrip
          items={[
            {
              label: '当前连续打卡',
              value: (
                <>
                  {streak.current}
                  <span className="stat-suffix">天</span>
                </>
              ),
              icon: <FireOutlined />,
              tone: 'amber',
            },
            {
              label: '最长连续打卡',
              value: (
                <>
                  {streak.longest}
                  <span className="stat-suffix">天</span>
                </>
              ),
              icon: <TrophyOutlined />,
              tone: 'violet',
            },
            {
              label: '累计打卡天数',
              value: (
                <>
                  {streak.totalDays}
                  <span className="stat-suffix">天</span>
                </>
              ),
              icon: <FieldTimeOutlined />,
              tone: 'green',
            },
          ]}
        />
      </div>
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            title="训练日历"
            extra={
              <span className="calendar-extra">
                点击日期查看当天计划并打卡 · 本月 <b>{doneDays}</b>/{monthInfos.length} 天全勤
              </span>
            }
            size="small"
          >
            {/* 月历取数失败：格子会全空，必须在日历上方说明，而不是让用户以为这个月没安排 */}
            {monthError && (
              <InlineError
                compact
                message={monthError}
                hint="本月打卡数据没能取回来，下面的日历暂不可信。"
                onRetry={() => loadMonth(month)}
              />
            )}
            <Calendar
              onSelect={(d: Dayjs) => setSelected(d.format('YYYY-MM-DD'))}
              onPanelChange={(d: Dayjs) => setMonth(d.format('YYYY-MM'))}
              /* antd 5 起 dateFullCellRender 已弃用（每次进日历页都刷一条控制台告警）。
                 官方迁移就是改名：fullCellRender(date, info) 直接接管整个「日」格子的内容，
                 与旧 dateFullCellRender(date) 的返回结构一致（仍是 .calendar-cell 那一层）。 */
              fullCellRender={renderCell}
            />
            <div className="calendar-legend" aria-hidden>
              <span>
                <i className="lg lg-none" />无任务
              </span>
              <span>
                <i className="lg lg-part" />进行中
              </span>
              <span>
                <i className="lg lg-done" />全部完成
              </span>
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title={`当天任务 · ${selected}`} size="small" style={{ minHeight: 360 }}>
            {loadingTasks ? (
              <CardSkeleton variant="list" rows={3} />
            ) : dayError ? (
              /* 失败 ≠ 没有任务：旧实现只弹 toast，列表保持上一次的数据（或空）→ 卡片会显示
                 「当天没有计划任务」这种不实结论。这里给明确的错误块 + 重试。 */
              <InlineError
                compact
                message={dayError}
                hint="这一天的任务清单没能取回来，重试即可。"
                onRetry={() => loadDay(selected)}
                retrying={loadingTasks}
              />
            ) : tasks.length === 0 ? (
              <EmptyState
                compact
                title="当天没有计划任务"
                description="训练计划里的任务会自动排到日期上。先去「训练计划」建一个计划，或看看今天的推荐题。"
                actions={[
                  { label: '去训练计划', type: 'primary', onClick: () => navigate('/plans') },
                  { label: '看今日训练', onClick: () => navigate('/today') },
                ]}
              />
            ) : (
              tasks.map((t) => {
                const link = t.problem_url ?? t.url
                const done = Boolean(t.checked)
                return (
                  <Card
                    key={t.id}
                    size="small"
                    className={`task-card task-card-${t.kind}${done ? ' task-done' : ''}`}
                    style={{ marginBottom: 8 }}
                    styles={{ body: { padding: 12 } }}
                  >
                    <div className="task-row">
                      <div className="task-main">
                        <Space size={8} wrap>
                          <Tag color={KIND_COLOR[t.kind]}>{KIND_LABEL[t.kind]}</Tag>
                          {link ? (
                            <a className="task-title" href={link} target="_blank" rel="noreferrer">
                              <b>{t.title}</b>
                            </a>
                          ) : (
                            <b className="task-title">{t.title}</b>
                          )}
                          {t.problem_key && <span className="task-key">{t.problem_key}</span>}
                        </Space>
                        {t.note && <p className="task-note">{t.note}</p>}
                        {link && (
                          <a className="task-link" href={link} target="_blank" rel="noreferrer">
                            {t.problem_title ?? '跳转做题'} ↗
                          </a>
                        )}
                      </div>
                      {done ? (
                        <Button size="small" icon={<CheckOutlined />} onClick={() => toggle(t)}>
                          已打卡
                        </Button>
                      ) : (
                        <Button size="small" type="primary" onClick={() => toggle(t)}>
                          打卡
                        </Button>
                      )}
                    </div>
                  </Card>
                )
              })
            )}
          </Card>
        </Col>
      </Row>
    </div>
  )
}
