import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, App as AntdApp, Button, Card, Dropdown, Input, Modal, Select, Space, Spin, Tag, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import {
  CheckOutlined,
  CloudDownloadOutlined,
  CloseOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  HolderOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoreOutlined,
  PaperClipOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  RightOutlined,
  RobotOutlined,
  SearchOutlined,
  SelectOutlined,
  SendOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  applyAbility,
  applyPlanModification,
  chatWithAssistantStream,
  generateSessionTitle,
  get,
  post,
  put,
  uploadAiFile,
  extractDocumentText,
  type AbilityInfo,
  type ChatFileAttachment,
  type PlanApplyResult,
  type PlanChatTurn,
  type TokenUsage,
} from '../api'
import type { ParticipatedContest, PlanListItem } from '../types'
import type { AiProviderView, ModelCaps } from '../../../shared/src/index.ts'
import Markdown from '../components/Markdown'
import PageHeader from '../components/PageHeader'
import SessionMiniPanel from '../components/SessionMiniPanel'
import {
  commandPrompt,
  commandReady,
  matchChatCommands,
  parseChatCommand,
  type ChatCommand,
} from '../chatCommands'
import { platformName } from '../ui'
import { createStreamBuffer } from '../streamBuffer'
import { rememberSessionFiles, getSessionFileText, forgetSessionFiles } from './sessionFiles'
import { moveSessionBy, pinFirstOrder, restoreSessionOrder, sessionIdOrder } from './assistantSessionOrder'
import { sanitizeOutgoingTurns, describeToolStatus, EMPTY_REPLY_NOTICE } from './assistantTurns'
import {
  aggregateSessionStats,
  contextPercent,
  fmtTokenCount,
  fmtTokPerSec,
  SpeedTracker,
} from './assistantStats'
import {
  resolveTemplateTarget,
  templateCategoryLabel,
  type TemplateCategoryOption,
} from '../templateTarget'
import {
  REVIEW_REQUEST_TEXT,
  contestJumpWarning,
  reviewRequestText,
} from './assistantContest'
import {
  extractAbilityUpdate,
  extractModifyBlock,
  extractTemplateAdd,
  stripAbilityUpdate,
  stripModifyBlock,
  stripTemplateAdd,
  type TemplateAddDraft,
  extractListCreate,
  stripListCreate,
  type ListCreateDraft,
  extractPlanCreate,
  stripPlanCreate,
  type PlanCreateDraft,
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
  /** 该消息的 list-create 块是否已导入题单 */
  appliedList?: boolean
  /** 该消息的 plan-create 块是否已生成训练计划 */
  appliedPlan?: boolean
  /** AI 的思维链内容（reasoning_content，如 DeepSeek-R1 / o1 模型） */
  reasoning?: string
  /** 本次回复的 token 用量（服务端 usage 事件） */
  usage?: TokenUsage
  /** 本轮流式生成实测时长（首 delta → 末 delta，毫秒）：与 usage 配合算真实 tok/s */
  durationMs?: number
  /** 该助手消息是一次失败回合（API 报错 / 空中止）：再次编辑时会被剔除，不回传给模型 */
  failed?: boolean
}
interface ChatSession {
  id: string
  title: string
  messages: ChatMsg[]
  planId: number | undefined
  listId: number | undefined
  /** 赛后复盘关联的比赛（ParticipatedContest.key，如 codeforces:1877），持久化在会话上 */
  contestKey?: string
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

/** /api/settings 的 ai 切片（只取状态栏与模型下拉用到的字段；密钥字段不触碰） */
interface AssistantAiView {
  model?: string
  /** 上下文窗口（token，含输入+输出）：「上下文占用 %」的分母，缺省由 contextPercent 自行兜底 */
  contextWindow?: number
  activeProviderId?: string
  providers?: AiProviderView[]
}

/** 待发送附件（含图片本地预览用的 blob URL）：previewUrl 只活在这条消息发出/移除前，
 *  绝不进会话存储与请求体（请求只需 fileId，blob URL 刷新即失效） */
interface PendingAtt extends ChatFileAttachment {
  previewUrl?: string
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
        listId: typeof s.listId === 'number' ? s.listId : undefined,
        contestKey: typeof s.contestKey === 'string' && s.contestKey !== '' ? s.contestKey : undefined,
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
    const toSave = sessions
      .filter((s) => s.messages.length > 0)
      .slice(0, MAX_SESSIONS)
      .map((s) => ({
        ...s,
        // dataUrl 是内存里的内联图片（base64 动辄数 MB）：只活在本次页面会话，绝不落盘
        messages: s.messages.map((m) =>
          m.attachments?.some((a) => a.dataUrl !== undefined)
            ? { ...m, attachments: m.attachments.map(({ dataUrl: _d, ...rest }) => rest) }
            : m,
        ),
      }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
  } catch {
    /* localStorage 可能不可用或已满，静默忽略 */
  }
}

// ---------- 模块级 store ----------

function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function createSession(planId?: number, listId?: number, contestKey?: string): ChatSession {
  const now = Date.now()
  return {
    id: newSessionId(),
    title: '新会话',
    messages: [],
    planId,
    listId,
    contestKey,
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

/** 进行中的会话 → 流式速率采样器（tok/s 估算）；生成结束/中止后在 finally 中移除 */
const sessionSpeedTrackers = new Map<string, SpeedTracker>()

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

/**
 * 键盘排序：把 `id` 对应会话上移/下移一格（拖拽的无障碍替代，§6.2）。
 * 返回是否真的移动了 —— 越界时为 false，调用方据此不弹撤销提示。
 */
function moveSession(id: string, delta: -1 | 1): boolean {
  const before = chatState.sessions
  const next = moveSessionBy(before, id, delta)
  if (!next) return false
  // CAS：仅当期间没人动过列表时才落盘，避免覆盖并发的增删/切换
  setChatState((prev) => (prev.sessions === before ? { ...prev, sessions: next } : prev))
  return true
}

/** 撤销键盘/拖拽排序：按 id 序列还原顺序；列表已增删（id 对不上）时返回 false */
function restoreSessionOrderByIds(orderedIds: string[]): boolean {
  const before = chatState.sessions
  const next = restoreSessionOrder(before, orderedIds)
  if (!next) return false
  setChatState((prev) => (prev.sessions === before ? { ...prev, sessions: next } : prev))
  return true
}

function deleteSessionById(id: string): void {
  // 若该会话正在生成，中止其流式请求
  sessionAbortControllers.get(id)?.abort()
  sessionAbortControllers.delete(id)
  forgetSessionFiles(id) // 同步清理该会话的附件内容缓存
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

function updateActiveSessionListId(listId: number | undefined): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === prev.activeId ? { ...s, listId } : s)),
  }))
}

function updateActiveSessionContestKey(contestKey: string | undefined): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === prev.activeId ? { ...s, contestKey } : s)),
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

// ---------- 消息结构化块解析（带缓存） ----------

interface MsgBlocks {
  modify: string | null
  abilityUpd: { level: number; reason?: string } | null
  tplAdds: TemplateAddDraft[]
  listDraft: ListCreateDraft | null
  planDraft: PlanCreateDraft | null
  /** 剥掉所有结构化块之后、留给 Markdown 渲染的正文 */
  text: string
}

/**
 * 解析结果按消息对象缓存。
 *
 * 流式输出时 store 每帧都会更新一次消息数组，map 里每条助手消息都要跑六组 regex
 * （计划修改 / 能力值 / 模板 / 题单 / 训练计划 + 对应的剥离）。历史消息的内容根本
 * 没变，却跟着每帧重扫 —— 消息一多这就是纯粹的白工。消息对象引用不变时用缓存直接
 * 返回（WeakMap，消息被丢弃后自动回收）。
 */
const blockCache = new WeakMap<ChatMsg, { content: string; blocks: MsgBlocks }>()

function parseMessageBlocks(m: ChatMsg): MsgBlocks {
  const cached = blockCache.get(m)
  if (cached && cached.content === m.content) return cached.blocks

  const modify = extractModifyBlock(m.content)
  const abilityUpd = extractAbilityUpdate(m.content)
  const tplAdds = extractTemplateAdd(m.content)
  const listDraft = extractListCreate(m.content)
  const planDraft = extractPlanCreate(m.content)

  let text = stripModifyBlock(m.content)
  if (abilityUpd) text = stripAbilityUpdate(text)
  if (tplAdds.length > 0) text = stripTemplateAdd(text)
  if (listDraft) text = stripListCreate(text)
  if (planDraft) text = stripPlanCreate(text)

  const blocks: MsgBlocks = { modify, abilityUpd, tplAdds, listDraft, planDraft, text }
  blockCache.set(m, { content: m.content, blocks })
  return blocks
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

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 内联附图的单张上限：6 MiB 原图 ≈ 8MiB base64，给 12MB 的请求体限额留足余量 */
const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024

/** File → data:image/...;base64（上传降级为内联图片时用） */
function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(f)
  })
}

// ---------- 左侧栏折叠 ----------

/** 折叠状态持久化：切页/刷新后保持用户的选择（localStorage 不可用时仅本次会话生效） */
const SIDE_COLLAPSED_KEY = 'icpc-assistant-side-collapsed'

/** 右侧对话导航的收起状态：同样持久化，默认展开 */
const TOC_HIDDEN_KEY = 'icpc-assistant-toc-hidden'

