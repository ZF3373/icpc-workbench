import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, App as AntdApp, Button, Card, Input, Modal, Popconfirm, Select, Space, Spin, Tag } from 'antd'
import {
  DeleteOutlined,
  HolderOutlined,
  LoadingOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  RobotOutlined,
  SendOutlined,
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  applyAbility,
  applyPlanModification,
  chatWithAssistantStream,
  get,
  post,
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
  extractTemplateAdd,
  stripAbilityUpdate,
  stripModifyBlock,
  stripTemplateAdd,
  type TemplateAddDraft,
} from '../aiBlocks'

/**
 * AI 助手（issue #4）：全局 AI 交流窗口。
 *
 * - 自动携带练习数据汇总（含问题分布统计）与弱项画像，可回答问题/调试代码
 * - 关联训练计划后支持直接修改计划（plan-modify 块 → 用户确认应用）
 * - AI 评估后可输出 ability-update 块，用户一键更新估算能力值
 * - 多会话管理：侧边栏会话记录列表，支持切换/删除/置顶，localStorage 持久化
 * - 聊天状态存模块级 store（useSyncExternalStore）：切模块再回来不丢，生成中切走
 *   回来也能看到回复自动出现——async 回调直接写 store，不依赖组件是否挂载
 */

// ---------- 类型 ----------

interface ChatMsg extends PlanChatTurn {
  applied?: boolean
  /** 该消息中已写入模板库的 template-add 草稿下标（按消息内顺序，持久化防重载重复写入） */
  appliedTpl?: number[]
}

interface ChatSession {
  id: string
  title: string
  messages: ChatMsg[]
  planId: number | undefined
  createdAt: number
  updatedAt: number
  pinned: boolean
}

interface ChatState {
  sessions: ChatSession[]
  activeId: string
  input: string
  /** 正在流式生成的会话 id 集合（支持多会话并行输入输出） */
  sendingIds: Set<string>
}

// ---------- localStorage 持久化 ----------

const STORAGE_KEY = 'icpc-ai-sessions-v1'
const MAX_SESSIONS = 50

function loadFromStorage(): ChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as ChatSession[]
    if (!Array.isArray(data)) return []
    return data
      .filter(
        (s) =>
          typeof s.id === 'string' && Array.isArray(s.messages) && typeof s.createdAt === 'number',
      )
      .map((s) => ({
        id: s.id,
        title: typeof s.title === 'string' ? s.title : '新会话',
        messages: s.messages,
        planId: typeof s.planId === 'number' ? s.planId : undefined,
        createdAt: s.createdAt,
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : s.createdAt,
        pinned: !!s.pinned,
      }))
  } catch {
    return []
  }
}

function saveToStorage(sessions: ChatSession[]): void {
  try {
    const toSave = sessions.filter((s) => s.messages.length > 0).slice(0, MAX_SESSIONS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
  } catch {
    /* localStorage 可能不可用或已满，静默忽略 */
  }
}

// ---------- 模块级 store ----------

function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function createSession(planId?: number): ChatSession {
  const now = Date.now()
  return {
    id: newSessionId(),
    title: '新会话',
    messages: [],
    planId,
    createdAt: now,
    updatedAt: now,
    pinned: false,
  }
}

function initChatState(): ChatState {
  const saved = loadFromStorage()
  const sessions = saved.length > 0 ? saved : [createSession()]
  return { sessions, activeId: sessions[0].id, input: '', sendingIds: new Set() }
}

let chatState: ChatState = initChatState()
const chatListeners = new Set<() => void>()

/** 进行中的会话 → AbortController，用于停止生成（非 React 状态，不触发渲染） */
const sessionAbortControllers = new Map<string, AbortController>()

function setChatState(updater: (prev: ChatState) => ChatState): void {
  const prev = chatState
  chatState = updater(chatState)
  // 仅在 sessions 引用变化时写 localStorage（input/sendingIds 变化不触发写入）
  if (chatState.sessions !== prev.sessions) saveToStorage(chatState.sessions)
  chatListeners.forEach((l) => l())
}

function subscribeChat(listener: () => void): () => void {
  chatListeners.add(listener)
  return () => {
    chatListeners.delete(listener)
  }
}

function getChatSnapshot(): ChatState {
  return chatState
}

// ---------- 会话操作 ----------

function createNewSession(): void {
  const s = createSession()
  setChatState((prev) => ({ ...prev, sessions: [s, ...prev.sessions], activeId: s.id, input: '' }))
}

function switchToSession(id: string): void {
  setChatState((prev) => (prev.activeId === id ? prev : { ...prev, activeId: id, input: '' }))
}

/** 拖拽排序：将 fromId 对应的会话移动到 toId 对应会话的位置 */
function reorderSessions(fromId: string, toId: string): void {
  setChatState((prev) => {
    const fromIdx = prev.sessions.findIndex((s) => s.id === fromId)
    const toIdx = prev.sessions.findIndex((s) => s.id === toId)
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return prev
    const next = [...prev.sessions]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved!)
    return { ...prev, sessions: next }
  })
}

