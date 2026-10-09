/**
 * markdownMath.ts 预处理管线单元测试。
 * 用 node:test 运行（Node 22 内置，无需额外依赖）。
 *
 * 用例来源于真实 AI 消息（Permutation Inversions 讲解）中暴露的渲染 bug：
 * 代码块被公式逻辑污染、** 加粗定界符卷入公式、片段重叠导致文本重复、
 * Unicode 省略号/减号截断公式。
 *
 * 本轮重构新增「代码 / 公式 / 文字」三分判定，重点回归：
 *   · 代码区（围栏 + 行内）绝不被公式逻辑改写
 *   · 正文里的代码引用渲染成行内代码而非斜体公式
 *   · 数学围栏 / 缩进公式块仍能正确改判为公式
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  preprocessMath,
  stripOuterCodeFence,
  normalizeMathDelimiters,
  wrapBareMath,
} from '../src/components/markdownMath.ts'
import { shouldConvertFenceToMath, looksLikeCode, normalizeLang, stripLineComments, looksLikeCodeReference, isPiecewiseDefinition } from '../src/components/markdownCode.ts'

// ---------- stripOuterCodeFence ----------

describe('stripOuterCodeFence', () => {
  it('剥离整段包裹的 ```markdown 围栏', () => {
    assert.equal(stripOuterCodeFence('```markdown\n# 标题\n内容\n```'), '# 标题\n内容\n')
  })
  it('cpp 等代码语言的围栏不剥离（整段是代码块）', () => {
    const text = '```cpp\nint x;\n```'
    assert.equal(stripOuterCodeFence(text), text)
  })
  it('内部嵌套围栏时不剥离', () => {
    const text = '```\n标题\n```cpp\nint x;\n```\n```'
    assert.equal(stripOuterCodeFence(text), text)
  })
  it('无围栏时原样返回', () => {
    assert.equal(stripOuterCodeFence('# 标题'), '# 标题')
  })
  it('围栏只是内容一部分时不剥离', () => {
    const text = '正文\n```\ncode\n```\n结尾'
    assert.equal(stripOuterCodeFence(text), text)
  })
  it('语言标记带空白或大小写时仍识别为 markdown', () => {
    assert.equal(stripOuterCodeFence('``` Markdown \n# 标题\n```'), '# 标题\n')
  })
})

// ---------- normalizeMathDelimiters ----------

describe('normalizeMathDelimiters', () => {
  it('\\(...\\) → $...$', () => {
    assert.equal(normalizeMathDelimiters('已知 \\(x < y\\) 求解'), '已知 $x < y$ 求解')
  })
  it('\\[...\\] → $$...$$（$$ 独占一行，否则 remark-math 会降级为行内公式）', () => {
    assert.equal(normalizeMathDelimiters('公式：\n\\[a + b = c\\]\n完毕'), '公式：\n$$\na + b = c\n$$\n完毕')
  })
  it('代码块内的 \\(...\\) 不转换', () => {
    const text = '`\\(x\\)` 是内联代码'
    assert.equal(normalizeMathDelimiters(text), text)
  })
  it('块级 LaTeX 定界符被归一化为 remark-math 可识别的 $$', () => {
    // $$ 必须独占一行：行内 $$...$$ 会被 remark-math 降级为行内公式（不居中、不换行）
    assert.ok(preprocessMath('\\[O(n \\log n)\\]').includes('$$\nO(n \\log n)\n$$'))
  })
  it('行内 \\(...\\) 归一化后仍为行内公式（不升级为块级）', () => {
    const out = preprocessMath('其中 \\(a_i\\) 为前缀和')
    assert.ok(out.includes('$a_i$'), out)
    assert.ok(!out.includes('$$'), out)
  })
})

// ---------- 代码块保护 ----------

describe('代码块不被公式逻辑污染', () => {
  it('C++ 代码块内的下划线标识符/箭头注释保持原样', () => {
    const code = [
      '```cpp',
      'ios::sync_with_stdio(false);',
      'g[prev].push_back(cur);',
      'priority_queue<int, vector<int>, greater<int>> pq;',
      '// 连 qj -> q(j+1)',
      'cout << p[i] << (i == n ? \'\\n\' : \' \');',
      '```',
    ].join('\n')
    const out = preprocessMath(code)
    assert.ok(out.includes('ios::sync_with_stdio(false);'), 'sync_with_stdio 被包进公式')
    assert.ok(out.includes('g[prev].push_back(cur);'), 'push_back 被包进公式')
    assert.ok(out.includes('priority_queue<int, vector<int>, greater<int>> pq;'), 'priority_queue 被包进公式')
    assert.ok(out.includes('// 连 qj -> q(j+1)'), '箭头注释被包进公式')
    // 代码围栏本身必须保留
    assert.ok(out.includes('```cpp'), '代码围栏被移除')
  })

  it('代码块内容不含任何 $ 包裹（代码区被完全保护）', () => {
    const out = preprocessMath('```cpp\nint dp_max = f_{i}; // a_i\n```')
    assert.ok(!out.includes('$'), `代码区出现公式定界符: ${out}`)
  })

  it('围栏内的 $$ 不会被当成公式定界符（内容是代码）', () => {
    const out = preprocessMath('```txt\n\\[x\\]\n```')
    assert.ok(out.includes('\\[x\\]'), out)
  })

  it('未闭合的行内反引号不破坏后续文本', () => {
    const out = preprocessMath('看 ` 这里 c_i 是下标')
    assert.ok(out.includes('$c_i$'), out)
  })

  it('行内代码 + 围栏混排时围栏语法不泄漏（占位符编号必须全局唯一）', () => {
    const text = '其中 w 用 `query_max` 维护。\n\n```cpp\nint dp_max[100005];\n```\n'
    const out = preprocessMath(text)
    assert.equal(out, text, `围栏/行内代码被破坏: ${out}`)
    assert.equal((out.match(/```/g) ?? []).length, 2, '围栏数量应为 2')
  })

  it('多段围栏与多个行内代码混排时各自保持原样', () => {
    const text = [
      '先 `push_back` 再 `pop_back`：',
      '',
      '```cpp',
      'g[prev].push_back(cur);',
      '```',
      '',
      '最后 `std::sort(a, a + n)`。',
      '',
      '```python',
      'def solve(n):',
      '    return n',
      '```',
    ].join('\n')
    const out = preprocessMath(text)
    assert.ok(out.includes('`push_back`') && out.includes('`pop_back`'), out)
    assert.ok(out.includes('`std::sort(a, a + n)`'), out)
    assert.equal((out.match(/```/g) ?? []).length, 4, `围栏数量应为 4: ${out}`)
    assert.ok(!out.includes('$'), `不应产生公式: ${out}`)
  })

  it('q1 → q2 链式文本不被包裹（→ 不是数学种子）', () => {
    const out = wrapBareMath('对每条约束，相邻两项连边：q1 → q2 → q3 → … → qk')
    assert.equal(out, '对每条约束，相邻两项连边：q1 → q2 → q3 → … → qk')
  })
})

// ---------- 正文中的代码引用 ----------

describe('正文里的代码引用渲染为行内代码', () => {
  it('g[prev].push_back(cur) 不进入公式，保持原样且只出现一次', () => {
    const out = preprocessMath('调用 g[prev].push_back(cur) 追加边')
    const occurrences = out.split('g[prev].push_back').length - 1
    assert.equal(occurrences, 1, `文本被重复输出: ${out}`)
    assert.ok(!out.includes('$g[prev]'), `代码引用被包进公式: ${out}`)
  })
  it('std::sort(a, a + n) 保持代码形态', () => {
    const out = preprocessMath('先 std::sort(a, a + n) 排序')
    assert.ok(out.includes('std::sort'), out)
    assert.ok(!/\$std::sort/.test(out), out)
  })
  it('说明正文里的单个下标记号按数学渲染（dp[i][j] / a[offset]）', () => {
    // 本轮按用户反馈翻面：说明里的 `dp[i][j]` 是数学符号，不是代码。
    // KaTeX 渲染时方括号原样保留（不做下标改写），含义不变。
    const out = preprocessMath('状态 dp[i][j] 表示前 i 个')
    assert.ok(out.includes('$dp[i][j]$'), out)
    assert.ok(preprocessMath('权值正是 a[offset]').includes('$a[offset]$'))
    assert.ok(preprocessMath('用 dp_max[i] 记录').includes('$dp_max[i]$'))
    // 同一行有代码语法语境时仍是代码
    const code = preprocessMath('数组 int dp[i][j]; 的写法')
    assert.ok(!code.includes('$dp'), code)
  })
  it('裸 snake_case 标识符 push_back 按代码处理', () => {
    const out = wrapBareMath('用 push_back 插入')
    assert.ok(!/\$push_back\$/.test(out), out)
  })
  it('真正的数学下标 a_i 仍被包裹为公式', () => {
    assert.ok(preprocessMath('数列 a_i 的前缀和').includes('$a_i$'))
  })
  it('单字母下标的标识符按数学渲染（dp_i / c_i / a_m），与 f_{i-1} 风格一致', () => {
    for (const src of ['dp_i', 'c_i', 'a_m', 'f_i']) {
      const out = preprocessMath(`前缀 ${src} 后缀`)
      assert.ok(out.includes(`$${src}$`), `${src} 未进公式: ${out}`)
      assert.ok(!out.includes('`'), `${src} 被当成代码: ${out}`)
    }
  })
  it('非运算符后缀的 snake_case 仍按代码渲染（push_back / vis_cnt）', () => {
    for (const src of ['push_back', 'vis_cnt']) {
      const out = preprocessMath(`前缀 ${src} 后缀`)
      assert.ok(out.includes(`\`${src}\``), `${src} 未保持代码: ${out}`)
    }
  })
  it('运算符名后缀按公式渲染（dp_max / dp_min），有代码语境时才是代码', () => {
    for (const src of ['dp_max', 'dp_min', 'sum_max', 'ans_min']) {
      const out = preprocessMath(`前缀 ${src} 后缀`)
      assert.ok(out.includes(`$${src}$`), `${src} 未进公式: ${out}`)
    }
    // 同一行的代码语境（声明 / 分号 / 下标访问 / 反引号）把身份翻回代码
    for (const line of ['int dp_max[100005];', 'dp_min 的初值设为 0;', '用 `dp_max` 记录最大值']) {
      const out = preprocessMath(line)
      assert.ok(!out.includes('$dp_m'), `${line} 里的 dp_m* 被误判成公式: ${out}`)
    }
  })
  it('公式里的绝对值 | … | 不被截断，且裸 | 表达式被识别', () => {
    assert.ok(preprocessMath('令 x = |a| + |b| 即可').includes('$|a| + |b|$'))
  })
  // 回归：`$` 定界符**紧贴**裸数学时，包裹会拼出 `$$`（块级定界符），
  // 截断前面那个行内公式。流式半成品里必然出现（`满足 $a_j` 的收尾 `$` 还没到）。
  it('定界符紧贴裸数学时不拼出 $$，保持原样', () => {
    const text = '其中 $j 满足 $a_j 的取值'
    const out = preprocessMath(text)
    assert.ok(!out.includes('$$'), `拼出了块级定界符: ${out}`)
    assert.equal(out, text)
  })
  it('带数字下标的代码声明不被包进公式（截图级排版事故回归）', () => {
    // 修复前：`int dp[100005];` → `int $dp[100005]$;`（整行代码渲染成斜体公式）
    for (const line of ['int dp[100005];', 'int dp_max[100005];', 'long long f[1005];']) {
      const out = preprocessMath(line)
      assert.ok(!out.includes('$'), `${line} 被包进了公式: ${out}`)
    }
    // 纯正文里提到的数字下标保持现状（不无守卫地扩张）
    assert.ok(preprocessMath('以 dp[100005] 数组存状态').includes('$dp[100005]$'))
  })
  it('紧跟语句结束符的片段按代码语句渲染（dp[i] = dp[i-1] + 1;）', () => {
    const out = preprocessMath('转移就是 dp[i] = dp[i-1] + 1;')
    assert.ok(out.includes('`dp[i] = dp[i-1] + 1`'), out)
    assert.ok(!out.includes('$'), out)
  })
  it('定界符后面有空格时不受影响，裸数学照常包裹', () => {
    const out = preprocessMath('前缀 $a_i$ 与 b_j 之和')
    assert.ok(out.includes('$b_j$'), out)
    assert.ok(!out.includes('$$'), out)
  })
})

// ---------- 代码引用 vs 数学下标：现有行为契约 ----------

/**
 * `looksLikeCodeReference` 是一条启发式（下划线左右各 ≥2 字符 → 代码，否则当数学下标）。
 * 本轮按决定修掉「多字母数学下标被判成代码」：**后缀是数学运算符名（max/min）时按公式渲染**，
 * 代价是 `dp_max` 与 `dp_min` 必须一起翻面（两者形态完全同构），
 * 以及裸提到的 `query_max` 这类变量名也会走公式（用代码语境信号兜住多数情况）。
 *
 * 这张表把**现有行为**钉住（有意为之 / 已知误判 / 已知代价都标出来）：
 * 将来要动这条规则，先看这里哪些是有意设计、哪些是承认的误判，再决定翻哪一面。
 */
