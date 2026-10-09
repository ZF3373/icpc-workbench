/**
 * `==高亮==` 重点标记（纯函数 + rehype 插件，无 React 依赖）。
 *
 * 背景：AI 回复里"重点"和"普通正文"此前只有 `**粗体**` 一种表达，而粗体在长回复里
 * 到处都是，读者扫不出真正的结论。本模块给模型一个更明确的手段：`==…==` 渲染成
 * 带底色的高亮标记，与粗体（术语/定义）分工不同。
 *
 * 为什么不能直接在字符串层替换成 `<mark>`：react-markdown 有意不开 rehype-raw，
 * 原始 HTML 一律按纯文本转义（安全姿态，见 Markdown.tsx 顶部注释）。所以在字符串层
 * 只把定界符换成**两个私有区哨兵字符**，让它们跟着文本走完公式管线，最后在 rehype
 * 阶段由本模块组装成真正的 mark 元素。
 *
 * 为什么要哨兵而不是保留 `==`：公式管线会把 `==` 当数学字符吃掉——
 * `==dp_i==` 经 wrapBareMath 变成 `$=dp_i=$`（normalizeMathSymbols 再把 `==` 压成 `=`），
 * `==f_{i,j}==` 更会被整行升级成块级公式 `$$=f_{i,j}=$$`。哨兵字符既不是数学种子
 * 也不在 isMathChar 里，管线完全看不见它们，而**里面的数学照常渲染**。
 *
 * 为什么要跨兄弟节点配对：`==$O(n)$==` 里哨兵之间夹着一个 KaTeX 元素，`==` 落在
 * 前后两个文本节点上，字符串层再也拼不回一整串。所以 rehype 插件按「同一父节点的
 * 兄弟序列」配对，把中间的所有节点（文本、公式、行内代码）整体包进 mark。
 *
 * 安全边界：哨兵字符（U+E000 / U+E001，Unicode 私有区）只由本模块生成；用户输入里
 * 偶然出现的同码位字符在管线入口就被剔除（stripMarkSentinels），所以"用户伪造哨兵"
 * 这条路径不存在。code/pre 里的哨兵一律还原成字面 `==`。
 */

/** 高亮开启哨兵（私有区 U+E000，正常文本中不会出现） */
export const MARK_OPEN = '\uE000'
/** 高亮关闭哨兵（私有区 U+E001） */
export const MARK_CLOSE = '\uE001'

/** 标记名（CSS 钩子 + 测试断言用），只此一处定义 */
export const MARK_CLASS = 'md-mark'

/** 词字符：`==` 紧贴词字符时不构成高亮（那是 `a==b` 这类比较写法） */
const WORD = /[\p{L}\p{N}_]/u

/** 一个已判定的定界符 */
export interface MarkDelimiter {
  /** 在整段文本中的下标 */
  at: number
  kind: 'open' | 'close'
}

/**
 * 在一行里按 CommonMark 强调定界符同款的「侧翼规则」判定 `==`。
 *
 * 规则存在的唯一目的：**绝不动相等比较**。
 *   · 开定界符前不能是词字符 —— `x==y==z` 不匹配（`x` 是词字符）；
 *   · 开定界符后不能是空白 —— `a == b` 不匹配（后面是空格）；
 *   · 闭定界符前不能是空白、后不能是词字符 —— `==x==y` 不匹配（后面是 `y`）。
 * 于是 `a == b`、`if (a == b)`、`cnt == 0`、`dp[i]==dp[j]` 全部原样保留，
 * 而 `==关键结论==`、`**==重点==**`、`==$O(n\log n)$==` 正常命中。
 *
 * 同一时刻只允许一个开定界符（遇到可开就开，遇到可闭就闭），与强调解析的
 * 贪心配对一致；这样 `==a== 和 ==b` 会被拆成「一对 + 一个未闭合」，而不是
 * 把两段并成一个大高亮。
 *
 * @param line 单行文本（不含换行符）
 * @param base line 首字符在整段文本中的下标（供 skip 判定）
 * @param skip 判断某下标是否位于代码区/公式区；那里 `==` 是内容，不是定界符
 */
