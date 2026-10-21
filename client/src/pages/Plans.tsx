import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Table,
  Tag,
} from 'antd'
import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import type { ColumnsType } from 'antd/es/table'
import { KIND_COLOR, KIND_LABEL, KIND_OPTIONS } from '../ui'
import PageHeader from '../components/PageHeader'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import NoteCardButton from '../components/NoteCardButton'
import { del, get, patch, post } from '../api'
import type { GenerateResult, PlanDetail, PlanListItem, PlanTask } from '../types'

function sourceTag(s: PlanListItem['source']) {
  if (s === 'ai') return <Tag className="ai-tag-shimmer">AI</Tag>
  if (s === 'template') return <Tag color="orange">模板</Tag>
  return <Tag>手动</Tag>
}

function kindTag(k: PlanTask['kind']) {
  // 标签/配色单一真源在 ui.ts（与 Calendar 共用）
  return <Tag color={KIND_COLOR[k]}>{KIND_LABEL[k]}</Tag>
}

type PlanGenerationRequest = {
  days: number
  startDate: string
  dailyTasks?: number
  requirements?: string
}

export default function Plans() {
  // React 19 下 antd 静态 message 静默失效，必须用 App 上下文实例
  const { message } = AntdApp.useApp()
  const [plans, setPlans] = useState<PlanListItem[]>([])
  // 初始即 true：初始 false 会先画一帧「表格无数据 + 暂无计划」，等 effect 发出请求才翻成加载中，
  // 首屏先闪一下空态再变加载（也与下面「首屏骨架」分支的判定一致）
  const [loading, setLoading] = useState(true)
  /** 列表取数失败原因：与「一个计划都还没有」严格区分（失败给 InlineError 重试，不冒充空态） */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [genOpen, setGenOpen] = useState(false)
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [shiftOpen, setShiftOpen] = useState(false)
  const [shiftBusy, setShiftBusy] = useState(false)
  const [shiftDays, setShiftDays] = useState(1)
  const [skipWeekends, setSkipWeekends] = useState(false)
  const [dailyLimit, setDailyLimit] = useState<number | null>(null)
  const [generationNotice, setGenerationNotice] = useState<GenerateResult | null>(null)
  const [generationRequest, setGenerationRequest] = useState<PlanGenerationRequest | null>(null)
  const [editing, setEditing] = useState<PlanTask | null>(null)
  const [editForm] = Form.useForm()
  const [genForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    // 新一轮取数开始即清掉上次的失败原因，重试成功后错误态不会残留
    setLoadError(null)
    get<PlanListItem[]>('/api/plans')
      .then((r) => {
        setPlans(r)
        setLoadError(null)
      })
      .catch((e: Error) => {
        // 失败 ≠ 空：记下原因渲染 InlineError；已有旧列表时下面的提示条仍会说明这次刷新失败
        setLoadError(e.message)
        message.error(e.message)
      })
      .finally(() => {
        setLoading(false)
      })
    // 依赖保持为空：message 是 AntdApp 提供的稳定实例，放进依赖会让本回调随渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const [detailLoading, setDetailLoading] = useState(false)

  // useCallback：cols 的 useMemo 引用它（否则 memo 每帧失效）
  const openDetail = useCallback(async (id: number) => {
    setDetailLoading(true)
    setDetailOpen(true)
    try {
      const d = await get<PlanDetail>(`/api/plans/${id}`)
      setDetail(d)
    } catch (e) {
      message.error((e as Error).message)
      setDetailOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }, [message])

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

  // useCallback：cols 的 useMemo 引用它（否则 memo 每帧失效）
  const removePlan = useCallback(async (id: number) => {
    try {
      await del(`/api/plans/${id}`)
      message.success('计划已删除')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }, [load, message])

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

  const shiftRemaining = async () => {
    if (!detail || shiftBusy) return
    setShiftBusy(true)
    try {
      const result = await post<{ shifted: number; endDate: string }>(`/api/plans/${detail.id}/shift`, {
        days: shiftDays, skipWeekends, dailyLimit: dailyLimit ?? undefined,
      })
      message.success(result.shifted ? `已调整 ${result.shifted} 项任务，计划结束日期 ${result.endDate}` : '任务已符合设置，无需调整')
      setShiftOpen(false)
      await openDetail(detail.id)
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setShiftBusy(false)
    }
  }

  // useMemo：196 行的 ColumnsType（含 render 闭包）不必每帧重建
  const cols = useMemo<ColumnsType<PlanListItem>>(() => [
    {
      title: '计划',
      dataIndex: 'title',
      render: (v: string, r) => <a onClick={() => void openDetail(r.id)}>{v}</a>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 80,
      // ≤768px 隐藏：来源 Tag 是 nowrap，是这张表里最难压缩的一列；
      // 窄屏让它退出，避免表格被撑出横向滚动（进度/任务数等关键列保留）
      responsive: ['md'],
      render: (v: PlanListItem['source']) => sourceTag(v),
    },
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
          onConfirm={() => void removePlan(r.id)}
        >
          <Button size="small" danger type="link">
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ], [openDetail, removePlan])

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
          <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setGenOpen(true)}>
            生成新计划
          </Button>
          </Space>
        }
      />
      {generationNotice?.fallbackReason && <Alert style={{ marginBottom: 16 }} type="warning" showIcon closable
        message={`已生成模板计划「${generationNotice.title}」`}
        description={<div>{generationNotice.fallbackReason}<p>模板计划使用默认规则，文字训练要求不会自动执行。</p></div>}
        action={<Button size="small" onClick={() => {
          if (generationRequest) genForm.setFieldsValue({ ...generationRequest, startDate: dayjs(generationRequest.startDate) })
          setGenOpen(true)
        }}>按原参数重新生成</Button>}
        onClose={() => setGenerationNotice(null)} />}
      {/* 分支顺序与 Today.tsx 一致：loading（且屏上还没有任何行）→ 骨架 ｜ 有行 → 表格
          ｜ loadError → 可重试错误态 ｜ 空 → 空态。
          用 `loading && plans.length === 0` 而不是「只认首次加载」的 loadedOnce：
          失败后点重试时屏上同样是空的，只有这个条件能保证重试期间不是一片空白。 */}
      {loading && plans.length === 0 ? (
        <PageSkeleton stats={false} table rows={6} />
      ) : plans.length > 0 ? (
        <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={plans} pagination={{ pageSize: 10 }} />
      ) : loadError ? (
        /* 失败 ≠ 空：取数失败给可重试的错误态，只有确实一个计划都没有时才落空态 */
        <Card>
          <InlineError
            message={loadError}
            hint="计划列表没能取回来；重试即可，已生成的计划与打卡记录不会丢失。"
            onRetry={load}
            retrying={loading}
          />
        </Card>
      ) : (
        <Card>
          <EmptyState
            title="还没有训练计划"
            description="让 AI 按你的弱项生成一份计划，或手动添加任务。未配置 API Key 时会自动退回模板计划，不影响使用。"
            action={{
              label: '生成新计划',
              type: 'primary',
              icon: <PlusOutlined />,
              onClick: () => setGenOpen(true),
            }}
          />
        </Card>
      )}

      <Drawer title={detail?.title} open={detailOpen} onClose={() => setDetailOpen(false)} width={580}>
        {detailLoading || !detail ? (
          <PageSkeleton stats={false} table rows={6} />
        ) : (
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

            <Button style={{ marginBottom: 16 }} onClick={() => setShiftOpen(true)} disabled={!detail.tasks.some((t) => !t.checked && (t.kind === 'practice' || t.kind === 'topic'))}>调整剩余训练任务</Button>

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
                      {/* 任务卡内的「内容 | 操作」两栏：≤768px 转纵向（.card-actions-row
                          的 @media 规则），操作按钮下沉到内容下方，不再与标题挤一行 */}
                      <div className="task-row card-actions-row">
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
                          {/* 备注改为点击弹卡查看：variant="text" 让备注正文本身即入口，
                              外观沿用原备注样式（12px / 次要色），不挤压列表观感 */}
                          {t.note && (
                            <NoteCardButton kind="task" variant="text" subject={t.title} text={t.note} />
                          )}
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
        )}
      </Drawer>

      <Modal title="调整剩余训练任务" open={shiftOpen && detailOpen} onCancel={() => { if (!shiftBusy) setShiftOpen(false) }}
        onOk={() => void shiftRemaining()} okText="确认调整" cancelText="取消" confirmLoading={shiftBusy}>
        <p>调整未打卡的练习和专题任务，保留已完成任务、比赛和复习的原日期。</p>
        <Form layout="vertical">
          <Form.Item label="顺延天数" extra="填 0 可只调整周末或每日负荷。">
            <InputNumber min={0} max={30} precision={0} value={shiftDays} onChange={(v) => setShiftDays(v ?? 0)} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item><Checkbox checked={skipWeekends} onChange={(e) => setSkipWeekends(e.target.checked)}>避开周六和周日</Checkbox></Form.Item>
          <Form.Item label="每日任务上限" extra="留空不限制。固定任务占用当天名额，超出的练习自动往后安排。">
            <InputNumber min={1} max={6} precision={0} value={dailyLimit} onChange={setDailyLimit} placeholder="1–6" style={{ width: '100%' }} />
          </Form.Item>
        </Form>
        <p style={{ color: 'var(--text-3)' }}>同名任务冲突时自动顺延到可用日期，计划周期随之延长。</p>
      </Modal>

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
        onDone={(result, request) => {
          setGenOpen(false)
          setGenerationNotice(result)
          setGenerationRequest(request)
          if (result.source === 'ai') genForm.resetFields()
          load()
        }}
      />
    </div>
  )
}

