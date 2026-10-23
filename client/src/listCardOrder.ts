/**
 * 题单卡片顺序的纯函数（拖拽排序 / 键盘上移下移共用）。
 *
 * 题单顺序由服务端 problem_lists.position 持久化（GET /api/lists 按 position ASC 返回，
 * POST /api/lists/reorder 收整份 id 数组），这里只负责在客户端算出「拖完/移完应该是
 * 怎样的顺序」。不写 localStorage：顺序只能有一个真相（服务端），否则多设备各排各的。
 *
 * 两个函数在顺序没变时都返回**入参的同一个数组引用**：调用方用 `next === prev` 就能判断
 * 这次操作是不是白做，既不必再比一遍 id 序列，也不会白跑一次 reorder 请求
 *（白跑还会顺带弹一条没有意义的「撤销」提示）。
 */

interface HasId {
  id: number
}

/**
 * 把 dragId 卡片移到 targetId 卡片的**前一位或后一位**（是插位，不是互换）：
 * 其余卡片保持相对顺序，与落点视觉（卡片上/下边缘那条品牌色线）一一对应。
 *
 * - id 不存在、dragId === targetId、移动后顺序与原顺序相同 → 返回原数组引用；
 * - 不修改入参（先复制再搬），React 状态可以直接用返回值替换。
 */
export function moveListCard<T extends HasId>(
  lists: readonly T[],
  dragId: number,
  targetId: number,
  pos: 'before' | 'after',
): T[] {
  // 入参声明 readonly 是为了别误改调用方的 state；「没变就原样交还」时把同一份引用交回去
  const unchanged = lists as T[]
  if (dragId === targetId) return unchanged
  const from = lists.findIndex((l) => l.id === dragId)
  if (from === -1) return unchanged
  if (!lists.some((l) => l.id === targetId)) return unchanged

  const next = lists.slice()
  const [moved] = next.splice(from, 1)
  // 必须先移除再定位目标：目标在拖拽项之后时索引已前移一位，
  // 拿移除前的下标去插，向下拖会稳定差一格（4 拖到 2 后面会落到 3 后面）
  const to = next.findIndex((l) => l.id === targetId)
  next.splice(pos === 'after' ? to + 1 : to, 0, moved)

  // 插回自己的原位（如 1 拖到 2 前面）→ 结果与原顺序逐项相同，按「没变」处理
  if (next.every((l, i) => l.id === lists[i].id)) return unchanged
  return next
}

/**
 * 与相邻一格交换（键盘/触屏的上移、下移按钮）：越界或 id 不存在时返回原数组引用。
 * 与 moveListCard 的区别只在语义——相邻交换是「一步一步挪」，拖拽是「一步到位」。
 */
export function swapListCard<T extends HasId>(lists: readonly T[], id: number, delta: -1 | 1): T[] {
  const unchanged = lists as T[]
  const from = lists.findIndex((l) => l.id === id)
  const to = from + delta
  if (from === -1 || to < 0 || to >= lists.length) return unchanged
  const next = lists.slice()
  const moved = next[from]
  next[from] = next[to]
  next[to] = moved
  return next
}
