import { useEffect } from 'react'
import { notification } from 'antd'
import { useNavigate } from 'react-router-dom'
import { get } from './api'
import type { ContestInfo, ContestReminderConfig } from './types'

/** 已提醒的赛事记录 { 赛事 id: 开始时间 ISO }，开始 24h 后清理 */
const FIRED_KEY = 'contest-reminder.fired'
const TICK_MS = 60_000

type FiredMap = Record<string, string>

function loadFired(): FiredMap {
  try {
    const raw = localStorage.getItem(FIRED_KEY)
    return raw ? (JSON.parse(raw) as FiredMap) : {}
  } catch {
    return {}
  }
}

function saveFired(map: FiredMap): void {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(map))
  } catch {
    /* 存储不可用时仍可提醒，只是会重复弹 */
  }
}

/**
 * 赛前提醒器：开启后每分钟拉一次即将开始的赛事，
 * 开赛时间进入提醒窗口（默认开赛前 30 分钟）且未提醒过时，
 * 发浏览器系统通知 + 应用内通知，点击跳转赛事中心。
 * 赛事接口失败静默跳过（下一轮重试）。
 */
export default function ContestReminder() {
  const nav = useNavigate()

  useEffect(() => {
    let stopped = false

    const fire = (contest: ContestInfo, minutes: number) => {
      const description = `${contest.name} 将在 ${minutes} 分钟后开始，准备好模板和 IDE 了嘛？`
      const goto = () => {
        window.focus()
        nav('/contests')
      }
      notification.open({
        message: '比赛即将开始',
        description,
        duration: 0,
        onClick: goto,
      })
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const n = new Notification('ICPC Workbench 赛前提醒', {
          body: description,
          tag: `contest-reminder-${contest.id}`,
        })
        n.onclick = () => {
          window.focus()
          nav('/contests')
          n.close()
        }
      }
    }

    const tick = async () => {
      if (stopped) return
      try {
        const { contestReminder } = await get<{ contestReminder: ContestReminderConfig }>('/api/settings')
        if (!contestReminder?.enabled) return
        const contests = await get<{ contests: ContestInfo[] }>('/api/contests?type=upcoming&limit=40')
        if (stopped || contests.contests.length === 0) return

        const now = Date.now()
        const fired = loadFired()
        const sizeBefore = Object.keys(fired).length
        // 清理已开始超过 24h 的记录，防止无限增长
        for (const [id, startIso] of Object.entries(fired)) {
          if (Date.parse(startIso) < now - 86_400_000) delete fired[id]
        }
        const windowMs = contestReminder.minutesBefore * 60_000
        let changed = false
        for (const c of contests.contests) {
          if (!c.startTimeIso || fired[c.id]) continue
          const diff = Date.parse(c.startTimeIso) - now
          if (diff <= 0 || diff > windowMs) continue
          fire(c, Math.max(1, Math.round(diff / 60_000)))
          fired[c.id] = c.startTimeIso
          changed = true
        }
        // 新提醒与过期清理都要落盘，否则清理结果不持久、每次 tick 重复做
        if (changed || Object.keys(fired).length !== sizeBefore) saveFired(fired)
      } catch {
        // 后端未启动 / 赛事源抖动：静默跳过，下一轮重试
      }
    }

    void tick()
    const timer = setInterval(tick, TICK_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [nav])

  return null
}
