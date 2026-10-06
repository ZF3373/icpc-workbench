import { codeOfTag } from '../../shared/src/index.ts'

/** 用户在题目页声明的卡点类型，与服务端 INTENT_OUTCOMES 白名单逐字一致 */
export type IntentOutcome = 'cant_start' | 'editorial' | 'upsolved' | 'wrong_approach' | 'implementation' | 'slight_bug'

export const INTENT_OPTIONS: ReadonlyArray<{ value: IntentOutcome; label: string; hint: string }> = [
  { value: 'cant_start', label: '完全不会', hint: '不知道从哪下手，看题解才懂' },
  { value: 'editorial', label: '看题解/讲解', hint: '做出来前看过题解或视频讲解' },
  { value: 'upsolved', label: '赛后补题', hint: '赛时没做出来，赛后看题解等方法补的' },
  { value: 'wrong_approach', label: '思路错', hint: '方向想错了，或漏了情况' },
  { value: 'implementation', label: '实现崩溃', hint: '知道怎么做，但写不出来/调不通' },
  { value: 'slight_bug', label: '差一点', hint: '思路对，小 bug 或边界没处理' },
]

/** 题库页的 tags 是知识点展示名（未标注题则是题源 tag token），而接口要求 taxonomy code。
 *  映射不到 code 的标签直接丢弃（不可作为 code 提交），并按出现顺序去重。 */
export function codeOptionsFromTags(tags: string[]): Array<{ value: string; label: string }> {
  const seen = new Set<string>()
  const result: Array<{ value: string; label: string }> = []
  for (const tag of tags) {
    const code = codeOfTag(tag)
    if (!code || seen.has(code)) continue
    seen.add(code)
    result.push({ value: code, label: tag })
  }
  return result
}

/** 构造「记录卡点」POST 请求路径，对平台与题号都 encodeURIComponent 防止特殊字符（含空格、斜杠）出错。 */
export function intentPath(platform: string, problemKey: string): string {
  return `/api/problems/${encodeURIComponent(platform)}/${encodeURIComponent(problemKey)}/intent`
}

/** 该题已有的卡点记录（GET /intents 的条目）。createdAt 为服务端 SQLite datetime 字符串。 */
export interface IntentRecord {
  id: number
  code: string | null
  outcome: IntentOutcome
  createdAt: string
}

/** 构造「已有卡点记录」GET 请求路径（编码口径与 intentPath 一致）。 */
export function intentsPath(platform: string, problemKey: string): string {
  return `/api/problems/${encodeURIComponent(platform)}/${encodeURIComponent(problemKey)}/intents`
}

/** 构造「撤销单条卡点」DELETE 请求路径。intentId 是服务端自增 id，无需编码。 */
export function intentDeletePath(platform: string, problemKey: string, intentId: number): string {
  return `/api/problems/${encodeURIComponent(platform)}/${encodeURIComponent(problemKey)}/intents/${intentId}`
}

/** 卡点类型 → 展示名（记录列表与行角标共用；未知 value 原样回显，防服务端新增类型时崩 UI）。 */
export function intentLabel(outcome: string): string {
  return INTENT_OPTIONS.find((o) => o.value === outcome)?.label ?? outcome
}

/**
 * 题目行角标的悬停摘要：无记录返回 null（不渲染角标）；有则「卡过 N 次 · 最差卡点」。
 * 最差卡点由服务端按 intentFactor（弱项口径）选定，这里只负责展示。
 */
export function intentBadgeSummary(intentCount: number, worstIntent?: string | null): string | null {
  if (!Number.isInteger(intentCount) || intentCount <= 0) return null
  const worstPart = worstIntent ? ` · ${intentLabel(worstIntent)}` : ''
  return `卡过 ${intentCount} 次${worstPart}`
}

/** 构造「记录卡点」请求体：code 缺失或为空字符串时均不发送该字段。 */
export function buildIntentBody(outcome: IntentOutcome, code?: string): { outcome: IntentOutcome; code?: string } {
  return code ? { outcome, code } : { outcome }
}
