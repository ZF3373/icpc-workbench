import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
} from 'antd'
import {
  BookOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  FieldTimeOutlined,
  ImportOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RightOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import PageHeader from '../components/PageHeader'
import StatStrip from '../components/StatStrip'
import Markdown from '../components/Markdown'
import CodeEditor from '../components/CodeEditor'
import { tagColor } from '../ui'
import { del, get, patch, post, put } from '../api'
import type { TemplateContentInfo, TemplateExampleInfo, TemplateItemInfo, TemplatesResponse, TemplateStatus } from '../types'

const STATUS_META: Array<{ key: TemplateStatus; label: string; icon: typeof CheckCircleOutlined }> = [
  { key: 'todo', label: '未学', icon: PlayCircleOutlined },
  { key: 'learning', label: '学习中', icon: FieldTimeOutlined },
  { key: 'mastered', label: '已掌握', icon: CheckCircleOutlined },
]

interface CustomFormValues {
  categoryKey: string
  name: string
  difficulty: number
  tags?: string[]
  complexity?: string
  url?: string
  idea?: string
  code?: string
}

/** 模板条目的有效内容：自建模板用自身字段，内置条目用用户写入的 content */
function contentOf(t: TemplateItemInfo): TemplateContentInfo {
  if (t.custom) {
    return { code: t.code || null, idea: t.idea || null, complexity: t.complexity || null, url: t.url || null }
  }
  return t.content ?? { code: null, idea: null, complexity: null, url: null }
}

export default function Templates() {
  const [data, setData] = useState<TemplatesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeCat, setActiveCat] = useState<string>()
  const [expanded, setExpanded] = useState<string>()
  const [noteDraft, setNoteDraft] = useState('')
  const [noteEditing, setNoteEditing] = useState<TemplateItemInfo | null>(null)
  const [customOpen, setCustomOpen] = useState(false)
  const [editingCustom, setEditingCustom] = useState<TemplateItemInfo | null>(null)
  const [customForm] = Form.useForm<CustomFormValues>()
  const [contentEditing, setContentEditing] = useState<TemplateItemInfo | null>(null)
  const [contentDraft, setContentDraft] = useState<TemplateContentInfo>({ code: '', idea: '', complexity: '', url: '' })
  const [syncingId, setSyncingId] = useState<string>()

  const load = useCallback(() => {
    setLoading(true)
    get<TemplatesResponse>('/api/templates')
      .then(setData)
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 首次加载后默认选中第一个分类
  useEffect(() => {
    if (!activeCat && data?.categories.length) setActiveCat(data.categories[0].key)
  }, [data, activeCat])

  const setStatus = async (t: TemplateItemInfo, status: TemplateStatus) => {
    try {
      await post(`/api/templates/${t.id}/status`, { status })
      message.success(status === 'mastered' ? `「${t.name}」已掌握 🎉` : '学习状态已更新')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const saveNote = async () => {
    if (!noteEditing) return
    try {
      await patch(`/api/templates/${noteEditing.id}/note`, { note: noteDraft })
      message.success('笔记已保存')
      setNoteEditing(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const jumpNext = () => {
    if (!data?.next) return
    for (const cat of data.categories) {
      const found = cat.templates.find((t) => t.id === data.next!.id)
      if (found) {
        setActiveCat(cat.key)
        setExpanded(found.id)
        return
      }
    }
  }

  // ---------- 自建模板 ----------

  const openCreate = (categoryKey?: string) => {
    setEditingCustom(null)
    customForm.resetFields()
    customForm.setFieldsValue({
      categoryKey: categoryKey ?? activeCat ?? 'basic',
      difficulty: 3,
    })
    setCustomOpen(true)
  }

  const openEdit = (t: TemplateItemInfo) => {
    setEditingCustom(t)
    customForm.setFieldsValue({
      categoryKey: activeCat,
      name: t.name,
      difficulty: t.difficulty,
      tags: t.tags,
      complexity: t.complexity || undefined,
      url: t.url || undefined,
      idea: t.idea || undefined,
      code: t.code,
    })
    setCustomOpen(true)
  }

  const submitCustom = async () => {
    const v = await customForm.validateFields().catch(() => null)
    if (!v) return
    try {
      if (editingCustom) {
        const dbId = editingCustom.id.slice(2)
        await patch(`/api/templates/custom/${dbId}`, v)
        message.success('模板已更新')
      } else {
        await post('/api/templates/custom', v)
        message.success(`「${v.name}」已加入模板库`)
      }
      setCustomOpen(false)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const removeCustom = async (t: TemplateItemInfo) => {
    try {
      await del(`/api/templates/custom/${t.id.slice(2)}`)
      message.success('已删除自建模板')
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // ---------- 例题练习 ----------

  const collectExample = async (t: TemplateItemInfo, ex: TemplateExampleInfo) => {
    try {
      await post('/api/templates/examples/collect', {
        platform: ex.platform,
        key: ex.key,
        title: ex.title,
        url: ex.url,
        tags: t.tags,
      })
      message.success(`「${ex.key}」已入库，可到「题目管理」追踪 AC 状态`)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  // 例题写完后一键同步：按例题涉及平台拉取最新提交，刷新 AC 状态
  const syncExamples = async (t: TemplateItemInfo) => {
    setSyncingId(t.id)
    try {
      const { results } = await post<{ results: Array<{ imported: number; errors: string[] }> }>(
        '/api/templates/examples/sync',
        { templateId: t.id },
      )
      const errors = results.flatMap((r) => r.errors)
      const imported = results.reduce((sum, r) => sum + r.imported, 0)
      if (errors.length) {
        message.warning(`部分平台未同步成功：${errors.join('；')}`)
      } else if (imported > 0) {
        message.success(`同步完成，新增 ${imported} 条提交记录`)
      } else {
        message.success('已是最新，例题暂无新提交')
      }
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSyncingId(undefined)
    }
  }

  // ---------- 内置条目：写入自己的模板内容 ----------

  const openContentEditor = (t: TemplateItemInfo) => {
    setContentEditing(t)
    setContentDraft({ ...(contentOf(t) as Required<TemplateContentInfo>) })
  }

  const submitContent = async () => {
    if (!contentEditing) return
    try {
      await put(`/api/templates/${contentEditing.id}/content`, {
        code: contentDraft.code ?? '',
        idea: contentDraft.idea ?? '',
        complexity: contentDraft.complexity ?? '',
        url: contentDraft.url ?? '',
      })
      message.success(`「${contentEditing.name}」的模板已保存`)
      setContentEditing(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const cat = useMemo(() => data?.categories.find((c) => c.key === activeCat), [data, activeCat])

  if (loading && !data) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />
  if (!data) return <Empty description="模板课程加载失败" />

  return (
    <div>
      <PageHeader
        title="模板库"
        description="系统学习竞赛算法模板 —— 支持自建模板与例题实战追踪"
        extra={
          <Space>
            {data.next && (
              <Tooltip title={`难度 ${data.next.difficulty}/5`}>
                <Button type="primary" icon={<RightOutlined />} onClick={jumpNext}>
                  下一课：{data.next.name}
                </Button>
              </Tooltip>
            )}
            <Button icon={<PlusOutlined />} onClick={() => openCreate()}>
              新建模板
            </Button>
          </Space>
        }
      />

      <StatStrip
        items={[
          {
            label: '课程模板',
            value: (
              <>
                {data.mastered}
                <span className="stat-suffix">/ {data.total} 已掌握</span>
              </>
            ),
            icon: <CodeOutlined />,
            tone: 'violet',
          },
          {
            label: '学习中',
            value: data.learning,
            icon: <FieldTimeOutlined />,
            tone: 'amber',
          },
          {
            label: '自建模板',
            value: (
              <>
                {data.customCount}
                <span className="stat-suffix">个</span>
              </>
            ),
            icon: <EditOutlined />,
            tone: 'green',
          },
          {
            label: '下一课',
            value: data.next?.name ?? '已全部完成',
            icon: <RightOutlined />,
            tone: 'blue',
          },
        ]}
      />

      <div className="workbench" style={{ marginTop: 16, gridTemplateColumns: '190px minmax(0, 1fr)' }}>
        {/* 左栏：分类导航 + 进度 */}
        <aside className="taxonomy-panel">
          <div className="section-label">课程分类</div>
          <div className="taxonomy-list">
            {data.categories.map((c) => {
              const mastered = c.templates.filter((t) => t.status === 'mastered').length
              return (
                <button
                  key={c.key}
                  type="button"
                  className={`taxonomy-item${activeCat === c.key ? ' is-active' : ''}`}
                  onClick={() => {
                    setActiveCat(c.key)
                    setExpanded(undefined)
                  }}
                >
                  <span className="taxonomy-item__marker" style={{ background: tagColor(c.key) }} />
                  <span className="taxonomy-item__name">{c.name}</span>
                  <span className="taxonomy-item__count">
                    {mastered}/{c.templates.length}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="taxonomy-footer">
            <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => openCreate()}>
              新建模板
            </Button>
          </div>
        </aside>

        {/* 右栏：当前分类模板列表 */}
        <section>
          {cat && (
            <>
              <p className="band-desc" style={{ marginBottom: 10 }}>
                {cat.description}
              </p>
              {cat.templates.length === 0 ? (
                <Card>
                  <Empty description="该分类暂无模板 —— 点击「新建模板」添加自己的积累" />
                </Card>
              ) : (
                cat.templates.map((t, idx) => {
                  const open = expanded === t.id
                  const acCount = t.examples.filter((ex) => ex.ac).length
                  const content = contentOf(t)
                  const hasContent = !!(content.code?.trim() || content.idea?.trim())
                  return (
                    <Card
                      key={t.id}
                      size="small"
                      className={`template-card${t.status === 'mastered' ? ' template-mastered' : ''}`}
                      style={{ marginBottom: 10 }}
                      title={
                        <span className="today-problem-head">
                          <span className="mono template-ordinal">{String(idx + 1).padStart(2, '0')}</span>
                          <span
                            className="today-problem-title"
                            role="button"
                            tabIndex={0}
                            onClick={() => setExpanded(open ? undefined : t.id)}
                            onKeyDown={(e) => e.key === 'Enter' && setExpanded(open ? undefined : t.id)}
                          >
                            {t.name}
                          </span>
                          <span className="template-stars" title={`难度 ${t.difficulty}/5`}>
                            {'★'.repeat(t.difficulty)}
                          </span>
                          {t.custom && <Tag color="geekblue">自建</Tag>}
                          {t.status === 'mastered' && (
                            <Tag color="success" className="dot-tag">
                              已掌握
                            </Tag>
                          )}
                          {t.status === 'learning' && (
                            <Tag color="processing" className="dot-tag">
                              学习中
                            </Tag>
                          )}
                        </span>
                      }
                      extra={
                        <Space size={0}>
                          {!t.custom && (
                            <Button size="small" type="text" icon={<EditOutlined />} title="写入 / 编辑我的模板" onClick={() => openContentEditor(t)}>
                              {hasContent ? '编辑' : '写入'}
                            </Button>
                          )}
                          {t.custom && (
                            <>
                              <Button size="small" type="text" icon={<EditOutlined />} title="编辑模板" onClick={() => openEdit(t)} />
                              <Popconfirm title="删除该自建模板？" okText="删除" cancelText="取消" onConfirm={() => removeCustom(t)}>
                                <Button size="small" type="text" danger icon={<DeleteOutlined />} title="删除模板" />
                              </Popconfirm>
                            </>
                          )}
                          <Button size="small" type="text" onClick={() => setExpanded(open ? undefined : t.id)}>
                            {open ? '收起' : '展开'}
                          </Button>
                        </Space>
                      }
                    >
                      {!open ? (
                        <div className="template-brief">
                          {t.tags.slice(0, 4).map((tag) => (
                            <Tag key={tag} color={tagColor(tag)}>
                              {tag}
                            </Tag>
                          ))}
                          {t.examples.length > 0 && (
                            <Tag className={acCount > 0 ? 'template-brief-ac' : undefined}>
                              例题 {acCount > 0 ? `${acCount}/${t.examples.length} AC` : t.examples.length}
                            </Tag>
                          )}
                          {!t.custom && !hasContent && <Tag color="warning">待写入</Tag>}
                          <span className="template-brief-text">
                            {(t.custom ? t.idea : (t.outline ?? '')).slice(0, 70)}…
                          </span>
                        </div>
                      ) : (
                        <div className="template-detail">
                          {!t.custom && (
                            <div className="template-section">
                              <div className="section-label">大纲要点</div>
                              <p className="template-text">{t.outline}</p>
                            </div>
                          )}

                          {hasContent ? (
                            <>
                              <div className="template-meta-row">
                                {content.complexity && <span className="template-chip">{content.complexity}</span>}
                                {content.url && (
                                  <a href={content.url} target="_blank" rel="noreferrer" className="template-example">
                                    <LinkOutlined /> {t.custom ? '模板出处' : '我的参考链接'} ↗
                                  </a>
                                )}
                              </div>

                              {content.idea && (
                                <div className="template-section">
                                  <div className="section-label">{t.custom ? '思路与备注' : '我的思路'}</div>
                                  <Markdown text={content.idea} />
                                </div>
                              )}

                              {content.code && (
                                <div className="template-section">
                                  <div className="section-label">
                                    {t.custom ? '模板代码' : '我的模板'}
                                    <Button
                                      size="small"
                                      type="text"
                                      onClick={() => {
                                        navigator.clipboard
                                          ?.writeText(content.code!)
                                          .then(() => message.success('代码已复制'))
                                          .catch(() => message.warning('复制失败，请手动选择复制'))
                                      }}
                                    >
                                      复制
                                    </Button>
                                  </div>
                                  <pre className="template-code mono">{content.code}</pre>
                                </div>
                              )}
                            </>
                          ) : (
                            !t.custom && (
                              <div className="template-empty-content">
                                <p className="template-text">这个模板位还没写入内容 —— 模板由你自己写才有用。</p>
                                <Button type="primary" icon={<EditOutlined />} onClick={() => openContentEditor(t)}>
                                  写入我的模板
                                </Button>
                              </div>
                            )
                          )}

                          {t.examples.length > 0 && (
                            <div className="template-section">
                              <div
                                className="section-label"
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
                              >
                                <span>例题实战（点击做题，入库后自动追踪 AC）</span>
                                <Tooltip title="拉取例题平台的最新提交，自动刷新 AC 状态">
                                  <Button
                                    size="small"
                                    type="text"
                                    icon={<SyncOutlined />}
                                    loading={syncingId === t.id}
                                    onClick={() => syncExamples(t)}
                                  >
                                    同步 AC
                                  </Button>
                                </Tooltip>
                              </div>
                              <div className="template-examples">
                                {t.examples.map((ex) => (
                                  <div className="template-example-row" key={`${ex.platform}-${ex.key}`}>
                                    <a href={ex.url} target="_blank" rel="noreferrer" className="template-example">
                                      <LinkOutlined /> [{ex.key}] {ex.title} ↗
                                    </a>
                                    {ex.ac ? (
                                      <Tag color="success" className="dot-tag">已 AC</Tag>
                                    ) : ex.inBank ? (
                                      <Link to="/problems">
                                        <Tag color="processing" className="dot-tag template-example-action">已入库 · 未 AC</Tag>
                                      </Link>
                                    ) : (
                                      <Button size="small" type="text" icon={<ImportOutlined />} onClick={() => collectExample(t, ex)}>
                                        入库
                                      </Button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="template-actions">
                            <Space size={8} wrap>
                              {STATUS_META.map((s) => (
                                <Button
                                  key={s.key}
                                  size="small"
                                  type={t.status === s.key ? 'primary' : 'default'}
                                  icon={<s.icon />}
                                  onClick={() => setStatus(t, s.key)}
                                >
                                  {s.label}
                                </Button>
                              ))}
                              <Button
                                size="small"
                                type="text"
                                icon={<EditOutlined />}
                                onClick={() => {
                                  setNoteEditing(t)
                                  setNoteDraft(t.note ?? '')
                                }}
                              >
                                {t.note ? '改笔记' : '记笔记'}
                              </Button>
                              {t.status === 'mastered' && (
                                <Link to="/reviews" className="template-review-hint">
                                  <BookOutlined /> 到复习库保持手感 →
                                </Link>
                              )}
                            </Space>
                            {t.note && <p className="task-note">📒 {t.note}</p>}
                          </div>
                        </div>
                      )}
                    </Card>
                  )
                })
              )}
            </>
          )}
        </section>
      </div>

      {/* 学习笔记弹窗 */}
      <Modal
        title={`学习笔记 · ${noteEditing?.name ?? ''}`}
        open={noteEditing !== null}
        onCancel={() => setNoteEditing(null)}
        onOk={saveNote}
        okText="保存"
        cancelText="取消"
      >
        <Input.TextArea
          rows={4}
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="自己的理解、踩过的坑、与哪些题联系紧密……"
        />
      </Modal>

      {/* 自建模板新建 / 编辑弹窗 */}
      <Modal
        title={editingCustom ? '编辑自建模板' : '新建自建模板'}
        open={customOpen}
        onCancel={() => setCustomOpen(false)}
        onOk={submitCustom}
        okText={editingCustom ? '保存' : '创建'}
        cancelText="取消"
        width={720}
      >
        <Form form={customForm} layout="vertical">
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="categoryKey" label="分类" rules={[{ required: true, message: '选择分类' }]} style={{ width: 160 }}>
              <Select
                options={(data?.categories ?? []).map((c) => ({ value: c.key, label: c.name }))}
              />
            </Form.Item>
            <Form.Item name="name" label="模板名称" rules={[{ required: true, message: '填写名称' }]} style={{ flex: 1, minWidth: 240 }}>
              <Input placeholder="如：线段树二分（自用版）" maxLength={100} />
            </Form.Item>
            <Form.Item name="difficulty" label="难度（1-5）" rules={[{ required: true }]} style={{ width: 120 }}>
              <InputNumber min={1} max={5} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label="标签（与刷题标签同词表，回车添加）">
            <Select mode="tags" open={false} tokenSeparators={[',', '|']} placeholder="线段树 / 二分 …" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="complexity" label="复杂度" style={{ width: 200 }}>
              <Input placeholder="O(n log n)" maxLength={200} />
            </Form.Item>
            <Form.Item name="url" label="模板出处 / 讲解链接" style={{ flex: 1, minWidth: 280 }}>
              <Input placeholder="https://..." maxLength={500} />
            </Form.Item>
          </Space>
          <Form.Item name="idea" label="思路与备注">
            <CodeEditor
              language="markdown"
              height={140}
              maxLength={5000}
              placeholder="自己的理解、适用边界……（Markdown 语法：列表 / 表格 / 代码块）"
            />
          </Form.Item>
          <Form.Item name="code" label="模板代码">
            <CodeEditor
              language="cpp"
              height={320}
              maxLength={20000}
              placeholder="粘贴 / 编写你的 C++ 模板……（语法高亮，支持 Tab 缩进）"
            />
          </Form.Item>
        </Form>
      </Modal>
      {/* 内置条目：写入我的模板内容弹窗 */}
      <Modal
        title={`写入我的模板 · ${contentEditing?.name ?? ''}`}
        open={contentEditing !== null}
        onCancel={() => setContentEditing(null)}
        onOk={submitContent}
        okText="保存"
        cancelText="取消"
        width={720}
      >
        {contentEditing && (
          <>
            <p className="band-desc" style={{ marginTop: 0 }}>
              大纲要点：{contentEditing.outline}
            </p>
            <Form layout="vertical">
              <Form.Item label="我的思路（什么时候用 / 关键观察）" style={{ marginBottom: 12 }}>
                <CodeEditor
                  language="markdown"
                  height={140}
                  maxLength={5000}
                  value={contentDraft.idea ?? ''}
                  onChange={(v) => setContentDraft((d) => ({ ...d, idea: v }))}
                  placeholder="用自己的话写下来，Markdown 语法（列表 / 表格 / 代码块）——复习时只看这一段……"
                />
              </Form.Item>
              <Form.Item label="模板代码" style={{ marginBottom: 12 }}>
                <CodeEditor
                  language="cpp"
                  height={320}
                  maxLength={20000}
                  value={contentDraft.code ?? ''}
                  onChange={(v) => setContentDraft((d) => ({ ...d, code: v }))}
                  placeholder="粘贴 / 编写你的 C++ 模板……（语法高亮，支持 Tab 缩进）"
                />
              </Form.Item>
              <Space size={12} style={{ display: 'flex' }}>
                <Form.Item label="复杂度" style={{ marginBottom: 0, width: 200 }}>
                  <Input
                    value={contentDraft.complexity ?? ''}
                    onChange={(e) => setContentDraft((d) => ({ ...d, complexity: e.target.value }))}
                    placeholder="O(n log n)"
                    maxLength={200}
                  />
                </Form.Item>
                <Form.Item label="参考链接" style={{ marginBottom: 0, flex: 1, minWidth: 260 }}>
                  <Input
                    value={contentDraft.url ?? ''}
                    onChange={(e) => setContentDraft((d) => ({ ...d, url: e.target.value }))}
                    placeholder="https://...（题解 / 笔记）"
                    maxLength={500}
                  />
                </Form.Item>
              </Space>
            </Form>
          </>
        )}
      </Modal>
    </div>
  )
}
