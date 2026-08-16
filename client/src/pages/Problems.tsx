import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Card,
  Checkbox,
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
import { ClearOutlined, CloudDownloadOutlined, InboxOutlined, PlusOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { PlatformId } from '../../../shared/src/index.ts'
import { PLATFORMS } from '../../../shared/src/index.ts'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import { difficultyColor } from '../ui'
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
  if (s === 'ac') return <Tag className="dot-tag" color="success">已 AC</Tag>
  if (s === 'tried') return <Tag className="dot-tag" color="warning">已尝试</Tag>
  return <Tag className="dot-tag">未做</Tag>
}

export default function Problems() {
  const [rows, setRows] = useState<ProblemRow[]>([])
  const [loading, setLoading] = useState(false)
  const [platform, setPlatform] = useState<string>()
  const [difficulty, setDifficulty] = useState<string>()
  const [tag, setTag] = useState<string>()
  const [q, setQ] = useState<string>()
  const [qInput, setQInput] = useState('')
  const [includeBank, setIncludeBank] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [manualForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (platform) params.set('platform', platform)
    if (difficulty) params.set('difficulty', difficulty)
    if (tag) params.set('tag', tag)
    if (q) params.set('q', q)
    if (includeBank) params.set('bank', '1')
    get<ProblemRow[]>(`/api/problems?${params.toString()}`)
      .then(setRows)
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [platform, difficulty, tag, q, includeBank])

  useEffect(() => {
    load()
  }, [load])

  const resetFilters = () => {
    setPlatform(undefined)
    setDifficulty(undefined)
    setTag(undefined)
    setQ(undefined)
    setQInput('')
    setIncludeBank(false)
  }

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
      if (!platform) {
        message.warning('请先选择平台')
        return false
      }
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
      width: 110,
      render: (v: PlatformId) => <PlatformTag id={v} />,
    },
    {
      title: '题号',
      dataIndex: 'problem_key',
      width: 120,
      render: (v: string, r) => (r.url ? <a className="mono" href={r.url} target="_blank" rel="noreferrer">{v}</a> : <span className="mono">{v}</span>),
    },
    {
      title: '标题',
      dataIndex: 'title',
      ellipsis: true,
      render: (v: string, r) => (r.url ? <a href={r.url} target="_blank" rel="noreferrer">{v}</a> : v),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 80,
      align: 'right',
      render: (v: number | null) =>
        v == null ? <span style={{ color: '#c0c0cc' }}>-</span> : (
          <span className="mono" style={{ color: difficultyColor(v), fontWeight: 600 }}>{v}</span>
        ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 230,
      render: (tags: string[]) =>
        tags.length ? (
          <Space size={4} wrap>
            {tags.slice(0, 3).map((t) => (
              <Tag key={t}>{t}</Tag>
            ))}
            {tags.length > 3 && <span className="tag-more">+{tags.length - 3}</span>}
          </Space>
        ) : (
          <span style={{ color: '#c0c0cc' }}>-</span>
        ),
    },
    { title: '提交', dataIndex: 'attempts', width: 70, align: 'right' },
    { title: '状态', dataIndex: 'status', width: 100, render: (v: ProblemRow['status']) => statusTag(v) },
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
      <PageHeader
        title="题目管理"
        description="管理和导入你在各平台的刷题记录"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            导入题目
          </Button>
        }
      />
      <Card size="small" className="filter-bar" style={{ marginBottom: 16 }}>
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
        <Input
          allowClear
          placeholder="按标签筛选"
          style={{ width: 150 }}
          value={tag}
          onChange={(e) => setTag(e.target.value || undefined)}
        />
        <Input.Search
          allowClear
          placeholder="搜索题号/标题"
          style={{ width: 220 }}
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          onSearch={(v) => setQ(v || undefined)}
        />
        <Button icon={<ClearOutlined />} onClick={resetFilters}>
          重置
        </Button>
        <Checkbox checked={includeBank} onChange={(e) => setIncludeBank(e.target.checked)}>
          含题库未做题
        </Checkbox>
        <span className="filter-count">共 {rows.length} 题</span>
      </Card>
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
              key: 'bank',
              label: '拉取题库',
              children: <BankTab onDone={() => { setImportOpen(false); load() }} />,
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

