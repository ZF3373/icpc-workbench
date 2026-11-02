/**
 * 前端后台任务：把耗时请求的状态放到**组件树之外**，切换页面不丢。
 *
 * 页面组件切路由就卸载（App.tsx 的 key={loc.pathname}），状态放组件里的话用户一走开，
 * 按钮的 loading、结果提示都没了，回来甚至能再发起一轮。这里的模块级 store 与路由无关：
 * 页面读 useBackgroundTask(key) 恢复状态，右下角进度卡读 useBackgroundTasks() 统一展示。
 *
 * 只覆盖当前页面生命周期：整页刷新后 store 清空。服务端自己跑的任务（题库拉取、难度回填）
 * 由 backgroundRuns.ts 按服务端状态接回，不受刷新影响。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

export type BackgroundTaskStatus = 'running' | 'done' | 'error'

export interface BackgroundTask<R = unknown> {
  key: string
  title: string
  /** 进度卡「查看」跳转的页面 */
  href?: string
  status: BackgroundTaskStatus
  startedAt: number
  finishedAt: number | null
  /** 完成后的一句话结果 */
  resultText: string | null
  error: string | null
  result: R | null
  /** 发起时的参数（如「按原参数重新生成」） */
  meta?: unknown
  /** 可从进度卡中止（请求被 abort，服务端随连接断开停止） */
  abortable: boolean
  /** 已从进度卡收起；结果仍保留给所属页面读取 */
  hidden: boolean
}

export interface StartTaskOptions<R> {
  key: string
  title: string
  href?: string
  meta?: unknown
  abortable?: boolean
  run: (ctx: { signal: AbortSignal }) => Promise<R>
  describe?: (result: R) => string
}

/** 成功的任务在进度卡停留多久后自动收起（失败的一直留着，等用户看到） */
export const DONE_AUTO_HIDE_MS = 10_000

let snapshot: readonly BackgroundTask[] = []
const listeners = new Set<() => void>()
const controllers = new Map<string, AbortController>()

function commit(next: readonly BackgroundTask[]): void {
  snapshot = next
  for (const l of listeners) l()
}

function patchTask(key: string, patch: Partial<BackgroundTask>): void {
  commit(snapshot.map((t) => (t.key === key ? { ...t, ...patch } : t)))
}

export function removeBackgroundTask(key: string): void {
  commit(snapshot.filter((t) => t.key !== key))
}

export function dismissBackgroundTask(key: string): void {
  patchTask(key, { hidden: true })
}

/** 中止可中止的任务；被中止的任务直接移除，不算失败 */
export function cancelBackgroundTask(key: string): void {
  controllers.get(key)?.abort()
}

/** 发起任务。同 key 已在运行时不重复发起，返回 false。 */
export function startBackgroundTask<R>(options: StartTaskOptions<R>): boolean {
  const { key, title, href, meta, abortable = false, run, describe } = options
  if (snapshot.some((t) => t.key === key && t.status === 'running')) return false
  const controller = new AbortController()
  controllers.set(key, controller)
  const task: BackgroundTask = {
    key,
    title,
    href,
    meta,
    abortable,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    resultText: null,
    error: null,
    result: null,
    hidden: false,
  }
  commit([...snapshot.filter((t) => t.key !== key), task])

  // 重发同 key 后，旧任务的自动收起定时器不能影响新任务：按 startedAt 认定是不是同一轮
  const isCurrent = (): boolean => snapshot.some((t) => t.key === key && t.startedAt === task.startedAt)
  void Promise.resolve()
    .then(() => run({ signal: controller.signal }))
    .then(
      (result) => {
        patchTask(key, {
          status: 'done',
          finishedAt: Date.now(),
          result,
          resultText: describe?.(result) ?? null,
        })
        const timer = setTimeout(() => {
          if (isCurrent()) dismissBackgroundTask(key)
        }, DONE_AUTO_HIDE_MS)
        ;(timer as { unref?: () => void }).unref?.()
      },
      (e: unknown) => {
        if (controller.signal.aborted) removeBackgroundTask(key)
        else patchTask(key, { status: 'error', finishedAt: Date.now(), error: (e as Error).message })
      },
    )
    .finally(() => {
      if (controllers.get(key) === controller) controllers.delete(key)
    })
  return true
}

export function getBackgroundTasks(): readonly BackgroundTask[] {
  return snapshot
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBackgroundTasks(): readonly BackgroundTask[] {
  return useSyncExternalStore(subscribe, getBackgroundTasks)
}

export function useBackgroundTask<R = unknown>(key: string): BackgroundTask<R> | undefined {
  return useBackgroundTasks().find((t) => t.key === key) as BackgroundTask<R> | undefined
}

/**
 * 任务在本组件挂载期间结束时回调（用于刷新本页数据）。
 * 组件挂载前就结束的任务不回调：重新挂载的页面本来就会取到最新数据。
 */
export function useBackgroundTaskSettled<R = unknown>(
  match: string | ((key: string) => boolean),
  onSettled: (task: BackgroundTask<R>) => void,
): void {
  const tasks = useBackgroundTasks()
  const previous = useRef(new Map<string, BackgroundTaskStatus>())
  const latest = useRef({ match, onSettled })
  useEffect(() => {
    latest.current = { match, onSettled }
  })
  useEffect(() => {
    const { match: m, onSettled: cb } = latest.current
    const hit = typeof m === 'string' ? (key: string) => key === m : m
    for (const t of tasks) {
      if (hit(t.key) && previous.current.get(t.key) === 'running' && t.status !== 'running') {
        cb(t as BackgroundTask<R>)
      }
    }
    previous.current = new Map(tasks.map((t) => [t.key, t.status]))
  }, [tasks])
}
