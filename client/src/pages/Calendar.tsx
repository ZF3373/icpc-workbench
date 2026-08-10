import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Calendar, Card, Col, Empty, message, Row, Spin, Tag } from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { get, post, del } from '../api'
import type { DayPlanInfo, DayTask } from '../types'

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

  useEffect(() => {
    loadMonth(month)
  }, [month, loadMonth])

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
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const renderCell = (date: Dayjs) => {
    const key = date.format('YYYY-MM-DD')
    const info = monthData[key]
    const isSelected = key === selected
    const done = info && info.total > 0 && info.checked === info.total
    return (
      <div
        style={{
          padding: 6,
          height: '100%',
          borderRadius: 8,
          background: isSelected ? '#e6f4ff' : undefined,
          cursor: 'pointer',
        }}
      >
        <div style={{ fontWeight: isSelected ? 600 : 400 }}>{date.date()}</div>
        {info && info.total > 0 && (
          <div style={{ marginTop: 4 }}>
            <Badge
              count={info.checked}
              showZero
              color={done ? 'green' : 'orange'}
              title={`${info.checked}/${info.total} 已打卡`}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <Row gutter={[16, 16]}>
      <Col span={16}>
        <Card title="训练日历 —— 点击日期查看当天计划并打卡" size="small">
          <Calendar
            onSelect={(d: Dayjs) => setSelected(d.format('YYYY-MM-DD'))}
            onPanelChange={(d: Dayjs) => setMonth(d.format('YYYY-MM'))}
            dateFullCellRender={renderCell}
          />
        </Card>
      </Col>
      <Col span={8}>
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
                <Card key={t.id} size="small" style={{ marginBottom: 8 }} styles={{ body: { padding: 12 } }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <Tag color={KIND_COLOR[t.kind]}>{KIND_LABEL[t.kind]}</Tag>
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer">
                          <b>{t.title}</b>
                        </a>
                      ) : (
                        <b>{t.title}</b>
                      )}
                      {t.problem_key && <Tag style={{ marginLeft: 4 }}>{t.problem_key}</Tag>}
                    </div>
                    <Button size="small" type={done ? 'default' : 'primary'} onClick={() => toggle(t)}>
                      {done ? '已打卡 ✓' : '打卡'}
                    </Button>
                  </div>
                  {link && (
                    <div style={{ marginTop: 8 }}>
                      <a href={link} target="_blank" rel="noreferrer">
                        {t.problem_title ?? '跳转做题'} ↗
                      </a>
                    </div>
                  )}
                  {t.note && <p style={{ marginTop: 8, marginBottom: 0, color: '#888', fontSize: 12 }}>{t.note}</p>}
                </Card>
              )
            })
          )}
        </Card>
      </Col>
    </Row>
  )
}
