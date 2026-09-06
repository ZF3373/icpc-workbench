import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Drawer, Empty, Input, message, Modal, Progress, Select, Space, Spin, Tag } from 'antd'
import { RobotOutlined, SendOutlined } from '@ant-design/icons'
import { applyPlanModification, chatWithPlan, get, type PlanApplyResult, type PlanChatTurn } from '../api'
import type { PlanDetail, PlanListItem } from '../types'
import Markdown from './Markdown'

/**
 * 计划 AI 助手抽屉：左侧当前计划概览、右侧聊天流。
 * AI 回复中可能带 plan-modify 围栏块（完整新计划 JSON）——展示时剥离，
 * 渲染「应用修改」入口，用户确认后调 /apply 原位更新（打卡按「日期+标题」匹配保留）。
 * 聊天记录仅存内存（切换计划/关闭抽屉即清空），服务端不落库。
 */

interface ChatMsg extends PlanChatTurn {
  /** 该条 AI 回复是否已应用其计划修改（应用后按钮失效，防止重复提交） */
  applied?: boolean
}

/** 提取 AI 回复中的 ```plan-modify 围栏块（容错 ```json 变体：正文含块名即可） */
function extractModifyBlock(reply: string): string | null {
  const m = reply.match(/```[a-zA-Z-]*plan-modify[\s\S]*?\n([\s\S]*?)```/)
  return m ? m[1] : null
}

/** 剥离 plan-modify 块后的可见文本 */
function stripModifyBlock(reply: string): string {
  return reply.replace(/```[a-zA-Z-]*plan-modify[\s\S]*?```/g, '').trim()
}

