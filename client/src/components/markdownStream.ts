/**
 * 流式未闭合 Markdown 容错（self-healing markdown，纯函数、无 React 依赖）。
 *
 * 背景：AI 逐字流式输出时，消息在**每一帧**都是半成品 —— `**加粗` 少了收尾、
 * ` ``` ` 围栏还没闭合、`$$…$$` 公式只写了一半、`` `dp_{i-1} `` 的反引号还没补上。
 * 半截的强调/代码定界符会在屏幕上闪出字面的 `**`、`` ` ``；半截的 `$$` 更糟，
 * 会把后续正文整段吞进公式源码里显示。
 *
 * 本模块只做一件事：**在"确实没写完"的位置补上收尾定界符**，其余一律不动。
 * 设计原则（与 markdownCode.ts 的「默认按代码处理」一脉相承）：
 *
 *   1. 能不动就不动。只有扫描出"有一个定界符开着且再没有配对的收尾"时才补。
 *   2. **围栏内绝不改动**。未闭合围栏的内容按代码块渲染本来就是正确结果，
 *      在里面补反引号/星号会把代码本身改坏。
 *   3. 补出来的内容必须满足本项目的排版不变量：
 *      `$$` 要独占一行（否则 remark-math 降级为行内公式，见 markdownMath 注释），
 *      引用块里的 `$$` 收尾还要带 `> ` 前缀（否则引用块被截断）。
 *   4. **snake_case 不是强调**：`push_back` / `dp_i` 的下划线两侧都是词字符，
 *      补一个 `_` 只会多出一个可见记号，所以按 remend 的做法跳过词内下划线。
 *   5. **单个 `$` 可能是货币符号**：只有尾部确实出现强数学特征（LaTeX 命令、
 *      上下标花括号、关系符）才补收尾 `$`。同 remend 默认关闭 inlineKatex 的取舍。
 *
 * 参考实现：vercel/streamdown 的 remend（同样的「一次扫描建表 + 按优先级修补」思路，
 * 但按本项目的公式管线重写，未引入任何新依赖）。
 */
import { needsMarkClose } from './markdownMark.ts'

/* ============================ 一次扫描：代码区 / 公式区 ============================ */

type MathKind = 'dollar' | 'bracket'

/** 一个未闭合的公式区（`$$` / `\[` / `$` / `\(`） */
interface OpenMath {
  kind: MathKind
  /** 块级（`$$` / `\[`）还是行内（`$` / `\(`） */
  block: boolean
  /** 开启定界符的下标 */
  at: number
  /**
   * `$$` 独占一行（允许前置空白与引用块 `> ` 前缀）时，记下这段前缀。
   * 收尾补的 `$$` 必须沿用同一前缀：引用块里补一个不带 `> ` 的 `$$`
   * 会把引用块截断，公式反而更碎。非行首的 `$$` 记 null（本来就不是块级写法，不猜）。
   */
  prefix: string | null
}

/**
 * 判断某个下标是否落在**代码区或公式区**（供 `==` 高亮扫描复用本模块的状态机）。
 *
 * `==` 有双重身份：高亮定界符，以及代码/公式里的相等运算符。逐个猜身份很脆弱，
 * 这里直接复用 scanStream 已经建好的字符级归属表 —— 代码区与公式区里的 `==`
 * 一律当内容（`if (a == b)`、`` `x == y` ``、`$a == b$` 都不受影响），
 * 只有正文区里的才可能是定界符。调用方传入的 text 必须与后续扫描的文本一致。
 */
export function codeOrMathSkip(text: string): (i: number) => boolean {
  const scan = scanStream(text)
  return (i: number) => scan.code[i] === 1 || scan.math[i] === 1
}

/** 扫描结果：字符级的代码/公式归属 + 尾部未闭合的定界符 */
export interface ScanResult {
  /** 1 = 该字符位于围栏代码块或行内代码内 */
  code: Uint8Array
  /** 1 = 该字符位于公式区内 */
  math: Uint8Array
  /** 尾部停在未闭合的围栏里（整段尾部都是代码，不做任何修复） */
  openFence: boolean
  /** 未闭合行内代码的开启反引号下标（-1 = 没有） */
  inlineCode: number
  /** 该行内代码的反引号个数（收尾要用等长的一串） */
  inlineTicks: number
  /** 未闭合的块级公式 */
  blockMath: OpenMath | null
  /** 未闭合的行内公式 */
  inlineMath: OpenMath | null
}

