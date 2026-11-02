/**
 * 右下角进度卡的行模型：合并前端任务（backgroundTasks.ts）与服务端正在跑的任务。
 *
 * 题库拉取、难度回填由服务端执行，进度也只有服务端知道；且刷新页面后它们仍在跑，
 * 而前端 store 已清空。因此以服务端状态为准补充进度文案，没有对应前端任务时单独成行。
 */
import type { BackgroundTask, BackgroundTaskStatus } from './backgroundTasks'
import { progressText, type BackfillRunStatus } from './backfillProgress'

export const BACKFILL_TASK_KEY = 'difficulty-backfill'
export const BACKFILL_STOP_PATH = '/api/problems/backfill-difficulty/stop'
export const bankTaskKey = (platform: string): string => `bank:${platform}`

export interface BankRun {
  platform: string
  fetched: number
  total: number | null
  startedAt: string
}

export interface ServerRun {
  key: string
  title: string
  detail: string
  href: string
  startedAt: number
  stopPath?: string
}

export interface ActivityRow {
  key: string
  title: string
  href?: string
  status: BackgroundTaskStatus
  /** 运行中的进度文案（来自服务端；AI 类任务没有可报的进度，只显示已用时） */
  detail: string | null
  resultText: string | null
  error: string | null
  startedAt: number
  abortable: boolean
  stopPath?: string
}

export function bankRunDetail(run: BankRun): string {
  if (run.fetched === 0) return '正在请求题库…'
  return run.total ? `已拉取 ${run.fetched}/${run.total} 题` : `已拉取 ${run.fetched} 题`
}

export function toServerRuns(
  bank: readonly BankRun[],
  backfill: BackfillRunStatus | null,
  nameOf: (platform: string) => string,
): ServerRun[] {
  const runs: ServerRun[] = bank.map((b) => ({
    key: bankTaskKey(b.platform),
    title: `拉取题库 · ${nameOf(b.platform)}`,
    detail: bankRunDetail(b),
    href: '/problems',
    startedAt: Date.parse(b.startedAt),
  }))
  if (backfill?.running) {
    runs.push({
      key: BACKFILL_TASK_KEY,
      title: '回填题目难度',
      detail: progressText(backfill, nameOf),
      href: '/problems',
      startedAt: backfill.startedAt ? Date.parse(backfill.startedAt) : Date.now(),
      stopPath: backfill.stopping ? undefined : BACKFILL_STOP_PATH,
    })
  }
  return runs
}

export function mergeActivityRows(tasks: readonly BackgroundTask[], runs: readonly ServerRun[]): ActivityRow[] {
  const running = new Set(tasks.filter((t) => t.status === 'running').map((t) => t.key))
  const rows: ActivityRow[] = tasks
    .filter((t) => !t.hidden)
    .map((t) => {
      const run = t.status === 'running' ? runs.find((r) => r.key === t.key) : undefined
      return {
        key: t.key,
        title: t.title,
        href: t.href,
        status: t.status,
        detail: run?.detail ?? null,
        resultText: t.resultText,
        error: t.error,
        startedAt: t.startedAt,
        abortable: t.abortable,
        stopPath: run?.stopPath,
      }
    })
  for (const run of runs) {
    if (running.has(run.key)) continue
    // 前端任务刚结束、下一轮轮询还没到时，服务端快照里这一项已经过期：不再重复成行
    if (rows.some((r) => r.key === run.key)) continue
    rows.push({
      key: run.key,
      title: run.title,
      href: run.href,
      status: 'running',
      detail: run.detail,
      resultText: null,
      error: null,
      startedAt: run.startedAt,
      abortable: false,
      stopPath: run.stopPath,
    })
  }
  return rows
}
