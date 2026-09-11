/**
 * 会话级附件内容缓存（sessionFiles）：fileId → 附件全文（textContent）。
 *
 * 背景：附件正文（PDF/文档提取文本）若存在消息里，localStorage 会迅速爆满
 * （原实现发送后即剥离，导致后续轮次 AI "忘记"文件内容）。改为独立缓存：
 * - 发送消息时按 fileId 从缓存取全文注入请求，任意轮次都能带上
 * - 总容量有限（默认 256KB 文本），超出按最旧会话优先淘汰（LRU）
 * - 持久化在 localStorage（独立 key），与聊天会话存储解耦
 */

const STORAGE_KEY = 'icpc-ai-session-files-v1'

/** 全部缓存的总容量上限（字符数）。256K 字符 ≈ 128K token 预算的一半，
 *  聊天会话存储约 5MB localStorage 的 ~5%，留足余量。 */
const MAX_TOTAL_CHARS = 256 * 1024

/** 单个附件的缓存上限：超过的不进缓存（发送那一轮仍带全文，后续轮次退化为文件名占位） */
const MAX_SINGLE_CHARS = 120 * 1024

type FileCache = Map<string, string> // fileId → textContent
type SessionFiles = Map<string, FileCache> // sessionId → files

let cache: SessionFiles | null = null

function load(): SessionFiles {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const data = raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {}
    const out: SessionFiles = new Map()
    for (const [sid, files] of Object.entries(data)) {
      out.set(sid, new Map(Object.entries(files)))
    }
    cache = out
    return out
  } catch {
    cache = new Map()
    return cache
  }
}

function persist(c: SessionFiles): void {
  try {
    const obj: Record<string, Record<string, string>> = {}
    for (const [sid, files] of c) {
      if (files.size > 0) obj[sid] = Object.fromEntries(files)
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
  } catch {
    /* 存储满：缓存降级为仅内存（本次会话仍有效），不阻断聊天 */
  }
}

function totalChars(c: SessionFiles): number {
  let n = 0
  for (const files of c.values()) {
    for (const t of files.values()) n += t.length
  }
  return n
}

/**
 * 记录一批附件全文（发送带附件消息时调用）。
 * 超大单文件跳过；总量超限时按会话插入顺序淘汰最旧会话的文件（当前会话永不淘汰自身）。
 */
export function rememberSessionFiles(sessionId: string, atts: Array<{ fileId: string; textContent?: string }>): void {
  const c = load()
  const files = c.get(sessionId) ?? new Map<string, string>()
  let changed = false
  for (const a of atts) {
    if (typeof a.textContent !== 'string' || !a.textContent) continue
    if (a.textContent.length > MAX_SINGLE_CHARS) continue // 超大文件不缓存
    files.set(a.fileId, a.textContent)
    changed = true
  }
  if (!changed) return
  c.set(sessionId, files)

  // 容量淘汰：从最旧会话开始整会话丢弃（Map 保持插入序；刚 set 的会话移到末尾）
  let total = totalChars(c)
  if (total > MAX_TOTAL_CHARS) {
    for (const [sid, files2] of c) {
      if (total <= MAX_TOTAL_CHARS) break
      if (sid === sessionId) continue // 永不淘汰当前会话
      total -= totalCharsOf(files2)
      c.delete(sid)
    }
    // 仍超限（单会话就超）：保留当前会话最新插入的文件，丢最旧的
    if (total > MAX_TOTAL_CHARS) {
      const cur = c.get(sessionId)!
      for (const [fid, text] of cur) {
        if (total <= MAX_TOTAL_CHARS) break
        total -= text.length
        cur.delete(fid)
      }
    }
  }
  persist(c)
}

function totalCharsOf(files: FileCache): number {
  let n = 0
  for (const t of files.values()) n += t.length
  return n
}

/** 取某会话中一个附件的缓存全文；未缓存返回 undefined */
export function getSessionFileText(sessionId: string, fileId: string): string | undefined {
  return load().get(sessionId)?.get(fileId)
}

/** 删除会话时同步清理其附件缓存 */
export function forgetSessionFiles(sessionId: string): void {
  const c = load()
  if (c.delete(sessionId)) persist(c)
}
