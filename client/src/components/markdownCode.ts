/**
 * Markdown「代码 vs 公式」判定（纯函数，无 React 依赖，便于单元测试）。
 *
 * AI 回复里最常见的排版问题不是公式写错，而是 AI 把**数学公式塞进代码围栏/行内代码**，
 * 或者反过来把**代码片段写成裸文本**。渲染前必须先判定每一块内容的身份，
 * 才能分别交给代码卡（等宽 + 语言标签 + 复制）或 KaTeX（数学字体 + 居中）渲染。
 *
 * 判定原则：**默认是代码，只有强数学特征才改判为公式**。
 * 因为把真正的代码误判成公式会彻底毁掉可读性（C++ 代码渲染成斜体数学），
 * 而把公式留在代码框里只是"不够好看"。
 */

/**
 * 强数学记号：出现这些说明内容是**数学表达**，可以放心升级为 KaTeX 渲染。
 *
 * 覆盖三类：
 *   · LaTeX 语法（`\max`、`\frac`、`f_{i}`、`2^{k}`）
 *   · 排版级数学符号（Σ ∏ √ ≤ ≥ ≠ ∈ ∪ ∩ ← ∞ … 等）——AI 常直接用 Unicode 写公式，
 *     例如 `answer = Σ a[i] + (n-1) * min(a[i])`
 *   · Unicode 上下标字符（₀₁ᵢ ⁿ²，通常在管线入口已被归一化为 `_{}`/`^{}`）
 *
 * 刻意不含方括号/圆括号本身：`a[x] + a[x+1]`、`f(n)` 这类纯括号 ASCII 记法
 * 既可能是代码也可能是数学，升级后会渲染成 `a` 下标 `[x+1]`（含义改变），因此保持原样。
 *
 * 唯一例外是**复杂度记号** `O(…)` / `Θ(…)` / `Ω(…)`：它由下面的 COMPLEXITY 单独认领，
 * 不当作"函数调用"而当作公式（用户反馈"O((n+#events)logn+q⋅n) 没正确渲染"）。
 * 理由是大 O 只有这一种含义 —— 它是记号而不是可调用的符号，写成 `O(n log n)`
 * 就是"`n log n` 的同阶量"，不会有第二个解释。
 */
const STRONG_MATH_SYMBOLS =
  /∑|Σ|∏|Π|√|⌊|⌋|⌈|⌉|←|→|↔|⇔|⇒|≤|≥|≠|∞|∂|∇|∈|∉|∪|∩|⊆|⊇|⊕|⊗|∀|∃|·|…|[₀-₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥ]|[⁰-⁹⁺⁻⁼⁽⁾ⁿⁱ]|²|³/

