/**
 * 「同步状态」卡的内容区：进度行（进行中 / 收尾）或各平台上次同步结果（空闲）。
 *
 * 拆成两个纯展示组件由 SyncStatusCard 选择，卡片外壳（标题/收缩/历史入口）不在这里。
 * 展示内容全部来自 GET /api/sync/progress 与 /api/sync/status 的真实数据：
 * 平台、阶段、已用时、该站点请求数、最后一次请求距今；没有百分比。
 */
import { Empty, Space, Tag, Typography } from 'antd'
import { useSyncProgress } from '../syncProgressContext'
import { batchRows, batchStateText, elapsedText, heartbeatTone, jobLineText, modeText, phaseText, type BatchRowState } from '../syncProgress'
import { healthColor, healthText, platformRunLine } from '../syncStatus'
import { platformName } from '../ui'

const STATE_TAG: Record<BatchRowState, string> = {
  pending: 'default',
  running: 'processing',
  ok: 'success',
  failed: 'error',
}

/** 进行中 / 刚结束的进度行（一键同步时逐平台：待同步 → 同步中 → 已完成/失败） */
export function RunningRows() {
  const { snapshot } = useSyncProgress()
  const runningJobs = new Map(snapshot.jobs.map((j) => [j.platform, j]))
  const batchPlatforms = snapshot.batch?.platforms ?? []
  const rows = [
    ...(snapshot.batch ? batchRows(snapshot.batch) : []),
    ...snapshot.jobs
      .filter((j) => !batchPlatforms.includes(j.platform))
      .map((j) => ({ platform: j.platform, state: 'running' as const, imported: 0, error: undefined })),
  ]

  if (rows.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无进行中的同步" />

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {rows.map((row) => {
        const job = runningJobs.get(row.platform)
        return (
          <div key={row.platform}>
            <Space size={8} wrap>
              <Typography.Text strong>{platformName(row.platform)}</Typography.Text>
              <Tag color={STATE_TAG[row.state]} style={{ marginInlineEnd: 0 }}>
                {row.state === 'ok' || row.state === 'failed' ? batchStateText(row.state, row.imported) : batchStateText(row.state, 0)}
              </Tag>
              {job && (
                <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                  {modeText(job)}
                </Tag>
              )}
              {job && <Typography.Text type="secondary">{phaseText(job)}</Typography.Text>}
            </Space>
            {job && <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 2 }}>{jobLineText(job)}</div>}
            {row.state === 'failed' && row.error && (
              <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 2 }}>{row.error}</div>
            )}
          </div>
        )
      })}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {snapshot.jobs.length > 0
          ? `正在同步 · 总用时 ${elapsedText(snapshot.batch?.elapsedMs ?? snapshot.jobs[0]!.elapsedMs)}；切换页面不会中断同步，请勿关闭应用。`
          : '本次同步已结束；提交记录较多时会分批拉取，可再次点击「同步数据」继续补全更早的历史。'}
      </Typography.Text>
      {snapshot.jobs.some((j) => heartbeatTone(j.lastRequestAgoMs) === 'waiting') && (
        <Typography.Text type="warning" style={{ fontSize: 12 }}>
          上游响应较慢，仍在等待——平台限速下这是正常的，请保持应用开启。
        </Typography.Text>
      )}
    </Space>
  )
}

/** 空闲时的各平台上次同步结果（健康徽章 + 时间/触发方式/新增/去重/限速等待/失败原因） */
export function IdlePlatformRows() {
  const { statuses } = useSyncProgress()
  if (statuses.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未绑定平台账号" />
  }
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {statuses.map((s) => (
        <div key={s.platform}>
          <Space size={8} wrap>
            <Typography.Text strong>{s.platformName}</Typography.Text>
            <Tag color={healthColor(s.status)} style={{ marginInlineEnd: 0 }}>
              {healthText(s.status)}
            </Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {s.handle}
            </Typography.Text>
          </Space>
          <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 2 }}>{platformRunLine(s)}</div>
        </div>
      ))}
    </Space>
  )
}