/** 可变的扫描状态（跨行保留：块级公式与围栏都可以跨行） */
interface ScanState {
  inlineCode: number
  inlineTicks: number
  open: OpenMath | null
}

const FENCE_START = /^[ \t]*(`{3,}|~{3,})/
const FENCE_END = /^[ \t]*(`{3,}|~{3,})[ \t]*$/

/** 行首允许的前缀：空白 + 引用块标记（`$$` 在引用块里同样算块级公式） */
const LINE_PREFIX = /^[ \t]*(?:>[ \t]?)*$/

/**
 * 扫描整段文本，得到「每个字符属于代码区 / 公式区」的查表，
 * 以及尾部哪些定界符还开着（一次 O(n) 扫描，供各修复器复用）。
 *
 * 状态机刻意贴近 remark 的实际解析规则：
 *   · 围栏（``` / ~~~）只在行首生效，未闭合的围栏吞掉之后所有行；
 *   · 反引号 span 与**行内**公式（`$…$`、`\(…\)`）都不跨行，换行即作废；
 *   · `$$` 与 `\[…\]` 可以跨行。
 * 跨行规则很关键：若把上一行那个孤立的 `$` 当成"还开着"，就会在文末补一个
 * 凭空多出来的 `$`，与紧随其后的 `$` 拼成 `$$`，把一个普通符号变成块级公式。
 */
function scanStream(text: string): ScanResult {
  const len = text.length
  const code = new Uint8Array(len)
  const math = new Uint8Array(len)
  let fence: { ch: string; len: number } | null = null
  const st: ScanState = { inlineCode: -1, inlineTicks: 0, open: null }

  let lineStart = 0
  for (;;) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? len : nl
    // 行内代码与行内公式都不跨行：换到新的一行就把上一行的未闭合状态作废
    if (st.inlineCode >= 0) {
      st.inlineCode = -1
      st.inlineTicks = 0
    }
    if (st.open && !st.open.block) st.open = null

    if (fence) {
      for (let i = lineStart; i < lineEnd; i++) code[i] = 1
      const m = FENCE_END.exec(text.slice(lineStart, lineEnd))
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len) fence = null
    } else if (st.open) {
      // 块级公式跨行：整行按公式区继续扫描（末尾的收尾定界符之后回到文本区）
      scanChars(text, lineStart, lineEnd, code, math, st)
    } else {
      const m = FENCE_START.exec(text.slice(lineStart, lineEnd))
      if (m) {
        fence = { ch: m[1]![0]!, len: m[1]!.length }
        for (let i = lineStart; i < lineEnd; i++) code[i] = 1
      } else {
        scanChars(text, lineStart, lineEnd, code, math, st)
      }
    }

    if (nl === -1) break
    lineStart = nl + 1
  }

  return {
    code,
    math,
    openFence: fence !== null,
    inlineCode: st.inlineCode,
    inlineTicks: st.inlineTicks,
    blockMath: st.open && st.open.block ? st.open : null,
    inlineMath: st.open && !st.open.block ? st.open : null,
  }
}

