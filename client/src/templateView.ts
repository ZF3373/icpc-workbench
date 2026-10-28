import { readJson, writeJson } from './persistence.ts'

/**
 * 模板库视图快照：记住上次选择的课程分类与页面滚动位置。
 *
 * 模板库的列表很长（内置 18 个分类），从别的页面切回来时从第一个分类、页面顶部
 * 重新开始，等于每次都要重新找位置。这里只存「视图状态」，不碰学习内容本身。
 *
 * 读取时做结构归一化：localStorage 是用户可以手改、也可能残留旧版本的，
 * 非法字段直接丢弃而不是让页面崩在恢复逻辑里。
 */

export const TEMPLATE_VIEW_KEY = 'icpc-template-view-v1'

export interface TemplateViewState {
  /** 上次选中的分类 key；分类已删除时由页面回退到第一个分类 */
  categoryKey: string | null
  /** 页面滚动位置（window.scrollY） */
  scrollTop: number
}

/** 上限只用于挡住手改/异常值，正常长列表远到不了 */
const MAX_SCROLL_TOP = 10_000_000

export function normalizeTemplateViewState(raw: unknown): TemplateViewState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as { categoryKey?: unknown; scrollTop?: unknown }
  const categoryKey =
    typeof value.categoryKey === 'string' && value.categoryKey.trim()
      ? value.categoryKey.trim()
      : null
  const rawScroll = typeof value.scrollTop === 'number' && Number.isFinite(value.scrollTop)
    ? Math.floor(value.scrollTop)
    : 0
  const scrollTop = Math.min(MAX_SCROLL_TOP, Math.max(0, rawScroll))
  if (categoryKey === null && scrollTop === 0) return null
  return { categoryKey, scrollTop }
}

export function readTemplateViewState(): TemplateViewState | null {
  return normalizeTemplateViewState(readJson<unknown>(TEMPLATE_VIEW_KEY))
}

export function writeTemplateViewState(state: TemplateViewState): void {
  writeJson(TEMPLATE_VIEW_KEY, state)
}
