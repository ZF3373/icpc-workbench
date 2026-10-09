/**
 * 渲染结构验证（静态渲染，不需要浏览器 —— headless Chrome 在本沙箱会被进程级拦截）。
 *
 * 用法（在 client/ 下）：node test/renderCheck.mjs
 *
 * 步骤：
 *   1. 用 TypeScript 编译器 API 把 Markdown.tsx 编到 test/.render-out（不派生子进程，
 *      沙箱禁止 Node 通过管道 spawn 子进程；vite build 同样跑不了，所以只验证渲染结构）
 *   2. 注册 renderHooks.mjs 处理 .css / .ts 扩展名
 *   3. renderToStaticMarkup 出一段 HTML，对结构与可见文本做断言
 *
 * 断言技巧（都是踩过的坑）：
 *   · 「公式到底有没有被解析」用 katex.renderToString(body, { throwOnError: true })
 *     判定 —— 这是定位"公式源码被当普通文本显示"的唯一可靠手段；
 *     复用 markdownDiag.auditMathRender，与实际渲染走同一条 KaTeX 路径。
 *   · 数表头要数 `<th[ >]`，`<th[^>]*>` 会匹配到 `<thead>`。
 *   · KaTeX 在 `<annotation>` 里回显 TeX 源码，判断"可见文本里有没有残留源码"
 *     必须先剔除 annotation，否则永远为真。
 *   · 「修复前确实坏」不能靠猜：半截 `$$` / `\[` 在渲染层**不会**留下字面 `$$`
 *     （remark-math 把未闭合的 $$ 当到文件末尾的公式，我们的管线也会把未闭合的
 *     `\[` 换成不配对的 `$$`），此时要看的是**管线输出里公式区是否配对**、
 *     以及正文有没有被吞进公式区。
 */

import { createRequire, register } from 'node:module'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolvePath(here, '..')
/** Markdown.tsx 里 `import 'katex/dist/katex.min.css'` 实际会解析到的那份样式表 */
const katexCssPath = createRequire(join(clientRoot, 'package.json')).resolve('katex/dist/katex.min.css')
const outDir = join(here, '.render-out')

/* ---------------------------- 1. 编译 ---------------------------- */

const hostFormatter = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => clientRoot,
  getNewLine: () => '\n',
}

function compile() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const options = {
    outDir,
    rootDir: join(clientRoot, 'src', 'components'),
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2023,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    // 需要真正产出 JS，所以必须关掉它（源码的 .ts 后缀由 renderHooks 改写）
    allowImportingTsExtensions: false,
    skipLibCheck: true,
    noEmitOnError: false,
    declaration: false,
    sourceMap: false,
  }
  const program = ts.createProgram([join(clientRoot, 'src', 'components', 'Markdown.tsx')], options)
  const { emitSkipped, diagnostics } = program.emit()
  if (emitSkipped) throw new Error(`tsc 未产出文件: ${ts.formatDiagnostics(diagnostics, hostFormatter)}`)
}

compile()
register('./renderHooks.mjs', import.meta.url)

const load = (name) => import(pathToFileURL(join(outDir, name)).href)
const { default: Markdown } = await load('Markdown.js')
const { repairStreamingMarkdown } = await load('markdownStream.js')
const { preprocessMath } = await load('markdownMath.js')
const { auditMathRender } = await load('markdownDiag.js')
const { MARK_OPEN, MARK_CLOSE } = await load('markdownMark.js')

/* ---------------------------- 断言工具 ---------------------------- */

/**
 * 取「用户能看到的文本」：去掉全部标签，并**先剔除 KaTeX 的 `<annotation>`**
 * （那里回显着 TeX 源码，不清掉会把"源码残留"判断变成恒真）。
 */
function visibleText(html) {
  return html
    .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

const render = (text, streaming) =>
  renderToStaticMarkup(React.createElement(Markdown, streaming === undefined ? { text } : { text, streaming }))

/** 开启段内换行（AI 生成内容的默认形态）后渲染 */
const renderBreaks = (text) => renderToStaticMarkup(React.createElement(Markdown, { text, breaks: true }))

/** 数表头：`<th[ >]` —— 用 `<th[^>]*>` 会把 `<thead>` 也算进去 */
const tableHeaderCount = (html) => (html.match(/<th[ >]/g) ?? []).length

/**
 * 取管线输出里的 `$$…$$` 区：**未配对的 `$$` 之后的内容整体算一段**，
 * 用来暴露"半截公式把后面的正文吞进公式区"。
 */
function mathRegions(processed) {
  const regions = []
  let i = 0
  for (;;) {
    const at = processed.indexOf('$$', i)
    if (at === -1) break
    const close = processed.indexOf('$$', at + 2)
    regions.push({ body: close === -1 ? processed.slice(at + 2) : processed.slice(at + 2, close), closed: close !== -1 })
    i = close === -1 ? processed.length : close + 2
  }
  return regions
}

/** 渲染时的 KaTeX strict 警告（"Unicode text character 由 used in math mode" 这类） */
function collectWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = original
  }
}

let failures = 0
let checks = 0

function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`  ✔ ${name}`)
  } catch (e) {
    failures += 1
    console.log(`  ✖ ${name}\n      ${e.message}`)
  }
}

/* ---------------------------- [1] 流式补全 ---------------------------- */

console.log('\n[1] 流式补全：修复前 vs 修复后（同一段半成品文本）')

/**
 * 每条用例都先证明「修复前确实是坏的」，再证明「修复后是好的」。
 * before 证据二选一：
 *   · literals:   可见文本里残留的字面定界符
 *   · openRegion: 管线输出里 `$$` 不配对（公式区认不出来 / 吞掉正文）
 */
const STREAM_CASES = [
  {
    name: '加粗定界符写了一半',
    raw: '结论：**按位贪心可以证明',
    before: { literals: ['**'] },
    after: { literals: ['**'], html: ['<strong>'] },
  },
  {
    name: '斜体定界符写了一半',
    raw: '注意 *这里的边界',
    before: { literals: ['*'] },
    after: { literals: ['*'], html: ['<em>'] },
  },
  {
    name: '删除线写了一半',
    raw: '旧结论 ~~已经被推翻',
    before: { literals: ['~~'] },
    after: { literals: ['~~'], html: ['<del>'] },
  },
  {
    name: '行内代码里的 LaTeX 还没补反引号',
    raw: '递推式 `dp_{i-1}',
    before: { literals: ['`'] },
    after: { literals: ['`'], katex: 'inline' },
  },
  {
    name: '块级公式只写了一半（公式体里有 & 时后果可见）',
    raw: '推导：\n$$\nx_1 & x_2 + x_3',
    before: { openRegion: true, katexError: true },
    // `&` 在修复后会渲染成转义后的 & 号，所以这里只断言 `$$` 不再出现在可见文本里
    after: { literals: ['$$'], katex: 'display', html: ['katex-display'] },
  },
  {
    name: '引用块里的块级公式只写了一半（收尾要带 > 前缀）',
    raw: '> 推导：\n> $$\n> dp_i = dp_{i-1} + 1',
    before: { openRegion: true },
    after: { literals: ['$$'], katex: 'display', html: ['<blockquote>'] },
  },
  {
    name: '未闭合的 \\[ … \\] 换算（修复前会把正文吞进公式）',
    raw: '由定义 \\[f_i = f_{i-1} + a_i',
    before: { openRegion: true, swallowed: '由定义' },
    after: { literals: ['\\[', '\\]'], katex: 'display' },
  },
  {
    name: '未闭合的行内 $ 公式',
    raw: '转移为 $f_i = f_{i-1} + a_i',
    before: { literals: ['$'] },
    after: { literals: ['$'], katex: 'inline' },
  },
]