/** 扫描一行内的行内代码 / 公式定界符（状态跨行保留在 st 里） */
function scanChars(text: string, from: number, to: number, code: Uint8Array, math: Uint8Array, st: ScanState): void {
  for (let i = from; i < to; i++) {
    const ch = text[i]!

    // ---- 行内代码内：只找等长的收尾反引号 ----
    if (st.inlineCode >= 0) {
      code[i] = 1
      if (ch === '\\' && i + 1 < to) {
        code[i + 1] = 1
        i++
        continue
      }
      if (ch !== '`') continue
      let run = 0
      while (i + run < to && text[i + run] === '`') run++
      for (let k = 0; k < run; k++) code[i + k] = 1
      if (run === st.inlineTicks) {
        st.inlineCode = -1
        st.inlineTicks = 0
      }
      i += run - 1
      continue
    }

    // ---- 公式区内：只找配对的收尾定界符 ----
    if (st.open) {
      const o = st.open
      math[i] = 1
      if (ch === '\\' && i + 1 < to) {
        const nx = text[i + 1]!
        math[i + 1] = 1
        // `\[ … \]` 只认 `\]`；`\( … \)` 只认 `\)`（`\\` 是 LaTeX 换行，照常跳过）
        if (o.kind === 'bracket' && ((o.block && nx === ']') || (!o.block && nx === ')'))) st.open = null
        i++
        continue
      }
      if (o.kind !== 'dollar' || ch !== '$') continue
      if (o.block) {
        // 块级 `$$` 必须是连续两个
        if (text[i + 1] !== '$') continue
        math[i + 1] = 1
        st.open = null
        i++
        continue
      }
      st.open = null
      continue
    }

    // ---- 文本区 ----
    if (ch === '\\' && i + 1 < to) {
      const nx = text[i + 1]!
      if (nx === '(' || nx === '[') {
        // `\(` / `\[` 不是转义，是 LaTeX 公式定界符
        math[i] = 1
        math[i + 1] = 1
        st.open = { kind: 'bracket', block: nx === '[', at: i, prefix: null }
      } else if (nx === '$') {
        // `\$` 是转义美元号：既不开启也不关闭公式
        math[i] = 1
        math[i + 1] = 1
      }
      i++
      continue
    }
    if (ch === '`') {
      let run = 0
      while (i + run < to && text[i + run] === '`') run++
      for (let k = 0; k < run; k++) code[i + k] = 1
      st.inlineCode = i
      st.inlineTicks = run
      i += run - 1
      continue
    }
    if (ch === '$') {
      let run = 0
      while (i + run < to && text[i + run] === '$') run++
      // scanChars 总是按行调用，from 就是行首：`$$` 之前只有空白/引用块前缀才算独占一行
      const before = text.slice(from, i)
      const prefix = LINE_PREFIX.test(before) ? before : null
      if (run >= 2) {
        math[i] = 1
        math[i + 1] = 1
        st.open = { kind: 'dollar', block: true, at: i, prefix }
        i++
        continue
      }
      math[i] = 1
      st.open = { kind: 'dollar', block: false, at: i, prefix: null }
      continue
    }
  }
}

/* ============================ 补收尾定界符 ============================ */

/** 行内公式/行内代码的收尾必须紧跟非空白字符，否则 remark 不认这个定界符 */
function closableInline(body: string): boolean {
  return body.trim().length > 0 && !/\s$/.test(body)
}

/**
 * 尾部这段（未闭合 `$` 之后的内容）是否"确实是公式"。
 *
 * 单个 `$` 在中文里常是货币符号（`$5`、`US$100`），补一个 `$` 会把金额变成公式；
 * 所以要求出现**强数学特征**（LaTeX 命令 / 上下标花括号 / 关系符 / Unicode 数学符号），
 * 且整段不是纯金额形态 —— 与 markdownCode.ts「默认不是数学，有强特征才升级」同一原则。
 */
function looksLikeMathTail(body: string): boolean {
  if (!closableInline(body)) return false
  if (/^\s*\d[\d,.]*\s*$/.test(body)) return false
  return /\\[a-zA-Z]|[_^{}]|[≤≥≠∈∉∪∩√∞→←×·]|[=+*/]\s*[a-zA-Z0-9\\]/.test(body)
}

/**
 * 修掉**写了一半的链接/图片**：`[快速排序](https://examp` 在渲染时会原样显示成
 * 一串字面 `](https://examp`，是流式里最刺眼的"源码泄漏"。
 *
 * 做法：只认"正文已收尾、URL 还没收尾"的形态（`[…](` 之后到串尾没有 `)`），
 * 从 `[` 处整段截掉 —— 让链接在写完的那一帧整条出现，而不是逐字符长出来。
 * 只有 `[` 而没有 `](` 的形态不动（`a[i]` 写到一半的 `a[i` 渲染出来就是一个
 * 普通 `[`，截掉反而会让已经打出来的字缩回去，抖得更明显）。
 *
 * 代码区与公式区内的 `[` 一律跳过（`a[prev]` 是下标，不是链接）。
 */
function repairIncompleteLinks(text: string, scan: ScanResult): string {
  let start = -1
  for (let i = text.length - 1; i >= 0; i--) {
    if (scan.code[i] || scan.math[i]) continue
    if (text[i] === '[') {
      start = i
      break
    }
  }
  if (start === -1) return text
  const rest = text.slice(start)
  // `!?` 同时覆盖图片；`[^)\n]*$` 保证 URL 部分确实还没闭合
  if (/^!?\[[^\]\n]*\]\([^)\n]*$/.test(rest)) {
    // 图片语法连前面的 `!` 一起截掉，否则会剩下一个孤零零的感叹号
    if (start > 0 && text[start - 1] === '!' && !scan.code[start - 1] && !scan.math[start - 1]) start--
    return text.slice(0, start)
  }
  return text
}

