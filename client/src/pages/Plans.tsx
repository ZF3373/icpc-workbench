import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  DatePicker,
  Drawer,
  Empty,
  Form,
  InputNumber,
  message,
  Modal,
  Progress,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { del, get, post } from '../api'
import type { GenerateResult, PlanDetail, PlanListItem, PlanTask } from '../types'

function sourceTag(s: PlanListItem['source']) {
  if (s === 'ai') return <Tag color="blue">AI</Tag>
  if (s === 'template') return <Tag color="orange">模板</Tag>
  return <Tag>手动</Tag>
}

function kindTag(k: PlanTask['kind']) {
  const color = { practice: 'geekblue', review: 'purple', topic: 'cyan', contest: 'volcano' }[k]
  const label = { practice: '练习', review: '回顾', topic: '专题', contest: '模拟赛' }[k]
  return <Tag color={color}>{label}</Tag>
}

export default function Plans() {
  const [plans, setPlans] = useState<PlanListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [genOpen, setGenOpen] = useState(false)
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
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

  const cols: ColumnsType<PlanListItem> = [
    {
      title: '计划',
      dataIndex: 'title',
      render: (v: string, r) => <a onClick={() => openDetail(r.id)}>{v}</a>,
    },
    { title: '来源', dataIndex: 'source', width: 80, render: (v: PlanListItem['source']) => sourceTag(v) },
    { title: '周期', width: 210, render: (_v, r) => `${r.start_date} ~ ${r.end_date}` },
    { title: '进度', width: 160, render: (_v, r) => <Progress percent={r.task_count ? Math.round((r.checked_count / r.task_count) * 100) : 0} size="small" /> },
    { title: '任务', dataIndex: 'task_count', width: 70, render: (_v, r) => `${r.checked_count}/${r.task_count}` },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setGenOpen(true)}>
          生成新计划
        </Button>
        <span style={{ color: '#888' }}>AI 生成（需在设置中配置 API Key）；未配置时自动生成模板计划。也可到「题目管理 → 导出提示词」手动喂给任意 AI。</span>
      </Space>
      <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={plans} pagination={{ pageSize: 10 }} />
      {!loading && plans.length === 0 && <Empty description="暂无计划 —— 点击「生成新计划」开始" />}

      <Drawer title={detail?.title} open={detailOpen} onClose={() => setDetailOpen(false)} width={560}>
        {detail ? (
          <div>
            <p style={{ color: '#666' }}>{detail.goal}</p>
            <p>
              周期 {detail.start_date} ~ {detail.end_date} · {sourceTag(detail.source)}
            </p>
            {detail.tasks.map((t) => {
              const link = t.problem_url ?? t.url
              return (
                <Card key={t.id} size="small" style={{ marginBottom: 8 }}>
                  <Space wrap>
                    {kindTag(t.kind)}
                    <b>{t.title}</b>
                    {t.problem_key && <Tag>{t.problem_key}</Tag>}
                    {link && (
                      <a href={link} target="_blank" rel="noreferrer">
                        跳转做题 ↗
                      </a>
                    )}
                    <Button size="small" type={t.checked ? 'default' : 'primary'} onClick={() => toggleCheckin(t)}>
                      {t.checked ? '已打卡 ✓' : '打卡'}
                    </Button>
                  </Space>
                  {t.note && <p style={{ marginTop: 8, color: '#888' }}>{t.note}</p>}
                </Card>
              )
            })}
          </div>
        ) : (
          <Spin />
        )}
      </Drawer>

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
