# ICPC Workbench · Design Token 参考

> 配套 `docs/UI-Optimization-Plan.md` 第 6.1 节「Design Token 治理」。
> 唯一色值来源：`client/src/index.css` 的 `:root`（暗色）与 `[data-theme='light']`（亮色）。
> 页面/组件里**禁止**再出现 hex 或 rgba 字面量。

---

## 1. 怎么取色（按使用场景三选一）

| 场景 | 用什么 | 例子 |
|---|---|---|
| CSS 属性（`index.css`、`className`） | 直接 `var(--token)` | `color: var(--text-3);` |
| inline `style={{}}`（React 的 style 支持 `var()`） | `var(--token)` 或 `toneVar(tone)` | `style={{ color: 'var(--text-3)' }}` |
| 写进 **SVG 表现属性**（recharts 的 `fill`/`stroke`/`stopColor`） | `useTokenColors()` 取计算值 | `const t = useTokenColors(); <Bar fill={t.success} />` |

> 为什么图表不能直接用 `var()`：recharts 把颜色渲染成 SVG 表现属性（`<rect fill="...">`），
> 表现属性里的 `var()` 不保证被解析，取到空值就是「图表整片空白」。`useTokenColors()`
> 用 `getComputedStyle` 读 `documentElement` 上的实际值，并用 `MutationObserver` 监听
> `data-theme`，亮/暗切换后自动重取。

`client/src/ui.ts` 导出的入口：

- `toneVar(tone)` / `TONE_VAR` —— 语义色调 → `var(--*)` 表达式。
- `semanticColor` 语义：`success` `warning` `danger` `info` `neutral` `brand` `violet` `cyan`。
- `useTokenColors()` —— 当前主题的具体色值（含 `chartGrid` / `chartCursor`）。
- `getTokenColor('--green', fallback)` —— 单值读取。
- `difficultyColor(rating)`、`rateColor(rate)`、`gapColor(gap)` —— 域内语义色，已 Token 化。
- `difficultyTone()`、`rateTone()` —— 纯判断逻辑（与配色分离，便于单测覆盖边界）。

---

## 2. 替换对照表（旧硬编码 → Token）

文本层级：

| 旧值 | 语义 | Token |
|---|---|---|
| `#f5f7fb` | 主文本 | `--text` |
| `#c4cad4`、`#c9d4e0`、`#c9d3e0`、`#5b6573` | 次要文本 | `--text-2` |
| `#8993a2` | 三级文本 / 说明文字 | `--text-3` |
| `#4e5a68`、`#5a6472` | 空值占位、装饰性图标（拖拽把手） | `--text-dim` |
| `#f5f7fb` 作为图表 label | 图表文字 | `--text` |

语义色：

| 旧值 | Token |
|---|---|
| `#86a8ff`、`#6b8eef` | `--brand` |
| `#69d7a5`、`#48c774`、`#52c41a`、`#55d990` | `--green` |
| `#f2c46d`、`#faad14`、`#d48806`、`#f59e0b`、`#d29922` | `--amber` |
| `#ff7b84`、`#ff7875`、`#ff5d70`、`#d4380d`、`#ff5d70` | `--red` |
| `#58a3ff`、`#1677ff` | `--blue` |
| `#c080ff`、`#a887ff`、`#b18cff` | `--violet` |
| `#45d5e5`、`#13c2c2` | `--cyan` |
| `#bfbfbf` | `--text-3` |

表面 / 边框 / 叠层：

| 旧值 | Token |
|---|---|
| `#181b22` | `--surface` |
| `#1d212a`、`#141a24` | `--surface-2` |
| `#242a34`、`#3a424f` | `--surface-3` |
| `#2a3039` | `--line` |
| `#222831`、`#2a323d` | `--line-soft` |
| `#2b3648` | `--line`（与 `--line` 近乎同色；`--line-soft` 明显偏暗） |
| `#101318` | `--surface-inset` |
| `rgba(134, 168, 255, 0.13)` | `--brand-soft` |
| `rgba(134, 168, 255, 0.05)`（图表 cursor） | `tokens.chartCursor` |
| `rgba(255, 255, 255, 0.06)`（图表网格） | `tokens.chartGrid` |
| `rgba(255, 255, 255, 0.02/0.04/0.06)`、`rgba(0, 0, 0, 0.02/0.04/0.06)` | `--overlay-1/2/3` |
| `rgba(0, 0, 0, 0.35)`、`rgba(0, 0, 0, 0.4)`（浮层阴影） | `--shadow` |

浅色徽标 / 提示卡：

| 旧值 | Token |
|---|---|
| `#f6ffed` + `#b7eb8f` | `--green-soft` + `--green-line` |
| `#e6f4ff` + `#91caff` | `--brand-soft` + `--brand-line` |

> 注意：`#f6ffed`/`#e6f4ff` 是 antd **亮色预设**底，放在暗色主题下会形成刺眼的白色块 ——
> 这类「只在亮色下成立」的色值必须换成成对的 soft/line Token。

SF 段位色（`--cf-*`，由 `difficultyColor()` 返回）：

`--cf-new` `--cf-pupil` `--cf-specialist` `--cf-expert` `--cf-cm` `--cf-master` `--cf-gm`

Markdown 重点着色（AI 回复的扫读锚点，见 `client/src/components/markdownMark.ts`）：

