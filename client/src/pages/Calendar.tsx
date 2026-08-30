import { useCallback, useEffect, useState } from 'react'
import { Button, Calendar, Card, Col, Empty, message, Row, Space, Spin, Tag } from 'antd'
import { CheckOutlined, FieldTimeOutlined, FireOutlined, TrophyOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import PageHeader from '../components/PageHeader'
import StatStrip from '../components/StatStrip'
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
  const [month, setMonth] = useState(dayjs().format('YYYY-MM'))
  const [monthData, setMonthData] = useState<Record<string, DayPlanInfo>>({})
  const [selected, setSelected] = useState(dayjs().format('YYYY-MM-DD'))
  const [tasks, setTasks] = useState<DayTask[]>([])
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [streak, setStreak] = useState<StreakInfo>({ current: 0, longest: 0, totalDays: 0 })

  const loadMonth = useCallback((m: string) => {
    get<DayPlanInfo[]>(`/api/checkins?month=${m}`)
      .then((rows) => {
        const map: Record<string, DayPlanInfo> = {}
        for (const r of rows) map[r.date] = r
        setMonthData(map)
      })
      .catch((e: Error) => message.error(e.message))
  }, [])

  const loadDay = useCallback((d: string) => {
    setLoadingTasks(true)
    get<DayTask[]>(`/api/checkins/date/${d}`)
      .then(setTasks)
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoadingTasks(false))
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

  const renderCell = (date: Dayjs) => {
    const key = date.format('YYYY-MM-DD')
    const info = monthData[key]
    const isSelected = key === selected
    const done = info && info.total > 0 && info.checked === info.total
    const pct = info && info.total > 0 ? Math.round((info.checked / info.total) * 100) : 0
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
      <div className={cellCls}>
        <span className="cell-date">{date.date()}</span>
        {info && info.total > 0 && (
          <span className="cell-foot" title={`${info.checked}/${info.total} 已打卡`}>
            <span className="cell-count">
              {info.checked}/{info.total}
            </span>
            <span className="cell-bar">
              <i style={{ width: `${pct}%` }} />
            </span>
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
          <Card title="训练日历 —— 点击日期查看当天计划并打卡" size="small">
            <Calendar
              onSelect={(d: Dayjs) => setSelected(d.format('YYYY-MM-DD'))}
              onPanelChange={(d: Dayjs) => setMonth(d.format('YYYY-MM'))}
              dateFullCellRender={renderCell}
            />
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card title={`当天任务 · ${selected}`} size="small" style={{ minHeight: 360 }}>
            {loadingTasks ? (
              <Spin style={{ display: 'block', margin: '40px auto' }} />
            ) : tasks.length === 0 ? (
              <Empty description="当天没有计划任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
