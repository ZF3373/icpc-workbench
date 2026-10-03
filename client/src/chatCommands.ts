/**
 * AI 助手输入框的 `/` 快捷指令（P3-5 / §5.3）。
 *
 * 纯逻辑，无 React/DOM —— 解析与匹配是这里唯一的一份，UI 只负责渲染与键盘选择，
 * 因此边界（空斜杠、只写了半截命令名、需要参数但没给、中文别名）都能被单测直接钉住。
 */

export interface ChatCommand {
  /** 主名（写输入框里时不含斜杠），一律小写 */
  name: string
  /** 中文 / 英文别名，同样能命中 */
  aliases: string[]
  /** 需要参数时的占位说明；不需要参数则省略 */
  arg?: string
  /** 一句话说明用途，菜单里显示 */
  hint: string
}

export const CHAT_COMMANDS: ChatCommand[] = [
  { name: 'new', aliases: ['新建', '新会话'], hint: '新建一个会话' },
  { name: 'attach', aliases: ['附件', '上传'], hint: '附加图片或代码文件' },
  { name: 'problem', aliases: ['题目'], arg: '关键词', hint: '到题目管理按关键词搜索' },
  { name: 'template', aliases: ['模板'], arg: '关键词', hint: '到模板库定位模板' },
  { name: 'today', aliases: ['今日'], hint: '打开今日训练' },
  { name: 'settings', aliases: ['设置'], hint: '打开设置' },
]

/** 是否处于「斜杠命令」输入态：以 / 开头，且还没换行（多行正文里的 / 不算命令） */
export function isCommandInput(input: string): boolean {
  return input.startsWith('/') && !input.includes('\n')
}

/** 取输入里的命令名部分（第一个空白之前），小写 */
function nameOf(body: string): string {
  const sp = body.search(/\s/)
  return (sp === -1 ? body : body.slice(0, sp)).toLowerCase()
}

function findCommand(name: string): ChatCommand | undefined {
  return CHAT_COMMANDS.find((c) => c.name === name || c.aliases.some((a) => a.toLowerCase() === name))
}

/**
 * 把输入拆成 `{ command, arg }`。
 * 识别不出来（只打了个 `/`、命令名拼错、不是命令态）返回 null ——
 * 此时应当照常当普通消息发送，而不是悄悄吞掉用户输入。
 */
export function parseChatCommand(input: string): { command: ChatCommand; arg: string } | null {
  if (!isCommandInput(input)) return null
  const body = input.slice(1)
  const name = nameOf(body)
  if (!name) return null
  const command = findCommand(name)
  if (!command) return null
  const sp = body.search(/\s/)
  const arg = sp === -1 ? '' : body.slice(sp + 1).trim()
  return { command, arg }
}

/** 菜单候选：按已输入的命令名前缀过滤；空前缀（只打了 `/`）给全部 */
export function matchChatCommands(input: string): ChatCommand[] {
  if (!isCommandInput(input)) return []
  const name = nameOf(input.slice(1))
  if (!name) return CHAT_COMMANDS
  return CHAT_COMMANDS.filter(
    (c) => c.name.startsWith(name) || c.aliases.some((a) => a.toLowerCase().startsWith(name)),
  )
}

/** 命令是否已可执行：需要参数的命令必须带上参数 */
export function commandReady(cmd: ChatCommand, arg: string): boolean {
  return cmd.arg ? arg.trim().length > 0 : true
}

/** 把命令补全成 `/name `，让用户接着填参数 */
export function commandPrompt(cmd: ChatCommand): string {
  return `/${cmd.name} `
}
