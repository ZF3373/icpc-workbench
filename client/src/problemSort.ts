/**
 * 题目管理页排序的纯函数桥（issue #38）。
 *
 * 排序**在服务端做**：题目管理页是服务端分页（GET /api/problems/page），
 * 前端只持有当前页 50 行 —— 在前端排只能排当前页，所以这里不排数据，
 * 只负责把状态翻译成查询参数（sort/order），以及把 antd Table 的 sorter 事件翻译成状态。
 * 字段白名单必须与 server/src/routes/problems.ts 的 SORT_KEYS 保持一致。
 */

/** 服务端支持的排序字段 */
export const SORT_FIELDS = [
  'problem_key',
  'difficulty',
  'title',
  'platform',
  'attempts',
  'ac_count',
  'last_ac_at',
] as const

export type SortField = (typeof SORT_FIELDS)[number]

export type SortDirection = 'asc' | 'desc'

/** null = 不排序，用服务端默认顺序（难度降序、未知难度最后） */
export interface SortState {
  field: SortField
  order: SortDirection
}

export function isSortField(v: unknown): v is SortField {
  return typeof v === 'string' && (SORT_FIELDS as readonly string[]).includes(v)
}

/**
 * 把排序写进查询串；未排序时**不写任何参数** —— 服务端见不到 sort 就走默认顺序，
 * 保证默认视图与加排序功能之前逐字一致。
 */
export function appendSortParams(params: URLSearchParams, sort: SortState | null): URLSearchParams {
  if (sort && isSortField(sort.field)) {
    params.set('sort', sort.field)
    params.set('order', sort.order)
  }
  return params
}

/**
 * antd Table 的受控 sortOrder：只有当前排序列显示箭头。
 * 其余列必须显式给 null（不能给 undefined）：缺省 sortOrder 会被 antd 当成非受控列，
 * 于是「点过的列」与「状态里的列」就会各亮各的。
 */
export function sorterOrderOf(sort: SortState | null, field: SortField): 'ascend' | 'descend' | null {
  if (!sort || sort.field !== field) return null
  return sort.order === 'asc' ? 'ascend' : 'descend'
}

/**
 * antd onChange 给出的 sorter.order → 新状态。
 * undefined/null = 第三次点击表头（取消排序），回到服务端默认顺序。
 */
export function sortFromAntd(field: SortField, order: 'ascend' | 'descend' | null | undefined): SortState | null {
  if (order === 'ascend') return { field, order: 'asc' }
  if (order === 'descend') return { field, order: 'desc' }
  return null
}

/**
 * 从 antd 的 sorter 描述里取出白名单字段：columnKey 优先，其次是 dataIndex
 * （数组型 dataIndex 取第一段）。取不到白名单字段 → null，调用方按「取消排序」处理。
 */
export function sortFieldOf(sorter: { columnKey?: unknown; field?: unknown } | undefined): SortField | null {
  const field = sorter?.field
  const dataIndex = Array.isArray(field) ? field[0] : field
  for (const candidate of [sorter?.columnKey, dataIndex]) {
    if (isSortField(candidate)) return candidate
  }
  return null
}

/** 表头 tooltip：antd 的默认文案只说升/降序，这里补上「第三次点击取消」与「全量排序」 */
export function sortTooltip(label: string, note?: string): string {
  return `${label}排序：点击升序 → 再点降序 → 第三次取消排序（按全部结果排序，不只是当前页）${note ? `；${note}` : ''}`
}
