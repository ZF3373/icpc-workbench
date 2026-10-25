/**
 * 消息项交互动作的稳定引用 hook（无组件导出，与 memo 消息气泡配套）。
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { ListCreateDraft, PlanCreateDraft, TemplateAddDraft } from '../../aiBlocks'

/** 消息项需要的交互动作（由 useMessageActions 提供，引用恒定） */
export interface MessageActions {
  edit(index: number): void
  applyPlan(raw: string): void
  confirmAbility(suggestion: { level: number; reason?: string }, raw: string): void
  setTplTarget(index: number, draftIndex: number, key: string): void
  confirmTemplate(draft: TemplateAddDraft, index: number, draftIndex: number): void
  confirmAllTemplates(drafts: TemplateAddDraft[], index: number): void
  confirmListCreate(draft: ListCreateDraft, index: number): void
  confirmPlanCreate(draft: PlanCreateDraft, index: number): void
  notify(kind: 'success' | 'warning', text: string): void
}

/**
 * 把动作集合的引用钉住：内部始终转发到本轮渲染的最新实现。
 *
 * 列表项被 memo 后只有 props 引用变化才重渲染；若把每次渲染新建的箭头函数直接传下去，
 * memo 永远失效。这里用 ref 保存最新闭包、动作对象只在挂载时创建一次 ——
 * 点击时读到的仍是最新的 messages / pendingAtts，不会踩到 memo 跳过后留下的旧闭包。
 */
export function useMessageActions(handlers: MessageActions): MessageActions {
  const latest = useRef(handlers)
  // 每次提交后同步：事件只会在绘制之后触发，读到的必是本轮闭包
  useLayoutEffect(() => {
    latest.current = handlers
  })
  const [stable] = useState<MessageActions>(() => ({
    edit: (index) => latest.current.edit(index),
    applyPlan: (raw) => latest.current.applyPlan(raw),
    confirmAbility: (suggestion, raw) => latest.current.confirmAbility(suggestion, raw),
    setTplTarget: (index, draftIndex, key) => latest.current.setTplTarget(index, draftIndex, key),
    confirmTemplate: (draft, index, draftIndex) => latest.current.confirmTemplate(draft, index, draftIndex),
    confirmAllTemplates: (drafts, index) => latest.current.confirmAllTemplates(drafts, index),
    confirmListCreate: (draft, index) => latest.current.confirmListCreate(draft, index),
    confirmPlanCreate: (draft, index) => latest.current.confirmPlanCreate(draft, index),
    notify: (kind, text) => latest.current.notify(kind, text),
  }))
  return stable
}
