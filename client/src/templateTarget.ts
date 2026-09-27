/**
 * 「AI 助手 → 写入模板库」时目标标签的解析（用户反馈：无法指定 AI 把模板放到哪个标签下）。
 *
 * 背景：AI 在 template-add 块里给出 categoryKey，但（a）它可能给出一个已不存在/拼错的 key，
 * （b）用户可能就是想放到自己刚建的自定义标签里。所以写入前允许用户显式选目标标签：
 * 状态里存的是「用户的选择」，本模块负责把「用户选择 → AI 给的 key → 兜底」这一串解析清楚。
 * 纯函数，便于单测。
 */

export interface TemplateCategoryOption {
  key: string
  name: string
  /** 用户自建标签 */
  custom?: boolean
  /** 自建标签下的模板数（服务端 GET /api/templates/categories 下发） */
  templateCount?: number
}

/** 兜底分类：内置课程大纲的第一个分类（基础算法） */
export const FALLBACK_TEMPLATE_CATEGORY = 'basic'

/** key 是否在清单里（自建标签也在清单里） */
export function isKnownTemplateCategory(
  categories: TemplateCategoryOption[],
  key: string | undefined,
): boolean {
  if (!key) return false
  return categories.some((c) => c.key === key)
}

/**
 * 解析某个 template-add 草稿最终写入的目标标签：
 * 1. 用户显式选过 → 用它；
 * 2. AI 给的 categoryKey 在清单里 → 用它（用户没说就尊重 AI 的判断）；
 * 3. 都没有 → 清单里的第一个分类，清单为空时退到 'basic'（服务端会给出明确报错）。
 */
export function resolveTemplateTarget(opts: {
  aiKey: string
  chosen?: string
  categories: TemplateCategoryOption[]
}): string {
  const { aiKey, chosen, categories } = opts
  if (chosen && isKnownTemplateCategory(categories, chosen)) return chosen
  if (isKnownTemplateCategory(categories, aiKey)) return aiKey
  return categories[0]?.key ?? FALLBACK_TEMPLATE_CATEGORY
}

/** 选择器选项文案：自建标签标出来（用户需要一眼看到自己建的标签） */
export function templateCategoryLabel(c: TemplateCategoryOption): string {
  return c.custom ? `${c.name}（自建）` : c.name
}
