# ICPC Workbench · UI 优化落地报告

> 对应 `docs/UI-Optimization-Plan.md`（v1.0）与 `docs/UI-Design-Tokens.md`
> 范围：`client/src`（React 19 + Vite + Ant Design 5 + TypeScript）
> 结论：**Phase 1 / 2 / 3 / 5 全部完成，Phase 4 除 P4-4 外完成，Phase 6 全部完成**（详见 §11 与 §6）

---

## 1. 落地结果一览

| 指标 | 改造前 | 改造后 | 说明 |
|---|---|---|---|
| `tsc --noEmit` | 0 错 | **0 错** | `client/tsconfig.app.json` |
| `oxlint` | 13 warning / 0 error | **12 warning / 0 error** | 未新增，且顺手消掉 1 条 `exhaustive-deps` |
| `tsx --test` | 397 通过 | **429 通过 / 0 失败** | 新增 32 个用例（含回归防护） |
| `vite build` | 成功 | **成功** | 仅保留既有的大 chunk 提示 |
| 硬编码色值出现次数 | **218** | **98** | 剩余全部为「有意保留」（见 §4） |
| CSS 未定义/自引用变量 | 4 自引用 + 4 未定义 | **0** | 见 §2.1 |
| 报错级控制台输出 | 18 条 duplicate-key / 次 | **0**（仅剩 4 条既有 antd 弃用/兼容提示） | 见 §5.2 |
| 水平溢出（6 断点 × 13 路由 = 78 组合） | **6 个组合溢出** | **0** | 最宽溢出 196px → 0 |
| 目标断言核对 | — | **135 项全通过**（83 + 52） | `.scratch/verify-objective*.mjs` |

---

## 2. Phase 1 · 基础治理（完成）

### 2.1 修复 CSS 变量自引用与错误回退（P1-1）

`index.css` 的 `:root`（暗色）里存在 4 个**自引用**变量，暗色下真实值从未定义：

```css
/* 修复前 —— 自引用，整条声明失效 */
--overlay-1: var(--overlay-1);
--overlay-2: var(--overlay-2);
--overlay-3: var(--overlay-3);
--marker-ring: var(--marker-ring);
```

亮色主题里有具体值，所以**只有暗色主题坏掉**：`.rating-pill`（难度色丸）底色丢失、
`.platform-dot` 的内描边缺失。现已在两个主题里各给出具体值。

同时修掉一批「只有亮色才成立」或「只有暗色才成立」的隐性缺陷：

| 问题 | 症状 | 修复 |
|---|---|---|
| `--blue` / `--violet` / `--cyan` / `--accent-bg` / `--panel-2` / `--accent` / `--border` / `--text-1` / `--text-tertiary` / `--fill-2` 全部**未定义**，只靠 fallback 硬编码 | 暗色 fallback 在亮色下失效或反色 | 补齐真实 Token，删掉所有「暗色专用 hex fallback」 |
| `.note-preview-md[data-clipped]::after` 渐变回退写死 `#fff` | 暗色下白块遮罩 | 改用 `var(--surface)` |
| `.conn-dot-*` 光晕写死 `rgba(...)` | 亮色下光晕过重 | 新增 `--ring-ok/fail/checking` 双主题 Token |
| `.review-added-btn` 写死 `#48c774`、`.task-card-*::before` 写死 4 个 hex | 主题切换不跟随 | 改用 `--green` / `--blue` / `--violet` / `--cyan` / `--amber` |
| `--text-3: #8993a2`（亮色）对比度仅 **2.9:1** | 不满足 WCAG AA 正文 4.5:1 | 亮色改 `#656e7e`（**4.83:1**） |

### 2.2 图表与状态色 Token 化（P1-2）

`ui.ts` 变成唯一的色值出口：

- `TONE_VAR` / `toneVar(tone)`：8 个语义色调（`success warning danger info neutral brand violet cyan`）→ `var(--*)`。
- **`useTokenColors()`**：返回当前主题的**具体色值**。为什么需要它 —— recharts 把 `fill`/`stroke`
  写进 **SVG 表现属性**，`var()` 在其中不被解析，直接用会让图表整片掉色；该 hook 用
  `getComputedStyle` 读 `documentElement` 的计算值，并用 `MutationObserver` 监听 `data-theme`
  自动重取（同一主题内返回同一对象引用，避免多余渲染）。
- `difficultyTone()` / `rateTone()` 把**判断**与**配色**拆开，边界由单测覆盖；`difficultyColor()` 现在返回
  `var(--cf-*)`，亮/暗各有一套按底色校准的 CF 段位色（原先一套暗色 hex 在亮色下可读性差）。
