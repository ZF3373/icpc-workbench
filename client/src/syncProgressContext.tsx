/**
 * 同步进度上下文：**全应用只轮询一份** `/api/sync/progress`。
 *
 * 为什么需要全局单例：数据概览面板、右下角悬浮卡、题目页同步页签都要看同一份进度，
 * 各自轮询会成倍放大请求；而且用户可能在题目页发起同步后切到别的页面——
 * 那时只有全局的这份数据还能证明「它还在跑」。
 *
 * 轮询策略（自停，不常驻空转）：
 * - 有同步进行中：1 秒一次（心跳要跟得上，用户盯着看）；
 * - 空闲：10 秒一次的哨兵轮询（覆盖服务端后台续拉、别的页面发起的同步）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SyncProgressSnapshot } from '../../shared/src/index.ts'
import { get } from './api'
import { hasRunningProgress } from './syncProgress'
import {
  PROGRESS_POLL_IDLE_MS,
  PROGRESS_POLL_RUNNING_MS,
  SyncProgressCtx as Ctx,
  type SyncProgressApi,
} from './syncProgressCore'
import type { SyncPlatformStatusView } from './syncStatus'

const EMPTY: SyncProgressSnapshot = { jobs: [], batch: null }

export function SyncProgressProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<SyncProgressSnapshot>(EMPTY)
  const [statuses, setStatuses] = useState<SyncPlatformStatusView[]>([])
  const [tick, setTick] = useState(0)
  const running = hasRunningProgress(snapshot)

  useEffect(() => {
    let stopped = false
    // 请求序号：轮询不等待上一次 load 完成，接口偶发 >1 个轮询周期时旧响应会晚到，
    // 无序号护栏会把快照回跳一拍（「已用时/已请求次数」短暂倒退）
    let seq = 0
    const load = async (): Promise<void> => {
      const my = ++seq
      try {
        const s = await get<SyncProgressSnapshot>('/api/sync/progress')
        if (!stopped && my === seq) setSnapshot(s ?? EMPTY)
      } catch {
        // 服务端未升级 / 暂时不可用：静默保持上一次快照，不影响同步本体
      }
      // 同步进行中不必拉历史状态（卡片展示的是进度）；空闲时才拉，让「上次同步结果」保持新鲜
      if (running) return
      try {
        const st = await get<{ statuses: SyncPlatformStatusView[] }>('/api/sync/status')
        if (!stopped && my === seq) setStatuses(st.statuses ?? [])
      } catch {
        /* 同上：静默 */
      }
    }
    void load()
    const timer = setInterval(() => void load(), running ? PROGRESS_POLL_RUNNING_MS : PROGRESS_POLL_IDLE_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [running, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const value = useMemo<SyncProgressApi>(
    () => ({ snapshot, statuses, running, refresh }),
    [snapshot, statuses, running, refresh],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
