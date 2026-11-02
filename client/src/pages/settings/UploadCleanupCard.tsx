import { useState } from 'react'
import { Alert, App as AntdApp, Button, Card, Image, List, Modal, Tag } from 'antd'
import { ClearOutlined, PaperClipOutlined } from '@ant-design/icons'
import { get, post } from '../../api'
import { fmtDateTime } from '../../formatTime.ts'
import { formatBytes } from '../../ui'

interface UnusedFile {
  file: string
  kind: 'image' | 'attachment'
  size: number
  modifiedAt: string
}

interface UploadScan {
  unused: UnusedFile[]
  unusedBytes: number
  inUse: number
  keptForBackups: number
  keptRecent: number
}

/** 清理笔记里不再使用的图片和附件：先扫描给出清单，确认后才删除，不做自动删除 */
export function UploadCleanupCard() {
  const { message } = AntdApp.useApp()
  const [scan, setScan] = useState<UploadScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const runScan = async (): Promise<void> => {
    setScanning(true)
    try {
      setScan(await get<UploadScan>('/api/uploads/unused'))
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setScanning(false)
    }
  }

  const clean = async (): Promise<void> => {
    if (!scan) return
    setDeleting(true)
    try {
      const r = await post<{ deleted: number; freedBytes: number; failed: number }>('/api/uploads/cleanup', {
        files: scan.unused.map((f) => f.file),
      })
      if (r.failed > 0) message.warning(`已清理 ${r.deleted} 个文件，${r.failed} 个删除失败`)
      else message.success(`已清理 ${r.deleted} 个文件，释放 ${formatBytes(r.freedBytes)}`)
      setScan(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  const count = scan?.unused.length ?? 0
  return (
    <Card title={<span className="settings-section-title"><ClearOutlined />清理未使用文件</span>} size="small">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Button onClick={() => void runScan()} loading={scanning}>扫描未使用文件</Button>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          找出笔记不再引用的图片和附件，确认清单后才会删除。当前数据或恢复点还在引用的文件、24 小时内上传的文件不会被清理。
        </span>
      </div>
      <Modal
        title="清理未使用文件"
        open={scan !== null}
        onCancel={() => setScan(null)}
        width={640}
        destroyOnHidden
        styles={{ body: { maxHeight: '60vh', overflowY: 'auto' } }}
        footer={[
          <Button key="cancel" onClick={() => setScan(null)}>{count > 0 ? '取消' : '关闭'}</Button>,
          ...(count > 0
            ? [
                <Button key="clean" type="primary" danger loading={deleting} onClick={() => void clean()}>
                  删除 {count} 个文件（释放 {formatBytes(scan?.unusedBytes ?? 0)}）
                </Button>,
              ]
            : []),
        ]}
      >
        {scan && (
          <>
            <Alert
              style={{ marginBottom: 12 }}
              type={count > 0 ? 'warning' : 'success'}
              showIcon
              message={count > 0 ? `发现 ${count} 个未使用文件，删除后不可恢复` : '没有可清理的文件'}
              description={
                <>
                  正在使用 {scan.inUse} 个
                  {scan.keptForBackups > 0 && ` · 恢复点还在引用，保留 ${scan.keptForBackups} 个（对应恢复点过期或删除后才可清理）`}
                  {scan.keptRecent > 0 && ` · 24 小时内上传，保留 ${scan.keptRecent} 个`}
                </>
              }
            />
            {count > 0 && (
              <List
                size="small"
                dataSource={scan.unused}
                renderItem={(f) => (
                  <List.Item
                    extra={<span style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatBytes(f.size)}</span>}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      {f.kind === 'image' ? (
                        <Image src={`/api/uploads/${f.file}`} width={40} height={40} style={{ objectFit: 'cover', borderRadius: 4 }} alt="未使用的图片" />
                      ) : (
                        <span style={{ width: 40, textAlign: 'center' }}><PaperClipOutlined /></span>
                      )}
                      <div style={{ minWidth: 0 }}>
                        <Tag style={{ marginInlineEnd: 6 }}>{f.kind === 'image' ? '图片' : '附件'}</Tag>
                        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>上传于 {fmtDateTime(Date.parse(f.modifiedAt))}</span>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file}</div>
                      </div>
                    </div>
                  </List.Item>
                )}
              />
            )}
          </>
        )}
      </Modal>
    </Card>
  )
}