- 新增 `gapColor(gap)`：弱项偏差三段语义色，替代 `Dashboard.tsx` 里的 `gapColorHex`。

`Dashboard / Mastery / Today` 的图表与状态色全部改走 Token；`Assistant / About / SyncProgress* /
SyncHistoryDrawer / CodeEditor / Settings / Problems / Lists` 的内联硬编码色一并清理（54 处纯色替换）。

### 2.3 账号视角切换器稳定键值（P1-4）

`AccountScopePicker` 原先用**数组下标**当 `Select` 的 value：账号增删或排序变化后，同一个下标会指向
另一个账号 —— 界面选中的项没变，实际统计口径已经换了号（**静默串数据**）。

现在 value 是 `platform:account` 稳定键值（`accountKey` / `parseAccountKey` / `scopeKey`），
「全部账号」用哨兵值 `'*'`。新增 6 个单测覆盖：键值与下标无关、往返无损、handle 含冒号、
非法键值返回 null、哨兵不与真实账号碰撞。

---

## 3. Phase 2 · 导航与全局体验（完成）

### 3.1 侧边栏按任务流重组（P2-1）

```
数据概览（固定置顶）
训练  今日训练 · AI 助手 · 模板库 · 训练计划
题库  题目管理 · 题单整理 · 复习库
赛事  赛事中心 · 日历打卡
数据  掌握度地图
设置 / 关于（固定底部）
```

与文档表格有**两处有意偏差**（照抄会丢入口）：

1. `/lists`（题单整理）文档未列出 —— 归入「题库」（它就是整理题目的地方）；
2. `/`（数据概览）文档放在「数据」组内 —— 这里仍**固定置顶**：它是应用落地页，
   沉到第四组会让首页入口在窄屏下掉出首屏。相应地把 `/mastery`（掌握度地图）从「题库」移到
   「数据」，它本就是「分析弱项」的视图，四组也都有内容。

**顺序迁移**：持久化 key 由 `icpc-menu-order-v1`（2 组）升到 `v2`（4 组）。读取 v2 失败时会把
v1 的两组拼成扁平序列，再按新分组重排 —— 用户排过的相对顺序不丢，而不是直接清空。

### 3.2 全局命令面板（P2-2）

新增 `CommandPalette.tsx`（`Cmd/Ctrl + K`，侧栏底部还有可点击的「搜索 ⌘K」入口解决可发现性）：

- 四个分组：**最近访问**（`recentPages.ts`，localStorage + 跨标签页同步）、**页面**（中英文别名，
  「sync」「配置」这类说法都能命中）、**题目**（`GET /api/problems/page?q=`，防抖 200ms、≥2 字符）、
  **模板**（首次打开拉一次 `/api/templates` 建索引，之后纯本地过滤）。
- ↑/↓ 选择、Enter 跳转、Esc 关闭、高亮项自动滚进可视区。
- 选中题目 → `/problems?q=<题号>`；选中模板 → `/templates?q=<名字>`。两个页面原先都不读 `?q=`，
  已补上深链支持（`Problems.tsx` 用 `urlQ` effect 跟随，因为 `App.tsx` 的页面容器按 **pathname**
  加 key，同一路由只变 query 不会重挂载）。

### 3.3 拖拽键盘化 + 撤销（P2-3 / §6.2）

全站统一一套：宿主加 `.reorder-host`，控件 `.reorder-controls > .reorder-btn`，
`opacity: 0`（**不**用 `visibility: hidden`，否则 Tab 焦点被移除）→ `:hover` 或 `:focus-within` 时显现。

覆盖：侧栏分组内条目、Dashboard 六个模块卡、Dashboard 平台小卡（共 **54 个按钮**）。
实测：全部可 Tab 聚焦、全部带 `aria-label`（如「上移『难度分布』」）、首末项正确 `disabled`（12 个）、
真实 Enter 键能完成重排并弹出 3 秒「撤销」提示（撤销可精确还原）。

侧栏还新增「恢复默认排序」按钮 —— 仅在顺序确实偏离默认时出现。

### 3.4 折叠态分组间距（P2-4）

折叠态原先隐藏分组标题后，4 个组的条目连成一串。现在组间加分隔线，折叠条目保持 40px 方轨，
图标用 antd `Tooltip` 显示完整名称。

---

## 4. Phase 3–5 · 高价值项（完成）

