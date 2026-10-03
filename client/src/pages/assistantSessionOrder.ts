/**
 * AI 助手会话列表的顺序操作（纯函数，便于单测）。
 *
 * 为什么单独抽出来：会话顺序同时被两条路径改写 —— 鼠标拖拽（`reorderSessions`）与
 * 键盘上移/下移（拖拽的无障碍替代，见 §6.2）。两条路径都要求「找不到就什么都不做」
 * 且能撤销，而这些判定放在组件里测不了（仓库没有组件测试设施，见 assistantStopOrder.test.ts
 * 的说明）。这里只做数组搬运，不碰 localStorage、不碰 React 状态。
 */

/** 参与排序的最小结构：只要 id 稳定，就能按它定位 */
export interface OrderedById {
  id: string
}

/** 当前顺序的 id 快照（撤销提示用：只存 id，不持有会话对象引用） */
export function sessionIdOrder<T extends OrderedById>(sessions: readonly T[]): string[] {
  return sessions.map((s) => s.id)
}

/**
 * 把 `id` 对应的元素上移/下移一格（delta = -1 / +1）。
 *
 * 返回新数组；id 不存在、或已在首/尾（越界）时返回 null —— 调用方据此跳过
 * 「已调整顺序」提示，避免出现「按了没反应却弹出撤销」。
 */
export function moveSessionBy<T extends OrderedById>(
  sessions: readonly T[],
  id: string,
  delta: -1 | 1,
): T[] | null {
  const from = sessions.findIndex((s) => s.id === id)
  if (from === -1) return null
  const to = from + delta
  if (to < 0 || to >= sessions.length) return null
  const next = [...sessions]
  const [moved] = next.splice(from, 1)
  // moved 一定存在：from 已通过边界校验
  next.splice(to, 0, moved as T)
  return next
}

/**
 * 置顶分区：置顶会话整体排在未置顶之前，组内保持原有手动顺序。
 *
 * 只做展示层的稳定分区，不改写 store 数组 —— 拖拽/撤销快照描述的仍是用户手动排出的
 * 顺序，还原之后再走一遍这个分区就得到一致的画面。两次 filter 各自保序，所以
 * 「同为置顶」或「同为未置顶」的会话彼此不会被这一步打乱。
 */
export function pinFirstOrder<T extends OrderedById & { pinned: boolean }>(
  sessions: readonly T[],
): T[] {
  return [...sessions.filter((s) => s.pinned), ...sessions.filter((s) => !s.pinned)]
}

/**
 * 按 id 序列还原顺序（撤销用）。
 *
 * 只在「id 集合完全一致」时应用：撤销提示有 3 秒窗口，期间用户可能新建/删除会话，
 * 那时旧快照的 id 已经对不上，强行还原会把新会话挤掉或让顺序错位。返回 null 让调用方
 * 提示「会话列表已变化，无法撤销」，而不是悄悄做半截操作。
 */
export function restoreSessionOrder<T extends OrderedById>(
  sessions: readonly T[],
  orderedIds: readonly string[],
): T[] | null {
  if (orderedIds.length !== sessions.length) return null
  const pool = new Map(sessions.map((s) => [s.id, s]))
  const next: T[] = []
  for (const id of orderedIds) {
    const s = pool.get(id)
    // 快照里出现重复 id 或陌生 id 时同样判为「已变化」
    if (!s) return null
    pool.delete(id)
    next.push(s)
  }
  return next
}
