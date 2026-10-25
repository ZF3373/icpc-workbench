import { useEffect, useState } from 'react'
import { App, Button, Card, Form, Input, Modal, Popconfirm, Space, Spin } from 'antd'
import type { AiCustomPrompt } from '../../../shared/src/index.ts'
import { get, post } from '../api'

export default function AiCustomPromptsCard() {
  const { message } = App.useApp()
  const [prompts, setPrompts] = useState<AiCustomPrompt[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [form] = Form.useForm<AiCustomPrompt>()
  const load = () => {
    void get<AiCustomPrompt[]>('/api/settings/ai/custom-prompts').then((value) => {
      setPrompts(value)
      setLoaded(true)
    }).catch((e: Error) => message.error(e.message))
  }
  useEffect(load, [message])

  const save = async (next: AiCustomPrompt[]) => {
    setBusy(true)
    try {
      setPrompts(await post<AiCustomPrompt[]>('/api/settings/ai/custom-prompts', { prompts: next }))
      message.success('自定义提示词已保存，下次发送消息时生效')
      return true
    } catch (e) {
      message.error((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  return <Card title="追加 AI 提示词" size="small" style={{ marginTop: 16 }}>
    <p className="muted-note">每次 AI 辅导时，按列表顺序合并全部提示词，与题目、训练信息一起发送，不显示在会话框中。</p>
    {!loaded ? <Space><Spin /><Button onClick={load}>重新加载</Button></Space> : <Space direction="vertical" style={{ width: '100%' }}>
      {prompts.map((prompt, index) => <div key={index} style={{ borderBottom: '1px solid var(--border-color, #d9d9d9)', paddingBottom: 12 }}>
        <Space wrap style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}><strong style={{ overflowWrap: 'anywhere' }}>{prompt.title}</strong><Space>
        <Button size="small" disabled={busy} onClick={() => { form.setFieldsValue(prompt); setEditing(index) }}>编辑</Button>
        <Popconfirm title="删除这条提示词？" onConfirm={() => save(prompts.filter((_, i) => i !== index)).then(() => {})}>
          <Button size="small" danger disabled={busy}>删除</Button>
        </Popconfirm>
      </Space></Space><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflowY: 'auto' }}>{prompt.content}</div></div>)}
      <Button disabled={busy || prompts.length >= 50} onClick={() => { form.resetFields(); setEditing(prompts.length) }}>添加提示词</Button>
    </Space>}
    <Modal title={editing === prompts.length ? '添加提示词' : '编辑提示词'} open={editing !== null} confirmLoading={busy}
      onCancel={() => { if (!busy) setEditing(null) }} onOk={async () => {
        const value = await form.validateFields().catch(() => null)
        if (!value || editing === null) return
        const next = [...prompts]
        next[editing] = value
        if (await save(next)) setEditing(null)
      }}>
      <Form form={form} layout="vertical">
        <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, max: 100 }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="content" label="提示词内容" rules={[{ required: true, whitespace: true, max: 20000 }]}><Input.TextArea rows={8} maxLength={20000} showCount /></Form.Item>
      </Form>
    </Modal>
  </Card>
}
