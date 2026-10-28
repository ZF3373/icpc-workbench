/**
 * AI 回复结构化围栏块解析（plan-modify / ability-update / template-add / list-create / plan-create）。
 * 独立成文件以满足 fast refresh 的 only-export-components 约束。
 *
 * 设计原则：**围栏按 Markdown 语义识别，块内按严格字段约定校验**。
 * 解析器宁可不出按钮，也不能把半截/畸形的块直接落库。
 */

/* ============================ 围栏块扫描（Markdown 语义） ============================ */

/**
 * 一个被扫出来的行内围栏块（``` / ~~~，长度不限）。
 *
 * 为什么要自己扫而不是直接用 `/```…```/`：
 * AI 在 JSON 的 `idea` / `code` 字段里经常再写一段 Markdown 代码围栏
 * （例如 ```cpp），而**带语言标记的围栏在 Markdown 里不是合法的闭合围栏**
 * （闭合围栏要求整行只有围栏字符）。用懒匹配正则在第一个 ``` 处就收尾，
 * 会把 JSON 截成半截 → 解析失败 → 整个块退化成正文里的死代码卡，按钮也消失。
 * 这里按 CommonMark 的闭合规则扫描：整行只有「同字符、长度不短于开启围栏」才算闭合。
 */
export interface FenceBlock {
  /** 块在原文中的起始偏移（含开启围栏行） */
  start: number
  /** 块在原文中的结束偏移（含闭合围栏行；未闭合时为正文长度） */
  end: number
  /** 围栏之间的内容（不含围栏行） */
  body: string
  /** 是否有真正独占一行的闭合围栏；输出被截断时为 false */
  closed: boolean
}

/** 开启围栏：行首最多 3 空格 + 3 个以上 ``` 或 ~~~ + info string */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/
/** 闭合围栏：整行只有围栏字符（前后允许空格），不能带 info string */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** info string 里是否点名了这个块（大小写不敏感，允许 ```json template-add 这类附加语言词） */
function infoMentionsBlock(info: string, name: string): boolean {
  return info
    .split(/[\s,]+/)
    .map((t) => t.toLowerCase().replace(/[:：]+$/, ''))
    .some((t) => t === name)
}

/** 去掉块名与常见语言词后，info string 里还剩什么（用于兜住「围栏行上直接写 JSON」的写法） */
function infoRemainder(info: string, name: string): string {
  const idx = info.toLowerCase().indexOf(name)
  if (idx < 0) return ''
  // 按原始文本裁掉块名（不能按逗号/空格重新拼 token：会把 JSON 里的分隔符吃掉）
  const rest = info.slice(0, idx) + ' ' + info.slice(idx + name.length)
  return rest
    .replace(/\b(?:jsonc|json5|json|javascript|js|markdown|md|plaintext|text|txt)\b/gi, ' ')
    .trim()
}

/**
 * 扫出回复里所有点了名的围栏块（按出现顺序）。
 *
 * 容忍的写法：```template-add / ```json template-add / ~~~template-add /
 * ````template-add（4 个以上反引号）/ ```TEMPLATE-ADD（大小写）/
 * 块内容直接跟在围栏行后面（```template-add {…}）。
 */
export function findFenceBlocks(reply: string, name: string): FenceBlock[] {
  const blocks: FenceBlock[] = []
  const rawLines = reply.split('\n')
  // 判围栏时忽略行尾 \r（CRLF 输出），但偏移量按原文行长度算
  const lines = rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  // 每行的起始偏移，便于最后按偏移剥离原文
  const starts: number[] = []
  let offset = 0
  for (const line of rawLines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const endOfLine = (i: number): number => starts[i]! + (rawLines[i]?.length ?? 0)

  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i] ?? '')
    if (!open || !infoMentionsBlock(open[2] ?? '', name)) {
      i++
      continue
    }
    const fence = open[1] ?? '```'
    const char = fence[0]!
    // 闭合围栏必须同字符、长度不短于开启围栏，且整行只有围栏字符
    let closeLine = -1
    for (let j = i + 1; j < lines.length; j++) {
      const close = FENCE_CLOSE.exec(lines[j] ?? '')
      if (close && close[1]![0] === char && close[1]!.length >= fence.length) {
        closeLine = j
        break
      }
    }

    const bodyLines = lines.slice(i + 1, closeLine >= 0 ? closeLine : undefined)
    // 围栏行上直接写了 JSON（```template-add {…}）：Markdown 会把它当 info string，
    // 但 AI 的本意是块内容，这里补回正文首行
    const inline = infoRemainder(open[2] ?? '', name)
    const body = (inline.startsWith('{') ? [inline, ...bodyLines] : bodyLines).join('\n')

    blocks.push({
      start: starts[i]!,
      end: closeLine >= 0 ? endOfLine(closeLine) : reply.length,
      body,
      closed: closeLine >= 0,
    })
    i = closeLine >= 0 ? closeLine + 1 : lines.length
  }
  return blocks
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

