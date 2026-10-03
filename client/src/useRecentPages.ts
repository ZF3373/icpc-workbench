import { useSyncExternalStore } from 'react'
import { getRecentPagesSnapshot, subscribeRecentPages } from './recentPages'

/** 服务端/测试环境快照：必须是稳定引用，否则 useSyncExternalStore 会反复重渲染 */
const EMPTY: string[] = []

/**
 * 订阅「最近访问」路由列表（全局命令面板用）。
 * 与 menuConfig 的 useMenuOrder 同款模式：变更经自定义事件 + storage 事件广播，
 * 同标签页即时生效、跨标签页同步。
 */
export function useRecentPages(): string[] {
  return useSyncExternalStore(subscribeRecentPages, getRecentPagesSnapshot, () => EMPTY)
}