function readTocHidden(): boolean {
  try {
    return localStorage.getItem(TOC_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 对话导航条目的摘要：取首个非空行的前 40 字；纯附件提问回退到附件名。
 * 用户靠「我当时问了什么」认条目，长代码块的首行往往就是问题本身。
 */
function turnExcerpt(m: ChatMsg): string {
  const firstLine =
    (m.content ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  if (firstLine) return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
  const att = m.attachments?.[0]?.filename
  return att ? `📎 ${att}` : '（图片提问）'
}

/**
 * 会话排序「撤销」提示的固定 message key：同一 key 会被 antd 替换而非叠加，
 * 连续点上下移时不会堆出一摞提示（与 SiderMenu 的 msgKeyRef 思路一致，但这里更简单）。
 */
const SESSION_ORDER_MSG_KEY = 'assistant-session-order'

function readSideCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDE_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

// ---------- 组件 ----------

export default function Assistant() {
  const { message, modal } = AntdApp.useApp()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const chat = useSyncExternalStore(subscribeChat, getChatSnapshot)
  const { sessions, activeId, input, sendingIds } = chat
  const activeSession = sessions.find((s) => s.id === activeId)
  const messages = activeSession?.messages ?? []
  const planId = activeSession?.planId
  const listId = activeSession?.listId
  const contestKey = activeSession?.contestKey
  const sending = sendingIds.has(activeId)

  /**
   * 折叠态迷你栏要展示的信息（P3-5）：
   * - 当前会话首字当作"图标"，让收起后仍能认出会话切换过没有；
   * - 当前会话里的附件总数（图片/文件是用户手动传的，收起来后最容易忘了它在哪个会话）；
   * - 是否正在流式生成（多会话可并行，「它还在写」必须能看见）。
   */
  const railAttachments = messages.reduce((n, m) => n + (m.attachments?.length ?? 0), 0)
  const railInitial = (activeSession?.title ?? '新').trim().slice(0, 1) || '新'
  // 置顶会话浮动到列表前部（组内保持手动顺序）；store 数组不动，拖拽/撤销仍按手动顺序运作
  const orderedSessions = useMemo(() => pinFirstOrder(sessions), [sessions])
  const miniSessions = useMemo(
    () =>
      orderedSessions.map((s) => ({
        id: s.id,
        title: s.title,
        pinned: s.pinned,
        turns: s.messages.length,
        streaming: sendingIds.has(s.id),
      })),
    [orderedSessions, sendingIds],
  )

  /**
   * `/` 快捷指令（P3-5）：输入框以 `/` 开头时在它上方浮出候选，↑↓ 选择、Enter 执行、Esc 忽略。
   * 菜单只在「确实是命令」时出现 —— 解析不出来就照常当普通消息发出去，绝不静默吞掉输入。
   */
  const cmdCandidates = useMemo(() => matchChatCommands(input), [input])
  const [cmdIndex, setCmdIndex] = useState(0)
  const [cmdDismissed, setCmdDismissed] = useState(false)
  const cmdMenuOpen = cmdCandidates.length > 0 && !cmdDismissed
  // 候选变了就把高亮收回范围，避免停在一个已经不存在的项上
  useEffect(() => {
    setCmdIndex((i) => (i < cmdCandidates.length ? i : 0))
  }, [cmdCandidates.length])
  // 输入不再是命令态时，重新允许弹出菜单（Esc 只忽略当前这一次）
  useEffect(() => {
    if (cmdCandidates.length === 0) setCmdDismissed(false)
  }, [cmdCandidates.length])

  /** 执行一条指令；需要参数却没给时只补全命令名，等用户填完再按 Enter */
  const runChatCommand = (cmd: ChatCommand) => {
    const parsed = parseChatCommand(input)
    const arg = parsed?.command.name === cmd.name ? parsed.arg : ''
    if (!commandReady(cmd, arg)) {
      setChatState((prev) => ({ ...prev, input: commandPrompt(cmd) }))
      return
    }
    switch (cmd.name) {
      case 'new':
        createNewSession()
        break
      case 'attach':
        fileInputRef.current?.click()
        break
      // 题目/模板复用命令面板已经打通的 ?q= 深链，落到对应页面的搜索态
      case 'problem':
        nav(`/problems?q=${encodeURIComponent(arg)}`)
        break
      case 'template':
        nav(`/templates?q=${encodeURIComponent(arg)}`)
        break
      case 'today':
        nav('/today')
        break
      case 'settings':
        nav('/settings')
        break
      default:
        break
    }
    setChatState((prev) => ({ ...prev, input: '' }))
  }

  const [plans, setPlans] = useState<PlanListItem[]>([])
  /** 题单列表（关联上下文下拉用，只要 id/标题/题数） */
  const [problemLists, setProblemLists] = useState<Array<{ id: number; title: string; item_count: number }>>([])
  /** 参加过的比赛（赛后复盘下拉用）：从提交记录推导，加载失败时静默为空列表 */
  const [contests, setContests] = useState<ParticipatedContest[]>([])
  const [ability, setAbility] = useState<AbilityInfo | null>(null)
  const [abilityError, setAbilityError] = useState(false)
  const [needConfig, setNeedConfig] = useState(false)
  const [applyTarget, setApplyTarget] = useState<{ planId: number; raw: string; planTitle: string } | null>(null)
  const [applying, setApplying] = useState(false)
  const [tplWriting, setTplWriting] = useState<Set<string>>(new Set())
  const [listCreating, setListCreating] = useState(false)
  const [planCreating, setPlanCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  /** 折叠态浮层里会话 ⋯ 菜单的打开态：打开期间锁定浮层，portal 菜单才够得着 */
  const [miniActionsOpen, setMiniActionsOpen] = useState(false)
  /** 删除会话的统一确认入口：展开侧行与折叠态浮层共用（React 19 下静态 Modal.confirm 静默失效，必须用 App 上下文实例） */
  const confirmDeleteSession = (id: string) => {
    modal.confirm({
      title: '删除这条会话？',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => deleteSessionById(id),
    })
  }
  /** 模板库分类清单（内置课程分类 + 用户自建标签）：写入模板库时选目标标签用 */
  const [tplCategories, setTplCategories] = useState<TemplateCategoryOption[]>([])
  /** 用户为某个 template-add 草稿显式指定的目标标签（key = `${消息下标}:${草稿下标}`） */
  const [tplTargets, setTplTargets] = useState<Record<string, string>>({})
  /** 当前正在跑的工具体（属于哪个会话 + 文案）：正文输出完后 AI 还在检索/抓网页时的进度提示 */
  const [toolStatus, setToolStatus] = useState<{ sessionId: string; text: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  /** 左侧栏折叠：会话记录/上下文/能力值收成一条窄栏，把宽度让给对话区 */
  const [sideCollapsed, setSideCollapsed] = useState(readSideCollapsed)
  /** 拖拽源 id（ref 即时读写，不依赖 state 异步更新） */
  const dragIdRef = useRef<string | null>(null)
  /** 消息列表可滚动容器：判断用户是否在底部附近，也是自动滚动的作用对象 */
  const msgsRef = useRef<HTMLDivElement>(null)
  /** 用户是否在底部附近（true 时流式更新自动滚到底，false 时不打断用户上滑查看） */
  const stickToBottomRef = useRef(true)
  /** 输入框引用：「再次编辑」时把历史消息回填并聚焦输入框 */
  const inputRef = useRef<TextAreaRef>(null)
  /** 划选 AI 输出后的「引用到输入框」浮钮：x/y 为浮钮中心（viewport 坐标），text 是选区快照 */
  const [quoteFloat, setQuoteFloat] = useState<{ x: number; y: number; text: string } | null>(null)

  // ---------- 右侧对话导航（快速跳转） ----------
  /** 导航栏收起状态（持久化）；会话没有任何 user 消息时整个导航不渲染 */
  const [tocHidden, setTocHidden] = useState(readTocHidden)
  /** 滚动联动：当前视口顶部最近的那条 user 消息下标（导航里高亮） */
  const [activeTurnIdx, setActiveTurnIdx] = useState<number | null>(null)
  /** 点击跳转后目标消息的短暂高亮 */
  const [jumpFlashIdx, setJumpFlashIdx] = useState<number | null>(null)
  const spyRafRef = useRef(0)
  const flashTimerRef = useRef(0)
  /** 跳转锁定：点击条目后高亮锁定到该轮，直到锁定期过后用户再次滚动（对齐文档侧栏目录的行为） */
  const pinnedTurnRef = useRef<{ idx: number; until: number } | null>(null)

  const toggleToc = useCallback(() => {
    setTocHidden((h) => {
      try {
        localStorage.setItem(TOC_HIDDEN_KEY, h ? '0' : '1')
      } catch {
        /* localStorage 不可用时仅本次会话生效 */
      }
      return !h
    })
  }, [])

  /**
   * 滚动联动（scroll spy）：找出视口顶部 96px 线以上的最后一条 user 消息。
   * scroll 事件 60Hz 触发，用 rAF 合并到每帧一次；无变化时不 setState。
   */
  const scheduleSpy = useCallback(() => {
    if (spyRafRef.current) return
    spyRafRef.current = requestAnimationFrame(() => {
      spyRafRef.current = 0
      const container = msgsRef.current
      if (!container) return
      // 跳转锁定期内不重算：平滑滚动本身会触发一串 scroll 事件，若按滚动位置重算，
      // 点靠近底部的条目（滚动被钳制、目标到不了顶部线）高亮会立刻弹回别的轮次
      const pin = pinnedTurnRef.current
      if (pin) {
        if (Date.now() < pin.until) {
          setActiveTurnIdx((prev) => (prev === pin.idx ? prev : pin.idx))
          return
        }
        pinnedTurnRef.current = null
      }
      const cTop = container.getBoundingClientRect().top
      let active: number | null = null
      container.querySelectorAll<HTMLElement>('.plan-chat-msg[data-role="user"]').forEach((node) => {
        if (node.getBoundingClientRect().top - cTop <= 96) {
          const idx = Number(node.dataset.msgIndex)
          if (Number.isFinite(idx)) active = idx
        }
      })
      setActiveTurnIdx((prev) => (prev === active ? prev : active))
    })
  }, [])

  useEffect(
    () => () => {
      // ⚠ 取消后必须把引用归零：StrictMode 双挂载会先卸载一次，若留着旧 id，
      // scheduleSpy 的 `if (spyRafRef.current) return` 会把之后所有调度永久挡掉
      if (spyRafRef.current) {
        cancelAnimationFrame(spyRafRef.current)
        spyRafRef.current = 0
      }
      if (flashTimerRef.current) {
        window.clearTimeout(flashTimerRef.current)
        flashTimerRef.current = 0
      }
    },
    [],
  )

  /** 跳转到第 idx 条消息：滚动使其贴近视口顶部，锁定高亮并短暂描边 */
  const jumpToTurn = (idx: number) => {
    const container = msgsRef.current
    if (!container) return
    const node = container.querySelector<HTMLElement>(`.plan-chat-msg[data-msg-index="${idx}"]`)
    if (!node) return
    const delta = node.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTo({ top: container.scrollTop + delta - 12, behavior: 'smooth' })
    pinnedTurnRef.current = { idx, until: Date.now() + 1500 }
    setActiveTurnIdx(idx)
    setJumpFlashIdx(idx)
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => {
      setJumpFlashIdx(null)
      flashTimerRef.current = 0
    }, 1400)
  }

  // ---------- 图片附件（Files API） ----------
  /** 本条消息待发送的附件（上传成功后的 file_id 引用） */
  const [pendingAtts, setPendingAtts] = useState<PendingAtt[]>([])
  const [uploadingAtts, setUploadingAtts] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 释放并清空待发送附件（图片 blob URL 必须 revoke，否则整页生命周期内泄漏内存） */
  const clearPendingAtts = () => {
    setPendingAtts((prev) => {
      // StrictMode 下 updater 会跑两次：revokeObjectURL 对已释放的 URL 幂等，无副作用
      prev.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl))
      return []
    })
  }

  /** 移除单个待发送附件（连带释放其预览 URL） */
  const removePendingAtt = (index: number) => {
    const target = pendingAtts[index]
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    setPendingAtts((prev) => prev.filter((_, j) => j !== index))
  }

  // 切换会话时清空未发送的附件，避免串会话
  useEffect(() => {
    clearPendingAtts()
    // 选区随消息列表一起换掉了，浮钮位置失效
    setQuoteFloat(null)
    // 导航高亮与跳转锁定都属于旧会话，一并清掉（滚动联动随后按新会话重算）
    pinnedTurnRef.current = null
    setActiveTurnIdx(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  // ---------- 划选 AI 输出 → 引用到输入框 ----------
  /** mouseup / 键盘划选（Shift+方向键）结束时检查选区：落在助手消息内才浮出引用钮。
   *  选区文本在触发时就快照进 state —— 点击浮钮时原生选区往往已被收起，靠快照而非
   *  当时的 window.getSelection 才拿得到内容。 */
  useEffect(() => {
    const readAssistantSelection = (): { text: string; rect: DOMRect } | null => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
      const anchor = sel.anchorNode
      const el = anchor instanceof Element ? anchor : anchor?.parentElement
      // 只认助手消息里的划选：引用的前提是「这是 AI 说的」
      if (!el || !msgsRef.current?.contains(el) || !el.closest('.plan-chat-msg-assistant')) return null
      const text = sel.toString().trim()
      if (!text) return null
      return { text, rect: sel.getRangeAt(0).getBoundingClientRect() }
    }
    const showAt = (hit: { text: string; rect: DOMRect } | null) => {
      if (!hit) {
        setQuoteFloat(null)
        return
      }
      // 水平居中于选区并夹在视口内；选区贴着顶时浮钮改挂到选区下方
      const x = Math.min(Math.max(hit.rect.left + hit.rect.width / 2, 100), window.innerWidth - 100)
      const y = hit.rect.top > 64 ? hit.rect.top - 44 : hit.rect.bottom + 10
      setQuoteFloat({ x, y, text: hit.text })
    }
    const onMouseUp = (e: MouseEvent) => {
      // 点在浮钮自身上时不能收走它：mouseup 先于 click 到达，收走了 click 就落空
      if (e.target instanceof Element && e.target.closest('.selection-quote-btn')) return
      showAt(readAssistantSelection())
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!e.shiftKey && !['Shift', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
      showAt(readAssistantSelection())
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  /** 把划选文本作为 markdown 引用块（> 逐行前缀）附到输入框末尾：
      渲染出来是一段引用，AI 与用户都一眼看出「问的是这段」 */
  const quoteSelectionToInput = () => {
    if (!quoteFloat) return
    const quoted = quoteFloat.text
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    setChatState((prev) => {
      const base = prev.input
      const sep = base.length === 0 ? '' : base.endsWith('\n') ? '\n' : '\n\n'
      return { ...prev, input: `${base}${sep}${quoted}\n` }
    })
    setQuoteFloat(null)
    window.getSelection()?.removeAllRanges()
    // 光标落到输入框末尾：引用完接着打字就是提问
    requestAnimationFrame(() => {
      const ta = inputRef.current?.resizableTextArea?.textArea
      if (ta) {
        ta.focus()
        const end = ta.value.length
        ta.setSelectionRange(end, end)
      } else {
        inputRef.current?.focus()
      }
    })
  }

  // ---------- 左侧栏折叠 ----------
  /** 折叠/展开左侧栏（fold/unfold 图标与全局侧边栏保持一致） */
  const toggleSideCollapsed = useCallback(() => {
    setSideCollapsed((c) => {
      try {
        localStorage.setItem(SIDE_COLLAPSED_KEY, c ? '0' : '1')
      } catch {
        /* localStorage 不可用时仅本次会话生效 */
      }
      return !c
    })
  }, [])

  // ---------- 文件上传 ----------
  /** 图片 MIME 类型：走 Files API 上传，以 file 内容块引用 */
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
  /** 文本类扩展名：直接读取内容以代码块注入消息文本，不依赖 Files API */
  const TEXT_EXTENSIONS = [
    '.txt', '.md', '.markdown', '.py', '.cpp', '.c', '.cc', '.cxx', '.h', '.hpp',
    '.java', '.kt', '.rs', '.go', '.js', '.ts', '.jsx', '.tsx', '.rb', '.php',
    '.sh', '.bash', '.zsh', '.sql', '.json', '.xml', '.yaml', '.yml', '.toml',
    '.csv', '.tsv', '.html', '.css', '.scss', '.less', '.vue', '.svelte',
    '.swift', '.m', '.scala', '.clj', '.ex', '.exs', '.erl', '.hs', '.lua',
    '.pl', '.r', '.dart', '.groovy', '.gradle', '.cmake', '.makefile',
    '.gitignore', '.dockerfile', '.env', '.ini', '.cfg', '.conf', '.properties',
  ]
  /** 文本文件大小上限：1 MiB（避免注入过多文本撑爆上下文窗口） */
  const MAX_TEXT_FILE_BYTES = 1024 * 1024
  /** PDF 文件大小上限：10 MiB（服务端用 unpdf 提取文本，上限与服务端一致） */
  const MAX_PDF_FILE_BYTES = 10 * 1024 * 1024
  /** 文档文件（Word/Excel/PPT/HTML/CSV/JSON/XML/EPub）大小上限：20 MiB */
  const MAX_DOC_FILE_BYTES = 20 * 1024 * 1024
  /** 服务端 docConverter 支持的文档扩展名（走 /extract-text 提取文本） */
  const DOCUMENT_EXTENSIONS = [
    '.docx', '.xlsx', '.pptx', '.html', '.htm', '.csv', '.json', '.xml', '.epub',
  ]

  const isImageFile = (f: File): boolean =>
    IMAGE_TYPES.includes(f.type) || /\.(jpe?g|png|gif|webp)$/i.test(f.name)

  const isTextFile = (f: File): boolean => {
    if (isImageFile(f)) return false
    if (f.type.startsWith('text/')) return true
    const lower = f.name.toLowerCase()
    return TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
  }

  const isPdfFile = (f: File): boolean =>
    f.type === 'application/pdf' || /\.pdf$/i.test(f.name)

  /** 文档文件（Word/Excel/PPT/HTML/CSV/JSON/XML/EPub）：走服务端 docConverter 提取 */
  const isDocumentFile = (f: File): boolean => {
    const lower = f.name.toLowerCase()
    return DOCUMENT_EXTENSIONS.some((ext) => lower.endsWith(ext))
  }

  const handlePickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const all = Array.from(files)
    // 分流：图片走 Files API，文本直接读取内容，PDF + 文档走服务端提取
    const images = all.filter(isImageFile)
    const pdfs = all.filter(isPdfFile)
    const docs = all.filter((f) => !isImageFile(f) && !isPdfFile(f) && isDocumentFile(f))
    const texts = all.filter((f) => !isImageFile(f) && !isPdfFile(f) && !isDocumentFile(f) && isTextFile(f))
    const unsupported = all.filter((f) => !isImageFile(f) && !isPdfFile(f) && !isDocumentFile(f) && !isTextFile(f))

    if (unsupported.length > 0) {
      message.warning(`不支持的文件：${unsupported.map((f) => f.name).join('、')}（支持图片、文本/代码、PDF、Word、Excel、PPT、HTML、CSV、JSON、XML、EPub）`)
    }

    // 三个分支共享 8 个配额：pendingAtts 是本次调用开始时的渲染闭包快照，前一个分支
    // setPendingAtts 之后后一个分支仍按旧值算 room——一次混选 5 文本 + 5 图片能加到 13 个，
    // 故用本地计数器跨分支累计（分支间还有 await，不能指望 state 刷新）
    let usedSlots = pendingAtts.length

    // 文本文件：读取内容作为附件（与图片统一管理，显示为可删除标签）
    if (texts.length > 0) {
      const textAtts: ChatFileAttachment[] = []
      for (const f of texts) {
        if (f.size > MAX_TEXT_FILE_BYTES) {
          message.warning(`「${f.name}」超过 1 MiB，已跳过（文本文件上限 1 MiB）`)
          continue
        }
        try {
          const text = await f.text()
          textAtts.push({
            fileId: `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            filename: f.name,
            bytes: f.size,
            textContent: text,
          })
        } catch {
          message.error(`读取「${f.name}」失败`)
        }
      }
      if (textAtts.length > 0) {
        const room = 8 - usedSlots
        const picked = textAtts.slice(0, room)
        if (picked.length < textAtts.length) message.warning('每条消息最多附带 8 个文件')
        if (picked.length > 0) {
          usedSlots += picked.length
          setPendingAtts((prev) => [...prev, ...picked])
          message.success(`已添加 ${picked.length} 个文本文件`)
        }
      }
    }

    // PDF + 文档文件：走服务端提取文本，作为文本附件注入
    const extractable = [...pdfs, ...docs]
    if (extractable.length > 0) {
      setUploadingAtts(true)
      try {
        const docAtts: ChatFileAttachment[] = []
        for (const f of extractable) {
          const maxBytes = isPdfFile(f) ? MAX_PDF_FILE_BYTES : MAX_DOC_FILE_BYTES
          const label = isPdfFile(f) ? 'PDF' : '文档'
          if (f.size > maxBytes) {
            message.warning(`「${f.name}」超过 ${maxBytes / 1024 / 1024} MiB，已跳过（${label}文件上限）`)
            continue
          }
          try {
            const { text, warning } = await extractDocumentText(f)
            if (warning) message.warning(`「${f.name}」：${warning}`)
            if (!text) continue
            docAtts.push({
              fileId: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              filename: f.name,
              bytes: f.size,
              textContent: text,
            })
          } catch (e) {
            message.error(`提取「${f.name}」文本失败：${(e as Error).message}`)
          }
        }
        if (docAtts.length > 0) {
          const room = 8 - usedSlots
          const picked = docAtts.slice(0, room)
          if (picked.length < docAtts.length) message.warning('每条消息最多附带 8 个文件')
          if (picked.length > 0) {
            usedSlots += picked.length
            setPendingAtts((prev) => [...prev, ...picked])
            message.success(`已提取 ${picked.length} 个文档文件`)
          }
        }
      } finally {
        setUploadingAtts(false)
      }
    }

    // 图片文件：走 Files API 上传
    if (images.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    const room = 8 - usedSlots
    const picked = images.slice(0, room)
    if (picked.length < images.length) message.warning('每条消息最多附带 8 个文件')
    if (picked.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setUploadingAtts(true)
    try {
      const uploaded: PendingAtt[] = []
      const inlined: PendingAtt[] = []
      for (const f of picked) {
        try {
          const obj = await uploadAiFile(f)
          // 本地 blob 预览：请求体里只有 file_id，预览图仅用于待发送区的缩略显示
          uploaded.push({ fileId: obj.id, filename: obj.filename || f.name, bytes: obj.bytes, previewUrl: URL.createObjectURL(f) })
        } catch {
          // 聚合网关普遍没有 Files API（/files 404）：降级为内联 base64 图片，
          // 服务端将其转为 image_url 内容块——主流 OpenAI 兼容网关都支持
          if (f.size > MAX_INLINE_IMAGE_BYTES) {
            message.error(`上传「${f.name}」失败：图片超过 6 MiB，且当前网关不支持文件上传接口`)
            continue
          }
          try {
            const dataUrl = await fileToDataUrl(f)
            inlined.push({
              fileId: `data-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              filename: f.name,
              bytes: f.size,
              dataUrl,
              // data URL 可直接作 img src，无需另建 blob URL
              previewUrl: dataUrl,
            })
          } catch {
            message.error(`读取「${f.name}」失败，无法内联附图`)
          }
        }
      }
      if (uploaded.length > 0) {
        usedSlots += uploaded.length
        setPendingAtts((prev) => [...prev, ...uploaded])
        message.success(`已上传 ${uploaded.length} 个图片`)
      }
      if (inlined.length > 0) {
        const room = 8 - usedSlots
        const pickedInline = inlined.slice(0, room)
        if (pickedInline.length < inlined.length) message.warning('每条消息最多附带 8 个文件')
        if (pickedInline.length > 0) {
          usedSlots += pickedInline.length
          setPendingAtts((prev) => [...prev, ...pickedInline])
          message.info(`当前 AI 网关不支持文件上传，已改用内联方式附图（${pickedInline.length} 张）`)
        }
      }
    } finally {
      setUploadingAtts(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ---------- 粘贴上传 ----------
  /**
   * 输入框内粘贴截图 / 复制的图片文件 → 直接进附件区（与拖拽、附件按钮同一上传通道）。
   *
   * 只拦「纯图片」粘贴：剪贴板里同时有文本（复制网页/带说明的截图工具）时原样放行，
   * 避免 preventDefault 把用户要粘的代码/说明吞掉；普通文本粘贴完全不受影响。
   * 上传进行中不受理：handlePickFiles 按渲染闭包里的 pendingAtts 算剩余配额，
   * 并发两批会把 8 个附件的上限数错。
   */
  const handlePasteUpload = (e: React.ClipboardEvent) => {
    if (uploadingAtts) return
    if ((e.clipboardData?.getData('text/plain') ?? '').trim() !== '') return
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null)
    if (files.length === 0) return
    e.preventDefault()
    void handlePickFiles(files as unknown as FileList)
  }

  // ---------- 拖拽上传 ----------
  /** 拖拽文件进入聊天区域时显示遮罩 */
  const [dragOver, setDragOver] = useState(false)
  /** 防止 dragleave 误触发（子元素进出）：用计数器而非布尔 */
  const dragCounter = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // 仅处理文件拖入（非内部元素拖拽）
    if (!e.dataTransfer?.types?.includes('Files')) return
    dragCounter.current++
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // dragover 必须 preventDefault 否则浏览器默认行为会阻止 drop
    e.preventDefault()
    e.stopPropagation()
  }, [])

  // 不 memo：handlePickFiles 每次渲染都是新版本（它读当前的 pendingAtts 算剩余配额），
  // 一旦被 useCallback 冻在首次渲染上，「每条消息最多 8 个附件」的上限就从拖拽口被绕开
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return
    // 过滤：仅接受支持的文件类型（handlePickFiles 内部会二次校验并提示不支持的文件）
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => isImageFile(f) || isTextFile(f) || isPdfFile(f) || isDocumentFile(f),
    )
    if (files.length === 0) {
      message.warning('不支持的文件类型（支持图片、文本/代码、PDF、Word、Excel、PPT、HTML、CSV、JSON、XML、EPub）')
      return
    }
    void handlePickFiles(files as unknown as FileList)
  }

  // 拖拽中松手在列表外时清除状态（mouse 事件方案，兼容 WebView2/WKWebView）
  useEffect(() => {
    if (dragId === null) return
    const onGlobalMouseUp = () => {
      dragIdRef.current = null
      setDragId(null)
      setDragOverId(null)
    }
    document.addEventListener('mouseup', onGlobalMouseUp)
    return () => document.removeEventListener('mouseup', onGlobalMouseUp)
  }, [dragId])

  /**
   * 会话排序后的「撤销」提示（§6.2 验收标准：3 秒内可撤销）。
   * beforeIds 是操作前的 id 序列；撤销时按 id 还原 —— 到点没点就自然消失，无需额外清理。
   */
  const showSessionUndo = (beforeIds: string[]) => {
    message.open({
      key: SESSION_ORDER_MSG_KEY,
      type: 'success',
      duration: 3,
      content: (
        <span>
          已调整会话顺序
          <Button
            type="link"
            size="small"
            icon={<UndoOutlined />}
            onClick={() => {
              message.destroy(SESSION_ORDER_MSG_KEY)
              if (restoreSessionOrderByIds(beforeIds)) message.info('已恢复排序前的顺序')
              // 3 秒窗口内新建/删除过会话：旧快照对不上，明确告知而不是半截还原
              else message.warning('会话列表已变化，无法撤销')
            }}
          >
            撤销
          </Button>
        </span>
      ),
    })
  }

  /** 键盘排序：上移/下移一格；真的移动了才给撤销入口 */
  const handleSessionMove = (id: string, delta: -1 | 1) => {
    const before = sessionIdOrder(sessions)
    if (moveSession(id, delta)) showSessionUndo(before)
  }

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
    get<Array<{ id: number; title: string; item_count: number }>>('/api/lists')
      .then((lists) => {
        setProblemLists(lists)
        setChatState((prev) => {
          const active = prev.sessions.find((s) => s.id === prev.activeId)
          if (active?.listId !== undefined && !lists.some((l) => l.id === active.listId)) {
            return {
              ...prev,
              sessions: prev.sessions.map((s) =>
                s.id === prev.activeId ? { ...s, listId: undefined } : s,
              ),
            }
          }
          return prev
        })
      })
      .catch(() => {})
    // 模板库分类清单（含用户自建标签）：写入模板库前让用户能指定目标标签。
    // 加载失败静默降级 —— 此时不显示选择器，仍按 AI 给的 categoryKey 写入。
    get<{ categories: TemplateCategoryOption[] }>('/api/templates/categories')
      .then(({ categories }) => setTplCategories(categories))
      .catch(() => {})
    // 参加过的比赛（赛后复盘）：加载失败静默为空。?contest=<key> 从赛事中心
    // 「去 AI 复盘」跳转而来：新建专属会话（不占用当前会话）并预填复盘请求；
    // 推导不出该场时**不静默丢弃**——明确提示原因并保留预填文本（用户可手动选场）；
    // 悬空 contestKey（数据清理/换账号后推导不出该场）同样清理，避免失效关联
    get<{ contests: ParticipatedContest[] }>('/api/contests/participated')
      .then(({ contests: list }) => {
        setContests(list)
        const urlContest = searchParams.get('contest')
        if (urlContest !== null) setSearchParams({}, { replace: true })
        const jumped = urlContest ? list.find((c) => c.key === urlContest) : undefined
        if (jumped) {
          const session = createSession(undefined, undefined, jumped.key)
          setChatState((prev) => ({
            ...prev,
            sessions: [session, ...prev.sessions],
            activeId: session.id,
            input: reviewRequestText(jumped),
          }))
          return
        }
        if (urlContest) {
          message.warning(contestJumpWarning(urlContest))
          // 保留预填文本：跳转意图不落空，用户选好场次即可直接发送
          setChatState((prev) => (prev.input.trim() ? prev : { ...prev, input: REVIEW_REQUEST_TEXT }))
        }
        setChatState((prev) => {
          const active = prev.sessions.find((s) => s.id === prev.activeId)
          if (active?.contestKey !== undefined && !list.some((c) => c.key === active.contestKey)) {
            return {
              ...prev,
              sessions: prev.sessions.map((s) =>
                s.id === prev.activeId ? { ...s, contestKey: undefined } : s,
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

  // ---------- AI 配置视图（模型切换 + 上下文占用） ----------
  /**
   * /api/settings 的 ai 切片：模型下拉（目录 / 切换提供商）与「上下文占用 %」的数据源。
   * 切换模型后重拉一次，芯片上的名字与目录勾选保持一致。
   */
  const [aiInfo, setAiInfo] = useState<AssistantAiView | null>(null)
  const [switchingModel, setSwitchingModel] = useState(false)
  const loadAiInfo = useCallback(() => {
    get<{ ai: AssistantAiView }>('/api/settings')
      .then((s) => setAiInfo(s.ai))
      .catch(() => {})
  }, [])
  useEffect(loadAiInfo, [loadAiInfo])

  /**
   * 面板内拉取的网关模型目录（按提供商 id 缓存）：提供商没建模型目录时也能直接在此面板
   * 选模型，不必先去设置页「获取可用模型」。打不开面板不会触发请求；拉取失败记录原因，
   * 在「拉取」项上就地显示并可点击重试（打开面板时的自动拉取不弹 toast）。
   */
  const [gwCatalog, setGwCatalog] = useState<Record<string, { ids: string[]; caps?: Record<string, ModelCaps> }>>({})
  const [gwErrors, setGwErrors] = useState<Record<string, string>>({})
  const [fetchingProviderId, setFetchingProviderId] = useState<string | null>(null)
  /** 面板顶部搜索框的过滤词：网关动辄返回两三百个模型，不筛根本点不到目标 */
  const [modelFilter, setModelFilter] = useState('')

  const fetchGatewayModels = useCallback(
    async (providerId: string) => {
      if (fetchingProviderId !== null) return
      setFetchingProviderId(providerId)
      try {
        const r = await post<{ models: string[]; caps?: Record<string, ModelCaps> }>('/api/settings/ai/models', {
          providerId,
        })
        setGwCatalog((prev) => ({ ...prev, [providerId]: { ids: r.models ?? [], caps: r.caps } }))
        setGwErrors((prev) => {
          if (!(providerId in prev)) return prev
          const next = { ...prev }
          delete next[providerId]
          return next
        })
      } catch (e) {
        setGwErrors((prev) => ({ ...prev, [providerId]: (e as Error).message }))
      } finally {
        setFetchingProviderId(null)
      }
    },
    [fetchingProviderId],
  )

  /** 打开面板且提供商没有模型目录时自动拉一次网关列表（失败就地标记，不弹 toast）；
   *  关闭面板时清掉过滤词，避免下次打开面对一个被旧关键词筛空的列表 */
  const onModelMenuOpenChange = (open: boolean) => {
    if (!open) {
      setModelFilter('')
      return
    }
    const provider = aiInfo?.providers?.find((p) => p.id === aiInfo.activeProviderId)
    if (
      provider &&
      !(provider.models?.length) &&
      !gwCatalog[provider.id] &&
      !(provider.id in gwErrors) &&
      fetchingProviderId === null
    ) {
      void fetchGatewayModels(provider.id)
    }
  }

  /** 切换活跃提供商或其模型（POST /api/settings/ai/providers/active）：全局配置，成功后重拉视图 */
  const switchAiModel = async (providerId: string, model?: string) => {
    if (switchingModel) return
    setSwitchingModel(true)
    try {
      await post('/api/settings/ai/providers/active', { id: providerId, ...(model ? { model } : {}) })
      message.success(model ? `已切换到模型 ${model}` : '已切换提供商')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSwitchingModel(false)
      loadAiInfo()
    }
  }

  /** 模型下拉：活跃提供商的模型目录（勾选当前）→ 网关可用模型 → 其他提供商 → 设置页入口。
   *  顶部搜索词过滤模型条目（目录与网关列表都筛），操作类条目（拉取/切提供商/设置）不受影响 */
  const modelMenu: MenuProps = useMemo(() => {
    const items: MenuProps['items'] = []
    const kw = modelFilter.trim().toLowerCase()
    const match = (id: string) => kw === '' || id.toLowerCase().includes(kw)
    const provider = aiInfo?.providers?.find((p) => p.id === aiInfo.activeProviderId)
    if (provider) {
      const catalog = provider.models ?? []
      const gw = gwCatalog[provider.id]
      const gwError = gwErrors[provider.id]
      // 网关目录与手建目录去重；拉取失败时不用旧缓存，避免展示过期列表
      const gwIds = gw && !gwError ? gw.ids.filter((id) => !catalog.some((m) => m.id === id)) : []
      const catalogHits = catalog.filter((m) => match(m.id))
      const gwHits = gwIds.filter((id) => match(id))
      const currentVisible = match(provider.model)
      if (catalog.length > 0) {
        if (catalogHits.length > 0) {
          items.push({ type: 'group', label: `${provider.name} · 模型目录` })
          for (const m of catalogHits) {
            items.push({
              key: `model:${provider.id}:${m.id}`,
              icon: m.id === provider.model ? <CheckOutlined /> : <span className="chat-model-check-holder" />,
              label: m.id,
            })
          }
        }
      } else if (!(gwHits.includes(provider.model) && provider.model !== '') && currentVisible) {
        // 当前模型没被（过滤后的）网关列表覆盖时单独展示，保证「现在用的是哪个」一眼可见
        items.push({ type: 'group', label: '当前模型' })
        items.push({
          key: 'model:none',
          disabled: true,
          icon: <CheckOutlined />,
          label: provider.model || '（未设置模型）',
        })
      }
      if (gwHits.length > 0) {
        items.push({ type: 'divider' })
        items.push({ type: 'group', label: '网关可用模型' })
        for (const id of gwHits) {
          const ctx = gw?.caps?.[id]?.contextWindow
          items.push({
            key: `model:${provider.id}:${id}`,
            icon: id === provider.model ? <CheckOutlined /> : <span className="chat-model-check-holder" />,
            label: ctx && ctx > 0
              ? (
                <span>
                  {id}
                  <span className="chat-model-menu-ctx">{fmtTokenCount(ctx)} 上下文</span>
                </span>
              )
              : id,
          })
        }
      }
      if (kw !== '' && catalogHits.length === 0 && gwHits.length === 0 && !currentVisible) {
        items.push({ key: 'model:nomatch', disabled: true, label: '没有匹配的模型' })
      }
      items.push({ type: 'divider' })
      items.push({
        key: 'fetch-models',
        icon: fetchingProviderId === provider.id ? <LoadingOutlined /> : <CloudDownloadOutlined />,
        disabled: fetchingProviderId !== null,
        label: gwError ? '拉取失败，点击重试' : gwCatalog[provider.id] ? '刷新网关模型列表' : '拉取网关模型列表',
        ...(gwError ? { title: gwError } : {}),
      })
      const others = (aiInfo?.providers ?? []).filter((p) => p.id !== provider.id)
      if (others.length > 0) {
        items.push({ type: 'divider' })
        items.push({ type: 'group', label: '切换提供商' })
        for (const p of others) {
          items.push({ key: `provider:${p.id}`, label: `${p.name}（${p.model}）` })
        }
      }
    } else if (aiInfo?.model) {
      items.push({ key: 'model:none', disabled: true, icon: <CheckOutlined />, label: aiInfo.model })
    }
    items.push({ type: 'divider' }, { key: 'settings', icon: <SettingOutlined />, label: '到设置页管理模型' })
    return { items }
  }, [aiInfo, gwCatalog, gwErrors, fetchingProviderId, modelFilter])

  const onModelMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'settings') {
      nav('/settings')
      return
    }
    if (key === 'fetch-models') {
      const provider = aiInfo?.providers?.find((p) => p.id === aiInfo.activeProviderId)
      if (provider) void fetchGatewayModels(provider.id)
      return
    }
    // model key 形如 `model:{providerId}:{modelId}`——模型 id 理论上可含冒号，用 rest 重组
    const [kind, id, ...rest] = key.split(':')
    if (kind === 'model' && id) void switchAiModel(id, rest.join(':') || undefined)
    else if (kind === 'provider' && id) void switchAiModel(id)
  }

  // ---------- 会话状态栏（轮数/消息 · tok/s · 累计 token/缓存命中 · 上下文占用） ----------
  // 直接算不 memo：O(消息数) 的轻量求和，比 memo 化带来的依赖警告便宜
  const sessionStats = aggregateSessionStats(messages)
  // 流式进行中读采样窗口的估算速度（delta 落库即重渲染，数字跟着流走）；空闲时用上一轮真实值
  const liveTok = sending ? (sessionSpeedTrackers.get(activeId)?.liveTokPerSec() ?? null) : null
  const tokPerSec = fmtTokPerSec(liveTok ?? sessionStats.lastTokPerSec)
  const contextPct = contextPercent(sessionStats.lastPromptTokens, aiInfo?.contextWindow)
  const showModelChip = !!aiInfo && ((aiInfo.model ?? '') !== '' || (aiInfo.providers?.length ?? 0) > 0)

  // ---------- 右侧对话导航数据 ----------
  const userTurns = messages
    .map((m, i) => (m.role === 'user' ? { idx: i, msg: m } : null))
    .filter((t): t is { idx: number; msg: ChatMsg } => t !== null)

  /**
   * 流式更新时只在用户已在底部附近时才跟随，不打断上滑查看历史。
   *
   * 三个关键点：
   *   1. 流式期间直接写 scrollTop 而不是 scrollIntoView({behavior:'smooth'})。
   *      平滑滚动是一段异步动画，每来一帧就新起一段，动画互相打断就会看到滚动条
   *      来回抽搐（"滚动跳动"）；而且 scrollIntoView 会把所有可滚动祖先一起滚。
   *      直接赋值是同步的，配合上面的节流，看起来就是匀速往下走。
   *   2. 只有"会话内追加消息 / 生成结束"这类一次性变化才用平滑滚动 —— 那种场景下
   *      内容是一大块跳变的，用动画过渡更自然。
   *   3. 进入会话（页面挂载 / 切换会话）的第一次对位必须瞬时：组件每次进页都重新
   *      挂载，若也走平滑滚动，整段对话就会当着用户的面从顶滚到底放一遍动画。
   *      useLayoutEffect 在绘制前同步赋值，首帧即落在底部，看不到任何滚动过程。
   *
   * 用 useLayoutEffect：在浏览器绘制前就把位置调好，避免"内容先画在视口外、
   * 下一帧才滚过去"造成的一帧跳动。
   */
  const lastAlignSessionRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    // 消息变化后同步一次导航高亮（切会话/新消息都会走到这里）
    scheduleSpy()
    // 先记账再判断：本次要不要滚与是否在底部无关，会话标识必须每次都更新
    const isSessionEntry = lastAlignSessionRef.current !== activeId
    lastAlignSessionRef.current = activeId
    const el = msgsRef.current
    if (!el || !stickToBottomRef.current) return
    if (sending || isSessionEntry) {
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, sending, scheduleSpy, activeId])

  const send = async () => {
    const text = input.trim()
    const atts = pendingAtts
    if ((!text && atts.length === 0) || sendingIds.has(activeId)) return
    // 发新消息时恢复自动滚动到底部
    stickToBottomRef.current = true
    const sessionId = activeId
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return

    // 发送给服务端的附件（含 textContent）：剥离本地预览的 blob URL（请求只需 fileId）
    const attsForSend = atts.map(({ previewUrl: _p, ...rest }) => rest)
    // 附件全文入会话级缓存：后续任意轮次发送时从缓存回填，AI 不会"忘记"已上传文件
    rememberSessionFiles(sessionId, attsForSend)
    // 存入会话历史的附件（剥离 textContent 避免 localStorage 爆满；previewUrl 同样不入库）
    const attsForStore = atts.map(({ textContent: _tc, previewUrl: _p, ...rest }) => rest)
    const userMsg: ChatMsg = {
      role: 'user',
      content: text,
      ...(attsForStore.length > 0 ? { attachments: attsForStore } : {}),
    }
    const nextMessages: ChatMsg[] = [...session.messages, userMsg]
    /**
     * 送出前的历史清洗（issue 36）：本地历史里可能残留 content 为空的 assistant 轮次
     * （模型偶发空回复留下的）。旧服务端会因为这一条空轮次整体拒绝请求，导致该会话
     * 之后每一轮都发不出去。本地仍保留它（用户能看到自己发过什么），只是不发给模型。
     */
    const outgoingMessages = sanitizeOutgoingTurns(nextMessages)
    const sendPlanId = session.planId
    const sendListId = session.listId
    const sendContestKey = session.contestKey

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
              title: s.messages.length === 0 ? (text || userMsg.attachments?.[0]?.filename || '新会话').slice(0, 30) : s.title,
              updatedAt: Date.now(),
            }
          : s,
      ),
    }))
    // 附件已并入消息：释放本地预览的 blob URL 并清空待发送区
    clearPendingAtts()
    setNeedConfig(false)

    // 每次发送创建独立的 AbortController，支持用户主动停止生成
    const ac = new AbortController()
    sessionAbortControllers.set(sessionId, ac)
    // 流式速率采样器：生成中给状态栏提供 tok/s 估算，结束时按 usage 折算整轮真实 tok/s
    const speedTracker = new SpeedTracker()
    sessionSpeedTrackers.set(sessionId, speedTracker)

    /**
     * 流式增量先攒起来再批量写库：
     * 一个 token 一次 setState 会让 React 每秒重渲染上百次（每次都要重解析整段
     * Markdown + 重排公式），攒批后压到每秒十几次，肉眼依然连贯。
     * 正文与思维链共用一个定时器，同帧到达也只触发一次重渲染。
     */
    const buf = createStreamBuffer(({ delta, reasoning }) => {
      if (!delta && !reasoning) return
      // 采样本轮字符增量（正文 + 思维链都是模型产出）：状态栏 tok/s 估算的数据源
      speedTracker.push(delta.length + reasoning.length)
      // 正文重新开始输出 = 工具阶段结束，清掉「正在检索…」进度（否则会一直挂在输入栏）
      if (delta) setToolStatus((cur) => (cur && cur.sessionId === sessionId ? null : cur))
      patchActiveSessionMessages(sessionId, (msgs) => {
        const last = msgs[msgs.length - 1]
        if (!last || last.role !== 'assistant') return msgs
        return [
          ...msgs.slice(0, -1),
          {
            ...last,
            ...(delta ? { content: last.content + delta } : {}),
            ...(reasoning ? { reasoning: (last.reasoning ?? '') + reasoning } : {}),
          },
        ]
      })
    })

    try {
      // 先种一条空 assistant 消息，流式 delta 逐字追加到它
      patchActiveSessionMessages(sessionId, (msgs) => [
        ...msgs,
        { role: 'assistant', content: '' },
      ])

      const result = await chatWithAssistantStream(
        {
          messages: outgoingMessages.map(({ role, content, attachments }, idx) => ({
            role,
            content,
            // 带附件的消息：最后一条用本轮新附件全文；历史消息从会话缓存回填全文
            // （textContent 已从消息存储剥离，缓存让 AI 在后续轮次仍记得文件内容）
            ...(attachments && attachments.length > 0
              ? {
                  attachments: attachments
                    .map((a) => ({
                      ...a,
                      textContent:
                        idx === outgoingMessages.length - 1
                          ? attsForSend.find((x) => x.fileId === a.fileId)?.textContent
                          : getSessionFileText(sessionId, a.fileId),
                    }))
                    // 图片附件（file-api-…）必须保留（textContent 恒空）；内联图片（dataUrl）
                    // 同样保留——后续轮次把图重新带给模型；仅剔除"本地文本附件但缓存未命中/
                    // 超出容量"的残缺项
                    .filter((a) => a.fileId.startsWith('file-') || a.textContent !== undefined || a.dataUrl !== undefined),
                }
              : {}),
          })),
          ...(sendPlanId !== undefined ? { planId: sendPlanId } : {}),
          ...(sendListId !== undefined ? { listId: sendListId } : {}),
          ...(sendContestKey !== undefined ? { contestKey: sendContestKey } : {}),
        },
        (delta) => buf.pushDelta(delta),
        ac.signal,
        (reasoningChunk) => buf.pushReasoning(reasoningChunk),
        // 工具执行进度：正文输出完但 AI 还在检索/抓网页时，界面显示进度而不是只剩「停止生成」
        (status) => setToolStatus({ sessionId, text: describeToolStatus(status.name, status.detail) }),
      )
      // 流已结束：先把缓冲里剩下的内容落库，再处理用量/截断等收尾信息，
      // 否则这些内容会被追加到"还没有最后一段文字"的消息上
      buf.flush()
      // token 用量 + 整轮实测时长：写入最后一条 assistant 消息（状态栏展示 tok/s / 上下文占用）
      if (result.usage) {
        const durationMs = speedTracker.finalizeDurationMs()
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant') {
            return [
              ...msgs.slice(0, -1),
              { ...last, usage: result.usage!, ...(durationMs > 0 ? { durationMs } : {}) },
            ]
          }
          return msgs
        })
      }
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
      // 对话历史被摘要：提示用户早期对话已压缩为摘要
      if (result.summarized) {
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant') {
            return [
              ...msgs.slice(0, -1),
              { ...last, content: `${last.content}\n\n> 📝 **对话历史较长，已自动摘要 ${result.droppedCount} 条早期对话以适配上下文窗口，关键信息已保留。**` },
            ]
          }
          return msgs
        })
      } else if (result.contextTrimmed > 0) {
        // 对话历史被裁剪：提示用户上下文窗口偏小，最早的消息已丢弃
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

      // 模型返回了空回复（无正文，可能只有思考内容）：必须留下可见痕迹。
      // 空 Markdown 渲染出来就是一片空白 —— 用户看到的「发了问题但没有任何输出」正是这种，
      // 而且旧服务端会因为这条空轮次拒绝该会话之后的所有请求（issue 36）。
      patchActiveSessionMessages(sessionId, (msgs) => {
        const last = msgs[msgs.length - 1]
        if (last && last.role === 'assistant' && last.content.trim() === '') {
          return [...msgs.slice(0, -1), { ...last, content: EMPTY_REPLY_NOTICE, failed: true }]
        }
        return msgs
      })

      // 会话标题自动生成：首条消息发送后（原标题为默认/截断）异步生成更好的标题
      if (session.messages.length === 0) {
        const titleMsgs = [{ role: 'user' as const, content: text || '图片提问' }]
        generateSessionTitle(titleMsgs)
          .then((title) => {
            if (title && title !== '新会话') {
              renameSession(sessionId, title)
            }
          })
          .catch(() => {
            // 标题生成失败：静默回退到首条消息截断（已在上方设置），不阻断对话
          })
      }
    } catch (e) {
      // ⚠ 先把缓冲里剩下的字落库，再写「已停止/报错」的收尾标记。JS 保证 catch 先于 finally 执行，
      // 而 dispose() 就是 flush：留在 finally 里会把停止前最后几十毫秒收到的正文追加到标记**之后**
      //（看起来像「停止之后还在续写」）；错误分支更糟 —— ⚠️ 消息刚被追加成最后一条，
      // 残留正文会被 append 进那个错误气泡里。成功路径同理，见上面 stream 结束处的 buf.flush()。
      buf.dispose()
      // 用户主动停止生成：保留已收到内容，不报错
      if (ac.signal.aborted) {
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant' && last.content === '') {
            return [...msgs.slice(0, -1), { ...last, content: '（已停止生成）', failed: true }]
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
            return [...msgs.slice(0, -1), { ...last, content: `⚠️ ${err.message}`, failed: true }]
          }
          return [...msgs, { role: 'assistant', content: `⚠️ ${err.message}`, failed: true }]
        })
      }
    } finally {
      // 兜底：正常路径已在 stream 结束处 flush、异常/中止路径已在 catch 开头 dispose，
      // 这里对空缓冲是 no-op（保留它以免将来新增分支漏掉收尾）
      buf.dispose()
      sessionAbortControllers.delete(sessionId)
      sessionSpeedTrackers.delete(sessionId)
      setToolStatus((cur) => (cur && cur.sessionId === sessionId ? null : cur))
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

  /**
   * 该草稿最终写入的目标标签：用户显式选择 > AI 给的 categoryKey（有效时）> 第一个分类。
   * 用户反馈「无法指定 AI 把模板放到哪个标签下」——选择器与这里的解析共同保证
   * 用户点名的标签（含自己新建的自建标签）一定被原样写入。
   */
  const templateTargetOf = (msgIndex: number, draftIndex: number, draft: TemplateAddDraft): string =>
    resolveTemplateTarget({
      aiKey: draft.categoryKey,
      chosen: tplTargets[tplKey(msgIndex, draftIndex)],
      categories: tplCategories,
    })

  /** 写入单个模板草稿（不弹 toast，供单条/批量复用），返回是否成功。
   *  有 templateId → 完善已有内置模板（PUT /api/templates/:id/content）；
   *  无 templateId → 新建自定义模板（POST /api/templates/custom） */
  const writeOneTemplate = async (
    draft: TemplateAddDraft,
    msgIndex: number,
    draftIndex: number,
  ): Promise<boolean> => {
    const key = tplKey(msgIndex, draftIndex)
    setTplWriting((prev) => new Set(prev).add(key))
    try {
      if (draft.templateId) {
        // 完善已有内置模板条目：写入 code/idea/complexity/url 到 template_progress
        await put(`/api/templates/${draft.templateId}/content`, {
          code: draft.code,
          idea: draft.idea,
          complexity: draft.complexity,
          url: draft.url,
        })
      } else {
        // 新建自定义模板：目标标签取「用户选择器里的选择 → AI 给的 key → 兜底」（见 templateTargetOf）
        await post('/api/templates/custom', {
          categoryKey: templateTargetOf(msgIndex, draftIndex, draft),
          name: draft.name,
          difficulty: draft.difficulty,
          tags: draft.tags,
          code: draft.code,
          idea: draft.idea,
          complexity: draft.complexity,
          url: draft.url,
        })
      }
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
      message.success(
        draft.templateId
          ? `「${draft.name}」模板内容已完善，到「模板库」页可查看`
          : `「${draft.name}」已写入模板库，到「模板库」页可继续完善`,
      )
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

  const confirmListCreate = async (draft: ListCreateDraft, msgIndex: number) => {
    setListCreating(true)
    try {
      const result = await post<{ ok: boolean; id: number; imported: number; unrecognized: number }>(
        '/api/lists',
        { title: draft.title, raw: draft.raw, sourceUrl: draft.sourceUrl },
      )
      if (result.unrecognized > 0) {
        message.warning(`题单「${draft.title}」已创建，导入 ${result.imported} 题，${result.unrecognized} 题未识别`)
      } else {
        message.success(`题单「${draft.title}」已创建，导入 ${result.imported} 题，到「题单整理」页可查看`)
      }
      patchActiveSessionMessages(activeId, (msgs) =>
        msgs.map((m, i) => (i === msgIndex ? { ...m, appliedList: true } : m)),
      )
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setListCreating(false)
    }
  }

  const confirmPlanCreate = async (draft: PlanCreateDraft, msgIndex: number) => {
    setPlanCreating(true)
    try {
      const result = await post<{ ok: boolean; planId: number; title: string; taskCount: number }>(
        '/api/plans/import',
        { raw: draft.raw, startDate: draft.startDate, days: draft.days },
      )
      message.success(`训练计划「${result.title}」已创建（${result.taskCount} 个任务），到「训练计划」页可查看`)
      patchActiveSessionMessages(activeId, (msgs) =>
        msgs.map((m, i) => (i === msgIndex ? { ...m, appliedPlan: true } : m)),
      )
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setPlanCreating(false)
    }
  }

  const openPlanApply = (raw: string) => {
    if (planId === undefined) {
      message.warning('AI 回复包含计划修改，但当前未关联计划：请在左侧选择要修改的计划后让 AI 重新生成')
      return
    }
    // 计划可以中途改选（会话上方的下拉框），确认框必须点名要替换的是哪个计划，
    // 否则「应用旧回复」会把当前选中的另一个计划整体替换掉（其任务与打卡一并清除）
    setApplyTarget({ planId, raw, planTitle: plans.find((p) => p.id === planId)?.title ?? `计划 #${planId}` })
  }

  /**
   * 「再次编辑」：把指定用户消息回填到输入框，并截断该消息及其后的所有消息
   * （分支编辑语义，与主流聊天产品一致）。这样重发后不会出现"原对话 + 重复的新对话"
   * 两条几乎相同的对话。同时回填该消息当时的附件到输入区，重发时文件内容不丢。
   */
  const editUserMessage = (msgIndex: number) => {
    const userMsg = messages[msgIndex]
    if (!userMsg || userMsg.role !== 'user') return
    // 流式生成中禁止编辑：在途流按「最后一条 assistant 消息」追加增量，截断后它会把
    // 剩余 delta/usage/停止提示全部写进更早的历史回复（或空数组上静默丢失）
    if (sending) {
      message.warning('AI 正在生成回复：请先停止生成，再编辑历史消息')
      return
    }
    const content = userMsg.content ?? ''
    const atts = userMsg.attachments ?? []

    // 回填该消息的附件（图片附件缺 file-api 引用有效性，仍按原样回填；
    // 文本附件内容由会话缓存兜底，重发时仍带全文）
    if (atts.length > 0) {
      const existingIds = new Set(pendingAtts.map((a) => a.fileId))
      const restored = atts
        .filter((a) => !existingIds.has(a.fileId))
        .map((a) => ({
          fileId: a.fileId,
          filename: a.filename,
          bytes: a.bytes,
          textContent: getSessionFileText(activeId, a.fileId),
          // 内存里的内联图片还能重发；刷新后 dataUrl 已剥离，退化为普通附件标签
          previewUrl: a.dataUrl,
        }))
      // 与 handlePickFiles 三条分支同一配额：回填不截断就可能凑出 9+ 个附件，
      // send() 原样作为该 user 消息的 attachments 下发，服务端按「每条消息 1-8 个」整单 400
      //（实测提示为 attachments 需为 1-8 个的数组）——消息发不出去，用户不知道是附件多了一个
      const room = Math.max(0, 8 - pendingAtts.length)
      if (restored.length > room) message.warning('每条消息最多附带 8 个文件')
      const picked = restored.slice(0, room)
      if (picked.length > 0) setPendingAtts((prev) => [...prev, ...picked])
    }

    // 截断该用户消息及其后所有消息（含成功/失败回复）
    patchActiveSessionMessages(activeId, (msgs) => {
      if (msgIndex >= msgs.length) return msgs
      return msgs.slice(0, msgIndex)
    })

    setChatState((prev) => ({ ...prev, input: content }))
    inputRef.current?.focus()
  }

  return (
    <div>
      <PageHeader
        title="AI 助手"
        description="与 AI 教练自由对话：解答算法问题、调试代码、解读刷题数据；关联计划 / 题单 / 比赛后 AI 可直接动手。"
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
      <div className={`assistant-layout${sideCollapsed ? ' is-side-collapsed' : ''}`}>
        <div className="assistant-side">
          {/* 折叠按钮：收起后本栏只留这条窄边，把宽度让给对话区 */}
          <div className="assistant-side-head">
            <Tooltip title={sideCollapsed ? '展开侧栏' : '收起侧栏'} placement="right">
              <button
                type="button"
                className="assistant-side-toggle"
                aria-label={sideCollapsed ? '展开侧栏' : '收起侧栏'}
                aria-expanded={!sideCollapsed}
                onClick={toggleSideCollapsed}
              >
                {sideCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              </button>
            </Tooltip>
          </div>
          {/* 折叠态迷你栏（P3-5）：会话图标 + 附件/流式提示 + 新建入口；
              悬停或键盘聚焦时浮出完整会话列表，不必先展开侧栏。
              is-flyout-locked：浮层里 ⋯ 菜单打开期间锁住浮层显隐 —— 菜单渲染在 portal，
              鼠标移向它会离开 rail 触发区，不锁的话浮层带着触发按钮一起消失 */}
          <div className={`assistant-mini-rail${miniActionsOpen ? ' is-flyout-locked' : ''}`}>
            <Tooltip title={`${activeSession?.title ?? '新会话'} —— 点击展开侧栏`} placement="right">
              <button
                type="button"
                className="mini-rail-avatar"
                aria-label={`展开侧栏（当前会话：${activeSession?.title ?? '新会话'}）`}
                onClick={toggleSideCollapsed}
              >
                {railInitial}
                {sending && <LoadingOutlined className="mini-rail-stream" />}
                {railAttachments > 0 && (
                  <span className="mini-rail-badge" title={`当前会话有 ${railAttachments} 个附件`}>
                    {railAttachments}
                  </span>
                )}
              </button>
            </Tooltip>
            <Tooltip title="新建会话" placement="right">
              <button type="button" className="mini-rail-new" aria-label="新建会话" onClick={createNewSession}>
                <PlusOutlined />
              </button>
            </Tooltip>
            <div className="mini-rail-flyout">
              <SessionMiniPanel
                sessions={miniSessions}
                activeId={activeId}
                onSelect={switchToSession}
                onCreate={createNewSession}
                /* 折叠态也能键盘排序：与展开侧栏的会话行共用同一个撤销提示 */
                onMove={handleSessionMove}
                /* 折叠态同样能重命名/置顶/删除：与展开侧行共用 renamingId 与确认弹窗 */
                renamingId={renamingId}
                onRenameStart={setRenamingId}
                onRenameCommit={(id, title) => {
                  renameSession(id, title)
                  setRenamingId(null)
                }}
                onRenameCancel={() => setRenamingId(null)}
                onTogglePin={toggleSessionPin}
                onDeleteRequest={confirmDeleteSession}
                onActionsOpenChange={setMiniActionsOpen}
              />
            </div>
          </div>
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
              {orderedSessions.map((s) => {
                const isActive = s.id === activeId
                const isDragging = dragId === s.id
                const isDragOver = dragOverId === s.id && dragId !== null && dragId !== s.id
                return (
                  <div
                    key={s.id}
                    className="reorder-host"
                    onClick={() => switchToSession(s.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '6px 8px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      marginBottom: 2,
                      background: isActive ? 'var(--brand-soft)' : 'transparent',
                      opacity: isDragging ? 0.4 : 1,
                      borderTop: isDragOver ? '2px solid var(--brand)' : '2px solid transparent',
                      transition: 'background 0.15s',
                      userSelect: dragId !== null ? 'none' : undefined,
                    }}
                    onMouseEnter={(e) => {
                      // 拖拽中：标记当前行为放置目标；否则普通 hover
                      if (dragIdRef.current !== null && dragIdRef.current !== s.id) {
                        setDragOverId(s.id)
                      } else if (!isActive && !isDragging) {
                        e.currentTarget.style.background = 'var(--overlay-2)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (dragIdRef.current !== null) return
                      if (!isActive) e.currentTarget.style.background = 'transparent'
                    }}
                    onMouseUp={() => {
                      // 拖拽中松手在此行：执行排序（并留一条撤销入口）
                      if (dragIdRef.current !== null && dragIdRef.current !== s.id) {
                        const before = sessionIdOrder(sessions)
                        reorderSessions(dragIdRef.current, s.id)
                        showSessionUndo(before)
                      }
                      dragIdRef.current = null
                      setDragId(null)
                      setDragOverId(null)
                    }}
                  >
                    <HolderOutlined
                      style={{ fontSize: 12, color: 'var(--text-dim)', flexShrink: 0, cursor: 'grab' }}
                      onMouseDown={(e) => {
                        // 在手柄上按下鼠标：启动拖拽（阻止默认行为避免选中文本）
                        e.stopPropagation()
                        e.preventDefault()
                        dragIdRef.current = s.id
                        setDragId(s.id)
                      }}
                    />
                    {/* 行内只留拖拽手柄 + ⋯ 菜单：↑↓ 排序与拖拽功能重复，重命名/置顶/删除
                        是低频操作，收进菜单把宽度还给标题。⋯ 是真实按钮，键盘和触屏都够得着。 */}
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
                          {/* 双击重命名的提示：原生 title 悬停约 1 秒才出、无样式、键盘聚焦也不显示；
                              换成 Tooltip 后与行内「⋯ → 重命名」的入口保持同一套提示形态
                              （键盘用户的主路径是 ⋯ 菜单，这里是鼠标路径的提示） */}
                          <Tooltip title="双击重命名">
                            <div
                              style={{
                                fontSize: 13,
                                fontWeight: isActive ? 600 : 400,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                color: s.pinned ? 'var(--amber)' : undefined,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                            >
                              {sendingIds.has(s.id) && (
                                <LoadingOutlined style={{ fontSize: 11, color: 'var(--brand)', flexShrink: 0 }} />
                              )}
                              {s.pinned && (
                                <PushpinFilled style={{ fontSize: 11, color: 'var(--amber)', flexShrink: 0 }} />
                              )}
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title || '新会话'}</span>
                            </div>
                          </Tooltip>
                          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{relTime(s.updatedAt)}</div>
                        </>
                      )}
                    </div>
                    <Dropdown
                      trigger={['click']}
                      placement="bottomRight"
                      menu={{
                        items: [
                          { key: 'rename', icon: <EditOutlined />, label: '重命名' },
                          {
                            key: 'pin',
                            icon: s.pinned ? <PushpinFilled /> : <PushpinOutlined />,
                            label: s.pinned ? '取消置顶' : '置顶',
                          },
                          { type: 'divider' },
                          { key: 'delete', icon: <DeleteOutlined />, label: '删除', danger: true },
                        ],
                        onClick: ({ key, domEvent }) => {
                          domEvent.stopPropagation() // 不能顺带切换会话
                          if (key === 'rename') setRenamingId(s.id)
                          else if (key === 'pin') toggleSessionPin(s.id)
                          else if (key === 'delete') confirmDeleteSession(s.id)
                        },
                      }}
                    >
                      <Button
                        size="small"
                        type="text"
                        icon={<MoreOutlined />}
                        aria-label={`会话操作：「${s.title || '新会话'}」`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ flexShrink: 0, padding: '0 4px' }}
                      />
                    </Dropdown>
                  </div>
                )
              })}
            </div>
          </Card>

          {/* 对话上下文 */}
          <Card size="small" title="对话上下文" style={{ marginTop: 12 }}>
            <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
              AI 自动携带你的练习数据汇总与弱项画像。
            </p>
            {/* 三个关联入口的「关联了会发生什么」说明收进 ⓘ：一段四行的复盘说明
                在 260px 侧栏里要占十来行，悬停才需要知道细节的不必常驻 */}
            <div className="ctx-select-row">
              <Select
                style={{ flex: 1, minWidth: 0 }}
                placeholder="关联训练计划（可选）"
                value={planId}
                allowClear
                onClear={() => updateActiveSessionPlanId(undefined)}
                onChange={(v) => updateActiveSessionPlanId(v)}
                options={plans.map((p) => ({ value: p.id, label: p.title }))}
              />
              <Tooltip title="关联后 AI 可直接修改该计划；每次修改都会先向你确认，确认后才会应用。">
                <span className="ctx-help" aria-label="关联训练计划说明">
                  <InfoCircleOutlined />
                </span>
              </Tooltip>
            </div>
            <div className="ctx-select-row">
              <Select
                style={{ flex: 1, minWidth: 0 }}
                placeholder="关联题单整理（可选）"
                value={listId}
                allowClear
                onClear={() => updateActiveSessionListId(undefined)}
                onChange={(v) => updateActiveSessionListId(v)}
                options={problemLists.map((l) => ({
                  value: l.id,
                  label: `${l.title}（${l.item_count} 题）`,
                }))}
              />
              <Tooltip title="关联后 AI 会基于题单内容分析分类、推荐优先刷哪些题。">
                <span className="ctx-help" aria-label="关联题单说明">
                  <InfoCircleOutlined />
                </span>
              </Tooltip>
            </div>
            <div className="ctx-select-row">
              <Select
                style={{ flex: 1, minWidth: 0 }}
                placeholder="赛后复盘比赛（可选）"
                value={contestKey}
                allowClear
                showSearch
                optionFilterProp="label"
                onClear={() => updateActiveSessionContestKey(undefined)}
                onChange={(v) => {
                  updateActiveSessionContestKey(v)
                  // 选中即预填复盘请求（输入框已有草稿时不覆盖）：带上本场关键事实，
                  // 省去 AI 反问「哪一场、做了几题」
                  if (v && !input.trim()) {
                    const picked = contests.find((c) => c.key === v)
                    setChatState((prev) => ({
                      ...prev,
                      input: picked ? reviewRequestText(picked) : REVIEW_REQUEST_TEXT,
                    }))
                  }
                }}
                options={contests.map((c) => {
                  const label = c.name ?? `${platformName(c.platform)} · ${c.contestId}`
                  const d = new Date(c.startTimeIso ?? c.lastSubmittedAt)
                  const date = Number.isFinite(d.getTime()) ? ` · ${d.getMonth() + 1}/${d.getDate()}` : ''
                  const counts =
                    c.submissionCount === 0 ? '未同步提交' : `${c.problemCount} 题 AC ${c.acProblemCount}`
                  return {
                    value: c.key,
                    label: `${label}（${platformName(c.platform)}${date} · ${counts}）`,
                  }
                })}
                notFoundContent={
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    暂无可复盘的比赛——先到「题目管理」同步各平台提交记录
                  </span>
                }
              />
              <Tooltip title="选中后 AI 会拿到比赛链接与该场提交记录进行复盘。列表来自你的提交记录与各平台参赛记录（CF / AtCoder / 洛谷 / 牛客 / 计蒜客 / QOJ）；代码源、LeetCode 暂不支持；标注「未同步提交」的场次，AI 会结合平台排名成绩与比赛链接点评。">
                <span className="ctx-help" aria-label="赛后复盘说明">
                  <InfoCircleOutlined />
                </span>
              </Tooltip>
            </div>
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
                {/* 未调整时 effective 就是计算值，不重复报数；被 AI 调整过才给出计算值与理由 */}
                {ability.override ? (
                  <div style={{ fontSize: 12, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                    <Tag color="purple" style={{ marginInlineEnd: 0 }}>
                      AI 调整
                    </Tag>
                    <span>
                      计算值 {ability.computed}
                      {ability.override.reason ? ` · ${ability.override.reason}` : ''}
                    </span>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>加权解题证据估算</div>
                )}
              </>
            ) : abilityError ? (
              <span style={{ fontSize: 12, color: 'var(--amber)' }}>
                加载失败，<a onClick={loadAbility}>重试</a>
              </span>
            ) : (
              <Spin size="small" />
            )}
          </Card>
        </div>

        {/* 聊天主区 */}
        <div
          className="assistant-main"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div className="chat-dropzone">
              <div className="chat-dropzone-inner">
                <PaperClipOutlined style={{ fontSize: 40, marginBottom: 12 }} />
                <div style={{ fontSize: 15, fontWeight: 500 }}>松开以添加文件</div>
                <div style={{ fontSize: 12, marginTop: 4, opacity: 0.7 }}>
                  图片（JPEG/PNG/GIF/WebP ≤64MiB）、文本/代码（≤1MiB）或文档（PDF/Word/Excel/PPT/HTML/CSV/JSON/XML/EPub ≤20MiB）
                </div>
              </div>
            </div>
          )}
          {quoteFloat && (
            /* 划选 AI 输出后的浮钮：fixed 定位挂 viewport 坐标，避开任何祖先 overflow 裁剪 */
            <button
              type="button"
              className="selection-quote-btn"
              style={{ left: quoteFloat.x, top: quoteFloat.y, transform: 'translateX(-50%)' }}
              onClick={quoteSelectionToInput}
            >
              <SelectOutlined /> 引用到输入框
            </button>
          )}
          <div className="assistant-msgs-row">
            <div
              className="plan-chat-msgs"
              ref={msgsRef}
              onScroll={(e) => {
                const el = e.currentTarget
                // 距底部 80px 以内视为"在底部"，允许自动滚动；超出则用户主动上滑，停止跟随
                stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                // 滚动后选区的 viewport 位置已失效，引用浮钮先收起（重新划选会再浮出）
                setQuoteFloat(null)
                // 同步右侧对话导航的高亮（rAF 节流）
                scheduleSpy()
              }}
            >
            {messages.length === 0 && !sending && (
              /* 空态建议做成可点的芯片：点击即填入输入框，不再只是装饰性文字 */
              <div className="chat-empty">
                <RobotOutlined className="chat-empty-icon" />
                <div className="chat-empty-title">试试这样问：</div>
                <div className="chat-empty-sugs">
                  {[
                    '我哪个知识点最弱？该怎么补？',
                    '这段代码为什么 TLE：粘贴你的代码',
                    '根据我的刷题情况帮我重新估算能力值',
                    '把这段思路沉淀成模板记到模板库',
                    ...(planId !== undefined ? ['把计划里下周改成图论专题'] : []),
                    ...(listId !== undefined ? ['题单里哪道题最值得先做？'] : []),
                  ].map((sug) => (
                    <button
                      key={sug}
                      type="button"
                      className="chat-empty-sug"
                      onClick={() => setChatState((prev) => ({ ...prev, input: sug }))}
                    >
                      {sug}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => {
              if (m.role === 'user') {
                return (
                  <div
                    key={i}
                    data-msg-index={i}
                    data-role="user"
                    className={`plan-chat-msg plan-chat-msg-user${jumpFlashIdx === i ? ' is-flash' : ''}`}
                  >
                    {m.attachments && m.attachments.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: m.content ? 6 : 0 }}>
                        {m.attachments.map((a, j) =>
                          a.dataUrl ? (
                            /* 内联图片：气泡内直接预览（刷新后 dataUrl 剥离，退化为标签） */
                            <img
                              key={`${a.fileId}-${j}`}
                              src={a.dataUrl}
                              alt={a.filename || '图片附件'}
                              style={{
                                maxWidth: 200,
                                maxHeight: 160,
                                borderRadius: 8,
                                border: '1px solid var(--line)',
                                display: 'block',
                                objectFit: 'cover',
                              }}
                            />
                          ) : (
                            <Tag key={`${a.fileId}-${j}`} style={{ marginInlineEnd: 0 }}>
                              <PaperClipOutlined /> {a.filename || a.fileId}
                              {a.bytes !== undefined ? `（${fmtBytes(a.bytes)}）` : ''}
                              {a.textContent !== undefined ? ' · 文本' : ''}
                            </Tag>
                          ),
                        )}
                      </div>
                    )}
                    {m.content && <Markdown text={m.content} />}
                    {/* 按钮行对纯附件消息（content 为空）同样渲染：否则粘贴图片直接发送后
                        找不到「再次编辑」入口；「复制」无文本可复制，仅在有内容时出现 */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
                      {m.content && (
                        <Button
                          size="small"
                          type="text"
                          className="msg-copy-btn"
                          icon={<CopyOutlined />}
                          onClick={() => {
                            navigator.clipboard
                              ?.writeText(m.content ?? '')
                              .then(() => message.success('已复制'))
                              .catch(() => message.warning('复制失败，请手动选择复制'))
                          }}
                        >
                          复制
                        </Button>
                      )}
                      <Button
                        size="small"
                        type="text"
                        className="msg-copy-btn"
                        icon={<EditOutlined />}
                        onClick={() => editUserMessage(i)}
                      >
                        再次编辑
                      </Button>
                    </div>
                  </div>
                )
              }
              const { modify, abilityUpd, tplAdds, listDraft, planDraft, text } = parseMessageBlocks(m)
              const hasTpl = tplAdds.length > 0
              // 旧消息用 m.applied 表示模板已写入（向后兼容：无 appliedTpl 时视为该消息模板均已应用）
              const appliedTpl =
                m.applied === true && !m.appliedTpl ? tplAdds.map((_, j) => j) : (m.appliedTpl ?? [])
              const appliedTplSet = new Set(appliedTpl)
              const pendingTplCount = tplAdds.length - appliedTpl.length
              return (
                <div
                  key={i}
                  data-msg-index={i}
                  data-role="assistant"
                  className={`plan-chat-msg plan-chat-msg-assistant${jumpFlashIdx === i ? ' is-flash' : ''}`}
                >
                  {m.reasoning && (
                    <details
                      className="ai-reasoning"
                      // 思考进行中（本条消息还在推流且正文未开始）自动展开，思维链实时可见；
                      // 正文一开始或流结束后改为非受控，用户可自由开合（issue #27）
                      open={sending && i === messages.length - 1 && !text.trim() ? true : undefined}
                      style={{
                        marginBottom: 8,
                        padding: '6px 12px',
                        background: 'var(--overlay-2)',
                        borderRadius: 6,
                        fontSize: 13,
                        color: 'var(--text-2)',
                      }}
                    >
                      <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 500 }}>
                        💭 思考过程
                      </summary>
                      <div style={{ marginTop: 6, whiteSpace: 'pre-wrap', opacity: 0.85 }}>
                        {m.reasoning}
                      </div>
                    </details>
                  )}
                  <Markdown text={text} streaming={sending && i === messages.length - 1} />
                  {text.trim() && (
                    <Button
                      size="small"
                      type="text"
                      className="msg-copy-btn"
                      icon={<CopyOutlined />}
                      onClick={() => {
                        navigator.clipboard
                          ?.writeText(text)
                          .then(() => message.success('已复制'))
                          .catch(() => message.warning('复制失败，请手动选择复制'))
                      }}
                    >
                      复制
                    </Button>
                  )}
                  {(modify || abilityUpd || hasTpl || listDraft || planDraft) && (
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
                          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
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
                            <Space key={j} size={4}>
                              {/* 目标标签选择器：用户可显式指定放到哪个课程分类/自建标签下
                                  （templateId 草稿是「完善已有内置条目」，不存在选分类的问题） */}
                              {!draft.templateId && tplCategories.length > 0 && (
                                <Tooltip title="写入到哪个标签下 —— 含你在「模板库 → 新建标签」里自己建的标签">
                                  <Select
                                    size="small"
                                    style={{ minWidth: 140 }}
                                    value={templateTargetOf(i, j, draft)}
                                    disabled={applied}
                                    onChange={(key: string) =>
                                      setTplTargets((prev) => ({ ...prev, [tplKey(i, j)]: key }))
                                    }
                                    options={tplCategories.map((c) => ({
                                      value: c.key,
                                      label: templateCategoryLabel(c),
                                    }))}
                                  />
                                </Tooltip>
                              )}
                              <Button
                                size="small"
                                type="primary"
                                ghost
                                disabled={applied}
                                loading={tplWriting.has(tplKey(i, j))}
                                onClick={() => void confirmTemplate(draft, i, j)}
                              >
                                {applied
                                  ? `✓ 已完善：${draft.name}`
                                  : draft.templateId
                                    ? `完善模板：「${draft.name}」`
                                    : `写入模板库：「${draft.name}」`}
                              </Button>
                            </Space>
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
                      {listDraft && (
                        <Button
                          size="small"
                          type="primary"
                          disabled={m.appliedList}
                          loading={listCreating}
                          onClick={() => void confirmListCreate(listDraft, i)}
                        >
                          {m.appliedList ? `✓ 已导入题单：${listDraft.title}` : `导入题单：「${listDraft.title}」`}
                        </Button>
                      )}
                      {planDraft && (
                        <Button
                          size="small"
                          type="primary"
                          disabled={m.appliedPlan}
                          loading={planCreating}
                          onClick={() => void confirmPlanCreate(planDraft, i)}
                        >
                          {m.appliedPlan ? `✓ 已生成计划：${planDraft.title}` : `生成训练计划：「${planDraft.title}」`}
                        </Button>
                      )}
                    </Space>
                  )}
                  {m.usage && (
                    <div
                      style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: 'var(--text-3)',
                        textAlign: 'right',
                      }}
                    >
                      📝 输入 {m.usage.prompt_tokens} / 输出 {m.usage.completion_tokens} token
                    </div>
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
            </div>
            {userTurns.length > 0 && (
              /* 右侧对话导航：列出每条发过的消息（摘要），点击跳转 + 滚动联动高亮 */
              <aside className={`chat-toc${tocHidden ? ' is-collapsed' : ''}`}>
                {tocHidden ? (
                  <Tooltip title="对话导航：快速跳到你发过的消息" placement="left">
                    <button type="button" className="chat-toc-toggle" aria-label="展开对话导航" onClick={toggleToc}>
                      <UnorderedListOutlined />
                    </button>
                  </Tooltip>
                ) : (
                  <>
                    <div className="chat-toc-head">
                      <span className="chat-toc-title">对话导航</span>
                      <Tooltip title="收起导航" placement="left">
                        <button type="button" className="chat-toc-toggle" aria-label="收起对话导航" onClick={toggleToc}>
                          <RightOutlined />
                        </button>
                      </Tooltip>
                    </div>
                    <div className="chat-toc-list">
                      {userTurns.map((t, n) => (
                        <button
                          key={t.idx}
                          type="button"
                          className={`chat-toc-item${activeTurnIdx === t.idx ? ' is-active' : ''}`}
                          title={turnExcerpt(t.msg)}
                          onClick={() => jumpToTurn(t.idx)}
                        >
                          <span className="chat-toc-no">{n + 1}</span>
                          <span className="chat-toc-excerpt">{turnExcerpt(t.msg)}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </aside>
            )}
          </div>
          {showModelChip && (
            /* 模型选择器（对齐 ZCode 输入框右上角的模型位）：点击切模型 / 切提供商，全局生效 */
            <div className="chat-input-topbar">
              <Dropdown
                trigger={['click']}
                placement="topRight"
                menu={{ ...modelMenu, onClick: onModelMenuClick }}
                onOpenChange={onModelMenuOpenChange}
                overlayClassName="chat-model-dropdown"
                popupRender={(menu) => (
                  /* 面板壳：搜索框固定在顶部，模型列表在下方滚动（网关列表常有几百条） */
                  <div className="chat-model-panel">
                    <Input
                      size="small"
                      className="chat-model-filter"
                      placeholder="搜索模型…"
                      prefix={<SearchOutlined />}
                      allowClear
                      value={modelFilter}
                      onChange={(e) => setModelFilter(e.target.value)}
                    />
                    {menu}
                  </div>
                )}
              >
                <button type="button" className="chat-model-chip" aria-label="切换 AI 模型">
                  <span className="chat-model-chip-name">{aiInfo?.model || '未设置模型'}</span>
                  <DownOutlined className="chat-model-chip-caret" />
                </button>
              </Dropdown>
            </div>
          )}
          <div className="plan-chat-input" style={{ position: 'relative' }}>
            {/* `/` 快捷指令候选（P3-5）：浮在输入框上方，不挤压消息区高度 */}
            {cmdMenuOpen && (
              <div className="chat-cmd-menu" role="listbox" aria-label="快捷指令">
                {cmdCandidates.map((c, i) => (
                  <button
                    key={c.name}
                    type="button"
                    role="option"
                    aria-selected={i === cmdIndex}
                    className={`chat-cmd-item${i === cmdIndex ? ' is-active' : ''}`}
                    onMouseEnter={() => setCmdIndex(i)}
                    // mousedown 而不是 click：click 之前输入框会先失焦，菜单已经被关掉
                    onMouseDown={(e) => {
                      e.preventDefault()
                      runChatCommand(c)
                    }}
                  >
                    <span className="chat-cmd-name">
                      /{c.name}
                      {c.arg ? <span className="chat-cmd-arg"> {c.arg}</span> : null}
                    </span>
                    <span className="chat-cmd-hint">{c.hint}</span>
                  </button>
                ))}
              </div>
            )}
            {pendingAtts.length > 0 && (
              <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {pendingAtts.map((a, i) =>
                  a.previewUrl ? (
                    /* 图片附件：缩略图预览（对齐主流聊天产品的粘贴样式），悬停出移除钮 */
                    <div key={`${a.fileId}-${i}`} className="pending-att-thumb">
                      <img src={a.previewUrl} alt={a.filename || '图片附件'} />
                      <button
                        type="button"
                        className="pending-att-remove"
                        aria-label={`移除图片 ${a.filename || ''}`}
                        title={a.filename || '图片附件'}
                        onClick={() => removePendingAtt(i)}
                      >
                        <CloseOutlined />
                      </button>
                    </div>
                  ) : (
                    <Tag
                      key={`${a.fileId}-${i}`}
                      closable
                      onClose={() => removePendingAtt(i)}
                    >
                      <PaperClipOutlined /> {a.filename || a.fileId}
                      {a.bytes !== undefined ? `（${fmtBytes(a.bytes)}）` : ''}
                      {a.textContent !== undefined ? ' · 文本' : ''}
                    </Tag>
                  ),
                )}
              </div>
            )}
            <Input.TextArea
              ref={inputRef}
              value={input}
              onChange={(e) => setChatState((prev) => ({ ...prev, input: e.target.value }))}
              placeholder="向 AI 教练提问…（可粘贴截图/代码，拖入或附加图片/代码文件；输入 / 查看快捷指令）Enter 发送，Shift+Enter 换行"
              onPaste={handlePasteUpload}
              autoSize={{ minRows: 1, maxRows: 6 }}
              onKeyDown={(e) => {
                // 菜单打开时先吃掉方向键/Enter/Esc，避免同时触发「发送」
                if (!cmdMenuOpen) return
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCmdIndex((i) => (i + 1) % cmdCandidates.length)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCmdIndex((i) => (i - 1 + cmdCandidates.length) % cmdCandidates.length)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setCmdDismissed(true)
                }
              }}
              onPressEnter={(e) => {
                if (e.shiftKey) return
                e.preventDefault()
                if (cmdMenuOpen) {
                  runChatCommand(cmdCandidates[cmdIndex])
                  return
                }
                void send()
              }}
            />
            <Button
              icon={uploadingAtts ? <LoadingOutlined /> : <PaperClipOutlined />}
              title="附加图片或代码文件（图片走 Files API 上传，文本/代码文件读取内容到输入框）"
              disabled={uploadingAtts || sending}
              onClick={() => fileInputRef.current?.click()}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.docx,.xlsx,.pptx,.html,.htm,.csv,.json,.xml,.epub,.txt,.md,.py,.cpp,.c,.cc,.cxx,.h,.hpp,.java,.kt,.rs,.go,.js,.ts,.jsx,.tsx,.rb,.php,.sh,.bash,.zsh,.sql,.yaml,.yml,.toml,.tsv,.css,.scss,.less,.vue,.svelte,.swift,.m,.scala,.clj,.ex,.exs,.erl,.hs,.lua,.pl,.r,.dart,.groovy,.gradle,.cmake,.ini,.cfg,.conf,.properties"
              hidden
              onChange={(e) => void handlePickFiles(e.target.files)}
            />
            {sending ? (
              <>
                {/* 正文输出完但 AI 还在跑工具（检索/抓网页）时，说明为什么按钮仍是「停止」 */}
                {toolStatus?.sessionId === activeId && (
                  <span style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                    {toolStatus.text}
                  </span>
                )}
                <Button
                  danger
                  onClick={() => stopSending(activeId)}
                  title="停止本次生成（已输出的内容会保留）"
                >
                  停止
                </Button>
              </>
            ) : (
              <Button
                type="primary"
                icon={<SendOutlined />}
                disabled={(!input.trim() && pendingAtts.length === 0) || uploadingAtts}
                onClick={() => void send()}
              />
            )}
          </div>
          {(messages.length > 0 || sending) && (
            /* 会话状态栏（对齐 ZCode）：轮数/消息 · tok/s · 累计 token/缓存命中 · 上下文占用 */
            <div className="chat-statusbar">
              <Tooltip title="当前会话的对话轮数与消息总数；闪电后是流式生成速度（生成中为估算值，结束后按真实用量折算）">
                <span className="chat-status-seg">
                  {sessionStats.rounds} 轮 · {sessionStats.msgCount} 消息
                  {tokPerSec && (
                    <span className="chat-status-speed">
                      <ThunderboltOutlined /> {tokPerSec} tok/s
                    </span>
                  )}
                </span>
              </Tooltip>
              {sessionStats.totalTokens > 0 && (
                <Tooltip title="本会话累计 token 用量；「缓存命中」是输入部分命中提示词缓存的比例（网关返回 cached_tokens 时才显示）">
                  <span className="chat-status-seg">
                    <DatabaseOutlined />
                    {fmtTokenCount(sessionStats.totalTokens)} tok
                    {sessionStats.cacheHit !== null && (
                      <span>缓存命中 {(sessionStats.cacheHit * 100).toFixed(1)}%</span>
                    )}
                  </span>
                </Tooltip>
              )}
              {contextPct !== null && (
                <Tooltip title="最后一轮输入 token 占模型上下文窗口的比例（窗口大小取自设置页 AI 配置）">
                  <span
                    className={`chat-status-seg chat-status-ctx${
                      contextPct >= 90 ? ' is-critical' : contextPct >= 70 ? ' is-warn' : ''
                    }`}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <circle cx="8" cy="8" r="6.5" fill="none" strokeWidth="2.5" style={{ stroke: 'var(--line)' }} />
                      <circle
                        cx="8"
                        cy="8"
                        r="6.5"
                        fill="none"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeDasharray={`${Math.max((contextPct / 100) * 40.84, 0.6)} 40.84`}
                        transform="rotate(-90 8 8)"
                        style={{ stroke: 'currentColor' }}
                      />
                    </svg>
                    {contextPct}%
                  </span>
                </Tooltip>
              )}
            </div>
          )}
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
          message={
            <>
              目标计划：<b>{applyTarget?.planTitle}</b>
              <br />
              将以 AI 给出的任务列表整体替换该计划的任务。日期与标题都相同的任务会保留原 id 与打卡记录；其余任务新增/删除（被删除任务的打卡将一并清除）。
            </>
          }
        />
      </Modal>

    </div>
  )
}
