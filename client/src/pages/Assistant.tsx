import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, App as AntdApp, Button, Card, Input, Modal, Popconfirm, Select, Space, Spin, Tag } from 'antd'
import type { TextAreaRef } from 'antd/es/input/TextArea'
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  LoadingOutlined,
  PaperClipOutlined,
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
  generateSessionTitle,
  get,
  post,
  uploadAiFile,
  extractDocumentText,
  type AbilityInfo,
  type ChatFileAttachment,
  type PlanApplyResult,
  type PlanChatTurn,
  type TokenUsage,
} from '../api'
import type { PlanListItem } from '../types'
import Markdown from '../components/Markdown'
import PageHeader from '../components/PageHeader'
import { rememberSessionFiles, getSessionFileText, forgetSessionFiles } from './sessionFiles'
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
  /** 该助手消息是一次失败回合（API 报错 / 空中止）：再次编辑时会被剔除，不回传给模型 */
  failed?: boolean
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

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
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
  const [listCreating, setListCreating] = useState(false)
  const [planCreating, setPlanCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  /** 拖拽源 id（ref 即时读写，不依赖 state 异步更新） */
  const dragIdRef = useRef<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  /** 消息列表可滚动容器，用于判断用户是否在底部附近 */
  const msgsRef = useRef<HTMLDivElement>(null)
  /** 用户是否在底部附近（true 时流式更新自动滚到底，false 时不打断用户上滑查看） */
  const stickToBottomRef = useRef(true)
  /** 输入框引用：「再次编辑」时把历史消息回填并聚焦输入框 */
  const inputRef = useRef<TextAreaRef>(null)

  // ---------- 图片附件（Files API） ----------
  /** 本条消息待发送的附件（上传成功后的 file_id 引用） */
  const [pendingAtts, setPendingAtts] = useState<ChatFileAttachment[]>([])
  const [uploadingAtts, setUploadingAtts] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 切换会话时清空未发送的附件，避免串会话
  useEffect(() => {
    setPendingAtts([])
  }, [activeId])

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
    '.docx', '.xlsx', '.xls', '.pptx', '.html', '.htm', '.csv', '.json', '.xml', '.epub',
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
        const room = 8 - pendingAtts.length
        const picked = textAtts.slice(0, room)
        if (picked.length < textAtts.length) message.warning('每条消息最多附带 8 个文件')
        if (picked.length > 0) {
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
          const room = 8 - pendingAtts.length
          const picked = docAtts.slice(0, room)
          if (picked.length < docAtts.length) message.warning('每条消息最多附带 8 个文件')
          if (picked.length > 0) {
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
    const room = 8 - pendingAtts.length
    const picked = images.slice(0, room)
    if (picked.length < images.length) message.warning('每条消息最多附带 8 个文件')
    if (picked.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    setUploadingAtts(true)
    try {
      const uploaded: ChatFileAttachment[] = []
      for (const f of picked) {
        try {
          const obj = await uploadAiFile(f)
          uploaded.push({ fileId: obj.id, filename: obj.filename || f.name, bytes: obj.bytes })
        } catch (e) {
          message.error(`上传「${f.name}」失败：${(e as Error).message}`)
        }
      }
      if (uploaded.length > 0) {
        setPendingAtts((prev) => [...prev, ...uploaded])
        message.success(`已上传 ${uploaded.length} 个图片`)
      }
    } finally {
      setUploadingAtts(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
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

  const handleDrop = useCallback((e: React.DragEvent) => {
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
  }, [message])

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

  // 流式更新时只在用户已在底部附近时才自动滚动，不打断用户上滑查看历史
  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, sending])

  const send = async () => {
    const text = input.trim()
    const atts = pendingAtts
    if ((!text && atts.length === 0) || sendingIds.has(activeId)) return
    // 发新消息时恢复自动滚动到底部
    stickToBottomRef.current = true
    const sessionId = activeId
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return

    // 发送给服务端的附件（含 textContent），存入会话历史的附件（剥离 textContent 避免 localStorage 爆满）
    const attsForSend = atts
    // 附件全文入会话级缓存：后续任意轮次发送时从缓存回填，AI 不会"忘记"已上传文件
    rememberSessionFiles(sessionId, atts)
    const attsForStore = atts.map(({ textContent: _tc, ...rest }) => rest)
    const userMsg: ChatMsg = {
      role: 'user',
      content: text,
      ...(attsForStore.length > 0 ? { attachments: attsForStore } : {}),
    }
    const nextMessages: ChatMsg[] = [...session.messages, userMsg]
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
              title: s.messages.length === 0 ? (text || userMsg.attachments?.[0]?.filename || '新会话').slice(0, 30) : s.title,
              updatedAt: Date.now(),
            }
          : s,
      ),
    }))
    setPendingAtts([])
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
          messages: nextMessages.map(({ role, content, attachments }, idx) => ({
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
                        idx === nextMessages.length - 1
                          ? attsForSend.find((x) => x.fileId === a.fileId)?.textContent
                          : getSessionFileText(sessionId, a.fileId),
                    }))
                    // 图片附件（file-api-…）必须保留（textContent 恒空）；
                    // 仅剔除"本地文本附件但缓存未命中/超出容量"的残缺项
                    .filter((a) => a.fileId.startsWith('file-') || a.textContent !== undefined),
                }
              : {}),
          })),
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
        (reasoningChunk) => {
          // 推理内容（思维链）追加到最后一条 assistant 消息的 reasoning 字段
          patchActiveSessionMessages(sessionId, (msgs) => {
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant') {
              return [...msgs.slice(0, -1), { ...last, reasoning: (last.reasoning ?? '') + reasoningChunk }]
            }
            return msgs
          })
        },
      )
      // token 用量：写入最后一条 assistant 消息（前端展示消耗）
      if (result.usage) {
        patchActiveSessionMessages(sessionId, (msgs) => {
          const last = msgs[msgs.length - 1]
          if (last && last.role === 'assistant') {
            return [...msgs.slice(0, -1), { ...last, usage: result.usage! }]
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
    setApplyTarget({ planId, raw })
  }

  /**
   * 「再次编辑」：把指定用户消息回填到输入框，并截断该消息及其后的所有消息
   * （分支编辑语义，与主流聊天产品一致）。这样重发后不会出现"原对话 + 重复的新对话"
   * 两条几乎相同的对话。同时回填该消息当时的附件到输入区，重发时文件内容不丢。
   */
  const editUserMessage = (msgIndex: number) => {
    const userMsg = messages[msgIndex]
    if (!userMsg || userMsg.role !== 'user') return
    const content = userMsg.content ?? ''
    const atts = userMsg.attachments ?? []

    // 回填该消息的附件（图片附件缺 file-api 引用有效性，仍按原样回填；
    // 文本附件内容由会话缓存兜底，重发时仍带全文）
    if (atts.length > 0) {
      setPendingAtts((prev) => {
        const existing = new Set(prev.map((a) => a.fileId))
        const restored = atts
          .filter((a) => !existing.has(a.fileId))
          .map((a) => ({
            fileId: a.fileId,
            filename: a.filename,
            bytes: a.bytes,
            textContent: getSessionFileText(activeId, a.fileId),
          }))
        return [...prev, ...restored]
      })
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
                    onClick={() => switchToSession(s.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '6px 8px',
                      borderRadius: 8,
                      cursor: 'pointer',
                      marginBottom: 2,
                      background: isActive ? 'rgba(134, 168, 255, 0.13)' : 'transparent',
                      opacity: isDragging ? 0.4 : 1,
                      borderTop: isDragOver ? '2px solid #86a8ff' : '2px solid transparent',
                      transition: 'background 0.15s',
                      userSelect: dragId !== null ? 'none' : undefined,
                    }}
                    onMouseEnter={(e) => {
                      // 拖拽中：标记当前行为放置目标；否则普通 hover
                      if (dragIdRef.current !== null && dragIdRef.current !== s.id) {
                        setDragOverId(s.id)
                      } else if (!isActive && !isDragging) {
                        e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (dragIdRef.current !== null) return
                      if (!isActive) e.currentTarget.style.background = 'transparent'
                    }}
                    onMouseUp={() => {
                      // 拖拽中松手在此行：执行排序
                      if (dragIdRef.current !== null && dragIdRef.current !== s.id) {
                        reorderSessions(dragIdRef.current, s.id)
                      }
                      dragIdRef.current = null
                      setDragId(null)
                      setDragOverId(null)
                    }}
                  >
                    <HolderOutlined
                      style={{ fontSize: 12, color: '#5a6472', flexShrink: 0, cursor: 'grab' }}
                      onMouseDown={(e) => {
                        // 在手柄上按下鼠标：启动拖拽（阻止默认行为避免选中文本）
                        e.stopPropagation()
                        e.preventDefault()
                        dragIdRef.current = s.id
                        setDragId(s.id)
                      }}
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
          <div
            className="plan-chat-msgs"
            ref={msgsRef}
            onScroll={(e) => {
              const el = e.currentTarget
              // 距底部 80px 以内视为"在底部"，允许自动滚动；超出则用户主动上滑，停止跟随
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
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
                    {m.attachments && m.attachments.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: m.content ? 6 : 0 }}>
                        {m.attachments.map((a, j) => (
                          <Tag key={`${a.fileId}-${j}`} style={{ marginInlineEnd: 0 }}>
                            <PaperClipOutlined /> {a.filename || a.fileId}
                            {a.bytes !== undefined ? `（${fmtBytes(a.bytes)}）` : ''}
                            {a.textContent !== undefined ? ' · 文本' : ''}
                          </Tag>
                        ))}
                      </div>
                    )}
                    {m.content && <Markdown text={m.content} />}
                    {m.content && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
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
                    )}
                  </div>
                )
              }
              const modify = extractModifyBlock(m.content)
              const abilityUpd = extractAbilityUpdate(m.content)
              const tplAdds = extractTemplateAdd(m.content)
              const hasTpl = tplAdds.length > 0
              const listDraft = extractListCreate(m.content)
              const planDraft = extractPlanCreate(m.content)
              let text = stripModifyBlock(m.content)
              if (abilityUpd) text = stripAbilityUpdate(text)
              if (hasTpl) text = stripTemplateAdd(text)
              if (listDraft) text = stripListCreate(text)
              if (planDraft) text = stripPlanCreate(text)
              // 旧消息用 m.applied 表示模板已写入（向后兼容：无 appliedTpl 时视为该消息模板均已应用）
              const appliedTpl =
                m.applied === true && !m.appliedTpl ? tplAdds.map((_, j) => j) : (m.appliedTpl ?? [])
              const appliedTplSet = new Set(appliedTpl)
              const pendingTplCount = tplAdds.length - appliedTpl.length
              return (
                <div key={i} className="plan-chat-msg plan-chat-msg-assistant">
                  {m.reasoning && (
                    <details
                      className="ai-reasoning"
                      style={{
                        marginBottom: 8,
                        padding: '6px 12px',
                        background: 'var(--fill-2, rgba(0,0,0,0.04))',
                        borderRadius: 6,
                        fontSize: 13,
                        color: 'var(--text-2, #5b6573)',
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
                  <Markdown text={text} />
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
                        color: 'var(--text-3, #8993a2)',
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
            <div ref={bottomRef} />
          </div>
          <div className="plan-chat-input">
            {pendingAtts.length > 0 && (
              <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {pendingAtts.map((a, i) => (
                  <Tag
                    key={`${a.fileId}-${i}`}
                    closable
                    onClose={() => setPendingAtts((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <PaperClipOutlined /> {a.filename || a.fileId}
                    {a.bytes !== undefined ? `（${fmtBytes(a.bytes)}）` : ''}
                    {a.textContent !== undefined ? ' · 文本' : ''}
                  </Tag>
                ))}
              </div>
            )}
            <Input.TextArea
              ref={inputRef}
              value={input}
              onChange={(e) => setChatState((prev) => ({ ...prev, input: e.target.value }))}
              placeholder="向 AI 教练提问…（可粘贴代码，拖入或附加图片/代码文件）Enter 发送，Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 6 }}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
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
              accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.docx,.xlsx,.xls,.pptx,.html,.htm,.csv,.json,.xml,.epub,.txt,.md,.py,.cpp,.c,.cc,.cxx,.h,.hpp,.java,.kt,.rs,.go,.js,.ts,.jsx,.tsx,.rb,.php,.sh,.bash,.zsh,.sql,.yaml,.yml,.toml,.tsv,.css,.scss,.less,.vue,.svelte,.swift,.m,.scala,.clj,.ex,.exs,.erl,.hs,.lua,.pl,.r,.dart,.groovy,.gradle,.cmake,.ini,.cfg,.conf,.properties"
              hidden
              onChange={(e) => void handlePickFiles(e.target.files)}
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
                disabled={(!input.trim() && pendingAtts.length === 0) || uploadingAtts}
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