export function scanMarkDelimiters(
  line: string,
  base: number,
  skip?: (i: number) => boolean,
): MarkDelimiter[] {
  if (!line.includes('==')) return []
  const events: MarkDelimiter[] = []
  let openAt = -1
  let i = 0
  while (i + 1 < line.length) {
    if (line[i] !== '=' || line[i + 1] !== '=') {
      i += 1
      continue
    }
    if (skip?.(base + i)) {
      // 代码区/公式区里的 `==` 是内容：整对跳过，且不影响配对状态
      i += 2
      continue
    }
    const prev = i > 0 ? line[i - 1]! : ''
    const next = line[i + 2] ?? ''
    const canOpen = (prev === '' || !WORD.test(prev)) && next !== '' && !/\s/.test(next)
    const canClose = prev !== '' && !/\s/.test(prev) && (next === '' || !WORD.test(next))
    if (openAt === -1 && canOpen) {
      openAt = i
      events.push({ at: base + i, kind: 'open' })
    } else if (openAt !== -1 && canClose) {
      openAt = -1
      events.push({ at: base + i, kind: 'close' })
    }
    i += 2
  }
  return events
}

/** 剔除用户输入里偶然出现的哨兵字符（幂等；防伪造，见文件头「安全边界」） */
export function stripMarkSentinels(text: string): string {
  return text.includes(MARK_OPEN) || text.includes(MARK_CLOSE)
    ? text.split(MARK_OPEN).join('').split(MARK_CLOSE).join('')
    : text
}

/**
 * 把文本里的 `==…==` 换成哨兵对（**不跨行**配对）。
 *
 * 只转换**真正配成对**的定界符：末尾那个落单的开定界符（`==a== 和 ==b` 里的第二个）
 * 原样保留。理由有二 ——
 *   · 转换了也没用：rehype 阶段发现哨兵不配平会整体还原成字面 `==`，白折腾一趟；
 *   · 流式期间更安全：少一次"先插哨兵、再还原"的往返，可见文本不会闪。
 * 流式的半成品由 `needsMarkClose` 补上收尾 `==` 后再进来，那时就是合法的一对了。
 *
 * 不跨行是刻意的：跨行配对会让一个高亮横跨两个段落，把 mark 撑成块级容器
 * （mark 是行内元素，跨块会让排版结构塌掉）。AI 写重点都是行内用法。
 */
export function replaceMarkDelimiters(text: string, skip?: (i: number) => boolean): string {
  if (!text.includes('==')) return text
  let out = ''
  let offset = 0
  for (const line of text.split('\n')) {
    const events = scanMarkDelimiters(line, offset, skip)
    // scanMarkDelimiters 产出的序列严格交替（open, close, open, …），
    // 所以奇数长度说明最后一个开定界符没配对 —— 丢掉它，只处理前偶数个
    const usable = events.length - (events.length % 2)
    if (usable === 0) {
      out += line
    } else {
      let last = 0
      for (let i = 0; i < usable; i += 1) {
        const ev = events[i]!
        const at = ev.at - offset
        out += line.slice(last, at) + (ev.kind === 'open' ? MARK_OPEN : MARK_CLOSE)
        last = at + 2
      }
      out += line.slice(last)
    }
    out += '\n'
    offset += line.length + 1
  }
  // 上面的循环给每行都补了 '\n'，末尾多一个，去掉
  return out.slice(0, -1)
}

/**
 * 流式自愈用：**最后一行**是否存在未闭合的高亮开定界符。
 *
 * 只看最后一行，因为补的收尾定界符会被追加到文本末尾 —— 若未闭合的开定界符
 * 在更早的行上，补出来的 `==` 与它隔着换行、永远配不成对（配对不跨行），
 * 反而会多出两个可见的 `==`。
 */
export function needsMarkClose(text: string, skip?: (i: number) => boolean): boolean {
  if (!text.includes('==')) return false
  const nl = text.lastIndexOf('\n')
  const line = nl === -1 ? text : text.slice(nl + 1)
  const base = nl === -1 ? 0 : nl + 1
  const events = scanMarkDelimiters(line, base, skip)
  return events.length > 0 && events[events.length - 1]!.kind === 'open'
}

/**
 * 兜底：去掉落在 `$…$` / `$$…$$` **内部**的哨兵。
 *
 * 正常路径下哨兵只会出现在公式之外（扫描阶段已跳过公式区），但围栏转公式、
 * 缩进块转公式等"改写"步骤可能把带哨兵的文本塞进 `$$` 里，而 KaTeX 遇到
 * 私有区字符会直接解析失败（公式退化成源码文本）。这里做最后一道闸：
 * 宁可丢掉一个高亮，也不能让公式崩掉。
 */