| 项 | 做法 | 实测 |
|---|---|---|
| **P3-1 操作列聚合** | 232px → **120px**；保留「标记 AC」为独立主操作，其余进「更多」下拉（加入/移出复习、人工校正知识点、卡在哪、删除）；删除走 `Modal.confirm` 说明连带影响 | 表头实测操作列 = 120px；下拉 4 项；确认框标题「删除题目 750H？」+ 完整后果说明 |
| **P3-1 批量操作** | 新增 `ProblemBatchActions.tsx`（纯展示 + 回调）；表格 `rowSelection` + `preserveSelectedRowKeys`；复用既有单条函数串行执行（`quiet` 模式不逐题弹提示/刷列表），完成后统一汇报成功/失败条数 | 勾选 1 行 → 操作条出现「已选 1 题」+ 三个动作 + 取消选择 |
| **P3-3 Dashboard 信息分层** | 新增「今日聚焦」卡（今日训练 / 最近弱项 / 查看赛事中心，**零新请求**）；`heatmap` / `history` 默认折叠并持久化；`PageHeader` 加「恢复默认布局」 | 首屏只剩统计带 + 4 个模块；热力图/写题历史只显示卡片头；展开/折叠有 `aria-expanded` |
| **P3-4 Dashboard 键盘排序** | 模块卡与平台卡各加上下移动按钮，两条路径都落盘、都弹撤销 | 真实 Enter 使 `平台分布 ↔ 难度分布` 互换并弹撤销提示 |
| **P5-1 组件库** | 新增 `PageSkeleton` / `CardSkeleton` / `EmptyState` / `InlineError` | 见下 |
| **P5-2 骨架屏与空态** | Dashboard→`PageSkeleton`；Problems→`PageSkeleton table`；Lists→`CardSkeleton table`。空态统一要求**至少一个真实的下一步按钮** | 拦截 `/api/lists` → 渲染 `InlineError`（「加载失败 / 重试」）而**不是**空态，`empty-state` 不出现 |
| **P5-3 Modal 响应式** | 全站 `.ant-modal { max-width: calc(100vw - 32px) }`，≤640px 时 `-16px` + 内容内边距收紧 + Drawer 占满 | 640px 视口实测 Modal 宽 620、`fitsInViewport: true` |
| **P4-1/P4-2 设置页** | 吸顶分段导航（AI / 账号与平台 / 同步 / 提醒 / 数据）+ 5 个分区锚点 + `IntersectionObserver` 高亮 + `scroll-margin-top: 64px`；右侧设置项搜索（手工索引 38 项，中文 + 英文别名 + 口语说法，分词全命中） | 5 个锚点全部存在；点「数据」滚到 `dataTop=64`；搜「备份」命中 4 项 |
| **P4-3 统一提交模式** | **未做**，见 §6 | — |

> 设置页导航未把卡片搬进 antd `Tabs`（等于整页重渲染，回归风险高），而是保留现有 DOM 顺序、
> 只加锚点 + 滚动高亮。文档要求的第 6 个分区「关于」在本页没有对应内容（版本号在侧栏），已从导航去掉。
>
> 后来（第六轮收尾之后）按用户要求**又删掉了「界面」分区**：它里面只有「恢复默认导航排序」一项，
> 而那是 `SiderMenu` 自身已有入口的冗余副本 —— 所以上表的分区清单恰好就是现在线上真实的样子。
> 细节与连带删除的四处见 Plan §16。

---

## 5. 顺带发现并修掉的既有缺陷

这三类是**改动前就存在**的，通过新旧对照实验确认，不是本次引入。

### 5.1 亮/暗主题对比度与「亮色预设底」误用

- 亮色 `--text-3` 对比度 2.9:1 → 4.83:1（见 §2.1）。
- `Mastery.tsx` 的「下一档建议」卡片用了 antd **亮色预设**底 `#f6ffed` / `#e6f4ff`：
  暗色主题下是一块刺眼白块。改用成对的 `--green-soft`/`--green-line`、`--brand-soft`/`--brand-line`。

### 5.2 `/today` 每次加载 18 条 duplicate key 报错

`Today.tsx` 里两组标签是**同一个 `<Space>` 的兄弟子节点**，React 按同一个 key 命名空间对齐它们；
两边都用裸标签名时，同一标签既是「弱项」又是普通标签就撞 key：

```tsx
{p.weakTags.map((t) => <Tooltip key={t}>…弱 · {t}…</Tooltip>)}
{p.tags.slice(0, 2).map((t) => <Tag key={t}>{t}</Tag>)}
```

React 明确说明重复 key 会导致子项被重复或**遗漏**。已加来源前缀（`weak:` / `tag:`）。
全站 13 个路由 + `/today` 轮换 4 次后，duplicate-key 报错 **0**。