/* ---------------- template-add 块内 JSON 的容错解析 ---------------- */

/** 草稿已知字段（容错解析时按这些键找成员边界） */
const DRAFT_KEYS = [
  'categoryKey',
  'templateId',
  'name',
  'difficulty',
  'tags',
  'code',
  'idea',
  'complexity',
  'url',
] as const

/**
 * 字段值里的 JSON 转义还原。
 *
 * 不用 `JSON.parse('"' + raw + '"')`：AI 写在 `code` 里的未转义双引号会直接失败，
 * 而这里的目的恰恰是把这种半成品救回来。
 */
function unescapeJsonString(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (_all, esc: string) => {
    switch (esc[0]) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return ''
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case 'u':
        return String.fromCharCode(parseInt(esc.slice(1), 16))
      default:
        // \" \\ \/ 以及未知转义：原样保留被转义的字符
        return esc
    }
  })
}

/**
 * 修掉 LLM 最常见的两类 JSON 失真，再交给 JSON.parse：
 *   1. 字符串里的裸换行/制表符（AI 把多行代码直接写进 `code` 值）；
 *   2. 结尾多余的逗号（`"url": "…",` 后直接 `}`）。
 * 只做「不改变内容」的修补，不凭空补缺失的字段。
 */
export function repairLooseJson(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (!inString) {
      if (c === '"') {
        inString = true
      }
      out += c
      continue
    }
    if (c === '\\') {
      // 转义序列整体保留（连同被转义的字符）
      out += c + (text[i + 1] ?? '')
      i++
      continue
    }
    if (c === '"') {
      inString = false
      out += c
      continue
    }
    if (c === '\n') {
      out += '\\n'
      continue
    }
    if (c === '\r') continue
    if (c === '\t') {
      out += '\\t'
      continue
    }
    out += c
  }
  return stripTrailingCommas(out)
}

/**
 * 去掉 `,` 与 `}`/`]` 之间的尾逗号（字符串外才算）。
 *
 * 不能用 `/,\s*([}\]])/g` 直接替换：字符串内容里也可能出现 `, ]`（例如报错信息），
 * 那样会把用户/代码正文改坏。所以这里同样按「是否在字符串内」逐字符判定。
 */
function stripTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') continue // 尾逗号：丢掉
    }
    out += c
  }
  return out
}

/**
 * 按键切字段的兜底解析：标准 JSON 修不好时（例如 `code` 里有未转义的双引号），
 * 按「形如 `  "key":` 的成员行」把原文切成若干片段，再逐段取值。
 *
 * 关键点：字段值的结束位置由**下一个成员行的起点**界定，而不是由引号配对界定 ——
 * 代码里的 `printf("%d", x)` 这类未转义引号因此不会把值截断。
 */
function looseObjectFields(text: string): Record<string, string> {
  const keyRe = new RegExp(`"(${DRAFT_KEYS.join('|')})"\\s*:`, 'g')
  const hits: Array<{ key: string; index: number; valueStart: number }> = []
  for (let m = keyRe.exec(text); m; m = keyRe.exec(text)) {
    // 只认对象成员位置（前面只剩空白，且上一个非空白字符是 { 或 ,），
    // 避免正文/代码里恰好提到的同名键被当成字段
    const before = text.slice(0, m.index).replace(/\s+$/, '')
    const prev = before[before.length - 1]
    if (prev !== '{' && prev !== ',') continue
    hits.push({ key: m[1]!, index: m.index, valueStart: m.index + m[0].length })
  }
  const out: Record<string, string> = {}
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!
    if (out[hit.key] !== undefined) continue // 同名字段以第一次出现为准
    const valueEnd = i + 1 < hits.length ? hits[i + 1]!.index : text.length
    out[hit.key] = text.slice(hit.valueStart, valueEnd).trim().replace(/,\s*$/, '').trim()
  }
  return out
}

