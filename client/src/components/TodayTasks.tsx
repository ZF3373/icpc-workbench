import { Button, Card, Space, Tag } from 'antd'
import { Link } from 'react-router-dom'
import { CheckOutlined } from '@ant-design/icons'
import type { TodayPlanTask } from '../../../shared/src/index.ts'

const KINDS = [
  { kind: 'review', label: '回顾', color: 'gold' },
  { kind: 'practice', label: '练习', color: 'geekblue' },
  { kind: 'topic', label: '专题', color: 'cyan' },
  { kind: 'contest', label: '模拟赛', color: 'volcano' },
] as const

export default function TodayTasks({ tasks, busyIds, onToggle, onConfirmAc }: {
  tasks: TodayPlanTask[]
  busyIds: Set<number>
  onToggle: (task: TodayPlanTask) => void
  onConfirmAc: () => void
}) {
  const ready = tasks.filter((t) => !t.checked && t.kind === 'practice' && t.solvedToday)
  return (
    <Card
      title="今日计划任务"
      size="small"
      style={{ marginBottom: 16 }}
      extra={<Link to="/plans">管理计划 →</Link>}
    >
      {ready.length > 0 && (
        <Button
          type="primary"
          onClick={onConfirmAc}
          style={{ marginBottom: 12 }}
          icon={<CheckOutlined />}
        >
          确认 {ready.length} 项已 AC 任务并打卡
        </Button>
      )}
      {tasks.length === 0 ? (
        <p style={{ color: 'var(--text-3)' }}>
          今天暂无计划任务。<Link to="/plans">生成训练计划</Link>，或从下方推荐开始练习。
        </p>
      ) : (
        KINDS.map(({ kind, label, color }) => {
          const group = tasks.filter((t) => t.kind === kind)
          if (group.length === 0) return null
          const checkedCount = group.filter((t) => t.checked).length
          const allChecked = checkedCount === group.length
          return (
            <div key={kind} className="today-task-group">
              <div className="today-task-group-header">
                <span className="today-task-group-label">
                  <Tag color={color} style={{ fontSize: 11, margin: 0, lineHeight: '18px' }}>
                    {label}
                  </Tag>
                  <span style={{ color: allChecked ? 'var(--green)' : 'var(--text-2)' }}>
                    {allChecked ? '已完成' : `${checkedCount}/${group.length} 已打卡`}
                  </span>
                </span>
                {allChecked && <CheckOutlined style={{ color: 'var(--green)', fontSize: 12 }} />}
              </div>
              {group.map((t) => {
                const url = t.problem_url ?? t.url
                return (
                  <Card
                    key={t.id}
                    size="small"
                    className={`task-card task-card-${t.kind}${t.checked ? ' task-done' : ''}`}
                    style={{ marginBottom: 6 }}
                  >
                    <div className="task-row card-actions-row">
                      <div className="task-main">
                        <Space wrap size={6}>
                          {url ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              <b>{t.title} ↗</b>
                            </a>
                          ) : (
                            <b>{t.title}</b>
                          )}
                          {t.problem_key && <span className="task-key">{t.problem_key}</span>}
                          {t.solvedToday && t.kind === 'practice' && (
                            <Tag color="green" style={{ fontSize: 11, margin: 0 }}>
                              今日已 AC
                            </Tag>
                          )}
                        </Space>
                        <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 3 }}>
                          {t.plan_title}
                        </div>
                        {t.note && <p className="task-note">{t.note}</p>}
                      </div>
                      <Button
                        size="small"
                        type={t.checked ? 'default' : 'primary'}
                        icon={t.checked ? <CheckOutlined /> : undefined}
                        loading={busyIds.has(t.id)}
                        onClick={() => onToggle(t)}
                      >
                        {t.checked ? '取消' : '打卡'}
                      </Button>
                    </div>
                  </Card>
                )
              })}
            </div>
          )
        })
      )}
    </Card>
  )
}
