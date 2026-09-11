/**
 * Markdown 数学公式预处理管线（纯函数，无 React 依赖，便于单元测试）。
 *
 * AI 输出的数学内容存在多种"不规范"形式，remark-math 只认 $...$ / $$...$$ 定界符，
 * 此处在渲染前做一次性归一化：
 *   1. stripOuterCodeFence  剥离误加的外层代码围栏
 *   2. normalizeMathDelimiters  \(...\) / \[...\] → $ / $$
 *   3. wrapBareMath  裸数学片段与"数学代码块"→ $...$ / $$...$$
 *   4. normalizeMathSymbols  公式内的 Unicode 符号 → LaTeX 命令
 */
/**
 * 剥离 AI 输出中误加的外层 Markdown 围栏：当整段回复被 ```markdown 包裹时，
 * ReactMarkdown 会将其渲染为 <pre><code> 而非解析内部 markdown，此处提取围栏内的正文。
 *
 * 只剥「语言标记为空或 markdown 系」的围栏——其他语言（cpp/py 等）说明内容确实是
 * 代码，整段就是代码块，剥掉围栏会让代码变裸文本、进而被数学包裹逻辑污染
 * （如 ios::sync_with_stdio 被包进 $...$）。内部还嵌套围栏时也不剥。
 */
export function stripOuterCodeFence(text: string): string {
  const m = text.match(/^```([a-zA-Z]*)\n([\s\S]*)\n?```\s*$/)
  if (!m) return text
  const lang = m[1].toLowerCase()
  // markdown 系语言标记（含空）才可能是 AI 误包的 Markdown 内容
  const isMarkdownish = lang === '' || lang === 'markdown' || lang === 'md'
  const body = m[2]
  if (isMarkdownish && !body.includes('```')) return body
  return text
}

/** Markdown 中的「非文本区」：围栏代码块、行内代码、已有公式（$...$ / $$...$$） */
const CODE_OR_MATH = /(```[\s\S]*?```|`[^`\n]+`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g

/**
 * 对 Markdown 源文本中「普通文本区」（代码块/行内代码/已有公式之外的部分）做转换。
 * 其余部分原样保留 —— 代码块里的下划线标识符、公式内部的内容都不能被二次处理。
 */
function transformTextRegions(text: string, fn: (s: string) => string): string {
  return text
    .split(CODE_OR_MATH)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('')
}

/**
 * 把 AI 常用的 LaTeX 公式定界符统一为 remark-math 能识别的 $ 格式。
 *
 * remark-math (v6) 仅支持 $...$（行内）和 $$...$$（块级），但 AI 模型（尤其是
 * 数学/算法场景）经常输出 \(...\) 和 \[...\] 定界符，这些不会被识别为公式而是
 * 当作普通文本渲染。此处做一次性转换：
 *   \[...\]  →  $$...$$   （块级公式，跨行）
 *   \(...\)  →  $...$      （行内公式）
 *
 * 注意：必须先处理 \[...\]（双字符定界符），再处理 \(...\)，避免误匹配。
 * 转换在代码块/行内代码/已有公式之外进行（代码块中的 LaTeX 不应被渲染为公式）。
 */
export function normalizeMathDelimiters(text: string): string {
  return transformTextRegions(text, (part) =>
    part
      // 块级公式 \[...\] → $$...$$
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `$$${body}$$`)
      // 行内公式 \(...\) → $...$
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body}$`),
  )
}

/**
 * 检测并包裹 AI 输出中的「裸数学」片段为 $...$，使其能被 remark-math 识别渲染。
 *
 * AI 模型（尤其数学/算法场景）经常输出不带任何定界符的数学表达式，例如：
 *   - 下标：need_i, f_{i mod a_m}, c_i, a_m
 *   - 上标：2^k, 2^j, 2^{j+1}
 *   - LaTeX 命令：\frac{n(n+1)}{2}, \sum_{i=1}^{n}, \sqrt{V}
 *   - 复杂度：O(V²/B log V), O(V√V log V)（这些含特殊符号，已能正常显示）
 *   - 赋值式：f_{i mod a_m} ← f_{i mod a_m} + f_i / c_i
 *
 * 此外，AI 常把数学公式放在代码块中（避免 Markdown 语法干扰），如：
 *   ```
 *   O(n·3^{n/6})
 *   ```
 *   `f_{i mod a_m} ← f_{i mod a_m} + f_i / c_i`
 * 这些代码块的内容实际上是数学公式而非代码，需要识别并转为 $$...$$ / $...$ 渲染。
 *
 * 策略：
 * 1. 先把"内容像数学公式"的代码块/行内代码转为 $$...$$ / $...$（在分段处理前）
 * 2. 再按代码块/已有公式分段，对普通文本段做裸数学检测包裹
 */
