/**
 * 「上次同步结果」抽屉：把后端一直有、前端一直没用的同步历史呈现出来。
 *
 * 数据：GET /api/sync/runs?limit=50（同步历史，新→旧）+ 上下文里的 /api/sync/status（各平台最近一次）。
 * 打开时才拉取（不做常驻轮询）。
 */
import { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Drawer, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { PlatformId, SyncRun } from '../../../shared/src/index.ts'
import { get, post } from '../api'
import { useSyncProgress } from '../syncProgressContext'
import { elapsedText, modeText } from '../syncProgress'
import { absoluteTimeText, healthText, triggeredByText } from '../syncStatus'
import { platformName } from '../ui'

export default function SyncHistoryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp()
  const { snapshot, refresh } = useSyncProgress()
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [loading, setLoading] = useState(false)
  const [retrying, setRetrying] = useState<PlatformId | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const r = await get<SyncRun[]>('/api/sync/runs?limit=50')
      setRuns(r ?? [])
    } catch {
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [open, load])

  /** 正在同步的平台（重试按钮据此禁用，避免同平台并发触发被互斥锁拒绝） */
  const runningPlatforms = new Set(snapshot.jobs.map((j) => j.platform))

  const retry = async (run: SyncRun): Promise<void> => {
    setRetrying(run.platform)
    try {
      const r = await post<{ imported: number; skipped: number; errors: string[]; note?: string }>(
        `/api/sync/${run.platform}`,
        { handle: run.handle, retry: true },
      )
      if (r.errors.length > 0) {
        message.warning(`${platformName(run.platform)}：${r.errors[0]}`, 6)
      } else {
        message.success(
          `${platformName(run.platform)} 重试完成：导入 ${r.imported} 条、去重 ${r.skipped} 条` +
            (r.note ? `。${r.note}` : ''),
          6,
        )
      }
      // 进度与历史都刷新：重试本身也会在历史里留下一条 triggered_by=retry 的记录
      refresh()
      await load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setRetrying(null)
    }
  }

  const columns: ColumnsType<SyncRun> = [
    { title: '时间', dataIndex: 'startedAt', width: 150, render: (v: string) => absoluteTimeText(v) },
    { title: '平台', dataIndex: 'platform', width: 110, render: (v: SyncRun['platform']) => platformName(v) },
    { title: '触发', dataIndex: 'triggeredBy', width: 90, render: (v: string) => triggeredByText(v) },
    { title: '模式', dataIndex: 'mode', width: 110, render: (v: SyncRun['mode']) => modeText({ mode: v }) },
    {
      title: '结果',
      dataIndex: 'status',
      width: 110,
      render: (_v, r) => (
        <Tag color={r.status === 'ok' ? 'success' : 'error'} style={{ marginInlineEnd: 0 }}>
          {r.status === 'ok' ? '成功' : healthText(r.errorCode ?? 'unknown')}
        </Tag>
      ),
    },
    {
      title: '新增 / 去重',
      key: 'counts',
      width: 110,
      render: (_v, r) => `${r.imported} / ${r.skipped}`,
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 110,
      render: (v: number, r) => `${elapsedText(v)}${r.waitedMs > 0 ? `（限速 ${Math.round(r.waitedMs / 1000)}s）` : ''}`,
    },
    {
      title: '说明',
      key: 'note',
      render: (_v, r) => {
        if (r.status === 'failed') return <span style={{ color: 'var(--red)' }}>{r.errorMessage ?? '（无错误信息）'}</span>
        if (r.truncated === 1) return '记录较多，已分批（可再次同步继续补全）'
        return '—'
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 96,
      render: (_v, r) => {
        if (r.status !== 'failed') return null
        const busy = retrying === r.platform
        const isRunning = runningPlatforms.has(r.platform)
        return (
          <Tooltip title={isRunning ? '该平台正在同步中，请等本轮结束' : `用 ${r.handle} 重新同步该平台（记录为「重试」）`}>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={busy}
              disabled={isRunning && !busy}
              onClick={() => void retry(r)}
            >
              重试
            </Button>
          </Tooltip>
        )
      },
    },
  ]

  return (
    <Drawer title="上次同步结果" width={860} open={open} onClose={onClose}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          最近 50 次同步记录（新→旧）。「限速」是页间间隔与限流退避的累计等待——
          平台限速下同步较慢属正常；失败的平台可直接点该行的「重试」重新同步。
        </Typography.Text>
        <Table<SyncRun>
          size="small"
          rowKey={(r) => String(r.id)}
          loading={loading}
          columns={columns}
          dataSource={runs}
          pagination={{ pageSize: 15, hideOnSinglePage: true }}
          scroll={{ x: 1000 }}
        />
      </Space>
    </Drawer>
  )
}
