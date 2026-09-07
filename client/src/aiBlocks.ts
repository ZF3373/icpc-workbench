/**
 * AI 回复结构化围栏块解析（plan-modify / ability-update）。
 * 独立成文件以满足 fast refresh 的 only-export-components 约束。
 */

/** 提取 AI 回复中的 ```plan-modify 围栏块（容错 ```json 变体：正文含块名即可） */
export function extractModifyBlock(reply: string): string | null {
  const m = reply.match(/```[a-zA-Z-]*plan-modify[\s\S]*?\n([\s\S]*?)```/)
  return m ? m[1] : null
}

/** 剥离 plan-modify 块后的可见文本 */
export function stripModifyBlock(reply: string): string {
  return reply.replace(/```[a-zA-Z-]*plan-modify[\s\S]*?```/g, '').trim()
}

/** 解析 ability-update 块（AI 能力值调整建议）：{ level, reason } | null */
export function extractAbilityUpdate(reply: string): { level: number; reason?: string } | null {
  const m = reply.match(/```[a-zA-Z-]*ability-update[\s\S]*?\n([\s\S]*?)```/)
  if (!m) return null
  try {
    const v = JSON.parse(m[1].trim()) as { level?: unknown; reason?: unknown }
    const level = Number(v.level)
    if (!Number.isInteger(level)) return null
    return { level, ...(typeof v.reason === 'string' ? { reason: v.reason } : {}) }
  } catch {
    return null
  }
}

/** 剥离 ability-update 块后的可见文本 */
export function stripAbilityUpdate(reply: string): string {
  return reply.replace(/```[a-zA-Z-]*ability-update[\s\S]*?```/g, '').trim()
}

/** template-add 块草稿（AI 建议写入模板库的模板内容，确认后走 POST /api/templates/custom） */
export interface TemplateAddDraft {
  categoryKey: string
  name: string
  difficulty: number
  tags: string[]
  code: string
  idea?: string
  complexity?: string
  url?: string
}

/** 解析 template-add 块（AI 模板库写入建议）：缺 name 视为无效返回 null */
export function extractTemplateAdd(reply: string): TemplateAddDraft | null {
  const m = reply.match(/```[a-zA-Z ]*template-add[\s\S]*?\n([\s\S]*?)```/)
  if (!m) return null
  try {
    const v = JSON.parse(m[1].trim()) as Record<string, unknown>
    const name = typeof v.name === 'string' ? v.name.trim() : ''
    if (!name) return null
    const difficulty = Number(v.difficulty)
    return {
      categoryKey: typeof v.categoryKey === 'string' ? v.categoryKey.trim() : '',
      name,
      difficulty: Number.isInteger(difficulty) ? difficulty : 3,
      tags: Array.isArray(v.tags) ? v.tags.map(String).filter(Boolean).slice(0, 12) : [],
      code: typeof v.code === 'string' ? v.code : '',
      ...(typeof v.idea === 'string' && v.idea.trim() !== '' ? { idea: v.idea } : {}),
      ...(typeof v.complexity === 'string' && v.complexity.trim() !== '' ? { complexity: v.complexity } : {}),
      ...(typeof v.url === 'string' && v.url.trim() !== '' ? { url: v.url.trim() } : {}),
    }
  } catch {
    return null
  }
}

/** 剥离 template-add 块后的可见文本 */
export function stripTemplateAdd(reply: string): string {
  return reply.replace(/```[a-zA-Z ]*template-add[\s\S]*?```/g, '').trim()
}