/** 从一个字段原始片段里取字符串值（去掉包裹引号 + 还原转义） */
function looseString(raw: string | undefined): string {
  if (raw === undefined) return ''
  // 末尾可能切进成员分隔符与对象/数组收尾符号（`"…",` / `"…"\n}`）
  const s = raw.trim().replace(/[,}\]\s]+$/, '')
  if (!s.startsWith('"')) return s
  if (!s.endsWith('"') || s.length < 2) return unescapeJsonString(s.slice(1))
  return unescapeJsonString(s.slice(1, -1))
}

/** 从一个字段原始片段里取整数（缺失/非法返回 null，由调用方回退默认值） */
function looseInt(raw: string | undefined): number | null {
  if (raw === undefined) return null
  const n = Number(raw.trim().replace(/,\s*$/, ''))
  return Number.isInteger(n) ? n : null
}

/** 从一个字段原始片段里取字符串数组（先按 JSON 试，失败再按键值列表拆） */
function looseStringArray(raw: string | undefined): string[] {
  if (raw === undefined) return []
  const s = raw.trim().replace(/,\s*$/, '').trim()
  if (s.startsWith('[')) {
    try {
      const v = JSON.parse(repairLooseJson(s))
      if (Array.isArray(v)) return v.map(String)
    } catch {
      // 退化为按逗号拆
    }
    return s
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((t) => looseString(t))
  }
  return []
}

/** 把解析出来的键值对象规整成草稿（缺 name 视为无效块） */
function draftFromFields(fields: Record<string, unknown>): TemplateAddDraft | null {
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  if (!name) return null
  // 先验类型（Number(null)=0 会绕过 isInteger）：数字缺失/非整数按声明回退 3
  const difficulty =
    typeof fields.difficulty === 'number' && Number.isInteger(fields.difficulty) ? fields.difficulty : 3
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  return {
    categoryKey: str(fields.categoryKey),
    name,
    difficulty,
    tags: Array.isArray(fields.tags) ? fields.tags.map(String).filter(Boolean).slice(0, 12) : [],
    code: typeof fields.code === 'string' ? fields.code : '',
    ...(str(fields.idea) !== '' ? { idea: String(fields.idea) } : {}),
    ...(str(fields.complexity) !== '' ? { complexity: String(fields.complexity) } : {}),
    ...(str(fields.url) !== '' ? { url: str(fields.url) } : {}),
    ...(str(fields.templateId) !== '' ? { templateId: str(fields.templateId) } : {}),
  }
}

/**
 * 解析一个 template-add 块的块体。
 *
 * 三级降级：标准 JSON → 修补后 JSON（裸换行/尾逗号）→ 按键切片的兜底解析。
 * `closed` 为 false（输出被截断、没有闭合围栏）时只用前两级：
 * 截断块的 JSON 必然是半截的，硬救出来会得到一条残缺模板，静默入库比不认更糟。
 */
function parseTemplateDraft(body: string, closed: boolean): TemplateAddDraft | null {
  const text = body.trim()
  if (!text) return null
  try {
    return draftFromFields(JSON.parse(text) as Record<string, unknown>)
  } catch {
    // 继续降级
  }
  try {
    return draftFromFields(JSON.parse(repairLooseJson(text)) as Record<string, unknown>)
  } catch {
    // 继续降级
  }
  if (!closed) return null
  const fields = looseObjectFields(text)
  const raw: Record<string, unknown> = {
    categoryKey: looseString(fields.categoryKey),
    templateId: looseString(fields.templateId),
    name: looseString(fields.name),
    difficulty: looseInt(fields.difficulty) ?? undefined,
    tags: looseStringArray(fields.tags),
    code: looseString(fields.code),
    idea: looseString(fields.idea),
    complexity: looseString(fields.complexity),
    url: looseString(fields.url),
  }
  return draftFromFields(raw)
}

/** 一个解析成功的 template-add 块：草稿 + 它在原文里的位置（用于精确剥离） */
export interface TemplateAddBlock {
  draft: TemplateAddDraft
  block: FenceBlock
}

/** 解析回复里全部 template-add 块（连同位置信息；缺 name / JSON 不可救的块跳过） */
export function extractTemplateAddBlocks(
  reply: string,
  /** 已经扫好的围栏块（调用方要同时统计坏块数时复用它，避免重复扫全文） */
  fences: readonly FenceBlock[] = findFenceBlocks(reply, 'template-add'),
): TemplateAddBlock[] {
  const out: TemplateAddBlock[] = []
  for (const block of fences) {
    const draft = parseTemplateDraft(block.body, block.closed)
    if (draft) out.push({ draft, block })
  }
  return out
}

