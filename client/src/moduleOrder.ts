/**
 * 数据概览模块卡片的拖拽排序：顺序的持久化（localStorage）与恢复纯逻辑。
 * 拖拽交互本身在 Dashboard.tsx（沿用平台小卡片的 mouse 事件方案，兼容 WebView2）。
 */
import { readJson, writeJson } from './persistence.ts'

export const DEFAULT_MODULE_IDS = [
  'heatmap',
  'platforms',
  'difficulty',
  'weakness',
  'trend',
  'history',
] as const

export type ModuleId = (typeof DEFAULT_MODULE_IDS)[number]

const STORAGE_KEY = 'icpc-dashboard-module-order-v1'

export function loadModuleOrder(): string[] | null {
  return readJson<string[]>(STORAGE_KEY)
}

export function saveModuleOrder(ids: string[]): void {
  writeJson(STORAGE_KEY, ids)
}

/** 把持久化顺序应用到默认列表：未知/重复 id 丢弃，缺失的按默认序补在末尾；saved 为空返回默认 */
export function applyModuleOrder(
  saved: string[] | null,
  defaults: readonly ModuleId[] = DEFAULT_MODULE_IDS,
): ModuleId[] {
  if (!saved || saved.length === 0) return [...defaults]
  const known = new Set<ModuleId>(defaults)
  const ordered: ModuleId[] = []
  for (const id of saved) {
    if (known.has(id as ModuleId) && !ordered.includes(id as ModuleId)) {
      ordered.push(id as ModuleId)
    }
  }
  for (const id of defaults) {
    if (!ordered.includes(id)) ordered.push(id)
  }
  return ordered
}
