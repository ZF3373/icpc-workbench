/** 题目笔记的类型与接口约定（GET/POST/PATCH/DELETE /api/notes，打卡见 POST /api/checkins）。 */
export type NoteBlock =
  | { type: 'markdown'; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'image'; url: string; name: string; caption: string }
  | { type: 'attachment'; url: string; name: string; size: number }

export type NoteBlockType = NoteBlock['type']

export interface ProblemNote {
  id: number
  problemId: number | null
  taskId: number | null
  labels: string[]
  content: string
  blocks: NoteBlock[]
  createdAt: string
  updatedAt: string
  taskTitle: string | null
  taskDate: string | null
  planTitle: string | null
}

/** 编辑中的框：key 只用于 React 列表，uploading 表示文件还在上传 */
export type DraftBlock = NoteBlock & { key: string; uploading?: boolean }

export interface NoteDraft {
  blocks: DraftBlock[]
  labels: string[]
}

export type NoteDraftUpdate = (prev: NoteDraft) => NoteDraft

let nextKey = 0
const withKey = <T extends NoteBlock>(block: T): T & { key: string } => {
  nextKey += 1
  return { ...block, key: `b${nextKey}` }
}

export function newBlock(type: NoteBlockType): DraftBlock {
  switch (type) {
    case 'markdown':
      return withKey({ type, text: '' })
    case 'code':
      return withKey({ type, language: 'cpp', code: '' })
    case 'image':
      return withKey({ type, url: '', name: '', caption: '' })
    case 'attachment':
      return withKey({ type, url: '', name: '', size: 0 })
  }
}

/** 新笔记默认一个 Markdown 框；它和其它框一样可以删掉 */
export const newDraft = (): NoteDraft => ({ blocks: [newBlock('markdown')], labels: [] })

export const toDraft = (note: ProblemNote): NoteDraft => ({ blocks: note.blocks.map(withKey), labels: note.labels })

const isEmptyBlock = (b: NoteBlock): boolean => {
  switch (b.type) {
    case 'markdown':
      return b.text.trim() === ''
    case 'code':
      return b.code.trim() === ''
    default:
      return b.url === ''
  }
}

/** 发给服务端的结构：去掉空框和前端字段（框的数量不设限） */
export function draftPayload(draft: NoteDraft): { blocks: NoteBlock[]; labels: string[] } {
  const blocks = draft.blocks
    .filter((b) => !isEmptyBlock(b))
    .map(({ key: _key, uploading: _uploading, ...block }) => block as NoteBlock)
  return { blocks, labels: draft.labels }
}

export const isBlankNote = (draft: NoteDraft): boolean => draft.blocks.every(isEmptyBlock)

export const isUploading = (draft: NoteDraft): boolean => draft.blocks.some((b) => b.uploading)

export const isNoteDirty = (draft: NoteDraft, note: ProblemNote): boolean =>
  JSON.stringify(draftPayload(draft)) !== JSON.stringify({ blocks: note.blocks, labels: note.labels })

export function moveBlock(blocks: readonly DraftBlock[], key: string, delta: -1 | 1): DraftBlock[] {
  const from = blocks.findIndex((b) => b.key === key)
  const to = from + delta
  if (from < 0 || to < 0 || to >= blocks.length) return [...blocks]
  const next = [...blocks]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export const NOTE_LABEL_OPTIONS = ['思路', '踩坑', '易错', '复盘', '模板', '待回看'].map((value) => ({ value, label: value }))

export const MAX_NOTE_LABELS = 5

export const CODE_LANGUAGE_OPTIONS = [
  { value: 'cpp', label: 'C++' },
  { value: 'c', label: 'C' },
  { value: 'python', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'bash', label: 'Shell' },
  { value: '', label: '纯文本' },
]

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 用于展示的代码围栏：比代码里最长的连续反引号再长一截，避免提前闭合 */
export function codeFence(language: string, code: string): string {
  const longest = Math.max(2, ...(code.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${language}\n${code}\n${fence}`
}