/** 解析回复中全部 template-add 块（AI 模板库写入建议）：返回草稿数组，无块返回空数组 */
export function extractTemplateAdd(reply: string): TemplateAddDraft[] {
  return extractTemplateAddBlocks(reply).map((b) => b.draft)
}

/* ============================ 其余结构化块（严格字段校验） ============================ */

/** 结构化块名（顺序即 UI 提示顺序，与提示词里的块名一一对应） */
export const STRUCTURED_BLOCK_NAMES = ['plan-modify', 'ability-update', 'template-add', 'list-create', 'plan-create'] as const
export type StructuredBlockName = (typeof STRUCTURED_BLOCK_NAMES)[number]

/** 识别到、但格式不合法而未生成操作按钮的块（正文里保留原文，UI 据此说明原因） */
export interface BlockIssue {
  name: StructuredBlockName
  reason: string
}

/** 能力值合法区间：与 POST /api/ai/ability 的服务端校验保持一致（800–3500 的 100 整数倍） */
const ABILITY_MIN = 800
const ABILITY_MAX = 3500
const ABILITY_STEP = 100

/** 解析结果（成功值或失败原因） */
type ParsedValue<T> = { value: T } | { error: string }

/** 块体 → JSON 对象（标准解析 → 修补裸换行/尾逗号）；不是对象或解析失败返回 null */
function parseJsonObject(body: string): Record<string, unknown> | null {
  const text = body.trim()
  if (!text) return null
  for (const candidate of [text, repairLooseJson(text)]) {
    try {
      const v = JSON.parse(candidate) as unknown
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {
      // 换下一种修补再试
    }
  }
  return null
}

/** 块没解析出来时的统一原因（区分「没闭合=被截断」和「闭合了但内容不对」） */
function fenceIssueReason(block: FenceBlock, detail: string): string {
  return block.closed ? detail : '块没有闭合（回复被截断或模型漏写结尾的 ```）'
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 计划任务条目是否可用（date=YYYY-MM-DD + 非空 title） */
function isUsableTask(t: unknown): t is { date: string; title: string } {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  return typeof o.date === 'string' && DATE_RE.test(o.date) && typeof o.title === 'string' && o.title.trim() !== ''
}

/** plan-modify：必须是一个对象，且带**完整**的新任务列表（服务端是整体替换，缺 tasks 会 400） */
function parsePlanModifyBody(body: string): ParsedValue<string> {
  const obj = parseJsonObject(body)
  if (!obj) return { error: '块内不是合法 JSON 对象（可能被截断，或块内又嵌套了 ``` 围栏）' }
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    return { error: '缺少 tasks 数组（计划修改必须给出完整的新任务列表）' }
  }
  if (!obj.tasks.some(isUsableTask)) {
    return { error: 'tasks 里没有有效任务（每条需含 date=YYYY-MM-DD 与非空 title）' }
  }
  return { value: body.trim() }
}

/** ability-update：level 必须是 800–3500 的 100 整数倍（与能力值标尺/服务端校验一致） */
function parseAbilityUpdateBody(body: string): ParsedValue<{ level: number; reason?: string }> {
  const obj = parseJsonObject(body)
  if (!obj) return { error: '块内不是合法 JSON 对象（应为 {"level": 1800, "reason": "…"}）' }
  const level = obj.level
  if (typeof level !== 'number' || !Number.isInteger(level)) {
    return { error: `level 缺失或不是整数（收到 ${JSON.stringify(level) ?? 'undefined'}）` }
  }
  if (level < ABILITY_MIN || level > ABILITY_MAX || level % ABILITY_STEP !== 0) {
    return { error: `level 必须是 ${ABILITY_MIN}–${ABILITY_MAX} 之间 ${ABILITY_STEP} 的整数倍（收到 ${level}）` }
  }
  return { value: { level, ...(typeof obj.reason === 'string' && obj.reason.trim() ? { reason: obj.reason } : {}) } }
}

/** list-create：title + raw（题目列表原文）都必填 */
function parseListCreateBody(body: string): ParsedValue<ListCreateDraft> {
  const v = parseListCreateJson(body)
  if (!v) return { error: '块内不是合法 JSON 对象（应为 {"title": "…", "raw": "…"}）' }
  const title = typeof v.title === 'string' ? v.title.trim() : ''
  const raw = typeof v.raw === 'string' ? v.raw.trim() : ''
  if (!title) return { error: '缺少 title（题单名称）' }
  if (!raw) return { error: '缺少 raw（题目列表原文）' }
  return {
    value: {
      title,
      raw,
      ...(typeof v.sourceUrl === 'string' && v.sourceUrl.trim() !== '' ? { sourceUrl: v.sourceUrl.trim() } : {}),
    },
  }
}

/** plan-create：title + 非空 tasks；startDate/days 可选但必须合法 */
function parsePlanCreateBody(body: string): ParsedValue<PlanCreateDraft> {
  const obj = parseJsonObject(body)
  if (!obj) return { error: '块内不是合法 JSON 对象（可能被截断，或块内又嵌套了 ``` 围栏）' }
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  if (!title) return { error: '缺少 title（计划标题）' }
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    return { error: '缺少 tasks 数组（新计划必须给出任务列表）' }
  }
  if (!obj.tasks.some(isUsableTask)) {
    return { error: 'tasks 里没有有效任务（每条需含 date=YYYY-MM-DD 与非空 title）' }
  }
  const draft: PlanCreateDraft = { title, raw: body.trim() }
  if (typeof obj.startDate === 'string' && DATE_RE.test(obj.startDate)) draft.startDate = obj.startDate
  if (Number.isInteger(obj.days) && (obj.days as number) > 0 && (obj.days as number) <= 90) {
    draft.days = obj.days as number
  }
  return { value: draft }
}

