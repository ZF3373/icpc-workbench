/**
 * 生成「AI 回复排版」预览页：用**真实的**渲染管线 + **真实的** index.css，
 * 产出一个自包含 HTML，供浏览器截图核对配色与分块效果。
 *
 * 为什么不用 dev server：本脚本只读源码、不依赖后端与网络，产出确定可复现；
 * 静态渲染走的就是 Markdown.tsx 本身（renderCheck.mjs 同一套编译方式）。
 *
 * 用法（在 client/ 下）：node test/markdownPreview.mjs [输出目录]
 */
import { createRequire, register } from 'node:module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolvePath(here, '..')
/** 独立的编译目录：renderCheck.mjs 也用 .render-out 并在启动时清空，两者并行会互相踩 */
const outDir = join(here, '.preview-out')
const target = process.argv[2] ? resolvePath(process.argv[2]) : join(here, '.preview')
const katexCssPath = createRequire(join(clientRoot, 'package.json')).resolve('katex/dist/katex.min.css')

/* ---------- 编译 Markdown.tsx（与 renderCheck.mjs 同一套设置） ---------- */
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const program = ts.createProgram([join(clientRoot, 'src', 'components', 'Markdown.tsx')], {
  outDir,
  rootDir: join(clientRoot, 'src', 'components'),
  jsx: ts.JsxEmit.ReactJSX,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2023,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: false,
  skipLibCheck: true,
  noEmitOnError: false,
  declaration: false,
  sourceMap: false,
})
program.emit()
register('./renderHooks.mjs', import.meta.url)
const { default: Markdown } = await import(pathToFileURL(join(outDir, 'Markdown.js')).href)

const render = (text) => renderToStaticMarkup(React.createElement(Markdown, { text, breaks: true }))

/* ---------- 一段"像真实 AI 回复"的样例：刻意覆盖本轮所有排版能力 ---------- */
const REPLY = `这题的核心是把「矩形面积」转成 ==每个柱子向两侧能扩展多远==，用单调栈一趟扫完即可。

### 1. 题意

给定 $n$ 个非负整数表示柱状图，求其中能勾勒出的 **最大矩形面积**。

数据范围 $n \\le 10^5$，所以 $O(n^2)$ 枚举左右边界会超时，需要 $O(n)$ 或 $O(n \\log n)$。

### 2. 从朴素出发

最直接的做法是枚举每一对左右边界，再取区间最小高度：

$$
\\text{area}(l, r) = (r - l + 1) \\times \\min_{l \\le i \\le r} h_i
$$

瓶颈在于「区间最小值」要反复求，于是想到：**能不能让每个柱子只被算一次？**

### 3. 解法思路

对每根柱子 $i$，只要求出它作为**最矮柱子**时能扩展的左右边界 $L_i$、$R_i$，答案就是：

$$
\\max_{1 \\le i \\le n} \\; h_i \\times (R_i - L_i - 1)
$$

用单调栈求 $L_i$ / $R_i$：栈里维护**高度递增**的下标序列。

- **求 $L_i$**：弹出所有高度 $\\ge h_i$ 的下标，弹完后栈顶就是左边第一个更矮的柱子
- **求 $R_i$**：从右往左扫一遍，做法完全对称
- 每根柱子最多进出栈各一次，所以总复杂度是 ==$O(n)$==

小例子：$h = [2, 1, 5, 6, 2, 3]$

| 柱子 $i$ | $h_i$ | $L_i$ | $R_i$ | 面积 |
| --- | --- | --- | --- | --- |
| 1 | 2 | 0 | 2 | 2 |
| 3 | 5 | 2 | 4 | 5 |
| 4 | 6 | 3 | 4 | 6 |
| 5 | 2 | 0 | 6 | 10 |

最大值 10 出现在 $i = 5$（高度 2 向两侧扩到整个宽度 5）。

### 4. 正确性证明

**引理**：设 $L_i$ 是 $i$ 左侧第一个满足 $h_j < h_i$ 的下标，则任何以 $i$ 为最矮柱子的矩形，其左边界不可能小于 $L_i + 1$。

*证明*：若左边界 $l \\le L_i$，则区间 $[l, R_i]$ 包含 $L_i$，而 $h_{L_i} < h_i$，与「$i$ 是最矮柱子」矛盾。$\\square$

由引理，以 $i$ 为最矮柱子的最大宽度恰为 $R_i - L_i - 1$，故枚举所有 $i$ 即覆盖全部候选矩形，==答案不会漏也不会多==。

### 5. 关键代码

\`\`\`cpp
vector<int> h(n + 2, 0);          // 两端补 0，省掉边界特判
vector<int> L(n + 2), R(n + 2);
stack<int> st;

for (int i = 1; i <= n + 1; i++) {
    while (!st.empty() && h[st.top()] >= h[i]) st.pop();
    L[i] = st.empty() ? 0 : st.top();
    st.push(i);
}
\`\`\`

**易错点**：循环上界要写 \`n + 1\`（哨兵），否则最后一根柱子的 $R_i$ 求不出来。`

/* ---------- 组装自包含 HTML：真实 index.css + KaTeX 样式 + 明暗两套 ---------- */
const appCss = readFileSync(join(clientRoot, 'src', 'index.css'), 'utf8')
const katexCss = readFileSync(katexCssPath, 'utf8')
const body = render(REPLY)

const page = (theme, label) => `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8">
<title>AI 回复排版预览 · ${label}</title>
<style>${katexCss}</style>
<style>${appCss}</style>
<style>
  html, body { margin: 0; background: var(--surface); }
  .stage { max-width: 860px; margin: 0 auto; padding: 28px 20px 60px; }
  .caption { margin: 0 0 14px; color: var(--text-3); font: 12px/1.6 system-ui, sans-serif; }
  /* 复刻助手消息气泡的真实外观（见 index.css 的 .plan-chat-msg-assistant） */
  .plan-chat-msg-assistant {
    background: var(--surface-2);
    border-radius: 10px 10px 10px 2px;
    padding: 12px 16px;
  }
</style>
</head>
<body>
  <div class="stage">
    <p class="caption">AI 助手回复 · ${label}主题 · 真实 index.css + Markdown 渲染管线</p>
    <div class="plan-chat-msg-assistant">
      <div class="markdown-body">${body}</div>
    </div>
  </div>
</body>
</html>`

mkdirSync(target, { recursive: true })
for (const [theme, label] of [['dark', '暗色'], ['light', '亮色']]) {
  const file = join(target, `ai-reply-${theme}.html`)
  writeFileSync(file, page(theme, label), 'utf8')
  console.log(`写入 ${file}`)
}
