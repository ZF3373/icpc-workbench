import { codeOfTag } from '../../shared/src/index.ts'

/** 用户在题目页声明的卡点类型，与服务端 INTENT_OUTCOMES 白名单逐字一致 */
export type IntentOutcome = 'cant_start' | 'editorial' | 'wrong_approach' | 'implementation' | 'slight_bug'

export const INTENT_OPTIONS: ReadonlyArray<{ value: IntentOutcome; label: string; hint: string }> = [
  { value: 'cant_start', label: '完全不会', hint: '不知道从哪下手，看题解才懂' },
  { value: 'editorial', label: '看题解/讲解', hint: '做出来前看过题解或视频讲解' },
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

/** 构造「记录卡点」请求体：code 缺失或为空字符串时均不发送该字段。 */
export function buildIntentBody(outcome: IntentOutcome, code?: string): { outcome: IntentOutcome; code?: string } {
  return code ? { outcome, code } : { outcome }
}