function GenerateModal({ open, form, onClose, onDone }: { open: boolean; form: ReturnType<typeof Form.useForm>[0]; onClose: () => void; onDone: (result: GenerateResult, request: PlanGenerationRequest) => void }) {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const v = (await form
      .validateFields()
      .catch(() => null)) as unknown as { days: number; startDate: { format(f: string): string }; dailyTasks?: number; requirements?: string } | null
    if (!v) return
    const request: PlanGenerationRequest = {
      days: v.days,
      startDate: v.startDate.format('YYYY-MM-DD'),
      // 每天任务数留空 = AI 自行安排（1-3）
      dailyTasks: v.dailyTasks ?? undefined,
      // 用户手写的训练要求（可选）
      requirements: v.requirements?.trim() || undefined,
    }
    setBusy(true)
    try {
      const r = await post<GenerateResult>('/api/plans/generate', request)
      message.success(`已生成「${r.title}」（${r.source === 'ai' ? 'AI' : '模板'}）`)
      onDone(r, request)
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
        <Form.Item name="dailyTasks" label="每天任务数" extra="留空 = AI 自行安排（1-3）；无 AI 时按此密度生成练习任务">
          <InputNumber min={1} max={6} style={{ width: '100%' }} placeholder="1-6" />
        </Form.Item>
        <Form.Item name="startDate" label="开始日期" rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="requirements"
          label="训练要求"
          extra="可选。写下你对计划的要求（如：主攻图论与 DP、多安排 Div.2 赛题、周末留空），AI 生成时会优先满足"
          rules={[{ max: 500, message: '最多 500 字' }]}
        >
          <Input.TextArea
            rows={3}
            placeholder="如：主攻图论和动态规划，题目难度 1600-1900，周日不安排任务"
            maxLength={500}
            showCount
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}
