import { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Checkbox, Space } from 'antd'
import type { PlatformId } from '../../../../shared/src/index.ts'
import { get, post } from '../../api'
import { platformName } from '../../ui'
import { progressText, resultText, type BackfillResponse, type BackfillRunStatus } from '../../backfillProgress'

export function BackfillDifficultyCard() {
  const { message } = AntdApp.useApp()
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [result, setResult] = useState<string>()
  /** 服务端运行状态：刷新 / 换个标签页回来时，据此继续显示「回填进行中 N/M」并给出停止入口 */
  const [run, setRun] = useState<BackfillRunStatus | null>(null)
  /**
   * 强制重查：无视「平台无公开难度」的负缓存，并把洛谷「仅缺原生值」的行也逐题重查一遍。
   * 真实用途：① 平台刚补了评级/标签而 TTL 未到，想立刻拿到；② 想把洛谷题的原生档位原文补齐。
   * （题号形态修复前被误锁的 AtCoder 旧定论已由启动迁移一次性作废，不需要用户点这个。）
   * 代价是这一轮耗时明显变长（洛谷 ≥4 秒/题），故默认关闭。
   */
  const [force, setForce] = useState(false)
  /**
   * 第三方备选（issue #57）：平台确实给不出难度时再去 clist.by 查一次 rating。
   * 默认开启——但要真正生效，设置页必须已配置 API Key（见 clistConfigured）。
   * 关掉它的理由：clist.by 免费额度 10 次/分钟，不想让回填占用这份额度，或不想把题目名发给第三方。
   */
  const [useClist, setUseClist] = useState(true)
  /** clist.by 是否已配置 Key（由 /run 下发；null = 还没问到） */
  const [clistConfigured, setClistConfigured] = useState<boolean | null>(null)

  const nameOf = (p: string): string => platformName(p as PlatformId)

  const refreshRun = useCallback(async () => {
    try {
      const r = await get<{
        ok: boolean
        run: BackfillRunStatus
        clist?: { configured: boolean }
      }>('/api/problems/backfill-difficulty/run')
      setRun(r.run)
      if (r.clist !== undefined) setClistConfigured(r.clist.configured)
    } catch {
      /* 状态接口失败不影响回填本身：保持上一次的按钮语义，不误报「没在跑」 */
    }
  }, [])

  // 挂载先问一次：回填由**服务端**跑（关页面/刷新都不会停），本页可能只是重新打开
  useEffect(() => {
    void refreshRun()
  }, [refreshRun])

  // 运行中每 2s 刷新进度；未运行时不挂定时器
  const active = busy || run?.running === true
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      void refreshRun()
    }, 2000)
    return () => clearInterval(timer)
  }, [active, refreshRun])

  // 「停止回填」要等**服务端**真正收尾后才复位 stopping：跨页面/跨标签页发起的回填没有
  // 本组件在途的 runBackfill 请求来复位（stop 接口返回 stopped:true 时也不复位），只能
  // 靠轮询到的运行状态收尾 —— 漏了它，重开页面后点「停止」会让两个按钮永久卡死，只能刷新恢复
  useEffect(() => {
    if (stopping && !busy && run !== null && !run.running) setStopping(false)
  }, [stopping, busy, run])

  const runBackfill = async () => {
    setBusy(true)
    setResult(undefined)
    setStopping(false)
    try {
      const r = await post<BackfillResponse>('/api/problems/backfill-difficulty', {
        ...(force ? { includeNativeOnly: true } : {}),
        // 服务端默认也是开启；这里显式传，用户取消勾选时才真的不会打第三方
        clistFallback: useClist,
      })
      setResult(resultText(r, nameOf))
      message.success(r.stopped ? '已停止回填（已落库的不受影响，再点一次继续）' : '难度回填完成')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
      setStopping(false)
      void refreshRun()
    }
  }

  /**
   * 停止 = 让**服务端**中止（在途上游请求被立即打断、已提交的批次留在库里）。
   * 只 abort 本页的 fetch 是做不到的：服务端的循环会照旧跑完并把结果写完。
   */
  const stopBackfill = async () => {
    setStopping(true)
    try {
      const r = await post<{ ok: boolean; stopped: boolean }>('/api/problems/backfill-difficulty/stop', {})
      if (!r.stopped) {
        message.info('当前没有正在运行的回填')
        setStopping(false)
      }
    } catch (e) {
      message.error((e as Error).message)
      setStopping(false)
    }
  }

  const running = busy || run?.running === true
  const progress = progressText(run, nameOf)

  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--line-soft)' }}>
      <p style={{ color: 'var(--text-3)' }}>
        补全库内<b>未知难度</b>、<b>缺标签</b>的题，覆盖所有平台；按缺口优先：
        真缺难度 → 缺标签 → 仅缺原生原文（后者仅洛谷默认跳过，结果里显示「跳过 N 题」）。
        整轮通常几分钟到半小时，取决于剩余缺口。
        <b>随时可点「停止回填」</b>：已落库的题不受影响，再点一次从剩余缺口继续，
        刷新页面也不会丢进度。各平台请求都走全局限速，想更稳可到「设置 → 拉取速度」调整倍率。
        <b>确实没有公开难度的题</b>（CF gym / 官方未评级、牛客难度格为空、已删除或私有的题）：
        回填后会显示「无官方难度」，一个月内不再重复请求，到期自动重查。
        这类题只有<b>在难度格上手动填写</b>一条出路（手动值不会被回填覆盖）。
        若平台后来补了评级，勾选下面的<b>强制重查</b>可立即无视缓存重新问上游。
      </p>
      <Space>
        <Button loading={busy} disabled={stopping || run?.running === true} onClick={runBackfill}>
          一键回填未知难度
        </Button>
        <Button danger loading={stopping} disabled={!running} onClick={stopBackfill}>
          停止回填
        </Button>
      </Space>
      <div style={{ marginTop: 8 }}>
        <Checkbox checked={force} onChange={(e) => setForce(e.target.checked)} disabled={running}>
          强制重查（无视「无官方难度」结论，并补洛谷的「仅缺原生原文」行；本轮会明显更慢）
        </Checkbox>
      </div>
      <div style={{ marginTop: 8 }}>
        <Checkbox
          checked={useClist}
          onChange={(e) => setUseClist(e.target.checked)}
          disabled={running || clistConfigured === false}
        >
          用 clist.by 第三方数据兜底「平台给不出难度」的题
          {clistConfigured === false
            ? '（未配置：先到「设置 → 第三方难度备选（clist.by）」填入 API Key）'
            : '（限额 10 次/分钟，每轮最多查几十道；只按题目链接匹配，补上的难度标注为第三方来源）'}
        </Checkbox>
      </div>
      {progress && <p style={{ marginTop: 12, color: 'var(--text-3)' }}>{progress}</p>}
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
    </div>
  )
}