describe('代码引用 vs 数学下标：现有行为契约', () => {
  it('单字母后缀 → 数学下标（有意：与 f_{i-1} 的渲染风格保持一致）', () => {
    for (const src of ['dp_i', 'c_i', 'a_m', 'f_i', 'x_1']) {
      assert.equal(looksLikeCodeReference(src), false, `${src} 应判为公式`)
    }
  })
  it('运算符名后缀（max/min）→ 数学下标（本轮修正；dp_max 一并翻面）', () => {
    for (const src of ['dp_max', 'dp_min', 'sum_max', 'ans_min']) {
      assert.equal(looksLikeCodeReference(src), false, `${src} 应判为公式`)
    }
  })
  it('其余 snake_case → 代码标识符（有意：push_back 这类绝不能变斜体公式）', () => {
    for (const src of ['push_back', 'vis_cnt', 'foo_bar', 'my_var', 'is_valid', 'sync_with_stdio', 'max_element']) {
      assert.equal(looksLikeCodeReference(src), true, `${src} 应判为代码`)
    }
  })
  it('左侧只有 1 个字符时后缀再长也判为公式（f_max 是这条的副作用，不是规则覆盖）', () => {
    assert.equal(looksLikeCodeReference('f_max'), false)
  })
  it('代码语境兜住运算符后缀：声明 / 分号 / 限定名 / 反引号 / 下标访问 → 仍是代码', () => {
    assert.equal(looksLikeCodeReference('dp_max', 'int dp_max[100005];'), true)
    assert.equal(looksLikeCodeReference('dp_max', '把 dp_max 初始化为 0;'), true)
    assert.equal(looksLikeCodeReference('dp_max', 'std::max(dp_max, x)'), true)
    assert.equal(looksLikeCodeReference('query_max', '用 `query_max` 维护'), true)
    assert.equal(looksLikeCodeReference('sum_min', 'sum_min[i] 表示前缀和'), true)
  })
  it('嵌套下标被判成公式，但 KaTeX 只吃第一个 `_`（**已知误判**，非预期双下标）', () => {
    // 记录现状：`dp_i_j` → `$dp_i_j$`，渲染出来是 dp_i 后面跟一个字面 j，不是双下标。
    // 修它需要另一套信号（把嵌套 `_` 拆成 `_{i,j}`），本轮有意不动。
    assert.equal(looksLikeCodeReference('dp_i_j'), false)
    assert.equal(looksLikeCodeReference('a_b_c'), false)
  })
  it('裸提到「动词+运算符名」的变量名会判成公式（**已知代价**，与 dp_min 同构无法区分）', () => {
    // `query_max` / `prefix_sum` 这类变量名与 `dp_min` 形态完全一样，形态规则无法二选一；
    // 有代码语境时由上一个用例兜住，完全裸提时才落到公式。再想压需要语义（动词性前缀）信号。
    assert.equal(looksLikeCodeReference('query_max'), false)
  })
})

// ---------- 说明正文里的数学不再被当成代码（截图反馈） ----------

/**
 * 用户截图：AI 把说明里的数学符号**全部用反引号包起来**（`r`、`c`、`c←c+1`、
 * `offset = (r - c) mod n`、`a[offset]`），并把一条公式写进空标记围栏。
 * 之前这些一律按代码渲染（行内代码 span / 代码卡），整段说明变成等宽代码块。
 *
 * 本轮按「默认是代码、只有明确数学结构才升级」的分层原则把它们放回数学渲染，
 * 同时守住真正的代码（push_back / a[x] + a[x+1] / O(n log n) / int x = 1;）。
 */