export function wrapBareMath(text: string): string {
  // 第一步：把"数学代码块"转为 display math
  // 匹配 ```lang\n...\n``` 形式的代码块（lang 可含 Unicode/特殊字符，如 cᵢ、d₁[v]）
  // 内容含数学特征时转为 $$...$$；lang 本身像数学且 body 为空时也转（如 ```cᵢ\n``` → $cᵢ$）
  text = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, lang: string, body: string) => {
    const trimmedBody = body.trim()
    const trimmedLang = lang.trim()
    // body 有内容且像数学 → 块级公式（$$ 独占行，前后空行确保 remark-math 正确解析）
    // 必须同时排除 looksLikeCode：C/C++ 代码中的 '\n' '\t' 等转义序列会被
    // looksLikeMath 的 \\[a-zA-Z]+ 模式误判为 LaTeX 命令，导致代码块被错误转为公式
    if (trimmedBody && looksLikeMath(trimmedBody) && !looksLikeCode(trimmedBody)) {
      // body 已含 $ / $$ 定界符 → 是"文本 + 内联数学"混合内容，不是纯公式。
      // 转成 $$...$$ 会让内部 $ 造成嵌套/截断，应去掉围栏让内容按普通 markdown + 内联公式渲染
      if (/\$/.test(trimmedBody)) return `\n\n${trimmedBody}\n\n`
      return `\n\n$$\n${trimmedBody}\n$$\n\n`
    }
    // body 为空但 lang 像数学（AI 把单行公式写成 ```公式\n```，lang 被当作语言标识符）
    if (!trimmedBody && trimmedLang && looksLikeMath(trimmedLang) && !looksLikeCode(trimmedLang)) {
      return `\n\n$$\n${trimmedLang}\n$$\n\n`
    }
    // body 有内容但不像数学，lang 像数学（如 ```d₁[v]\n+ dₙ[v] = D\n```）
    // 此时 lang 是公式的一部分，body 是其余部分，合并为公式
    if (trimmedBody && trimmedLang && looksLikeMath(trimmedLang) && !looksLikeCode(trimmedBody)) {
      return `\n\n$$\n${trimmedLang}\n${trimmedBody}\n$$\n\n`
    }
    return '```' + lang + '\n' + body + '```' // 非数学，保留原样
  })
  // 缩进代码块（4+ 空格）：AI 偶尔用缩进而非围栏表示代码块，
  // 若内容像数学且含 $ 定界符，则去掉缩进让它按普通文本 + 内联公式渲染
  text = text.replace(/(?:^|\n)([ \t]{4,}[^\n]+(?:\n[ \t]{4,}[^\n]+)*)/g, (match, block: string) => {
    const body = block.replace(/[ \t]{4,}/g, '').trim()
    if (body && looksLikeMath(body) && !looksLikeCode(body) && /\$/.test(body)) {
      return `\n\n${body}\n\n`
    }
    return match // 非数学混合内容，保留缩进代码块原样
  })
  // 匹配行内代码 `...`，内容含数学特征且不像真实代码时转为 $...$
  // 若 body 已含 $ 定界符则不转换：内部 $ 会在 $...$ 包裹后嵌套/截断
  text = text.replace(/`([^`\n]+)`/g, (_, body: string) => {
    if (looksLikeMath(body) && !looksLikeCode(body) && !/\$/.test(body)) return `$${body}$`
    return '`' + body + '`'
  })

  // 第二步：对普通文本做裸数学包裹。
  // 关键：必须用 transformTextRegions 分段，跳过围栏代码块（第一步已决定保留为代码的）
  // 与已有公式。否则 C++ 代码里的 sync_with_stdio / push_back 等下划线标识符、
  // "\n" 转义序列都会被当成数学种子包进 $...$，破坏代码高亮并渲染出 ∗∗ 之类的乱码。
  return transformTextRegions(text, (part) => wrapMathInText(part))
}

/**
 * 判断文本是否"看起来像数学公式"而非普通代码。
 * 含数学特征符号（下标/上标/LaTeX命令/求和/根号/赋值箭头等）且不含典型代码特征。
 */
function looksLikeMath(text: string): boolean {
  // 数学特征：下标 _{...} 或 _letter、上标 ^{...} 或 ^letter、LaTeX 命令、
  // 求和/连乘符号、根号、赋值箭头 ←、数学比较符 ≤≥≠、点乘 ·、地板天花板 ⌊⌋⌈⌉、
  // Unicode 下标/上标字符（ᵢ ₁ ₂ ₙ 等）
  // 注意：不含单箭头 → —— "q1 → q2" 这类链式关系文本太常见，误伤面大
  return /([a-zA-Z]_\{|[a-zA-Z]_[a-zA-Z0-9]|\^\{|\\\\[a-zA-Z]+|[₁₂₃₄₅₆₇₈₉₀ₙᵢⱼ₊₋₌₍₎]|[¹²³⁴⁵⁶⁷⁸⁹⁰]|Σ|∑|∏|√|⌊|⌋|⌈|⌉|←|≤|≥|≠|·|⊕|⊗|ω|ℓ|π|∈|∪|∩|∀|∃|∂|∞)/.test(text)
}

/**
 * 判断文本是否"看起来像真实代码"（而非数学公式）。
 * 含分号、赋值 =（非比较）、函数定义、控制流等代码特征时为真。
 */
function looksLikeCode(text: string): boolean {
  // 典型代码特征：分号结尾、=> 箭头函数、function/def/const/let/var 关键字、
  // 多行代码（含换行且像语句）、花括号代码块、if/for/while 等
  return /(;\s*$|=>|function |const |let |var |def |#\s*include|printf|scanf|cout|cin|return |import |from )/.test(text)
}

/**
 * 在纯文本段中检测裸数学片段并包裹 $...$。
 * 匹配策略：找到以数学特征字符（下标 _、上标 ^、LaTeX 反斜杠命令、← 箭头）为核心的
 * 连续 token 串，向前后扩展到词边界，整体包裹。
 */
function wrapMathInText(text: string): string {
  // 核心数学模式（按优先级）：
  // 1. LaTeX 命令：\frac{...}{...}, \sum_{...}^{...}, \sqrt{...}, \leq, \geq, \cdot, \times 等
  // 2. 变量下标：letter_{...} 或 letter_letter（如 f_{i mod a_m}, need_i, c_i）
  // 3. 上标表达式：base^{...} 或 base^c（如 2^{j+1}, 2^k, n^2）
  // 4. 赋值箭头式：... ← ...（含 ← 的数学赋值语句）
  //
  // 把这些模式作为一个"数学种子"，然后向两侧贪心扩展相邻的数学 token
  // （数字、运算符、变量名、括号等），形成完整片段后用 $...$ 包裹。

  // 先按行处理（数学表达式通常不跨行，除了 O(...) 复杂度）
  return text
    .split('\n')
    .map((line) => wrapMathInLine(line))
    .join('\n')
}

/**
 * 匹配一个"数学种子"：任何包含下标/上标/LaTeX命令/数学符号的 token。
 * 注意不含单箭头 → —— "q1 → q2" 这类链式文本（如拓扑序、状态转移）太常见，
 * 会把整个句子都卷进公式。
 */
const MATH_SEED = /(?:[a-zA-Z]+_\{[^}]*\}|[a-zA-Z]+_[a-zA-Z0-9]+|[0-9a-zA-Z]\^\{[^}]*\}|[0-9a-zA-Z]\^[0-9a-zA-Z]+|\\[a-zA-Z]+\{?[^$\n]*|←|·|V²|V³|√|≤|≥|≠|∈|∉|∪|∩|⊕|⊗|∀|∃|Σ|Π|∑|∏|ℓ)/

/**
 * 判断字符是否可以纳入数学片段（向种子两侧扩展时用）。
 * 在原 ASCII 数学字符之外补充：… − · ⇔ ⇒ ⇐ ≤ ≥ ≠ ← → ↔ （AI 常用的 Unicode 数学符号，
 * 若不含它们，"Σ(ri − li + 1)"、"O(n·3^{n/6})" 这类公式会在 − / · 处断成残缺片段）。
 */
function isMathChar(ch: string): boolean {
  return /[a-zA-Z0-9+\-*/^_=<>{}\[\]().,|…−·⇔⇒⇐∩∪⊕⊗⊆⊇∈∉≤≥≠√²³←→↔ℓΣΠ∑∏∀∃∂∇∞x]/.test(ch)
}

function wrapMathInLine(line: string): string {
  let result = ''
  let pos = 0
  while (pos < line.length) {
    const remaining = line.slice(pos)
    const seedMatch = MATH_SEED.exec(remaining)
    if (!seedMatch) {
      result += remaining
      break
    }
    const seedStart = seedMatch.index
    const seedEnd = seedStart + seedMatch[0].length

    // 从种子两侧贪心扩展：向前收集连续的数学字符，向后也收集
    let start = pos + seedStart
    let end = pos + seedEnd

    // 向前扩展（跳过空格也算，因为 "f_{i mod a_m} ← f_{i mod a_m} + f_i / c_i" 中间有空格）
    // 但向前只扩展连续数学字符（不含空格，避免吞掉太多普通文本）
    while (start > pos && isMathChar(line[start - 1])) start--

    // 向后扩展：连续数学字符 + 受限空格（空格后必须跟数学字符）
    while (end < line.length) {
      if (isMathChar(line[end])) {
        end++
      } else if (line[end] === ' ' && end + 1 < line.length && isMathChar(line[end + 1])) {
        // 空格两侧都是数学字符时纳入（如 "f_i / c_i"、"v ← v"）
        // 但要检查空格前是否确实是数学上下文（前一个非空字符是数学字符）
        end++
      } else {
        break
      }
    }

    // Markdown 强调定界符（**bold** / *italic*）不能进入公式内部：
    // KaTeX 会把 ** 渲染成 ∗∗ 并连带破坏外部加粗。把它们留在公式外面。
    while (start < end && (line[start] === '*' || line[start] === '_')) start++
    while (end > start && line[end - 1] === '*') end--

    // 提取片段并包裹
    const fragment = line.slice(start, end)
    // 确保片段确实包含数学特征（避免误包裹纯英文单词）。
    // 片段与已输出部分可能重叠（种子匹配可以在向前扩展越过的区域内再次命中），
    // 用 max(start, consumed) 收敛起点，防止 "g[prev].push_back" 被输出两遍。
    const fragStart = Math.max(start, pos)
    if (fragStart >= end) {
      // 片段整体都在已消费区域内（强调定界符剥离后为空），跳过
      pos = end
      continue
    }
    const visible = line.slice(fragStart, end)
    if (MATH_SEED.test(fragment)) {
      // 前缀（向前扩展越过的部分）原样输出，避免重复
      if (fragStart > pos) result += line.slice(pos, fragStart)
      result += `$${visible}$`
    } else {
      if (fragStart > pos) result += line.slice(pos, fragStart)
      result += visible
    }
    pos = end
  }
  return result
}

/**
 * 把数学片段中的 KaTeX 不兼容字符转为合法 LaTeX：
 * - 特殊字符转义：& → \&, # → \#, % → \%（KaTeX 中 & 是表格分隔符、# 是宏参数、% 是注释）
 * - Unicode 数学符号 → LaTeX 命令（KaTeX 不认识 ¬ ⊕ ⊗ ℓ 等 Unicode 符号）
 * 仅在 $...$ / $$...$$ 包裹的数学内容内做转换，不影响普通文本。
 */
export function normalizeMathSymbols(text: string): string {
  // 按公式分段：只处理 $...$ / $$...$$ 内的内容
  const segments = text.split(/(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
  return segments
    .map((seg, i) => {
      if (i % 2 === 0) return seg // 普通文本：不转换
      // 数学片段：去掉外层 $ 后转换内容，再重新包裹
      const isBlock = seg.startsWith('$$')
      const body = isBlock ? seg.slice(2, -2) : seg.slice(1, -1)
      const converted = body
        // LaTeX 命令保护：不转换已存在的 \& \# \% 等
        .replace(/(?<!\\)&/g, '\\&')
        .replace(/(?<!\\)#/g, '\\#')
        .replace(/(?<!\\)%/g, '\\%')
        // Unicode 数学符号 → LaTeX 命令
        .replace(/¬/g, '\\neg ')
        .replace(/⊕/g, '\\oplus ')
        .replace(/⊗/g, '\\otimes ')
        .replace(/ℓ/g, '\\ell ')
        .replace(/≤/g, '\\le ')
        .replace(/≥/g, '\\ge ')
        .replace(/≠/g, '\\ne ')
        .replace(/·/g, '\\cdot ')
        .replace(/×/g, '\\times ')
        .replace(/÷/g, '\\div ')
        .replace(/→/g, '\\to ')
        .replace(/←/g, '\\leftarrow ')
        .replace(/↔/g, '\\leftrightarrow ')
        // Unicode 省略号/减号 → LaTeX 等价物（KaTeX 把 … 渲染成文本省略号，
        // 数学排版应为 \dots；− 是 Unicode 数学减号，KaTeX 可直接显示但转为 - 更稳）
        .replace(/…/g, '\\dots ')
        .replace(/−/g, '-')
        .replace(/√/g, '\\sqrt ')
        .replace(/⌊/g, '\\lfloor ')
        .replace(/⌋/g, '\\rfloor ')
        .replace(/⌈/g, '\\lceil ')
        .replace(/⌉/g, '\\rceil ')
        .replace(/∈/g, '\\in ')
        .replace(/∉/g, '\\notin ')
        .replace(/∪/g, '\\cup ')
        .replace(/∩/g, '\\cap ')
        .replace(/⊆/g, '\\subseteq ')
        .replace(/⊇/g, '\\supseteq ')
        .replace(/∀/g, '\\forall ')
        .replace(/∃/g, '\\exists ')
        .replace(/∂/g, '\\partial ')
        .replace(/∞/g, '\\infty ')
        .replace(/Σ/g, '\\sum ')
        .replace(/∏/g, '\\prod ')
        .replace(/²/g, '^2')
        .replace(/³/g, '^3')
        // Unicode 下标字符 → _{...}（连续多个下标合并为一组，如 ᵢ₋₁ → _{i-1}）
        .replace(/([ᵢⱼₙₘₚₖₐᵦₓᵧ₁₂₃₄₅₆₇₈₉₀₊₋]+)/g, (m: string) => {
          const map: Record<string, string> = {
            'ᵢ': 'i', 'ⱼ': 'j', 'ₙ': 'n', 'ₘ': 'm', 'ₚ': 'p', 'ₖ': 'k',
            'ₐ': 'a', 'ᵦ': 'b', 'ₓ': 'x', 'ᵧ': 'y',
            '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5',
            '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₀': '0',
            '₊': '+', '₋': '-',
          }
          return '_{' + [...m].map(c => map[c] ?? c).join('') + '}'
        })
        // Unicode 上标数字 → ^{...}（连续多个合并，如 ¹² → ^{12}）
        .replace(/([¹²³⁴⁵⁶⁷⁸⁹⁰]+)/g, (m: string) => {
          const map: Record<string, string> = {
            '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5',
            '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁰': '0',
          }
          return '^{' + [...m].map(c => map[c] ?? c).join('') + '}'
        })
      return isBlock ? `$$${converted}$$` : `$${converted}$`
    })
    .join('')
}


/**
 * 完整预处理：按管线顺序归一化 AI 输出的数学内容。
 * Markdown 组件渲染前的唯一入口。
 */
export function preprocessMath(text: string): string {
  return normalizeMathSymbols(wrapBareMath(normalizeMathDelimiters(stripOuterCodeFence(text))))
}
