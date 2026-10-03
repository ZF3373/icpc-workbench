/**
 * 同步进度的紧凑一行（同步按钮旁 / 同步页签内）：
 * 让用户不用去找悬浮卡也能看到「已用时 + 已请求次数 + 最后一次请求距今」。
 *
 * - 传 `platform`：只显示该平台的进度（题目页同步页签）。
 * - 不传：显示整体摘要（数据概览的一键同步「第 N/M 个平台」）。
 * 只在真的有同步进行中时渲染（收尾状态由数据概览面板展示）。
 */
import type { PlatformId } from '../../../shared/src/index.ts'
import { useSyncProgress } from '../syncProgressContext'
import { jobLineText, summaryText } from '../syncProgress'

export default function SyncProgressHint({ platform }: { platform?: PlatformId }) {
  const { snapshot, running } = useSyncProgress()
  if (!running) return null

  const job = platform
    ? snapshot.jobs.find((j) => j.platform === platform)
    : (snapshot.jobs[0] ?? undefined)
  const text = platform && !job ? '' : job ? jobLineText(job) : summaryText(snapshot)
  if (!text) return null

  return (
    <span style={{ color: 'var(--text-3)', fontSize: 12 }} title="切换页面不会中断同步；请勿关闭应用">
      {text}
    </span>
  )
}