describe('说明正文里的数学记号不再渲染成代码', () => {
  it('反引号里的短数学符号 → 行内公式', () => {
    const out = preprocessMath('记行号为 `r`，列号为 `c`。')
    assert.ok(out.includes('$r$') && out.includes('$c$'), out)
    assert.ok(!out.includes('`'), out)
  })
  it('反引号里的数学表达式 → 行内公式（含 mod → \\bmod）', () => {
    const out = preprocessMath('把 `offset = (r - c) mod n` 称为偏移')
    assert.ok(out.includes('$offset = (r - c) \\bmod n$'), out)
  })
  it('反引号里的单个下标记号 → 行内公式', () => {
    const out = preprocessMath('格子的权值正是 `a[offset]`。')
    assert.ok(out.includes('$a[offset]$'), out)
  })
  it('反引号里的箭头/取模/带符号数 → 行内公式', () => {
    const out = preprocessMath('- **向右**：`c←c+1`，`r` 不变 → `offset` 变为 `offset-1 (mod n)`')
    assert.ok(out.includes('$c\\leftarrow c+1$'), out)
    assert.ok(out.includes('$offset-1 (\\bmod n)$'), out)
    // 行内「同词一致」：`offset` 在同一行里已经出现在数学记号中 → 也按数学渲染
    assert.ok(out.includes('$offset$'), out)
    assert.ok(!out.includes('`'), out)
  })
  it('纯数字/带符号数字 → 行内公式', () => {
    const out = preprocessMath('步长为 `±1` 的随机游走，起点 `offset = 0`，终点也必须是 `0`。')
    assert.ok(out.includes('$±1$'), out)
    assert.ok(out.includes('$offset = 0$'), out)
    assert.ok(out.includes('$0$'), out)
  })
  it('空标记围栏里的数学式子 → 块级公式，且行尾说明转成 \\text{} 保留', () => {
    const out = preprocessMath('```\nb[r][c] = a[(r - c) mod n]      // 这里的 mod 取非负余数\n```')
    assert.ok(out.includes('$$'), out)
    assert.ok(out.includes('b[r][c] = a[(r - c) \\bmod n]'), out)
    assert.ok(out.includes('\\text{这里的 mod 取非负余数}'), out)
    assert.ok(!out.includes('```'), out)
    // `\text{}` 里是字面文本：不能被 mod→\bmod 改写（KaTeX 文本模式下会报错）
    assert.ok(!out.includes('\\text{这里的 \\bmod'), out)
  })
  it('真代码仍然保持代码（红线）', () => {
    // 注意：`O(n log n)` **已不在**这条红线里 —— 复杂度记号本轮按用户反馈翻面：
    // 正文里的 `O(…)` 现在识别为公式（见下面那条专属用例）。
    for (const src of ['push_back', 'vis_cnt', 'a[x] + a[x+1]', 'g[prev].push_back(cur)', 'sort(a, a + n)']) {
      const out = preprocessMath(`前缀 \`${src}\` 后缀`)
      assert.ok(out.includes(`\`${src}\``), `${src} 被误转公式: ${out}`)
    }
    const decl = preprocessMath('开一个 int dp[100005]; 数组，转移写成 dp[i] = dp[i-1] + 1; 即可')
    assert.ok(!decl.includes('$'), decl)
  })
  it('mod 只在独立成词时才转 \\bmod（标识符里的 mod 不动）', () => {
    assert.ok(preprocessMath('用 `dp_mod` 记录').includes('`dp_mod`'))
    assert.ok(preprocessMath('$model(x)$').includes('model(x)'))
  })
  it('标准数学函数名转 LaTeX 命令（`log n` → `\\log n`）', () => {
    // KaTeX 在数学模式里忽略空格，`O(n log n)` 不转会排成 `O(nlogn)` 一串斜体字母
    assert.ok(preprocessMath('复杂度 O(n log n)').includes('\\log n'), 'log 未转为 \\log')
    // AI 常把乘法连写：`logn` / `logk` —— 只认「log + 单个字母 + 之后不再是字母」
    assert.ok(preprocessMath('$O(nlogn)$').includes('\\log n'), 'logn 未转为 \\log n')
    // 函数调用形态不应该凭空多出一个空格
    assert.ok(preprocessMath('$max(0, x)$').includes('\\max(0, x)'), 'max(0 前多余空格')
    for (const w of ['min', 'sin', 'cos', 'exp', 'ln', 'lg']) {
      assert.ok(preprocessMath(`$a ${w} b$`).includes(`\\${w} `), `${w} 未转: ${preprocessMath(`$a ${w} b$`)}`)
    }
  })

  it('函数名红线：logic / long / log_2 / log2(n) 不动', () => {
    for (const s of ['$logic$', '$long$', '$log_2 n$', '$log2(n)$']) {
      assert.equal(preprocessMath(s), s, `${s} 被误改`)
    }
    // 已有的 \log 不能被二次转换（幂等）
    assert.equal(preprocessMath('$\\log n$'), '$\\log n$')
  })

  it('词运算符转 \\operatorname，让公式中间不再糊成一团（用户反馈）', () => {
    // KaTeX 在数学模式里按 LaTeX 规则忽略空格，`xor` 会退化成一串挨个排的字母，
    // 与相邻标识符连成 `ans(k1)xorans(k2)`。\operatorname 给直立字形 + 两侧薄间距。
    const out = preprocessMath('res = ans(k_1) xor ans(k_2)')
    assert.ok(out.includes('\\operatorname{xor}'), out)
    // 其余词运算符同样升为算子
    for (const word of ['lcm', 'gcd', 'shl', 'shr', 'div', 'and', 'or']) {
      assert.ok(preprocessMath(`$a ${word} b$`).includes(`\\operatorname{${word}}`), `${word}: ${preprocessMath(`$a ${word} b$`)}`)
    }
  })
  it('词运算符的红线：标识符内部 / \\text{} 内 / 文本区 / 已有 \\operatorname 都不改', () => {
    // 下划线与字母前缀属于标识符的一部分
    assert.ok(preprocessMath('$dp_xor = 1$').includes('dp_xor'), 'dp_xor 被改写')
    assert.ok(preprocessMath('$txorid = 2$').includes('txorid'), 'txorid 被改写')
    assert.ok(preprocessMath('$a\\_model + g_{sort}$').includes('model'), 'model 被改写')
    // \text{} 里的字面文本不能被 LaTeX 化（KaTeX 文本模式下会报错）
    assert.ok(preprocessMath('x = \\text{a or b}').includes('\\text{a or b}'), '\\text{} 被改写')
    // 数学区之外的普通文本不是公式
    assert.ok(!preprocessMath('我们先 A and B 再算 c_i').includes('operatorname'), '文本区被改写')
    // 已经写好的 \operatorname 不能被二次包裹（否则预处理不幂等）
    const given = '$a \\operatorname{xor} b$'
    assert.equal(preprocessMath(given), given)
    assert.equal(preprocessMath(preprocessMath(given)), given)
  })
  it('长箭头、iff 与 en dash 渲染为带间距的数学关系（用户反馈）', () => {
    const out = preprocessMath('$$i ──► v   iff   a[i] = v  or  a[i] = k – v$$')
    assert.ok(out.includes('\\longrightarrow'), out)
    assert.ok(out.includes('\\iff'), out)
    assert.ok(out.includes('k - v'), out)
  })
  it('集合构造的竖线转成 \\mid，pref 作为函数名保持直立（用户反馈）', () => {
    const out = preprocessMath('$$pref(v) = #{ i | b[i] <= v } .$$')
    assert.ok(out.includes('\\operatorname{pref}'), out)
    assert.ok(out.includes('\\#\\{ i \\mid b[i] \\le'), out)
    assert.ok(out.includes('v \\}'), out)
  })
  it('反引号里的中文术语去掉反引号（不是代码）', () => {
    const out = preprocessMath('使它的 `价值` 为 `0`，若不是则未使用')
    assert.ok(!out.includes('`价值`'), `中文术语仍是代码: ${out}`)
    assert.ok(out.includes('价值'), out)
    // 含代码语法的中文内容仍是代码（注释、语句）
    assert.ok(preprocessMath('写成 `int x; // 计数` 即可').includes('`int x; // 计数`'))
  })
  it('反引号里的 Unicode 减号 + 下标 → 数学（k−a_i）', () => {
    assert.ok(preprocessMath('使它的价值为 `k−a_i = 0`').includes('$k-a_i = 0$'))
    assert.ok(preprocessMath('或是 `k−a_i` 本身').includes('$k-a_i$'))
    assert.ok(preprocessMath('下标 `a_1` 与 `x_ij`').includes('$a_1$'))
  })
  it('多行伪代码围栏不被转成公式（换行与缩进必须保留）', () => {
    // 用户截图回归：块里只要有一行含 `…`（强数学记号），整块伪代码曾被判成公式，
    // 所有换行被压成一行、KaTeX 还吞掉词间空格（for i → fori、else break answer → elsebreakanswer）
    const block = [
      '```',
      'need = 0',
      'for i = 0…n :',
      '    if cnt[i] > 0 :',
      '        cnt[i]--, need++',
      '    else:',
      '        break',
      'answer = i',
      '```',
    ].join('\n')
    assert.equal(preprocessMath(block), block)
    // 单行伪代码同样不升级（控制流关键字就是代码证据）
    const flat = '```\nneed = 0 for i = 0…n : if cnt[i] > 0 : cnt[i]-- else break answer = i\n```'
    assert.equal(preprocessMath(flat), flat)
    // 但真正的公式围栏照旧升级
    assert.ok(preprocessMath('```\nO(n·3^{n/6})\n```').includes('$$'))
  })
  it('反引号里自带 $ 定界符时保持代码（展示"公式源码怎么写"）', () => {
    const text = '源码写作 `$a_i + b_i$` 的形式'
    assert.equal(preprocessMath(text), text)
  })
  it('折行的公式（第二行以运算符开头）转成块级公式，注释以 \\text{} 保留', () => {
    // 用户截图 3：这张卡不是代码，是一条被折成两行的公式
    const raw = [
      '```',
      'avail(i) = cnt[i]                  // 直接保留 i',
      '         + (i != k-i ? cnt[k-i] : 0) // 变换得到 i（若 i 与 k-i 不同）',
      '```',
    ].join('\n')
    const out = preprocessMath(raw)
    assert.ok(out.includes('$$'), `没有转成块级公式: ${out}`)
    assert.ok(!out.includes('```'), out)
    assert.ok(out.includes('avail(i) = cnt[i]'), out)
    // 编程写法写成的关系符要转成真正的数学关系符（替换会留多余空格，比对前归一化）
    assert.ok(out.replace(/[ \t]+/g, ' ').includes('i \\ne k-i'), out)
    // 两处中文说明都保留
    assert.ok(out.includes('\\text{直接保留 i') && out.includes('变换得到 i（若 i 与 k-i 不同）}'), out)
  })
  it('多行伪代码仍然留在代码卡（折行公式的判定不能放宽到代码）', () => {
    const pseudo = [
      '```',
      'need = 0            // 已经成功构造了 0..need-1',
      'for i = 0 … n:',
      '    if cnt[i] > 0:          cnt[i]--, need++',
      '    else break              // i 不能得到，mex = i',
      'answer = i',
      '```',
    ].join('\n')
    assert.equal(preprocessMath(pseudo), pseudo)
  })
  it('边界：自增/返回/调用这类仍是代码，含关系符与不等式的仍是数学', () => {
    for (const src of ['i++', 'return dp[n]', 'sort(a, a + n)', 'n//2']) {
      const out = preprocessMath(`前缀 \`${src}\` 后缀`)
      assert.ok(out.includes(`\`${src}\``), `${src} 被误转公式: ${out}`)
    }
    for (const [src, want] of [
      ['n ≤ 10^5', '$n \\le 10^5$'],
      ['x = y + 1', '$x = y + 1$'],
    ] as const) {
      // 符号替换会留下多余空格（`≤ ` + 原文空格），比对前先归一化
      const out = preprocessMath(`前缀 \`${src}\` 后缀`).replace(/[ \t]+/g, ' ')
      assert.ok(out.includes(want), `${src} 未按数学渲染: ${out}`)
    }
  })
})

