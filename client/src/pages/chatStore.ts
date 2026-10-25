/**
 * AI 助手的聊天 store（模块级，useSyncExternalStore 消费）：
 * 会话数据、localStorage 持久化、会话操作全部与 UI 组件解耦。
 *
 * 为什么放模块级而不是 React state：生成中切走页面再回来，async 流式回调仍在
 * 直接写 store——不依赖组件是否挂载；多个组件（主页面/输入区/侧栏行）按各自
 * 粒度订阅（视图快照 / input 字符串），见 getChatViewSnapshot 与 getInputSnapshot。
 */
import type { PlanChatTurn, TokenUsage } from '../api'
import { readJson, writeJson } from '../persistence.ts'
import { SpeedTracker } from './assistantStats'
import { restoreSessionOrder } from './assistantSessionOrder'
import { forgetSessionFiles } from './sessionFiles'


export interface ChatMsg extends PlanChatTurn {
  /**
   * 消息的稳定标识（列表 key 用）。
   *
   * 不能用数组下标：对话导航跳转、尤其「再次编辑后重发」截断数组时，
   * 相邻消息会复用错位的 DOM 与组件状态。历史会话里没有 id 的旧消息在
   * loadFromStorage 里补发（只在页面加载时生成一次，之后随会话一起持久化）。
   */
  id: string
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
export interface ChatSession {
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

export interface ChatState {
  sessions: ChatSession[]
  activeId: string
  input: string
  /** 正在流式生成的会话 id 集合（支持多会话并行输入输出） */
  sendingIds: Set<string>
}


// ---------- localStorage 持久化 ----------

const STORAGE_KEY = 'icpc-ai-sessions-v1'
export const MAX_SESSIONS = 50

function loadFromStorage(): ChatSession[] {
  const data = readJson<ChatSession[]>(STORAGE_KEY)
  if (!Array.isArray(data)) return []
  return data
    .filter(
      (s) =>
        typeof s.id === 'string' && Array.isArray(s.messages) && typeof s.createdAt === 'number',
    )
    .map((s) => ({
      id: s.id,
      title: typeof s.title === 'string' ? s.title : '新会话',
      // 旧版本会话没有消息 id：加载时补一次，之后随会话一起落 localStorage。
      // 只在加载时生成，流式追加/截断都不会再改已有消息的 id。
      messages: s.messages.map((m) =>
        m && typeof m === 'object' && typeof m.id === 'string' ? m : { ...m, id: newMsgId() },
      ),
      planId: typeof s.planId === 'number' ? s.planId : undefined,
      listId: typeof s.listId === 'number' ? s.listId : undefined,
      contestKey: typeof s.contestKey === 'string' && s.contestKey !== '' ? s.contestKey : undefined,
      createdAt: s.createdAt,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : s.createdAt,
      pinned: !!s.pinned,
    }))
}

function saveToStorageNow(sessions: ChatSession[]): void {
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
  // localStorage 可能不可用或已满，静默忽略
  writeJson(STORAGE_KEY, toSave)
}

/**
 * 落盘防抖：流式生成期间 sessions 每 50ms 换一次引用（streamBuffer 攒批），
 * 同步全量 JSON.stringify 最多 50 个会话会每秒阻塞主线程约 20 次，长对话时
 * 卡顿比渲染还明显。trailing 500ms 已足够——生成中页面关闭前有 pagehide 兜底落盘。
 */
const SAVE_DEBOUNCE_MS = 500
let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveToStorage(sessions: ChatSession[]): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveToStorageNow(sessions)
  }, SAVE_DEBOUNCE_MS)
}

// 立即落盘挂起的写入（生成收尾 finally 与关页/切后台共用）：
// 防抖窗口内的最后一批更新不能丢。pagehide 在 bfcache 场景也可靠触发；
// visibilitychange 兜底移动端与部分嵌入 WebView。
export function flushPendingSave(): void {
  if (saveTimer === null) return
  clearTimeout(saveTimer)
  saveTimer = null
  saveToStorageNow(chatState.sessions)
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingSave)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave()
  })
}

// ---------- 模块级 store ----------

function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * 消息 id：`crypto.randomUUID` 可用就用它（浏览器与 secure context 下都有），
 * 否则退化为时间戳 + 随机串。只要求「同一会话内唯一且不再变化」，不做语义。
 */
