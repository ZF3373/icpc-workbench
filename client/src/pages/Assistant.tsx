import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Input, message, Modal, Select, Space, Spin, Tag } from 'antd'
import { ClearOutlined, RobotOutlined, SendOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  applyAbility,
  applyPlanModification,
  chatWithAssistant,
  get,
  type AbilityInfo,
  type PlanApplyResult,
  type PlanChatTurn,
} from '../api'
import type { PlanListItem } from '../types'
import Markdown from '../components/Markdown'
import PageHeader from '../components/PageHeader'
import {
  extractAbilityUpdate,
  extractModifyBlock,
  stripAbilityUpdate,
  stripModifyBlock,
} from '../aiBlocks'

/**
 * AI 助手（issue #4）：全局 AI 交流窗口。
 * 自动携带练习数据汇总（含问题分布统计）与弱项画像，可回答问题/调试代码；
 * 关联训练计划后支持直接修改计划（plan-modify 块 → 用户确认应用）；
 * AI 评估后可输出 ability-update 块，用户一键更新估算能力值（今日训练分档随之生效）。
 * 聊天记录存内存；切换关联计划仅影响后续 system prompt，不强制清空会话。
 */

interface ChatMsg extends PlanChatTurn {
  applied?: boolean
}

export default function Assistant() {
  const nav = useNavigate()
  const [plans, setPlans] = useState<PlanListItem[]>([])
  const [planId, setPlanId] = useState<number | undefined>(undefined)
  const [ability, setAbility] = useState<AbilityInfo | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [needConfig, setNeedConfig] = useState(false)
  const [applyTarget, setApplyTarget] = useState<{ planId: number; raw: string } | null>(null)
  const [applying, setApplying] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    get<PlanListItem[]>('/api/plans')
      .then(setPlans)
      .catch(() => {})
  }, [])

  const loadAbility = useCallback(() => {
    get<AbilityInfo>('/api/ai/ability')
      .then(setAbility)
      .catch(() => {})
  }, [])

  useEffect(loadAbility, [loadAbility])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    const next: ChatMsg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setSending(true)
    setNeedConfig(false)
    try {
      const r = planId !== undefined
        ? await chatWithAssistant<{ reply: string }>({ messages: next.map(({ role, content }) => ({ role, content })), planId })
        : await chatWithAssistant<{ reply: string }>({ messages: next.map(({ role, content }) => ({ role, content })) })
      setMessages((s) => [...s, { role: 'assistant', content: r.reply }])
    } catch (e) {
      const err = e as Error & { needConfig?: boolean }
      if (err.needConfig) setNeedConfig(true)
      setMessages(messages)
      setInput(text)
      message.error(err.message)
    } finally {
      setSending(false)
    }
  }

  const confirmApply = async () => {
    if (applyTarget === null) return
    setApplying(true)
    try {
      const r = await applyPlanModification<PlanApplyResult>(applyTarget.planId, applyTarget.raw)
      message.success(
        `已应用修改：新增 ${r.added}、删除 ${r.removed}、保留 ${r.kept} 个任务（保留打卡 ${r.checkinsKept} 条）`,
      )
      setMessages((s) => s.map((m) => (m.content === applyTarget.raw ? { ...m, applied: true } : m)))
      setApplyTarget(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setApplying(false)
    }
  }

  const confirmAbility = async (suggestion: { level: number; reason?: string }, raw: string) => {
    try {
      const r = await applyAbility<AbilityInfo>({ level: suggestion.level, reason: suggestion.reason })
      setAbility(r)
      setMessages((s) => s.map((m) => (m.content === raw ? { ...m, applied: true } : m)))
      message.success(`估算能力值已更新为 ${r.effective}，今日训练三档将按新值分档`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const resetAbility = async () => {
    try {
      const r = await applyAbility<AbilityInfo>({ reset: true })
      setAbility(r)
      message.success('已恢复为计算值')
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  /** 计划存在性/日期范围由 /apply 端点校验，这里仅打包待确认内容 */
  const openPlanApply = (raw: string) => {
    if (planId === undefined) {
      message.warning('AI 回复包含计划修改，但当前未关联计划：请在左侧选择要修改的计划后让 AI 重新生成')
      return
    }
    setApplyTarget({ planId, raw })
  }

  return (
    <div>
      <PageHeader
        title="AI 助手"
        description="与 AI 教练自由对话：解答算法问题、调试代码、解读你的问题分布统计；关联训练计划后可直接修改计划，也可让 AI 评估并更新估算能力值。"
      />
      {needConfig && (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={
            <span>
              AI 尚未配置。到
              <a onClick={() => nav('/settings')}>「设置 → AI 配置」</a>
              填写 OpenAI 兼容接口（如 DeepSeek）后即可对话。
            </span>
          }
        />
      )}
      <div className="assistant-layout">
        <div className="assistant-side">
          <Card size="small" title="对话上下文">
            <p style={{ fontSize: 12, color: '#8993a2', marginBottom: 8 }}>
              AI 自动携带你的练习数据汇总（含问题分布统计）与弱项画像。
            </p>
            <Space.Compact style={{ width: '100%' }}>
              <Select
                style={{ width: '100%' }}
                placeholder="关联训练计划（可选）"
                value={planId}
                allowClear
                onClear={() => setPlanId(undefined)}
                onChange={(v) => setPlanId(v)}
                options={plans.map((p) => ({ value: p.id, label: p.title }))}
              />
            </Space.Compact>
            <p style={{ fontSize: 12, color: '#8993a2', margin: '8px 0 0' }}>
              关联后可让 AI 直接修改该计划（应用前会向你确认）。
            </p>
          </Card>
          <Card
            size="small"
            title="估算能力值"
            style={{ marginTop: 12 }}
            extra={ability?.override ? <Button size="small" type="link" onClick={() => void resetAbility()}>恢复计算值</Button> : undefined}
          >
            {ability ? (
              <>
                <div style={{ fontSize: 28, fontWeight: 700 }}>{ability.effective}</div>
                <div style={{ fontSize: 12, color: '#8993a2' }}>
                  计算值 {ability.computed}（近期 AC 难度中位数）
                </div>
                {ability.override && (
                  <div style={{ marginTop: 8 }}>
                    <Tag color="purple">AI 调整</Tag>
                    <span style={{ fontSize: 12 }}>{ability.override.reason ?? '未记录理由'}</span>
                  </div>
                )}
              </>
            ) : (
              <Spin size="small" />
            )}
          </Card>
          <Button
            block
            style={{ marginTop: 12 }}
            icon={<ClearOutlined />}
            onClick={() => setMessages([])}
          >
            清空会话
          </Button>
        </div>
        <div className="assistant-main">
          <div className="plan-chat-msgs">
            {messages.length === 0 && !sending && (
              <div style={{ color: '#8993a2', fontSize: 13, padding: '32px 16px', textAlign: 'center' }}>
                <RobotOutlined style={{ fontSize: 32, display: 'block', marginBottom: 12 }} />
                试试这样问：<br />
                「我哪个知识点最弱？该怎么补？」<br />
                「这段代码为什么 TLE：粘贴你的代码」<br />
                「把我的估算能力值调整到 1900」{planId !== undefined ? '「把计划里下周改成图论专题」' : ''}
              </div>
            )}
            {messages.map((m, i) => {
              if (m.role === 'user') {
                return (
                  <div key={i} className="plan-chat-msg plan-chat-msg-user">
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  </div>
                )
              }
              const modify = extractModifyBlock(m.content)
              const abilityUpd = extractAbilityUpdate(m.content)
              let text = stripModifyBlock(m.content)
              if (abilityUpd) text = stripAbilityUpdate(text)
              return (
                <div key={i} className="plan-chat-msg plan-chat-msg-assistant">
                  <Markdown text={text} />
                  {(modify || abilityUpd) && (
                    <Space style={{ marginTop: 8 }} wrap>
                      {modify && (
                        <Button size="small" type="primary" disabled={m.applied} onClick={() => void openPlanApply(m.content)}>
                          {m.applied ? '已应用' : '应用计划修改'}
                        </Button>
                      )}
                      {abilityUpd && (
                        <Button
                          size="small"
                          type="primary"
                          ghost
                          disabled={m.applied}
                          onClick={() => void confirmAbility(abilityUpd, m.content)}
                        >
                          更新能力值为 {abilityUpd.level}
                        </Button>
                      )}
                    </Space>
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
              placeholder="向 AI 教练提问…（可粘贴代码）Enter 发送，Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 6 }}
              disabled={sending}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={!input.trim()} onClick={() => void send()} />
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
          message="将以 AI 给出的任务列表整体替换该计划的任务。日期与标题都相同的任务会保留原 id 与打卡记录；其余任务新增/删除（被删除任务的打卡将一并清除）。"
        />
      </Modal>
    </div>
  )
}