// ---------- 式子被误判成代码卡（截图回归） ----------

/**
 * 用户截图：这类**带函数调用写法的公式**被塞进了代码卡 ——
 *   `cnt(m) = #{ i | b_i(k) < m }`（集合基数定义）
 *   `= max(0, upper_bound(a, k-m) - lower_bound(a, t+1))`（上一条式子的续写）
 * 根因：判定顺序把"弱代码形态（`name(` 函数调用）"排在"关系符"之前，
 * `cnt(` / `max(` 一命中就被否决。正确顺序是**先语句级代码特征，再关系符，最后弱形态**。
 */
describe('带函数调用写法的公式不再被误判成代码卡', () => {
  it('集合基数定义 cnt(m) = #{ i | … } 转成块级公式，集合括号保留', () => {
    const out = preprocessMath('```\ncnt(m) = #{ i | b_i(k) < m }\n```')
    assert.ok(out.includes('$$'), `没有转成块级公式: ${out}`)
    assert.ok(!out.includes('```'), out)
    // KaTeX 里裸花括号是"分组"（不显示），必须转成 \{ \} 才看得到集合括号
    assert.ok(out.includes('\\#\\{ i \\mid b_i(k) < m \\}'), out)
  })
  it('以关系符开头的续写式子（= max(0, upper_bound(…))）转成块级公式', () => {
    const out = preprocessMath('```\n= max(0, upper_bound(a, k-m) - lower_bound(a, t+1))\n```')
    assert.ok(out.includes('$$') && !out.includes('```'), out)
    assert.ok(out.includes('max(0, upper_bound(a, k-m) - lower_bound(a, t+1))'), out)
  })
  it('列表项下的缩进续行：回接上一行合成一个公式，列表标记不被吞', () => {
    const out = preprocessMath(
      '- badR = #{ a_i > t and a_i ≤ k−m }\n      = max(0, upper_bound(a, k-m) - lower_bound(a, t+1))',
    )
    assert.ok(!out.includes('\n\n$$'), `列表标记被块级公式吞掉: ${out}`)
    assert.ok(out.startsWith('- badR = $'), out)
    assert.ok(out.trimEnd().endsWith('lower_bound(a, t+1))$'), out)
    // 集合记号可见：`#` 必须转义，花括号也必须是 `\` 开头的 \{
    // （这一行里有 `\max`，属高结构，\{…\} 会被 enhanceMathLayout 升级成 \left\{…\right\}）
    assert.ok(out.includes('\\#'), out)
    assert.ok(/\\(?:left)?\\{/.test(out) && /\\(?:right)?\\}/.test(out), `集合括号不可见: ${out}`)
    // `max` 应升级为 LaTeX 函数名：`\max(0, …)` —— 直立，且右侧不凭空插空格
    assert.ok(out.includes('\\max(0, upper_bound'), out)
  })
  it('红线：没有关系符的弱代码形态仍是代码', () => {
    for (const body of ['f(n)', 'sort(a, a + n);', 'g[i][j]', 'push_back(x);']) {
      const out = preprocessMath(`\`\`\`\n${body}\n\`\`\``)
      assert.ok(out.includes('```'), `${body} 被误转公式: ${out}`)
    }
  })
  it('红线：伪代码（控制流 + ≥ 这类强数学记号）仍是代码', () => {
    const block = '```\nif c_j ≥ cur :    // 还能给出 cur\n    cur++\n```'
    assert.equal(preprocessMath(block), block)
  })
  it('编程写法的 == 在公式里转成 =', () => {
    assert.ok(preprocessMath('$x == y$').includes('x = y'))
  })
  it('LaTeX 分组花括号不被当成集合括号', () => {
    const out = preprocessMath('$f_{i} = 2^{k}$')
    assert.ok(out.includes('f_{i}') && out.includes('2^{k}'), out)
  })
})

// ---------- 行内代码 / 数学围栏的身份判定 ----------

describe('代码与公式的身份判定', () => {
  it('行内代码里的数学样式不再被改写成公式（保持代码）', () => {
    const out = preprocessMath('用 `dp_max` 记录最大值')
    assert.ok(out.includes('`dp_max`'), out)
    assert.ok(!out.includes('$dp_max$'), out)
  })
  it('行内代码一律保持代码（含纯公式写法，反引号是显式的代码标注）', () => {
    // 复杂度记号是本轮按用户反馈开的例外：`` `O(n log n)` `` 里的反引号是 AI 的手抖，
    // 它是公式而不是代码。其余反引号内容一律保持代码。
    const out = preprocessMath('额外的代价只剩一次 `a[x] + a[x+1]`。')
    assert.ok(out.includes('`a[x] + a[x+1]`'), out)
    assert.ok(preprocessMath('前缀 `sort(a, a + n)` 后缀').includes('`sort(a, a + n)`'))
  })
  it('行内代码里的 ASCII 下标访问不被渲染成 a 下标 [x+1]（截图乱码回归）', () => {
    const text = '额外的代价只剩一次 `a[x] + a[x+1]`（其余抵消）。'
    assert.equal(preprocessMath(text), text)
  })
  it('行内代码里的 Unicode 下标被归一化并转为公式（字形兜底 + 样式统一）', () => {
    // ⱼ ₁ ₙ 这类字符在等宽字体与 KaTeX 基础字体里都缺字形，渲染成方框；
    // 管线入口统一转成 _{...}，随后被识别为 LaTeX 数学、剥掉反引号走公式渲染。
    const text = '相邻的两个元素 `a₁` 与 `a₁₈`（下标取模 `a₁₉`）的和。'
    assert.equal(
      preprocessMath(text),
      '相邻的两个元素 $a_{1}$ 与 $a_{18}$（下标取模 $a_{19}$）的和。',
    )
  })
  it('行内代码自带 $ 定界符时也保持代码（不剥反引号）', () => {
    const text = '源码写作 `$a_i + b_i$` 的形式'
    assert.equal(preprocessMath(text), text)
  })
  it('数学代码块被转为公式（· 不再截断片段）', () => {
    const out = preprocessMath('```\nO(n·3^{n/6})\n```')
    assert.ok(out.includes('$$\nO(n\\cdot 3^{n/6})\n$$'), out)
    assert.ok(!out.includes('```'), out)
  })
  it('```math 围栏即使内容是纯算式也改判为公式', () => {
    const out = preprocessMath('```math\nx = y + 1\n```')
    assert.ok(out.includes('x = y + 1'), out)
    assert.ok(!out.includes('```'), out)
  })
  it('多行推导块每行都是公式时整体转公式', () => {
    const out = preprocessMath('```\nf_i = f_{i-1} + f_{i-2}\ng_i = g_{i-1} · 2\n```')
    assert.ok(out.includes('$$'), out)
    assert.ok(out.includes('\\cdot'), out)
  })
  it('自然语言代码围栏保持代码（不因含下划线转公式）', () => {
    const block = '```python\ndef solve(n):\n    return n * 2\n```'
    const out = preprocessMath(block)
    assert.ok(out.includes('```python'), out)
    assert.ok(out.includes('def solve(n):'), out)
  })
  it('shouldConvertFenceToMath 判定符合预期', () => {
    assert.equal(shouldConvertFenceToMath('math', 'x + y'), true)
    assert.equal(shouldConvertFenceToMath('latex', 'a[x]'), true)
    assert.equal(shouldConvertFenceToMath('cpp', 'int x = a_i;'), false)
    assert.equal(shouldConvertFenceToMath('', 'f_{i} = f_{i-1} + 1'), true)
    assert.equal(shouldConvertFenceToMath('', 'hello world'), false)
    // AI 直接用 Unicode 写公式也必须升级（用户报告"公式被当成代码"的回归）
    assert.equal(shouldConvertFenceToMath('', 'answer = Σ a[i] + (n-1) * min(a[i])'), true)
    assert.equal(shouldConvertFenceToMath('', 'x ≤ y'), true)
    assert.equal(shouldConvertFenceToMath('', 'Σ a_i'), true)
    assert.equal(shouldConvertFenceToMath('', 'a₁ 与 a₁₈ 的和'), true)
    // 纯括号 ASCII 记法保持代码：升级成 KaTeX 会把 a[x+1] 渲染成 a 下标 [x+1]（含义改变）
    assert.equal(shouldConvertFenceToMath('', 'a[x] + a[x+1]'), false)
    assert.equal(shouldConvertFenceToMath('', 'f(n)'), false)
    assert.equal(shouldConvertFenceToMath('', 'g[i][j]'), false)
    // 复杂度记号 O(...) 无歧义，属于公式
    assert.equal(shouldConvertFenceToMath('', 'O(n log n)'), true)
    // 公式 + 代码注释混排（第二行是运算符开头的续行）→ 公式（本轮翻面）：
    // 注释现在会转成 \text{} 保留，所以"注释中文不能进 KaTeX"这条理由已不成立；
    // 用户也明确要求"除了代码以外的公式符号都要渲染"。
    assert.equal(
      shouldConvertFenceToMath('', 'sum = a[0] + a[n-1]  // 每个元素至少出现一次\n     + n * min(a)  // 再额外一次'),
      true,
    )
    // 但**两行独立语句**（都以标识符开头）仍留在代码卡里
    assert.equal(shouldConvertFenceToMath('', 'dp[0] = 1\ndp[i] = dp[i-1] + dp[i-2]'), false)
    // 「同一个量的几种取值」= 分段定义 → 公式（用户反馈"中间有的数学公式被当成代码块了"）
    assert.equal(shouldConvertFenceToMath('', 'value = a_i          (不变)\nvalue = k - a_i      (变换)'), true)
    // 反例：左侧不同就是若干独立语句，仍留在代码卡里
    assert.equal(shouldConvertFenceToMath('', 'value = a_i\nother = k - a_i'), false)
    // 有语句结束符 / 伪代码结构 → 代码
    assert.equal(shouldConvertFenceToMath('', 'avail(i) = cnt[i];\n  + cnt[k-i];'), false)
    // 真实 C++：关键字特征优先于数学记号
    assert.equal(shouldConvertFenceToMath('', 'int main() {\n  int dp_max = 0;\n  return dp_max;\n}'), false)
  })
  it('looksLikeCode 识别常见语言特征', () => {
    assert.equal(looksLikeCode('#include <bits/stdc++.h>'), true)
    assert.equal(looksLikeCode('const int N = 1e5;'), true)
    assert.equal(looksLikeCode('for (int i = 0; i < n; i++)'), true)
    assert.equal(looksLikeCode('f_{i} = f_{i-1} + f_{i-2}'), false)
  })
  it('normalizeLang 归一化语言标记', () => {
    assert.equal(normalizeLang('C++'), 'c++')
    assert.equal(normalizeLang('language-Python'), 'python')
    assert.equal(normalizeLang(' cpp '), 'cpp')
  })
})

