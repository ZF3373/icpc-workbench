/**
 * 题目管理页的客户端过滤纯函数（「过滤问题」面板 + 状态页签共用）。
 * 标签按「逻辑或」组合：命中任一所选标签（含同义别名，如 二分 ↔ binary search）即保留该题。
 */
import { expandTag } from '../../shared/src/index.ts'

export interface ProblemFilterInput {
  tags: string[]
  difficulty: number | null
  status: 'ac' | 'tried' | 'none'
}

export interface ProblemFilterSpec {
  /** 所选标签的同义集合并集（空集 = 不限标签） */
  tagAliases: Set<string>
  /** 难度区间（闭区间，CF rating 标尺；均为 undefined = 不限难度） */
  diffMin?: number
  diffMax?: number
  status: 'ac' | 'tried' | 'none' | 'all'
}

/** 所选标签的同义集合并集：选中「二分」也能命中标着「binary search」的题（反向同理） */
export function buildTagAliasSet(tags: string[]): Set<string> {
  const aliases = new Set<string>()
  for (const t of tags) for (const name of expandTag(t)) aliases.add(name)
  return aliases
}

/**
 * 判断一题是否通过过滤：
 * - 标签：逻辑或，任一所选标签的同义别名命中即通过；空选择 = 不限
 * - 难度：设置了区间时，未知难度的题不显示（与 CF 过滤行为一致）
 * - 状态：all = 不限
 */
export function matchesProblemFilters(row: ProblemFilterInput, f: ProblemFilterSpec): boolean {
  if (f.tagAliases.size > 0 && !row.tags.some((t) => f.tagAliases.has(t))) return false
  if (f.diffMin != null || f.diffMax != null) {
    if (row.difficulty == null) return false
    if (f.diffMin != null && row.difficulty < f.diffMin) return false
    if (f.diffMax != null && row.difficulty > f.diffMax) return false
  }
  if (f.status !== 'all' && row.status !== f.status) return false
  return true
}
