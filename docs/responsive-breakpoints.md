# ICPC Workbench · 响应式断点规范

> 版本：v1.1（2026-10-03，清理 720 遗留断点，见 §4.1）
> 范围：`client/src`（React 19 + Vite + Ant Design 5）
> 目的：全站**同时存在三套断点**（CSS 媒体查询 / JS `useMediaQuery` / antd 栅格 props），
> 本文是它们的唯一口径表；新增响应式改动前先读 §5 的 checklist。

---

## 0. 断点总表

按数值排序。**方向**一列是关键：前两套是 `max-width`（向下收），antd 栅格是 `min-width`（向上覆盖），
同一个数字在两套里的语义完全不同。

| 数值 | 方向 | 载体 | 语义 / 触发什么 |
|---|---|---|---|
| 1600 | ≥ | antd `xxl` | 预留，当前无使用 |
| 1280 | ≥ | CSS `index.css:3882` 段 + `BP.xlUp` | **换结构**：设置页分区导航由「顶部吸顶横排」换成「左侧竖排 + 内容右栏」 |
| 1200 | ≥ | antd `xl` | 三列 / 宽栏：Contests 卡片三列、Calendar 主副栏 16:8、Dashboard 模块跨度 |
| 1024 | ≤ | CSS `index.css:4144` 段 + `BP.lgDown` | 小桌面 / 平板横屏：`.page-skeleton-grid` 转单列 |
| 992 | ≥ | antd `lg` | 两列起点：Contests / About / Settings / Today |
| 920 | ≤ | CSS `index.css:1597` 段 + `BP.narrowTaxonomy` | **换结构**：分类侧栏 → 顶部 `Select`（Problems / Templates） |
| 768 | ≥ | antd `md` | Mastery 3 列、About 2 列、Plans 表格「来源」列出现 |
| 768 | ≤ | CSS `index.css:4150` 段 + `BP.mdDown` | 页面内边距收紧、卡片内「内容 \| 操作」下沉（`.card-actions-row`、`.review-item`） |
| 640 | ≤ | CSS `index.css:3838` / `4194` 段 + `BP.smDown` | 手机：Modal 贴边、命令面板列表降高 |
| 576 | ≥ | antd `sm` | 预留，当前无直接使用 |
| 575 | ≤ | antd `xs` | 单列兜底（`xs={24}`） |
| — | — | CSS `index.css:2852` | `prefers-reduced-motion`：不是宽度断点，禁用动画 |
| — | — | JS `themeContext.tsx:36,180` | `prefers-color-scheme`：跟随系统亮/暗，也不是宽度断点 |

**一句话记忆**：`640 手机 / 768 平板竖屏 / 920 分类栏 / 992 两列 / 1024 小桌面 / 1200 三列 / 1280 左侧栏`。

---

## 1. 为什么必须有三套

| 载体 | 能做什么 | 不能做什么 | 判据 |
|---|---|---|---|
| **CSS 媒体查询** | 换样式：间距、方向、列数、显隐 | 不能决定**渲染哪一份 DOM** | 只是「看起来不同」 |
| **JS `useMediaQuery(BP.x)`** | 决定渲染哪一套结构 | 不能做纯样式（会多一次渲染） | 两套 DOM **不能同时存在**时 |
| **antd 栅格 props**（`xs/md/lg/xl`、`responsive: [...]`） | 列数、列显隐 | 结构性替换 | 组件本身就是 antd `Row/Col/Table` |

必须用 JS 的典型例子（`useMediaQuery.ts` 文件头也写了）：题目管理的算法标签栏，
宽屏是常驻侧栏、≤920px 换成顶部 `Select`。两套 DOM 同时存在会产生**两个 Tab 停靠点**、
且读屏会重复念一遍，所以只能由 JS 决定渲染哪一个。

`matchMedia` 而不是监听 `resize`：只在**跨过断点**时重渲染一次，拖动窗口不会每帧 `setState`。

---

## 2. 单一数值口径

`client/src/useMediaQuery.ts` 的 `BP` 与 `index.css` 的 `@media` **必须同数值**，
文件头也注明了这条纪律。当前对照：

| `BP` 常量 | 值 | JS 侧调用点 | CSS 侧对应 |
|---|---|---|---|
| `narrowTaxonomy` | `(max-width: 920px)` | `Problems.tsx:177`、`Templates.tsx:155` | `index.css:1597`（`.workbench` / `.taxonomy-panel` 兜底） |
| `lgDown` | `(max-width: 1024px)` | 暂无 | `index.css:4144` |
| `mdDown` | `(max-width: 768px)` | 暂无 | `index.css:4150` |
| `smDown` | `(max-width: 640px)` | 暂无 | `index.css:3838`、`4194` |
| `xlUp` | `(min-width: 1280px)` | `Settings.tsx`（`wideNav`） | `index.css:3882` 段（设置页） |

> 前四个是 `max-width`（向下收），`xlUp` 是唯一的 `min-width`（向上扩）。
> 命名里带 Up/Down 就是为了让方向一眼可辨 —— 新增常量请沿用这个约定。

> `lgDown` / `mdDown` / `smDown` 目前**只有 CSS 在用**，JS 侧没有调用点。
> 保留它们是为了让「全站断点」有一个可 import 的书面口径，新增 JS 分支时直接用，
> 不要另写裸字符串 `'(max-width: 768px)'`。

---

## 3. antd 栅格的坑（都是踩过的）

- **方向相反**：`Col` 的每个断点是 `min-width`，**从该断点向上生效**，被更大的断点覆盖；
  基类（无媒体查询）始终生效。
  ```tsx
  <Col xs={24} lg={12} />   // <992 单列；≥992 两列
  ```
