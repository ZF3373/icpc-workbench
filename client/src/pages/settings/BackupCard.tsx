import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  List,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
} from 'antd'
import { DatabaseOutlined, DeleteOutlined, DownloadOutlined } from '@ant-design/icons'
import { del, get, post } from '../../api'
import { fmtDateTime } from '../../formatTime.ts'
import { formatBytes } from '../../ui'
import { saveUrlAsFile } from '../../download'

/** 恢复点条目（GET /api/backups） */
/** 恢复点条目（GET /api/backups） */
interface BackupItem {
  file: string
  reason: string
  createdAtMs: number
  size: number
  /** 是否带知识点标注快照；false（升级前的旧备份）表示恢复后标注不会回退 */
  knowledge?: boolean
}

/** GET /api/backups 的响应：列表 + 待恢复标记 + 部署形态 */
interface BackupsResponse {
  backups: BackupItem[]
  /** 已登记、等待重启生效的恢复目标；无标记时为 null */
  pendingRestore: { file: string; requestedAt: string } | null
  /** 运行在 Docker 容器内（恢复引导文案不同） */
  docker?: boolean
  /** 「重启容器」端点可用（仅 Docker 环境） */
  canRestart?: boolean
}

const BACKUP_REASON_LABEL: Record<string, string> = {
  manual: '手动',
  daily: '每日',
  'pre-upgrade': '升级前',
  'pre-import': '导入前',
  'pre-reset': '重置前',
}

/** 备份与恢复点：每日首次启动 / 升级前 / 大批量导入前 / 换账号重置前自动创建；恢复重启后生效。
 *  refreshKey 变化（如设置页删号新建了恢复点）时重新拉取，避免列表停在页面加载时的快照 */
