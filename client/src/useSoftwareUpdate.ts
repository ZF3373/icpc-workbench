import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from 'antd'
import { get, post } from './api'
import type { UpdateInfo, UpdateProgress } from './types'

/**
 * 软件更新流程（设置页与顶部更新横幅共用）：
 * 检查 →（有更新且支持自更新）下载并轮询进度 → 校验通过后原地替换 → 提示重启。
 */
export function useSoftwareUpdate() {
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

  useEffect(() => stopPolling, [stopPolling])

  const check = useCallback(async () => {
    setChecking(true)
    try {
      setInfo(await get<UpdateInfo>('/api/update/check'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setChecking(false)
    }
  }, [])

  const pollUntilStaged = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        stopPolling()
        timer.current = setInterval(async () => {
          try {
            const p = await get<UpdateProgress>('/api/update/progress')
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
            /* 单次轮询失败忽略，等下一拍 */
          }
        }, 800)
      }),
    [stopPolling],
  )

  const runUpdate = useCallback(async () => {
    if (phase === 'downloading' || phase === 'verifying') return
    setResult(null)
    setPercent(0)
    setPhase('downloading')
    try {
      const started = await post<{ ok: boolean; message?: string }>('/api/update/download')
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
      setPercent(100)
      const applied = await post<{ ok: boolean; message?: string }>('/api/update/apply')
      setPhase('idle')
      setResult({ ok: applied.ok, text: applied.message ?? (applied.ok ? '更新完成' : '应用更新失败') })
      if (applied.ok) message.success(applied.message ?? '更新完成')
      else message.error(applied.message ?? '应用更新失败')
    } catch (e) {
      setPhase('idle')
      setResult({ ok: false, text: (e as Error).message })
      message.error((e as Error).message)
    }
  }, [phase, pollUntilStaged])

  const busy = phase === 'downloading' || phase === 'verifying'
  const hasUpdate = !!(info?.ok && (info.hasUpdate || info.hasCommitUpdate))

  return { info, checking, check, phase, percent, busy, result, runUpdate, hasUpdate }
}
