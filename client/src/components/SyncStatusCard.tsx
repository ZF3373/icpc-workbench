/**
 * 数据概览页内常驻的「同步状态」卡（合并两件事）：
 * - 进行中/刚结束时 = 进度视图（逐平台 待同步/同步中/已完成/失败）；
 * - 空闲时 = 上次同步结果摘要 + 各平台最近一次同步（健康徽章）。
 *
 * 标题行右侧两个操作：**「上次同步结果」**（打开历史抽屉）与**展开/收缩**（状态存 localStorage）。
 * 收缩后仍保留摘要一行；**有同步进行中时强制展开**——"还在跑"这件事任何时候都必须看得见。
 */
import { useState } from 'react'
import { Card, Space, Tooltip, Typography } from 'antd'
import { IconChevronDown, IconChevronUp, IconHistory } from './icons'
import { useSyncProgress } from '../syncProgressCore'
import { summaryText, wrapUpVisible } from '../syncProgress'
import { lastSyncSummary } from '../syncStatus'
import { IdlePlatformRows, RunningRows } from './SyncProgressRows'
import SyncHistoryDrawer from './SyncHistoryDrawer'

const COLLAPSED_KEY = 'icpc-sync-status-collapsed'

/** 默认收起（概览页的首要内容是统计）：键不存在=收起，用户点过「展开」才持久化为展开 */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) !== '0'
  } catch {
    return true
  }
}

export default function SyncStatusCard() {
  const { snapshot, statuses, running } = useSyncProgress()
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [historyOpen, setHistoryOpen] = useState(false)

  const wrapUp = wrapUpVisible(snapshot)
  // 没绑账号、没有历史、也没在同步：不占位（概览页自己的空状态已给出引导）
  if (!running && !wrapUp && statuses.length === 0) return null

  // 进行中强制展开：用户可以自己收起来看别的内容，但同步一开始必须能看见
  const showBody = running || !collapsed
  const title = running || wrapUp ? summaryText(snapshot) : lastSyncSummary(statuses)

  const toggle = (): void => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1')
      } catch {
        /* localStorage 不可用时仅本次会话生效 */
      }
      return !c
    })
  }

  return (
    <>
      <Card
        size="small"
        className="sync-status-card"
        style={{ marginBottom: 16 }}
        title={
          <Space size={8} wrap>
            <span>{title}</span>
            {running && <Typography.Text type="secondary" style={{ fontSize: 12 }}>进度实时刷新中</Typography.Text>}
          </Space>
        }
        extra={
          <Space size={12}>
            <Tooltip title="查看最近 50 次同步的明细（平台 / 模式 / 耗时 / 错误原因）">
              <a onClick={() => setHistoryOpen(true)} style={{ fontSize: 13 }}>
                <IconHistory size={13} /> 上次同步结果
              </a>
            </Tooltip>
            <Tooltip title={collapsed ? '展开各平台详情' : '收起详情（摘要仍显示）'}>
              <a onClick={toggle} style={{ fontSize: 13 }}>
                {collapsed ? (
                  <>
                    展开 <IconChevronDown size={11} />
                  </>
                ) : (
                  <>
                    收起 <IconChevronUp size={11} />
                  </>
                )}
              </a>
            </Tooltip>
          </Space>
        }
      >
        {showBody ? (
          running || wrapUp ? (
            <RunningRows />
          ) : (
            <IdlePlatformRows />
          )
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已收起：点右侧「展开」查看各平台上次同步结果。
          </Typography.Text>
        )}
      </Card>
      <SyncHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  )
}
