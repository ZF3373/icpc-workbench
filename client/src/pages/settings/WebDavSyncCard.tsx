import { CloudSyncOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Checkbox, Form, Input, InputNumber, Popconfirm, Space, Switch } from 'antd'
import { useEffect, useState } from 'react'
import type { WebDavSyncSettings, WebDavSyncStatus } from '../../../../shared/src/webdavSync.ts'
import { get, post, put } from '../../api'
import { fmtDateTime } from '../../formatTime.ts'

type Fields = Omit<WebDavSyncSettings, 'hasPassword'> & { password?: string; clearPassword?: boolean }
const ENDPOINT = '/api/webdav-sync'

export function WebDavSyncCard() {
  const { message } = App.useApp()
  const [form] = Form.useForm<Fields>()
  const clearPassword = Form.useWatch('clearPassword', form)
  const [status, setStatus] = useState<WebDavSyncStatus>()
  const [loadError, setLoadError] = useState('')
  const [action, setAction] = useState<'save' | 'test' | 'run' | 'resolve'>()

  useEffect(() => {
    let initialized = false
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const next = await get<WebDavSyncStatus>(ENDPOINT, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (!initialized) {
          initialized = true
          form.setFieldsValue(next.settings)
        }
        setStatus(next)
        setLoadError('')
      } catch (error) {
        if (!controller.signal.aborted) setLoadError((error as Error).message)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [form])

  async function configure(kind: 'save' | 'test') {
    const fields = await form.validateFields().catch(() => undefined)
    if (!fields) return
    const { clearPassword, password, ...settings } = fields
    const body = { ...settings, password: clearPassword ? '' : password || undefined }
    setAction(kind)
    try {
      if (kind === 'save') {
        const next = await put<WebDavSyncStatus>(ENDPOINT, body)
        form.setFieldsValue({ ...next.settings, password: '', clearPassword: false })
        setStatus(next)
        message.success('WebDAV 同步设置已保存')
      } else {
        await post(`${ENDPOINT}/test`, body)
        message.success('WebDAV 目录连接成功')
      }
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setAction(undefined)
    }
  }

  async function sync(keep?: 'local' | 'remote') {
    setAction(keep ? 'resolve' : 'run')
    try {
      const next = await post<WebDavSyncStatus>(`${ENDPOINT}/${keep ? 'resolve' : 'run'}`,
        keep ? { ...status?.conflict, keep } : undefined)
      setStatus(next)
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setAction(undefined)
    }
  }

  const synchronizing = status?.state === 'syncing'
  const alertType = status?.state === 'error' ? 'error' : status?.state === 'conflict' ? 'warning' : 'success'

  return (
    <Card title={<span className="settings-section-title"><CloudSyncOutlined />WebDAV 数据同步</span>} size="small">
      <p className="muted-note">在各设备上填写同一个 WebDAV 目录。启用后，应用运行时会自动检测两端变化并传输有变动的数据块。</p>
      {loadError && <Alert type="error" showIcon message={loadError} />}
      <Form form={form} layout="vertical" disabled={!status || Boolean(action) || synchronizing} onFinish={() => void configure('save')}>
        <Form.Item name="url" label="WebDAV 目录地址">
          <Input placeholder="https://cloud.example.com/remote.php/dav/files/用户名/" autoComplete="off" />
        </Form.Item>
        <Form.Item name="username" label="账号">
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="password" label="密码或应用密码">
          <Input.Password autoComplete="new-password" disabled={clearPassword} placeholder={status?.settings.hasPassword ? '已保存，留空沿用原密码' : '需要身份验证时填写'} />
        </Form.Item>
        {status?.settings.hasPassword && (
          <Form.Item name="clearPassword" valuePropName="checked" preserve={false}>
            <Checkbox>清除已保存的密码</Checkbox>
          </Form.Item>
        )}
        <Space wrap align="start" size="large">
          <Form.Item name="enabled" label="自动同步" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="intervalMinutes" label="同步间隔（分钟）" rules={[{ required: true, type: 'integer', min: 1, max: 1440 }]}>
            <InputNumber min={1} max={1440} precision={0} />
          </Form.Item>
        </Space>
        <Space wrap>
          <Button type="primary" htmlType="submit" loading={action === 'save'}>保存设置</Button>
          <Button onClick={() => void configure('test')} loading={action === 'test'}>测试连接</Button>
          <Button onClick={() => void sync()} disabled={!status?.settings.url} loading={action === 'run' || synchronizing}>立即同步</Button>
        </Space>
      </Form>
      <Space direction="vertical" size="small" style={{ display: 'flex', marginTop: 12 }}>
        {synchronizing && <Alert type="info" showIcon message="正在检查并同步数据…" />}
        {status?.message && <Alert type={alertType} showIcon message={status.message} />}
        {status?.state === 'conflict' && status.conflict && (
          <Space wrap>
            <Popconfirm title="用本地数据替换 WebDAV 数据？" onConfirm={() => sync('local')}>
              <Button danger disabled={Boolean(action)}>保留本地</Button>
            </Popconfirm>
            {status.conflict.remote && (
              <Popconfirm title="用 WebDAV 数据替换本地数据？" description="应用会先创建本地恢复点。" onConfirm={() => sync('remote')}>
                <Button danger disabled={Boolean(action)}>保留 WebDAV</Button>
              </Popconfirm>
            )}
          </Space>
        )}
        {status?.lastSuccessAt && (
          <span className="muted-note">
            最近同步 {fmtDateTime(status.lastSuccessAt)}
            {status.transferredBlocks > 0 && `，传输了 ${status.transferredBlocks} 个数据块`}
          </span>
        )}
      </Space>
    </Card>
  )
}
