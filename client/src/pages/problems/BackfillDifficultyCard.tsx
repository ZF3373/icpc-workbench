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

  const nameOf = (p: string): string => platformName(p as PlatformId)

  const refreshRun = useCallback(async () => {
    try {
      const r = await get<{ ok: boolean; run: BackfillRunStatus }>('/api/problems/backfill-difficulty/run')
      setRun(r.run)
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
        补全库内「未知难度 / 未知原生难度 / 缺标签」的题，覆盖所有平台：整表型平台
        （Codeforces / AtCoder / 力扣 / 计蒜客 / 代码源）先拉一次题库表再在本地比对；
        洛谷与牛客按题查题目页（牛客只在待补题上千时才改拉整表）。所有请求都走<b>全局按域名限速</b>：洛谷 ≥4 秒/题、
        牛客 ≥2 秒/题、AtCoder ≥2.5 秒、Codeforces ≥2 秒、力扣 / 计蒜客 / 代码源 ≥1.5 秒
        —— 这是<b>最快端</b>（洛谷逐题上限 400 题 ≈30 分钟、牛客每道题 ≈2 秒，
        两者排在最后，整轮通常几分钟到三十分钟，取决于还剩多少真缺口）；想更稳可到「设置 → 拉取速度」把倍率调到 2×–5×。
        连续失败会判定为风控并中止该平台。
        <b>随时可以点「停止回填」</b>：在途请求立即中断，<b>已落库的题不受影响</b>，
        再点一次「一键回填」就从库里剩下的缺口继续（可反复分多次补完）；停止期间页面刷新也不会
        丢掉进度 —— 重新打开仍会显示「正在处理 平台 N/M」和停止按钮。
        <b>平台按实测成本升序处理</b>：QOJ（约 18 秒）、AtCoder、代码源、Codeforces 先完成，
        牛客垫底 —— 因此中途停止时，前面的成果已经落库。
        回填按缺口优先级执行：<b>真缺难度</b>最优先，其次缺标签，最后才是「难度已有、只缺原生原文」；
        后一类只在洛谷默认跳过（结果里显示「跳过 N 题」），因此一次点击就能把真缺口补完。
        牛客同时修复历史遗留的标题混入标签问题。QOJ 的难度由 ICPC/CCPC 公开榜单
        （RankLand + xcpcrating 题号映射）推导档位，不在审核目录内的题仍保持未知。
        Codeforces 的 gym 与官方未评级比赛、牛客站上难度格为空的题<b>确实没有公开难度</b>：
        回填问过上游后会记下这个结论（列表里显示「无官方难度」而不是横杠），
        <b>一个月内不再对这些题重复发请求</b>，到期再自动重查一次（平台后来给出评级就会被采纳）。
        已删除 / 私有的题（洛谷 T 号题那类）上游明确拒绝（401/403），同样记成「无公开来源」不再重打；
        这类题与 gym 一样，唯一的出路是在<b>难度格上点击手动填写</b>（手动值优先级最高，回填不会覆盖）。
        平台后来补了评级/标签而负缓存还没到期时，勾选下面的<b>强制重查</b>再点一次，
        本轮就会无视这些缓存、重新问上游。
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
          强制重查（无视「平台无公开难度」的结论，并补洛谷的「仅缺原生值」行 —— 这一轮会明显更慢）
        </Checkbox>
      </div>
      {progress && <p style={{ marginTop: 12, color: 'var(--text-3)' }}>{progress}</p>}
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
    </div>
  )
}