/** 复杂度记号：O(...) / Θ(...) / Ω(...)（注意不能匹配 C++ 的 operator() —— 那会先被 looksLikeCode 拦下） */
const COMPLEXITY = /(?<![A-Za-z])[OΘΩ]\s*\(/

/**
 * LaTeX 语法特征：反斜杠命令（`\max`、`\frac`、`\le`）或花括号下标上标
 * （`f_{i}`、`2^{k}`，带不带前导标识符都算，例如 `\max_{j<i}`）。
 *
 * 这类记号说明内容确实是**排版出来的公式**。注意它只是"升级为公式"的充分条件之一 ——
 * AI 也常直接用 Unicode 写公式（`Σ a[i]`、`x ≤ y`），那部分由 STRONG_MATH 覆盖。
 */
export function looksLikeLatex(text: string): boolean {
  return /\\[a-zA-Z]+|\^\{|_\{/.test(text)
}

/** Unicode 下标字符 → 普通字符（含 U+2C7C 这类修饰字母，KaTeX 与等宽字体都不含其字形） */
const SUBSCRIPT_CHARS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x', 'ₕ': 'h', 'ₖ': 'k',
  'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₚ': 'p', 'ₛ': 's', 'ₜ': 't',
  'ᵢ': 'i', 'ⱼ': 'j', 'ᵣ': 'r', 'ᵤ': 'u', 'ᵥ': 'v', 'ᵦ': 'b', 'ᵧ': 'y',
}

/** Unicode 上标字符 → 普通字符 */
const SUPERSCRIPT_CHARS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i',
}

/** 连续下标字符序列（用于整体转换为 _{...}） */
const SUBSCRIPT_RUN = /[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥᵦᵧ]+/g

/** 连续上标字符序列（用于整体转换为 ^{...}） */
const SUPERSCRIPT_RUN = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g

/** 修饰字母 / 上下标字符的整体范围（用于"整行是否只含公式字符"这类判定） */
export const SCRIPT_CHAR_RANGE = '₀-₉₊₋₌₍₎ₐₑₒₓₕₖₗₘₙₚₛₜᵢⱼᵣᵤᵥᵦᵧ⁰-⁹⁺⁻⁼⁽⁾ⁿⁱ'

/**
 * 把整段文本里的 Unicode 上下标字符提前归一化为 LaTeX 记法：
 *   `dpⱼ` → `dp_{j}`     `2ⁿ` → `2^{n}`     `a₁` → `a_{1}`
 *
 * 必须在管线一开始（代码区保护之前）做，因为这些字符会被后续逻辑当作普通文本，
 * 既匹配不到"裸数学"种子，也会在等宽/KaTeX 字体里渲染成方框（tofu）。
 * 代价是代码区里的上下标也会被改写 —— 但它们本来就是数学记法，转成 LaTeX 更清楚。
 */
export function normalizeMathScriptChars(text: string): string {
  return text
    .replace(SUBSCRIPT_RUN, (m) => `_{${[...m].map((c) => SUBSCRIPT_CHARS[c] ?? c).join('')}}`)
    .replace(SUPERSCRIPT_RUN, (m) => `^{${[...m].map((c) => SUPERSCRIPT_CHARS[c] ?? c).join('')}}`)
}

/**
 * 判断文本是否"看起来像真实代码"（而非数学公式）。
 * 命中任一典型代码特征即认为是代码——宁可把公式留在代码框里，也不要把代码渲染成公式。
 *
 * 关键是只认**无歧义的代码语法**：`f_i = f_{i-1} + 1` 这类等式虽然也像
 * "类型 + 变量名"，但那是数学，不能判成声明语句。
 */
export function looksLikeCode(text: string): boolean {
  return [
    // 语句结束符。排除 `\;` `\:` 这类 LaTeX 间距命令（公式里极常见，不是语句结束）：
    // 左负向断言要求分号前是偶数个连续反斜杠（0 个 → 真语句结束；1 个 → 转义，跳过）
    /(?<!\\)((?:\\\\)*);/,
    /#\s*(?:include|define|pragma|ifdef|ifndef)\b/, // 预处理指令（C/C++ 独有）
    /\b(?:function|const|let|var|def|class|struct|namespace|using|typedef|return|import|from|require|public|private|protected|template|printf|scanf|cout|cin|endl|std::|nullptr|malloc|free|lambda|elif|console\.|System\.out)\b/,
    /\b(?:if|for|while|switch|catch)\s*\(/, // 控制流
    /=>/, // 箭头函数 / lambda（`->` 与 `{}` 不判定：f_{i-1}、_{j} 这类数学写法极易误伤）
    /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?>/, // 标签
    // 变量/函数声明。两处否定断言很关键，否则 `dp_i = \max…`、`dp[j] = x` 这类
    // 数学等式会被当成"类型 + 变量名 + 赋值"：
    //   (?<![_\]}])  变量名左侧不能是下标/上标的花括号或方括号（排除 a[i] = x、f_{i} = x）
    //   (?!\s*[[(])  变量名右侧不能紧跟 [ 或 (（排除 min(a) = x 这类函数调用）
    /\b(?:int|long|double|float|char|bool|void|string|auto|vector|pair|map|set|queue|unsigned|size_t)(?<![_\]}])\s+(?<![_\]}])\w+(?!\s*[[(])\s*[=;([]/,
    /\([^()\n]*\)\s*(?:->\s*[\w*&]+)?\s*;/, // 函数调用语句
    /**
     * 编程语言的关系运算符 `==` / `===` / `!=`：**数学里没有这种写法**
     * （相等是单个 `=`，不等是 `≠`），所以出现 2 个及以上连续等号基本可以断定是代码。
     *
     * 这是 B4 的根因：`print(a == b)`、`x == y` 这类裸围栏内容原先不含任何代码特征，
     * 于是被 `shouldConvertFenceToMath` 判成公式 → 整个代码块变成 KaTeX，
     * `==` 还会被 normalizeMathSymbols 压成 `=`，等号语义彻底丢失。
     * 同理 `` `a == b` `` 这类行内代码也被升级成公式。
     * 要求 `[^=\n]*=[^=]` 之外的两连等号，避免误伤 LaTeX 的 `&=&` 对齐写法（那是公式）。
     */
    /={2,}/,
  ].some((re) => re.test(text))
}

/**
 * 是否"强数学"——用于把行内代码 / 代码围栏改判为公式。
 * 只在出现明确的数学记号时返回真，避免 `dp_max`、`vis_cnt` 这类标识符被渲染成斜体公式。
 */
export function looksStronglyMath(text: string): boolean {
  return looksLikeLatex(text) || STRONG_MATH_SYMBOLS.test(text) || COMPLEXITY.test(text)
}

/** C/C++/Python 常见标准库标识符：单独出现（无任何数学记号）时按代码渲染 */
const CODE_IDENTIFIER =
  /^(?:std|push_back|pop_back|emplace_back|make_pair|lower_bound|upper_bound|sync_with_stdio|tie|ios|printf|scanf|sort|max_element|min_element|__int128|size_t|int64_t|uint64_t|NULL|nullptr|append|extend|strip|split|join|len|range|enumerate|zip)::?$/i

/**
 * 数学下标里常见的**运算符名后缀**：`dp_max`、`ans_min`、`sum_max`。
 * 这类写法的后缀是数学运算符（读作"dp 在 max 处"），所以按数学下标渲染更合理。
 *
 * 只收**有实际证据**的 `max` / `min`（`dp_min` 类误判的正用例就是这几个）。
 * 每加一个词都会扩大误伤面：`query_max`、`prefix_sum` 这类"动词/名词 + 运算符名"的
 * 变量名只凭 token 形态与 `dp_max` 完全同构、无法区分，所以按需增量，别一次塞一堆。
 */
const MATH_OPERATOR_SUFFIXES = new Set(['max', 'min'])

/**
 * 「代码语境」的强信号（**只认语法，不认反引号**）：同一行里出现这些，
 * 说明这行在讲代码而不是公式。
 *
 * 刻意不含反引号：AI 会把说明里的数学也用反引号包起来（用户截图里整段说明都是
 * `` `r` ``、`` `c←c+1` `` 这种），拿反引号当"这行是代码"的证据，会把说明里的数学
 * 又推回代码外观 —— 正是要修的问题。
 */
const CODE_SYNTAX_CONTEXT =
  /;|::|->|\/\/|\/\*|#\s*(?:include|define|pragma|ifdef|ifndef)|\b(?:int|long|double|float|char|bool|void|unsigned|size_t|const|struct|class|namespace|typedef|using|vector|nullptr|sizeof|template|return|def)\b/

/**
 * 运算符后缀规则（`dp_max`）用的代码语境：语法信号之外，**反引号**（显式代码标注）
 * 与**下标访问**（`dp_max[i]`）同样算代码证据。
 */
const CODE_CONTEXT =
  /`[^`\n]*`|;|::|->|\/\/|\/\*|#\s*(?:include|define|pragma|ifdef|ifndef)|\b(?:int|long|double|float|char|bool|void|unsigned|size_t|const|struct|class|namespace|typedef|using|vector|nullptr|sizeof|template|return|def)\b|\w+\s*\[[^\]]*[A-Za-z_]/

/** 明确的**代码形态**：出现这些就绝不当成数学记号 */
const CODE_SHAPE =
  /;|::|->|\/\/|\/\*|#\s*(?:include|define|pragma|ifdef|ifndef)|\b[A-Za-z_]\w*\s*\(|\.[A-Za-z_]\w*|\b(?:int|long|double|float|char|bool|void|string|auto|vector|pair|map|set|queue|stack|unsigned|size_t|const|struct|class|namespace|typedef|using|return|def|if|else|for|while|switch|case|break|continue|new|delete|print|printf|scanf|cout|cin|endl|std|nullptr|lambda|import|from|range|enumerate|append|extend|split|join|sort)\b/

/**
 * 数学记号里的关系符 / 箭头 / 集合符号。
 * 刻意**不含裸 `+` `-`**：`a[x] + a[x+1]` 这类"带运算符的 ASCII 下标表达式"
 * 曾让用户看到过乱码（截图回归，见 test 里的用例），那条线不碰。
 * `−`（U+2212 数学减号）与 ASCII `-` 不同，它是排版出来的数学符号，收进来。
 */
const MATH_RELATION = /[=←→↔⇔⇒⇐≤≥≠≈±×÷·√∞∈∉∪∩∑∏Σ∂∇⌊⌋⌈⌉−]/

/** 数学里的 `mod`（独立成词：不能是 `dp_mod`、`model` 的一部分） */
const MATH_MOD_WORD = /(?<![\w\\])mod(?![\w])/

/** 极短的数学符号：单字母、纯数字、带符号数字、±数字（`r`、`c`、`0`、`-1`、`±1`） */
const SHORT_MATH_SYMBOL = /^(?:[A-Za-z]|[+-]?\d+(?:\.\d+)?|±\d+)$/

/**
 * 带下标的数学符号写法：`a_i`、`dp_i`、`k−a_i`。
 * 下标只有 1-2 个字符才算数学记号；`vis_cnt`、`max_element`、`foo_bar` 这类
 * 3+ 字符后缀是 snake_case 变量名（后缀长度就是那条第 3 节里"已知不可靠"的启发式，
 * 这里只是把同一条线用在"反引号里到底是数学还是代码"这个判断上）。
 */
const SUBSCRIPT_NOTATION = /[A-Za-z0-9]_[A-Za-z0-9]{1,2}(?![A-Za-z0-9_])/

/** 整段就是一个下标记号：`a[offset]`、`dp[i][j]`（不带任何其它运算符） */
const BRACKET_SYMBOL = /^[A-Za-z_]\w*(?:\s*\[[^\]\n]*\])+$/

/**
 * **伪代码结构特征**：控制流关键字（不要求后面跟括号）、自增自减、赋值/行尾冒号。
 *
 * `looksLikeCode` 里的控制流判定要求 `if (`，而 AI 写的伪代码是
 * `if cnt[i] > 0 :`（没有括号），于是整块伪代码会因为某一行含 `…` 这类"强数学记号"
 * 被判成公式 —— 实测后果：所有换行被压成一行，KaTeX 还会吞掉词间空格
 * （`for i` → `fori`、`else break answer` → `elsebreakanswer`）。
 * 宁可把公式留在代码卡里，也不能把代码渲染成公式，所以单独认这几个信号。
 */
const PSEUDO_CODE =
  /(?<![\\\w])(?:if|elif|elseif|else|for|foreach|while|switch|case|default|break|continue|return|then|do|end|def|function|procedure|repeat|until|begin)(?![\w])|\+\+|--|:=|(?:\w|\))\s*:\s*$/m

/**
 * **语句级**代码特征：出现这些就是真代码，**不论式子长得像不像公式**。
 *
 * 与 CODE_SHAPE 的关键区别：函数调用 `cnt(m)`、下标 `b_i(k)` 这类**弱**形态不算 ——
 * 它们在数学公式里同样常见。用户截图里两张被误判成代码卡的"公式"正是栽在这点上：
 *   `cnt(m) = #{ i | b_i(k) < m }`        ← `cnt(` 命中 CODE_SHAPE 就被否决
 *   `= max(0, upper_bound(a, k-m) - …)`   ← 同上
 * 所以判定顺序必须是：**先看语句级代码特征，再看关系符，最后才看弱形态**。
 */
const CODE_STATEMENT =
  /;|::|->|\/\/|\/\*|#\s*(?:include|define|pragma|ifdef|ifndef)|\+\+|--|\.[A-Za-z_]\w*|={2,}|\b(?:int|long|double|float|char|bool|void|unsigned|size_t|const|struct|class|namespace|typedef|using|return|def|if|else|for|while|switch|case|break|continue|new|delete|import|from|assert|sizeof|printf|scanf|cout|cin|endl|malloc|free|nullptr)\b/

/**
 * 这段内容是**数学记号**还是**代码** —— 用于把「说明正文里的数学」从代码外观
 * （行内代码 span / 代码卡）里解放出来。
 *
 * 判定顺序与全项目一致：**默认是代码**，只有出现明确的数学结构才升级为数学。
 *   · 已经是 LaTeX 记法（`\cmd`、`_{}`、`^{}`）→ 数学
 *   · 语句级代码特征（分号、限定名、成员访问、控制流、声明…）→ 代码
 *   · 关系符/箭头/`mod`/极短数学符号/带下标的符号 → 数学
 *   · 弱代码形态（函数调用 `f(x)`、`O(n log n)`）→ 代码
 *   · 整段就是一个下标记号（`a[offset]`）→ 数学；但同一行是代码语境时仍是代码
 *
 * @param content 片段内容（不含反引号）
 * @param context 该片段所在的行，用于判定代码语境
 */
export function looksLikeMathNotation(content: string, context = ''): boolean {
  const s = content.trim()
  if (!s) return false
  // 已是 LaTeX 记法：交给原有公式管线
  if (/\\[a-zA-Z]|_\{|\^\{/.test(s)) return true
  // 语句级代码特征优先（`int x = 1;`、`g[prev].push_back(cur)`、`ios::sync_with_stdio(false)`）
  if (CODE_STATEMENT.test(s)) return false
  // 关系符/数学词/极短符号（`cnt(m) = #{ i | b_i(k) < m }`、`= max(0, …)` 都属于这里）
  if (MATH_RELATION.test(s) || MATH_MOD_WORD.test(s) || SHORT_MATH_SYMBOL.test(s)) return true
  // 复杂度记号（`O(n log n)`、`O((n+#events)logn)`）：必须抢在下面的 CODE_SHAPE 之前 ——
  // `O(` 长得跟函数调用一模一样，否则 `` `O(n²)` `` 这类会被判成代码。
  // 与 looksStronglyMath 的口径保持一致（那里的 COMPLEXITY 也是这个意思）。
  if (COMPLEXITY.test(s)) return true
  // 弱代码形态（`O(n log n)`、`sort(a, a + n)`、`f(n)`）
  if (CODE_SHAPE.test(s)) return false
  // 带下标的符号写法（`k−a_i`、`a_1`）
  if (SUBSCRIPT_NOTATION.test(s)) return true
  // 单个下标记号：说明正文里这是数学符号（`a[offset]`、`dp[i][j]`），
  // 但同一行有代码语法特征时仍按代码（`int dp[100005];`、`dp[i][j] = 0;`）
  if (BRACKET_SYMBOL.test(s)) return !CODE_SYNTAX_CONTEXT.test(context)
  return false
}

/**
 * 反引号里其实是**中文说明**而不是代码：`` `价值` ``、`` `未使用` ``。
 * AI 习惯用反引号引一个术语，渲染成等宽代码药丸很怪。只认语句级代码特征，
 * 所以 `` `int x; // 计数` `` 仍然按代码，而 `` `cnt(m) 的值` `` 会当成术语。
 */
export function isQuotedChineseTerm(content: string): boolean {
  const s = content.trim()
  return /[\u4e00-\u9fff]/.test(s) && !CODE_STATEMENT.test(s)
}

/**
 * 比 looksLikeMathNotation 更严：必须出现**关系符 / 数学词**（`=`、`←`、`mod`…）
 * 或强数学记号，只有"单个下标记号"（`g[i][j]`）或"单个短符号"（`0`）不算。
 *
 * 用于推翻围栏：围栏是 AI **显式写的代码块**，要改判成公式需要更强的证据；
 * 而正文里的反引号只是弱标注（AI 习惯用它包数学），所以那边可以放宽一档。
 *
 * 顺序同样关键：`f(n)`、`sort(a, a+n)` 这类**没有关系符**的弱代码形态仍是代码，
 * 而 `cnt(m) = #{ … }`、`= max(0, upper_bound(…))` 这种带关系符的式子要认成公式。
 */
export function looksLikeMathEquation(content: string): boolean {
  const s = content.trim()
  if (!s) return false
  if (/\\[a-zA-Z]|_\{|\^\{/.test(s)) return true
  // 语句级代码特征与伪代码结构优先：`if c_j ≥ cur :` 含 `≥`，但它明显是代码
  if (CODE_STATEMENT.test(s) || PSEUDO_CODE.test(s)) return false
  // 强数学记号（`O(n log n)`、`Σ`、`≤`、Unicode 上下标…）无歧义
  if (looksStronglyMath(s)) return true
  if (MATH_RELATION.test(s) || MATH_MOD_WORD.test(s)) return true
  if (CODE_SHAPE.test(s)) return false
  return false
}

/**
 * 片段是否其实是「代码引用」而非公式。
 * 例如正文里提到的 g[prev].push_back(cur)、std::sort(a, a+n)、dp[i][j]、dp_max：
 * 这些含下划线/括号，会被数学种子命中，但它们属于代码，应渲染成行内代码。
 *
 * 注意要求片段内不含空格/逗号混排，避免把 `dp[i] + a[j]` 这类数学表达式整体标成代码。
 * （实际效果：`dp_max = min(dp_j)` 这种整段式子会被"含空格"这条直接判为数学，
 *   所以本文的形态规则只影响**正文里单独提到的那个 token**。）
 *
 * ⚠ 下划线左右各 ≥2 字符这条仍然是启发式，现状与取舍：
 *
 *   判为公式：dp_i  c_i  a_m  f_i  x_1  dp_i_j  a_b_c  f_max
 *             dp_max  dp_min  sum_max  ans_min      ← 运算符名后缀（已修正）
 *             a[offset]  dp[i]  dp[i][j]            ← 单个下标记号（说明正文里是数学）
 *   判为代码：push_back  vis_cnt  foo_bar  my_var  is_valid  sync_with_stdio
 *             max_element  a[x] + a[x+1]（带运算符的表达式不碰）
 *             dp_max[..] / dp[i][j]（同一行有代码语境时）
 *
 * 仍然**已知误判**的是：
 *   · `dp_i_j` 这类嵌套下标判成公式后，KaTeX 只对第一个 `_` 生效，不是双下标；
 *   · 裸提到 `query_max` / `prefix_sum` 这类"动词+运算符名"的变量名会被判成公式
 *     （与 `dp_min` 同构，无法用形态区分）。代价可接受：它们多数出现在带反引号、
 *     声明或下标访问的代码语境里，那由 CODE_CONTEXT 兜住；完全裸提时才走公式。
 *     真要再压，应加"动词性前缀"这类语义信号，而不是继续调字符数阈值。
 */
export function looksLikeCodeReference(fragment: string, context = ''): boolean {
  const s = fragment.trim()
  // 含 LaTeX 命令或中文说明的一定不是代码引用
  if (!s || /\\[a-zA-Z]/.test(s) || /[\u4e00-\u9fff]/.test(s)) return false
  // 限定名（std::sort / a.b / a->b）可以带参数与空格：函数调用是代码
  if (/[A-Za-z_]\w*\s*(?:::|->|\.)\s*[A-Za-z_]\w*/.test(s)) return true
  // 其余形态含空格/逗号混排（`dp[i] + a[j]`、`f_i, c_j`）视为数学表达式
  if (/[\s,]/.test(s)) return false
  // 单个 snake_case 标识符（push_back / dp_max / max_element）是代码。
  // 但**单字母后缀**是数学下标：`dp_i`、`c_i`、`a_m` 必须走公式（否则会渲染成等宽代码，
  // 与同一句话里的 `f_{i-1}` 风格不一致）。所以要求后缀至少两个字符，
  // 或多段下划线（`sync_with_stdio`）。
  if (/^[A-Za-z]{2,}_[A-Za-z0-9]{2,}(?:_[A-Za-z0-9]+)*$/.test(s)) {
    // 例外：后缀是数学运算符名时按数学下标渲染（`dp_max` 读作 dp 在 max 处），
    // 除非同一行有明确的代码语境（声明 / 分号 / 限定名 / 反引号 / 下标访问）
    const suffix = s.slice(s.lastIndexOf('_') + 1).toLowerCase()
    if (MATH_OPERATOR_SUFFIXES.has(suffix) && !CODE_CONTEXT.test(context)) return false
    return true
  }
  if (CODE_IDENTIFIER.test(s)) return true
  // 整段就是一个下标记号（`a[offset]`、`dp[i][j]`）：说明正文里它是**数学**，
  // 不是代码（KaTeX 渲染时方括号原样保留，含义不变）。同一行有代码语法时才按代码。
  if (BRACKET_SYMBOL.test(s)) return CODE_SYNTAX_CONTEXT.test(context)
  // 下标访问 a[...]：括号内还有标识符说明是代码数组（`g[prev].push_back` 已在上面的限定名分支拦下）
  const bracket = /[A-Za-z_]\w*\s*\[([^\]]*)\]/.exec(s)
  if (bracket && /[A-Za-z_]/.test(bracket[1]!)) return true
  // 括号里只有数字（`dp[100005]` = 数组大小）：单看片段与数学下标 `a[5]` 判断不了，
  // 但同一行有代码语境（声明 / 分号 / 限定名 / 反引号 / 下标访问）时按代码渲染 ——
  // `int dp[100005];` 是 DP 讲解里最常见的写法之一，判成公式是排版事故。
  // 纯正文里提到的 `以 dp[100005] 存状态` 保持现状（数学下标），不做无守卫的扩张。
  if (bracket && CODE_CONTEXT.test(context)) return true
  return false
}

/** 数学代码围栏的语言标记：```math / ```latex / ```tex / ```equation / ```formula */
export const MATH_LANGS = new Set(['math', 'latex', 'tex', 'equation', 'formula', 'katex'])

/** Markdown 系围栏语言标记（含空标记）：这类围栏里装的其实是 Markdown 正文，不是代码 */
export const MARKDOWNISH_LANGS = new Set(['', 'markdown', 'md', 'gfm', 'commonmark'])

/** 围栏语言标记是否属于 Markdown（AI 整段回复误包 ```markdown 时用于剥离） */
export function isMarkdownishLang(lang: string): boolean {
  return MARKDOWNISH_LANGS.has(normalizeLang(lang))
}

/** 语言标记归一化：去 `language-` 前缀、取首个别名、小写 */
export function normalizeLang(raw: string): string {
  const first = raw.trim().split(/[\s:,]/)[0] ?? ''
  return first.replace(/^language-/i, '').toLowerCase()
}

/**
 * 围栏内容是否"自带代码注释"。注释是代码块的强特征：
 * 带注释的多行内容留在代码框里（注释里的中文、对齐空格在 KaTeX 里会变成怪异排版）。
 */
export function hasCodeComment(body: string): boolean {
  return /\/\/\s*\S|\/\*|(?:^|\s)#\s*[^\s#]/.test(body)
}

/** Unicode 数学符号 → LaTeX 命令（判定与渲染共用一份映射） */
const SYMBOL_MAP: Array<[RegExp, string]> = [
  [/Σ/g, '\\sum '], [/∑/g, '\\sum '], [/∏/g, '\\prod '], [/√/g, '\\sqrt '],
  [/≤/g, '\\le '], [/≥/g, '\\ge '], [/≠/g, '\\ne '], [/·/g, '\\cdot '], [/×/g, '\\times '],
  [/∈/g, '\\in '], [/∪/g, '\\cup '], [/∩/g, '\\cap '], [/∞/g, '\\infty '], [/←/g, '\\leftarrow '],
  // `⋅`(U+22C5) 与 `·`(U+00B7) 是同一种点乘运算符的两种写法，判定侧必须一并归一化
  [/⋅/g, '\\cdot '], [/·/g, '\\cdot '],
  [/→/g, '\\to '], [/…/g, '\\dots '], [/−/g, '-'],
]

/**
 * 把 Unicode 数学符号换成 LaTeX 命令，**供分类判定使用**。
 *
 * `Σ a[i]`、`n ≥ 3` 这类写法必须能被识别为数学；但 `Σ` 本身不是"强数学记号"
 * 覆盖的字符（`≥` 是），所以判定前先归一化，避免同一块内容被拆成
 * "有的行像公式、有的行不像"而整块退化成代码框。
 */
export function normalizeMathSymbolsForDetect(text: string): string {
  let out = text
  for (const [re, cmd] of SYMBOL_MAP) out = out.replace(re, cmd)
  return out
}

/**
 * 多行内容是否是**一条被折行的式子**（而不是多行代码）。
 *
 * AI 常把一条长公式折成两行写，第二行以运算符开头（对齐续行）：
 *   `avail(i) = cnt[i]` / `         + (i != k-i ? cnt[k-i] : 0)`
 * 这种折行只是排版，合并成一行交给 KaTeX 才是正确结果，不该留在代码卡里。
 *
 * 反例（保持代码）：
 *   · `dp[0] = 1` / `dp[i] = dp[i-1] + dp[i-2]` —— 两行都以标识符开头，是两条独立语句；
 *   · 含 `;`（语句结束符）或伪代码结构（控制流 / `++` / `--`）。
 */
function isSingleWrappedExpression(lines: string[]): boolean {
  if (lines.length < 2) return false
  // 后续行都必须以运算符开头（续行的标志）
  if (!lines.slice(1).every((l) => /^[+\-*/·×÷−=<>≤≥&|^%\\]/.test(l.trim()))) return false
  const body = lines.join(' ')
  if (body.includes(';')) return false
  if (PSEUDO_CODE.test(body.replace(/\\text\{[^}]*\}/g, ''))) return false
  // 还要有"这是一条式子"的正面证据
  return MATH_RELATION.test(body) || MATH_MOD_WORD.test(body) || looksStronglyMath(body)
}

/**
 * 关系式里主关系符的**左侧**：`value = k - a_i` → `value`。
 *
 * 取最靠左的那个关系符（与 `looksLikeMathEquation` 的口径一致：只要出现关系符就算式子），
 * 用于判断若干行是不是在描述"同一个量"。
 */
function relationLead(line: string): string | null {
  const m = MATH_RELATION.exec(line)
  return m ? line.slice(0, m.index).trim() : null
}

/**
 * 多行内容是不是「分段定义」：各行左侧完全相同、且每行都是一条明确的数学关系式。
 *
 * ```
 * value = a_i          (不变)
 * value = k - a_i      (变换)
 * ```
 * AI 常这样列举同一个量的几种取值 —— 它本质是数学，塞进代码卡里完全看不出是公式
 * （用户反馈"中间有的数学公式被当成代码块了"，例子就是这个）。
 *
 * 判据要求**左侧相同**是刻意的：真正的一组独立语句
 * （`dp[0] = 1` / `dp[i] = dp[i-1] + dp[i-2]`）每行左侧各不相同，
 * 若一并放行，多行代码会被压成一条首尾相接的公式 —— 那比留在代码卡里糟得多。
 * 含 `Σ`/`≤` 这类强数学记号的行早就由调用方的前置判定兜住了，这里只补 ASCII 记法的缺口。
 */
export function isPiecewiseDefinition(lines: string[]): boolean {
  if (lines.length < 2) return false
  const first = relationLead(lines[0]!)
  if (!first) return false
  return lines.every((l) => relationLead(l) === first && looksLikeMathEquation(l))
}

/**
 * 围栏代码块内容是否为数学公式。
 *
 * AI 经常把公式写进围栏（避免 Markdown 语法干扰），而且写法五花八门，判定顺序：
 *  1. 显式数学语言标记（```math / ```latex …）→ 公式
 *  2. 显式非数学语言标记（```cpp / ```python …）→ 代码
 *  3. 含代码特征（分号、关键字、控制流…）→ 代码
 *  4. 含 LaTeX 语法或强数学记号（`\frac`、`f_{i}`、`Σ`、`≤`、Unicode 上下标…）→ 公式
 *  5. 其余（`a[x] + a[x+1]`、`f(n)`、`O(n log n)` 这类纯括号 ASCII 记法）→ 代码
 *
 * **代码注释不算代码特征**：AI 常把公式连同解释一起写进围栏，例如
 *   `S = Σ a[i]   // 所有元素之和`
 * 这类内容本质是公式，之前因为"含注释"被误判成代码框（用户反馈"非代码内容被识别为代码块"）。
 * 注释由调用方在转换前剥掉。
 *
 * 多行内容额外要求"每一行都像公式"：避免"公式 + 普通说明行"整块被当公式。
 *
 * 第 5 条是刻意的取舍：把 `a[x+1]` 升级成 KaTeX 会渲染成 `a` 下标 `[x+1]`，
 * 与原文含义不同（用户截图里的"乱码"），宁可把它留在代码框里。
 */
export function shouldConvertFenceToMath(langRaw: string, body: string): boolean {
  const lang = normalizeLang(langRaw)
  const trimmed = body.trim()
  if (!trimmed) return false
  if (MATH_LANGS.has(lang)) return true
  if (lang && !MARKDOWNISH_LANGS.has(lang)) return false
  // 判定前先剥掉解释性注释、归一化 Unicode 数学符号：
  // 注释里的中文不是"代码"的证据，`Σ`/`≥` 则必须能被识别为数学
  const code = normalizeMathSymbolsForDetect(stripLineComments(trimmed)).trim()
  if (!code) return false
  if (looksLikeCode(code)) return false
  // 伪代码结构（`if cnt[i] > 0 :`、`cnt[i]--`、`for i = 0…n :`）→ 代码。
  // 这一步必须在"含强数学记号"之前：否则只要块里有一行含 `…`/`≤` 这类记号，
  // 整块伪代码就会被判成公式，所有换行被压成一行（用户截图里的"代码粘连"）。
  // `\text{…}` 里是字面说明，先摘掉再判，避免 `\text{if}` 之类误伤公式。
  if (PSEUDO_CODE.test(code.replace(/\\text\{[^}]*\}/g, ''))) return false
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  // 单行：含强数学记号即可；或者它本身就是一条数学**式子**（`b[r][c] = a[(r - c) mod n]`
  // 这类 ASCII 记法没有 LaTeX/Unicode 特征，但它是公式，不该塞进代码卡）。
  // 比正文里宽松的 looksLikeMathNotation 严一档：围栏是显式的代码块标注，
  // 只有 `g[i][j]`/`0` 这种孤零零的片段仍然留在代码卡里。
  if (lines.length === 1) return looksStronglyMath(lines[0]!) || looksLikeMathEquation(lines[0]!)
  // 多行但是**一条被折行的式子**（`avail(i) = cnt[i]` / `  + (i != k-i ? cnt[k-i] : 0)`）→
  // 公式：折行只是排版，合并成一行才是正确结果（用户截图反馈的第二类"公式被当代码卡"）
  if (isSingleWrappedExpression(lines)) return true
  // 多行「同一个量的几种取值」（分段定义）→ 公式。
  // 放在"至少一行含强数学记号"那条之前：纯 ASCII 记法（`value = a_i` / `value = k - a_i`）
  // 没有任何 Unicode/LaTeX 记号，到不了那条判断，就直接退回代码卡了 —— 而**同样内容只剩一行**
  // 时是能正常渲染成公式的，多行反而更严，这个不一致正是那个 bug 的来源。
  if (isPiecewiseDefinition(lines)) return true
  // 多行值表：从宽 —— 只要**至少一行**含强数学记号，且包含该记号的行里没有普通说明文字，
  // 就整块按公式渲染。像 `n = 1 : a[0]` / `n ≥ 3 : S + M` 这种值表，
  // 部分行（`a[0]`）没有强数学记号，但它明显是公式而不是代码。
  const mathLines = lines.filter((l) => looksStronglyMath(l))
  if (mathLines.length === 0) return false
  return mathLines.every((l) => !/[\u4e00-\u9fff]/.test(l))
}

/**
 * 行尾解释性注释（`// 说明`）的匹配模式。
 *
 * 仅在注释符后面跟着空白或中文字符时才匹配（`a // b`、`a // 说明`），
 * 避免把 `n//2` 这类整除、或 `http://` 误判。行内代码 span 里的内容保持不动。
 */
const LINE_COMMENT = /\s*\/\/\s*(?=[\s\u4e00-\u9fff]|$)(.*)$/

/** 剥掉行尾解释性注释（`// 说明`） */
export function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(LINE_COMMENT, ''))
    .join('\n')
}

/**
 * 取出被剥掉的那些解释性注释文本（不含注释符），用于**不静默丢内容**：
 * 公式块里的中文说明转成 `\text{…}` 留在公式里（见 markdownMath.normalizeFenceBody）。
 */
export function extractLineComments(text: string): string[] {
  return text
    .split('\n')
    .map((line) => LINE_COMMENT.exec(line)?.[1]?.trim() ?? '')
    .filter(Boolean)
}