for (const c of STREAM_CASES) {
  // 修复前的渲染会触发 KaTeX 的 strict 警告（正文被吞进公式区时会报"中文出现在数学模式"），
  // 这里收集起来而不是让它打到 stderr：它本身就是"修复前确实坏"的旁证。
  const { result: beforeHtml, warnings: beforeWarnings } = collectWarnings(() => render(c.raw, false))
  const beforeText = visibleText(beforeHtml)
  const beforeProcessed = preprocessMath(c.raw)

  check(`${c.name} —— 修复前确实坏`, () => {
    for (const lit of c.before.literals ?? []) {
      assert.ok(beforeText.includes(lit), `修复前可见文本里没有 ${JSON.stringify(lit)}（用例前提不成立）: ${beforeText}`)
    }
    if (c.before.openRegion) {
      const regions = mathRegions(beforeProcessed)
      assert.ok(
        regions.some((r) => !r.closed),
        `修复前管线输出里的 $$ 竟然是配对的: ${JSON.stringify(beforeProcessed)}`,
      )
    }
    if (c.before.swallowed) {
      const regions = mathRegions(beforeProcessed)
      const swallowedIntoMath = regions.some((r) => !r.closed && r.body.includes(c.before.swallowed))
      const warned = beforeWarnings.some((w) => w.includes('unicodeTextInMathMode') || w.includes('math mode'))
      assert.ok(swallowedIntoMath || warned, `修复前正文没有被吞进公式区: ${JSON.stringify(beforeProcessed)}`)
    }
    if (c.before.katexError) {
      assert.ok(beforeHtml.includes('katex-error'), `修复前没有出现 katex-error（用例前提不成立）: ${beforeHtml.slice(0, 200)}`)
    }
  })

  const html = render(c.raw, true)
  const text = visibleText(html)
  const processed = preprocessMath(repairStreamingMarkdown(c.raw))

  check(`${c.name} —— 修复后可见文本干净`, () => {
    for (const lit of c.after.literals ?? []) {
      assert.ok(!text.includes(lit), `可见文本里仍残留 ${JSON.stringify(lit)}: ${text}`)
    }
    assert.ok(!html.includes('katex-error'), `仍出现 katex-error（源码被当文本显示）: ${html.slice(0, 200)}`)
  })
  check(`${c.name} —— 公式区配对且能被 KaTeX 严格解析`, () => {
    assert.ok(
      mathRegions(processed).every((r) => r.closed),
      `管线输出里仍有不配对的 $$: ${JSON.stringify(processed)}`,
    )
    const issues = auditMathRender(processed)
    assert.equal(issues.length, 0, `KaTeX 解析失败: ${JSON.stringify(issues)}`)
    if (c.after.katex === 'display') {
      assert.ok(html.includes('katex-display'), `没有渲染成块级公式: ${html.slice(0, 200)}`)
    } else if (c.after.katex === 'inline') {
      assert.ok(html.includes('class="katex"'), `没有渲染成行内公式: ${html.slice(0, 200)}`)
      assert.ok(!html.includes('katex-display'), '被误升级为块级公式')
    }
  })
  check(`${c.name} —— 附加结构断言`, () => {
    for (const frag of c.after.html ?? []) {
      assert.ok(html.includes(frag), `缺少结构 ${frag}: ${html.slice(0, 200)}`)
    }
  })
}

/* ---------------------------- [2] 不许越过红线 ---------------------------- */

console.log('\n[2] 流式补全不得越过这些红线（正文正常写法不能被"补"坏）')

const NO_TOUCH = [
  { name: '乘法算式 2 * 3 = 6', raw: '结果是 2 * 3 = 6', want: ['2 * 3 = 6'], noEmphasis: true },
  { name: '金额 $5', raw: '一共花了 $5', want: ['$5'] },
  { name: '无序列表标记 * item', raw: '* 第一项\n* 第二项', want: ['<ul>', '<li>第一项</li>'] },
  { name: 'snake_case 标识符 push_back', raw: '用 push_back 插入', want: ['push_back'], noKatax: true },
  // 说明：`dp[i]` 这类**单个下标记号**本轮已按数学渲染（用户截图反馈），
  // 所以它不在"原样保留"清单里，改在 [4] 里断言数学渲染；代码语句仍在这里。
  { name: '代码语句 dp[i] = dp[i-1] + 1;', raw: '转移就是 dp[i] = dp[i-1] + 1;', want: ['<code>dp[i] = dp[i-1] + 1</code>'] },
]

for (const c of NO_TOUCH) {
  check(`${c.name} —— 流式渲染后仍是普通文本`, () => {
    const html = render(c.raw, true)
    const text = visibleText(html)
    if (c.noEmphasis !== false) assert.ok(!html.includes('<em>') && !html.includes('<strong>'), `被当成强调: ${html.slice(0, 200)}`)
    assert.ok(!html.includes('class="katex"'), `被当成公式渲染: ${html.slice(0, 200)}`)
    for (const frag of c.want) {
      assert.ok(html.includes(frag), `缺少 ${frag}（记号被改写或吞掉）: ${html.slice(0, 200)} / 可见文本: ${text}`)
    }
  })
}

check('词内波浪号 20~25 被转义而不是变成删除线区间', () => {
  const html = render('区间 20~25 之间', true)
  assert.ok(!html.includes('<del>'), `被当成删除线: ${html.slice(0, 200)}`)
  assert.ok(visibleText(html).includes('20~25'), visibleText(html))
})

check('表格：公式（含未闭合写法）不会把表格拆散', () => {
  const html = render('| 状态 | 转移 |\n| --- | --- |\n| dp_i | $f_i = f_{i-1} + 1$ |', false)
  assert.ok(html.includes('<table>'), html.slice(0, 200))
  assert.equal(tableHeaderCount(html), 2, '表头数不对')
  assert.ok(!html.includes('katex-display'), '单元格里出现块级公式会拆散表格行')
})

/* ---------------------------- [3] 代码区不变量 ---------------------------- */

console.log('\n[3] 代码区不变量（分层渲染的地基）')

const CODE_CASES = [
  {
    name: '正文里的 g[prev].push_back(cur) 保持代码形态',
    raw: '调用 g[prev].push_back(cur) 追加边',
    want: ['<code>'],
    reject: ['$g[prev]', 'class="katex"'],
  },
  {
    name: 'ios::sync_with_stdio 不被包进公式',
    raw: '加 ios::sync_with_stdio(false) 加速',
    want: ['<code>'],
    reject: ['class="katex"'],
  },
  {
    name: '围栏代码块走代码卡，内容原样',
    raw: '```cpp\nint main() {\n  for (int i = 0; i < n; i++) dp[i] = i;\n  return 0;\n}\n```',
    want: ['md-code-card', 'md-code-lang', 'language-cpp', 'dp[i] = i;'],
    reject: ['class="katex"'],
  },
  {
    name: '正文里的 C++ 声明行（带数字下标）不被包进公式',
    raw: '开一个 int dp[100005]; 数组，转移写成 dp[i] = dp[i-1] + 1; 即可',
    // 声明里的数组名与代码语句都渲染成行内代码（修复前是 `int $dp[100005]$;` 斜体公式）
    want: ['<code>dp[100005]</code>', '<code>dp[i] = dp[i-1] + 1</code>'],
    reject: ['class="katex"'],
  },
  {
    name: '外链带 target=_blank rel=noreferrer',
    raw: '参考 [题解](https://example.com/a)',
    want: ['target="_blank"', 'rel="noreferrer noopener"'],
  },
]

