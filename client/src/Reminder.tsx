import { useEffect } from 'react'
import { notification } from 'antd'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { get } from './api'
import type { DayTask, ReminderConfig } from './types'

/** localStorage 记录当天已提醒过，避免到点后每 30 秒重复弹出（跨天自动重置）。 */
const LAST_FIRED_KEY = 'checkin-reminder.lastFiredDate'
const TICK_MS = 30_000

/**
 * 全局打卡提醒器：应用打开期间每 30 秒检查一次，
 * 到达设置时间且当天仍有未打卡任务时，发浏览器系统通知 + 应用内通知，点击跳转日历页。
 * 当天全部打卡完成或暂无任务时不打扰（无任务不落标记，稍后生成计划仍可提醒）。
 */
export default function Reminder() {
  const nav = useNavigate()

  useEffect(() => {
    let stopped = false

    const fire = (unchecked: number) => {
      const description = `今天还有 ${unchecked} 项训练任务未打卡，别断了连续记录 💪`
      const goto = () => {
        window.focus()
        nav('/calendar')
      }
      notification.info({
        message: '打卡提醒',
        description,
        duration: 0,
        onClick: goto,
      })
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const n = new Notification('ICPC Workbench 打卡提醒', {
          body: description,
          tag: 'checkin-reminder',
        })
        n.onclick = () => {
          window.focus()
          nav('/calendar')
          n.close()
        }
      }
    }

    const tick = async () => {
      if (stopped) return
      try {
        const { reminder } = await get<{ reminder: ReminderConfig }>('/api/settings')
        if (!reminder?.enabled) return
        const now = dayjs()
        const today = now.format('YYYY-MM-DD')
        if (localStorage.getItem(LAST_FIRED_KEY) === today) return
        if (now.format('HH:mm') < reminder.time) return // 未到提醒时间（零填充格式可直接字典序比较）
        const tasks = await get<DayTask[]>(`/api/checkins/date/${today}`)
        if (tasks.length === 0) return
        const unchecked = tasks.filter((t) => !t.checked).length
        localStorage.setItem(LAST_FIRED_KEY, today) // 有任务即标记当天已处理，含"全部已打卡"
        if (unchecked > 0) fire(unchecked)
      } catch {
        // 后端未启动等异常：静默跳过，下一轮重试
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
