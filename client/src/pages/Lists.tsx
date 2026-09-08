import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd'
import {
  BulbOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  PlusOutlined,
  TagsOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import type { ColumnsType } from 'antd/es/table'
import type { PlatformId } from '../../../shared/src/index.ts'
import PageHeader from '../components/PageHeader'
import PlatformTag from '../components/PlatformTag'
import Markdown from '../components/Markdown'
import { del, get, patch, post } from '../api'
import { difficultyColor } from '../ui'

/**
 * 题单整理（issue #4）：导入平台题单（粘贴文本自动识别题号/链接），
 * 按知识点分类（题库 tags 规则 / AI / 手动），AI 读取题单内容给练习建议。
 */

interface ListItemRow {
  id: number
  title: string
  source_url: string | null
  created_at: string
  item_count: number
  category_count: number
  solved_count: number
}

interface ListItem {
  id: number
  platform: string
  problem_key: string
  title: string | null
  url: string | null
  category: string
  position: number
  difficulty: number | null
  tags: string[]
  solved: boolean
}

interface ListDetail {
  id: number
  title: string
  source_url: string | null
  created_at: string
  aiSuggestion: string | null
  aiSuggestionAt: string | null
  items: ListItem[]
}

export default function Lists() {
  const [lists, setLists] = useState<ListItemRow[]>([])
  const [loading, setLoading] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [detail, setDetail] = useState<ListDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // 正在进行的操作（classify/ai-classify/ai-suggest）
  const [suggest, setSuggest] = useState<string | null>(null) // AI 建议内容
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [importForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    get<ListItemRow[]>('/api/lists')
      .then(setLists)
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  const openDetail = async (id: number) => {
    setDetailLoading(true)
    setDetailOpen(true)
    try {
      const d = await get<ListDetail>(`/api/lists/${id}`)
      setDetail(d)
      // 从 DB 缓存恢复 AI 建议（有缓存则直接显示，无需重新调 AI）
      setSuggest(d.aiSuggestion)
    } catch (e) {
      message.error((e as Error).message)
      setDetailOpen(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const reloadDetail = () => detail && openDetail(detail.id)

  const submitImport = async () => {
    const v = (await importForm.validateFields().catch(() => null)) as unknown as {
      title: string
      sourceUrl?: string
      raw: string
    } | null
    if (!v) return
    setBusy('import')
    try {
      const r = await post<{ id: number; imported: number; unrecognized: number }>('/api/lists', {
        title: v.title,
        raw: v.raw,
        sourceUrl: v.sourceUrl || undefined,
      })
      message.success(
        `已导入 ${r.imported} 道题${r.unrecognized > 0 ? `（${r.unrecognized} 行未识别已跳过）` : ''}`,
      )
      importForm.resetFields()
      setImportOpen(false)
      load()
      void openDetail(r.id)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const runClassify = async (mode: 'rule' | 'ai') => {
    if (!detail) return
    setBusy(mode === 'rule' ? 'classify' : 'ai-classify')
    try {
      const r = await post<{ updated: number; total: number }>(`/api/lists/${detail.id}/${mode === 'rule' ? 'classify' : 'ai-classify'}`, {})
      message.success(mode === 'rule' ? `按题库分类完成：更新 ${r.updated}/${r.total} 道` : `AI 分类完成：更新 ${r.updated}/${r.total} 道`)
      reloadDetail()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const runSuggest = async (force = false) => {
    if (!detail) return
    // 有缓存且非强制刷新：直接打开 Modal 显示缓存内容，不重新请求
    if (!force && suggest) {
      setSuggestOpen(true)
      return
    }
    setBusy('ai-suggest')
    setSuggestOpen(true)
    setSuggest(null)
    try {
      const r = await post<{ reply: string; cached?: boolean; cachedAt?: string }>(
        `/api/lists/${detail.id}/ai-suggest`,
        force ? { force: true } : {},
      )
      setSuggest(r.reply)
    } catch (e) {
      if (!force) setSuggestOpen(false)
      message.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const removeList = async (id: number) => {
    try {
      await del(`/api/lists/${id}`)
      message.success('题单已删除')
      if (detail?.id === id) setDetailOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const changeCategory = async (itemId: number, category: string) => {
    try {
      await patch(`/api/lists/items/${itemId}`, { category })
      reloadDetail()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeItem = async (itemId: number) => {
    try {
      await del(`/api/lists/items/${itemId}`)
      reloadDetail()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const cols: ColumnsType<ListItemRow> = [
    { title: '题单', dataIndex: 'title', render: (v: string, r) => <a onClick={() => openDetail(r.id)}>{v}</a> },
    {
      title: '来源',
      dataIndex: 'source_url',
      width: 140,
      render: (v: string | null) =>
        v ? (
          <a href={v} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
            链接 ↗
          </a>
        ) : (
          <span style={{ color: '#8993a2' }}>粘贴导入</span>
        ),
    },
    { title: '题目', dataIndex: 'item_count', width: 70, align: 'right', render: (v: number) => <span className="mono">{v}</span> },
    { title: '分类', dataIndex: 'category_count', width: 70, align: 'right', render: (v: number) => <span className="mono">{v}</span> },
    {
      title: '已完成',
      width: 90,
      align: 'right',
      render: (_v, r) => (
        <span className="mono">
          {r.solved_count}/{r.item_count}
        </span>
      ),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 110, render: (v: string) => <span className="mono">{dayjs(v).format('YYYY-MM-DD')}</span> },
    {
      title: '操作',
      width: 130,
      render: (_v, r) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => openDetail(r.id)}>
            详情
          </Button>
          <Popconfirm title="删除题单" description="将删除题单及其全部条目" okText="删除" cancelText="取消" onConfirm={() => removeList(r.id)}>
            <Button size="small" danger type="link">
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // 按分类分组（保持 position 顺序）
  const groups: Array<{ category: string; items: ListItem[] }> = []
  if (detail) {
    for (const it of detail.items) {
      const last = groups[groups.length - 1]
      if (last && last.category === it.category) last.items.push(it)
      else groups.push({ category: it.category, items: [it] })
    }
  }

  return (
    <div>
      <PageHeader
        title="题单整理"
        description="导入平台题单（支持洛谷 / Codeforces / AtCoder / 代码源 / 牛客的题号或链接，每行一题），按知识点分类；AI 可读取题单内容结合你的弱项给出练习建议。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            导入题单
          </Button>
        }
      />
      <Table rowKey="id" size="small" loading={loading} columns={cols} dataSource={lists} pagination={{ pageSize: 10 }} />
      {!loading && lists.length === 0 && (
        <Card style={{ marginTop: 16 }}>
          <Empty description="暂无题单 —— 点击「导入题单」粘贴平台题单开始" style={{ padding: '24px 0' }} />
        </Card>
      )}

      <Drawer
        title={detail?.title}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        width={720}
        extra={
          <Space wrap>
            <Button size="small" icon={<TagsOutlined />} loading={busy === 'classify'} onClick={() => void runClassify('rule')}>
              按题库分类
            </Button>
            <Button size="small" icon={<ExperimentOutlined />} loading={busy === 'ai-classify'} onClick={() => void runClassify('ai')}>
              AI 分类
            </Button>
            <Button size="small" type="primary" ghost icon={<BulbOutlined />} loading={busy === 'ai-suggest'} onClick={() => void runSuggest()}>
              AI 建议
            </Button>
          </Space>
        }
      >
        {detailLoading && <Spin style={{ display: 'block', margin: '40px auto' }} />}
        {!detailLoading && detail && (
          <>
            <p style={{ color: '#8993a2', fontSize: 12, marginBottom: 12 }}>
              共 {detail.items.length} 题 · 已完成 {detail.items.filter((i) => i.solved).length} 题；
              「按题库分类」依据已同步题库的标签，覆盖不到的用「AI 分类」或手动调整。
            </p>
            {groups.map((g) => (
              <div key={g.category} style={{ marginBottom: 16 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>
                  <Tag color="geekblue">{g.category}</Tag>
                  <span style={{ color: '#8993a2', fontSize: 12 }}>{g.items.length} 题</span>
                </div>
                {g.items.map((it) => {
                  const link = it.url
                  return (
                    <div key={it.id} className="list-item-row" style={{ opacity: it.solved ? 0.55 : 1 }}>
                      <Space size={8} wrap style={{ flex: 1 }}>
                        <PlatformTag id={it.platform as PlatformId} />
                        {link ? (
                          <a href={link} target="_blank" rel="noreferrer">
                            <b>{it.title ?? it.problem_key}</b>
                          </a>
                        ) : (
                          <b>{it.title ?? it.problem_key}</b>
                        )}
                        <span className="mono" style={{ fontSize: 12, color: '#8993a2' }}>
                          {it.problem_key}
                        </span>
                        {it.difficulty !== null && (
                          <span className="mono" style={{ fontSize: 12, color: difficultyColor(it.difficulty) }}>
                            {it.difficulty}
                          </span>
                        )}
                        {it.solved && <Tag color="success">已AC</Tag>}
                      </Space>
                      <Space size={4}>
                        <Select
                          size="small"
                          style={{ minWidth: 110 }}
                          value={it.category}
                          showSearch
                          onChange={(v) => void changeCategory(it.id, v)}
                          options={[...new Set([...groups.map((x) => x.category), '其他'])].map((c) => ({ value: c, label: c }))}
                        />
                        <Popconfirm title="移除该题" okText="移除" cancelText="取消" onConfirm={() => void removeItem(it.id)}>
                          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    </div>
                  )
                })}
              </div>
            ))}
          </>
        )}
      </Drawer>

      <Modal
        title="导入题单"
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onOk={submitImport}
        okText="导入"
        cancelText="取消"
        confirmLoading={busy === 'import'}
        width={640}
      >
        <Form form={importForm} layout="vertical">
          <Form.Item name="title" label="题单名称" rules={[{ required: true, message: '必填' }]}>
            <Input placeholder="如：二分专题 20 题" />
          </Form.Item>
          <Form.Item name="sourceUrl" label="来源链接（可选）">
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item
            name="raw"
            label="题目列表（每行一题）"
            rules={[{ required: true, message: '请粘贴题目列表' }]}
          >
            <Input.TextArea
              rows={10}
              placeholder={
                '支持题号或链接，自动识别平台：\nP1001 A+B Problem\nhttps://www.luogu.com.cn/problem/P1001\nCF1234A\nhttps://codeforces.com/contest/1234/problem/A\nabc300_a\nhttps://bs.daimayuan.top/p/7'
              }
            />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="从平台题单页全选复制粘贴即可；无法识别的行会自动跳过并在导入结果中提示。"
          />
        </Form>
      </Modal>

      <Modal
        title="AI 练习建议"
        open={suggestOpen}
        onCancel={() => setSuggestOpen(false)}
        footer={
          suggest ? (
            <Button
              size="small"
              loading={busy === 'ai-suggest'}
              onClick={() => void runSuggest(true)}
            >
              重新生成
            </Button>
          ) : null
        }
        width={640}
      >
        {suggest === null ? (
          <Spin style={{ display: 'block', margin: '32px auto' }} tip="AI 正在结合你的练习数据分析题单…" />
        ) : (
          <>
            <Markdown text={suggest} />
            {detail?.aiSuggestionAt && (
              <p style={{ color: '#8993a2', fontSize: 12, marginTop: 12, textAlign: 'right' }}>
                生成于 {new Date(detail.aiSuggestionAt + 'Z').toLocaleString('zh-CN')}
              </p>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}
