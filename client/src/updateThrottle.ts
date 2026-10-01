/**
 * 更新检查的本地节流：用一个 localStorage 时间戳表达两种间隔。
 *
 * 存的是「**下次允许检查的时刻**」（epoch ms），而不是「上次检查时刻」——
 * 单时间戳配两种间隔是判不出来的，历史实现就栽在这里：判定恒用 30 分钟的重试间隔
 * （`Date.now() - last < RETRY_INTERVAL`），而 24 小时的 CHECK_INTERVAL 只在写失败戳时
 * 被减掉、从未参与比较。于是「应用打开时 24 小时检查一次」实际变成「距上次成功 ≥30 分钟
 * 就再打一次上游」，长期使用的用户会持续多打更新接口（有被上游限流的风险）。
 */

/** 检查成功后的节流间隔：24 小时 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 检查失败后的重试间隔：网络抖动/限流不该把下次静默检查推迟整整一天 */
export const UPDATE_RETRY_INTERVAL_MS = 30 * 60 * 1000

/** 按「本次检查是否成功」算出下次允许检查的时刻 */
export function nextUpdateCheckAt(now: number, ok: boolean): number {
  return now + (ok ? UPDATE_CHECK_INTERVAL_MS : UPDATE_RETRY_INTERVAL_MS)
}

/**
 * 现在是否允许检查。
 * - 未到点（存的是未来时刻）→ 不再检查；
 * - 读不出 / 非法值 → 允许检查（宁可多查一次，也不要因为坏数据永远不查）；
 * - 旧版本存的是「上次检查时刻」（过去时刻）→ 允许检查一次，随后写入新格式即自愈。
 */
export function shouldCheckUpdate(now: number, stored: string | null): boolean {
  const next = Number(stored ?? 0)
  if (!Number.isFinite(next)) return true
  return now >= next
}