### 5.3 响应式水平溢出

计划书 §9.1 要求「四个断点下无水平滚动」，实测改造前 65 个「路由 × 断点」组合里有 6 个溢出
（最宽 196px）。已定位并修掉：

| 页面 | 根因 | 修复 |
|---|---|---|
| `/settings` | 拉取速度说明里每个平台是一个 `white-space: nowrap` 的行内 `<span>` 且相邻**无空白**，整串构成一个不可断的长行 | 每个平台加 `display: inline-block`：自身不拆断，但两项之间获得换行机会 |
| `/contests` | `PageHeader` 的 `extra` 用 `<Space>`（默认 `flex-wrap: nowrap`），其 min-content = 全部子项总宽 ≈600px；作为 flex 项又被 `min-width: auto` 顶住无法收缩 | `<Space wrap>`；并给 `PageHeader` 的操作区加 `minWidth: 0`（全站受益） |

**新旧对照实验**（把 `Settings.tsx` 临时换回 HEAD 版本、量完再还原并校验内容逐字节一致）：

```
1280px: HEAD=37px  改动后=37px  -> 预存在
1024px: HEAD=165px 改动后=165px -> 预存在
 768px: HEAD=37px  改动后=37px  -> 预存在
```

---

## 6. 未做的部分（明确列出）

| 项 | 原因 |
|---|---|
| **P4-4 平台账号卡片组件化为 `AccountCard.tsx`** | **唯一未做的计划项**。它是纯代码组织、**零用户可见收益**，而账号区是本页耦合最紧、风险最高的部分：`acctInputs` / `acctDirty` / `acctCheck` / `cookieInputs` / `credShown` / `dirtyFields` 六份状态 + 8 个处理函数必须整体穿出，而这段代码的注释逐条记录了**历史缺陷**（任何一次 `load()` 都会清空所有平台正在填写的半成品输入；空串被当「显式清除」而静默删掉已存凭据）。抽出组件要先有一层针对「账号增删改 / Cookie 保存与清除」的测试网 —— 计划书 §10 自己也为 Settings 拆分写了同样的前置条件（「拆分前补充单元测试；保持 API 字段不变」）。建议单独一批：先补账号区测试，再做抽取 |
| **P3-5 的「按 分析/代码/建议 分段」** | 长度折叠已实现（见 §11.4）。**没有**做「按关键词猜标题再分段」：靠正则猜「这一段是分析、那段是代码」会把普通段落误判成章节，反而破坏可读性；而 AI 回复自带的 markdown 标题结构在渲染层本来就已经分层。这是有意的实现选择，不是遗漏 |

> 其余计划项均已完成。Phase 6 的 P6-1 ~ P6-4 与 P5-4、P3-2、P3-5、P4-3、§4.2 见 §11。

---

## 7. 验证方式与证据

计划书 §9.2 的三条自动化命令全部通过（见 §1）。此外自建了一套 **Chrome DevTools Protocol** 核对脚本
（只用 Node 内置 `WebSocket`，不引入依赖），覆盖：

1. **65 个「路由 × 断点」组合**的水平溢出检测 —— 0 失败。
2. **明/暗主题**逐页截图（Dashboard / Problems / Settings / Lists / Assistant / Mastery / Today / Contests）。
3. **控制台归因**：逐路由清空缓冲，定位每条 error/warning 属于哪个页面 → 最终只剩 3 条既有 antd
   弃用/兼容提示（`Calendar dateFullCellRender`、`InputNumber addonAfter`、antd v5 × React 19）。
4. **交互断言**（真实输入事件，非合成 DOM 事件）：
   - `Ctrl+K` 打开 / `Esc` 关闭 / 再按 `Ctrl+K` 切换；
   - 搜索 `abc347` → 题目 1 条；搜索 `线段树` → 题目 2 条 + 模板 2 条；
   - 点击模板 → 跳 `/templates?q=…` 且分类切到「数据结构」并展开该条目；
   - `/problems?q=abc347` → 搜索框值 `abc347`、共 2 题；同路由再跳 `?q=750H` → 跟随生效；
   - 真实 `Tab` 走到排序按钮 → `:focus-within` 使控件 `opacity: 1`；真实 `Enter` 完成重排 + 撤销提示；
   - 删除二次确认弹出后**取消**（数据未被修改，仍 50 行）。
5. **新旧对照实验**：`Settings.tsx` 换回 HEAD 版本量溢出，再还原并校验 `diff` 逐字节一致。