for (const c of CODE_CASES) {
  check(`${c.name}`, () => {
    const html = render(c.raw, false)
    const processed = preprocessMath(c.raw)
    for (const frag of c.want) assert.ok(html.includes(frag), `缺少 ${frag}: ${html.slice(0, 300)}`)
    for (const frag of c.reject ?? []) {
      assert.ok(!html.includes(frag) && !processed.includes(frag), `出现不该有的 ${frag}`)
    }
  })
}

/* ---------------------------- [4] 说明正文里的数学（用户截图） ---------------------------- */

console.log('\n[4] 说明正文里的数学不再渲染成代码（用户截图场景）')

/** 用户截图里的那条消息（按截图重建） */
const EXPLANATION = [
  '### 1.1 位置与"偏移"的关系',
  '',
  '记行号为 `r`，列号为 `c`。',
  '格子里的数等价于',
  '',
  '```',
  'b[r][c] = a[(r - c) mod n]      // 这里的 mod 取非负余数',
  '```',
  '',
  '把 `offset = (r - c) mod n` 称为**偏移**，则格子的权值正是 `a[offset]`。',
  '',
  '- **向右**：`c←c+1`，`r` 不变 → `offset` 变为 `offset-1 (mod n)`',
  '- **向下**：`r←r+1`，`c` 不变 → `offset` 变为 `offset+1 (mod n)`',
  '',
  '所以路径在偏移环上进行一次步长为 `±1` 的随机游走，起点 `offset = 0`，终点也必须是 `0`。',
].join('\n')

check('公式行不再是代码卡，说明里的数学记号不再是行内代码', () => {
  const html = render(EXPLANATION, false)
  const text = visibleText(html)
  assert.ok(!html.includes('md-code-card'), `公式行仍被渲染成代码卡: ${html.slice(0, 300)}`)
  assert.ok(!html.includes('<code'), `说明正文里仍有行内代码 span: ${html.slice(0, 400)}`)
  assert.ok(html.includes('katex-display'), '公式行没有渲染成块级公式')
  // 说明里的数学都进了 KaTeX
  assert.ok(!text.includes('`') && !text.includes('$'), `可见文本里残留定界符: ${text}`)
  assert.ok(html.includes('katex'), '说明里的数学没有渲染成公式')
})

check('公式行的内容与说明都还在（不能静默丢内容）', () => {
  const html = render(EXPLANATION, false)
  // KaTeX 会重排空白并使用 Unicode 减号，所以按关键片段断言而不是整串比对
  const text = visibleText(html).replace(/\s+/g, ' ')
  assert.ok(text.includes('b[r][c]'), `公式左边丢了: ${text}`)
  assert.ok(text.includes('mod n]'), `公式右边丢了: ${text}`)
  assert.ok(text.includes('这里的 mod 取非负余数'), `行尾说明被丢掉: ${text}`)
  assert.ok(text.includes('记行号为') && text.includes('随机游走'), '正文被破坏')
})

check('每个公式都能被 KaTeX 严格解析（含 ±、\\bmod、\\text{中文}）', () => {
  const processed = preprocessMath(EXPLANATION)
  const issues = auditMathRender(processed)
  assert.equal(issues.length, 0, `KaTeX 解析失败: ${JSON.stringify(issues)}`)
  assert.ok(!render(EXPLANATION, false).includes('katex-error'), '出现 katex-error（源码被当文本显示）')
})

check('真代码红线：反引号里的代码标识符仍是代码', () => {
  const html = render('用 `push_back` 插入，比较 `a[x] + a[x+1]`，还需要 `sort(a, a + n)`。', false)
  for (const frag of ['<code>push_back</code>', '<code>a[x] + a[x+1]</code>', '<code>sort(a, a + n)</code>']) {
    assert.ok(html.includes(frag), `缺少 ${frag}: ${html.slice(0, 300)}`)
  }
})

check('复杂度记号按公式渲染（本轮按用户反馈翻面：不再是代码）', () => {
  const html = render('复杂度为 O((n+#events)logn+q⋅n) 左右。', false)
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
  assert.ok(html.includes('class="katex"'), `复杂度没有渲染成公式: ${html.slice(0, 400)}`)
  // `\log` 是 \mathop，KaTeX 会排成函数名 + 应用间距（MathML 里紧跟着 <mo>⁡</mo>）
  assert.ok(html.includes('<mi>log</mi>') || html.includes('mop'), `log 没有升为 LaTeX 函数名: ${html.slice(0, 500)}`)
  // `#` 必须转义，否则会被 KaTeX 当宏参数报错
  const text = visibleText(html)
  assert.ok(text.includes('#events'), `集合/计数记号 # 丢了: ${text.slice(0, 200)}`)
  assert.equal(auditMathRender(preprocessMath('复杂度为 O((n+#events)logn+q⋅n) 左右。')).length, 0, '公式无法被 KaTeX 解析')
})

check('多行伪代码围栏保持代码卡，换行与缩进不丢（用户截图：代码粘连）', () => {
  // 回归：块里只要有一行含 `…`（强数学记号），整块伪代码曾被判成公式，
  // 换行被压成一行、缩进消失，KaTeX 还会吞掉词间空格（for i → fori）
  const raw = [
    '等价的写法是：',
    '',
    '```',
    'need = 0',
    'for i = 0…n :',
    '    if cnt[i] > 0 :',
    '        cnt[i]--, need++',
    'answer = i',
    '```',
    '',
    '### 1.4 大 k 的特例',
    '',
    '如果 k > 2·max(a_i) 则答案为普通 mex。',
  ].join('\n')
  const html = render(raw, false)
  assert.ok(html.includes('md-code-card'), `伪代码没有走代码卡: ${html.slice(0, 300)}`)
  // 只看代码卡内部：整条消息里的正文公式（`2·max(a_i)`）本来就该用 KaTeX
  const cardStart = html.indexOf('md-code-card')
  const card = html.slice(cardStart, html.indexOf('</pre>', cardStart) + 6)
  assert.ok(card.length > 20, `代码卡没抓到: ${html.slice(0, 200)}`)
  assert.ok(!card.includes('katex'), `代码卡里的伪代码被当成公式: ${card.slice(0, 300)}`)
  assert.ok(card.includes('need = 0\nfor i = 0…n :'), '代码卡里丢了换行')
  // 缩进按行首空格断言（`>` 在 HTML 里会转义成 &gt;，不比对整行）
  assert.ok(card.includes('\n    if cnt[i]'), '代码卡里丢了 4 空格缩进')
  assert.ok(card.includes('\n        cnt[i]--'), '代码卡里丢了 8 空格缩进')
  assert.ok(html.includes('<h3>1.4 大 k 的特例</h3>'), '章节标题没有渲染成标题')
  // 正文里的数学仍是公式
  assert.ok(html.includes('katex'), '正文里的 · max(a_i) 没有渲染成公式')
})

