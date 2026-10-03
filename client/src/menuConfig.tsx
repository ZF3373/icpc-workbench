/**
 * 侧边栏菜单元数据 + 分组定义 + 拖拽顺序持久化（纯 localStorage，无后端）。
 * 顺序写入后广播自定义事件，同标签页即时生效、跨标签页经 storage 事件同步。
 */
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import {
  CalendarOutlined,
  CodeOutlined,
  DashboardOutlined,
  FileTextOutlined,
  FlagOutlined,
  HeatMapOutlined,
  InfoCircleOutlined,
  ReadOutlined,
  RobotOutlined,
  ScheduleOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  TagsOutlined,
} from '@ant-design/icons'

export interface MenuMeta {
  key: string
  icon: ReactNode
  label: string
}

/** 全部菜单项的元数据（key = 路由路径） */
export const MENU: MenuMeta[] = [
  { key: '/', icon: <DashboardOutlined />, label: '数据概览' },
  { key: '/today', icon: <ThunderboltOutlined />, label: '今日训练' },
  { key: '/ai', icon: <RobotOutlined />, label: 'AI 助手' },
  { key: '/templates', icon: <CodeOutlined />, label: '模板库' },
  { key: '/lists', icon: <TagsOutlined />, label: '题单整理' },
  { key: '/problems', icon: <FileTextOutlined />, label: '题目管理' },
  { key: '/mastery', icon: <HeatMapOutlined />, label: '掌握度地图' },
  { key: '/plans', icon: <ScheduleOutlined />, label: '训练计划' },
  { key: '/calendar', icon: <CalendarOutlined />, label: '日历打卡' },
  { key: '/reviews', icon: <ReadOutlined />, label: '复习库' },
  { key: '/contests', icon: <FlagOutlined />, label: '赛事中心' },
  { key: '/settings', icon: <SettingOutlined />, label: '设置' },
  { key: '/about', icon: <InfoCircleOutlined />, label: '关于' },
]

const menuMap = new Map(MENU.map((m) => [m.key, m]))
export const menuIcon = (key: string): ReactNode => menuMap.get(key)?.icon
export const menuLabel = (key: string): string => menuMap.get(key)?.label ?? key

/** 分组定义：按「计划 → 训练 → 复盘 → 参赛」的任务流分组，而不是功能清单。 */
export interface MenuGroup {
  key: string
  label: string
  /** 组内默认顺序 */
  items: string[]
}

/**
 * 三组任务流（UI 优化方案 §4.1，含后续调整）：
 * - 训练：今天做什么、怎么学、怎么练 —— 今日训练 / AI 助手 / 模板库 / 训练计划
 * - 题库：找题、整理、练与复习 —— 题目管理 / 题单整理 / 复习库 / 掌握度地图
 * - 赛事：报名参赛、打卡 —— 赛事中心 / 日历打卡
 *
 * 与文档表格的两处有意偏差（文档漏了路由，照抄会丢入口）：
 * 1. `/lists`（题单整理）文档未列出，归入「题库」（它就是整理题目的地方）；
 * 2. `/mastery`（掌握度地图）最终归入「题库」——它分析的就是题目掌握情况，
 *    放题库让「找题 → 练 → 复习 → 看弱项」在同一组闭环；原先单独成组的「数据」
 *    组随之取消，`/`（数据概览）仍是固定置顶项，不进任何分组。
 *    注意：老用户存储里的 `stats` 组键会被 getMenuOrder 忽略，组内顺序无需迁移。
 */
export const MENU_GROUPS: MenuGroup[] = [
  { key: 'training', label: '训练', items: ['/today', '/ai', '/templates', '/plans'] },
  { key: 'bank', label: '题库', items: ['/problems', '/lists', '/reviews', '/mastery'] },
  { key: 'contest', label: '赛事', items: ['/contests', '/calendar'] },
]

/** 固定项（不在分组内、不可拖拽） */
export const MENU_FIXED_TOP = '/'
export const MENU_FIXED_BOTTOM: string[] = ['/settings', '/about']

// ---------- 顺序持久化 ----------

const ORDER_KEY = 'icpc-menu-order-v2'
/** v1 的两组（训练 / 题库与记录）；分组重组后只用来迁移用户已有的自定义顺序 */
const LEGACY_ORDER_KEY = 'icpc-menu-order-v1'
const LEGACY_GROUP_ORDER = ['training', 'records'] as const
const CHANGE_EVENT = 'icpc-menu-order-change'

/** 组 key → 组内顺序。用宽松索引签名，新增分组时不必改类型 */
export type MenuOrder = Record<string, string[]>

const DEFAULT_ORDER: MenuOrder = Object.fromEntries(
  MENU_GROUPS.map((g) => [g.key, [...g.items]]),
)

/** 把 localStorage 里读到的顺序与默认顺序对齐：过滤已删除的 key、追加新增的 key */
function reconcile(stored: string[], defaults: string[]): string[] {
  const known = new Set(defaults)
  const result = stored.filter((k) => known.has(k))
  for (const k of defaults) {
    if (!result.includes(k)) result.push(k)
  }
  return result
}