/** list-create 块草稿（AI 建议导入题单到「题单整理」，确认后走 POST /api/lists） */
export interface ListCreateDraft {
  title: string
  raw: string
  sourceUrl?: string
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
 * 容错 JSON 解析：AI 输出的 raw 字段常含未转义换行（多行题目列表），标准 JSON.parse 会失败。
 * 先尝试标准解析，失败后用正则提取 title / raw / sourceUrl 字段值。
 */
function parseListCreateJson(text: string): { title?: string; raw?: string; sourceUrl?: string } | null {
  // 标准解析（AI 正确转义了换行时直接成功）
  try {
    const parsed = JSON.parse(text.trim()) as { title?: unknown; raw?: unknown; sourceUrl?: unknown }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        title: typeof parsed.title === 'string' ? parsed.title : undefined,
        raw: typeof parsed.raw === 'string' ? parsed.raw : undefined,
        sourceUrl: typeof parsed.sourceUrl === 'string' ? parsed.sourceUrl : undefined,
      }
    }
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
  return {
    title: titleM[1],
    raw: rest.slice(0, endM.index),
    ...(urlM ? { sourceUrl: urlM[1] } : {}),
  }
}

/**
 * 解析一条回复里的**全部**结构化块（一次扫全文，供消息渲染与「为什么没有按钮」提示共用）。
 *
 * 每种块最多 1 个（template-add 例外，允许按分类批量输出多个）：重复的块会保留原文
 * 但只认第一个，避免「同一份计划被两个块分别应用」这类歧义。
 */
export interface ParsedStructuredBlocks {
  /** plan-modify 的 JSON 原文（应用时整段交给服务端解析） */
  modify: string | null
  abilityUpd: { level: number; reason?: string } | null
  tplAdds: TemplateAddDraft[]
  tplBlocks: TemplateAddBlock[]
  listDraft: ListCreateDraft | null
  planDraft: PlanCreateDraft | null
  /** 解析成功、应从正文剥离的围栏 */
  parsedFences: FenceBlock[]
  /** 解析失败/重复的块（正文里保留原文，UI 提示原因） */
  issues: BlockIssue[]
}

