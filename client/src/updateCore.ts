/**
 * 软件更新的 Context 对象、类型与消费 hook（Provider 组件见 updateContext.tsx）。
 * 拆成独立文件的原因：react-refresh 要求组件文件只导出组件（热更新不打回子树重挂载）。
 */
import { createContext, useContext } from 'react'
import type { UpdateInfo, UpdateProgress } from './types'

export interface UpdateContextValue {
  info: UpdateInfo | null
  checking: boolean
  check: () => Promise<UpdateInfo | null>
  phase: UpdateProgress['phase']
  percent: number
  busy: boolean
  result: { ok: boolean; text: string } | null
  /** channel 缺省时使用检查结果的推荐通道（顶部横幅的一键更新走推荐通道） */
  runUpdate: (channel?: 'stable' | 'commit') => Promise<void>
  hasUpdate: boolean
}

export const UpdateContext = createContext<UpdateContextValue | null>(null)

export function useSoftwareUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext)
  if (!ctx) throw new Error('useSoftwareUpdate 必须在 <UpdateProvider> 内使用')
  return ctx
}