/** 词内单个 `~` 转义：GFM 的单波浪线删除线会把 `20~25` 当成删除线定界符 */
function escapeWordTildes(text: string, scan: ScanResult): string {
  return text.replace(/([\p{L}\p{N}_])~(?!~)(?=[\p{L}\p{N}_])/gu, (m, _p: string, offset: number) =>
    scan.code[offset] || scan.math[offset] ? m : `${m[0]}\\~`,
  )
}

interface DelimRun {
  at: number
  /** 还没被配掉的定界符个数 */
  len: number
  canOpen: boolean
  canClose: boolean
}

/** 收集某一类定界符（`*` / `_` / `~`）的连续段，并判断它能不能开 / 能不能收 */
function collectRuns(text: string, scan: ScanResult, ch: string): DelimRun[] {
  const runs: DelimRun[] = []
  const word = /[\p{L}\p{N}_]/u
  let i = 0
  while (i < text.length) {
    if (text[i] !== ch || scan.code[i] || scan.math[i] || text[i - 1] === '\\') {
      i++
      continue
    }
    let len = 0
    while (i + len < text.length && text[i + len] === ch && !scan.code[i + len] && !scan.math[i + len]) len++
    const prev = i > 0 ? text[i - 1]! : ''
    const next = text[i + len] ?? ''
    // 词内下划线不是强调（push_back / dp_i / sync_with_stdio）：
    // 两侧都是词字符时既不能开也不能收，补一个 `_` 只会多出一个可见记号
    const intraword = ch === '_' && word.test(prev) && word.test(next)
    runs.push({
      at: i,
      len,
      // `_` 还不能跟在词字符后面开（`a_b` 里的 `_` 不是定界符），`*` 无此限制
      canOpen: !intraword && next !== '' && !/\s/.test(next) && !(ch === '_' && word.test(prev)),
      canClose: !intraword && prev !== '' && !/\s/.test(prev),
    })
    i += len
  }
  return runs
}

/**
 * 找出所有「开着但没配对」的强调定界符，返回按嵌套顺序排列的收尾串（没有则返回空串）。
 *
 * 逐段配对（能收就收，收不完的继续挂着），流结束后还挂在栈上的就是没写完的。
 * 定界符分 `*` / `_` / `~` 三类各自配对 —— 它们互不成对，`*a_` 不是合法强调。
 */
function unclosedDelimiters(text: string, scan: ScanResult): string {
  const pending: Array<{ at: number; closer: string }> = []
  for (const ch of ['*', '_', '~']) {
    const stack: DelimRun[] = []
    for (const run of collectRuns(text, scan, ch)) {
      let len = run.len
      if (run.canClose && stack.length > 0) {
        const opener = stack[stack.length - 1]!
        // 双方都够长时按 2 个成对（** 加粗），否则按 1 个（* 斜体 / ~ 删除线）
        const used = opener.len >= 2 && len >= 2 ? 2 : 1
        opener.len -= used
        len -= used
        if (opener.len <= 0) stack.pop()
      }
      if (len > 0 && run.canOpen) stack.push({ at: run.at + (run.len - len), len, canOpen: true, canClose: false })
    }
    /**
     * 栈里**所有**未闭合的开定界符都要收尾，而不只是栈顶那个。
     *
     * 原实现只取 stack[stack.length - 1]（最内层），与本函数末尾「后开的先收」的注释
     * 相矛盾：嵌套未闭合时外层永远补不上，可见文本里就留下字面的 `**`。
     * 实测流式半成品 `**bold and *italic` → 只补成 `**bold and *italic*`，
     * 渲染结果是字面的 `**bold and ` + 斜体，用户看到的正是那串星号。
     * 正确收尾是 `**bold and *italic***`（先闭 em、再闭 strong）。
     * 这里按「最内层 → 最外层」推入 pending，外层靠下面的 at 降序排到后面。
     */
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const opener = stack[k]!
      pending.push({ at: opener.at, closer: ch.repeat(opener.len) })
    }
  }
  // 后开的先收（`**外层` 里再开 `_内层` → 收尾顺序是 `_**`）
  return pending
    .sort((a, b) => b.at - a.at)
    .map((p) => p.closer)
    .join('')
}

/* ============================ 入口 ============================ */

/**
 * 补上流式输出里未闭合的 Markdown 定界符，并截掉写了一半的链接
 * （仅在"正在流式输出"时调用）。
 *
 * 完整消息不要调用本函数：一段已经写完的文本里出现单个 `*`/`_`/`$` 是正常写法
 * （`2 * 3`、`价格 $5`、`a_b`），补符号反而会改变原意。
 *
 * @param text 当前已收到的原文（未经 preprocessMath 预处理）
 * @returns 补齐收尾定界符后的文本；没有任何未闭合结构时原样返回
 */