export function newMsgId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function createSession(planId?: number, listId?: number, contestKey?: string): ChatSession {
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

export let chatState: ChatState = initChatState()
const chatListeners = new Set<() => void>()

/**
 * 主页面订阅的视图快照（不含 input）：input 是高频瞬态（每击键一变），主页面这棵
 * 大组件树不该跟着它重渲染——sessions/activeId/sendingIds 引用都没变时视图快照
 * 对象保持不变，useSyncExternalStore 即判定「无变化」。input 的渲染收敛在 Composer
 * 组件内（按 input 字符串单独订阅）；事件处理器要读当前输入直接读 chatState.input。
 */
let chatView: Readonly<Omit<ChatState, 'input'>> = {
  sessions: chatState.sessions,
  activeId: chatState.activeId,
  sendingIds: chatState.sendingIds,
}

/** 进行中的会话 → AbortController，用于停止生成（非 React 状态，不触发渲染） */
export const sessionAbortControllers = new Map<string, AbortController>()

/** 进行中的会话 → 流式速率采样器（tok/s 估算）；生成结束/中止后在 finally 中移除 */
export const sessionSpeedTrackers = new Map<string, SpeedTracker>()

export function setChatState(updater: (prev: ChatState) => ChatState): void {
  const prev = chatState
  chatState = updater(chatState)
  // 仅在 sessions 引用变化时写 localStorage（input/sendingIds 变化不触发写入）
  if (chatState.sessions !== prev.sessions) saveToStorage(chatState.sessions)
  if (
    chatState.sessions !== prev.sessions ||
    chatState.activeId !== prev.activeId ||
    chatState.sendingIds !== prev.sendingIds
  ) {
    chatView = {
      sessions: chatState.sessions,
      activeId: chatState.activeId,
      sendingIds: chatState.sendingIds,
    }
  }
  chatListeners.forEach((l) => l())
}

export function subscribeChat(listener: () => void): () => void {
  chatListeners.add(listener)
  return () => {
    chatListeners.delete(listener)
  }
}

/** 主页面用：不含 input 的视图快照（引用稳定，见 chatView 的注释） */
export function getChatViewSnapshot() {
  return chatView
}

/** 输入框（Composer）用：字符串本身值稳定，相同内容不会误判为变化 */
export function getInputSnapshot(): string {
  return chatState.input
}

// ---------- 会话操作 ----------

export function createNewSession(): void {
  const s = createSession()
  setChatState((prev) => {
    // 内存数组与落盘口径对齐（saveToStorage 只存前 MAX_SESSIONS 个）：不淘汰的话
    // 第 51 个以后的旧会话只在内存活着，刷新后静默消失——用户以为删了，其实只是没存。
    // 置顶会话永远保留（pinned 优先于位置序）。
    const rest = prev.sessions.filter((x) => x.pinned)
    const unpinned = prev.sessions.filter((x) => !x.pinned)
    while (rest.length + unpinned.length >= MAX_SESSIONS) {
      const victim = unpinned.pop()
      if (!victim || victim.id === prev.activeId) break
    }
    return { ...prev, sessions: [s, ...rest, ...unpinned], activeId: s.id, input: '' }
  })
}

export function switchToSession(id: string): void {
  setChatState((prev) => (prev.activeId === id ? prev : { ...prev, activeId: id, input: '' }))
}

/** 拖拽排序：将 fromId 对应的会话移动到 toId 对应会话的位置 */
export function reorderSessions(fromId: string, toId: string): void {
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

/** 撤销键盘/拖拽排序：按 id 序列还原顺序；列表已增删（id 对不上）时返回 false */
export function restoreSessionOrderByIds(orderedIds: string[]): boolean {
  const before = chatState.sessions
  const next = restoreSessionOrder(before, orderedIds)
  if (!next) return false
  setChatState((prev) => (prev.sessions === before ? { ...prev, sessions: next } : prev))
  return true
}

export function deleteSessionById(id: string): void {
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

export function toggleSessionPin(id: string): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === id ? { ...s, pinned: !s.pinned } : s)),
  }))
}

export function renameSession(id: string, title: string): void {
  const t = title.trim()
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === id ? { ...s, title: t || '新会话' } : s)),
  }))
}

export function updateActiveSessionPlanId(planId: number | undefined): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === prev.activeId ? { ...s, planId } : s)),
  }))
}

export function updateActiveSessionListId(listId: number | undefined): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === prev.activeId ? { ...s, listId } : s)),
  }))
}

export function updateActiveSessionContestKey(contestKey: string | undefined): void {
  setChatState((prev) => ({
    ...prev,
    sessions: prev.sessions.map((s) => (s.id === prev.activeId ? { ...s, contestKey } : s)),
  }))
}

/** 更新当前会话的消息列表（async 回调安全：直接写 store，不依赖组件挂载） */
export function patchActiveSessionMessages(
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