const LUOGU_DIFFICULTY_OPTIONS = [
  { value: 2, label: '普及- 及以上（含入门水题）' },
  { value: 3, label: '普及/提高- 及以上（推荐）' },
  { value: 4, label: '普及+/提高 及以上' },
  { value: 5, label: '提高+/省选- 及以上' },
  { value: 6, label: '省选/NOI- 及以上' },
]

/** 「拉取题库」页签：从洛谷/牛客公开题库批量入库，扩充训练计划待选题池（无需账号）。 */
function BankTab({ onDone }: { onDone: () => void }) {
  const [platform, setPlatform] = useState<'luogu' | 'nowcoder'>('luogu')
  const [max, setMax] = useState(1000)
  const [luoguMin, setLuoguMin] = useState(3)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()

  const run = async () => {
    setBusy(true)
    setResult(undefined)
    try {
      const r = await post<{
        ok: boolean; platform: string; total: number | null; fetched: number; inserted: number; updated: number
      }>('/api/problems/bank', {
        platform,
        max,
        ...(platform === 'luogu' ? { luoguMinDifficulty: luoguMin } : {}),
      })
      const totalPart = r.total ? `（题库共 ${r.total} 题）` : ''
      setResult(`拉取 ${r.fetched} 题${totalPart}：新增 ${r.inserted}，更新 ${r.updated}`)
      message.success(`${platform === 'luogu' ? '洛谷' : '牛客'}题库已入库，训练计划选题池已扩充`)
      onDone()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p style={{ color: '#8c8c9e' }}>
        从洛谷 / 牛客公开题库批量拉取题目入库，扩充训练计划的待选题池（无需账号/Cookie，不影响刷题统计）。
        拉取量越大耗时越长（约 1-2 分钟/千题），请耐心等待。
      </p>
      <Space wrap>
        <Select
          style={{ width: 120 }}
          value={platform}
          onChange={(v) => setPlatform(v)}
          options={[
            { value: 'luogu' as const, label: '洛谷' },
            { value: 'nowcoder' as const, label: '牛客' },
          ]}
        />
        <InputNumber min={50} max={5000} step={50} value={max} onChange={(v) => setMax(v ?? 1000)} addonAfter="题" style={{ width: 140 }} />
        <Button type="primary" icon={<CloudDownloadOutlined />} loading={busy} onClick={run}>
          拉取题库
        </Button>
      </Space>
      {platform === 'luogu' && (
        <div style={{ marginTop: 12 }}>
          <Select
            style={{ width: 300 }}
            value={luoguMin}
            onChange={setLuoguMin}
            options={LUOGU_DIFFICULTY_OPTIONS}
          />
        </div>
      )}
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
      <BackfillDifficultyCard />
    </div>
  )
}

/** 「拉取题库」页签内的难度回填区块：对库内未知难度的洛谷/牛客题逐题查询公开接口补全。 */
function BackfillDifficultyCard() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string>()

  const run = async () => {
    setBusy(true)
    setResult(undefined)
    try {
      const r = await post<{
        ok: boolean
        results: Array<{ platform: string; scanned: number; filled: number; repaired: number; missing: number; failed: number }>
        unknownLeft: number
      }>('/api/problems/backfill-difficulty', {})
      const parts = r.results.map((x) => {
        const name = x.platform === 'nowcoder' ? '牛客' : x.platform === 'luogu' ? '洛谷' : x.platform
        return `${name}：补难度 ${x.filled} 题、修标题/标签 ${x.repaired} 题${x.missing ? `、官方无难度 ${x.missing} 题` : ''}${x.failed ? `、失败 ${x.failed} 题` : ''}`
      })
      setResult(parts.length ? parts.join('；') + `。全库剩余未知难度 ${r.unknownLeft} 题` : '库内没有待补难度的洛谷/牛客题')
      message.success('难度回填完成')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <p style={{ color: '#8c8c9e' }}>
        补全库内「未知难度」的洛谷/牛客题（逐题查询官方接口，牛客约 0.5 秒/题，请耐心等待）；
        牛客同时修复历史遗留的标题混入标签问题。Codeforces 未知难度来自 gym 与官方 Unrated 比赛，无公开难度可补。
      </p>
      <Button loading={busy} onClick={run}>一键回填未知难度</Button>
      {result && <p style={{ marginTop: 12 }}>{result}</p>}
    </div>
  )
}