// ---------- 复杂度记号 ----------

/**
 * 用户反馈：`O((n+#events)logn+q⋅n)` 没正确渲染。
 *
 * 两个独立缺陷叠加：
 *  1. `COMPLEXITY` 正则只存在于 markdownCode.ts 的 `looksStronglyMath`（服务于围栏 / 行内代码的
 *     身份判定），`markdownMath.ts` 的 `MATH_SEED` 里没有它 —— 正文里的复杂度从来不被包进公式。
 *     只有 `O(n²)` 这种恰好含 Unicode 记号的才行，这就是"时好时坏"的来源。
 *  2. `#` 与 `⋅` 不是数学字符，一旦附近有别的种子，片段会在那里断开，
 *     产出 `O((n+#$events)…)$` 这种半截定界符。
 */
describe('复杂度记号识别为公式', () => {
  it('正文里的 O(…) / Θ(…) / Ω(…) 被包成公式', () => {
    for (const s of ['复杂度为 O((n+#events)logn+q⋅n) 左右。', '总复杂度 O(n log n)', 'Θ(V+E) 与 Ω(2^k)']) {
      assert.ok(preprocessMath(s).includes('$'), `${s} 没有被识别为公式: ${preprocessMath(s)}`)
    }
  })

  it('独立一行的复杂度升级为块级公式', () => {
    const out = preprocessMath('O((n+#events)logn+q⋅n)')
    assert.ok(out.includes('$$'), out)
    assert.ok(!out.includes('```'), out)
  })

  it('#events 不再把公式劈成两半（半截定界符回归）', () => {
    const out = preprocessMath('复杂度为 O((n+#events)logn+q⋅n) 左右。')
    assert.equal(out, '复杂度为 $O((n+\\#events)\\log n+q\\cdot n)$ 左右。')
    // 关键：不能出现 `+#$` 这种"$ 被拼进正文中间"的形态
    assert.ok(!out.includes('#$'), `出现了半截定界符: ${out}`)
  })

  it('⋅(U+22C5) 与 ·(U+00B7) 一样转成 \\cdot', () => {
    assert.ok(preprocessMath('复杂度待梳 $q⋅n$').includes('\\cdot'))
    assert.ok(preprocessMath('复杂度待梳 $q·n$').includes('\\cdot'))
  })

  it('红线：TODO( / INFO( 这类普通单词不会被当成大 O', () => {
    const out = preprocessMath('参见 TODO(事项) 与 INFO(说明) 两节')
    assert.ok(!out.includes('$'), `普通单词被当复杂度: ${out}`)
  })

  it('红线：Markdown 标题的 # 与正文里的 #1 不受影响', () => {
    assert.ok(!preprocessMath('## 第二节').includes('$'))
    assert.ok(!preprocessMath('排名 #1 的做法是 dp').includes('$'))
  })
})

// ---------- 分段定义（同一量的几种取值）----------

/**
 * 用户报告的一段 mex 讲解（原文粘贴的渲染结果里，这两行被塞进了代码卡）。
 *
 * 它没有 LaTeX 命令、没有 Unicode 数学符号，只有普通的 ASCII `=`，
 * 于是落在 `shouldConvertFenceToMath` 多行分支的最后一条（"至少一行含强数学记号"）之外，
 * 整块退回代码卡 —— 而**同样内容只剩一行**时是能正常渲染成公式的。
 * 这组用例锁住这个不一致。
 */
describe('分段定义：同一个量的几种取值不再被当成代码', () => {
  const FENCE = '```\nvalue = a_i          (不变)\nvalue = k - a_i      (变换)\n```'

  it('isPiecewiseDefinition 只看"关系符左侧是否一致"', () => {
    assert.equal(isPiecewiseDefinition(['value = a_i', 'value = k - a_i']), true)
    // 左侧不同 = 若干独立语句，绝不能放进来
    assert.equal(isPiecewiseDefinition(['dp[0] = 1', 'dp[i] = dp[i-1] + dp[i-2]']), false)
    // 没有关系符 / 少于两行 / 含伪代码结构 → 不是分段定义
    assert.equal(isPiecewiseDefinition(['a_i', 'k - a_i']), false)
    assert.equal(isPiecewiseDefinition(['x = 1']), false)
    assert.equal(isPiecewiseDefinition(['if x = 1 : y', 'x = 2']), false)
  })

  it('空标记围栏里的分段定义不再保留围栏', () => {
    const out = preprocessMath(FENCE)
    assert.ok(!out.includes('```'), out)
  })

  it('每条取值各自排成一条块级公式（不合并成一行）', () => {
    const out = preprocessMath(FENCE)
    // 必须是两条独立的 $$…$$，而不是拼成 `value = a_i value = k - a_i`
    assert.equal((out.match(/\$\$/g) ?? []).length, 4, out)
    assert.ok(out.includes('$$\nvalue = a_i \\quad \\text{(不变)}\n$$'), out)
    assert.ok(out.includes('$$\nvalue = k - a_i \\quad \\text{(变换)}\n$$'), out)
  })

  it('行尾中文小注保留括号原文，不被吞掉', () => {
    const out = preprocessMath(FENCE)
    assert.ok(out.includes('\\text{(不变)}'), out)
    assert.ok(out.includes('\\text{(变换)}'), out)
    // 小注不能留在公式外面（`\\quad` 之后必须是 text 盒子，否则中文缺字形出方框）
    assert.ok(!/\\\$\$?\s*\(不变\)/.test(out), out)
  })

  it('缩进代码块里的分段定义同样逐行各排一条公式', () => {
    const out = preprocessMath('    value = a_i          (不变)\n    value = k - a_i      (变换)')
    assert.ok(out.includes('$$\nvalue = a_i \\quad \\text{(不变)}\n$$'), out)
    assert.ok(out.includes('$$\nvalue = k - a_i \\quad \\text{(变换)}\n$$'), out)
  })

  it('红线：一组独立赋值语句仍留在代码卡里', () => {
    const out = preprocessMath('```\ndp[0] = 1\ndp[i] = dp[i-1] + dp[i-2]\n```')
    assert.ok(out.includes('```'), out)
    assert.ok(out.includes('dp[0] = 1'), out)
    assert.ok(!out.includes('$$'), out)
  })
})

// ---------- 加粗 + 公式 ----------

describe('加粗定界符不卷入公式', () => {
  it('**p_{qi,1} < ... < p_{qi,k}** 渲染为加粗包裹公式', () => {
    const out = preprocessMath('**p_{qi,1} < p_{qi,2} < … < p_{qi,k}**')
    // ** 保留在公式外，remark-math 已验证可解析为 strong > inlineMath
    assert.ok(out.startsWith('**$'), `** 应在公式外: ${out}`)
    assert.ok(out.endsWith('$**'), `** 应在公式外: ${out}`)
    assert.ok(!out.includes('$**p_'), `公式内部不应含 **: ${out}`)
  })
})

// ---------- Unicode 数学符号 ----------

describe('Unicode 数学符号归一化', () => {
  it('Σ(ri − li + 1) ≤ 10^6 转为完整 LaTeX 公式', () => {
    const out = preprocessMath('所有测试的 Σ(ri − li + 1) ≤ 10^6。')
    // 公式不应在 − 或 … 处断开：应产生单个 $...$ 包裹
    assert.ok(out.includes('$\\sum (ri - li + 1) \\le  10^6$'), out)
  })
  it('… → \\dots', () => {
    const out = preprocessMath('设 x_{i} … 为序列')
    assert.ok(out.includes('\\dots'), out)
  })
  it('变体选择符被清除（避免 KaTeX 渲染出方框）', () => {
    const out = preprocessMath('求和 ∑\uFE0F 记为 S')
    assert.ok(!out.includes('\uFE0F'), out)
  })
})

// ---------- 独立成行的公式：升级为块级公式 ----------