export function stripMarkSentinelsInMath(text: string): string {
  if (!text.includes(MARK_OPEN) && !text.includes(MARK_CLOSE)) return text
  return text
    .split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
    .map((seg, i) =>
      i % 2 === 1 ? seg.split(MARK_OPEN).join('').split(MARK_CLOSE).join('') : seg,
    )
    .join('')
}

/* ============================ rehype：哨兵 → mark 元素 ============================ */

/** 与 markdownBr.ts 一致的 hast 局部视图，避免展开完整联合类型 */
interface HastLike {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastLike[]
}

/**
 * 兄弟序列里的哨兵是否**结构合法**：先开后闭、任意时刻不欠开、最终恰好配平。
 *
 * 只数个数是不够的：`==a` 换行 `b==`（闭在开之前）个数相等，却会把后半段整段包进
 * 一个永不闭合的 mark。所以按栈模拟一遍，不合法就整体降级为字面 `==`。
 */
function marksWellFormed(children: HastLike[]): boolean {
  let depth = 0
  for (const child of children) {
    if (child.type !== 'text' || !child.value) continue
    for (const ch of child.value) {
      if (ch === MARK_OPEN) depth += 1
      else if (ch === MARK_CLOSE) {
        if (depth === 0) return false
        depth -= 1
      }
    }
  }
  return depth === 0
}

/** 哨兵还原成字面 `==`（未配对、或位于 code/pre 内时的降级显示） */
function literalize(node: HastLike): void {
  if (node.type === 'text' && node.value) {
    node.value = node.value.split(MARK_OPEN).join('==').split(MARK_CLOSE).join('==')
    return
  }
  for (const child of node.children ?? []) literalize(child)
}

/**
 * 处理一个父节点的子序列：把哨兵对之间的**所有兄弟节点**包进 `<mark class="md-mark">`。
 *
 * 用「收集器栈」而不是原地 splice：开哨兵之后追加的每个节点都该落进当前 mark，
 * 闭哨兵只是弹栈（与 markdownBr.ts 重建 children 数组的思路一致）。
 */
function wrapMarks(children: HastLike[]): HastLike[] {
  let hasSentinel = false
  for (const child of children) {
    if (child.type === 'text' && child.value && (child.value.includes(MARK_OPEN) || child.value.includes(MARK_CLOSE))) {
      hasSentinel = true
      break
    }
  }
  if (!hasSentinel) return children
  if (!marksWellFormed(children)) {
    for (const child of children) literalize(child)
    return children
  }

  const root: HastLike[] = []
  const stack: HastLike[][] = [root]
  const push = (node: HastLike): void => {
    stack[stack.length - 1]!.push(node)
  }

  for (const child of children) {
    if (child.type !== 'text' || !child.value || !(child.value.includes(MARK_OPEN) || child.value.includes(MARK_CLOSE))) {
      push(child)
      continue
    }
    // split 带捕获组 → 奇数位就是哨兵本身，偶数位是普通文本
    for (const piece of child.value.split(new RegExp(`([${MARK_OPEN}${MARK_CLOSE}])`))) {
      if (piece === '') continue
      if (piece === MARK_OPEN) {
        const mark: HastLike = {
          type: 'element',
          tagName: 'mark',
          properties: { className: [MARK_CLASS] },
          children: [],
        }
        push(mark)
        stack.push(mark.children!)
      } else if (piece === MARK_CLOSE) {
        // marksWellFormed 已保证不会欠开，长度判断只是防御
        if (stack.length > 1) stack.pop()
      } else {
        push({ type: 'text', value: piece })
      }
    }
  }
  return root
}

/**
 * rehype 插件：把哨兵对组装成 mark 元素。
 *
 * `pre` / `code` 内的哨兵还原成字面 `==`：那里是代码内容，不该变成高亮，
 * 更不能把私有区字符原样显示出来。
 */
export function rehypeMark() {
  const walk = (node: HastLike): void => {
    const children = node.children
    if (!children || children.length === 0) return
    if (node.tagName === 'pre' || node.tagName === 'code') {
      for (const child of children) literalize(child)
      return
    }
    node.children = wrapMarks(children)
    for (const child of node.children) walk(child)
  }
  return (tree: HastLike): void => {
    walk(tree)
  }
}