function deleteSessionById(id: string): void {
  // 若该会话正在生成，中止其流式请求
  sessionAbortControllers.get(id)?.abort()
  sessionAbortControllers.delete(id)
  setChatState((prev) => {
    const remaining = prev.sessions.filter((s) => s.id !== id)
    const sessions = remaining.length > 0 ? remaining : [createSession()]
    const activeId = prev.activeId === id ? sessions[0].id : prev.activeId
    const nextSending = new Set(prev.sendingIds)
    nextSending.delete(id)
    return { ...prev, sessions, activeId, input: '', sendingIds: nextSending }
  })
}

function toggleSessionPin(id: string): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)),
  }))
}

function renameSession(id: string, title: string): void {
  const t = title.trim()
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === id ? { ...s, title: t || '新会话' } : s)),
  }))
}

function updateActiveSessionPlanId(planId: number | undefined): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === prev.activeId ? { ...s, planId } : s)),
  }))
}

/** 更新当前会话的消息列表（async 回调安全：直接写 store，不依赖组件挂载） */
function patchActiveSessionMessages(
  sessionId: string,
  fn: (msgs: ChatMsg[]) => ChatMsg[],
): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) =>
      s.id === sessionId ? { ...s, messages: fn(s.messages), updatedAt: Date.now() } : s,
    ),
  }))
}

// ---------- 相对时间 ----------

function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// ---------- 组件 ----------

