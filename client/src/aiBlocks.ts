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

/** template-add 块草稿（AI 建议写入模板库的模板内容，确认后写入） */
export interface TemplateAddDraft {
  categoryKey: string
  name: string
  difficulty: number
  tags: string[]
  code: string
  idea?: string
  complexity?: string
  url?: string
  /** 可选：已有内置模板的 id（如 math-game-theory）。
   *  存在时写入该内置条目（PUT /api/templates/:id/content），而非新建自定义模板 */
  templateId?: string
}

/** 解析回复中全部 template-add 块（AI 模板库写入建议）：返回草稿数组，缺 name 的块跳过，无块返回空数组 */
export function extractTemplateAdd(reply: string): TemplateAddDraft[] {
  const drafts: TemplateAddDraft[] = []
  for (const m of reply.matchAll(/```[a-zA-Z ]*template-add[\s\S]*?\n([\s\S]*?)```/g)) {
    try {
      const v = JSON.parse(m[1].trim()) as Record<string, unknown>
      const name = typeof v.name === 'string' ? v.name.trim() : ''
      if (!name) continue
      const difficulty = Number(v.difficulty)
      drafts.push({
        categoryKey: typeof v.categoryKey === 'string' ? v.categoryKey.trim() : '',
        name,
        difficulty: Number.isInteger(difficulty) ? difficulty : 3,
        tags: Array.isArray(v.tags) ? v.tags.map(String).filter(Boolean).slice(0, 12) : [],
        code: typeof v.code === 'string' ? v.code : '',
        ...(typeof v.idea === 'string' && v.idea.trim() !== '' ? { idea: v.idea } : {}),
        ...(typeof v.complexity === 'string' && v.complexity.trim() !== '' ? { complexity: v.complexity } : {}),
        ...(typeof v.url === 'string' && v.url.trim() !== '' ? { url: v.url.trim() } : {}),
        ...(typeof v.templateId === 'string' && v.templateId.trim() !== '' ? { templateId: v.templateId.trim() } : {}),
      })
    } catch {
      // 单块 JSON 非法跳过，不影响其余块解析
    }
  }
  return drafts
}

/** 剥离 template-add 块后的可见文本 */
export function stripTemplateAdd(reply: string): string {
  return reply.replace(/```[a-zA-Z ]*template-add[\s\S]*?```/g, '').trim()
}

/** list-create 块草稿（AI 建议导入题单到「题单整理」，确认后走 POST /api/lists） */
export interface ListCreateDraft {
  title: string
  raw: string
  sourceUrl?: string
}

/**
 * 容错 JSON 解析：AI 输出的 raw 字段常含未转义换行（多行题目列表），标准 JSON.parse 会失败。
 * 先尝试标准解析，失败后用正则提取 title / raw / sourceUrl 字段值。
 */
function parseListCreateJson(text: string): { title?: string; raw?: string; sourceUrl?: string } | null {
  // 标准解析（AI 正确转义了换行时直接成功）
  try {
    return JSON.parse(text.trim()) as { title?: string; raw?: string; sourceUrl?: string }
  } catch {
    // 降级：正则提取各字段（兼容 raw 含未转义换行的情况）
  }
  // title: "title": "..."（单行值，取到下一个引号）
  const titleM = text.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  // sourceUrl: 同理
  const urlM = text.match(/"sourceUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  // raw: "raw": "..." — 值可能跨多行，取到与 sourceUrl/} 配对的结尾引号
  // 策略：找 "raw": " 开始位置，从末尾向前找配对的 "
  const rawStart = text.match(/"raw"\s*:\s*"/)
  if (!rawStart || !titleM) return null
  const valStart = rawStart.index! + rawStart[0].length
  // raw 值的结束：找下一个在 sourceUrl 或 } 之前的 "
  const rest = text.slice(valStart)
  // 从 rest 中找 "\n  "sourceUrl" 或 "\n}" 的位置，往前取到最近的 "
  const endM = rest.match(/"\s*,?\s*(?:"sourceUrl"|\n\s*\}|\})/)
  if (!endM) return null
  const rawVal = rest.slice(0, endM.index)
  return {
    title: titleM[1],
    raw: rawVal,
    ...(urlM ? { sourceUrl: urlM[1] } : {}),
  }
}

/** 解析回复中的 list-create 块（AI 题单导入建议）：返回草稿，无块返回 null */
export function extractListCreate(reply: string): ListCreateDraft | null {
  const m = reply.match(/```[a-zA-Z-]*list-create[\s\S]*?\n([\s\S]*?)```/)
  if (!m) return null
  const v = parseListCreateJson(m[1])
  if (!v) return null
  const title = typeof v.title === 'string' ? v.title.trim() : ''
  const raw = typeof v.raw === 'string' ? v.raw.trim() : ''
  if (!title || !raw) return null
  return {
    title,
    raw,
    ...(typeof v.sourceUrl === 'string' && v.sourceUrl.trim() !== '' ? { sourceUrl: v.sourceUrl.trim() } : {}),
  }
}

/** 剥离 list-create 块后的可见文本 */
export function stripListCreate(reply: string): string {
  return reply.replace(/```[a-zA-Z-]*list-create[\s\S]*?```/g, '').trim()
}

/** plan-create 块草稿（AI 建议生成新训练计划，确认后走 POST /api/plans/import） */
export interface PlanCreateDraft {
  title: string
  /** 块内 JSON 原文（发给 /api/plans/import 的 raw 参数，parsePlanJson 会容错解析） */
  raw: string
  startDate?: string
  days?: number
}

/**
 * 解析回复中的 plan-create 块（AI 训练计划生成建议）。
 * 与 list-create（导入题单到「题单整理」）和 plan-modify（修改已关联的计划）不同：
 * plan-create 用于在聊天中按用户要求**生成全新的训练计划**，确认后创建新计划入库。
 */
export function extractPlanCreate(reply: string): PlanCreateDraft | null {
  const m = reply.match(/```[a-zA-Z-]*plan-create[\s\S]*?\n([\s\S]*?)```/)
  if (!m) return null
  const blockText = m[1].trim()
  // 容错解析：先尝试标准 JSON.parse，失败后截取 {...} 并修尾逗号
  let v: { title?: unknown; startDate?: unknown; days?: unknown }
  try {
    v = JSON.parse(blockText) as typeof v
  } catch {
    try {
      const start = blockText.indexOf('{')
      const end = blockText.lastIndexOf('}')
      if (start === -1 || end <= start) return null
      const cleaned = blockText
        .slice(start, end + 1)
        .replace(/,\s*([}\]])/g, '$1')
      v = JSON.parse(cleaned) as typeof v
    } catch {
      return null
    }
  }
  const title = typeof v.title === 'string' ? v.title.trim() : ''
  if (!title) return null
  const draft: PlanCreateDraft = { title, raw: blockText }
  if (typeof v.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.startDate)) {
    draft.startDate = v.startDate
  }
  if (Number.isInteger(v.days) && (v.days as number) > 0 && (v.days as number) <= 90) {
    draft.days = v.days as number
  }
  return draft
}

/** 剥离 plan-create 块后的可见文本 */
export function stripPlanCreate(reply: string): string {
  return reply.replace(/```[a-zA-Z-]*plan-create[\s\S]*?```/g, '').trim()
}