| Token | 用途 | 为什么不能复用现有 Token |
|---|---|---|
| `--mark-text` | `==高亮==` 的文字色（底色用 `--amber-soft`） | `--amber` 是给图表/角标调的中等琥珀，放到 13px 正文的淡琥珀底上亮色主题只有 **2.05:1**，低于 WCAG AA |
| `--strong-text` | `**粗体**` 的文字色 | `--brand-text` 亮色下是 `#5a7de0`，在正文底色上只有 **3.38:1**，同样不达标 |

> 两个 Token 在 `:root`（暗色）与 `[data-theme='light']`（亮色）**成对声明**，
> 每套主题都按各自底色校准到 ≥ 4.5:1。改动后用 `cd client && npm run check:contrast`
> 核对（脚本直接读 `index.css` 的 Token 值按 WCAG 公式计算，不依赖浏览器）。

---

## 3. 有意保留的硬编码色

这些颜色属于「数据本身」而不是「主题外观」，换了就是错的：

| 位置 | 原因 |
|---|---|
| `ui.ts` 的 `PLATFORM_COLOR` | 各 OJ 品牌色（Codeforces 蓝、洛谷青…） |
| `ui.ts` 的 `TAG_PALETTE` | 知识点散列色板：同一标签必须跨主题、跨会话永远是同一色 |
| `components/ActivityHeatmap.tsx` 的 `light` / `dark` 数组 | GitHub 风格热力图色阶，本身就是按主题两套设计的 |
| `themeContext.tsx` 的 antd `token` / `components` 配置 | **antd 组件树的 Token 源头**，与 `index.css` 的 CSS 变量一一对应 |
| `components/markdownDiag.ts` | 文档字符串里的示例代码 |

---

## 4. 验收命令

```bash
# 1) 硬编码色扫描：应只剩上面「有意保留」的位置
node .scratch/scan-colors.mjs

# 2) CSS 变量完整性：不得出现未定义引用或自引用
node .scratch/check-css-vars.mjs

# 3) 类型 / 测试 / lint
cd client && npx tsc --noEmit -p tsconfig.app.json
cd client && npx tsx --test test/**/*.test.ts
cd client && npx oxlint

# 4) 生产构建
cd client && npx vite build

# 4.5) Markdown 排版专项（本轮新增）
cd client && npm run check:contrast      # 重点着色在暗/亮两套主题下的 WCAG 对比度
cd client && npm run check:render        # Markdown 渲染结构（含 ==高亮== / 段内换行）
cd client && npm run preview:markdown    # 生成一段 AI 回复的暗/亮预览页（自包含 HTML）
                                         # 产出在 client/test/.preview/，可直接用浏览器打开

# 5) 目标逐项断言（把计划书条目变成对源码的断言，共 135 项）
node .scratch/verify-objective.mjs    # Phase 1/2 + Phase 3-5 高价值项：83 项
node .scratch/verify-objective2.mjs   # Phase 3-6 剩余项：52 项

# 6) 浏览器核对（逐路由 × 明暗 × 断点截图 + 控制台归因 + 交互断言）
#    需先 npm run dev 起前后端；只用 Node 内置 WebSocket，不引入依赖
node .scratch/ui-check.mjs   .scratch/shots    # 全站明暗截图 + 控制台归因
node .scratch/ui-check2.mjs  .scratch/shots2   # 侧栏键盘排序 + 设置导航 + 折叠态 + 骨架屏
node .scratch/ui-check3.mjs  .scratch/shots3   # 命令面板/深链/删除二次确认/失败态
node .scratch/ui-check4.mjs  .scratch/shots4   # 响应式溢出 + Modal 适配
node .scratch/ui-check7.mjs  .scratch/shots7   # 真实 Tab/Enter 走键盘排序
node .scratch/ui-check10.mjs .scratch/shots10  # 面包屑/分类栏 Select/高速指令/卡片化/响应式回归
node .scratch/ui-check11.mjs .scratch/shots11  # 数字框失焦提交 + 长回复折叠
node .scratch/ui-check12.mjs .scratch/shots12  # 收口轮：控制台归因 + 命中区≥24×24 + 721-768 断点 + 日历/数字框/弹窗回归
node .scratch/ui-check12-visual.mjs            # 收口轮：24×24 排序按钮的悬停观感与明暗对照截图
```

**实测基线（改造后）**：

| 指标 | 数值 |
|---|---|
| `tsc` | 0 error |
| `oxlint` | 9 warning / 0 error（收口轮后；改造前 13） |
| `tsx --test` | 466 通过 / 0 失败（改造前 397；收口轮开工时 452） |
| `vite build` | 成功 |
| 硬编码色值出现次数 | 98（改造前 218），剩余全部为「有意保留」 |
| CSS 未定义/自引用变量 | 0 |
| 水平溢出（6 断点 × 13 路由 = 78 组合） | 0（改造前 6 个组合溢出，最宽 196px） |
| 目标断言核对 | 135 项全通过 |
| 控制台（13 路由 × normal，收口轮后） | 0 error / 0 warning（antd 弃用告警已清零） |
| 排序按钮命中区（收口轮后） | 全站 24×24（WCAG 2.2 最小目标尺寸） |

> ⚠️ 两个度量坑：`check-css-vars.mjs` 会命中**注释里的** `var(--token)` 与
> `--overlay-1: var(--overlay-1)` 示例文字（`ui.ts:12`、`index.css:89`），那是说明文字不是真实引用。
> 另外 `.reorder-controls` 有 `opacity 140ms` 过渡，聚焦后需等过渡结束再读 `getComputedStyle().opacity`；
> 无头浏览器还须先 `Emulation.setFocusEmulationEnabled`，否则 `:focus-within` 永不匹配。