export default function Assistant() {
  const { message } = AntdApp.useApp()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const chat = useSyncExternalStore(subscribeChat, getChatSnapshot)
  const { sessions, activeId, input, sendingIds } = chat
  const activeSession = sessions.find((s) => s.id === activeId)
  const messages = activeSession?.messages ?? []
  const planId = activeSession?.planId
  const sending = sendingIds.has(activeId)

  const [plans, setPlans] = useState<PlanListItem[]>([])
  const [ability, setAbility] = useState<AbilityInfo | null>(null)
  const [abilityError, setAbilityError] = useState(false)
  const [needConfig, setNeedConfig] = useState(false)
  const [applyTarget, setApplyTarget] = useState<{ planId: number; raw: string } | null>(null)
  const [applying, setApplying] = useState(false)
  const [tplWriting, setTplWriting] = useState<Set<string>>(new Set())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  /** 拖拽事件间即时传递 dragId（React state 异步更新，onDragOver 读到的是旧值导致拖拽失效） */
  const dragIdRef = useRef<string | null>(null)
  /** 标记本次是否真的发生了拖拽，防止 dragEnd 后误触发 onClick 切换会话 */
  const didDragRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // ?plan=<id> 消费 + 计划列表加载 + 清理已删除的计划关联
  useEffect(() => {
    const urlPlan = searchParams.get('plan')
    if (urlPlan !== null) {
      const v = Number(urlPlan)
      if (Number.isInteger(v) && v > 0) updateActiveSessionPlanId(v)
      setSearchParams({}, { replace: true })
    }
    get<PlanListItem[]>('/api/plans')
      .then((list) => {
        setPlans(list)
        setChatState((prev) => {
          const active = prev.sessions.find((s) => s.id === prev.activeId)
          if (active?.planId !== undefined && !list.some((p) => p.id === active.planId)) {
            return {
              ...prev,
              sessions: prev.sessions.map((s) =>
                s.id === prev.activeId ? { ...s, planId: undefined } : s,
              ),
            }
          }
          return prev
        })
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadAbility = useCallback(() => {
    setAbilityError(false)
    get<AbilityInfo>('/api/ai/ability')
      .then(setAbility)
      .catch(() => setAbilityError(true))
  }, [])

  useEffect(loadAbility, [loadAbility])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  const send = async () => {
    const text = input.trim()
    if (!text || sendingIds.has(activeId)) return
    const sessionId = activeId
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return

    const nextMessages: ChatMsg[] = [...session.messages, { role: 'user', content: text }]
    const sendPlanId = session.planId

    // 写入用户消息 + 进入 sending 态（标题取首条消息前 30 字）
    setChatState((prev) => ({
      ...prev,
      input: '',
      sendingIds: new Set(prev.sendingIds).add(sessionId),
      sessions: prev.sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              messages: nextMessages,
              title: s.messages.length === 0 ? text.slice(0, 30) : s.title,
              updatedAt: Date.now(),
            }
          : s,
      ),
    }))
    setNeedConfig(false)

    // 每次发送创建独立的 AbortController，支持用户主动停止生成
    const ac = new AbortController()
    sessionAbortControllers.set(sessionId, ac)

    try {
      // 先种一条空 assistant 消息，流式 delta 逐字追加到它
      patchActiveSessionMessages(sessionId, (msgs) => [
        ...msgs,
        { role: 'assistant', content: '' },
      ])

      const result = await chatWithAssistantStream(
        {
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          ...(sendPlanId !== undefined ? { planId: sendPlanId } : {}),
        },
        (delta) => {
          // 追加到最后一条 assistant 消息（用户可能已切到其他会话，但写入仍指向原会话）
          patchActiveSessionMessages(sessionId, (msgs) => {
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant') {
              return [...msgs.slice(0, -1), { ...last, content: last.content + delta }]
            }
            return msgs
          })
        },
        ac.signal,
      )
      // AI 因 max_tokens 上限被截断：在回复末尾追加提示，引导用户调大上限或分批请求
      if (result.truncated) {
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant') {
            return [
              ...msgs.slice(0, -1),
              { ...last, content: `${last.content}\n\n> ⚠️ **回复因达到最大 token 上限被截断。** 可到「设置 → AI 配置」调大「最大输出 token」（注意不得超过模型上限），或让 AI 分批输出。` },
            ]
          }
          return msgs
        })
      }
      // 对话历史被裁剪：提示用户上下文窗口偏小，最早的消息已丢弃
      if (result.contextTrimmed > 0) {
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant') {
            return [
              ...msgs.slice(0, -1),
              { ...last, content: `${last.content}\n\n> ℹ️ **对话历史较长，已自动裁剪最早的 ${result.contextTrimmed} 条消息以适配模型上下文窗口。** 如需保留更多上下文，可到「设置 → AI 配置」调大「模型上下文长度」。` },
            ]
          }
          return msgs
        })
      }
      // 联网搜索返回了来源：在回复末尾追加参考链接
      if (result.sources.length > 0) {
        const sourceLinks = result.sources
          .map((s, i) => `[${i + 1}] [${s.title}](${s.url})`)
          .join('\n')
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant') {
            return [
              ...msgs.slice(0, -1),
              { ...last, content: `${last.content}\n\n---\n**🔍 搜索来源：**\n${sourceLinks}` },
            ]
          }
          return msgs
        })
      }
    } catch (e) {
      // 用户主动停止生成：保留已收到内容，不报错
      if (ac.signal.aborted) {
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant' && last.content === '') {
            return [...msgs.slice(0, -1), { ...last, content: '（已停止生成）' }]
          }
          if (last && last.role === 'assistant' && last.content !== '') {
            return [...msgs.slice(0, -1), { ...last, content: `${last.content}\n\n> ⏹️ **已停止生成。**` }]
          }
          return msgs
        })
      } else {
        const err = e as Error & { needConfig?: boolean }
        if (err.needConfig) setNeedConfig(true)
        // 把错误追加到最后一条 assistant 消息（如果为空）或新加一条
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant' && last.content === '') {
            return [...msgs.slice(0, -1), { ...last, content: `⚠️ ${err.message}` }]
          }
          return [...msgs, { role: 'assistant', content: `⚠️ ${err.message}` }]
        })
      }
    } finally {
      sessionAbortControllers.delete(sessionId)
      setChatState((prev) => {
        if (!prev.sendingIds.has(sessionId)) return prev
        const next = new Set(prev.sendingIds)
        next.delete(sessionId)
        return { ...prev, sendingIds: next }
      })
    }
  }

  /** 中止指定会话的流式生成（保留已收到的部分回复） */
  const stopSending = (sessionId: string) => {
    sessionAbortControllers.get(sessionId)?.abort()
  }

  const confirmApply = async () => {
    if (applyTarget === null) return
    setApplying(true)
    try {
      const r = await applyPlanModification<PlanApplyResult>(applyTarget.planId, applyTarget.raw)
      message.success(
        `已应用修改：新增 ${r.added}、删除 ${r.removed}、保留 ${r.kept} 个任务（保留打卡 ${r.checkinsKept} 条）`,
      )
      patchActiveSessionMessages(activeId, (msgs) =>
        msgs.map((m) => (m.content === applyTarget.raw ? { ...m, applied: true } : m)),
      )
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
      patchActiveSessionMessages(activeId, (msgs) =>
        msgs.map((m) => (m.content === raw ? { ...m, applied: true } : m)),
      )
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

  const tplKey = (msgIndex: number, draftIndex: number) => `${msgIndex}:${draftIndex}`

  /** 写入单个模板草稿（不弹 toast，供单条/批量复用），返回是否成功 */
  const writeOneTemplate = async (
    draft: TemplateAddDraft,
    msgIndex: number,
    draftIndex: number,
  ): Promise<boolean> => {
    const key = tplKey(msgIndex, draftIndex)
    setTplWriting((prev) => new Set(prev).add(key))
    try {
      await post('/api/templates/custom', {
        categoryKey: draft.categoryKey,
        name: draft.name,
        difficulty: draft.difficulty,
        tags: draft.tags,
        code: draft.code,
        idea: draft.idea,
        complexity: draft.complexity,
        url: draft.url,
      })
      patchActiveSessionMessages(activeId, (msgs) =>
        msgs.map((m, i) =>
          i === msgIndex ? { ...m, appliedTpl: [...(m.appliedTpl ?? []), draftIndex] } : m,
        ),
      )
      return true
    } catch (e) {
      message.error((e as Error).message)
      return false
    } finally {
      setTplWriting((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const confirmTemplate = async (draft: TemplateAddDraft, msgIndex: number, draftIndex: number) => {
    if (await writeOneTemplate(draft, msgIndex, draftIndex)) {
      message.success(`「${draft.name}」已写入模板库，到「模板库」页可继续完善`)
    }
  }

  const confirmAllTemplates = async (drafts: TemplateAddDraft[], msgIndex: number) => {
    const appliedSet = new Set(messages[msgIndex]?.appliedTpl ?? [])
    const pending = drafts.map((_, j) => j).filter((j) => !appliedSet.has(j))
    if (pending.length === 0) return
    let ok = 0
    let fail = 0
    for (const j of pending) {
      if (await writeOneTemplate(drafts[j]!, msgIndex, j)) ok++
      else fail++
    }
    if (ok > 0) {
      message.success(`已写入 ${ok} 个模板到模板库${fail > 0 ? `，${fail} 个失败` : ''}`)
    }
  }

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
          {/* 会话记录 */}
          <Card
            size="small"
            title="会话记录"
            extra={
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
                onClick={createNewSession}
              >
                新建
              </Button>
            }
          >
            <div style={{ maxHeight: 280, overflowY: 'auto', margin: '0 -4px' }}>
              {sessions.map((s) => {
                const isActive = s.id === activeId
                const isDragging = dragId === s.id
                const isDragOver = dragOverId === s.id && dragId !== null && dragId !== s.id
                return (
                  <div
                    key={s.id}
                    draggable={renamingId !== s.id}
                    onDragStart={(e) => {
                      dragIdRef.current = s.id
                      didDragRef.current = true
                      setDragId(s.id)
                      e.dataTransfer.effectAllowed = 'move'
                      // Firefox 需要 setData 才能启动拖拽
                      e.dataTransfer.setData('text/plain', s.id)
                    }}
                    onDragOver={(e) => {
                      if (dragIdRef.current === null || dragIdRef.current === s.id) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      setDragOverId(s.id)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragIdRef.current !== null && dragIdRef.current !== s.id) {
                        reorderSessions(dragIdRef.current, s.id)
                      }
                      dragIdRef.current = null
                      setDragId(null)
                      setDragOverId(null)
                    }}
                    onDragEnd={() => {
                      dragIdRef.current = null
                      setDragId(null)
                      setDragOverId(null)
                      // 延迟清除标记，让 onClick 能检测到刚发生过拖拽
                      setTimeout(() => { didDragRef.current = false }, 0)
                    }}
                    onClick={() => {
                      if (didDragRef.current) return
                      switchToSession(s.id)
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '6px 8px',
                      borderRadius: 8,
                      cursor: 'grab',
                      marginBottom: 2,
                      background: isActive ? 'rgba(134, 168, 255, 0.13)' : 'transparent',
                      opacity: isDragging ? 0.4 : 1,
                      borderTop: isDragOver ? '2px solid #86a8ff' : '2px solid transparent',
                      transition: 'background 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive && !isDragging) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <HolderOutlined
                      style={{ fontSize: 12, color: '#5a6472', flexShrink: 0, cursor: 'grab' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }} onDoubleClick={() => setRenamingId(s.id)}>
                      {renamingId === s.id ? (
                        <Input
                          size="small"
                          autoFocus
                          defaultValue={s.title}
                          onClick={(e) => e.stopPropagation()}
                          onPressEnter={(e) => {
                            renameSession(s.id, (e.target as HTMLInputElement).value)
                            setRenamingId(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          onBlur={(e) => {
                            renameSession(s.id, e.target.value)
                            setRenamingId(null)
                          }}
                          style={{ fontSize: 13, height: 24 }}
                        />
                      ) : (
                        <>
                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: isActive ? 600 : 400,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              color: s.pinned ? '#f2c46d' : undefined,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                            title="双击重命名"
                          >
                            {sendingIds.has(s.id) && (
                              <LoadingOutlined style={{ fontSize: 11, color: '#86a8ff', flexShrink: 0 }} />
                            )}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title || '新会话'}</span>
                          </div>
                          <div style={{ fontSize: 11, color: '#8993a2' }}>{relTime(s.updatedAt)}</div>
                        </>
                      )}
                    </div>
                    <Button
                      size="small"
                      type="text"
                      icon={s.pinned ? <PushpinFilled style={{ color: '#f2c46d' }} /> : <PushpinOutlined />}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleSessionPin(s.id)
                      }}
                      style={{ flexShrink: 0, padding: '0 4px' }}
                    />
                    <Popconfirm
                      title="删除这条会话？"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={(e) => {
                        e?.stopPropagation()
                        deleteSessionById(s.id)
                      }}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={(e) => e.stopPropagation()}
                        style={{ flexShrink: 0, padding: '0 4px' }}
                      />
                    </Popconfirm>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* 对话上下文 */}
          <Card size="small" title="对话上下文" style={{ marginTop: 12 }}>
            <p style={{ fontSize: 12, color: '#8993a2', marginBottom: 8 }}>
              AI 自动携带你的练习数据汇总（含问题分布统计）与弱项画像。
            </p>
            <Select
              style={{ width: '100%' }}
              placeholder="关联训练计划（可选）"
              value={planId}
              allowClear
              onClear={() => updateActiveSessionPlanId(undefined)}
              onChange={(v) => updateActiveSessionPlanId(v)}
              options={plans.map((p) => ({ value: p.id, label: p.title }))}
            />
            <p style={{ fontSize: 12, color: '#8993a2', margin: '8px 0 0' }}>
              关联后可让 AI 直接修改该计划（应用前会向你确认）。
            </p>
          </Card>

          {/* 估算能力值 */}
          <Card
            size="small"
            title="估算能力值"
            style={{ marginTop: 12 }}
            extra={
              ability?.override ? (
                <Button size="small" type="link" onClick={() => void resetAbility()}>
                  恢复计算值
                </Button>
              ) : undefined
            }
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
            ) : abilityError ? (
              <span style={{ fontSize: 12, color: '#f2c46d' }}>
                加载失败，<a onClick={loadAbility}>重试</a>
              </span>
            ) : (
              <Spin size="small" />
            )}
          </Card>
        </div>

        {/* 聊天主区 */}
        <div className="assistant-main">
          <div className="plan-chat-msgs">
            {messages.length === 0 && !sending && (
              <div style={{ color: '#8993a2', fontSize: 13, padding: '32px 16px', textAlign: 'center' }}>
                <RobotOutlined style={{ fontSize: 32, display: 'block', marginBottom: 12 }} />
                试试这样问：<br />
                「我哪个知识点最弱？该怎么补？」<br />
                「这段代码为什么 TLE：粘贴你的代码」<br />
                「根据我的刷题情况帮我重新估算能力值」<br />
                「把这段思路沉淀成模板记到模板库」{planId !== undefined ? '「把计划里下周改成图论专题」' : ''}
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
              const tplAdds = extractTemplateAdd(m.content)
              const hasTpl = tplAdds.length > 0
              let text = stripModifyBlock(m.content)
              if (abilityUpd) text = stripAbilityUpdate(text)
              if (hasTpl) text = stripTemplateAdd(text)
              // 旧消息用 m.applied 表示模板已写入（向后兼容：无 appliedTpl 时视为该消息模板均已应用）
              const appliedTpl =
                m.applied === true && !m.appliedTpl ? tplAdds.map((_, j) => j) : (m.appliedTpl ?? [])
              const appliedTplSet = new Set(appliedTpl)
              const pendingTplCount = tplAdds.length - appliedTpl.length
              return (
                <div key={i} className="plan-chat-msg plan-chat-msg-assistant">
                  <Markdown text={text} />
                  {(modify || abilityUpd || hasTpl) && (
                    <Space style={{ marginTop: 8 }} wrap>
                      {modify && (
                        <Button
                          size="small"
                          type="primary"
                          disabled={m.applied}
                          onClick={() => void openPlanApply(m.content)}
                        >
                          {m.applied ? '已应用' : '应用计划修改'}
                        </Button>
                      )}
                      {abilityUpd &&
                        (abilityUpd.level === ability?.effective ? (
                          <span style={{ fontSize: 12, color: 'var(--text-3, #8993a2)' }}>
                            建议值 {abilityUpd.level} 与当前生效值相同，无需重复更新
                          </span>
                        ) : (
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            disabled={m.applied}
                            onClick={() => void confirmAbility(abilityUpd, m.content)}
                          >
                            更新能力值为 {abilityUpd.level}
                          </Button>
                        ))}
                      {hasTpl &&
                        tplAdds.map((draft, j) => {
                          const applied = appliedTplSet.has(j)
                          return (
                            <Button
                              key={j}
                              size="small"
                              type="primary"
                              ghost
                              disabled={applied}
                              loading={tplWriting.has(tplKey(i, j))}
                              onClick={() => void confirmTemplate(draft, i, j)}
                            >
                              {applied ? `✓ 已写入：${draft.name}` : `写入模板库：「${draft.name}」`}
                            </Button>
                          )
                        })}
                      {hasTpl && pendingTplCount > 1 && (
                        <Button
                          size="small"
                          type="primary"
                          loading={tplAdds.some(
                            (_, j) => !appliedTplSet.has(j) && tplWriting.has(tplKey(i, j)),
                          )}
                          onClick={() => void confirmAllTemplates(tplAdds, i)}
                        >
                          全部写入（{pendingTplCount}）
                        </Button>
                      )}
                    </Space>
                  )}
                </div>
              )
            })}
            {sending &&
              (!messages.some((m) => m.role === 'assistant' && m.content !== '') ||
                messages[messages.length - 1]?.role !== 'assistant') && (
              <div className="plan-chat-msg plan-chat-msg-assistant">
                <Spin size="small" />
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="plan-chat-input">
            <Input.TextArea
              value={input}
              onChange={(e) => setChatState((prev) => ({ ...prev, input: e.target.value }))}
              placeholder="向 AI 教练提问…（可粘贴代码）Enter 发送，Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 6 }}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            {sending ? (
              <Button
                danger
                onClick={() => stopSending(activeId)}
              >
                停止
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<SendOutlined />}
                disabled={!input.trim()}
                onClick={() => void send()}
              />
            )}
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