- **`md` 是 768 而不是「小于 768」**。Contests 早期写作 `xs={24} md={12} xl={8}`，
  结果 **768px 正好落成两列**，与「≤768 单列」的验收冲突；已改为 `lg={12}`。
  凡是「<=768 单列」的要求，两列的起点必须用 `lg`。
- **`responsive: ['md']`** 用于表格列显隐（`Plans.tsx:184` 的「来源」列）：
  ≥768 显示。窄屏让最难压缩的列退出，比横向滚动体验好。
- **`Grid.useBreakpoint()` 未使用**：本项目一律走 CSS 栅格 props 或 `useMediaQuery`，
  不要引入第三种订阅方式。

---

## 4. 已知不一致与后续动作

### 4.1 `720` 遗留断点已清理（2026-10-03）

原 `index.css:2335` 的 `@media (max-width: 720px) { .review-item .ant-card-body { flex-direction: column } }`
只覆盖 ≤720，导致 **721~768 区间**卡片内「内容 | 操作」仍是横排 —— 与 `.card-actions-row`
（≤768）语义重叠、数值却不一致。

**处理结果**：删除 720 这条规则，`.review-item` 的相关样式并入文件末尾的
`@media (max-width: 768px)` 段（与 `.card-actions-row` 同一处收口），并把
`.review-item-actions` 在纵向排布下多余的 `padding-top: 4px` 归零。

**实测**（CDP `getComputedStyle`，见 `.scratch/ui-check12.mjs` §4）：
| 视口 | `.review-item .ant-card-body` flex-direction | `.review-item-actions` padding-top |
|---|---|---|
| 730px | `column` | `0px` |
| 750px | `column` | `0px` |
| 768px | `column` | `0px` |
| 769px | `row`（边界正确，恢复横排） | — |

现在 `index.css` 里已不存在 `@media (max-width: 720px)` 这条规则（只在原地留了一行注释说明去向，
`grep 'max-width: 720px'` 命中的就是那行注释）。

### 4.2 骨架屏的块数不与真实列数联动

`PageSkeleton` 的 `blocks` / `blockHeight` 是调用点手工传的近似值，`.page-skeleton-grid`
在 ≤1024 转单列。数据落地时列数可能从 3 变 2（如 Contests），仍会有一次轻微位移 ——
这是**有意的取舍**：骨架只保证「结构同一量级」，不追求像素级对齐。

### 4.3 `1280` 是唯一「向上」的 JS 断点

设置页的分区导航在 `≥1280px` 由「顶部吸顶横排」换成「左侧竖排」（Plan §15 / P3）。
它必须走 JS 而不是纯 CSS：`Segmented` 的横/竖是 antd 的 **DOM 结构差异**
（竖排有独立的滑动指示块定位），CSS 强行 `flex-direction: column` 会得到一个滑块错位的伪竖排。
DOM 仍然只有一份，所以不产生重复 Tab 停靠点。

实测（headless Chrome + CDP 量 `getBoundingClientRect`）：

| 视口 | shell display | grid 列 | Segmented | 导航相对内容 |
|---|---|---|---|---|
| 1440px | `grid` | `220px 945px` | `vertical: true` | 左侧（nav.right ≤ body.left） |
| 1200px | `block` | — | 横排 | 上方（nav.bottom ≤ body.top） |

滚动 900px 后导航 `y` 从 98 → 12（贴在 `top: 12px`），内容 `y` 从 98 → −801 —— 即导航确实常驻可见。

### 4.4 没有 1200 的 JS 常量

`BP` 只有五个断点。需要 1200 的场景（三列）全部由 antd 栅格覆盖，
所以没有 `xlUp` 之外的「向上」常量；真要在 JS 里判 1200 时再补，并同步本文档。

---

## 5. 新增响应式改动的 checklist

1. 先判性质：**换样式**还是**换结构**？
   - 换样式 → CSS `@media`（用 §0 表里的既有数值，不要发明新数字）
   - 换结构 → `useMediaQuery(BP.x)`，并确认两套 DOM 不同时存在
   - 是 antd `Row/Col/Table` 的列数 → 栅格 props（注意 `lg` 而非 `md`，见 §3）
2. 新数值必须同时改两处：`useMediaQuery.ts` 的 `BP` + `index.css`，并更新本文档 §0。
3. 自检：≤640 无横向滚动；≤768 卡片内操作组下沉；Modal 不超视口。
4. 键盘可达性不受影响：被隐藏的分支不得留下不可见的 Tab 停靠点
   （`.reorder-controls` 用 `opacity: 0` 而不是 `visibility: hidden` 就是这条）。
5. 命中区（WCAG 2.2「目标尺寸（最小）」24×24）：列表排序按钮 `.reorder-btn` 一律 24×24；
   压缩视觉尺寸时必须用 `.reorder-btn::before` 的 `inset` 补足命中区，并保证
   **同排 gap ≥ 2px**（相邻两枚各自外溢时不得重叠）。实测脚本：`.scratch/ui-check12.mjs`。

---

## 6. 文件索引

| 文件 | 作用 |
|---|---|
| `client/src/useMediaQuery.ts` | `useMediaQuery()` + `BP` 常量（JS 断点唯一来源） |
| `client/src/themeContext.tsx` | 另一处 `matchMedia`，但查的是 `prefers-color-scheme`（主题，不是宽度） |
| `client/src/index.css` | 全部 CSS 媒体查询；行号见 §0 |
| `client/src/pages/Problems.tsx`、`Templates.tsx` | `BP.narrowTaxonomy` 的两个调用点 |
| `docs/UI-Optimization-Plan.md` §6.5 | 响应式策略的原始规划 |
