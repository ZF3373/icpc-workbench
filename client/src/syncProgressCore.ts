/**
 * 同步进度的 Context 对象与消费 hook（Provider 组件见 syncProgressContext.tsx）。
 *
 * 拆成独立文件的原因：react-refresh 要求组件文件只导出组件——Provider 与 hook
 * 同文件时开发态热更新会把整棵子树打回重挂载。纯 Context/hook 放这里，组件放那边。
 */
import { createContext, useContext } from 'react'
import type { SyncProgressSnapshot } from '../../shared/src/index.ts'
import type { SyncPlatformStatusView } from './syncStatus'

const EMPTY: SyncProgressSnapshot = { jobs: [], batch: null }

/** 进行中的轮询间隔（心跳粒度） */
export const PROGRESS_POLL_RUNNING_MS = 1_000
/** 空闲哨兵轮询间隔（发现「别处发起的同步 / 后台续拉」的最大延迟） */
export const PROGRESS_POLL_IDLE_MS = 10_000

export interface SyncProgressApi {
  snapshot: SyncProgressSnapshot
  /** 各平台最近一次同步（空闲时供「同步状态」卡与「上次同步结果」抽屉使用） */
  statuses: SyncPlatformStatusView[]
  /** 是否仍有同步在进行（面板/悬浮卡据此渲染，轮询据此加速） */
  running: boolean
  /** 立即拉一次（刚点下同步时调用，避免等一个轮询周期才出现进度） */
  refresh: () => void
}

export const SyncProgressCtx = createContext<SyncProgressApi>({
  snapshot: EMPTY,
  statuses: [],
  running: false,
  refresh: () => {},
})

export function useSyncProgress(): SyncProgressApi {
  return useContext(SyncProgressCtx)
}
