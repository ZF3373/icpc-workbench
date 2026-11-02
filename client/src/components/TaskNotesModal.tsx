import { useEffect, useState } from 'react'
import { App as AntdApp, Alert, Modal, Segmented, Spin } from 'antd'
import NoteForm from './NoteForm'
import { get, patch, post } from '../api'
import { draftPayload, isBlankNote, isNoteDirty, isUploading, newDraft, toDraft, type NoteDraft, type ProblemNote } from '../problemNotes'

export type TaskNoteMode = 'checkin' | 'add' | 'edit'

export interface TaskNoteTarget {
  task: { id: number; title: string }
  mode: TaskNoteMode
  /** 连续打卡时的「第几项 / 共几项」 */
  progress?: { index: number; total: number }
}

const TITLE: Record<TaskNoteMode, string> = { checkin: '写笔记并打卡', add: '再写一条笔记', edit: '编辑笔记' }

/**
 * 计划任务的笔记弹窗（训练计划 / 日历 / 今日训练共用）。
 * checkin：保存即打卡（服务端同一事务）；add：追加一条；edit：改已有笔记，多条时切换，草稿不丢。
 */
export default function TaskNotesModal({ target, onClose, onSaved }: {
  target: TaskNoteTarget | null
  onClose: () => void
  onSaved: (target: TaskNoteTarget) => void
}) {
  const { message } = AntdApp.useApp()
  const [draft, setDraft] = useState<NoteDraft>(newDraft)
  const [notes, setNotes] = useState<ProblemNote[] | null>(null)
  const [drafts, setDrafts] = useState<Record<number, NoteDraft>>({})
  const [activeId, setActiveId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const taskId = target?.task.id
  const mode = target?.mode
  useEffect(() => {
    if (taskId === undefined || mode === undefined) return
    setDraft(newDraft())
    setNotes(null)
    setDrafts({})
    setActiveId(null)
    if (mode !== 'edit') return
    let stale = false
    get<{ items: ProblemNote[] }>(`/api/notes?taskId=${taskId}`)
      .then(({ items }) => {
        if (stale) return
        setDrafts(Object.fromEntries(items.map((n) => [n.id, toDraft(n)])))
        setNotes(items)
        setActiveId(items[0]?.id ?? null)
      })
      .catch((e: Error) => {
        if (stale) return
        message.error(e.message)
        onClose()
      })
    return () => {
      stale = true
    }
    // onClose 由调用方每次渲染重建，只跟随目标任务变化重新取数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, mode, target?.progress?.index, message])

  if (!target) return null

  // 升级前打的卡可能没有笔记：编辑入口退化为新写一条，而不是一个空白的死胡同
  const editing = mode === 'edit' && activeId !== null
  const loadingNotes = mode === 'edit' && notes === null
  const current = editing ? drafts[activeId] : draft

  const submit = async (): Promise<void> => {
    // 未传完的框没有地址，此时保存会被当空框略去，文件就丢了
    if ([draft, ...Object.values(drafts)].some(isUploading)) {
      message.warning('文件还在上传，请稍候')
      return
    }
    setSaving(true)
    try {
      if (mode === 'edit' && notes && notes.length > 0) {
        const dirty = notes.filter((n) => isNoteDirty(drafts[n.id], n))
        const blank = dirty.find((n) => isBlankNote(drafts[n.id]))
        if (blank) {
          setActiveId(blank.id)
          message.warning('笔记内容不能为空')
          return
        }
        for (const n of dirty) await patch(`/api/notes/${n.id}`, draftPayload(drafts[n.id]))
        message.success('笔记已保存')
      } else {
        if (isBlankNote(draft)) {
          message.warning(mode === 'checkin' ? '写下笔记才能完成打卡' : '笔记内容不能为空')
          return
        }
        if (mode === 'checkin') {
          await post('/api/checkins', { taskId: target.task.id, note: draftPayload(draft) })
          message.success('打卡成功 ✓')
        } else {
          await post('/api/notes', { taskId: target.task.id, ...draftPayload(draft) })
          message.success('笔记已保存')
        }
      }
      onSaved(target)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const progress = target.progress && target.progress.total > 1 ? `（${target.progress.index}/${target.progress.total}）` : ''
  return (
    <Modal
      title={`${TITLE[target.mode]}${progress} · ${target.task.title}`}
      open
      onCancel={onClose}
      onOk={() => void submit()}
      okText={target.mode === 'checkin' ? '保存并打卡' : '保存'}
      okButtonProps={{ disabled: loadingNotes }}
      cancelText="取消"
      confirmLoading={saving}
      width={880}
      maskClosable={false}
      keyboard={false}
      destroyOnHidden
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
    >
      {target.mode === 'checkin' && (
        <Alert style={{ marginBottom: 12 }} type="info" showIcon message="保存笔记后才算打卡完成；打卡完成后不可取消，之后仍可编辑笔记或再写一条。" />
      )}
      {loadingNotes ? (
        <div style={{ textAlign: 'center', padding: 48 }}><Spin /></div>
      ) : (
        <>
          {notes && notes.length > 1 && (
            <Segmented
              style={{ marginBottom: 12, maxWidth: '100%', overflowX: 'auto' }}
              value={activeId ?? undefined}
              onChange={(v) => setActiveId(v as number)}
              options={notes.map((n, i) => ({
                value: n.id,
                label: `第 ${notes.length - i} 条${drafts[n.id].labels.length > 0 ? ` · ${drafts[n.id].labels[0]}` : ''}`,
              }))}
            />
          )}
          <NoteForm
            key={activeId ?? 'new'}
            value={current}
            onChange={(update) => {
              if (editing) setDrafts((d) => ({ ...d, [activeId]: update(d[activeId]) }))
              else setDraft(update)
            }}
          />
        </>
      )}
    </Modal>
  )
}
