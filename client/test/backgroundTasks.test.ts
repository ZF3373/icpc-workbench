import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cancelBackgroundTask,
  dismissBackgroundTask,
  getBackgroundTasks,
  removeBackgroundTask,
  startBackgroundTask,
} from '../src/backgroundTasks.ts'
import { bankRunDetail, mergeActivityRows, toServerRuns, type ServerRun } from '../src/backgroundRuns.ts'

const find = (key: string) => getBackgroundTasks().find((t) => t.key === key)
const flush = () => new Promise((r) => setTimeout(r, 0))

test('任务结束后结果保留在 store，收起后页面仍能读到', async () => {
  assert.equal(startBackgroundTask({ key: 'a', title: 'A', run: async () => 7, describe: (n) => `结果 ${n}` }), true)
  assert.equal(find('a')?.status, 'running')
  await flush()
  assert.equal(find('a')?.status, 'done')
  assert.equal(find('a')?.resultText, '结果 7')
  dismissBackgroundTask('a')
  assert.equal(find('a')?.hidden, true)
  assert.equal(find('a')?.result, 7)
  removeBackgroundTask('a')
  assert.equal(find('a'), undefined)
})

test('同 key 运行中不重复发起；结束后可重新发起', async () => {
  let release = () => {}
  const gate = new Promise<void>((r) => { release = r })
  let runs = 0
  const run = async () => { runs += 1; await gate }
  assert.equal(startBackgroundTask({ key: 'b', title: 'B', run }), true)
  assert.equal(startBackgroundTask({ key: 'b', title: 'B', run }), false)
  release()
  await flush()
  assert.equal(runs, 1)
  assert.equal(startBackgroundTask({ key: 'b', title: 'B', run }), true)
  await flush()
  removeBackgroundTask('b')
})

test('失败记下原因；中止的任务直接移除，不算失败', async () => {
  startBackgroundTask({ key: 'c', title: 'C', run: async () => { throw new Error('boom') } })
  await flush()
  assert.equal(find('c')?.status, 'error')
  assert.equal(find('c')?.error, 'boom')
  removeBackgroundTask('c')

  startBackgroundTask({
    key: 'd',
    title: 'D',
    abortable: true,
    run: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  })
  await flush()
  cancelBackgroundTask('d')
  await flush()
  assert.equal(find('d'), undefined)
})

test('进度文案：未拿到数据时不编数字', () => {
  assert.equal(bankRunDetail({ platform: 'luogu', fetched: 0, total: null, startedAt: '' }), '正在请求题库…')
  assert.equal(bankRunDetail({ platform: 'luogu', fetched: 50, total: 1000, startedAt: '' }), '已拉取 50/1000 题')
  assert.equal(bankRunDetail({ platform: 'luogu', fetched: 50, total: null, startedAt: '' }), '已拉取 50 题')
})

test('合并行：前端任务接上服务端进度；刷新后只剩服务端任务也单独成行；已结束不重复', async () => {
  const run: ServerRun = { key: 'bank:luogu', title: '拉取题库 · 洛谷', detail: '已拉取 50 题', href: '/problems', startedAt: 1 }
  assert.deepEqual(mergeActivityRows([], [run]).map((r) => [r.key, r.status, r.detail]), [['bank:luogu', 'running', '已拉取 50 题']])

  let release = () => {}
  const gate = new Promise<void>((r) => { release = r })
  startBackgroundTask({ key: 'bank:luogu', title: '拉取题库 · 洛谷', run: () => gate })
  let rows = mergeActivityRows(getBackgroundTasks(), [run])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].detail, '已拉取 50 题')

  release()
  await flush()
  rows = mergeActivityRows(getBackgroundTasks(), [run])
  assert.deepEqual(rows.map((r) => r.status), ['done'], '服务端快照滞后时不再多出一行运行中')
  removeBackgroundTask('bank:luogu')
})

test('服务端回填运行中才成行，停止中不再给停止入口', () => {
  const backfill = { running: true, stopping: false, startedAt: '2026-01-01T00:00:00Z', platform: 'luogu', platformDone: 1, platformTotal: 2, done: 1, total: 2 }
  const nameOf = (p: string) => p
  assert.equal(toServerRuns([], { ...backfill, running: false }, nameOf).length, 0)
  assert.ok(toServerRuns([], backfill, nameOf)[0].stopPath)
  assert.equal(toServerRuns([], { ...backfill, stopping: true }, nameOf)[0].stopPath, undefined)
})