> 度量小坑（记录下来免得后人重踩）：`.reorder-controls` 有 `opacity 140ms` 过渡，
> `.focus()` 后立刻读 `getComputedStyle().opacity` 会拿到过渡起点 `0`；
> 而无头浏览器默认页面未 focused，`:focus-within` 根本不匹配 —— 必须先
> `Emulation.setFocusEmulationEnabled` 再用真实按键，否则会误判成功能缺陷。

---

## 8. 有意保留的硬编码色（非缺陷）

| 位置 | 原因 |
|---|---|
| `themeContext.tsx`（46 处） | **antd 组件树的 Token 源头**，与 `index.css` 的 CSS 变量成对维护 |
| `ui.ts` 的 `PLATFORM_COLOR` | 各 OJ 品牌色（Codeforces 蓝、洛谷青…），换了就不是那个平台 |
| `ui.ts` 的 `TAG_PALETTE` | 知识点散列色板：同一标签必须跨主题、跨会话永远同色 |
| `ui.ts` 的 `TOKEN_FALLBACK` | 无 DOM 环境（node 单测）下的兜底色值，已注明「只为拿到合法色值，浏览器里一律走计算值」 |
| `ActivityHeatmap.tsx` 的 `light`/`dark` 数组 | 热力图色阶本身按主题两套设计 |
| `markdownDiag.ts` | 文档字符串里的示例代码 |

---

## 9. 需要你确认的两点

1. **`docs/` 下 4 个文件处于「已删除」状态**（`2026-09-27-各板块未完善部分审计与优化.md`、
   `ai-review-plan.md`、`题目清洗工作流-优化落地报告.md`、`题目清洗工作流-标签可信度评估报告.md`）。
   这 4 处删除在我开始工作**之前**就已存在于工作区，不是本次改动造成的，我也没有还原它们 ——
   请确认是你有意删除，还是需要 `git checkout` 恢复。
2. **导航分组的两处偏差**（`/lists` 归入题库、`/` 保持置顶并把 `/mastery` 划到「数据」）见 §3.1。
   如果坚持完全照文档表格，改 `menuConfig.tsx` 的 `MENU_GROUPS` 一处即可。

---

## 10. 复盘：本轮踩到的两个「假缺陷」

记录下来以免后人重复误判 —— 两次都差点被我当成功能 bug 报出去：

1. **`.reorder-controls` 的可见性**：它有 `opacity 140ms` 过渡。`.focus()` 之后**立刻**读
   `getComputedStyle().opacity` 拿到的是过渡起点 `0`，而 `el.matches(':focus-within')` 已经是 `true`
   —— 一度表现为「CSS 规则命中了但没生效」。另外无头浏览器默认页面未 focused，
   `:focus-within` 根本不匹配，必须先 `Emulation.setFocusEmulationEnabled`。
2. **React 的 `onBlur` 收不到合成 `blur` 事件**：React 17+ 用原生 `focusin`/`focusout` 实现
   `onFocus`/`onBlur`，而 `blur` **不冒泡**。所以 `el.dispatchEvent(new Event('blur'))` 永远到不了
   处理器，看起来就像「失焦提交没实现」。正确做法是 `el.blur()`（会同时触发原生 blur 与 focusout）
   或派发 `focusout`。

两条都属于「探针错了，不是代码错了」。

---

## 11. 第二轮完成项（Phase 3 / 4 / 5 / 6 剩余）

### 11.1 P3-2 · 分类栏 ≤920px 改顶部 Select

原实现把算法标签/课程分类横排成需要**横向滚动**的窄条：一屏只看得见三四个、且丢了「全部标签」的语境。
新增 `client/src/useMediaQuery.ts`（`matchMedia` 驱动，只在跨断点时重渲染，不是每帧 resize），
并在 `Problems.tsx` / `Templates.tsx` 里**二选一渲染**：

- `> 920px`：常驻粘性侧栏（原样保留）；
- `≤ 920px`：顶部 `Select`（Problems 用多选 + 可搜索 + `maxTagCount="responsive"`，Templates 单选带 `已掌握/总数`）。

二选一而不是都用 CSS 藏着，是因为两套 DOM 同时存在会让 Tab 顺序里出现两个入口、读屏也会念两遍。

### 11.2 P6-1 · 模板库分类导航键盘化

与侧栏/Dashboard 同一套 `.reorder-host / .reorder-controls / .reorder-btn`：每行「上移/下移」，
首末项 `disabled`，与 mouse 拖拽共用 `saveCatOrder`（落盘格式完全一致），
**两条路径落盘后都弹 3 秒撤销**。分类按钮包了一层 `.taxonomy-row`，因为 CSS 用的是
`.reorder-host:hover > .reorder-controls`（**直接**子元素）。