check('反引号里的中文术语与 Unicode 减号下标不再是代码', () => {
  const html = render('使它的 `价值` 为 0，或是 `k−a_i` 本身。', false)
  assert.ok(!html.includes('<code'), `仍有行内代码 span: ${html.slice(0, 300)}`)
  assert.ok(visibleText(html).includes('价值'), visibleText(html))
  assert.ok(html.includes('class="katex"'), 'k−a_i 没有渲染成公式')
})

check('折行的公式转成块级公式，同一段里的伪代码仍留在代码卡（用户截图 3）', () => {
  const raw = [
    '在一次查询中，针对当前的 k，对每个 i 我们可以使用的资源数为',
    '',
    '```',
    'avail(i) = cnt[i]                  // 直接保留 i',
    '         + (i != k-i ? cnt[k-i] : 0) // 变换得到 i（若 i 与 k-i 不同）',
    '```',
    '',
    '因为每件资源只能被使用一次，遍历 i 时把已经使用的资源从 cnt 中减掉即可。',
    '',
    '```',
    'need = 0            // 已经成功构造了 0..need-1',
    'for i = 0 … n:',
    '    if cnt[i] > 0:          cnt[i]--, need++',
    '    else break              // i 不能得到，mex = i',
    'answer = i',
    '```',
  ].join('\n')
  const html = render(raw, false)
  const text = visibleText(html).replace(/\s+/g, ' ')
  // KaTeX 会重排公式里的空白，所以去掉所有空白后再比对关键片段
  const flat = text.replace(/\s+/g, '')
  // 折行公式 → 块级公式（不是代码卡）
  assert.ok(html.includes('katex-display'), `折行公式没有渲染成块级公式: ${html.slice(0, 300)}`)
  assert.ok(flat.includes('avail(i)=cnt[i]'), `公式内容丢了: ${text.slice(0, 200)}`)
  assert.ok(flat.includes('i≠k−i') || flat.includes('i≠k-i'), `编程关系符没有转成数学不等号: ${flat.slice(0, 200)}`)
  assert.ok(text.includes('直接保留 i') && text.includes('变换得到 i'), `行尾说明被丢掉: ${text.slice(0, 200)}`)
  // 伪代码卡 → 仍是代码卡，换行与缩进都在；整条消息里只应剩这一张代码卡
  assert.equal((html.match(/class="md-code-card/g) ?? []).length, 1, '代码卡数量不对（应当只剩伪代码那一张）')
  assert.ok(html.includes('need = 0') && html.includes('\nfor i = 0 … n:'), '伪代码卡里丢了换行')
  assert.ok(html.includes('\n    if cnt[i]'), '伪代码卡里丢了缩进')
  assert.ok(html.includes('\nanswer = i'), '伪代码卡里丢了最后一行')
  // 全篇没有 KaTeX 解析失败
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
  assert.equal(auditMathRender(preprocessMath(raw)).length, 0, '有公式无法被 KaTeX 解析')
})

check('带函数调用写法的公式不再进代码卡（用户截图 4：集合基数 / 续写式子）', () => {
  const raw = [
    '把 a 预先排序，所有统计都可以用二分得到：',
    '',
    '- badR = #{ a_i > t and a_i ≤ k−m }',
    '      = max(0, upper_bound(a, k-m) - lower_bound(a, t+1))',
    '',
    '所以我们只需要快速求出',
    '',
    '```',
    'cnt(m) = #{ i | b_i(k) < m }',
    '```',
    '',
    '遍历 c ：',
    '',
    '```',
    'if c_j ≥ cur :    // 还能给出 cur',
    '    cur++',
    '```',
  ].join('\n')
  const html = render(raw, false)
  const text = visibleText(html).replace(/\s+/g, ' ')
  // 数学模式下 `lower_bound` 会渲染成 lower 带下标 bound（下划线本身不可见），
  // 所以比对时去掉空白、只认标识符主体
  const flat = text.replace(/\s+/g, '')
  // 两张"公式卡"都变成数学；只有伪代码那张仍是代码卡
  assert.equal((html.match(/class="md-code-card/g) ?? []).length, 1, `代码卡数量不对: ${html.slice(0, 400)}`)
  assert.ok(html.includes('katex-display'), `集合基数定义没有渲染成块级公式: ${html.slice(0, 300)}`)
  assert.ok(text.includes('cnt(m)'), `公式内容丢了: ${text.slice(0, 200)}`)
  assert.ok(text.includes('badR'), `列表项里的式子丢了: ${text.slice(0, 200)}`)
  assert.ok(flat.includes('upperbound(a,k−m)') || flat.includes('upperbound(a,k-m)'), `upper_bound 丢了: ${text.slice(0, 200)}`)
  assert.ok(flat.includes('lowerbound(a,t+1)'), `lower_bound 丢了: ${text.slice(0, 200)}`)
  // 集合括号必须可见（裸花括号在 KaTeX 里是分组、不显示）
  assert.ok(text.includes('{') && text.includes('}'), `集合括号不可见: ${text.slice(0, 200)}`)
  // 伪代码仍是代码卡，注释与缩进都在
  assert.ok(html.includes('if c_j ≥ cur :') && html.includes('// 还能给出 cur'), '伪代码内容丢了')
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
  assert.equal(auditMathRender(preprocessMath(raw)).length, 0, '有公式无法被 KaTeX 解析')
})

check('列表项不会被块级公式吞掉（`- badR = …` 的列表标记还在）', () => {
  const html = render('- badR = #{ a_i > t and a_i ≤ k−m }\n      = max(0, upper_bound(a, k-m) - lower_bound(a, t+1))', false)
  assert.ok(html.includes('<ul>') && html.includes('<li>'), `列表结构丢了: ${html.slice(0, 300)}`)
  assert.ok(!html.includes('katex-display'), '列表项被升级成块级公式（会把标记吞进公式）')
  assert.ok(html.includes('class="katex"'), '列表项里的式子没有渲染成行内公式')
})

check('裸写的单个下标记号按数学渲染（dp[i] / a[offset]）', () => {
  for (const raw of ['状态 dp[i] 表示前 i 个', '权值正是 a[offset]']) {
    const html = render(raw, false)
    assert.ok(html.includes('class="katex"'), `${raw} 没有渲染成公式: ${html.slice(0, 200)}`)
    assert.ok(!html.includes('<code'), `${raw} 被渲染成代码: ${html.slice(0, 200)}`)
  }
})

/**
 * 用户粘贴的 mex 讲解（反馈原文：「中间有的数学公式被当成代码块了」）。
 *
 * 这两行没有 LaTeX 命令、没有 Unicode 数学符号，只有普通的 ASCII `=`，
 * 于是落在 `shouldConvertFenceToMath` 多行分支的「至少一行含强数学记号」之外、
 * 整块退回代码卡 —— 而**同样内容只剩一行**时是能正常渲染成公式的。
 */
const MEX_REPLY = [
  '把每个下标 `i` 看成一件「资源」，它可以提供两种"价值"：',
  '',
  '```',
  'value = a_i          (不变)',
  'value = k - a_i      (变换)',
  '```',
  '',
  '在构造 `mex` 时，若我们想让 `0` 出现在 a\' 中，就必须挑选一件资源，使它的 `价值` 为 `0`。',
].join('\n')

check('分段定义（同一量的几种取值）不再被塞进代码卡', () => {
  const html = render(MEX_REPLY, false)
  assert.equal(
    (html.match(/class="md-code-card/g) ?? []).length,
    0,
    `分段定义被渲染成代码卡了: ${html.slice(0, 500)}`,
  )
  // 每条取值各自排成一条居中公式（而不是合并成一行）
  assert.equal((html.match(/katex-display/g) ?? []).length, 2, `块级公式数不对: ${html.slice(0, 500)}`)
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
  assert.equal(auditMathRender(preprocessMath(MEX_REPLY)).length, 0, '有公式无法被 KaTeX 解析')
  // 行尾中文小注不丢
  const text = visibleText(html).replace(/\s+/g, '')
  assert.ok(text.includes('(不变)') && text.includes('(变换)'), `中文小注丢了: ${text.slice(0, 300)}`)
})

check('整段只有一个围栏时，分段定义同样按公式渲染', () => {
  const html = render('```\nvalue = a_i          (不变)\nvalue = k - a_i      (变换)\n```', false)
  assert.equal((html.match(/class="md-code-card/g) ?? []).length, 0, `整段围栏被渲染成代码卡: ${html.slice(0, 400)}`)
  assert.equal((html.match(/katex-display/g) ?? []).length, 2, `块级公式数不对: ${html.slice(0, 400)}`)
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
})

check('红线：一组独立赋值语句仍留在代码卡里', () => {
  const html = render('转移：\n\n```\ndp[0] = 1\ndp[i] = dp[i-1] + dp[i-2]\n```', false)
  assert.equal(
    (html.match(/class="md-code-card/g) ?? []).length,
    1,
    `独立语句不该转公式（会压成一条首尾相接的式子）: ${html.slice(0, 400)}`,
  )
  assert.ok(!html.includes('class="katex"'), `独立语句不该渲染成公式: ${html.slice(0, 400)}`)
})

/**
 * 用户反馈：`res=ans(k1)xorans(k2)xor…xorans(kq)` 这句公式中间没有间隔，看不清。
 *
 * KaTeX 按 LaTeX 规则在数学模式里忽略空格，词运算符 `xor` 退化成一串挨个排的字母，
 * 与相邻标识符糊在一起。转成 `\operatorname` 后它是 \mathop，KaTeX 会在两侧排 TeX 的薄间距。
 */
check('词运算符排成算子，公式中间不再糊成一团', () => {
  const raw = '答案为 res = ans(k_1) xor ans(k_2) xor … xor ans(k_q)。'
  const html = render(raw, false)
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
  assert.equal(auditMathRender(preprocessMath(raw)).length, 0, '有公式无法被 KaTeX 解析')
  // \operatorname 在 KaTeX 里是 class="mop"，并在两侧插入 TeX 的薄间距（mspace）
  assert.equal((html.match(/class="mop"/g) ?? []).length, 3, `三个 xor 都应排成算子: ${html.slice(0, 600)}`)
  assert.ok((html.match(/mspace/g) ?? []).length >= 6, `算子两侧缺少 TeX 间距: ${html.slice(0, 600)}`)
  // 内容一个字都不能少
  const text = visibleText(html).replace(/\s+/g, '')
  assert.ok(text.includes('ans(k1)') && text.includes('ans(kq)'), `公式内容丢了: ${text.slice(0, 200)}`)
})

check('红线：词运算符不侵入标识符与 \\text{}', () => {
  // 完整边界覆盖在 markdownMath.test.ts；这里只兜渲染层不报错、不见 katex-error
  for (const raw of ['$dp_xor = 1$', '$txorid = 2$', 'x = \\text{a or b}']) {
    const html = render(raw, false)
    assert.ok(!html.includes('katex-error'), `${raw} 渲染失败`)
  }
})

/* ---------------------------- [5] 失败可观测性 ---------------------------- */

console.log('\n[5] KaTeX 失败的可观测性（失败必须能被发现，而不是静默显示源码）')

check('写坏的公式会被 KaTeX 拒绝，并且渲染成 katex-error（红色源码）', () => {
  const broken = '$$\n\\frac{1}\n$$'
  const processed = preprocessMath(broken)
  const issues = auditMathRender(processed)
  assert.equal(issues.length, 1, `诊断应报出 1 处失败，实际 ${issues.length}`)
  assert.match(issues[0].message, /ParseError|KaTeX/)
  const html = render(broken, false)
  assert.ok(html.includes('katex-error'), `未渲染成红色源码: ${html.slice(0, 300)}`)
  assert.ok(visibleText(html).includes('\\frac{1}'), '失败公式的源码应当可见（这正是要诊断的现象）')
})

check('正常公式不会被诊断误报', () => {
  const good = '设 $dp_i$ 为最优解：\n\n$$\ndp_i = \\max_{j < i}(dp_j + 1)\n$$'
  assert.equal(auditMathRender(preprocessMath(good)).length, 0)
  assert.ok(!render(good, false).includes('katex-error'))
})

/* ---------------------------- [5] 逐帧流式性质 ---------------------------- */

console.log('\n[6] 逐字流式：真实回复的每一帧都不比"不补"更差')

/**
 * 可见文本里残留的字面定界符数量 —— 用户实际看到的"闪烁"就是这个。
 * 刻意**不把 katex-error 计入**：公式本身只写了一半（如 `\\frac{1}{`）时，
 * 补全也变不出合法公式，那是 dev 诊断（[4]）负责暴露的对象，不是补全的失职。
 */
const DELIMS = ['**', '$$', '~~', '`']
function badness(html) {
  const text = visibleText(html)
  return DELIMS.reduce((n, d) => n + text.split(d).length - 1, 0)
}

const STREAM_ANSWER = [
  '## 思路',
  '',
  '设 $dp_i$ 表示前 $i$ 个位置的最优解，则转移为：',
  '',
  '$$',
  'dp_i = \\max_{j < i}(dp_j + 1)',
  '$$',
  '',
  '其中 $j$ 满足 $a_j \\le a_i$，**注意边界**：$dp_1 = 1$。',
  '',
  '用 `push_back` 维护候选集合，复杂度 $O(n \\log n)$。',
  '',
  '```cpp',
  'int main() {',
  '  for (int i = 0; i < n; i++) dp[i] = 1;',
  '  return 0;',
  '}',
  '```',
  '',
  '- 第一步：离散化',
  '- 第二步：树状数组',
].join('\n')

check('整段回复（补全后）渲染完全干净', () => {
  const html = render(STREAM_ANSWER, true)
  assert.equal(badness(html), 0, `仍有残留定界符: ${visibleText(html).slice(-80)}`)
  assert.ok(!html.includes('katex-error'), '完整回复不该出现 katex-error')
  assert.ok(
    mathRegions(preprocessMath(repairStreamingMarkdown(STREAM_ANSWER))).every((r) => r.closed),
    '完整回复里公式区不配对',
  )
})

check('逐字流式的每一帧：补全后不比不补更差（单调性），且公式区始终配对', () => {
  const violations = []
  let improved = 0
  let repaired = 0
  let frames = 0
  for (let n = 1; n <= STREAM_ANSWER.length; n++) {
    const frame = STREAM_ANSWER.slice(0, n)
    frames += 1
    if (repairStreamingMarkdown(frame) !== frame) repaired += 1
    const raw = badness(render(frame, false))
    const fixed = badness(render(frame, true))
    if (fixed > raw) violations.push({ n, raw, fixed, tail: frame.slice(-25) })
    if (fixed < raw) improved += 1
    const regions = mathRegions(preprocessMath(repairStreamingMarkdown(frame)))
    if (regions.some((r) => !r.closed)) violations.push({ n, raw, fixed, tail: `公式区未配对: ${frame.slice(-25)}` })
  }
  console.log(`      （共 ${frames} 帧：${repaired} 帧内容被补全，其中 ${improved} 帧的可见残留定界符被消除）`)
  assert.equal(violations.length, 0, `违反性质的帧: ${JSON.stringify(violations.slice(0, 3))}`)
  assert.ok(repaired >= 10, `补全几乎没有触发（只改了 ${repaired} 帧）—— 用例可能没覆盖到半成品状态`)
  assert.ok(improved >= 5, `补全没有产生可见改善（只改善了 ${improved} 帧）`)
})

/* ---------------------------- [7] 排版间距 ---------------------------- */

console.log('\n[7] 排版间距（CSS 结构检查）')

/**
 * CSS 不会进入静态渲染结果，headless 浏览器又被沙箱拦在进程级，
 * 所以这里只做**结构检查**：括号配平（防止手改样式表改坏整份 CSS）+ 关键间距声明存在。
 * 真实视觉效果需要用户刷新页面确认。
 */
check('index.css 括号配平，且章节/段落/代码卡间距已放宽', () => {
  const css = readFileSync(join(clientRoot, 'src', 'index.css'), 'utf8')
  const open = (css.match(/\{/g) ?? []).length
  const close = (css.match(/\}/g) ?? []).length
  assert.equal(open, close, `花括号不配平: { ${open} 个 / } ${close} 个`)
  for (const decl of [
    'margin: 20px 0 8px;', // 标题上间距
    'margin-top: 26px;', // h1/h2 更大一层
    'margin: 10px 0;', // 段落（本轮从 8px 放宽到 10px：治"挤成一坨"）
    'margin: 13px 0;', // 代码卡
    'margin: 15px 0;', // 块级公式
  ]) {
    assert.ok(css.includes(decl), `缺少间距声明: ${decl}`)
  }
})

/* ---------------------------- [8] KaTeX 类名/样式表同版本 ---------------------------- */

console.log('\n[8] KaTeX 渲染输出与自带样式表必须同版本（类名对得上）')

/**
 * 用户截图里"公式中间一条突兀竖线"就是这个不变量被打破的结果：
 * rehype-katex 用的是它自己依赖的 katex（0.16.x，输出 class="stretchy"），
 * 而组件里 `import 'katex/dist/katex.min.css'` 解析到顶层 katex（0.18.x，
 * 样式表里只认 .katex-stretchy）。类名对不上 → \boxed 的盒子丢掉
 * `.katex .stretchy { width: 100%; display: block }` 这条布局规则，
 * 只剩 0.04em 的左右边框重合，塌成 2px 宽的一条竖线。
 *
 * 这里拿**渲染输出里的 class** 去**实际会被 import 的那份 CSS** 里找规则：
 * 两个版本一旦漂移（升 katex 但不升 rehype-katex，或反过来）就会红。
 */
check('\\boxed 的容器 class 在自带样式表里有布局规则（不会塌成一条竖线）', () => {
  const html = render('$\\boxed{+a_0}$', false)
  const found = /<span class="([^"]*\b(?:stretchy|katex-stretchy)\b[^"]*)"/.exec(html)
  assert.ok(found, `\\boxed 没有产出 stretchy 容器：${html.slice(0, 300)}`)
  const classNames = found[1].split(/\s+/).filter(Boolean)
  // 压缩空白后 katex.min.css 里是 `.katex .stretchy{width:100%;…}`，
  // 断言要同时容忍压缩版（无空格）与源码版（有空格）
  const css = readFileSync(katexCssPath, 'utf8')
  const styled = classNames.filter((c) =>
    new RegExp(`\\.katex\\s+\\.${c}\\s*\\{[^}]*width\\s*:\\s*100%`).test(css),
  )
  assert.ok(
    styled.length > 0,
    `渲染输出的 class「${found[1]}」在 ${katexCssPath} 里没有 width:100% 规则 —— ` +
      'rehype-katex 用的 katex 与 import 的样式表版本漂了，\\boxed 会塌成一条竖线',
  )
})

/* ---------------------------- [9] 表格/段落里的 <br>（用户反馈） ---------------------------- */

console.log('\n[9] AI 输出里的 <br>：放行这一个标签，其余 HTML 仍转义')

/**
 * GFM 表格单元格内换行只有 `<br>` 一种惯用写法（真实换行符会截断表格行），
 * 而 react-markdown 默认把原始 HTML 转义成字面文本 —— AI 一在单元格里换行，
 * 用户就看见一串 `<br>`。修复后：raw 阶段白名单放行无属性无内容的 `<br>`。
 */

/** 用户反馈的原型场景：单元格里「公式 + <br> + 公式 + <br> + 说明」 */
const BR_TABLE = [
  '| 问题 | 修正 |',
  '| --- | --- |',
  '| 使用公式：<br>$z = x + y$<br>若 $z = 0$ 则计数++ | 改为 long long |',
].join('\n')

const brElementCount = (html) => (html.match(/<br\s*\/?>/g) ?? []).length

check('表格单元格里的 <br> 渲染成真正的换行，表格结构不破坏', () => {
  const html = render(BR_TABLE, false)
  const text = visibleText(html)
  assert.ok(brElementCount(html) >= 2, `单元格内没有 br 元素: ${html.slice(0, 300)}`)
  assert.ok(!text.includes('<br'), `<br> 仍是字面文本: ${text}`)
  assert.ok(html.includes('<table>'), '表格结构被破坏')
  assert.equal(tableHeaderCount(html), 2, '表头数不对')
  assert.ok(html.includes('class="katex"'), '单元格里的公式没有渲染成 KaTeX')
})

check('流式路径同样放行 <br>', () => {
  const html = render(BR_TABLE, true)
  assert.ok(brElementCount(html) >= 2, `流式渲染没有 br 元素: ${html.slice(0, 300)}`)
  assert.ok(!visibleText(html).includes('<br'), visibleText(html))
  assert.ok(html.includes('<table>'), '流式下表格结构被破坏')
})

check('段落里的 <br> 也换行（含连续两个）', () => {
  const html = render('第一行<br>第二行<br><br>第四行', false)
  assert.ok(brElementCount(html) >= 3, `段落里没有 br 元素: ${html.slice(0, 300)}`)
  assert.ok(!visibleText(html).includes('<br'), visibleText(html))
})

check('红线：其余 HTML 仍按纯文本转义（安全姿态不变）', () => {
  const html = render('普通 <b>加粗</b>，以及 <img src=x onerror=alert(1)>，还有 <script>alert(1)</script>', false)
  assert.ok(html.includes('&lt;b&gt;'), `<b> 没有被转义: ${html.slice(0, 300)}`)
  assert.ok(!/<b[ >]/.test(html), '放行了 <b>')
  assert.ok(!html.includes('<img'), '放行了 <img>')
  assert.ok(!html.includes('<script'), '放行了 <script>')
  // 转义后的纯文本仍可见（内容不丢、只是惰性）
  assert.ok(visibleText(html).includes('onerror=alert(1)'), 'onerror 文本被丢掉')
})

check('代码里的 <br> 保持字面（那是代码内容，不是换行）', () => {
  const html = render('行内 `<br>`，以及：\n\n```html\n<div><br></div>\n```', false)
  assert.ok(html.includes('<code>&lt;br&gt;</code>'), `行内代码里的 <br> 没有保持字面: ${html.slice(0, 300)}`)
  const cardStart = html.indexOf('md-code-card')
  const card = html.slice(cardStart, html.indexOf('</pre>', cardStart) + 6)
  // 高亮会把代码切成 span，解码后比对内容：br 仍是字面字符，而不是元素
  assert.ok(!/<br\s*\/?>/.test(card), '代码块里出现了真 br 元素')
  assert.ok(visibleText(card).includes('<div><br></div>'), `代码块里的 <br> 没有保持字面: ${visibleText(card)}`)
})

/* ---------------------------- [10] ==高亮== 重点标记 ---------------------------- */

console.log('\n[10] `==…==` 重点标记：着色渲染，且绝不动相等比较')

/** 高亮标记的渲染结果：<mark class="md-mark">…</mark> */
const MARK_RE = /<mark class="md-mark">([\s\S]*?)<\/mark>/g
const markContents = (html) => [...html.matchAll(MARK_RE)].map((m) => m[1])

check('基本高亮渲染成 mark.md-mark，文字正确', () => {
  const html = render('结论是 ==关键点== 记住了。', false)
  const marks = markContents(html)
  assert.equal(marks.length, 1, `应渲染出 1 个高亮: ${html}`)
  assert.ok(marks[0].includes('关键点'), `高亮内容不对: ${marks[0]}`)
  // 定界符不能残留在可见文本里
  assert.ok(!visibleText(html).includes('=='), `可见文本残留定界符: ${visibleText(html)}`)
})

check('一行里多组高亮各自成 mark', () => {
  const html = render('==甲== 与 ==乙== 都要记。', false)
  const marks = markContents(html)
  assert.equal(marks.length, 2, `应有 2 个高亮: ${html}`)
  assert.ok(marks[0].includes('甲') && marks[1].includes('乙'), `高亮内容不对: ${JSON.stringify(marks)}`)
})

check('高亮里的公式仍渲染成 KaTeX，且被包进 mark（跨元素配对）', () => {
  const raw = '复杂度 ==$O(n\\log n)$== 可以接受。'
  const html = render(raw, false)
  const marks = markContents(html)
  assert.equal(marks.length, 1, `应有 1 个高亮: ${html}`)
  assert.ok(marks[0].includes('class="katex"'), `高亮里的公式没有渲染成 KaTeX: ${marks[0]}`)
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
  assert.equal(auditMathRender(preprocessMath(raw)).length, 0)
})

check('高亮里的裸数学照常渲染（哨兵不是数学字符，不干扰包裹）', () => {
  const raw = '转移是 ==dp_i = dp_{i-1} + 1== 的形式。'
  const html = render(raw, false)
  const marks = markContents(html)
  assert.equal(marks.length, 1, `应有 1 个高亮: ${html}`)
  assert.ok(marks[0].includes('class="katex"'), `高亮里的数学没有渲染成公式: ${marks[0]}`)
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
})

check('高亮与粗体嵌套：两个方向都不塌', () => {
  for (const raw of ['==**重点**==', '**==重点==**']) {
    const html = render(raw, false)
    assert.equal(markContents(html).length, 1, `${raw} 应产出 1 个高亮: ${html}`)
    assert.ok(html.includes('<strong>'), `${raw} 丢了粗体: ${html}`)
  }
})

check('红线：相等比较绝不被当成高亮', () => {
  for (const raw of ['a == b 是相等', 'if (a == b)', 'cnt == 0', 'x==y', 'dp[i]==dp[j]']) {
    const html = render(raw, false)
    assert.equal(markContents(html).length, 0, `${raw} 被误判成高亮: ${html}`)
    assert.ok(visibleText(html).includes('=='), `${raw} 的 == 被吃掉了: ${visibleText(html)}`)
  }
})

check('红线：代码区/公式区里的 == 不受高亮影响', () => {
  // 含代码语句特征的 span 保持代码外观，内容一个字符都不能被改写
  const code = render('写法是 `if (a == b) return 1;` 的记号', false)
  assert.equal(markContents(code).length, 0, `行内代码被误判成高亮: ${code}`)
  assert.ok(code.includes('<code>if (a == b) return 1;</code>'), `行内代码内容被改写: ${code}`)

  // 只有相等关系的短 span 会被**既有**管线升级为行内公式（`$a = b$`，与本轮改动无关）——
  // 关键是它绝不能变成高亮
  const short = render('写法是 `a == b` 的记号', false)
  assert.equal(markContents(short).length, 0, `短公式 span 被误判成高亮: ${short}`)

  const fence = render('```cpp\nif (a == b) return 1;\n```', false)
  assert.equal(markContents(fence).length, 0, `围栏代码被误判: ${fence}`)
  assert.ok(visibleText(fence).includes('if (a == b) return 1;'), `围栏内容被改写: ${visibleText(fence)}`)

  const math = render('公式 $a == b$ 里', false)
  assert.equal(markContents(math).length, 0, `公式区被误判: ${math}`)
})

check('未配对的高亮降级为字面 ==，绝不产出半截 mark', () => {
  for (const raw of ['未闭合 ==一半', '==x==y', '== 空格开头', '==重点 ==']) {
    const html = render(raw, false)
    assert.equal(markContents(html).length, 0, `${raw} 不应产出高亮: ${html}`)
  }
})

check('哨兵字符绝不泄漏到渲染结果（私有区字符会显示成方框）', () => {
  for (const raw of ['==重点==', '未闭合 ==一半', '==a== 和 ==b', '==**重点**==', '`==code==`']) {
    const html = render(raw, false)
    assert.ok(!html.includes(MARK_OPEN) && !html.includes(MARK_CLOSE), `${raw} 泄漏了哨兵: ${html}`)
    assert.ok(!html.includes('\uE000') && !html.includes('\uE001'), `${raw} 泄漏了私有区字符`)
  }
})

check('流式路径同样渲染高亮（含半成品补全）', () => {
  const html = render('结论是 ==关键', true)
  assert.equal(markContents(html).length, 1, `流式半成品没有补成高亮: ${html}`)
  assert.ok(!visibleText(html).includes('=='), `流式可见文本残留定界符: ${visibleText(html)}`)
})

check('逐字流式：高亮定界符不会在屏幕上闪出字面 ==', () => {
  const answer = '结论：==按位贪心可以证明==，注意 **边界**。'
  const violations = []
  const dirty = []
  for (let n = 1; n <= answer.length; n++) {
    const frame = answer.slice(0, n)
    const text = visibleText(render(frame, true))
    // 补全只能让可见残留变少、不能变多（与 [6] 的单调性同一口径）
    const raw = badness(render(frame, false))
    const fixed = badness(render(frame, true))
    if (fixed > raw) violations.push({ n, raw, fixed, tail: frame.slice(-12) })
    // 开定界符后面已经有内容时，收尾补全应已生效 → 不该再看到字面 ==。
    // （刚打出 `==` 而后面还什么都没有的那一两帧是歧义的：它也可能是相等运算符，
    //   与 `**` 的行为一致，此时不补、按字面显示，不算违规。）
    const afterOpen = /==\S/.test(frame)
    if (afterOpen && text.includes('==')) dirty.push({ n, tail: frame.slice(-12), text })
  }
  assert.equal(violations.length, 0, `补全让可见残留变多了: ${JSON.stringify(violations.slice(0, 3))}`)
  assert.equal(dirty.length, 0, `开定界符后已有内容却仍闪字面 ==: ${JSON.stringify(dirty.slice(0, 3))}`)
})

/* ---------------------------- [11] 段内换行（breaks） ---------------------------- */

console.log('\n[11] breaks：AI 生成内容的段内换行渲染成真换行')

check('开启 breaks 后，段内单个换行变成 <br>', () => {
  const html = renderBreaks('第一行\n第二行')
  assert.ok((html.match(/<br\s*\/?>/g) ?? []).length >= 1, `段内换行没有变成 br: ${html}`)
  assert.ok(visibleText(html).includes('第一行') && visibleText(html).includes('第二行'), visibleText(html))
})

check('默认（用户手写笔记）不开 breaks：段内换行仍是软换行', () => {
  const html = render('第一行\n第二行')
  assert.equal((html.match(/<br\s*\/?>/g) ?? []).length, 0, `默认不该产出 br: ${html}`)
})

check('breaks 不拆散块级公式（math 是叶子节点，breaks 拆不动它）', () => {
  const raw = '推导：\n\n$$\ndp_i = dp_{i-1} + 1\n$$\n\n完成。'
  const html = renderBreaks(raw)
  assert.ok(html.includes('katex-display'), `块级公式没有渲染出来: ${html.slice(0, 300)}`)
  assert.ok(!html.includes('katex-error'), '出现 katex-error（公式被 breaks 拆坏了）')
  assert.equal(auditMathRender(preprocessMath(raw)).length, 0)
})

check('breaks 不拆散代码块内容', () => {
  const raw = '代码如下：\n\n```cpp\nint main() {\n  return 0;\n}\n```'
  const html = renderBreaks(raw)
  const cardStart = html.indexOf('md-code-card')
  const card = html.slice(cardStart, html.indexOf('</pre>', cardStart) + 6)
  assert.ok(card.length > 20, `代码卡没抓到: ${html.slice(0, 200)}`)
  // 语法高亮把代码切成了 span，比对解码后的可见文本（`int main()` 被 hljs 拆成多个 span）
  const code = visibleText(card)
  assert.ok(code.includes('int main()'), `代码卡内容丢了: ${code}`)
  assert.ok(code.includes('return 0;'), `代码卡内容丢了: ${code}`)
  // 换行与缩进都还在（breaks 不能把代码内容改成 br）
  assert.ok(code.includes('\n  return 0;'), `代码卡里丢了换行或缩进: ${JSON.stringify(code)}`)
  assert.ok(!/<br\s*\/?>/.test(card), '代码卡里被插入了 br（代码内容被改写）')
})

check('breaks 不拆散表格行', () => {
  const raw = '| 解法 | 复杂度 |\n| --- | --- |\n| 暴力 | $O(n^2)$ |\n| 优化 | $O(n\\log n)$ |'
  const html = renderBreaks(raw)
  assert.ok(html.includes('<table>'), `表格结构被破坏: ${html.slice(0, 300)}`)
  assert.equal(tableHeaderCount(html), 2, '表头数不对')
})

/* ---------------------------- [12] 排版分层（分块与着色） ---------------------------- */

console.log('\n[12] 排版分层：标题色条 + 粗体着色 + 高亮着色')

check('CSS 定义了三层重点着色（高亮 / 粗体），且用 Token 不用字面量', () => {
  const css = readFileSync(join(clientRoot, 'src', 'index.css'), 'utf8')
  // 高亮：文字色 + 同色系淡底（--mark-text 是**正文专用**的深一档，不能直接用 --amber：
  // 亮色主题下 --amber 在淡琥珀底上只有 2.05:1，见 test/contrastCheck.mjs）
  assert.ok(
    /\.markdown-body mark[\s\S]{0,500}?background:\s*var\(--amber-soft\)/.test(css),
    '高亮缺少 --amber-soft 底色',
  )
  assert.ok(
    /\.markdown-body mark[\s\S]{0,500}?color:\s*var\(--mark-text\)/.test(css),
    '高亮缺少 --mark-text 文字色',
  )
  // 粗体：正文专用的 --strong-text
  assert.ok(
    /\.markdown-body strong\s*\{[^}]*color:\s*var\(--strong-text\)/.test(css),
    '粗体缺少 --strong-text 着色',
  )
  // 两套主题都要声明这两个 Token（否则亮色主题会 fallback 到暗色值）
  const rootAt = css.indexOf(':root')
  const root = css.slice(rootAt, css.indexOf('}', rootAt))
  const lightAt = css.indexOf("[data-theme='light']")
  const light = css.slice(lightAt, css.indexOf('}', lightAt))
  for (const token of ['--mark-text', '--strong-text']) {
    assert.ok(root.includes(`${token}:`), `:root（暗色）缺少 ${token}`)
    assert.ok(light.includes(`${token}:`), `亮色主题缺少 ${token}`)
  }
  // 高亮里的粗体/公式/代码跟随高亮色（避免一个标记里三种颜色）
  assert.ok(/\.md-mark strong[\s\S]{0,80}?color:\s*inherit/.test(css), '高亮里的粗体没有跟随高亮色')
  assert.ok(/\.md-mark code[\s\S]{0,120}?color:\s*inherit/.test(css), '高亮里的代码没有跟随高亮色')
})

check('标题层级带左侧色条（h1/h2 实色、h3 半透明）', () => {
  const css = readFileSync(join(clientRoot, 'src', 'index.css'), 'utf8')
  assert.ok(
    /\.markdown-body h1,\s*\.markdown-body h2,\s*\.markdown-body h3\s*\{[^}]*border-left:\s*3px solid var\(--brand\)/.test(css),
    '标题缺少左侧色条',
  )
  assert.ok(
    /\.markdown-body h3\s*\{[^}]*border-left-color:\s*var\(--brand-line\)/.test(css),
    'h3 色条没有用半透明的 --brand-line 做层级区分',
  )
})

check('渲染出的结构确实分层：标题 / 列表 / 高亮 / 粗体各就各位', () => {
  const raw = [
    '一句话结论：这题用 ==单调栈== 即可。',
    '',
    '### 1. 题意',
    '',
    '给定一个序列，求 **最大矩形面积**。',
    '',
    '- 要点一：**单调栈** 维护递增序列',
    '- 要点二：遇到更矮的柱子就弹栈',
  ].join('\n')
  const html = renderBreaks(raw)
  assert.ok(html.includes('<h3>1. 题意</h3>'), `小标题没有渲染成 h3: ${html.slice(0, 300)}`)
  assert.ok(html.includes('<ul>') && html.includes('<li>'), '列表结构丢了')
  assert.equal(markContents(html).length, 1, `高亮数量不对: ${html}`)
  assert.ok(html.includes('<strong>最大矩形面积</strong>'), '粗体没有渲染')
  assert.ok(!visibleText(html).includes('=='), `可见文本残留定界符: ${visibleText(html)}`)
  assert.ok(!html.includes('katex-error'), '出现 katex-error')
})

check('红线：强调语法没有被着色改动（斜体/删除线不受影响）', () => {
  const html = render('这是 *斜体* 与 ~~删除线~~ 的测试', false)
  assert.ok(html.includes('<em>斜体</em>'), `斜体坏了: ${html}`)
  assert.ok(html.includes('<del>删除线</del>'), `删除线坏了: ${html}`)
})

/* ---------------------------- 收尾 ---------------------------- */

console.log(`\n${failures === 0 ? '全部通过' : '存在失败'}：${checks - failures}/${checks} 项断言组通过\n`)
if (failures > 0) process.exitCode = 1

