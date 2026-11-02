/**
 * 右下角全局进度卡：同步进度与其它耗时任务（AI 生成计划、拉取题库、难度回填、题单 AI 分析）
 * **切到任何页面都看得见**，可点击收缩成一行小胶囊。
 *
 * 存在的理由：单次同步现在按平台节奏限速（几十秒到几分钟），用户看不到任何动静就会
 * 以为卡住而关掉应用。卡片给出「已用时 + 该站点请求数 + 最后一次请求距今」——
 * 都是真实发生的请求，不是估值进度条。
 *
 * 收缩状态存 localStorage：嫌它挡视线时收起后不会自己弹开（但任务仍在跑，胶囊里继续报进度）。
 */
import { useEffect, useMemo, useState } from 'react'
import { App as AntdApp, Button, Card, Space, Tag, Tooltip, Typography } from 'antd'
import { CheckCircleFilled, CloseCircleFilled, CloseOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { PlatformId } from '../../shared/src/index.ts'
import { get, post } from './api'
import type { BackfillRunStatus } from './backfillProgress'
import { mergeActivityRows, toServerRuns, type ActivityRow, type BankRun, type ServerRun } from './backgroundRuns'
import { cancelBackgroundTask, dismissBackgroundTask, removeBackgroundTask, useBackgroundTasks } from './backgroundTasks'
import { IconChevronDown, IconChevronUp, IconSpinner } from './components/icons'
import { useSyncProgress } from './syncProgressCore'
import { elapsedText, heartbeatText, heartbeatTone, jobLineText, modeText, summaryText } from './syncProgress'
import { platformName } from './ui'

const COLLAPSED_KEY = 'icpc-sync-badge-collapsed'
const RUNS_POLL_ACTIVE_MS = 2_000
const RUNS_POLL_IDLE_MS = 10_000

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

const TONE_COLOR: Record<ReturnType<typeof heartbeatTone>, string> = {
  ok: 'processing',
  slow: 'warning',
  waiting: 'error',
  idle: 'default',
}

const nameOf = (platform: string): string => platformName(platform as PlatformId)

/** 轮询服务端自己跑的任务：有任务时跟紧进度，空闲时低频发现（刷新页面后接回、别处发起的任务） */
function useServerRuns(hasLocalRunning: boolean): ServerRun[] {
  const [runs, setRuns] = useState<ServerRun[]>([])
  const active = hasLocalRunning || runs.length > 0
  useEffect(() => {
    let stopped = false
    let seq = 0
    const load = async (): Promise<void> => {
      const my = ++seq
      try {
        const [bank, backfill] = await Promise.all([
          get<{ runs: BankRun[] }>('/api/problems/bank/runs'),
          get<{ run: BackfillRunStatus }>('/api/problems/backfill-difficulty/run'),
        ])
        if (!stopped && my === seq) setRuns(toServerRuns(bank.runs ?? [], backfill.run ?? null, nameOf))
      } catch {
        // 状态接口暂时不可用：保持上一次结果，不影响任务本体
      }
    }
    void load()
    const timer = setInterval(() => void load(), active ? RUNS_POLL_ACTIVE_MS : RUNS_POLL_IDLE_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [active])
  return runs
}

function TaskRow({ row, now, onStop }: { row: ActivityRow; now: number; onStop: (row: ActivityRow) => void }) {
  const nav = useNavigate()
  const hide = (): void => {
    dismissBackgroundTask(row.key)
    if (row.status === 'error') removeBackgroundTask(row.key)
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {row.status === 'running' && <IconSpinner size={13} className="icon-spin" />}
        {row.status === 'done' && <CheckCircleFilled style={{ color: 'var(--green)', fontSize: 13 }} />}
        {row.status === 'error' && <CloseCircleFilled style={{ color: 'var(--red)', fontSize: 13 }} />}
        <Typography.Text strong style={{ flex: 1, minWidth: 0 }} ellipsis={{ tooltip: row.title }}>
          {row.title}
        </Typography.Text>
        {row.status === 'running' && (row.abortable || row.stopPath) && (
          <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onStop(row)}>
            停止
          </Button>
        )}
        {row.status === 'done' && row.href && (
          <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => nav(row.href!)}>
            查看
          </Button>
        )}
        {row.status !== 'running' && (
          <Button type="text" size="small" aria-label="关闭" icon={<CloseOutlined style={{ fontSize: 11 }} />} onClick={hide} style={{ width: 20, height: 20 }} />
        )}
      </div>
      <div style={{ color: row.status === 'error' ? 'var(--red)' : 'var(--text-3)', fontSize: 12, marginTop: 2, wordBreak: 'break-word' }}>
        {row.status === 'running' && `${row.detail ? `${row.detail} · ` : ''}已用时 ${elapsedText(Math.max(0, now - row.startedAt))}`}
        {row.status === 'done' && (row.resultText ?? '已完成')}
        {row.status === 'error' && row.error}
      </div>
    </div>
  )
}

function pillText(rows: readonly ActivityRow[], now: number): string {
  const running = rows.filter((r) => r.status === 'running')
  const first = running[0]
  if (first) {
    const more = running.length > 1 ? `（共 ${running.length} 项）` : ''
    return `${first.title} · ${first.detail ?? elapsedText(Math.max(0, now - first.startedAt))}${more}`
  }
  const failed = rows.find((r) => r.status === 'error')
  if (failed) return `${failed.title}失败`
  return `${rows[0]?.title ?? '后台任务'}已完成`
}

export default function SyncProgressBadge() {
  const { message } = AntdApp.useApp()
  const { snapshot, running: syncing } = useSyncProgress()
  const tasks = useBackgroundTasks()
  const serverRuns = useServerRuns(tasks.some((t) => t.status === 'running'))
  const rows = useMemo(() => mergeActivityRows(tasks, serverRuns), [tasks, serverRuns])
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [now, setNow] = useState(() => Date.now())
  const ticking = rows.some((r) => r.status === 'running')

  // 已用时每秒走一格；后端任务的进度另有轮询，这里只驱动本地计时
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [ticking])

  if (!syncing && rows.length === 0) return null

  const toggle = (): void => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1')
      } catch {
        /* 隐私模式等场景 localStorage 不可用：仅本次会话生效 */
      }
      return !c
    })
  }

  const stop = (row: ActivityRow): void => {
    if (row.stopPath) {
      post(row.stopPath, {}).catch((e: Error) => message.error(e.message))
    } else {
      cancelBackgroundTask(row.key)
    }
  }

  const job = snapshot.jobs[0]
  const syncPill = job
    ? `同步中 · ${platformName(job.platform)} · ${elapsedText(job.elapsedMs)} · 已请求 ${job.siteRequests} 次`
    : summaryText(snapshot)
  const pill = syncing
    ? `${syncPill}${rows.length > 0 ? `（另有 ${rows.length} 项任务）` : ''}`
    : pillText(rows, now)

  if (collapsed) {
    return (
      <Tooltip title="点击展开任务进度">
        <button
          type="button"
          onClick={toggle}
          style={{
            position: 'fixed',
            right: 20,
            bottom: 20,
            zIndex: 1200,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: 'calc(100vw - 40px)',
            padding: '6px 12px',
            borderRadius: 16,
            border: '1px solid var(--line)',
            background: 'var(--surface-2)',
            color: 'var(--text-2)',
            fontSize: 12,
            cursor: 'pointer',
            boxShadow: 'var(--shadow)',
          }}
        >
          {(syncing || ticking) && <IconSpinner size={13} className="icon-spin" />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pill}</span>
          <IconChevronUp size={11} />
        </button>
      </Tooltip>
    )
  }

  const runningCount = rows.filter((r) => r.status === 'running').length
  return (
    <div
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 1200,
        width: 320,
        maxWidth: 'calc(100vw - 40px)',
        boxShadow: 'var(--shadow)',
      }}
    >
      <Card
        size="small"
        title={<span>{syncing ? summaryText(snapshot) : runningCount > 0 ? `后台任务 · ${runningCount} 项进行中` : '后台任务'}</span>}
        extra={
          <Tooltip title="收缩为一行（仍会继续显示进度）">
            <a onClick={toggle} style={{ fontSize: 12 }}>
              收缩 <IconChevronDown size={11} />
            </a>
          </Tooltip>
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%', maxHeight: '50vh', overflowY: 'auto' }}>
          {snapshot.jobs.map((j) => (
            <div key={j.platform}>
              <Space size={6} align="center">
                <IconSpinner size={13} className="icon-spin" />
                <Typography.Text strong>{platformName(j.platform)}</Typography.Text>
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  {modeText(j)}
                </Tag>
              </Space>
              <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 2 }}>{jobLineText(j)}</div>
              <Tag color={TONE_COLOR[heartbeatTone(j.lastRequestAgoMs)]} style={{ marginTop: 4 }}>
                {heartbeatText(j.lastRequestAgoMs)}
              </Tag>
            </div>
          ))}
          {syncing && snapshot.jobs.length === 0 && (
            <Typography.Text type="secondary">
              {snapshot.batch?.current
                ? `准备同步 ${platformName(snapshot.batch.current)}…`
                : `同步进行中 · 已用时 ${elapsedText(snapshot.batch?.elapsedMs ?? 0)}`}
            </Typography.Text>
          )}
          {rows.map((row) => (
            <TaskRow key={row.key} row={row} now={now} onStop={stop} />
          ))}
          {(syncing || runningCount > 0) && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              切换页面不会中断任务；请勿关闭应用。
            </Typography.Text>
          )}
        </Space>
      </Card>
    </div>
  )
}