### 11.3 P4-3 · 统一表单提交模式

| 优化项 | 改造前 | 改造后 |
|---|---|---|
| 单次同步上限 / 续拉轮数 | 停手 600ms 自动落库（时机不可预期，打字停顿也会发请求） | **失焦 / 回车提交**；值没变直接 return，不产生 POST 与提示 |
| 清空输入框 | 恢复服务端已落库值 | 同上（保留原语义，并明确注释「空串是误删、不是设成下限」） |
| 提交中反馈 | 无（用户会以为没生效而反复点） | 数字框 `disabled`（`InputNumber` 没有 `loading` 属性，禁用是等价忙碌态，同时挡掉「失焦提交没回来又改一次」的竞态） |
| 各开关 | 点完无反馈 | `Switch loading`：练习同步 / 提醒 / 按账号（`account:平台:handle`）/ 按平台适配器，失败回滚到服务端值 |
| Slider 拉取速度 | `onChangeComplete` + 600ms 防抖兜底 | **保持不动** —— 这正是计划书 §6.4 要求的形态 |

### 11.4 P3-5 · AI 助手

- **折叠态 64px 迷你栏**（原 40px）：会话首字当图标 + 附件数角标 + 正在流式生成的转圈，
  「＋」直接新建会话。
- **会话浮层**（`SessionMiniPanel.tsx`）：悬停**或键盘聚焦**窄边时浮出完整会话列表（含轮数、
  置顶标记、流式态），点击即切换，不必先展开侧栏；含空态「还没有会话 → 开始第一次对话」。
  折叠容器 `overflow` 由 `hidden` 改为 `visible`，否则绝对定位的浮层会被裁掉。
- **`/` 快捷指令**：新增纯逻辑模块 `chatCommands.ts`（6 条指令 + 中英文别名，15 个单测覆盖
  空斜杠、半截命令名、需要参数却没给、中文别名、大小写、多行正文里的斜杠等边界）。
  输入框上方浮出候选，↑↓ 选择 / Enter 执行 / Esc 忽略；需要参数而没给时先补全成 `/problem `；
  **解析不出来就照常当普通消息发出去，绝不静默吞输入**。`/problem <关键词>` 与
  `/template <关键词>` 复用命令面板已打通的 `?q=` 深链。
- **长回复折叠**：超过 1600 字的 AI 回复默认折到 340px，附「展开全文（约 N 千字）/ 收起」。
  渐变用 `mask-image` 而不是叠一层渐变背景 —— 气泡底色是半透明的 `--overlay-2`，
  盖不透明渐变会与底色对不上。
- **输入区固定**：核对确认 `.plan-chat-msgs { flex: 1; overflow-y: auto }` 已在 flex 列里承担滚动，
  输入区本就不随消息滚动，无需改动。

### 11.5 Phase 6 其余 · P6-2 / P6-3 / P6-4 / P5-4

- **P6-2 题单拖拽反馈**：落点行虚线占位 `.is-drop-target`、被拖行 `.is-dragging`、
  释放后 900ms 高亮 `.is-just-dropped`（定时器在卸载与新拖拽开始时清理）。
  **落点判定算法一行未动**。顺带修掉一个真实 CSS 优先级 bug：`.list-item-row:hover` 与
  `.is-drop-target` 同优先级且在后，会把落点的品牌软底盖掉、只剩虚线框 —— 补了
  `.is-drop-target:hover` 的显式规则。
- **P6-3 题单卡片化**：`Table` → `.list-card-grid` + `.list-card`，展示**真实字段**
  题数 / 分类数 / 进度（`solved_count/item_count` + 百分比）/ 创建日期，卡片可点击进入详情且键盘可达。
  ⚠️ `GET /api/lists` **没有** `updated_at`，所以「最近更新」无法展示，改显示创建时间 —— 没有伪造字段。
- **P6-4 / P5-4 响应式**：Reviews 卡片内「内容 | 操作」窄屏转纵向、按钮下沉；
  Contests 卡片列断点由 `md`(768) 改为 `lg`(992)，避免 768px 正好落成两列与「≤768 单列」冲突；
  Plans 详情两栏同样下沉 + `来源` 列在 <768px 隐藏（`responsive: ['md']`，渐进披露换零横向滚动）。

---

## 12. 收尾轮（第三 / 第四轮增量）

