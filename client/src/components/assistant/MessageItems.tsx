/**
 * AI 助手的消息列表项：用户气泡 / AI 回复气泡（memo 化）与配套的块解析、动作 hook。
 *
 * 为什么单独抽成 memo 组件：流式生成期间 streamBuffer 每 50ms 落一次库，
 * messages 数组每帧都是新的，但只有最后一条消息的对象引用会变（见 patchActiveSessionMessages
 * 的追加/替换逻辑）。抽出来后历史消息的 props 全部引用稳定，memo 直接跳过整棵子树 ——
 * 不再重跑 Markdown/KaTeX 解析，也不再重扫 parseMessageBlocks 的六组正则。
 *
 * key 必须用消息自带的 id（见 ChatMsg.id）而不是数组下标：「再次编辑后重发」会截断数组，
 * 用下标做 key 时新消息会复用旧位置上的组件实例，相邻消息的 DOM 状态（详情展开、选区）错位。
 */
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, Select, Space, Tag, Tooltip } from 'antd'
import { CopyOutlined, EditOutlined, PaperClipOutlined } from '@ant-design/icons'
import Markdown from '../Markdown'
import { formatBytes as fmtBytes } from '../../ui'
import { resolveTemplateTarget, templateCategoryLabel, type TemplateCategoryOption } from '../../templateTarget'
import {
  extractAbilityUpdate,
  extractListCreate,
  extractModifyBlock,
  extractPlanCreate,
  extractTemplateAdd,
  stripAbilityUpdate,
  stripListCreate,
  stripModifyBlock,
  stripPlanCreate,
  stripTemplateAdd,
  type ListCreateDraft,
  type PlanCreateDraft,
  type TemplateAddDraft,
} from '../../aiBlocks'
import type { ChatMsg } from '../../pages/chatStore'

// ---------- 消息结构化块解析（带缓存） ----------

export interface MsgBlocks {
  modify: string | null
  abilityUpd: { level: number; reason?: string } | null
  tplAdds: TemplateAddDraft[]
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
  const modify = extractModifyBlock(content)
  const abilityUpd = extractAbilityUpdate(content)
  const tplAdds = extractTemplateAdd(content)
  const listDraft = extractListCreate(content)
  const planDraft = extractPlanCreate(content)

  let text = stripModifyBlock(content)
  if (abilityUpd) text = stripAbilityUpdate(text)
  if (tplAdds.length > 0) text = stripTemplateAdd(text)
  if (listDraft) text = stripListCreate(text)
  if (planDraft) text = stripPlanCreate(text)

