/**
 * 列表与围栏的结构性修补（issue #18「AI 输出的格式渲染不完善」）。
 *
 * 单独成文件而不是塞进 markdownMath.ts：这里处理的不是公式，是「AI 写 Markdown 的
 * 习惯性形态」——CommonMark 语义正确、但对读者明显不对的那种。
 */

/** 列表项行：捕获「缩进 / 标记 / 标记后的空白」，三者宽度之和就是该项的内容列 */
const LIST_ITEM_LINE = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)/

/**
 * 这一行是不是列表项（允许前置缩进）。
 * markdownMath.ts 的「嵌套缩进块不是公式续行」判据共用这一份定义，免得两处各写一个
 * 正则然后慢慢漂移（issue #18 的三级列表被吃掉就是那个判据漏的）。
 */
export function isListItemLine(line: string): boolean {
  return /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\S/.test(line)
}

/** 围栏行（开栏或收尾），捕获标记串以取首字符与长度 */
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/

/** 收尾围栏：整行除空白外只有同一种三连字符 */
function isFenceCloser(line: string, char: string): boolean {
  const t = line.trim()
  return t.length >= 3 && t[0] === char && t === char.repeat(t.length)
}

/**
 * 把「紧跟在列表项后面、顶格写的代码围栏」缩进到该列表项的内容列。
 *
 * 为什么要改（issue #18）：模型极爱写
 *     1. 建栈
 *     ```cpp
 *     int x;
 *     ```
 *     2. 弹栈
 * 这种形态（围栏顶格、不跟着列表缩进）。按 CommonMark，顶格围栏**不属于**列表项，
 * 于是列表在这里断成两截：代码卡贴到左边界（丢了列表的悬挂缩进），后面的
 * `2. 弹栈` 另起一个 `<ol start="2">`。修一次缩进，两截就合成一个列表。
 *
 * 做法与边界：
 * - 只认「上一行就是列表项」这一种紧邻关系。隔了空行或正文的顶格围栏不动 ——
 *   那是作者真的想开一段独立代码，缩进进去反而改变了文档结构。
 * - **整段围栏一起**补前缀（开栏、代码内容、收尾）。CommonMark 会按开栏的缩进量
 *   统一剥掉，所以代码内容里的相对缩进不受影响，高亮与复制出来的文本都不变。
 * - 必须逐段跳过所有围栏，不能只看「列表项的下一行」：代码内容里以 `+ ` / `- ` 开头的
 *   续行（`         + (i != k-i ? …)`）长得和列表项一模一样，不跳完整段就会把
 *   真正的收尾围栏当成新的开栏，从此后面全部缩进错乱。
 * - 围栏没收尾（流式打字中）时，从开栏到文本末尾都补上 —— 与闭合后的表现一致，
 *   不会出现「打字时贴边、打完自动缩回去」的跳动。
 */
export function indentFencesInLists(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) return text
  const lines = text.split('\n')
  /** 上一行是列表项时它要求的缩进量；其它任何行都会清空 */
  let pending: string | null = null
  /** 当前所在的围栏：pad 非空表示这一段的缩进是本函数补的 */
  let fence: { char: string; pad: string } | null = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    if (fence !== null) {
      if (fence.pad) lines[i] = fence.pad + line
      if (isFenceCloser(line, fence.char)) fence = null
      continue
    }
    const opener = FENCE_LINE.exec(line)
    if (opener) {
      // 顶格（第 0 列）且上一行是列表项才补缩进；其余形态整段原样跳过。
      // 注意不能用 opener.index 判顶格 —— 正则带 ^，index 恒为 0，缩进得直接看行首字符。
      const atCol0 = line[0] === '`' || line[0] === '~'
      const pad = atCol0 && pending !== null ? pending : ''
      fence = { char: line.trim()[0]!, pad }
      if (pad) lines[i] = pad + line
      pending = null
      continue
    }
    const item = LIST_ITEM_LINE.exec(line)
    pending = item ? ' '.repeat(item[1]!.length + item[2]!.length + item[3]!.length) : null
  }
  return lines.join('\n')
}
