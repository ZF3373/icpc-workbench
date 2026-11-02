import { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Card, Drawer, Modal, Popconfirm, Space, Tag } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import EmptyState from './EmptyState'
import InlineError from './InlineError'
import NoteBlocksView from './NoteBlocksView'
import NoteForm from './NoteForm'
import PageSkeleton from './PageSkeleton'
import { del, get, patch, post } from '../api'
import { draftPayload, isBlankNote, isUploading, newDraft, toDraft, type NoteDraft, type ProblemNote } from '../problemNotes'

export interface NotesProblem {
  id: number
  title: string
  problem_key: string
}

/** 题目管理的「题目笔记」：一题多条、可标注；训练计划打卡写的笔记也汇总在这里。 */
export default function ProblemNotesDrawer({ problem, onClose, onChanged }: {
  problem: NotesProblem | null
  onClose: () => void
  /** 新增或删除后调用（刷新行上的笔记条数） */
  onChanged: () => void
}) {
  const { message } = AntdApp.useApp()
  const [notes, setNotes] = useState<ProblemNote[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** null = 未打开编辑；id 为 null = 新写一条 */
  const [editing, setEditing] = useState<{ id: number | null; draft: NoteDraft } | null>(null)
  const [saving, setSaving] = useState(false)

  const problemId = problem?.id
  const load = useCallback(() => {
    if (problemId === undefined) return
    setLoadError(null)
    get<{ items: ProblemNote[] }>(`/api/notes?problemId=${problemId}`)
      .then((r) => setNotes(r.items))
      .catch((e: Error) => setLoadError(e.message))
  }, [problemId])

  useEffect(() => {
    setNotes(null)
    setEditing(null)
    load()
  }, [load])

  const save = async (): Promise<void> => {
    if (!editing || problemId === undefined) return
    // 未传完的框没有地址，此时保存会被当空框略去，文件就丢了
    if (isUploading(editing.draft)) {
      message.warning('文件还在上传，请稍候')
      return
    }
    if (isBlankNote(editing.draft)) {
      message.warning('笔记内容不能为空')
      return
    }
    setSaving(true)
    try {
      if (editing.id === null) {
        await post('/api/notes', { problemId, ...draftPayload(editing.draft) })
        onChanged()
      } else {
        await patch(`/api/notes/${editing.id}`, draftPayload(editing.draft))
      }
      message.success('笔记已保存')
      setEditing(null)
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number): Promise<void> => {
    try {
      await del(`/api/notes/${id}`)
      message.success('笔记已删除')
      onChanged()
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <Drawer
      title={problem ? `题目笔记 · ${problem.problem_key} ${problem.title}` : '题目笔记'}
      open={problem !== null}
      onClose={onClose}
      width={640}
      extra={
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setEditing({ id: null, draft: newDraft() })}>
          写笔记
        </Button>
      }
    >
      {loadError ? (
        <InlineError message={loadError} hint="笔记没能取回来；重试即可，已写的笔记不会丢失。" onRetry={load} />
      ) : notes === null ? (
        <PageSkeleton stats={false} table rows={4} />
      ) : notes.length === 0 ? (
        <EmptyState
          title="这道题还没有笔记"
          description="记下思路、踩过的坑或待回看的点；一道题可以写多条，并用标注区分。"
          action={{ label: '写笔记', type: 'primary', icon: <PlusOutlined />, onClick: () => setEditing({ id: null, draft: newDraft() }) }}
        />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {notes.map((n) => (
            <Card
              key={n.id}
              size="small"
              title={
                <Space size={4} wrap>
                  {n.labels.map((l) => <Tag key={l} color="blue" style={{ marginInlineEnd: 0 }}>{l}</Tag>)}
                  <span style={{ color: 'var(--text-3)', fontSize: 12, fontWeight: 400 }}>
                    {dayjs(n.createdAt).format('YYYY-MM-DD HH:mm')}
                    {n.updatedAt !== n.createdAt && ` · 编辑于 ${dayjs(n.updatedAt).format('MM-DD HH:mm')}`}
                  </span>
                </Space>
              }
              extra={
                <Space size={0}>
                  <Button type="text" size="small" icon={<EditOutlined />} aria-label="编辑笔记" onClick={() => setEditing({ id: n.id, draft: toDraft(n) })} />
                  <Popconfirm title="删除这条笔记？" okText="删除" cancelText="取消" onConfirm={() => void remove(n.id)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除笔记" />
                  </Popconfirm>
                </Space>
              }
            >
              {n.taskTitle && (
                <div style={{ color: 'var(--text-3)', fontSize: 12, marginBottom: 8 }}>
                  来自训练计划：{n.planTitle} · {n.taskDate} · {n.taskTitle}
                </div>
              )}
              <NoteBlocksView blocks={n.blocks} />
            </Card>
          ))}
        </Space>
      )}
      <Modal
        title={editing?.id === null ? '写笔记' : '编辑笔记'}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => void save()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        width={880}
        maskClosable={false}
        keyboard={false}
        destroyOnHidden
        styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
      >
        {editing && (
          <NoteForm
            key={editing.id ?? 'new'}
            value={editing.draft}
            onChange={(update) => setEditing((e) => (e ? { ...e, draft: update(e.draft) } : e))}
          />
        )}
      </Modal>
    </Drawer>
  )
}