export default function PlanChatDrawer({
  open,
  onClose,
  plans,
  onPlanMutated,
}: {
  open: boolean
  onClose: () => void
  plans: PlanListItem[]
  onPlanMutated: () => void
}) {
  const navigate = useNavigate()
  const [planId, setPlanId] = useState<number | null>(null)
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [needConfig, setNeedConfig] = useState(false)
  const [applyTarget, setApplyTarget] = useState<string | null>(null) // 待确认应用的 AI 回复
  const [applying, setApplying] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 打开抽屉时默认选中最近一个计划
  useEffect(() => {
    if (open && planId === null && plans.length > 0) setPlanId(plans[0].id)
  }, [open, plans, planId])

  // 切换计划：加载详情并清空聊天（记录不落库，换计划即新会话）
  useEffect(() => {
    if (!open || planId === null) return
    let cancelled = false
    setDetailLoading(true)
    setMessages([])
    setNeedConfig(false)
    get<PlanDetail>(`/api/plans/${planId}`)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && message.error(e.message))
      .finally(() => !cancelled && setDetailLoading(false))
    return () => {
      cancelled = true
    }
  }, [open, planId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  const send = async () => {
    const text = input.trim()
    if (!text || planId === null || sending) return
    const next: ChatMsg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setSending(true)
    setNeedConfig(false)
    try {
      const r = await chatWithPlan<{ reply: string }>(planId, next.map(({ role, content }) => ({ role, content })))
      setMessages((s) => [...s, { role: 'assistant', content: r.reply }])
    } catch (e) {
      const err = e as Error & { needConfig?: boolean }
      if (err.needConfig) setNeedConfig(true)
      // 失败：撤回本地 user 消息，让用户可重发
      setMessages(messages)
      setInput(text)
      message.error(err.message)
    } finally {
      setSending(false)
    }
  }

  const confirmApply = async () => {
    if (planId === null || applyTarget === null) return
    setApplying(true)
    try {
      const r = await applyPlanModification<PlanApplyResult>(planId, applyTarget)
      message.success(
        `已应用修改：新增 ${r.added}、删除 ${r.removed}、保留 ${r.kept} 个任务（保留打卡 ${r.checkinsKept} 条）`,
      )
      setMessages((s) => s.map((m) => (m.content === applyTarget ? { ...m, applied: true } : m)))
      setApplyTarget(null)
      onPlanMutated()
      const d = await get<PlanDetail>(`/api/plans/${planId}`)
      setDetail(d)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setApplying(false)
    }
  }

  const checked = detail ? detail.tasks.filter((t) => t.checked).length : 0

  return (
    <Drawer
      title={
        <Space>
          <RobotOutlined />
          计划 AI 助手
          <Select
            size="small"
            style={{ minWidth: 220 }}
            placeholder="选择计划"
            value={planId ?? undefined}
            options={plans.map((p) => ({ value: p.id, label: p.title }))}
            onChange={(v) => setPlanId(v)}
          />
        </Space>
      }
      open={open}
      onClose={onClose}
      width={800}
      destroyOnHidden
    >
      {needConfig && (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={
            <span>
              AI 尚未配置。到
              <a onClick={() => navigate('/settings')}>「设置 → AI 配置」</a>
              填写 OpenAI 兼容接口（如 DeepSeek）后即可对话。
            </span>
          }
        />
      )}
      <div className="plan-chat-layout">
        <div className="plan-chat-side">
          {detailLoading && <Spin size="small" />}
          {!detailLoading && detail && (
            <>
              <b>{detail.title}</b>
              <p className="plan-goal" style={{ fontSize: 12, marginTop: 6 }}>{detail.goal}</p>
              <div className="plan-meta" style={{ fontSize: 12 }}>
                <span className="mono">{detail.start_date} ~ {detail.end_date}</span>
                <span>已打卡 {checked}/{detail.tasks.length}</span>
                <Progress
                  className="gradient-progress"
                  percent={detail.tasks.length ? Math.round((checked / detail.tasks.length) * 100) : 0}
                  size="small"
                />
              </div>
              <div className="plan-chat-tasks">
                {detail.tasks.map((t) => (
                  <div key={t.id} className="plan-chat-task" style={{ opacity: t.checked ? 0.55 : 1 }}>
                    <span className="mono" style={{ color: '#8993a2' }}>{t.task_date}</span>{' '}
                    {t.checked ? <Tag color="success">✓</Tag> : null}
                    <span>{t.title}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {!detailLoading && !detail && planId !== null && <Empty description="无任务" imageStyle={{ height: 40 }} />}
        </div>
        <div className="plan-chat-main">
          <div className="plan-chat-msgs">
            {messages.length === 0 && !sending && (
              <div style={{ color: '#8993a2', fontSize: 12, padding: '24px 0', textAlign: 'center' }}>
                和 AI 教练聊聊这份计划：可以问「我的弱项该怎么安排？」，也可以直接要求
                「把第 2 周换成图论专题」——AI 会给出可一键应用的修改方案。
              </div>
            )}
            {messages.map((m, i) => {
              const block = m.role === 'assistant' ? extractModifyBlock(m.content) : null
              return (
                <div key={i} className={`plan-chat-msg plan-chat-msg-${m.role}`}>
                  {m.role === 'assistant' ? (
                    <Markdown text={block ? stripModifyBlock(m.content) : m.content} />
                  ) : (
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  )}
                  {block && (
                    <div style={{ marginTop: 8 }}>
                      <Button
                        size="small"
                        type="primary"
                        disabled={m.applied}
                        onClick={() => setApplyTarget(m.content)}
                      >
                        {m.applied ? '已应用' : '应用修改'}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
            {sending && <div className="plan-chat-msg plan-chat-msg-assistant"><Spin size="small" /></div>}
            <div ref={bottomRef} />
          </div>
          <div className="plan-chat-input">
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={planId === null || sending}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={sending}
              disabled={!input.trim() || planId === null}
              onClick={() => void send()}
            />
          </div>
        </div>
      </div>

      <Modal
        title="应用 AI 计划修改"
        open={applyTarget !== null}
        onCancel={() => setApplyTarget(null)}
        onOk={() => void confirmApply()}
        okText="应用"
        cancelText="取消"
        confirmLoading={applying}
      >
        <Alert
          type="info"
          showIcon
          message="将以 AI 给出的任务列表整体替换当前计划的任务。日期与标题都相同的任务会保留原 id 与打卡记录；其余任务新增/删除（被删除任务的打卡将一并清除）。计划标题/目标如 AI 有给出也会一并更新。"
        />
      </Modal>
    </Drawer>
  )
}