前两轮把「可拖拽重排」的侧栏 / Dashboard / 模板分类 / 题单做完，剩下两处不对称：题单**题目行**
与 AI 助手**会话记录**仍只有鼠标拖拽。这两轮把它们补齐，并把 Today 的失败态/空态分开。
逐项状态与验证记录见 [`UI-Optimization-Plan.md`](./UI-Optimization-Plan.md) §12、§13。

### 12.1 题单题目行键盘排序（第三轮）

- `Lists.tsx` 抽 `commitReorder()`：用**函数式 `setDetail`** 落库，不依赖 `detail` 闭包 ——
  原先 Drawer 关闭再重开时，拖拽回调可能操作到旧引用。
- 每行行首加「上移 / 下移」（hover / focus 显现，首尾自动 `disabled`），成功后弹 3 秒撤销，
  失败自动回滚到操作前顺序。
- `index.css` 加 `.list-item-reorder` / `.list-item-row .reorder-btn` 作用域样式。

### 12.2 Today 的失败态与空态分离（第三轮）

- 首屏 `Spin` → `PageSkeleton`（降低 CLS 与等待焦虑）。
- 新增 `loadError`：加载失败渲染 `InlineError`（可重试），空数据渲染带跳转动作的 `EmptyState`，
  不再把「请求失败」伪装成「今天没任务」。

### 12.3 AI 助手会话记录键盘排序 + 撤销（第四轮）

- `Assistant.tsx` 会话行接同一套 `.reorder-host / .reorder-controls / .reorder-btn`，**未新增任何 CSS**。
- **拖拽路径也补上了撤销**（此前拖完没有任何回退入口），两条路径共用一条提示。
- 顺序逻辑抽成纯函数 `client/src/pages/assistantSessionOrder.ts`，配
  `client/test/assistantSessionOrder.test.ts`（16 条断言）。核心设计：撤销**按 id 序列还原**，
  且只在 id 集合完全一致时应用 —— 3 秒窗口内新建/删除过会话就明确提示「无法撤销」，
  而不是悄悄做半截还原。
- 未做：折叠态迷你会话浮层（`SessionMiniPanel`）不加排序按钮 —— 它的行本身是 `<button>`，
  按钮不能嵌套按钮，要做需先改语义结构（已登记为 Plan §12.3 的 P7）。

### 12.4 本轮验证

- `npm run typecheck -w client`：通过。
- `npm run lint -w client`：0 错误 / 11 warning，数量与位置与改动前一致（无新增）。
- `npm test -w client`：**445 个测试全部通过**（含本轮新增 16 条）。
- `npm run build -w client`：构建成功（既有 chunk size warning）。
- 注：本机沙箱下 `vite build` 会因 Vite 的 Windows realpath 探测（内部 `exec('net use')`）
  报 `spawn EPERM`，属环境限制、与代码无关；纯函数测试亦可用
  `node --experimental-strip-types` 直接跑通。

---

## 13. 第五轮：组件库覆盖补齐（P2）

逐页状态、统一约定与验证记录见 [`UI-Optimization-Plan.md`](./UI-Optimization-Plan.md) §14。
这里只记结论与「为什么值得做」。

### 13.1 覆盖面

有取数或空态的 12 个页面全部接入 `PageSkeleton` / `CardSkeleton` / `EmptyState` / `InlineError`：
`Mastery`、`Reviews`、`Contests`、`Plans`、`Calendar`、`Templates`、`Settings` 七页在本轮补齐，
其余五页（Dashboard / Problems / Lists / Today / Assistant）前几轮已完成（`About` 是纯静态页，
没有加载态与空态）。
**没有新增 CSS、没有新增组件** —— 只是把第二轮就落地的四个组件的调用点补齐。

### 13.2 这不是样式活：修掉了两个真缺陷

- **`Settings` 首屏永久转圈**：`if (!data) return <Spin/>` + 失败只弹 toast（`data` 永远为 null）
  ⇒ 接口失败时用户看到的是永不结束的转圈，没有原因、没有重试。
- **`Templates` 把失败渲染成空态**：`!data` 分支里写的是 `<Empty description="模板课程加载失败" />`
  —— 文案承认失败、形态却是「没有数据」，且没有重试按钮。

同类但更轻的是 `Calendar`：任务卡取数失败会继续显示**上一次选中日期**的任务，或者落成
「当天没有计划任务」；月历取数失败时整月格子静默全空。

### 13.3 统一约定（写进 §14.3，后续新增页面照办）