  return { modify, abilityUpd, tplAdds, listDraft, planDraft, text }
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
//
// 为什么单独抽成 memo 组件：流式生成期间 streamBuffer 每 50ms 落一次库，
// messages 数组每帧都是新的，但只有最后一条消息的对象引用会变（见 patchActiveSessionMessages
// 的追加/替换逻辑）。抽出来后历史消息的 props 全部引用稳定，memo 直接跳过整棵子树 ——
// 不再重跑 Markdown/KaTeX 解析，也不再重扫 parseMessageBlocks 的六组正则。
//
// key 必须用消息自带的 id（见 ChatMsg.id）而不是数组下标：「再次编辑后重发」会截断数组，
// 用下标做 key 时新消息会复用旧位置上的组件实例，相邻消息的 DOM 状态（详情展开、选区）错位。

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

export interface UserMessageItemProps {
  m: ChatMsg
  index: number
  /** 对话导航跳转命中的短暂高亮 */
  flash: boolean
  actions: MessageActions
}

/** 用户消息气泡：附件预览 + 正文 + 复制/再次编辑 */
export const UserMessageItem = memo(function UserMessageItem({ m, index, flash, actions }: UserMessageItemProps) {
  return (
    <div
      data-msg-index={index}
      data-role="user"
      className={`plan-chat-msg plan-chat-msg-user${flash ? ' is-flash' : ''}`}
    >
      {m.attachments && m.attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: m.content ? 6 : 0 }}>
          {m.attachments.map((a, j) =>
            a.dataUrl ? (
              /* 内联图片：气泡内直接预览（刷新后 dataUrl 剥离，退化为标签） */
              <img
                key={`${a.fileId}-${j}`}
                src={a.dataUrl}
                alt={a.filename || '图片附件'}
                style={{
                  maxWidth: 200,
                  maxHeight: 160,
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                  display: 'block',
                  objectFit: 'cover',
                }}
              />
            ) : (
              <Tag key={`${a.fileId}-${j}`} style={{ marginInlineEnd: 0 }}>
                <PaperClipOutlined /> {a.filename || a.fileId}
                {a.bytes !== undefined ? `（${fmtBytes(a.bytes)}）` : ''}
                {a.textContent !== undefined ? ' · 文本' : ''}
              </Tag>
            ),
          )}
        </div>
      )}
      {m.content && <div className="assistant-message-text"><Markdown text={m.content} /></div>}
      {/* 按钮行对纯附件消息（content 为空）同样渲染：否则粘贴图片直接发送后
          找不到「再次编辑」入口；「复制」无文本可复制，仅在有内容时出现 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        {m.content && (
          <Button
            size="small"
            type="text"
            className="msg-copy-btn"
            icon={<CopyOutlined />}
            onClick={() => {
              navigator.clipboard
                ?.writeText(m.content ?? '')
                .then(() => actions.notify('success', '已复制'))
                .catch(() => actions.notify('warning', '复制失败，请手动选择复制'))
            }}
          >
            复制
          </Button>
        )}
        <Button
          size="small"
          type="text"
          className="msg-copy-btn"
          icon={<EditOutlined />}
          onClick={() => actions.edit(index)}
        >
          再次编辑
        </Button>
      </div>
    </div>
  )
})

export interface AssistantMessageItemProps {
  m: ChatMsg
  index: number
  /** 本条是最后一条且正在流式输出（Markdown 补全语法、思维链自动展开） */
  streaming: boolean
  /** 对话导航跳转命中的短暂高亮 */
  flash: boolean
  /** 当前生效能力值：能力块建议值与之相同就不再给「更新」按钮 */
  abilityEffective: number | undefined
  /** 「写入模板库」的目标标签候选 */
  tplCategories: TemplateCategoryOption[]
  /** 用户为各草稿显式指定的目标标签（key = tplKey(index, draftIndex)） */
  tplTargets: Record<string, string>
  /** 正在写入的模板 key 集合 */
  tplWriting: Set<string>
  listCreating: boolean
  planCreating: boolean
  actions: MessageActions
}

/** AI 回复气泡：思维链 + Markdown 正文 + 结构化块的操作按钮 + 用量 */
export const AssistantMessageItem = memo(function AssistantMessageItem({
  m,
  index,
  streaming,
  flash,
  abilityEffective,
  tplCategories,
  tplTargets,
  tplWriting,
  listCreating,
  planCreating,
  actions,
}: AssistantMessageItemProps) {
  // 结构化块解析按正文 memo：只有正在增长的那条会重跑六组正则，
  // 应用标记 / 用量这类字段变化不必重扫（解析结果只取决于 content）
  const { modify, abilityUpd, tplAdds, listDraft, planDraft, text } = useMemo(
    () => parseMessageBlocks(m.content),
    [m.content],
  )
  const hasTpl = tplAdds.length > 0
  // 旧消息用 m.applied 表示模板已写入（向后兼容：无 appliedTpl 时视为该消息模板均已应用）
  const appliedTpl =
    m.applied === true && !m.appliedTpl ? tplAdds.map((_, j) => j) : (m.appliedTpl ?? [])
  const appliedTplSet = new Set(appliedTpl)
  const pendingTplCount = tplAdds.length - appliedTpl.length
  /**
   * 该草稿最终写入的目标标签：用户显式选择 > AI 给的 categoryKey（有效时）> 第一个分类。
   * 用户反馈「无法指定 AI 把模板放到哪个标签下」——选择器与这里的解析共同保证
   * 用户点名的标签（含自己新建的自建标签）一定被原样写入。
   */
  const targetOf = (draftIndex: number, draft: TemplateAddDraft): string =>
    draftTargetOf(tplTargets, tplCategories, index, draftIndex, draft)

  return (
    <div
      data-msg-index={index}
      data-role="assistant"
      className={`plan-chat-msg plan-chat-msg-assistant${flash ? ' is-flash' : ''}`}
    >
      {m.reasoning && (
        <details
          className="ai-reasoning"
          // 思考进行中（本条消息还在推流且正文未开始）自动展开，思维链实时可见；
          // 正文一开始或流结束后改为非受控，用户可自由开合（issue #27）
          open={streaming && !text.trim() ? true : undefined}
          style={{
            marginBottom: 8,
            padding: '6px 12px',
            background: 'var(--overlay-2)',
            borderRadius: 6,
            fontSize: 13,
            color: 'var(--text-2)',
          }}
        >
          <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 500 }}>
            💭 思考过程
          </summary>
          <div className="assistant-message-text assistant-message-reasoning" style={{ marginTop: 6, whiteSpace: 'pre-wrap', opacity: 0.85 }}>
            {m.reasoning}
          </div>
        </details>
      )}
      <div className="assistant-message-text">
        <Markdown text={text} breaks streaming={streaming} />
      </div>
      {text.trim() && (
        <Button
          size="small"
          type="text"
          className="msg-copy-btn"
          icon={<CopyOutlined />}
          onClick={() => {
            navigator.clipboard
              ?.writeText(text)
              .then(() => actions.notify('success', '已复制'))
              .catch(() => actions.notify('warning', '复制失败，请手动选择复制'))
          }}
        >
          复制
        </Button>
      )}
      {(modify || abilityUpd || hasTpl || listDraft || planDraft) && (
        <Space style={{ marginTop: 8 }} wrap>
          {modify && (
            <Button
              size="small"
              type="primary"
              disabled={m.applied}
              onClick={() => actions.applyPlan(m.content)}
            >
              {m.applied ? '已应用' : '应用计划修改'}
            </Button>
          )}
          {abilityUpd &&
            (abilityUpd.level === abilityEffective ? (
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                建议值 {abilityUpd.level} 与当前生效值相同，无需重复更新
              </span>
            ) : (
              <Button
                size="small"
                type="primary"
                ghost
                disabled={m.applied}
                onClick={() => actions.confirmAbility(abilityUpd, m.content)}
              >
                更新能力值为 {abilityUpd.level}
              </Button>
            ))}
          {hasTpl &&
            tplAdds.map((draft, j) => {
              const applied = appliedTplSet.has(j)
              return (
                <Space key={j} size={4}>
                  {/* 目标标签选择器：用户可显式指定放到哪个课程分类/自建标签下
                      （templateId 草稿是「完善已有内置条目」，不存在选分类的问题） */}
                  {!draft.templateId && tplCategories.length > 0 && (
                    <Tooltip title="写入到哪个标签下 —— 含你在「模板库 → 新建标签」里自己建的标签">
                      <Select
                        size="small"
                        style={{ minWidth: 140 }}
                        value={targetOf(j, draft)}
                        disabled={applied}
                        onChange={(key: string) => actions.setTplTarget(index, j, key)}
                        options={tplCategories.map((c) => ({
                          value: c.key,
                          label: templateCategoryLabel(c),
                        }))}
                      />
                    </Tooltip>
                  )}
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    disabled={applied}
                    loading={tplWriting.has(tplKey(index, j))}
                    onClick={() => actions.confirmTemplate(draft, index, j)}
                  >
                    {applied
                      ? `✓ 已完善：${draft.name}`
                      : draft.templateId
                        ? `完善模板：「${draft.name}」`
                        : `写入模板库：「${draft.name}」`}
                  </Button>
                </Space>
              )
            })}
          {hasTpl && pendingTplCount > 1 && (
            <Button
              size="small"
              type="primary"
              loading={tplAdds.some(
                (_, j) => !appliedTplSet.has(j) && tplWriting.has(tplKey(index, j)),
              )}
              onClick={() => actions.confirmAllTemplates(tplAdds, index)}
            >
              全部写入（{pendingTplCount}）
            </Button>
          )}
          {listDraft && (
            <Button
              size="small"
              type="primary"
              disabled={m.appliedList}
              loading={listCreating}
              onClick={() => actions.confirmListCreate(listDraft, index)}
            >
              {m.appliedList ? `✓ 已导入题单：${listDraft.title}` : `导入题单：「${listDraft.title}」`}
            </Button>
          )}
          {planDraft && (
            <Button
              size="small"
              type="primary"
              disabled={m.appliedPlan}
              loading={planCreating}
              onClick={() => actions.confirmPlanCreate(planDraft, index)}
            >
              {m.appliedPlan ? `✓ 已生成计划：${planDraft.title}` : `生成训练计划：「${planDraft.title}」`}
            </Button>
          )}
        </Space>
      )}
      {m.usage && (
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            color: 'var(--text-3)',
            textAlign: 'right',
          }}
        >
          📝 输入 {m.usage.prompt_tokens} / 输出 {m.usage.completion_tokens} token
        </div>
      )}
    </div>
  )
})

