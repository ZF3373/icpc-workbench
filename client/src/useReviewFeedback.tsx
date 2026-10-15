import { useRef, useState } from 'react'
import { App as AntdApp } from 'antd'
import { post } from './api'
import type { ReviewFeedback, ReviewFeedbackResult, ReviewItem } from '../../shared/src/index.ts'

/** 复习库、今日训练和日历共用反馈/确认流程，复习记录先保存，计划任务随后明确确认。 */
export function useReviewFeedback(onChanged: () => void) {
  const { message, modal } = AntdApp.useApp()
  const [pending, setPending] = useState<number | null>(null)
  const busy = useRef(false)

  const feedback = async (item: ReviewItem, value: ReviewFeedback) => {
    if (busy.current) return
    busy.current = true
    setPending(item.id)
    try {
      const result = await post<ReviewFeedbackResult>(`/api/reviews/${item.id}/feedback`, { feedback: value })
      message.success(`「${item.problemKey}」下次复习：${result.nextDueOn}`)
      onChanged()
      if (result.planTasks?.length > 0) {
        modal.confirm({
          title: `同时完成 ${result.planTasks.length} 项计划复习任务？`,
          content: <div>
            <p>本次复习已记录。以下同题任务已安排在今天，确认后一起打卡；可在计划或日历中取消打卡。</p>
            {result.planTasks.map(task => <p key={task.id}>{task.planTitle} · {task.title}</p>)}
          </div>,
          okText: '确认并打卡',
          cancelText: '仅记录复习',
          onOk: async () => {
            try {
              const response = await post<{ checked: number }>(`/api/reviews/${item.id}/complete-tasks`, {
                eventId: result.eventId,
                taskIds: result.planTasks.map(task => task.id),
              })
              message.success(`已为 ${response.checked} 项复习任务打卡`)
              onChanged()
            } catch (error) {
              message.error((error as Error).message)
              throw error
            }
          },
        })
      }
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      busy.current = false
      setPending(null)
    }
  }
  return { feedback, pending }
}