``` 
loading && 屏上还没有数据  →  骨架
loadError                 →  InlineError(message + hint + onRetry)
数据为空                   →  Card > EmptyState（至少一个真实可点的 action）
否则                       →  内容
```

两条容易写错的细节，都已固化在文档里：

1. 判 `loading` 不够（每次重拉会全页闪骨架），判「只认首次加载」也不够
   （失败后点重试时屏上同样为空，会渲染成一片空白）—— 正解是 `loading && 列表为空`。
2. 六页在**新一轮取数开始时清 `loadError`**（入参变了就是在查另一份数据）；
   只有 `Settings` 保留错误态并让重试按钮转圈，因为它的 `load()` 永远查同一份数据。
   这是全站唯一真正用到 `InlineError#retrying` 的地方，属有意为之。

### 13.4 验证

- `npm run typecheck -w client`：通过。
- `npm run lint -w client`：0 错误 / 10 warning（基线 11：`Plans.tsx` 的 `load` 补了显式
  `eslint-disable-next-line react-hooks/exhaustive-deps` 并注释了理由），无新增。
- `npm test -w client`：445 个测试全部通过。
- `npm run build -w client`：构建成功。
- ⚠ 本轮**没有**运行时验证（内置浏览器不可用），结论只到编译/类型/静态约定层面。

---

## 14. 第六轮：收尾六项 + 运行时验证（P3–P8）

逐项实现与实测数据见 [`UI-Optimization-Plan.md`](./UI-Optimization-Plan.md) §15。

### 14.1 清空的待办

| 项 | 结果 |
|---|---|
| P8 `Mastery` 抽屉错误态 | 失败 → `InlineError(compact)` + 重试；空 → `EmptyState`；加载 → `CardSkeleton` |
| P6 赛事分类色 Token 化 | **前提不成立，关闭**：那些是 antd 预设色名，由 `theme.algorithm` 运行时解析、本就跟随亮暗；换 CSS 变量反而丢配对前景色 |
| P5 设置索引维护提醒 | 新增 `settingsIndex.test.ts`（7 条源码级不变量），并**验证过它会红**（改坏一条 → 用例失败） |
| P4 断点文档化 | 新增 [`responsive-breakpoints.md`](./responsive-breakpoints.md)：三套断点共存规则、antd 栅格的坑（`md`=768 的陷阱）、720 遗留 |
| P3 设置页宽屏左侧竖排 | ≥1280 左侧 220px 竖排 + 内容右栏；几何实测见 Plan §15.4 |
| P7 迷你会话浮层排序 | 行容器 `<button>` → `div` + 内层 `button` + 两个 `.reorder-btn`；Tab 顺序与 `aria-current` 无退化 |

### 14.2 本轮最有价值的一件事：把「看不见」变成「量得出来」

内置浏览器在本环境不可用（Electron 二进制缺失），前几轮的 UI 改动都只能在
编译/类型层面确认。本轮发现**本机 Chrome 可以 headless 跑通并渲染真实应用**，
于是用「pwsh 拉起 `--remote-debugging-port` + Node 走 CDP」搭了个探针
（`.scratch/uiprobe.mjs`，gitignore 内、不进仓库），补上了三种运行时验证：

- `normal`：13 条路由全部 0 未捕获异常、不停在整页 Spin；
- `fail`（把所有 `/api/*` 打成 reject）：7 个页面 **7/7 出 `InlineError`、0 个假空态** ——
  这正是 P2 承诺的那句话，终于被真的验证了，而不只是「代码看起来对」；
- `empty`（指定端点返回空）：5 个页面 **5/5 出带下一步按钮的 `EmptyState`**。

**它立刻抓到一个真缺陷**：`updateContext.tsx` 启动探测未接 `.catch`，
后端不可达时每个页面的每次加载都会产生未处理的 rejection（`void` 只压 lint，压不住 rejection）。
已修；修完 `fail` 模式 7 页异常计数归零。

同时发现三条 antd 弃用告警（`Calendar` 的 `dateFullCellRender`、`Settings` 的
`InputNumber addonAfter`、以及一条 `useForm` 未连接 Form 的告警 —— 最后这条可能对应
真实的「表单提交没反应」，已登记为 P9 优先排查）。

### 14.3 验证

- `npm run typecheck -w client`：通过。
- `npm run lint -w client`：0 错误 / 10 warning（与前一轮同，无新增）。
- `npm test -w client`：**452 个测试全部通过**（新增 7 条）。
- `npm run build -w client`：构建成功。
- 运行时：见 §14.2；P3 另有几何实测（1440 左栏 / 1200 顶栏 / 滚动 900px 后导航仍可见）。


