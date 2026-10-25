import { useState } from 'react'
import {
  Alert,
  App as AntdApp,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Upload,
} from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { post } from '../../api'

/** 「导出提示词 → 手动喂给任意 AI → 导入」闭环的导入弹窗：粘贴/上传 AI 返回的 JSON 文本。 */
export function ImportPlanModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const v = (await form.validateFields().catch(() => null)) as {
      raw: string
      startDate: Dayjs
      days: number
    } | null
    if (!v) return
    setBusy(true)
    try {
      const r = await post<{ planId: number; title: string; taskCount: number }>('/api/plans/import', {
        raw: v.raw,
        startDate: v.startDate.format('YYYY-MM-DD'),
        days: v.days,
      })
      message.success(`已导入「${r.title}」（${r.taskCount} 个任务），到「训练计划」页查看`)
      form.resetFields()
      onClose()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="导入 AI 计划"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="导入"
      cancelText="取消"
      confirmLoading={busy}
      width={620}
      /* antd Modal 默认懒渲染：首次打开前这里的 <Form form={form}> 不挂载，而 form 实例
         已经由本组件的 Form.useForm() 创建 → 每次进设置页刷一条「未连接」告警。
         forceRender 让内容提前挂载（代价是设置页多一个隐藏表单），告警清零。 */
      forceRender
    >
      <Alert
        style={{ marginBottom: 12 }}
        type="info"
        showIcon
        message="把任意 AI 返回的计划 JSON 粘贴到下面（代码块围栏、前后解释文字均可，会自动清洗）；任务缺链接时自动按题库补链。"
      />
      <Form form={form} layout="vertical">
        <Form.Item
          name="raw"
          label="AI 返回的计划 JSON"
          rules={[{ required: true, message: '请粘贴 AI 返回的内容' }]}
        >
          <Input.TextArea
            rows={10}
            placeholder={'```json\n{\n  "title": "...",\n  "goal": "...",\n  "tasks": [{ "date": "YYYY-MM-DD", "title": "...", "kind": "practice", "url": "..." }]\n}\n```'}
          />
        </Form.Item>
        <Space size="large" wrap>
          <Form.Item
            name="startDate"
            label="计划开始日期（用于校验任务日期范围）"
            initialValue={dayjs()}
            rules={[{ required: true }]}
          >
            <DatePicker />
          </Form.Item>
          <Form.Item name="days" label="计划天数" initialValue={14} rules={[{ required: true }]}>
            <InputNumber min={1} max={90} />
          </Form.Item>
          <Form.Item label="或上传 .json / .md 文件">
            <Upload
              maxCount={1}
              showUploadList={false}
              beforeUpload={(file) => {
                const reader = new FileReader()
                reader.onload = () => form.setFieldsValue({ raw: String(reader.result ?? '') })
                reader.readAsText(file)
                return false // 阻止自动上传，仅读文件内容
              }}
            >
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  )
}
