import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Upload,
} from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS } from '../../../shared/src/index.ts'
import { get, post } from '../api'

interface ProblemRow {
  id: number
  platform: PlatformId
  problem_key: string
  title: string
  difficulty: number | null
  url: string | null
  tags: string[]
  attempts: number
  ac_count: number
  last_ac_at: string | null
  status: 'ac' | 'tried' | 'none'
}

const DIFFICULTY_BUCKETS = ['<1200', '1200-1399', '1400-1599', '1600-1899', '1900-2199', '2200+', '未知']

function statusTag(s: ProblemRow['status']) {
  if (s === 'ac') return <Tag color="green">已 AC</Tag>
  if (s === 'tried') return <Tag color="orange">已尝试</Tag>
  return <Tag>未做</Tag>
}

export default function Problems() {
  const [rows, setRows] = useState<ProblemRow[]>([])
  const [loading, setLoading] = useState(false)
  const [platform, setPlatform] = useState<string>()
  const [difficulty, setDifficulty] = useState<string>()
  const [tag, setTag] = useState<string>()
  const [q, setQ] = useState<string>()
  const [importOpen, setImportOpen] = useState(false)
  const [manualForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (platform) params.set('platform', platform)
    if (difficulty) params.set('difficulty', difficulty)
    if (tag) params.set('tag', tag)
    if (q) params.set('q', q)
    get<ProblemRow[]>(`/api/problems?${params.toString()}`)
      .then(setRows)
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [platform, difficulty, tag, q])

  useEffect(() => {
    load()
  }, [load])

  const markAc = async (r: ProblemRow) => {
    try {
      await post('/api/import/manual', {
        platform: r.platform,
        rows: [
          {
            problemKey: r.problem_key,
            title: r.title,
            verdict: 'AC',
            difficulty: r.difficulty ?? undefined,
            tags: r.tags,
            url: r.url ?? undefined,
          },
        ],
      })
      message.success(`已标记 ${r.problem_key} 为 AC`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const uploadProps = {
    beforeUpload: (file: File) => {
      const reader = new FileReader()
      reader.onload = async () => {
        const text = String(reader.result ?? '')
        try {
          if (file.name.endsWith('.csv')) {
            await post('/api/import/csv', { platform, csv: text })
          } else {
            const rows = JSON.parse(text) as unknown[]
            await post('/api/import/manual', { platform, rows })
          }
          message.success('导入成功')
          setImportOpen(false)
          load()
        } catch (e) {
          message.error((e as Error).message)
        }
      }
      reader.readAsText(file)
      return false
    },
  }

  const cols: ColumnsType<ProblemRow> = [
    {
      title: '平台',
      dataIndex: 'platform',
      width: 90,
      render: (v: PlatformId) => PLATFORMS.find((p) => p.id === v)?.name ?? v,
    },
    {
      title: '题号',
      dataIndex: 'problem_key',
      width: 110,
      render: (v: string, r) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer">{v}</a> : v),
    },
    { title: '标题', dataIndex: 'title', ellipsis: true },
    { title: '难度', dataIndex: 'difficulty', width: 80, render: (v: number | null) => v ?? '-' },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 220,
      render: (tags: string[]) => (tags.length ? tags.slice(0, 4).map((t) => <Tag key={t}>{t}</Tag>) : '-'),
    },
    { title: '提交', dataIndex: 'attempts', width: 70 },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: ProblemRow['status']) => statusTag(v) },
    {
      title: '操作',
      width: 100,
      render: (_v, r) =>
        r.status === 'ac' ? null : (
          <Button size="small" onClick={() => markAc(r)}>
            标记 AC
          </Button>
        ),
    },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="平台"
          style={{ width: 130 }}
          value={platform}
          onChange={setPlatform}
          options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Select
          allowClear
          placeholder="难度区间"
          style={{ width: 140 }}
          value={difficulty}
          onChange={setDifficulty}
          options={DIFFICULTY_BUCKETS.map((b) => ({ value: b, label: b }))}
        />
        <Input placeholder="按标签筛选" style={{ width: 150 }} value={tag} onChange={(e) => setTag(e.target.value || undefined)} />
        <Input.Search placeholder="搜索题号/标题" style={{ width: 220 }} onSearch={(v) => setQ(v || undefined)} />
        <Button type="primary" onClick={() => setImportOpen(true)}>
          导入题目
        </Button>
      </Space>
      <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={rows} pagination={{ pageSize: 20 }} />

      <Modal title="导入刷题记录" open={importOpen} onCancel={() => setImportOpen(false)} footer={null} width={620}>
        <Tabs
          items={[
            {
              key: 'sync',
              label: '平台同步',
              children: <SyncTab onDone={() => { setImportOpen(false); load() }} />,
            },
            {
              key: 'file',
              label: '上传文件',
              children: (
                <div>
                  <p>选择平台后上传 JSON 数组或 CSV（表头：{['problemKey', 'title', 'verdict', 'difficulty', 'tags', 'url', 'submittedAt', 'language', 'externalId'].join(', ')}）。</p>
                  <Select placeholder="平台" style={{ width: 200, marginBottom: 12 }} value={platform} onChange={setPlatform} options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))} />
                  <Upload.Dragger {...uploadProps} multiple={false} showUploadList={false}>
                    <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                    <p className="ant-upload-text">点击或拖拽文件上传</p>
                  </Upload.Dragger>
                </div>
              ),
            },
            {
              key: 'form',
              label: '逐条录入',
              children: (
                <Form
                  form={manualForm}
                  layout="vertical"
                  onFinish={async (v) => {
                    try {
                      await post('/api/import/manual', {
                        platform: v.platform,
                        rows: [
                          {
                            problemKey: v.problemKey,
                            title: v.title,
                            verdict: v.verdict ?? 'AC',
                            difficulty: v.difficulty,
                            tags: v.tags ? String(v.tags).split('|').map((t) => t.trim()).filter(Boolean) : [],
                          },
                        ],
                      })
                      message.success('录入成功')
                      manualForm.resetFields()
                      setImportOpen(false)
                      load()
                    } catch (e) {
                      message.error((e as Error).message)
                    }
                  }}
                >
                  <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
                    <Select options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))} />
                  </Form.Item>
                  <Form.Item name="problemKey" label="题号（如 P1001 / 1919C）" rules={[{ required: true }]}>
                    <Input />
                  </Form.Item>
                  <Form.Item name="title" label="标题">
                    <Input />
                  </Form.Item>
                  <Form.Item name="verdict" label="结果" initialValue="AC">
                    <Select options={['AC', 'WA', 'TLE', 'RE', 'MLE', 'CE', 'SKIPPED'].map((v) => ({ value: v, label: v }))} />
                  </Form.Item>
                  <Form.Item name="difficulty" label="难度（数值）">
                    <InputNumber min={0} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item name="tags" label="标签（| 分隔）">
                    <Input placeholder="dp|图论" />
                  </Form.Item>
                  <Button type="primary" htmlType="submit">提交</Button>
                </Form>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  )
}

function SyncTab({ onDone }: { onDone: () => void }) {
  const [platform, setPlatform] = useState<PlatformId>('codeforces')
  const [handle, setHandle] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()

  const run = async () => {
    if (!handle.trim()) return
    setBusy(true)
    try {
      const r = await post<{ imported: number; skipped: number; errors: string[] }>(`/api/sync/${platform}`, { handle: handle.trim() })
      const parts = [`导入 ${r.imported} 条`, `去重 ${r.skipped} 条`]
      if (r.errors.length) parts.push(`提示：${r.errors.join('；')}`)
      setResult(parts.join('，'))
      if (r.imported > 0) onDone()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Space>
        <Select style={{ width: 140 }} value={platform} onChange={setPlatform} options={PLATFORMS.map((p) => ({ value: p.id, label: p.name }))} />
        <Input placeholder={platform === 'codeforces' ? 'CF handle' : '用户名 / uid'} value={handle} onChange={(e) => setHandle(e.target.value)} style={{ width: 200 }} />
        <Button type="primary" loading={busy} onClick={run}>同步</Button>
      </Space>
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
    </div>
  )
}
