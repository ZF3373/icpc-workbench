/**
 * AI 助手会话历史的「送出前清洗」与生成状态文案（issue 36）。
 *
 * 现场：模型偶发返回空回复时，会话历史里会留下一条 content 为空的 assistant 轮次。
 * 旧服务端看到空 content 会**整体拒绝**这次请求（400「messages 必填：1-60 条 …」），
 * 于是这个会话之后每一轮都发不出去 —— 报错说的是轮次数量，真正的原因却是一条空轮次，
 * 用户无从自救。这里在客户端把空轮次挡在请求之外（本地历史仍保留，用户能看到自己发过什么），
 * 服务端也同步做了丢弃兜底（见 server/src/routes/ai.ts）。
 *
 * 纯逻辑、无 React/DOM 依赖，便于单测。
 */

/** 参与「送出」的最小消息形态（与 Assistant 的 ChatMsg 结构兼容） */
export interface ContentBearingTurn {
  role: 'user' | 'assistant'
  content: string
  /** user 消息的附件（纯图片提问时 content 为空但有附件，必须保留） */
  attachments?: unknown[]
}

/**
 * 过滤掉没有任何内容的轮次。
 *
 * 空 content 的 assistant 轮次对模型毫无信息，却会让服务端整单拒绝；
 * 空 content 的 user 轮次由「发送」按钮disabled 兜底，同样不值得发送。
 * user 纯附件提问（content 为空、attachments 非空）必须保留。
 */
export function sanitizeOutgoingTurns<T extends ContentBearingTurn>(turns: T[]): T[] {
  return turns.filter((t) => {
    if (String(t.content ?? '').trim() !== '') return true
    return t.role === 'user' && (t.attachments?.length ?? 0) > 0
  })
}

/**
 * 模型返回空回复时的可见提示。
 *
 * 以前这种情况什么都不显示（空 Markdown 渲染成空白），用户看到的是「我发了问题但没有任何回复」，
 * 既不知道发生了什么，也不知道能不能继续。留一条明确提示，并说明不影响后续对话。
 */
export const EMPTY_REPLY_NOTICE =
  '⚠️ **未收到回复内容。** 模型这次返回了空回复（可能被上游中断、只产出了思考内容，或触发了长度上限）。可以直接重发或换个问法 —— 这条空消息不会影响后续对话。'

/** 工具 id → 中文进度文案（服务端工具注册表里的名字） */
const TOOL_LABELS: Record<string, string> = {
  web_search: '正在联网检索',
  fetch_url: '正在读取网页',
  fetch_editorial: '正在查找题解',
}

/** 进度文案里附带参数的最大长度（详情可能是长 URL） */
const DETAIL_MAX = 60

/**
 * 把服务端的工具事件转成给用户看的进度文案。
 *
 * 为什么需要：正文输出完之后 AI 可能还在跑工具（检索/抓网页要十几秒），
 * 旧版界面此时只剩一个「停止生成」按钮，用户以为卡死就点了停止（issue 36 的第 3 个现象）。
 */
export function describeToolStatus(name: string, detail?: string): string {
  const label = TOOL_LABELS[name] ?? (name ? `正在执行 ${name}` : '正在处理')
  const d = (detail ?? '').trim()
  if (!d) return `${label}…`
  return `${label}：${d.length > DETAIL_MAX ? `${d.slice(0, DETAIL_MAX)}…` : d}`
}