export function repairStreamingMarkdown(text: string): string {
  // 快速返回：没有任何可能未闭合的定界符字符时不必扫描
  // （`[` 也要算进来：写了一半的链接同样需要修；`=` 覆盖 `==高亮==`）
  if (!text || !/[*_~`$\\[=]/.test(text)) return text

  let out = text
  let scan = scanStream(out)

  // 1. 未闭合围栏：内容按代码块渲染本来就是正确结果，任何补符号都可能改坏代码
  if (scan.openFence) return out

  // 2. 未闭合行内代码：补等长反引号（内容为空则不动 —— 空 span 不合法，
  //    而且补出来的反引号可能与后文的反引号拼成四个而误判为围栏）
  if (scan.inlineCode >= 0) {
    const body = out.slice(scan.inlineCode + scan.inlineTicks)
    if (body.trim()) out += '`'.repeat(scan.inlineTicks)
  }

  // 3. 未闭合块级公式
  scan = scanStream(out)
  const block = scan.blockMath
  if (block) {
    if (block.kind === 'bracket') out += '\\]'
    // `$$` 只有独占一行（可带引用块前缀）时才是块级公式；
    // 行中间的 `$$` 本来就是畸形写法，补一个收尾也变不成合法公式，不猜
    else if (block.prefix !== null) out += `\n${block.prefix}$$`
  }

  // 4. 未闭合行内公式：`\[`/`\(` 无歧义，直接补；单个 `$` 需要强数学特征
  scan = scanStream(out)
  const inline = scan.inlineMath
  if (inline) {
    const body = out.slice(inline.at + (inline.kind === 'bracket' ? 2 : 1))
    if (inline.kind === 'bracket') {
      if (closableInline(body)) out += '\\)'
    } else if (looksLikeMathTail(body)) {
      out += '$'
    }
  }

  // 5. 写了一半的链接/图片：`[…](https://examp` 整段截掉，避免闪出字面 `](`
  scan = scanStream(out)
  out = repairIncompleteLinks(out, scan)

  // 6. 词内单个 `~`：先把 `20~25` 这类转义掉，再谈删除线定界符
  scan = scanStream(out)
  out = escapeWordTildes(out, scan)

  // 7. 未闭合的强调定界符（`**加粗` / `*斜体` / `~~删除线`）
  scan = scanStream(out)
  out += unclosedDelimiters(out, scan)

  // 8. 未闭合的 `==高亮==`。必须排在强调之后：`==**重点` 要先补成 `==**重点**`
  //    再补 `==`，否则收尾顺序反了会得到 `==**重点==**`（高亮与加粗互相穿插）。
  //    只看最后一行（配对不跨行），代码区/公式区里的 `==` 是内容不参与。
  if (needsMarkClose(out, codeOrMathSkip(out))) out += '=='

  return out
}

/* ============================ 增量渲染：稳定块切点 ============================ */

/**
 * 找「已写定的部分」与「还在增长的部分」的分界，供 Markdown 组件做增量渲染。
 *
 * AI 一帧一帧追加内容时，只有**最后一个块**会变，前面所有块早就定稿了。
 * 把文本从这里切成两段分别渲染：前段交给 memo 过的 Markdown（字符串没变就整段
 * 跳过解析与 KaTeX 排版），只有尾段每帧重来 —— 这就是「边生成边渲染」里
 * 真正省下重复渲染的那一刀。
 *
 * 切点必须同时满足三个条件，否则宁可不切（返回 -1）：
 *   1. 是一个空行（`\n\n`）—— 块级边界；
 *   2. 在代码区/公式区之外 —— 围栏里、公式里的空行是内容，切开会撕裂代码块；
 *   3. 前面已经有足够长的稳定内容 —— 太短的文档切了也没收益。
 *
 * @returns 切点下标（前段取 `[0, cut)`，尾段取 `[cut, ...)`）；无安全切点时返回 -1
 */
export function findStableBlockSplit(text: string, minPrefix = 600): number {
  if (text.length < minPrefix + 64) return -1
  const scan = scanStream(text)
  const limit = text.length - 2
  for (let i = limit; i >= minPrefix; i--) {
    if (text[i] !== '\n' || text[i + 1] !== '\n') continue
    // 两个 `\n` 都必须落在代码区与公式区之外（围栏/公式内部的空行是内容）
    if (scan.code[i] || scan.math[i] || scan.code[i + 1] || scan.math[i + 1]) continue
    return i + 2
  }
  return -1
}
