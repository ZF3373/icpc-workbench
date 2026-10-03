import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { App as AntdApp } from 'antd'
import { get, post } from './api'
import type { UpdateInfo, UpdateProgress } from './types'

/**
 * 软件更新全局驱动（设置页与顶部更新横幅共用同一份状态）：
 * 检查 →（有更新且支持自更新）下载并轮询进度 → 校验通过后原地替换 → 提示重启。
 *
 * 关键：状态与轮询定时器挂在常驻的 <UpdateProvider> 上，而非调用方组件。
 * 这样在「设置页发起更新后切到别的模块」时，设置页卸载只是取消订阅，
 * Provider 不会卸载，轮询继续推进、/apply 仍会被调用，更新不会被中断。
 * 同时应用启动时同步一次后端进度，让「更新中刷新页面」也能恢复驱动到完成。
 */
interface UpdateContextValue {
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

const UpdateContext = createContext<UpdateContextValue | null>(null)

export function UpdateProvider({ children }: { children: ReactNode }) {
  const { message } = AntdApp.useApp()
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [phase, setPhase] = useState<UpdateProgress['phase']>('idle')
  const [percent, setPercent] = useState(0)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
  }, [])

  // Provider 常驻整个 App 生命周期，仅在卸载时兜底清理（正常不会触发）
  useEffect(() => stopPolling, [stopPolling])

  const check = useCallback(async (): Promise<UpdateInfo | null> => {
    setChecking(true)
    try {
      const checked = await get<UpdateInfo>('/api/update/check')
      setInfo(checked)
      return checked
    } catch (e) {
      message.error((e as Error).message)
      return null
    } finally {
      setChecking(false)
    }
  }, [message])

  const pollUntilStaged = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        stopPolling()
        // 连续失败上限：后端进程被替换/崩溃后 /progress 会一直失败，无上限的「单次忽略」
        // 会让轮询永不 settle、busy 永真、按钮永久 loading（15 拍 ≈ 12s，短暂网络抖动仍能容忍）
        const MAX_CONSECUTIVE_FAILURES = 15
        let failures = 0
        timer.current = setInterval(async () => {
          try {
            const p = await get<UpdateProgress>('/api/update/progress')
            failures = 0
            setPhase(p.phase)
            setPercent(p.total > 0 ? Math.min(99, Math.round((p.received / p.total) * 100)) : 0)
            if (p.phase === 'staged') {
              stopPolling()
              resolve(true)
            } else if (p.phase === 'error') {
              stopPolling()
              resolve(false)
            }
          } catch {
            failures += 1
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
              stopPolling()
              resolve(false)
            }
            /* 其余单次轮询失败忽略，等下一拍 */
          }
        }, 800)
      }),
    [stopPolling],
  )

  // 下载完成（staged）→ 原地替换文件 → 提示重启。runUpdate 与启动恢复共用。
  const applyStaged = useCallback(async () => {
    setPercent(100)
    const applied = await post<{ ok: boolean; message?: string }>('/api/update/apply')
    setPhase('idle')
    setResult({ ok: applied.ok, text: applied.message ?? (applied.ok ? '更新完成' : '应用更新失败') })
    if (applied.ok) message.success(applied.message ?? '更新完成')
    else message.error(applied.message ?? '应用更新失败')
  }, [message])

  const runUpdate = useCallback(
    async (channel?: 'stable' | 'commit') => {
      if (phase === 'downloading' || phase === 'verifying') return
      setResult(null)
      setPercent(0)
      setPhase('downloading')
      try {
        const started = await post<{ ok: boolean; message?: string }>(
          '/api/update/download',
          channel ? { channel } : undefined,
        )
        if (!started.ok) {
          setPhase('idle')
          message.warning(started.message ?? '无法开始下载')
          return
        }
        const ok = await pollUntilStaged()
        if (!ok) {
          const p = await get<UpdateProgress>('/api/update/progress').catch(() => null)
          setPhase('error')
          setResult({ ok: false, text: p?.error ?? '下载失败，请稍后重试或前往下载页手动更新' })
          return
        }
        await applyStaged()
      } catch (e) {
        setPhase('idle')
        setResult({ ok: false, text: (e as Error).message })
        message.error((e as Error).message)
      }
    },
    [phase, pollUntilStaged, applyStaged, message],
  )

  // 应用启动时同步后端更新状态：刷新/重启后若仍有未完成的更新，
  // 恢复进度显示并继续驱动到完成（与不刷新时的行为一致）。
  useEffect(() => {
    let cancelled = false
    void get<UpdateProgress>('/api/update/progress')
      .then((p) => {
        if (cancelled) return
        if (p.phase !== 'downloading' && p.phase !== 'verifying' && p.phase !== 'staged') return
        setPhase(p.phase)
        setPercent(
          p.phase === 'staged' ? 100 : p.total > 0 ? Math.min(99, Math.round((p.received / p.total) * 100)) : 0,
        )
        void (async () => {
          if (p.phase === 'staged') {
            await applyStaged()
            return
          }
          const ok = await pollUntilStaged()
          if (!ok) {
            const ep = await get<UpdateProgress>('/api/update/progress').catch(() => null)
            setPhase('error')
            setResult({ ok: false, text: ep?.error ?? '下载失败，请稍后重试或前往下载页手动更新' })
            return
          }
          await applyStaged()
        })()
      })
      // 必须 catch：后端重启/不可达时本请求会失败，而这是一次**页面加载即触发**的探测。
      // 不接住就是一个未处理的 Promise rejection —— 实测会让每个页面的控制台都多出一条
      // 与本页无关的 uncaught TypeError，真出问题时反而更难定位（`void` 只压住 lint，不压住 rejection）。
      // 失败即「没有待恢复的更新」，保持 idle 是正确状态，无需打扰用户。
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [applyStaged, pollUntilStaged])

  const busy = phase === 'downloading' || phase === 'verifying'
  const hasUpdate = !!(info?.ok && (info.hasUpdate || info.hasCommitUpdate))

  const value: UpdateContextValue = { info, checking, check, phase, percent, busy, result, runUpdate, hasUpdate }

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
}

export function useSoftwareUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext)
  if (!ctx) throw new Error('useSoftwareUpdate 必须在 <UpdateProvider> 内使用')
  return ctx
}