export function parseStructuredBlocks(reply: string, tplFences?: readonly FenceBlock[]): ParsedStructuredBlocks {
  const out: ParsedStructuredBlocks = {
    modify: null,
    abilityUpd: null,
    tplAdds: [],
    tplBlocks: [],
    listDraft: null,
    planDraft: null,
    parsedFences: [],
    issues: [],
  }

  // template-add：允许多个（一次回复按分类批量沉淀）
  for (const block of tplFences ?? findFenceBlocks(reply, 'template-add')) {
    const draft = parseTemplateDraft(block.body, block.closed)
    if (!draft) {
      out.issues.push({
        name: 'template-add',
        reason: fenceIssueReason(block, 'JSON 不合法或缺少必填字段 name（模板名）'),
      })
      continue
    }
    out.tplBlocks.push({ draft, block })
    out.tplAdds.push(draft)
    out.parsedFences.push(block)
  }

  // 其余四类：每条回复只应有一个
  const singles: Array<{
    name: StructuredBlockName
    parse: (body: string) => ParsedValue<unknown>
    assign: (value: never) => void
    taken: () => boolean
  }> = [
    {
      name: 'plan-modify',
      parse: parsePlanModifyBody,
      assign: (v: string) => { out.modify = v },
      taken: () => out.modify !== null,
    },
    {
      name: 'ability-update',
      parse: parseAbilityUpdateBody,
      assign: (v: { level: number; reason?: string }) => { out.abilityUpd = v },
      taken: () => out.abilityUpd !== null,
    },
    {
      name: 'list-create',
      parse: parseListCreateBody,
      assign: (v: ListCreateDraft) => { out.listDraft = v },
      taken: () => out.listDraft !== null,
    },
    {
      name: 'plan-create',
      parse: parsePlanCreateBody,
      assign: (v: PlanCreateDraft) => { out.planDraft = v },
      taken: () => out.planDraft !== null,
    },
  ]

  for (const spec of singles) {
    for (const block of findFenceBlocks(reply, spec.name)) {
      const parsed = spec.parse(block.body)
      if ('error' in parsed) {
        out.issues.push({ name: spec.name, reason: fenceIssueReason(block, parsed.error) })
        continue
      }
      if (spec.taken()) {
        // 重复块：保留原文没意义（同一个操作会被应用两次），但要把原因说清楚
        out.issues.push({ name: spec.name, reason: `重复的 ${spec.name} 块（每条回复只应有一个），已忽略后一个` })
        out.parsedFences.push(block)
        continue
      }
      spec.assign(parsed.value as never)
      out.parsedFences.push(block)
    }
  }

  return out
}

/** 解析回复中的 plan-modify 块（返回块内 JSON 原文；结构不合法返回 null） */
export function extractModifyBlock(reply: string): string | null {
  return parseStructuredBlocks(reply).modify
}

/** 解析 ability-update 块（AI 能力值调整建议）：{ level, reason } | null */
export function extractAbilityUpdate(reply: string): { level: number; reason?: string } | null {
  return parseStructuredBlocks(reply).abilityUpd
}

/** 解析回复中的 list-create 块（AI 题单导入建议）：返回草稿，无块/不合法返回 null */
export function extractListCreate(reply: string): ListCreateDraft | null {
  return parseStructuredBlocks(reply).listDraft
}

/**
 * 解析回复中的 plan-create 块（AI 训练计划生成建议）。
 * 与 list-create（导入题单到「题单整理」）和 plan-modify（修改已关联的计划）不同：
 * plan-create 用于在聊天中按用户要求**生成全新的训练计划**，确认后创建新计划入库。
 */
export function extractPlanCreate(reply: string): PlanCreateDraft | null {
  return parseStructuredBlocks(reply).planDraft
}

/** 按偏移剥离指定块（从后往前删，避免前面的删除让后面的偏移失效） */
export function stripFenceSpans(reply: string, blocks: readonly FenceBlock[]): string {
  let out = reply
  for (const b of [...blocks].sort((x, y) => y.start - x.start)) {
    out = out.slice(0, b.start) + out.slice(b.end)
  }
  return out.trim()
}

/** 剥离某类结构化块后的可见文本 */
function stripNamedBlock(reply: string, name: StructuredBlockName): string {
  return stripFenceSpans(reply, findFenceBlocks(reply, name))
}

export function stripModifyBlock(reply: string): string {
  return stripNamedBlock(reply, 'plan-modify')
}

export function stripAbilityUpdate(reply: string): string {
  return stripNamedBlock(reply, 'ability-update')
}

export function stripListCreate(reply: string): string {
  return stripNamedBlock(reply, 'list-create')
}

export function stripPlanCreate(reply: string): string {
  return stripNamedBlock(reply, 'plan-create')
}

/** 剥离 template-add 块后的可见文本（所有可识别的块都剥掉） */
export function stripTemplateAdd(reply: string): string {
  return stripFenceSpans(reply, findFenceBlocks(reply, 'template-add'))
}

/** 兼容旧名：按偏移剥离指定块 */
export const stripTemplateBlockSpans = stripFenceSpans