describe('独立成行的公式升级为块级公式', () => {
  it('整行只有公式时升为 $$…$$（居中、独立成行）', () => {
    const out = preprocessMath('dp_i = \\max_{0 \\le j < i} (dp_j + (i - j))')
    assert.ok(out.includes('$$\n'), out)
    assert.ok(out.includes('\n$$'), out)
  })

  it('升为块级公式时不做行内包裹（避免 $$ 内嵌套 $…$）', () => {
    const out = preprocessMath('dp_i = \\max_{0 \\le j < i} (dp_j + (i - j))')
    const body = out.split('$$')[1] ?? ''
    assert.ok(!body.includes('$'), `块级公式内部不应有嵌套 $: ${out}`)
  })

  it('极短引导语 + 公式时也升级为块级（"于是得到 <公式>"）', () => {
    const out = preprocessMath('于是得到 dp_i = \\max_{0 \\le j < i} (dp_j - j)')
    assert.ok(out.includes('$$'), out)
    assert.ok(out.includes('于是得到'), '引导语应保留', out)
  })

  it('说明句里的公式保持行内（引导语较长时不整行升级）', () => {
    const out = preprocessMath('如果当前的划分方案满足前面所有这些条件，那么 dp_i 就等于最大值')
    assert.ok(!out.includes('$$'), out)
  })

  it('列表项里的条件公式保持行内', () => {
    const out = preprocessMath('- 若 $Y_i \\ge 0$ 且 $B_j \\le B_i$，则取最大值 $dp_j - j$')
    assert.ok(!out.includes('$$'), out)
  })

  it('等式不再被拆成 $dp_i =$ $\\max…$ 两段', () => {
    const out = preprocessMath('于是得到 dp_i = \\max_{0 \\le j < i} (dp_j - j)')
    assert.ok(!/\$[^$\n]*\$\s+\$/.test(out), `出现相邻公式碎片: ${out}`)
  })

  it('短句 "令 x = 5 即可" 不被公式化', () => {
    const out = preprocessMath('令 x = 5 即可')
    assert.equal(out, '令 x = 5 即可')
  })

  it('LaTeX 间距命令 \\; 不截断公式（归一化为 \\,）', () => {
    const out = preprocessMath('dp_i = \\max_{0 \\le j < i,\\; Y_j \\le Y_i} (dp_j - j)')
    assert.ok(!out.includes('\\;'), out)
    assert.ok(out.includes('\\,'), out)
    // 整条公式必须保持完整（不出现 $ 碎片）
    assert.ok(!/\$[^$\n]*\$\s*\$/m.test(out.replace(/\$\$/g, '')), out)
  })

  it('非表格行里公式内的竖线不被截断（绝对值）', () => {
    const out = preprocessMath('dp_i = \\max\\left(dp_{i-1}, i, i + |\\max_{k}(dp_k - k)|\\right)')
    assert.ok(out.includes('|\\max'), `竖线把公式截断了: ${out}`)
    // 公式必须完整：两端是同一个 $…$ / $$…$$ 区
    assert.ok(!/\$[^$\n]*\|\s*\$/.test(out), out)
  })
})

// ---------- 公式排版增强（本轮反馈 1/2/3） ----------

describe('公式排版增强', () => {
  it('大运算符补 \\limits：范围不再挤在右下角', () => {
    const out = preprocessMath('dp_i = \\max_{Y_j \\le Y_i, B_j \\le B_i}(dp_j - j)')
    assert.ok(out.includes('\\max\\limits_'), out)
  })
  it('已是 \\limits 的不重复补', () => {
    const out = preprocessMath('dp_i = \\max\\limits_{j}(dp_j)')
    assert.equal((out.match(/\\limits/g) ?? []).length, 1, out)
  })
  it('\\min / \\sum / \\lim 同样补 \\limits', () => {
    assert.ok(preprocessMath('x = \\min_{i} a_i').includes('\\min\\limits'))
    assert.ok(preprocessMath('x = \\lim_{n} a_n').includes('\\lim\\limits'))
  })
  it('公式含高结构时 \\{ \\} 升级为 \\left\\{ \\right\\}（大括号随内容放大）', () => {
    const out = preprocessMath('dp_i = \\max\\{dp_{i-1}, i, \\max_{Y_j}(dp_j - j)\\}')
    assert.ok(out.includes('\\left\\{'), out)
    assert.ok(out.includes('\\right\\}'), out)
  })
  it('公式不含高结构时不动花括号（短公式保持紧凑）', () => {
    const out = preprocessMath('S = \\{a, b\\}')
    assert.ok(out.includes('\\{a, b\\}'), out)
    assert.ok(!out.includes('\\left\\{'), out)
  })
  it('已有 \\left\\{ 的不重复处理', () => {
    const out = preprocessMath('x = \\max\\left\\{a, \\frac{1}{2}\\right\\}')
    assert.equal((out.match(/\\left\\{/g) ?? []).length, 1, out)
    assert.equal((out.match(/\\right\\}/g) ?? []).length, 1, out)
  })
  it('正文里的普通花括号文本不受影响', () => {
    const out = preprocessMath('用 {a, b} 表示集合 S_1')
    assert.ok(!out.includes('\\left\\{'), out)
  })
})

// ---------- Unicode 上下标字符归一化 ----------

describe('Unicode 上下标字符归一化', () => {
  it('修饰字母下标 dpⱼ → dp_{j}（数学字体渲染，不再是方框）', () => {
    const out = preprocessMath('长度为 dpⱼ 的前缀')
    assert.ok(out.includes('$dp_{j}$'), out)
    assert.ok(!/[\u2C7C]/.test(out), out)
  })
  it('数字下标 a₁₈ → a_{18}', () => {
    const out = preprocessMath('元素 a₁₈ 的值')
    assert.ok(out.includes('$a_{18}$'), out)
  })
  it('上标 2ⁿ → 2^{n}', () => {
    const out = preprocessMath('共 2ⁿ 种方案')
    assert.ok(out.includes('$2^{n}$'), out)
  })
  it('已是 LaTeX 写法的不受影响', () => {
    const out = preprocessMath('公式 $dp_j$ 与 $2^k$')
    assert.equal(out, '公式 $dp_j$ 与 $2^k$')
  })
})

// ---------- 公式源码清理（本轮反馈：源码被当文本显示） ----------

describe('公式源码清理', () => {
  it('去掉 \\Biggl\\left 这类非法嵌套（KaTeX 会因此解析失败并回退显示源码）', () => {
    const out = preprocessMath('dp_i = \\max\\Biggl\\left\\{a, b\\Biggr\\right\\}')
    assert.ok(!out.includes('\\Biggl'), out)
    assert.ok(!out.includes('\\Biggr'), out)
    assert.ok(out.includes('\\left\\{') && out.includes('\\right\\}'), out)
  })
  it('合法的手动尺寸命令保留（\\Bigl( 后面不跟 \\left）', () => {
    const out = preprocessMath('f\\Bigl(x\\Bigr) = x')
    assert.ok(out.includes('\\Bigl('), out)
  })
  it('围栏正文的空行被压掉（空行会提前终止 $$ 块）', () => {
    const out = preprocessMath('```latex\n\\boxed{a,\n\nb}\n```')
    assert.equal((out.match(/\$\$/g) ?? []).length, 2, out)
    assert.ok(!/\$\$[\s\S]*\n\s*\n[\s\S]*\$\$/.test(out), `块级公式内部出现空行: ${out}`)
  })
  it('围栏正文的折行被合并为单行', () => {
    const out = preprocessMath('```latex\n\\boxed{a,\nb,\nc}\n```')
    const body = out.match(/\$\$\n([\s\S]*?)\n\$\$/)?.[1] ?? ''
    assert.ok(body.includes('a, b, c'), out)
    assert.ok(!body.includes('\n'), out)
  })
  it('块级公式仍保持「$$ 独占一行」结构', () => {
    const out = preprocessMath('\\[O(n \\log n)\\]')
    assert.equal(out, '$$\nO(n \\log n)\n$$')
    assert.ok(!/^\$\$[^\n]/m.test(out), `$$ 后面不应紧跟内容: ${out}`)
  })
})

// ---------- 表格结构保护（本轮反馈：表格退化成纯文本） ----------

describe('表格结构保护', () => {
  it('无空行、单元格紧贴的表格不被公式化', () => {
    const table = [
      '|转移|说明|',
      '|---|---|',
      '|dp_i ← dp_{i-1}|直接把第 i 个位置当作单点|',
      '|若 Y_i ≥ 0 且 B_i ≥ 0，则 dp_i ← i|整段 [1, i] 本身就是红色|',
    ].join('\n')
    const out = preprocessMath(table)
    // 结构必须原样：行数、分隔线、竖线位置都不变
    assert.equal(out.split('\n').length, 4, out)
    assert.equal(out.split('\n')[1], '|---|---|', out)
    assert.equal((out.match(/\|/g) ?? []).length, (table.match(/\|/g) ?? []).length, out)
  })

  it('表格单元格内的公式仍被包裹', () => {
    const out = preprocessMath('|a|b|\n|---|---|\n|dp_{i-1}|dp_i|')
    assert.ok(out.includes('$dp_{i-1}$'), out)
    assert.ok(out.includes('$dp_i$'), out)
  })

  it('表格外的绝对值 |…| 仍进公式', () => {
    const out = preprocessMath('令 x = |a| + |b| 即可')
    assert.ok(out.includes('$|a| + |b|$'), out)
  })
})

// ---------- 行内代码里的公式（本轮反馈：dp_i 仍是字面文本） ----------

