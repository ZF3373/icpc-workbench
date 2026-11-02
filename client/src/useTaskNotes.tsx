import { useCallback, useState, type ReactNode } from 'react'
import TaskNotesModal, { type TaskNoteMode, type TaskNoteTarget } from './components/TaskNotesModal'

type NoteTask = TaskNoteTarget['task']

/** 页面里只放一个笔记弹窗；openQueue 让多项已 AC 任务逐条写笔记打卡，中途取消即停在当前项。 */
export function useTaskNotes(onChanged: () => void): {
  open: (task: NoteTask, mode: TaskNoteMode) => void
  openQueue: (tasks: readonly NoteTask[]) => void
  modal: ReactNode
} {
  const [queue, setQueue] = useState<readonly NoteTask[]>([])
  const [index, setIndex] = useState(0)
  const [mode, setMode] = useState<TaskNoteMode>('checkin')

  const open = useCallback((task: NoteTask, nextMode: TaskNoteMode) => {
    setQueue([task])
    setIndex(0)
    setMode(nextMode)
  }, [])

  const openQueue = useCallback((tasks: readonly NoteTask[]) => {
    setQueue(tasks)
    setIndex(0)
    setMode('checkin')
  }, [])

  const close = (): void => {
    setQueue([])
    setIndex(0)
  }

  const task = queue[index]
  const target: TaskNoteTarget | null = task ? { task, mode, progress: { index: index + 1, total: queue.length } } : null
  return {
    open,
    openQueue,
    modal: (
      <TaskNotesModal
        target={target}
        onClose={close}
        onSaved={() => {
          onChanged()
          if (index + 1 < queue.length) setIndex(index + 1)
          else close()
        }}
      />
    ),
  }
}