/**
 * 从 v1 迁移用户的自定义顺序。
 *
 * v1 是 `{ training: [...], records: [...] }`，两组的内容与 v2 的四组不同，
 * 直接丢弃等于把用户排过的顺序清空。做法：把 v1 的组按原顺序拼成一条扁平序列，
 * 再用它给每个新组排序（组内各项的相对先后与用户在 v1 里的排列一致），
 * v1 里没有的项按默认序补在末尾。
 */
function migrateLegacyOrder(): MenuOrder | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_ORDER_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const flat: string[] = []
    for (const key of LEGACY_GROUP_ORDER) {
      const list = parsed[key]
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'string' && !flat.includes(item)) flat.push(item)
        }
      }
    }
    if (flat.length === 0) return null
    const migrated: MenuOrder = {}
    for (const group of MENU_GROUPS) {
      const inGroup = new Set(group.items)
      const fromLegacy = flat.filter((k) => inGroup.has(k))
      migrated[group.key] = reconcile(fromLegacy, group.items)
    }
    return migrated
  } catch {
    return null
  }
}

function getMenuOrder(): MenuOrder {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(ORDER_KEY)
  } catch {
    // 隐私模式或无 localStorage：回退默认
  }
  if (!raw) {
    const migrated = migrateLegacyOrder()
    if (migrated) return migrated
    return { ...DEFAULT_ORDER }
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const result: MenuOrder = {}
    for (const group of MENU_GROUPS) {
      const stored = parsed[group.key]
      result[group.key] = reconcile(Array.isArray(stored) ? (stored as string[]) : [], group.items)
    }
    return result
  } catch {
    return { ...DEFAULT_ORDER }
  }
}

/**
 * useSyncExternalStore 的 getSnapshot 必须返回稳定引用：连续调用若数据未变，
 * 必须返回同一个对象，否则 React 判定状态变更 → 重渲染 → 再次取快照 → 无限循环。
 * 这里缓存上一次的结果，仅当 JSON 快照变化时才重建对象。
 */
let cachedOrder: MenuOrder | null = null
let cachedKey = ''
function getOrderSnapshot(): MenuOrder {
  const order = getMenuOrder()
  const key = JSON.stringify(order)
  if (key !== cachedKey) {
    cachedKey = key
    cachedOrder = order
  }
  return cachedOrder!
}

function persistOrder(order: MenuOrder): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order))
  } catch {
    // 忽略隐私模式写入失败
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
}

/** 在指定组内把 fromKey 移到 toKey 的 before/after 位置 */
export function reorderInGroup(groupKey: string, fromKey: string, toKey: string, pos: 'before' | 'after'): void {
  const order = getMenuOrder()
  const list = [...(order[groupKey] ?? [])]
  const fromIdx = list.indexOf(fromKey)
  if (fromIdx === -1) return
  list.splice(fromIdx, 1)
  let toIdx = list.indexOf(toKey)
  if (toIdx === -1) {
    // 目标不在组里（理论上不会发生），放回原位
    list.splice(fromIdx, 0, fromKey)
  } else {
    if (pos === 'after') toIdx += 1
    list.splice(toIdx, 0, fromKey)
  }
  persistOrder({ ...order, [groupKey]: list })
}

/**
 * 组内把某项上移/下移一格（键盘排序按钮的入口，§6.2）。
 * 返回新的组内顺序；已在端点（无处可动）时返回 null，调用方据此禁用按钮/不发提示。
 */
export function moveInGroup(groupKey: string, key: string, delta: -1 | 1): string[] | null {
  const order = getMenuOrder()
  const list = [...(order[groupKey] ?? [])]
  const from = list.indexOf(key)
  if (from === -1) return null
  const to = from + delta
  if (to < 0 || to >= list.length) return null
  list.splice(from, 1)
  list.splice(to, 0, key)
  persistOrder({ ...order, [groupKey]: list })
  return list
}

/** 恢复默认排序（同时清掉 v1 的旧键，避免下次读取又把旧顺序迁移回来） */
export function resetMenuOrder(): void {
  try {
    localStorage.removeItem(LEGACY_ORDER_KEY)
  } catch {
    // 隐私模式忽略
  }
  persistOrder(Object.fromEntries(MENU_GROUPS.map((g) => [g.key, [...g.items]])))
}

/**
 * 整份写回顺序（「撤销重排」用）。
 * 只保留已知分组与已知菜单项，防止外部传入的脏数据把顺序表写坏。
 */
export function setMenuOrder(order: MenuOrder): void {
  const clean: MenuOrder = {}
  for (const group of MENU_GROUPS) {
    clean[group.key] = reconcile(order[group.key] ?? [], group.items)
  }
  persistOrder(clean)
}

// ---------- 订阅 hook ----------

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onChange = () => cb()
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** React hook：订阅菜单顺序变更，返回当前各组顺序 */
export function useMenuOrder(): MenuOrder {
  return useSyncExternalStore(subscribe, getOrderSnapshot, () => DEFAULT_ORDER)
}
