import { useCallback, useEffect, useState } from 'react'
import { Alert, App as AntdApp, Button, Input, Select, Space } from 'antd'
import { HistoryOutlined } from '@ant-design/icons'
import type { PlatformId } from '../../../../shared/src/index.ts'
import { PLATFORMS } from '../../../../shared/src/index.ts'
import SyncProgressHint from '../../components/SyncProgressHint'
import SyncHistoryDrawer from '../../components/SyncHistoryDrawer'
import { get, post } from '../../api'
import { platformName } from '../../ui'
import { useSyncProgress } from '../../syncProgressContext'
import { fmtClock } from '../../formatTime.ts'

interface SyncPlatformStatus {
  platform: PlatformId
  platformName: string
  handle: string
  enabled: boolean
  lastSyncAt: string | null
  status: string
  latestRun: unknown
  /** 后台续拉排期；无排期（未截断 / 已跑完 / 已取消 / 轮数设为 0）时为 null */
  autoContinue: {
    platform: PlatformId
    handle: string
    round: number
    maxRounds: number
    /** 下一轮预计开始时间（ISO 字符串） */
    nextAt: string
    running: boolean
  } | null
}

/** 续拉状态轮询间隔：续拉按平台节奏排期（秒级到分钟级），10 秒粒度足以看到轮次推进，请求极轻 */
const AUTO_CONTINUE_POLL_MS = 10_000

export function SyncTab({ onDone, active = true }: { onDone: () => void; active?: boolean }) {
  const { message } = AntdApp.useApp()
  const [platform, setPlatform] = useState<PlatformId>('codeforces')
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()
  // 同步进度（全局共享的 /api/sync/progress 轮询）：本页只看当前所选平台那一行
  const { refresh: refreshProgress } = useSyncProgress()
  // 「上次同步结果」抽屉（最近 50 次同步明细，平台/模式/耗时/错误原因）
  const [historyOpen, setHistoryOpen] = useState(false)
  // 各平台后台续拉状态（GET /api/sync/status）：截断后服务端会自行分批续拉，这里给出进度与手动停止
  const [statuses, setStatuses] = useState<SyncPlatformStatus[]>([])
  const [cancelling, setCancelling] = useState<string>()

  const loadStatus = useCallback(() => {
    get<{ statuses: SyncPlatformStatus[] }>('/api/sync/status')
      .then((r) => setStatuses(r.statuses ?? []))
      .catch(() => { /* 服务端未升级时静默：仅影响续拉提示 */ })
  }, [])

  // 弹窗打开 / 切回本页签时重新拉取：本组件一旦挂载就不会随弹窗关闭而卸载
  // （Modal 无 destroyOnClose、Tabs 不销毁非活动面板），只在挂载时拉一次会让横幅
  // 永远停在旧轮次——续拉跑完/被取消后仍显示「后台续拉中，预计 HH:MM 继续」。
  useEffect(() => {
    if (active) loadStatus()
  }, [active, loadStatus])

  // Boolean(...)：旧版服务端整段没有 autoContinue 字段（undefined），不能被当成「有待续拉」而空转轮询
  const hasPending = statuses.some((s) => Boolean(s.autoContinue))

  // 有待续拉时轻量轮询，让轮次与预计时间自行推进（无需用户操作）；
  // 没有待续拉或页签不活跃时不保留任何定时器（自停轮询）。
  useEffect(() => {
    if (!active || !hasPending) return
    const timer = setInterval(loadStatus, AUTO_CONTINUE_POLL_MS)
    return () => clearInterval(timer)
  }, [active, hasPending, loadStatus])

  const run = async () => {
    if (!handle.trim()) return
    setBusy(true)
    setResult(undefined)
    // 立刻拉一次进度：点下去就看到「已用时 0 秒 · 正在建立连接」，而不是空白等待
    refreshProgress()
    try {
      const r = await post<{ imported: number; skipped: number; errors: string[]; truncated?: boolean; note?: string }>(`/api/sync/${platform}`, { handle: handle.trim() })
      const parts = [`导入 ${r.imported} 条`, `去重 ${r.skipped} 条`]
      if (r.errors.length) parts.push(`提示：${r.errors.join('；')}`)
      if (r.truncated && r.note) parts.push(r.note)
      setResult(parts.join('，'))
      if (r.imported > 0) onDone()
      // 本次若被分批上限截断，服务端已排下一次续拉：立刻刷新续拉提示
      loadStatus()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
      refreshProgress()
    }
  }

  const cancelAutoContinue = async (p: PlatformId) => {
    setCancelling(p)
    try {
      const r = await post<{ ok: boolean; cancelled: boolean }>('/api/sync/auto-continue/cancel', { platform: p })
      message.success(r.cancelled ? `${platformName(p)}后台续拉已停止` : `${platformName(p)}当前没有待执行的续拉`)
      loadStatus()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCancelling(undefined)
    }
  }

  const pending = statuses.filter((s) => s.autoContinue)

  return (
    <div>
      <Space>
        <Select style={{ width: 140 }} value={platform} onChange={setPlatform} options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))} />
        <Input placeholder={platform === 'codeforces' ? 'CF handle' : '用户名 / uid'} value={handle} onChange={(e) => setHandle(e.target.value)} style={{ width: 200 }} />
        <Button type="primary" loading={busy} onClick={run}>同步</Button>
      </Space>
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
      {/* 同步进行中：显示真实请求进度（已用时 / 已请求次数 / 最后一次请求距今），
          避免用户以为卡住而直接关掉应用 */}
      {busy && (
        <p style={{ marginTop: 12, marginBottom: 0 }}>
          <SyncProgressHint platform={platform} />
        </p>
      )}
      {pending.length > 0 && (        <div style={{ marginTop: 12 }}>
          {pending.map((s) => {
            const ac = s.autoContinue!
            return (
              <Alert
                key={s.platform}
                type="info"
                showIcon
                style={{ marginBottom: 8 }}
                // running 时服务端正在拉本轮，nextAt 尚未落到下一轮：此时不报「预计 HH:MM」（会显示成过去时间）
                message={
                  ac.running
                    ? `后台续拉中：第 ${ac.round}/${ac.maxRounds} 轮（正在拉取）`
                    : `后台续拉中：第 ${ac.round}/${ac.maxRounds} 轮，预计 ${fmtClock(ac.nextAt)} 继续`
                }
                description={`${s.platformName}（${ac.handle}）：单次同步受分批上限截断后由后台自动续拉，可随时停止；停止不影响已导入的数据。`}
                action={
                  <Button size="small" loading={cancelling === s.platform} onClick={() => void cancelAutoContinue(s.platform)}>
                    停止续拉
                  </Button>
                }
              />
            )
          })}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <a onClick={() => setHistoryOpen(true)} style={{ fontSize: 13 }}>
          <HistoryOutlined /> 上次同步结果（各平台最近 50 次）
        </a>
      </div>
      <SyncHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  )
}
