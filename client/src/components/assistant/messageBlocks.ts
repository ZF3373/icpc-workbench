/**
 * AI 消息正文的纯解析辅助（无组件、无 React 依赖）：
 * 结构化块（plan-modify / ability-update / template-add / list-create / plan-create）
 * 的提取与剥离 + 模板草稿的目标标签定位。
 *
 * 与组件分离的原因：react-refresh 要求组件文件只导出组件；纯函数独立成文件后
 * 单测也无需挂载 React。
 */
import {
  parseStructuredBlocks,
  stripFenceSpans,
  type BlockIssue,
  type ListCreateDraft,
  type PlanCreateDraft,
  type TemplateAddDraft,
} from '../../aiBlocks'
import { resolveTemplateTarget, type TemplateCategoryOption } from '../../templateTarget'

// ---------- 消息结构化块解析（带缓存） ----------

export interface MsgBlocks {
  modify: string | null
  abilityUpd: { level: number; reason?: string } | null
  tplAdds: TemplateAddDraft[]
  /** 识别到但格式不合法 / 重复的块（UI 据此解释「为什么没有按钮」） */
  issues: BlockIssue[]
  listDraft: ListCreateDraft | null
  planDraft: PlanCreateDraft | null
  /** 剥掉所有结构化块之后、留给 Markdown 渲染的正文 */
  text: string
}

/**
 * 解析结果在组件内按 m.content 记忆（见 AssistantMessageItem 的 useMemo）。
 *
 * 流式输出时 store 每帧都会更新一次消息数组，每条助手消息都要跑六组 regex
 * （计划修改 / 能力值 / 模板 / 题单 / 训练计划 + 对应的剥离）。历史消息的内容根本
 * 没变，却跟着每帧重扫 —— 消息一多这就是纯粹的白工。抽成纯函数后由调用方按
 * 内容 memo：正文没变就直接复用上一次的结果。
 */
export function parseMessageBlocks(content: string): MsgBlocks {
  const parsed = parseStructuredBlocks(content)

  // 只剥离**解析成功**的块：解析失败的块留在正文里（用户能看到 AI 原话、可手动复制），
  // 而不是被静默删掉又没给按钮 —— 那样用户彻底没法补救。
  let text = parsed.parsedFences.length > 0 ? stripFenceSpans(content, parsed.parsedFences) : content
  text = text.trim()

  return {
    modify: parsed.modify,
    abilityUpd: parsed.abilityUpd,
    tplAdds: parsed.tplAdds,
    issues: parsed.issues,
    listDraft: parsed.listDraft,
    planDraft: parsed.planDraft,
    text,
  }
}

/** 模板草稿的定位键：消息下标 + 消息内草稿下标（tplTargets / tplWriting 都按它索引） */
export function tplKey(msgIndex: number, draftIndex: number): string {
  return `${msgIndex}:${draftIndex}`
}

/**
 * 该草稿最终写入的目标标签：用户显式选择 > AI 给的 categoryKey（有效时）> 第一个分类。
 * 用户反馈「无法指定 AI 把模板放到哪个标签下」——选择器与这里的解析共同保证
 * 用户点名的标签（含自己新建的自建标签）一定被原样写入。
 *
 * 消息项展示选择器与写入模板时都要算它，抽成同一份避免两处口径漂移。
 */
export function draftTargetOf(
  tplTargets: Record<string, string>,
  tplCategories: TemplateCategoryOption[],
  msgIndex: number,
  draftIndex: number,
  draft: TemplateAddDraft,
): string {
  return resolveTemplateTarget({
    aiKey: draft.categoryKey,
    chosen: tplTargets[tplKey(msgIndex, draftIndex)],
    categories: tplCategories,
  })
}

// ---------- 消息列表项 ----------