describe('行内代码里的数学被转回公式', () => {
  it('反引号包住的 LaTeX 下标转公式（AI 常误加反引号）', () => {
    const out = preprocessMath('保持 `dp_{i-1}`、整段 `[1, i]`、')
    assert.ok(out.includes('$dp_{i-1}$'), out)
    assert.ok(out.includes('`[1, i]`'), '非 LaTeX 内容应保持代码', out)
  })
  it('单字母下标的反引号内容也转公式（与 dp_{i-1} 风格统一）', () => {
    const out = preprocessMath('于是 `dp_i` 等于 `dp_{i-1}` 加一')
    assert.ok(out.includes('$dp_i$'), out)
    assert.ok(out.includes('$dp_{i-1}$'), out)
    assert.ok(!out.includes('`dp'), out)
  })
  it('真代码的反引号内容保持代码', () => {
    for (const src of ['push_back', 'vis_cnt', 'a[x] + a[x+1]', 'g[prev].push_back(cur)', 'sort(a, a + n)']) {
      const out = preprocessMath(`前缀 \`${src}\` 后缀`)
      assert.ok(out.includes(`\`${src}\``), `${src} 被误转公式: ${out}`)
    }
  })
})

// ---------- 公式块不被标成代码（本轮反馈） ----------

describe('公式块不被识别为代码', () => {
  it('公式 + 行尾注释的围栏转为公式（注释被剥掉）', () => {
    const out = preprocessMath('```\nS = Σ a[i]   // 所有元素之和\nM = min_{0≤i<n}( a[i] + a[(i+1) mod n] )   // 相邻两数之和最小值\n```')
    assert.ok(out.includes('$$'), out)
    assert.ok(!out.includes('```'), out)
    assert.ok(!out.includes('//'), `注释应被剥掉: ${out}`)
  })
  it('多行值表转为公式（部分行没有强数学记号也可以）', () => {
    const out = preprocessMath('```\nn = 1 :  a[0]\nn = 2 :  S + min(a[0], a[1])\nn ≥ 3 :  S + M\n```')
    assert.ok(out.includes('$$'), out)
    assert.ok(!out.includes('```'), out)
  })
  it('真 C++ 带注释的围栏仍是代码', () => {
    const text = '```cpp\nint x = 1;   // 初始化\nreturn x;\n```'
    assert.equal(preprocessMath(text), text)
  })
  it('stripLineComments 不误伤整除与 URL', () => {
    assert.equal(stripLineComments('a = n//2'), 'a = n//2')
    assert.equal(stripLineComments('见 http://example.com 说明'), '见 http://example.com 说明')
    assert.equal(stripLineComments('S = Σ a[i]   // 求和'), 'S = Σ a[i]')
  })
})

// ---------- 引用块里的公式（本轮反馈：渲染有问题） ----------

describe('引用块里的公式', () => {
  const quoted = [
    '> \\[',
    '> dp_i=\\max\\Bigl\\{dp_{i-1},\\ i+\\max_{\\substack{0\\le j<i}}\\bigl(dp_j-j\\bigr)\\Bigr\\},',
    '> \\qquad dp_0=0.',
    '> \\]',
  ].join('\n')

  it('引用块里的 \\[...\\] 转成块级公式，且每行保留 > 前缀', () => {
    const out = preprocessMath(quoted)
    const lines = out.split('\n')
    // `$$` 必须带引用前缀，否则会脱离引用块
    assert.ok(lines.some((l) => l === '> $$'), `$$ 行缺少引用前缀: ${out}`)
    assert.equal((out.match(/> \$\$/g) ?? []).length, 2, out)
  })

  it('公式主体本身不含引用符（KaTeX 收到的是剥掉前缀后的内容）', () => {
    const out = preprocessMath(quoted)
    const math = out.match(/> \$\$\n([\s\S]*?)\n> \$\$/)?.[1] ?? ''
    assert.ok(math.length > 0, out)
    // 每行可能带 Markdown 引用前缀（渲染器会剥掉，这是引用块语法的一部分），
    // 但**剥掉前缀后的公式主体**里不能再出现 `> `，否则才是真正的解析失败
    const body = math
      .split('\n')
      .map((l) => l.replace(/^[ \t]*>[ \t]?/, ''))
      .join('\n')
    assert.ok(!body.includes('>'), `公式主体残留引用符: ${body}`)
    assert.ok(body.includes('dp_i'), body)
  })

  it('修复 \\Bigl\\left 非法嵌套（KaTeX 会因此解析失败、回退显示源码）', () => {
    const out = preprocessMath('dp_i=\\max\\Bigl\\left\\{x\\Bigr\\right\\}')
    assert.ok(!out.includes('\\Bigl'), out)
    assert.ok(!out.includes('\\Bigr'), out)
    assert.ok(out.includes('\\left\\{') && out.includes('\\right\\}'), out)
    // \\left 与 \\right 必须成对
    assert.equal((out.match(/\\left\b/g) ?? []).length, (out.match(/\\right\b/g) ?? []).length, out)
  })

  it('大括号升级后也要成对（\\Bigl\\{ → \\left\\{ … \\right\\}）', () => {
    const out = preprocessMath('dp_i=\\max\\Bigl\\{dp_{i-1},\\ \\max_{j}(dp_j-j)\\Bigr\\}')
    assert.equal((out.match(/\\left\b/g) ?? []).length, (out.match(/\\right\b/g) ?? []).length, out)
    assert.ok(!out.includes('\\Bigl'), out)
    assert.ok(!out.includes('\\Bigr'), out)
  })

  it('合法的手动尺寸命令（\\Bigl( 无嵌套）不被改动', () => {
    const out = preprocessMath('f\\Bigl(x\\Bigr) = x')
    assert.ok(out.includes('\\Bigl(') && out.includes('\\Bigr)'), out)
  })

  it('引用块里的行内公式保持行内', () => {
    const out = preprocessMath('> 说明：\\(a_i\\) 是变量')
    assert.ok(out.includes('> 说明：$a_i$ 是变量'), out)
    assert.ok(!out.includes('$$'), out)
  })
})

// ---------- 表格中的数学公式 ----------

describe('表格中的数学公式', () => {
  it('表格单元格里已有的 $...$ 公式不被破坏', () => {
    const text = [
      '| 步骤 | 复杂度 |',
      '| --- | --- |',
      '| 排序 | $O(n \\log n)$ |',
      '| DP | $O(n)$ |',
    ].join('\n')
    const out = preprocessMath(text)
    assert.ok(out.includes('$O(n \\log n)$'), out)
    assert.ok(out.includes('$O(n)$'), out)
    // 表格结构（行/分隔线）必须完整保留
    assert.equal(out.split('\n').length, 4, out)
    assert.ok(out.split('\n')[1]!.includes('---'), out)
  })

  it('表格单元格里的 \\(...\\) 归一化为行内公式', () => {
    const text = '| a | b |\n| --- | --- |\n| \\(f_i\\) | \\(g_i\\) |'
    const out = preprocessMath(text)
    assert.ok(out.includes('$f_i$') && out.includes('$g_i$'), out)
    assert.ok(!out.includes('\\('), out)
  })

  it('表格单元格里的裸数学被包裹为行内公式', () => {
    const text = '| A | B |\n| --- | --- |\n| 裸公式 a_i | 2^k |'
    const out = preprocessMath(text)
    assert.ok(out.includes('$a_i$'), out)
    assert.ok(out.includes('$2^k$'), out)
  })

  it('单元格内公式不产生块级公式（$$ 会拆散表格）', () => {
    const text = '| a | b |\n| --- | --- |\n| \\[x_i\\] | y |'
    const out = preprocessMath(text)
    assert.ok(!out.includes('$$'), `单元格内不应出现块级公式: ${out}`)
  })

  it('单元格内的行内代码保持代码（真代码标识符不转公式）', () => {
    // 说明：单元格里的 `a[x]` 这类**单个下标记号**本轮已按数学渲染（见身份判定用例），
    // 这里用真正的代码标识符守住"单元格内代码不被转公式"这条。
    const text = '| a | b |\n| --- | --- |\n| `push_back` | `dp_max` |'
    assert.equal(preprocessMath(text), text)
  })

  it('单元格内的转义竖线不破坏表格结构', () => {
    const text = '| 表达式 | 说明 |\n| --- | --- |\n| $a \\| b$ | 按位或 |'
    const out = preprocessMath(text)
    assert.equal(out.split('\n').length, 3, out)
    assert.ok(out.includes('$a \\| b$'), out)
  })

  it('单元格内公式里的裸竖线转写成 \\vert（绝对值不再拆烂表格）', () => {
    const text = '| 情况 | 公式 |\n| --- | --- |\n| 距离 | $|l - r|$ |'
    const out = preprocessMath(text)
    // 行数不变（表格结构完整），公式内的竖线不再是裸竖线
    assert.equal(out.split('\n').length, 3, out)
    assert.ok(out.includes('$\\vert l - r\\vert$'), out)
    // 公式区域里不允许再出现裸竖线（否则 remark-gfm 会按它切单元格）
    const dataRow = out.split('\n')[2]!
    const mathRegion = /\$[^$]+\$/.exec(dataRow)![0]
    assert.ok(!mathRegion.includes('|'), mathRegion)
  })

  it('单元格内集合构造经 \\vert 转写后仍升级为 \\{ \\mid \\}', () => {
    // 裸花括号 + 裸竖线：竖线转 \vert 后，集合构造升级路径要照常识别
    // （\vert 转写会留一个空格，\mid 替换后可能是 \mid  双空格，KaTeX 排版等价）
    const text = '| 集合 | 说明 |\n| --- | --- |\n| $A = {x | x > 0}$ | 正数集 |'
    const out = preprocessMath(text)
    assert.ok(/\\{x \\mid\s+x > 0\\}/.test(out), out)
    assert.equal(out.split('\n').length, 3, out)
  })

  it('已转义花括号里的竖线转 \\vert 后保持原样（KaTeX 直接渲染为 |）', () => {
    const text = '| 集合 | 说明 |\n| --- | --- |\n| $A = \\{x | x > 0\\}$ | 正数集 |'
    const out = preprocessMath(text)
    assert.ok(out.includes('\\{x \\vert'), out)
    assert.ok(!/\|[^|\n]*\vert/.test(out.split('\n')[2]!), out)
  })

  it('表格行里 \\(...\\) 形式的公式竖线同样转写', () => {
    const text = '| f | 说明 |\n| --- | --- |\n| \\(|x|\\) | 绝对值 |'
    const out = preprocessMath(text)
    assert.ok(out.includes('$\\vert x\\vert$'), out)
  })

  it('非公式的伪数学区域（$ | b$）不转写，表格文本不受污染', () => {
    const text = '| a$ | b$ | 帐单 |\n| --- | --- |\n| 1 | 2 | 3 |'
    const out = preprocessMath(text)
    // `$ | b$` 开 $ 后紧跟空白，remark-math 不认为它是公式 —— 必须原样保留
    assert.ok(out.includes('$ | b$') || !out.includes('\\vert'), out)
  })

  it('带语言标记围栏里的 ASCII 表格不被竖线转写误伤', () => {
    // 空标记围栏装表格会被当 Markdown 正文剥掉围栏（stripOuterCodeFence 既有行为），
    // 这里用显式代码语言的围栏守住「代码内容绝不被改写」
    const text = '```cpp\n| a | b |\n| 1 | 2 |\n```'
    assert.equal(preprocessMath(text), text)
  })

  it('表格外的公式竖线保持原样（绝对值照常渲染）', () => {
    const text = '区间公式 $|l - r|$ 求最大距离'
    const out = preprocessMath(text)
    assert.ok(out.includes('$|l - r|$'), out)
  })
})

