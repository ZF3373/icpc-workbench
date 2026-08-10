import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  message,
  Row,
  Col,
  Space,
  Spin,
  Switch,
} from 'antd'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS } from '../../../shared/src/index.ts'
import { get, post } from '../api'

interface SettingsData {
  ai: { enabled: boolean; baseURL: string; apiKey: string; model: string }
  accounts: Array<{ platform: PlatformId; handle: string; last_sync_at: string | null; enabled: number }>
  adapterEnabled: Record<string, boolean>
  platforms: typeof PLATFORMS
}

export default function Settings() {
  const [data, setData] = useState<SettingsData | null>(null)
  const [aiForm] = Form.useForm()
  const [handleInputs, setHandleInputs] = useState<Record<string, string>>({})

  const load = () => {
    get<SettingsData>('/api/settings')
      .then((d) => {
        setData(d)
        aiForm.setFieldsValue(d.ai)
        const handles: Record<string, string> = {}
        for (const a of d.accounts) handles[a.platform] = a.handle
        setHandleInputs(handles)
      })
      .catch((e: Error) => message.error(e.message))
  }

  useEffect(load, [aiForm])

  if (!data) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />

  const saveAi = async () => {
    const v = await aiForm.validateFields().catch(() => null)
    if (!v) return
    try {
      await post('/api/settings/ai', v)
      message.success('AI 配置已保存')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const bindAccount = async (platform: PlatformId) => {
    const handle = handleInputs[platform]?.trim()
    if (!handle) {
      message.warning('请先填写用户名')
      return
    }
    try {
      await post('/api/settings/accounts', { platform, handle })
      message.success(`${PLATFORMS.find((p) => p.id === platform)?.name} 已绑定`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const toggleAdapter = async (platform: PlatformId, enabled: boolean) => {
    try {
      await post('/api/settings/adapters', { platform, enabled })
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Row gutter={[16, 16]}>
      <Col span={12}>
        <Card title="AI 配置（OpenAI 兼容接口）" size="small">
          <Form form={aiForm} layout="vertical">
            <Form.Item name="enabled" label="启用 AI 生成" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="baseURL" label="Base URL" rules={[{ required: true, message: '必填' }]}>
              <Input placeholder="https://api.deepseek.com/v1" />
            </Form.Item>
            <Form.Item name="apiKey" label="API Key">
              <Input.Password placeholder="留空则不填（可用环境变量 AI_API_KEY）" />
            </Form.Item>
            <Form.Item name="model" label="模型">
              <Input placeholder="deepseek-chat / gpt-4o-mini / qwen-plus" />
            </Form.Item>
            <Button type="primary" onClick={saveAi}>
              保存 AI 配置
            </Button>
          </Form>
        </Card>
      </Col>
      <Col span={12}>
        <Card title="平台账号与适配器" size="small">
          {data.platforms.map((p) => {
            const account = data.accounts.find((a) => a.platform === p.id)
            const enabled = data.adapterEnabled[p.id] !== false
            return (
              <div key={p.id} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #f0f0f0' }}>
                <Space wrap>
                  <b style={{ width: 70, display: 'inline-block' }}>{p.name}</b>
                  <Input
                    placeholder={p.id === 'codeforces' ? 'CF handle' : '用户名 / uid'}
                    style={{ width: 180 }}
                    value={handleInputs[p.id] ?? ''}
                    onChange={(e) => setHandleInputs((s) => ({ ...s, [p.id]: e.target.value }))}
                  />
                  <Button onClick={() => bindAccount(p.id)} disabled={!account}>
                    保存
                  </Button>
                  {account && (
                    <span style={{ color: '#888', fontSize: 12 }}>
                      已绑定 {account.handle}
                      {p.hasOfficialApi === false && '（无公开 API，需手动导入）'}
                    </span>
                  )}
                </Space>
                <div style={{ marginTop: 6 }}>
                  <Space>
                    <span style={{ fontSize: 12, color: '#888' }}>自动同步</span>
                    <Switch
                      size="small"
                      checked={enabled}
                      onChange={(v) => toggleAdapter(p.id, v)}
                    />
                  </Space>
                </div>
              </div>
            )
          })}
          <p style={{ color: '#999', fontSize: 12 }}>
            说明：Codeforces / AtCoder 支持自动同步；洛谷 / 牛客无公开 API，请在「题目管理」中手动导入。
          </p>
        </Card>
      </Col>
      <Col span={24}>
        <Card title="导出提示词（手动喂给任意 AI）" size="small">
          <Space wrap>
            <InputNumber min={1} max={90} defaultValue={14} id="export-days" />
            <Button
              onClick={async () => {
                const days = (document.getElementById('export-days') as HTMLInputElement | null)?.value || '14'
                try {
                  const url = `/api/export/plan-prompt.md?days=${days}`
                  const res = await fetch(url)
                  const text = await res.text()
                  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
                  const a = document.createElement('a')
                  a.href = URL.createObjectURL(blob)
                  a.download = 'plan-prompt.md'
                  a.click()
                  URL.revokeObjectURL(a.href)
                } catch (e) {
                  message.error((e as Error).message)
                }
              }}
            >
              下载提示词 .md
            </Button>
            <span style={{ color: '#888', fontSize: 12 }}>
              下载后把内容粘贴给任何 AI，把返回的 JSON 计划通过「题目管理 → 逐条录入」或后续手动导入生成计划。
            </span>
          </Space>
        </Card>
      </Col>
    </Row>
  )
}
