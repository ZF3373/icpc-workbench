/**
 * 赛事中心「日历页签」（即将开始 / 进行中 / 最近结束）的展示层纯函数。
 *
 * 为什么单独抽出来：按天分组、时:分缩写、结束多久都是纯计算，放进组件里测不了
 * （仓库没有组件测试设施，见 assistantSessionOrder.ts 的说明）。这里只算展示数据，
 * 不碰请求、不碰 React 状态。
 */

/** 参与按天分组的最小结构 */
export interface ContestLike {
  startTimeIso: string | null
}

export interface ContestDayGroup<T extends ContestLike> {
  /** 稳定 key：本地日期 yyyy-MM-dd；「时间待定」组为 none */
  key: string
  /** 展示标签：今天 · 10月3日 周五 / 明天 … / 昨天 … / 10月5日 周日 / 时间待定 */
  label: string
  items: T[]
}

/**
 * 按比赛开始时刻的**本地日历日**分组；组内保持传入顺序（API 已按时间排序），
 * 组按首次出现顺序排列。无开始时间 / 非法时间的场次归入末尾「时间待定」组。
 * 相对日仅区分 昨天/今天/明天 —— 更远的日期写星期几比「3 天后」直观，倒计时由卡片自己承担。
 */
export function groupContestsByDay<T extends ContestLike>(
  contests: readonly T[],
  now: Date = new Date(),
): ContestDayGroup<T>[] {
  const fmtDay = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
  const fmtWeek = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' })
  const dayKey = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const startOfLocalDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = startOfLocalDay(now)

  const groups = new Map<string, ContestDayGroup<T>>()
  const pending: T[] = []
  for (const c of contests) {
    const d = c.startTimeIso ? new Date(c.startTimeIso) : null
    if (!d || !Number.isFinite(d.getTime())) {
      pending.push(c)
      continue
    }
    const key = dayKey(d)
    let g = groups.get(key)
    if (!g) {
      const diffDays = Math.round((startOfLocalDay(d) - today) / 86_400_000)
      const rel = diffDays === 0 ? '今天' : diffDays === 1 ? '明天' : diffDays === -1 ? '昨天' : null
      const base = `${fmtDay.format(d)} ${fmtWeek.format(d)}`
      g = { key, label: rel ? `${rel} · ${base}` : base, items: [] }
      groups.set(key, g)
    }
    g.items.push(c)
  }
  const out = [...groups.values()]
  if (pending.length > 0) out.push({ key: 'none', label: '时间待定', items: pending })
  return out
}

/** 分组卡内的开始时刻只显示时:分（日期由组头承担） */
export function fmtTimeHm(iso: string | null): string {
  if (!iso) return '时间待定'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '时间待定'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 最近结束页签：距结束多久（结束瞬间显示「刚刚结束」） */
export function endedAgo(iso: string, durationMinutes: number, now: number = Date.now()): string {
  const end = new Date(iso).getTime() + durationMinutes * 60_000
  const diff = now - end
  if (diff <= 60_000) return '刚刚结束'
  const d = Math.floor(diff / 86_400_000)
  const h = Math.floor((diff % 86_400_000) / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (d > 0) return `${d} 天 ${h} 小时前结束`
  if (h > 0) return `${h} 小时 ${m} 分前结束`
  return `${m} 分钟前结束`
}
