import { Button } from 'antd'
import type { TaskNoteMode } from './TaskNotesModal'

/** 打卡前一个按钮（打卡）；打卡后两个按钮（编辑笔记 / 再写一条）。打卡完成后不可取消。 */
export default function TaskCheckinButtons({ checked, onOpen }: {
  checked: boolean
  onOpen: (mode: TaskNoteMode) => void
}) {
  if (!checked) {
    return <Button size="small" type="primary" onClick={() => onOpen('checkin')}>打卡</Button>
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
      <Button size="small" onClick={() => onOpen('edit')}>编辑笔记</Button>
      <Button size="small" onClick={() => onOpen('add')}>再写一条</Button>
    </span>
  )
}
