/**
 * AI 建议顺序 → 题单新顺序的纯函数（「按建议重排」共用，reviewDue.ts 同款的抽出动机：
 * 这套合并规则只此一处定义，弹窗按钮与未来任何调用方不会各合并各的）。
 */

interface HasId {
  id: number
}

/**
 * 把 AI 建议顺序（条目 id 数组）套到当前条目上，返回完整新顺序：
 * - 建议里排到的按建议先后排；
 * - 没排到的（AI 漏排、生成后又新增的题）按当前相对顺序接到末尾——
 *   reorder 接口要求恰好覆盖全部条目，缺一个都会被整单拒绝；
 * - 建议里已不存在的 id（生成后删除的题）静默跳过；重复 id 只取第一次。
 */
export function mergeSuggestedOrder<T extends HasId>(orderIds: readonly number[], items: readonly T[]): T[] {
  const byId = new Map(items.map((it) => [it.id, it] as const))
  const picked = new Set<number>()
  const out: T[] = []
  for (const id of orderIds) {
    const it = byId.get(id)
    if (!it || picked.has(id)) continue
    picked.add(id)
    out.push(it)
  }
  for (const it of items) if (!picked.has(it.id)) out.push(it)
  return out
}
