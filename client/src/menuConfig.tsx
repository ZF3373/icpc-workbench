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

/** 分组定义：训练 / 题库与记录。首尾固定项（数据概览、设置）不在分组内。 */
export interface MenuGroup {
  key: string
  label: string
  /** 组内默认顺序 */
  items: string[]
}

export const MENU_GROUPS: MenuGroup[] = [
  { key: 'training', label: '训练', items: ['/today', '/ai', '/templates', '/lists', '/plans', '/reviews'] },
  { key: 'records', label: '题库与记录', items: ['/problems', '/mastery', '/calendar', '/contests'] },
]

/** 固定项（不在分组内、不可拖拽） */
export const MENU_FIXED_TOP = '/'
export const MENU_FIXED_BOTTOM: string[] = ['/settings', '/about']

// ---------- 顺序持久化 ----------

const ORDER_KEY = 'icpc-menu-order-v1'
const CHANGE_EVENT = 'icpc-menu-order-change'

export interface MenuOrder {
  training: string[]
  records: string[]
}

const DEFAULT_ORDER: MenuOrder = Object.fromEntries(
  MENU_GROUPS.map((g) => [g.key, [...g.items]]),
) as unknown as MenuOrder

/** 把 localStorage 里读到的顺序与默认顺序对齐：过滤已删除的 key、追加新增的 key */
function reconcile(stored: string[], defaults: string[]): string[] {
  const known = new Set(defaults)
  const result = stored.filter((k) => known.has(k))
  for (const k of defaults) {
    if (!result.includes(k)) result.push(k)
  }
  return result
}

function getMenuOrder(): MenuOrder {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(ORDER_KEY)
  } catch {
    // 隐私模式或无 localStorage：回退默认
  }
  if (!raw) return { ...DEFAULT_ORDER }
  try {
    const parsed = JSON.parse(raw) as Partial<MenuOrder>
    return {
      training: reconcile(parsed.training ?? [], DEFAULT_ORDER.training),
      records: reconcile(parsed.records ?? [], DEFAULT_ORDER.records),
    }
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
export function reorderInGroup(groupKey: keyof MenuOrder, fromKey: string, toKey: string, pos: 'before' | 'after'): void {
  const order = getMenuOrder()
  const list = [...order[groupKey]]
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

/** 恢复默认排序 */
export function resetMenuOrder(): void {
  persistOrder({ ...DEFAULT_ORDER })
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