// ---------- 外层围栏剥离的边界 ----------

describe('外层围栏剥离', () => {
  it('空标记围栏里是代码时保留围栏', () => {
    for (const text of ['```\na[x] + a[x+1]\n```', '```\nint x = 1;\n```', '```\ng[prev].push_back(cur);\n```']) {
      assert.equal(stripOuterCodeFence(text), text, text)
      assert.equal(preprocessMath(text), text, text)
    }
  })

  it('空标记围栏里是 Unicode 数学写法时升级为公式', () => {
    const out = preprocessMath('```\na₁ 与 a₁₈ 的和\n```')
    assert.ok(out.includes('$$') && !out.includes('```'), out)
  })

  it('空标记围栏里是 Markdown 正文时剥掉围栏', () => {
    const out = stripOuterCodeFence('```\n# 标题\n- 列表项\n```')
    assert.ok(out.startsWith('# 标题'), out)
  })

  it('```markdown 围栏始终剥掉', () => {
    assert.equal(stripOuterCodeFence('```markdown\n普通正文\n```'), '普通正文\n')
  })
})

// ---------- 原有能力回归 ----------

describe('原有能力回归', () => {
  it('裸下标 c_i 被包裹', () => {
    assert.ok(preprocessMath('复杂度与 c_i 有关').includes('$c_i$'))
  })
  it('裸上标 2^k 被包裹', () => {
    assert.ok(preprocessMath('枚举 2^k 个子集').includes('$2^k$'))
  })
  it('LaTeX 命令 \\frac{...}{...} 被包裹', () => {
    const out = preprocessMath('答案是 \\frac{n(n+1)}{2}')
    assert.ok(out.includes('$\\frac{n(n+1)}{2}$'), out)
  })
  it('已有 $...$ 公式内部不被二次处理', () => {
    const out = preprocessMath('已知 $a_i + b_i$ 求和')
    assert.equal(out, '已知 $a_i + b_i$ 求和')
  })
  it('预处理是幂等的（对已处理结果再跑一次不改变结构）', () => {
    const once = preprocessMath('设 f_{i} = f_{i-1} + a_i，复杂度 O(n log n)')
    const twice = preprocessMath(once)
    assert.equal(twice, once)
  })
})

/**
 * 英文语境的回归（本次修复）。
 *
 * 上述全部用例都是**中文**语境，而 MATH_SEED 的 `标识符 + 方括号` 分支曾写成
 * `\b[a-zA-Z_]\w*\s*[[{]…`（允许中间有空格），于是英文里「名词 + 方括号补充说明」
 * 被当成数学种子；`/` 又属于数学字符，向后扩展会一路吞过 Markdown 链接的 `](http`。
 * 中文用例恰好绕开了这条分支（CJK 不匹配 `\b[a-zA-Z_]`），所以一直没被发现。
 */
describe('英文语境的方括号/链接不被误当公式（回归）', () => {
  it('Markdown 链接前的英文单词不再把链接卷进公式', () => {
    for (const src of [
      'see [text](http://example.com) for details',
      'See [the docs](https://example.com/docs) for more.',
      'For more details, see [here](https://example.com).',
      '- See [docs](https://example.com)',
      '1. Read [guide](https://example.com)',
      'Read from [here](https://example.com) now',
    ]) {
      const out = preprocessMath(src)
      assert.equal(out, src, `链接被公式管线改写了: ${out}`)
      // 链接语法必须完整保留，否则 remark 解析不出 <a>
      assert.ok(out.includes(']('), `链接语法丢失: ${out}`)
      assert.ok(!out.includes('$'), `链接被包进公式: ${out}`)
    }
  })

  it('中英混排（英文词紧跟链接）同样安全', () => {
    for (const src of [
      '题解见 editorial [链接](https://example.com) 里',
      '可以看 link [题解](https://example.com)',
      '参考 official [editorial](https://codeforces.com/blog/entry/1)',
    ]) {
      assert.equal(preprocessMath(src), src, `混排语境被改写`)
    }
  })

  it('英文正文里的方括号补充说明不再被包成公式', () => {
    for (const src of [
      'see note [1] below',
      'the value of x [see below]',
      'see Fig [3] for details',
      'array a [i] index',
      'use arr [0] to access',
      'in section [2.1] we show',
      'Read the manual [PDF] first',
    ]) {
      assert.equal(preprocessMath(src), src, `普通方括号被包进公式: ${preprocessMath(src)}`)
    }
  })

  it('不带空格的下标访问仍然是公式（本次收紧没有误伤）', () => {
    assert.ok(preprocessMath('状态 dp[i][j] 表示前 i 个').includes('$dp[i][j]$'))
    assert.ok(preprocessMath('权值正是 a[offset]').includes('$a[offset]$'))
    assert.ok(preprocessMath('用 dp_max[i] 记录').includes('$dp_max[i]$'))
  })
})

/**
 * `==` 是**编程**关系运算符（数学里相等是单个 `=`），因此显式代码区里的 `==`
 * 必须原样保留。此前 `looksLikeCode` 不认 `==`，导致 `` `a == b` `` 与裸围栏
 * 被改判成公式、`==` 再被压成 `=`，等号语义丢失。
 */
describe('代码区里的 == 保持原样（回归）', () => {
  it('行内代码里的 == 不被升级为公式', () => {
    for (const src of ['`a == b`', '`x == null`', '`a === b`', '`a == b` 判断相等']) {
      const out = preprocessMath(src)
      assert.ok(out.includes('=='), `== 被吞掉: ${out}`)
      assert.ok(!out.includes('$'), `行内代码被升级成公式: ${out}`)
    }
  })

  it('裸围栏里的 == 保持代码块', () => {
    for (const body of ['print(a == b)', 'x == y', 'dp[i] == dp[j]', 'sum == total']) {
      const out = preprocessMath('```\n' + body + '\n```')
      assert.ok(out.includes('```'), `围栏被转成公式: ${out}`)
      assert.ok(out.includes('=='), `== 被改写: ${out}`)
      assert.ok(!out.includes('$$'), `围栏被转成块级公式: ${out}`)
    }
  })

  it('显式 $...$ 公式里的 == 仍按数学转成 =（有意保留）', () => {
    assert.ok(preprocessMath('$x == y$').includes('x = y'))
  })
})

/**
 * 链接**目的地**里的 `_`、`^`、`[` 会命中裸数学种子（`[a-zA-Z]+_[a-zA-Z0-9]+` 等），
 * 把 URL 片段包进 `$…$` 后链接再也解析不出来：
 *   `[x](https://e.com/ab_cd)` → ``[x](https:`//e.com/ab_cd)``
 * 因此 `](…)` 里的目的地被当作非文本区保护；链接**文本**仍走正常管线。
 */
describe('链接目的地不被当作数学（回归）', () => {
  it('URL 里的 _ ^ [ ] 不触发裸数学包裹', () => {
    for (const src of [
      '链接 [文本](https://example.com/path_(with_parens))',
      'see [x](https://e.com/ab_cd)',
      '链接 [文本](https://example.com/path_x)',
      'see [x](https://e.com/a^b)',
      'see [x](https://e.com/a[i])',
      '参考 [题解](https://www.luogu.com.cn/problem/solution/P1001)',
    ]) {
      assert.equal(preprocessMath(src), src, `链接目的地被改写: ${preprocessMath(src)}`)
    }
  })

  it('链接文本里的数学照常渲染（只保护目的地）', () => {
    const out = preprocessMath('[复杂度 $O(n)$ 的说明](https://e.com/a_b)')
    assert.ok(out.includes('$O(n)$'), `链接文本里的公式被吞: ${out}`)
    assert.ok(out.includes('a_b'), `链接目的地被改写: ${out}`)
  })
})