export function BackupCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const { message, modal } = AntdApp.useApp()
  const [backups, setBackups] = useState<BackupItem[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  /** 已登记、等待重启生效的恢复目标；再点其他备份会覆盖它（覆盖前弹确认） */
  const [pendingFile, setPendingFile] = useState<string | null>(null)
  /** Docker 部署：恢复引导文案改为「重启容器」，并可一键触发容器重启 */
  const [docker, setDocker] = useState(false)
  /** 「重启此容器」按钮的进行中状态：请求成功后进程退出，页面会失去连接 */
  const [restarting, setRestarting] = useState(false)
  /** 组件是否仍挂载：重启轮询在用户离开设置页后应立即停止 */
  const aliveRef = useRef(true)
  useEffect(() => {
    // StrictMode 下 effect 会「挂载→卸载→再挂载」：必须在这里置回 true，
    // 只有 cleanup 置 false 会让开发模式的轮询一启动就退出。
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const load = () => {
    setLoading(true)
    get<BackupsResponse>('/api/backups')
      .then((d) => {
        setBackups(d.backups)
        setPendingFile(d.pendingRestore?.file ?? null)
        setDocker(d.docker === true)
      })
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [message, refreshKey])

  /** 恢复生效的操作指引：Docker 用户要重启容器，桌面版要重启应用 */
  const restartHint = docker
    ? '请重启容器（docker restart icpc-workbench）使恢复生效'
    : '请重启应用使恢复生效'
  const restartShort = docker ? '重启容器（docker restart icpc-workbench）' : '重启应用'

  const createNow = async () => {
    setCreating(true)
    try {
      const r = await post<{ file: string }>('/api/backups')
      message.success(`已创建恢复点 ${r.file}`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  /** 真正登记恢复（已确认过覆盖/数据丢失） */
  const doRestore = async (b: BackupItem) => {
    try {
      await post(`/api/backups/${encodeURIComponent(b.file)}/restore`)
      setPendingFile(b.file)
      message.warning(`已登记恢复请求：${restartHint}`)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const confirmRestore = (b: BackupItem) => {
    // 已登记了另一个恢复目标：先明确告知「会覆盖」，避免静默换目标后还以为之前那个会生效
    const overwriting = pendingFile !== null && pendingFile !== b.file
    modal.confirm({
      title: overwriting ? '改选另一个恢复点？' : '恢复此备份？',
      width: 480,
      content: (
        <div style={{ fontSize: 13 }}>
          {overwriting && (
            <p style={{ color: 'var(--red)' }}>
              当前待恢复的是 {pendingFile}，登记本次恢复会覆盖它（重启后只会回滚到下面这个恢复点）。
            </p>
          )}
          <p>数据库将回滚到 {fmtDateTime(b.createdAtMs)}（{BACKUP_REASON_LABEL[b.reason] ?? b.reason}，{formatBytes(b.size)}）。</p>
          <p style={{ color: 'var(--red)' }}>备份之后产生的同步、打卡、复习等数据会丢失。恢复在{restartShort}后生效。</p>
          {b.knowledge === false ? (
            <p style={{ color: 'var(--red)' }}>
              该恢复点不含知识点标注快照（升级前的旧备份）：数据库会回滚，但知识点标注不会被回退。
            </p>
          ) : (
            <p style={{ color: 'var(--text-3)' }}>数据库与知识点标注（annotations.jsonl）会一起回滚到该时间点。</p>
          )}
        </div>
      ),
      okText: overwriting ? '覆盖并登记恢复' : '登记恢复（重启生效）',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => doRestore(b),
    })
  }

  /** Docker：让进程退出，由 compose 的 restart: unless-stopped 拉起并应用恢复点 */
  const restartContainer = async () => {
    setRestarting(true)
    try {
      await post('/api/backups/restart')
      message.warning('容器正在重启以应用恢复点，恢复完成后页面会自动刷新')
      // 进程退出后接口会短暂不可达：轮询探活，回来后自动刷新，免去用户手点。
      // ⚠ 只看 /api/health 不够：旧进程退出前有 300ms 优雅退出宽限（restartDelayMs），
      // 宽限期内旧进程照样应答 health——此时 reload 刷回来的是**回滚前的旧数据**，
      // 用户会误以为恢复失败。必须同时确认待恢复标记已被新进程消费（pendingRestore 清空）。
      for (let i = 0; i < 60 && aliveRef.current; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        try {
          const h = await get<{ ok?: boolean }>('/api/health')
          if (!h.ok) continue
          const d = await get<BackupsResponse>('/api/backups')
          if (!d.pendingRestore) {
            window.location.reload()
            return
          }
          // 新进程起来了但标记还在（applyPendingRestore 失败/被跳过）：停止轮询提示人工处理，
          // 否则会 60 秒后以「容器未恢复」误导用户
          if (aliveRef.current) {
            setRestarting(false)
            message.error('容器已重启，但待恢复标记未被消费（恢复可能失败）：请查看服务端日志或重新发起恢复')
          }
          return
        } catch {
          // 进程还没起来，继续等
        }
      }
      if (aliveRef.current) {
        setRestarting(false)
        message.info('容器尚未恢复响应：请执行 docker ps 确认状态，或手动 docker restart icpc-workbench')
      }
    } catch (e) {
      message.error((e as Error).message)
      setRestarting(false)
    }
  }

  // 删除单个恢复点（连带其知识点伴生快照）：避免长期使用后备份堆积占用磁盘
  const removeBackup = async (b: BackupItem) => {
    try {
      await del(`/api/backups/${encodeURIComponent(b.file)}`)
      message.success(`已删除恢复点 ${b.file}`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Card title={<span className="settings-section-title"><DatabaseOutlined />备份与恢复点</span>} size="small">
      <Space style={{ marginBottom: 8 }} wrap>
        <Button onClick={() => void createNow()} loading={creating}>
          立即备份
        </Button>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          自动备份时机：每日首次启动、应用升级前、大批量导入前、换账号重置前；恢复需{restartShort}生效；备份可下载或手动删除。
        </span>
      </Space>
      {pendingFile && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message={`已登记恢复：${pendingFile}`}
          description={
            <Space direction="vertical" size={4}>
              <span>{restartHint}。重启前再选其他备份会覆盖当前待恢复项（会二次确认）。</span>
              {docker && (
                <Popconfirm
                  title="立即重启容器？"
                  description={
                    <span style={{ display: 'inline-block', maxWidth: 320 }}>
                      将让服务进程退出，由 compose 的 restart: unless-stopped 自动拉起并应用恢复点；页面会短暂断开。若容器未配置 restart
                      策略，退出后需手动 docker start icpc-workbench。
                    </span>
                  }
                  okText="重启容器"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void restartContainer()}
                >
                  <Button size="small" type="primary" danger loading={restarting}>
                    立即重启容器
                  </Button>
                </Popconfirm>
              )}
            </Space>
          }
        />
      )}
      <List
        size="small"
        loading={loading}
        dataSource={backups}
        locale={{ emptyText: '暂无备份' }}
        renderItem={(b) => (
          <List.Item
            actions={[
              <Button key="restore" size="small" color="green" variant="outlined" onClick={() => confirmRestore(b)}>
                恢复
              </Button>,
              <Button
                key="download"
                size="small"
                icon={<DownloadOutlined />}
                onClick={() =>
                  void saveUrlAsFile({
                    url: `/api/backups/${encodeURIComponent(b.file)}/download`,
                    filename: b.file,
                    mime: 'application/octet-stream',
                    binary: true,
                    successText: `已下载恢复点 ${b.file}（可异地留存，需要时直接替换数据目录中的同名备份）`,
                    message,
                  })
                }
              >
                下载
              </Button>,
              <Popconfirm
                key="delete"
                title="删除此备份？"
                description="将删除备份文件及其知识点快照，删除后不可找回。"
                okText="删除"
                cancelText="取消"
                onConfirm={() => void removeBackup(b)}
              >
                <Tooltip title="删除备份">
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除备份" />
                </Tooltip>
              </Popconfirm>,
            ]}
          >
            <Space size={8} wrap>
              <Tag>{BACKUP_REASON_LABEL[b.reason] ?? b.reason}</Tag>
              {pendingFile === b.file && <Tag color="warning">重启后恢复</Tag>}
              {b.knowledge === false && <Tag color="warning">不含知识点快照</Tag>}
              <span style={{ fontSize: 12 }}>{fmtDateTime(b.createdAtMs)}</span>
              <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatBytes(b.size)}</span>
            </Space>
          </List.Item>
        )}
      />
    </Card>
  )
}
