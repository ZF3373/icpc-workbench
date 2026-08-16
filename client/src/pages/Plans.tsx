import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd'
import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import type { ColumnsType } from 'antd/es/table'
import PageHeader from '../components/PageHeader'
import { del, get, patch, post } from '../api'
import type { GenerateResult, PlanDetail, PlanListItem, PlanTask } from '../types'

function sourceTag(s: PlanListItem['source']) {
  if (s === 'ai') return <Tag className="ai-tag-shimmer">AI</Tag>
  if (s === 'template') return <Tag color="orange">模板</Tag>
  return <Tag>手动</Tag>
}

function kindTag(k: PlanTask['kind']) {
  const color = { practice: 'geekblue', review: 'purple', topic: 'cyan', contest: 'volcano' }[k]
  const label = { practice: '练习', review: '回顾', topic: '专题', contest: '模拟赛' }[k]
  return <Tag color={color}>{label}</Tag>
}

const KIND_OPTIONS = [
  { value: 'practice', label: '练习' },
  { value: 'review', label: '回顾' },
  { value: 'topic', label: '专题' },
  { value: 'contest', label: '模拟赛' },
]

export default function Plans() {
  const [plans, setPlans] = useState<PlanListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [genOpen, setGenOpen] = useState(false)
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [editing, setEditing] = useState<PlanTask | null>(null)
  const [editForm] = Form.useForm()
  const [genForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    get<PlanListItem[]>('/api/plans')
      .then(setPlans)
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openDetail = async (id: number) => {
    try {
      const d = await get<PlanDetail>(`/api/plans/${id}`)
      setDetail(d)
      setDetailOpen(true)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const toggleCheckin = async (task: PlanTask) => {
    try {
      if (task.checked) {
        await del(`/api/checkins/${task.id}`)
      } else {
        await post('/api/checkins', { taskId: task.id })
      }
      if (detail) openDetail(detail.id)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removePlan = async (id: number) => {
    try {
      await del(`/api/plans/${id}`)
      message.success('计划已删除')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const openEdit = (t: PlanTask) => {
    setEditing(t)
    editForm.setFieldsValue({
      taskDate: dayjs(t.task_date),
      title: t.title,
      kind: t.kind,
      url: t.url ?? '',
      note: t.note ?? '',
    })
  }

  const submitEdit = async () => {
    if (!editing) return
    const v = (await editForm.validateFields().catch(() => null)) as unknown as {
      taskDate: Dayjs
      title: string
      kind: PlanTask['kind']
      url: string
      note: string
    } | null
    if (!v) return
    try {
      await patch(`/api/plans/tasks/${editing.id}`, {
        taskDate: v.taskDate.format('YYYY-MM-DD'),
        title: v.title,
        kind: v.kind,
        url: v.url || null, // 留空即清除
        note: v.note || null,
      })
      message.success('任务已更新')
      setEditing(null)
      if (detail) openDetail(detail.id)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeTask = async (t: PlanTask) => {
    try {
      await del(`/api/plans/tasks/${t.id}`)
      message.success('任务已删除')
      if (detail) openDetail(detail.id)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const cols: ColumnsType<PlanListItem> = [
    {
      title: '计划',
      dataIndex: 'title',
      render: (v: string, r) => <a onClick={() => openDetail(r.id)}>{v}</a>,
    },
    { title: '来源', dataIndex: 'source', width: 80, render: (v: PlanListItem['source']) => sourceTag(v) },
    { title: '周期', width: 210, render: (_v, r) => <span className="mono">{r.start_date} ~ {r.end_date}</span> },
    { title: '进度', width: 160, render: (_v, r) => <Progress className="gradient-progress" percent={r.task_count ? Math.round((r.checked_count / r.task_count) * 100) : 0} size="small" /> },
    { title: '任务', dataIndex: 'task_count', width: 70, align: 'right', render: (_v, r) => <span className="mono">{r.checked_count}/{r.task_count}</span> },
    {
      title: '操作',
      width: 80,
      render: (_v, r) => (
        <Popconfirm
          title="删除计划"
          description="将删除该计划及其全部任务与打卡记录"
          okText="删除"
          cancelText="取消"
          onConfirm={() => removePlan(r.id)}
        >
          <Button size="small" danger type="link">
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ]

  // 按日期分组（仅展示排序，不改动数据本身）
  const groups: Array<{ date: string; tasks: PlanTask[] }> = []
  if (detail) {
    for (const t of [...detail.tasks].sort((a, b) => (a.task_date < b.task_date ? -1 : a.task_date > b.task_date ? 1 : 0))) {
      const last = groups[groups.length - 1]
      if (last && last.date === t.task_date) last.tasks.push(t)
      else groups.push({ date: t.task_date, tasks: [t] })
    }
  }
  const checkedCount = detail ? detail.tasks.filter((t) => t.checked).length : 0

  return (
    <div>
      <PageHeader
        title="训练计划"
        description="AI 生成（需在设置中配置 API Key）；未配置时自动生成模板计划。也可到「设置 → 导出提示词」手动喂给任意 AI。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setGenOpen(true)}>
            生成新计划
          </Button>
        }
      />
      <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={plans} pagination={{ pageSize: 10 }} />
      {!loading && plans.length === 0 && (
        <Card style={{ marginTop: 16 }}>
          <Empty description="暂无计划 —— 点击「生成新计划」开始" style={{ padding: '24px 0' }} />
        </Card>
      )}

      <Drawer title={detail?.title} open={detailOpen} onClose={() => setDetailOpen(false)} width={580}>
        {detail ? (
          <div>
            <p className="plan-goal">{detail.goal}</p>
            <div className="plan-meta">
              {sourceTag(detail.source)}
              <span className="mono">{detail.start_date} ~ {detail.end_date}</span>
              <span>已打卡 {checkedCount}/{detail.tasks.length}</span>
              <Progress
                className="gradient-progress"
                percent={detail.tasks.length ? Math.round((checkedCount / detail.tasks.length) * 100) : 0}
                size="small"
              />
            </div>

            {groups.map((g) => (
              <div key={g.date} className="plan-day-group">
                <div className="plan-day-header">
                  <span className="mono">{g.date}</span>
                  <span className="plan-day-count">
                    {g.tasks.filter((t) => t.checked).length}/{g.tasks.length} 已打卡
                  </span>
                </div>
                {g.tasks.map((t) => {
                  const link = t.problem_url ?? t.url
                  return (
                    <Card
                      key={t.id}
                      size="small"
                      className={`task-card task-card-${t.kind}${t.checked ? ' task-done' : ''}`}
                      style={{ marginBottom: 8 }}
                    >
                      <div className="task-row">
                        <div className="task-main">
                          <Space size={8} wrap>
                            {kindTag(t.kind)}
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
                              跳转做题 ↗
                            </a>
                          )}
                        </div>
                        <div className="task-actions">
                          <Button
                            size="small"
                            type={t.checked ? 'default' : 'primary'}
                            icon={t.checked ? <CheckOutlined /> : undefined}
                            onClick={() => toggleCheckin(t)}
                          >
                            {t.checked ? '已打卡' : '打卡'}
                          </Button>
                          <Button size="small" type="text" icon={<EditOutlined />} title="编辑任务" onClick={() => openEdit(t)} />
                          <Popconfirm
                            title="删除任务"
                            description="将删除该任务及其打卡记录"
                            okText="删除"
                            cancelText="取消"
                            onConfirm={() => removeTask(t)}
                          >
                            <Button size="small" type="text" danger icon={<DeleteOutlined />} title="删除任务" />
                          </Popconfirm>
                        </div>
                      </div>
                    </Card>
                  )
                })}
              </div>
            ))}
          </div>
        ) : (
          <Spin />
        )}
      </Drawer>

      <Modal
        title="编辑任务"
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={submitEdit}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="taskDate" label="日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select options={KIND_OPTIONS} />
          </Form.Item>
          <Form.Item name="url" label="链接（留空清除）">
            <Input placeholder="https://..." allowClear />
          </Form.Item>
          <Form.Item name="note" label="备注（留空清除）">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <GenerateModal
        open={genOpen}
        form={genForm}
        onClose={() => setGenOpen(false)}
        onDone={() => {
          setGenOpen(false)
          genForm.resetFields()
          load()
        }}
      />
    </div>
  )
}

function GenerateModal({ open, form, onClose, onDone }: { open: boolean; form: ReturnType<typeof Form.useForm>[0]; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const v = (await form
      .validateFields()
      .catch(() => null)) as unknown as { days: number; startDate: { format(f: string): string } } | null
    if (!v) return
    setBusy(true)
    try {
      const r = await post<GenerateResult>('/api/plans/generate', {
        days: v.days,
        startDate: v.startDate.format('YYYY-MM-DD'),
      })
      message.success(`已生成「${r.title}」（${r.source === 'ai' ? 'AI' : '模板'}）`)
      onDone()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="生成训练计划" open={open} onCancel={onClose} onOk={submit} okText="生成" confirmLoading={busy}>
      <Form form={form} layout="vertical">
        <Form.Item name="days" label="周期（天）" rules={[{ required: true }]}>
          <InputNumber min={1} max={90} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="startDate" label="开始日期" rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
