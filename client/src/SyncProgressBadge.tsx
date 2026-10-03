/**
 * 右下角全局同步悬浮卡：**切到任何页面都看得见**，可点击收缩成一行小胶囊。
 *
 * 存在的理由：单次同步现在按平台节奏限速（几十秒到几分钟），用户看不到任何动静就会
 * 以为卡住而关掉应用。卡片给出「已用时 + 该站点请求数 + 最后一次请求距今」——
 * 都是真实发生的请求，不是估值进度条。
 *
 * 收缩状态存 localStorage：嫌它挡视线时收起后不会自己弹开（但同步仍在跑，胶囊里继续报进度）。
 */
import { useState } from 'react'
import { Card, Space, Tag, Tooltip, Typography } from 'antd'
import { DownOutlined, LoadingOutlined, UpOutlined } from '@ant-design/icons'
import { useSyncProgress } from './syncProgressContext'
import { elapsedText, heartbeatText, heartbeatTone, jobLineText, modeText, summaryText } from './syncProgress'
import { platformName } from './ui'

const COLLAPSED_KEY = 'icpc-sync-badge-collapsed'

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

export default function SyncProgressBadge() {
  const { snapshot, running } = useSyncProgress()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  if (!running) return null

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

  const job = snapshot.jobs[0]
  const pill = job
    ? `同步中 · ${platformName(job.platform)} · ${elapsedText(job.elapsedMs)} · 已请求 ${job.siteRequests} 次`
    : summaryText(snapshot)

  if (collapsed) {
    return (
      <Tooltip title="点击展开同步进度">
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
          <LoadingOutlined />
          {pill}
          <UpOutlined style={{ fontSize: 10 }} />
        </button>
      </Tooltip>
    )
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 1200,
        width: 320,
        boxShadow: 'var(--shadow)',
      }}
    >
      <Card
        size="small"
        title={<span>{summaryText(snapshot)}</span>}
        extra={
          <Tooltip title="收缩为一行（仍会继续显示进度）">
            <a onClick={toggle} style={{ fontSize: 12 }}>
              收缩 <DownOutlined style={{ fontSize: 10 }} />
            </a>
          </Tooltip>
        }
      >
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {snapshot.jobs.map((j) => (
            <div key={j.platform}>
              <Space size={6} align="center">
                <LoadingOutlined />
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
          {snapshot.jobs.length === 0 && (
            <Typography.Text type="secondary">
              {snapshot.batch?.current
                ? `准备同步 ${platformName(snapshot.batch.current)}…`
                : `同步进行中 · 已用时 ${elapsedText(snapshot.batch?.elapsedMs ?? 0)}`}
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            切换页面不会中断同步；请勿关闭应用。
          </Typography.Text>
        </Space>
      </Card>
    </div>
  )
}
