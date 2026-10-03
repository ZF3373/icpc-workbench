# ICPC Workbench · UI 优化方案

> 版本：v1.0  
> 范围：客户端 `client/src`（React + Ant Design）  
> 目标：在保留现有暗色工作台视觉风格的基础上，系统性提升交互流程、视觉层次、信息架构与组件一致性，建立可落地的 Design QA 流程。

---

## 1. 项目概述与优化目标

### 1.1 项目定位
ICPC Workbench 是一款面向算法竞赛备赛者的本地/桌面化训练工作台，覆盖数据概览、题目管理、AI 助手、模板库、训练计划、赛事中心等 13 个核心模块。当前采用 **React 19 + Vite + Ant Design 5** 构建，已具备完整的暗/亮主题切换、侧边栏分组导航、拖拽排序、Markdown/KaTeX 渲染与图表可视化能力。

### 1.2 核心优化目标

| 目标维度 | 当前问题 | 优化方向 | 成功指标 |
|---|---|---|---|
| 交互流程 | 拖拽排序无键盘替代；设置页流程冗长；题目管理操作列拥挤 | 减少操作步长、提供键盘/辅助操作路径、聚合高频操作 | 核心任务平均操作步数下降 ≥ 30% |
| 视觉层次 | 页面信息密度不均；硬编码颜色破坏主题一致性；部分内联样式未走变量 | 统一语义化色彩、建立字体/间距/elevation 层级 | 硬编码色值减少 ≥ 80%，暗/亮切换无异常 |
| 信息架构 | 13 个模块平铺导航；Dashboard 一屏塞入 6 大模块；设置页字段密集 | 按用户心智模型重新分组；引入首页工作台与分层设置 | 新用户首次找到目标页面时间 ≤ 15 秒 |
| 组件一致性 | 空态/加载态单一；表单布局不齐；响应式断点不足 | 建立组件规范与 Skeleton/Empty 模式库；补齐响应式 | 组件复用率提升，跨页面视觉偏差 ≤ 5% |
| 可用性 | 部分表单使用数组索引作为 value；缺少撤销/确认；空态缺少下一步引导 | 引入稳定键值、操作反馈、渐进式披露 | 设置表单误操作率下降 ≥ 50% |

---

## 2. 现状痛点分析

### 2.1 交互流程痛点

#### P1 · 全站拖拽排序缺乏无障碍与防误触设计
**表现**：侧边栏菜单、Dashboard 平台卡片/模块卡片、模板库分类导航、题单详情题目行均使用自定义 mouse 事件实现拖拽，无键盘替代方案，与点击/滚动区域重叠。
**影响**：
- 键盘与屏幕阅读器用户无法重排。
- 平台卡片「可点可拖」，容易在滚动或点击时误触发拖拽。
- 拖拽完成后无撤销入口，一旦误操作只能手动恢复。

#### P2 · 设置页流程冗长且缺少引导
**表现**：`Settings.tsx` 单文件体量庞大（> 64 KB），AI 配置、平台账号与适配器、提醒、同步参数、数据管理、导出等全部平铺；数字输入框使用防抖提交，清空时不落库。
**影响**：
- 用户进入设置页后找不到目标配置，认知负荷高。
- 表单行为不一致（部分即时保存、部分松手保存、部分清空恢复），容易误解为系统未响应。

#### P3 · 题目管理操作列过载
**表现**：表格操作列宽度 232 px 内塞入「标记 AC / 加入复习 / 卡在哪 / 知识点 / 删除」等 5+ 按钮。
**影响**：
- 小屏或列宽变化时按钮被截断或换行。
- 高频操作与危险操作（删除）视觉权重相同，误删风险高。
- 缺少批量操作入口，逐题处理效率低。

#### P4 · AI 助手侧栏折叠过窄
**表现**：侧栏折叠后仅留 40 px，会话列表、上下文、能力值全部消失。
**影响**：
- 用户难以感知当前会话上下文，展开前无法判断是否需要切换。
- 40 px 的可点击区域对触摸/高 DPI 屏不够友好。

### 2.2 视觉层次痛点

#### P5 · 硬编码颜色与内联样式破坏主题一致性
**表现**：
- `Dashboard.tsx` 中图表色、弱项偏差色、平台卡片色大量写死 hex。
- `Contests.tsx`、`Mastery.tsx`、`Today.tsx` 中等级/状态色硬编码。
- `index.css` 中任务卡左侧指示色、`.review-added-btn` 等使用固定 hex。
- 多处内联 `style={{ color: '#8993a2' }}`、`style={{ color: '#ff7875' }}`。
**影响**：
- 切换亮/暗主题后部分元素对比度异常或颜色不跟随。
- 新增主题（如高对比度）成本极高。

#### P6 · CSS 变量存在自引用与错误回退
**表现**：
- `:root` 中 `--overlay-1/2/3` 与 `--marker-ring` 自引用，暗色下实际未定义。
- `.note-preview-md[data-clipped]::after` 渐变回退色写死 `#fff`，暗色下产生不自然白色遮罩。
**影响**：暗色主题下部分组件渲染不可预期，存在视觉 bug。

#### P7 · 页面信息密度不均
**表现**：
- Dashboard 一屏内同时展示 6 个模块（统计带、平台卡、难度图、弱项图、趋势图、写题历史、热力图）。
- Settings 页字段密集，卡片之间缺少视觉节奏。
**影响**：
- 新手难以快速定位关键信息。
- 长表单缺少阶段性锚点，滚动后容易迷失。

### 2.3 信息架构痛点

#### P8 · 导航层级扁平，模块分组与用户任务不完全匹配
**表现**：侧边栏将 13 个模块分为「训练 / 题库与记录」两组，但「复习库」「赛事中心」「AI 助手」与「今日训练」「题目管理」的使用场景差异大。
**影响**：
- 用户在不同任务阶段（计划 → 做题 → 复习 → 参赛）需要在多个分组间跳转。
- 高频入口与低频入口权重相同。

#### P9 · 缺少全局搜索与快捷入口
**表现**：没有统一的题目/模板/计划/比赛搜索入口，用户必须进入对应页面再搜索。
**影响**：
- 跨模块查找成本高。
- 无法通过键盘快捷键快速跳转。

#### P10 · 空态与错误态引导不足
**表现**：
- 多数页面仅使用居中 `Spin size="large"` 加载，缺少骨架屏。
- 部分空态只提示「去设置绑定账号」，缺少一键跳转按钮。
- 加载失败与「无数据」状态 sometimes 混淆。
**影响**：
- 用户在首次同步或网络异常时容易产生「卡住」或「没有数据」的误判。

### 2.4 组件一致性痛点

#### P11 · 表单组件规范不统一
**表现**：
- 部分表单项标签左对齐，部分顶对齐；输入框宽度不一致。
- `AccountScopePicker` 使用数组索引作为 Select value，账号增删或排序变化时容易错位。
- 数字输入框的 debounce 行为在不同页面不一致。
**影响**：
- 用户在跨页面填写表单时产生不一致预期。
- 数据一致性风险（账号视角选错、配置未落库）。

#### P12 · 响应式断点不足
**表现**：
- 仅 Problems、Reviews、Calendar、Today 有少量响应式处理。
- Settings、Plans、About、Assistant 基本为桌面布局，Modal 宽度多为固定值（520–880 px）。
**影响**：
- 在平板、小屏笔记本或分屏场景下体验差，Modal 可能超 viewport。

#### P13 · 加载/空态组件单一
**表现**：
- 全站大量使用 `<Spin size="large" />` 居中加载。
- 缺少按模块的 Skeleton、逐步加载与占位动画。
**影响**：
- 数据概览、题目管理等重页面等待感明显，LCP 后的内容闪现（CLS）风险高。

---

## 3. 设计原则

基于现有「深空底色 + 雾蓝主色」的工作台风格，优化遵循以下原则：

1. **任务优先（Task-Oriented）**：导航与布局围绕「计划 → 训练 → 复盘 → 参赛」四大任务流组织，而非功能清单。
2. **渐进披露（Progressive Disclosure）**：复杂页面（设置、题目管理）按优先级分层，默认展示核心，高级选项折叠或移入二级面板。
3. **一致性优先（Consistency First）**：所有颜色、间距、圆角、阴影走 Design Token；禁止新增硬编码色值。
4. **无障碍基础（Accessibility Baseline）**：拖拽提供键盘/ARIA 替代；焦点可见；对比度满足 WCAG AA。
5. **性能感知（Perceived Performance）**：用 Skeleton、局部加载与微动画替代全局 Spin，减少等待焦虑。
6. **可逆操作（Reversible Actions）**：重排、删除、批量操作提供撤销或二次确认，避免不可逆误操作。

---

## 4. 导航结构与信息架构优化

### 4.1 建议的导航分组（按任务流）

将现有 13 个模块重新映射到 4 个任务组 + 2 个全局入口：

| 任务组 | 包含模块 | 用户目标 |
|---|---|---|
| **训练** | 今日训练、AI 助手、模板库、训练计划 | 今天做什么、怎么学、怎么练 |
| **题库** | 题目管理、掌握度地图、复习库 | 找题、追踪掌握度、复习 |
| **赛事** | 赛事中心、日历打卡 | 报名参赛、打卡记录 |
| **数据** | 数据概览、写题历史 | 看进度、分析弱项 |
| **全局 · 配置** | 设置 | 账号、偏好、同步 |
| **全局 · 信息** | 关于 | 版本、文档、反馈 |

> 当前侧边栏分组为「训练 / 题库与记录」，建议改为「训练 / 题库 / 赛事 / 数据」，使分组语义与任务流对齐。

### 4.2 导航优化细节

| 优化项 | 现状 | 建议 | 预期效果 |
|---|---|---|---|
| 分组标题 | 「训练 / 题库与记录」 | 「训练 / 题库 / 赛事 / 数据」 | 降低认知负荷，任务流更清晰 |
| 排序策略 | 组内可拖拽，但无恢复默认入口 | 在设置中增加「恢复默认导航排序」按钮 | 提供可逆路径 |
| 快捷键 | 无 | 增加 `Cmd/Ctrl + K` 全局搜索面板，支持跳转页面、搜索题目/模板/比赛 | 提升跨模块查找效率 |
| 当前位置感知 | 仅侧边栏高亮 | 在页头增加面包屑或返回上一级入口（如题单详情 → 题单整理） | 减少迷失感 |
| 折叠态 | 仅显示图标，无分组 | 折叠态保留分组间距，图标 Tooltip 显示完整名称 | 折叠后仍可快速识别 |

### 4.3 新增全局命令面板（Command Palette）

**目标**：解决「缺少全局搜索与快捷入口」痛点。
**范围**：新增 `CommandPalette.tsx` 组件，挂载在 `App.tsx`。
**功能**：
- 快捷键 `Cmd/Ctrl + K` 唤起。
- 支持最近访问、页面跳转、题目 ID/标题模糊搜索、模板关键词搜索。
- 键盘上下选择，回车跳转，Esc 关闭。

---

## 5. 核心页面布局优化

### 5.1 数据概览（Dashboard）

#### 现状问题
- 一屏塞入 6 大模块，信息过载。
- 平台卡片与模块卡片均支持拖拽，但无键盘替代。
- 统计带与模块之间缺少视觉节奏。

#### 优化建议

| 优化项 | 目标 | 实施范围 |
|---|---|---|
| 引入「今日聚焦」区域 | 将「今日训练入口 + 最近弱项 + 待参赛提醒」置顶，降低首次打开时的决策成本 | 新增顶部卡片，不占模块区 |
| 模块卡片默认折叠次要项 | 平台分布、难度分布默认展开；写题历史、热力图默认折叠或移入第二屏 | 修改 `MODULE_SPANS` 与默认展开态 |
| 拖拽增加键盘替代 | 在模块卡片标题栏增加「上移/下移」按钮（仅聚焦时可见） | `Dashboard.tsx` + `ModuleCard` |
| 图表颜色走 Token | `CHART_COLORS`、`gapColorHex` 改用 `getTokenColor` 工具函数 | `Dashboard.tsx`、`ui.ts` |
| 平台卡片操作防误触 | 拖拽把手仅在 hover/focus 时显示，点击区域与拖拽区域分离 | `index.css` + `Dashboard.tsx` |

#### 预期效果
- 首屏信息量减少约 30%，关键决策路径更短。
- 主题切换后图表颜色一致。
- 键盘用户可完成模块重排。

### 5.2 题目管理（Problems）

#### 现状问题
- 操作列 232 px 内塞入 5+ 按钮，拥挤且易误触。
- 左侧知识点分类栏 sticky，但小屏下变为横向滚动条，可读性差。
- 筛选面板折叠后缺少已选条件摘要。

#### 优化建议

| 优化项 | 目标 | 实施范围 |
|---|---|---|
| 操作列聚合为下拉菜单 | 将「加入复习 / 卡在哪 / 知识点 / 删除」聚合为「更多」Dropdown，保留「标记 AC」为独立主操作 | `Problems.tsx` 表格列定义 |
| 增加批量操作栏 | 表格顶部增加批量选择后的操作条（批量标记 AC、批量加入复习、批量删除） | 新增 `ProblemBatchActions.tsx` |
| 分类栏小屏优化 | 920 px 以下不改为横向滚动，而是折叠为顶部 Select/Tabs 切换 | `Problems.tsx` + `index.css` |
| 筛选摘要标签 | 已选难度/标签/平台以 Tag 形式展示在筛选面板外部，支持一键清除 | `problemFilter.ts` + `Problems.tsx` |
| 表格行悬停预览 | 悬停题目行时显示快速操作（Popover），减少进入详情页的步数 | 可选，评估后实施 |

#### 预期效果
- 操作列宽度降至 120 px 以内，表格可用空间增加。
- 批量操作使多题处理效率提升 ≥ 50%。
- 筛选状态可见性提升，误筛选减少。

### 5.3 AI 助手（Assistant）

#### 现状问题
- 侧栏折叠后仅 40 px，上下文全部消失。
- 聊天信息密度高，长消息缺少分段与视觉锚点。

#### 优化建议

| 优化项 | 目标 | 实施范围 |
|---|---|---|
| 折叠态保留 64 px 迷你侧栏 | 显示当前会话图标、未读/附件提示，点击可展开 | `Assistant.tsx` + `index.css` |
| 会话列表增加空态与新建入口 | 折叠态 hover 显示浮层面板 | 新增 `SessionMiniPanel.tsx` |
| 消息卡片分段 | AI 长回复按「分析/代码/建议」分段，并增加折叠/展开 | `Markdown.tsx` 已有基础，可扩展 |
| 输入框固定 + 快捷指令 | 底部输入区固定，支持 `/` 快捷指令（如 `/search 二分`） | `Assistant.tsx` |

#### 预期效果
- 侧栏折叠后用户仍可感知当前状态。
- 长消息可读性提升，操作路径缩短。

### 5.4 设置（Settings）

#### 现状问题
- 单文件过大，表单字段密集。
- 缺少分步引导与搜索。
- 数字输入 debounce 行为不一致。

#### 优化建议

| 优化项 | 目标 | 实施范围 |
|---|---|---|
| 分标签页/锚点导航 | 将设置拆分为「AI / 账号与平台 / 提醒 / 同步 / 数据 / 关于」六大标签或左侧锚点 | `Settings.tsx` 拆分 |
| 引入设置搜索 | 顶部搜索框过滤设置项，快速定位 | 新增 `SettingsSearch.tsx` |
| 统一表单提交模式 | 所有数字输入统一为「失焦/回车提交」，清空时显式恢复默认值；Slider 使用 `onChangeComplete` + 防抖兜底 | `Settings.tsx` |
| 平台账号卡片规范化 | 将账号小卡片提取为 `AccountCard.tsx`，统一新增/编辑/检测流程 | 新增组件 |
| 危险操作二次确认 | 删除账号/清除数据增加 Modal 二次确认与后果说明 | `Settings.tsx` |

#### 预期效果
- 用户找到目标设置项的时间从分钟级降至秒级。
- 表单提交行为一致，误操作率下降。
- 设置页文件拆分为多个子组件，维护性提升。

### 5.5 模板库（Templates）与题单整理（Lists）

#### 现状问题
- 模板库分类导航可拖拽但无键盘替代。
- 题单详情 Drawer 中题目行拖拽排序，缺少操作反馈。

#### 优化建议

| 优化项 | 目标 | 实施范围 |
|---|---|---|
| 分类导航增加键盘排序 | 每个分类项增加上下移动按钮（仅聚焦时可见） | `Templates.tsx` + `SiderMenu` 通用化 |
| 题单拖拽增加占位动画 | 拖拽时显示虚线占位，释放后短暂高亮 | `Lists.tsx` + `index.css` |
| 题单增加封面/描述 | 题单列表卡片化，显示题数、进度、最近更新 | `Lists.tsx` |

---

## 6. 组件一致性与可用性提升策略

### 6.1 Design Token 治理

#### 目标
消除硬编码颜色，建立唯一可信的 Token 来源。

#### 实施范围

| 优化项 | 现状 | 目标 | 关键文件 |
|---|---|---|---|
| 图表颜色 Token 化 | `Dashboard.tsx` 写死 hex | 所有图表颜色从 `ui.ts` 的 `tokenColor` 获取，支持亮/暗 | `ui.ts`、`Dashboard.tsx`、`Contests.tsx`、`Mastery.tsx` |
| 状态/等级色 Token 化 | `Contests.tsx`、`Mastery.tsx`、`Today.tsx` 硬编码 | 建立 `semanticColor` 映射（success/warning/error/info/neutral） | `ui.ts`、相关页面 |
| 修复 CSS 变量自引用 | `--overlay-*` / `--marker-ring` 自引用 | 暗色下给出具体 rgba 值 | `index.css` |
| 修复渐变回退色 | `.note-preview-md` 写死 `#fff` | 改用 `var(--surface)` 或透明遮罩 | `index.css` |
| 内联样式清理 | 多处 `style={{ color: '#...' }}` | 替换为语义化 class 或 Token | 全站扫描 |

#### 验收标准
- `grep -r "#[0-9a-fA-F]\{3,6\}" client/src --include="*.tsx"` 仅剩图表/地图等必须硬编码的第三方配置。
- 暗/亮主题切换后，所有页面无异常色块或遮罩。

### 6.2 拖拽交互无障碍改造

#### 目标
为所有拖拽排序提供键盘与屏幕阅读器替代方案。

#### 实施范围

| 组件/场景 | 现状 | 优化 | 文件 |
|---|---|---|---|
| 侧边栏菜单 | mouse 拖拽 | 增加聚焦态上下移动按钮；保留拖拽作为快捷方式 | `SiderMenu.tsx` |
| Dashboard 平台卡片 | mouse 拖拽 | 卡片标题增加排序按钮；拖拽把手 hover 显示 | `Dashboard.tsx` |
| Dashboard 模块卡片 | mouse 拖拽（仅头部） | 头部增加排序按钮；拖拽保留 | `Dashboard.tsx` |
| 模板库分类 | mouse 拖拽 | 分类项增加排序按钮 | `Templates.tsx` |
| 题单题目行 | mouse 拖拽 | 行首增加排序按钮；拖拽保留 | `Lists.tsx` |

#### 验收标准
- 每个可拖拽项在键盘 Tab 焦点下可见上下移动按钮。
- 拖拽完成后提供 3 秒「撤销重排」提示（Toast + 撤销按钮）。

### 6.3 加载/空态组件库

#### 目标
用分层加载与结构化空态替代单一全局 Spin。

#### 新增/改造组件

| 组件 | 用途 | 场景 |
|---|---|---|
| `PageSkeleton.tsx` | 页面级骨架屏，模拟统计带、卡片、表格结构 | Dashboard、Problems、Lists |
| `CardSkeleton.tsx` | 卡片级骨架屏 | Dashboard 模块卡片、Reviews |
| `EmptyState.tsx` | 统一空态，支持标题、描述、主操作按钮 | 全站替换 `Empty` |
| `InlineError.tsx` | 局部错误重试 | 表格、图表加载失败 |

#### 验收标准
- Dashboard、Problems、Lists 页面首屏使用 `PageSkeleton`。
- 所有空态至少包含一个明确的下一步操作按钮。

### 6.4 表单与选择器规范化

#### 目标
统一表单布局、提交行为与选择器键值。

#### 实施范围

| 优化项 | 现状 | 目标 | 文件 |
|---|---|---|---|
| 账号视角选择器 | 使用数组索引作为 value | 使用 `platform:account` 稳定字符串作为 value | `AccountScopePicker.tsx`、`accountScope.ts` |
| 表单标签对齐 | 部分左对齐，部分顶对齐 | 统一为顶对齐（复杂表单）或右对齐（简单表单） | `Settings.tsx` 拆分后统一 |
| 数字输入提交 | debounce 600 ms，清空恢复默认值 | 统一为失焦/回车提交，清空时显式恢复 | `Settings.tsx` |
| 开关即时反馈 | 部分开关点击后无 loading | 增加 `Switch` 提交 loading 态与失败回滚 | `Settings.tsx` |

### 6.5 响应式策略补齐

#### 目标
覆盖 1280 px（桌面）、1024 px（小桌面/平板横屏）、768 px（平板竖屏）、< 640 px（手机）四个断点。

#### 页面级响应式计划

| 页面 | 当前状态 | 优化 |
|---|---|---|
| Dashboard | 依赖 antd Col 的 xs/xl | 增加 `lg`/`md` 断点；模块卡片在 1024 px 以下单列 |
| Problems | 920 px 以下分类栏横向滚动 | 改为顶部 Select/Tabs；表格操作列在 768 px 以下隐藏为 Dropdown |
| Settings | 基本无响应式 | 标签页/锚点导航；表单在小屏下单列；Modal 在小屏下宽度 100% |
| Assistant | 侧栏折叠到 40 px | 折叠态 64 px；输入区在小屏下简化 |
| Plans / Reviews / Contests | 少量响应式 | 卡片列表在 768 px 以下单列；操作按钮下沉 |
| Modal 全站 | 固定宽度 520–880 px | 增加 `max-width: calc(100vw - 32px)`；小屏下占满 |

---

## 7. 优化前后对比

### 7.1 导航结构对比

| 维度 | 优化前 | 优化后 |
|---|---|---|
| 分组 | 训练 / 题库与记录 | 训练 / 题库 / 赛事 / 数据 |
| 排序恢复 | 无恢复默认入口 | 设置中可恢复默认排序 |
| 全局搜索 | 无 | `Cmd/Ctrl + K` 命令面板 |
| 折叠态 | 仅图标，无分组间距 | 保留分组间距，Tooltip 显示名称 |

### 7.2 核心页面对比

| 页面 | 优化前 | 优化后 |
|---|---|---|
| **Dashboard** | 6 模块平铺；图表色硬编码；拖拽无键盘 | 今日聚焦 + 模块卡片；Token 图表色；键盘可排序 |
| **Problems** | 操作列 5+ 按钮；分类栏小屏横向滚动 | 操作聚合 Dropdown；批量操作；小屏顶部 Select |
| **Assistant** | 侧栏折叠 40 px；长消息无分段 | 折叠态 64 px 迷你栏；消息分段与快捷指令 |
| **Settings** | 单文件 64 KB；字段平铺；debounce 不一致 | 标签页/锚点导航；搜索过滤；统一提交模式 |

### 7.3 组件一致性对比

| 维度 | 优化前 | 优化后 |
|---|---|---|
| 颜色 | 大量硬编码 hex | 全部走 Design Token |
| 拖拽 | 仅 mouse | mouse + 键盘按钮 + 撤销提示 |
| 加载 | 全局 Spin | 分层 Skeleton + 局部 Error |
| 表单 | 索引 value、对齐不一 | 稳定键值、统一布局与提交 |
| 响应式 | 少量断点 | 四断点覆盖 + Modal 自适应 |

---

## 8. 落地计划（按优先级排序）

### Phase 1 · 基础治理（高优先级，预计 1 周）

| 编号 | 任务 | 目标 | 实施范围 | 预期效果 |
|---|---|---|---|---|
| P1-1 | 修复 CSS 变量自引用与错误回退 | 消除暗色主题下的视觉 bug | `index.css` | 暗色下 overlay/marker 正常 |
| P1-2 | 图表与状态色 Token 化 | 消除 Dashboard/Contests/Mastery/Today 硬编码色 | `ui.ts` + 4 个页面 | 主题切换颜色一致 |
| P1-3 | 清理内联硬编码样式 | 减少 `style={{ color: '#...' }}` | 全站扫描替换 | 维护成本降低 |
| P1-4 | 账号视角选择器改用稳定键值 | 防止账号增删导致选错 | `AccountScopePicker.tsx` | 选择器稳定性提升 |

### Phase 2 · 导航与全局体验（高优先级，预计 1 周）

| 编号 | 任务 | 目标 | 实施范围 | 预期效果 |
|---|---|---|---|---|
| P2-1 | 侧边栏分组重组 | 按任务流分组 | `menuConfig.tsx`、`SiderMenu.tsx` | 导航认知负荷降低 |
| P2-2 | 全局命令面板 | 提供跨模块搜索与跳转 | 新增 `CommandPalette.tsx` | 跨模块查找效率提升 |
| P2-3 | 侧边栏拖拽键盘化 | 增加排序按钮与恢复默认 | `SiderMenu.tsx` | 无障碍支持 |
| P2-4 | 折叠态优化 | 保留分组间距与 Tooltip | `index.css` | 折叠态可用性提升 |

### Phase 3 · 核心页面重构（中优先级，预计 2 周）

| 编号 | 任务 | 目标 | 实施范围 | 预期效果 |
|---|---|---|---|---|
| P3-1 | 题目管理操作列聚合与批量操作 | 解决操作列拥挤 | `Problems.tsx` + 新组件 | 表格可用空间增加 ≥ 30% |
| P3-2 | 题目管理分类栏小屏优化 | 改善平板/小屏体验 | `Problems.tsx` + `index.css` | 小屏可读性提升 |
| P3-3 | Dashboard 信息分层 | 减少首屏信息过载 | `Dashboard.tsx` | 首屏信息量减少 ≥ 30% |
| P3-4 | Dashboard 拖拽键盘化 | 模块/平台卡片支持键盘排序 | `Dashboard.tsx` | 无障碍支持 |
| P3-5 | AI 助手侧栏与消息体验优化 | 保留上下文、分段消息 | `Assistant.tsx` | 长消息可读性提升 |

### Phase 4 · 设置页重构（中优先级，预计 1.5 周）

| 编号 | 任务 | 目标 | 实施范围 | 预期效果 |
|---|---|---|---|---|
| P4-1 | 设置页拆分为标签页/锚点导航 | 降低信息密度 | `Settings.tsx` 拆分 | 查找时间降至秒级 |
| P4-2 | 设置搜索 | 快速定位配置项 | 新增 `SettingsSearch.tsx` | 配置效率提升 |
| P4-3 | 统一表单提交模式 | 消除 debounce 不一致 | `Settings.tsx` | 误操作率下降 ≥ 50% |
| P4-4 | 平台账号卡片组件化 | 统一账号管理流程 | 新增 `AccountCard.tsx` | 代码复用率提升 |

### Phase 5 · 加载/空态与响应式（中优先级，预计 1.5 周）

| 编号 | 任务 | 目标 | 实施范围 | 预期效果 |
|---|---|---|---|---|
| P5-1 | 构建 Skeleton/Empty 组件库 | 替代全局 Spin | 新增 4 个组件 | 等待焦虑降低 |
| P5-2 | Dashboard/Problems/Lists 接入骨架屏 | 分块加载 | 3 个页面 | 首屏感知性能提升 |
| P5-3 | 全站 Modal 响应式适配 | 小屏不溢出 | 全站 Modal 调用点 | 移动端体验可用 |
| P5-4 | Settings/Assistant/Plans 响应式补齐 | 覆盖四断点 | 多个页面 | 平板/小屏可用 |

### Phase 6 · 模板库、题单、复习库等细节优化（低优先级，预计 1 周）

| 编号 | 任务 | 目标 | 实施范围 | 预期效果 |
|---|---|---|---|---|
| P6-1 | 模板库分类导航键盘化 | 支持键盘排序 | `Templates.tsx` | 无障碍支持 |
| P6-2 | 题单拖拽视觉反馈增强 | 拖拽占位与高亮 | `Lists.tsx` | 操作反馈明确 |
| P6-3 | 题单卡片化展示 | 增加进度与描述 | `Lists.tsx` | 信息层次更清晰 |
| P6-4 | 复习库/赛事中心响应式 | 小屏单列 | 2 个页面 | 移动端可用 |

### 优先级路线图

```
Week 1        Week 2        Week 3        Week 4        Week 5        Week 6        Week 7
|-------------|-------------|-------------|-------------|-------------|-------------|
[Phase 1]     [Phase 2]     [Phase 3 ···] [Phase 3 ···] [Phase 4]     [Phase 5]     [Phase 6]
基础治理       导航全局体验   核心页面重构   核心页面重构   设置页重构     加载/响应式   细节优化
```

---

## 9. 验收标准与 QA 流程

### 9.1 设计 QA Checklist

| 检查项 | 通过标准 |
|---|---|
| 颜色一致性 | 全站无新增硬编码色值（图表除外）；暗/亮切换无异常 |
| 对比度 | 正文与背景对比度 ≥ 4.5:1；大号文本 ≥ 3:1 |
| 键盘导航 | 所有可交互元素可通过 Tab 聚焦；拖拽排序有键盘替代 |
| 响应式 | 1280/1024/768/<640 四个断点下无水平滚动或内容截断 |
| 加载/空态 | Dashboard/Problems/Lists 使用骨架屏；所有空态含下一步操作 |
| 表单一致性 | 无索引 value；提交行为统一；错误状态明确 |

### 9.2 推荐测试流程

1. **自动化**：
   - `npm run lint -w client` 无新增 warning。
   - `npm run typecheck` 通过。
   - 新增视觉回归测试（可选 Playwright + Argos）。
2. **手动测试**：
   - 暗/亮主题切换遍历所有页面。
   - 键盘-only 操作侧边栏排序、Dashboard 模块排序。
   - 320 px、768 px、1280 px 三个宽度下检查布局。
   - 清空/恢复默认/批量删除等危险操作验证二次确认。
3. **用户走查**：
   - 邀请 2–3 名目标用户完成「制定今日训练 → 找题 → 标记 AC → 查看数据概览」任务流，记录卡点。

---

## 10. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 硬编码颜色清理涉及面广，可能引入回归 | 中 | 按文件分批修改，每批跑暗/亮主题截图对比 |
| Settings 拆分改动大，可能影响表单提交 | 高 | 拆分前补充单元测试；保持 API 字段不变；灰度发布 |
| 拖拽键盘化改动多，可能破坏现有 mouse 拖拽 | 中 | 保留 mouse 拖拽为默认，键盘按钮作为独立代码路径 |
| 响应式适配覆盖 Modal 全站，工作量大 | 中 | 优先处理高频 Modal（设置/题目编辑/AI 配置），其余逐步补齐 |

---

## 11. 附录：关键文件清单

| 文件 | 当前职责 | 优化涉及 |
|---|---|---|
| `client/src/index.css` | 全局设计系统 | Token 修复、响应式、拖拽样式 |
| `client/src/App.tsx` | 全局布局 | 命令面板挂载 |
| `client/src/menuConfig.tsx` | 导航元数据 | 分组重组 |
| `client/src/components/SiderMenu.tsx` | 侧边栏菜单 | 键盘排序、恢复默认 |
| `client/src/pages/Dashboard.tsx` | 数据概览 | 信息分层、Token 颜色、拖拽键盘化 |
| `client/src/pages/Problems.tsx` | 题目管理 | 操作聚合、批量操作、分类栏响应式 |
| `client/src/pages/Assistant.tsx` | AI 助手 | 侧栏折叠、消息分段 |
| `client/src/pages/Settings.tsx` | 设置 | 拆分、搜索、统一提交 |
| `client/src/ui.ts` | UI 工具函数 | 新增 Token 颜色工具 |
| `client/src/components/AccountScopePicker.tsx` | 账号视角 | 稳定键值 |

---

## 12. 实施状态与后续建议（2026-10-03 更新）

### 12.1 已实现项核对

通过第二次代码审计与增量开发，确认以下优化项已在代码中落地：

| 优化项 | 状态 | 关键证据 |
|---|---|---|
| CSS 变量自引用修复 | 已完成 | `:root` 中 `--overlay-*` / `--marker-ring` 已给出具体 rgba 值 |
| 账号视角稳定键值 | 已完成 | `AccountScopePicker.tsx` 使用 `scopeKey()` / `parseAccountKey()` |
| Dashboard Token 颜色 | 已完成 | `Dashboard.tsx` 使用 `useTokenColors()`、`gapColor()` |
| 全局命令面板 | 已完成 | `CommandPalette.tsx` + `App.tsx` `Cmd/Ctrl + K` 监听 |
| 导航分组重组 | 已完成 | `menuConfig.tsx` 四任务流分组 |
| 题目管理操作聚合/批量操作 | 已完成 | `Problems.tsx` + `ProblemBatchActions.tsx` |
| 题目管理分类栏小屏优化 | 已完成 | `useMediaQuery` + 顶部 `Select` |
| AI 助手侧栏折叠优化 | 已完成 | 折叠态 64 px + `SessionMiniPanel` |
| 设置页拆分/搜索 | 已完成 | `Settings.tsx` 锚点导航 + `SETTINGS_INDEX` |
| Modal 响应式适配 | 已完成 | `index.css` `.ant-modal { max-width: calc(100vw - 32px); }` |
| Dashboard 模块折叠 | 已完成 | `COLLAPSED_BY_DEFAULT` + 持久化 |
| Dashboard/Problems/Lists 骨架屏 | 已完成 | `PageSkeleton` / `CardSkeleton` + `EmptyState` / `InlineError` |
| 题单拖拽撤销提示 | 已完成 | `Lists.tsx` `showUndo()` + 3 秒撤销 |
| 题单键盘排序 | 已完成 | `Lists.tsx` `moveItemBy()` + 上移/下移按钮 |
| Today 错误/空态分离 | 已完成 | `Today.tsx` `PageSkeleton` + `InlineError` + `EmptyState` |
| AI 助手会话键盘排序 | 已完成 | `Assistant.tsx` `handleSessionMove()` + `.reorder-controls`（见 §13） |
| AI 助手会话排序撤销 | 已完成 | `Assistant.tsx` `showSessionUndo()` + `assistantSessionOrder.ts` |

### 12.2 本次增量改动文件

- `client/src/pages/Lists.tsx`：新增题单题目键盘排序、3 秒撤销提示。
- `client/src/pages/Today.tsx`：首屏 `Spin` → `PageSkeleton`；失败与空态分离。
- `client/src/index.css`：新增 `.list-item-reorder` / `.reorder-btn` 样式。
- `docs/UI-Optimization-Plan.md`：本章节。

### 12.3 仍建议继续推进的项

| 优先级 | 任务 | 建议 | 预估工作量 |
|---|---|---|---|
| ~~**P1**~~ | ~~Assistant 会话列表键盘排序~~ | **已完成**，见 §13 | — |
| ~~**P2**~~ | ~~组件库覆盖范围补齐~~ | **已完成**，见 §14 | — |
| ~~**P3**~~ | ~~设置页锚点布局打磨~~ | **已完成**，见 §15.4（≥1280 左侧竖排，几何实测） | — |
| ~~**P4**~~ | ~~响应式断点文档化~~ | **已完成** → [`responsive-breakpoints.md`](./responsive-breakpoints.md) | — |
| ~~**P5**~~ | ~~设置搜索索引维护提醒~~ | **已完成**，见 §15.3（源码级不变量测试） | — |
| ~~**P6**~~ | ~~赛事分类色 Token 化~~ | **前提不成立，已关闭**，见 §15.2 | — |
| ~~**P7**~~ | ~~折叠态迷你会话浮层排序~~ | **已完成**，见 §15.5 | — |
| ~~**P8**~~ | ~~`Mastery` 抽屉错误态~~ | **已完成**，见 §15.1 | — |
| ~~**P9**~~ | ~~antd 弃用告警清理~~ | **已完成**，见 §15.7 的结论与 [`UI-Polish-Plan.md`](./UI-Polish-Plan.md) §8 落地记录 | — |

### 12.4 验证结果

- `npm run typecheck -w client`：通过。
- `npm run lint -w client`：0 错误；11 个 warning 均为既有问题（其他文件的 `exhaustive-deps` / `only-export-components`），本次改动未引入新 warning。
- `npm run build -w client`：构建成功（存在既有 chunk size warning）。

### 12.5 下一步推荐动作

> P1 已落地，见 §13；本节保留当时的推进顺序作为背景。

1. **先补 Assistant 会话列表键盘排序**（P1）：与 Lists 改动对称，风险低，收益明确。→ ✅ 已完成
2. **再批量补齐 Skeleton/Empty/InlineError**（P2）：按页面逐个替换，每页独立提交，便于回滚。
3. **设计稿确认后打磨 Settings 布局**（P3）：涉及较大视觉调整，建议先出简单线框再编码。
4. **文档与维护提醒**（P4/P5）：可在 P2 之后作为收尾。

---

## 13. P1 落地：AI 助手会话列表键盘排序（2026-10-03 增量）

§12.3 的 P1 已实现。至此「可拖拽重排」的四处列表（侧边栏导航、Dashboard 模块卡、题单题目行、AI 会话记录）
**全部**有了键盘替代路径与撤销入口，§6.2 的验收标准不再有缺口。

### 13.1 做了什么

| 能力 | 实现 | 说明 |
|---|---|---|
| 键盘上移/下移 | `Assistant.tsx` `handleSessionMove()` + `.reorder-controls` | 复用全站 `.reorder-host` / `.reorder-controls` / `.reorder-btn` 三件套，hover 或 Tab 聚焦时显现，首尾自动 `disabled` |
| 3 秒撤销 | `Assistant.tsx` `showSessionUndo()` | 固定 message key `assistant-session-order`：连续点上下移时 antd 替换同 key 消息，不会叠成一摞提示 |
| 拖拽也留撤销 | 会话行 `onMouseUp` | 之前拖拽排序没有任何回退入口，现在与键盘路径共用同一条撤销提示 |
| 纯函数化 | `client/src/pages/assistantSessionOrder.ts` | `moveSessionBy()` / `restoreSessionOrder()` / `sessionIdOrder()`，不碰 localStorage 与 React 状态，可单测 |

### 13.2 三个刻意的设计决定

1. **撤销按 id 序列还原，而不是回滚数组引用**。提示有 3 秒窗口，期间用户可能新建或删除会话；
   `restoreSessionOrder()` 只在「id 集合完全一致」时应用，否则返回 `null`，由调用方提示
   「会话列表已变化，无法撤销」—— 比悄悄做半截还原更容易理解。
2. **越界 / id 不存在时返回 `null`，不弹提示**。避免出现「点了没反应却弹出『已调整顺序』」这种反馈失真；
   首尾按钮本来就已经 `disabled`，`null` 分支是给「渲染快照与 store 不一致」的竞态兜底。
3. **不持久化任何排序标志位**。会话顺序本来就是 `sessions` 数组顺序，`setChatState` 的写入会经
   `saveToStorage()` 落到 `icpc-ai-sessions-v1`，所以刷新后顺序保持，无需新增存储字段或迁移。

### 13.3 本次增量改动文件

- `client/src/pages/Assistant.tsx`：会话行新增上移/下移按钮（`.reorder-host` + `.reorder-controls`），
  新增 `moveSession()` / `restoreSessionOrderByIds()`（模块级 store 操作）与 `showSessionUndo()` / `handleSessionMove()`
  （组件级，需要 `message` 实例）；拖拽排序补上撤销入口。
- `client/src/pages/assistantSessionOrder.ts`（新增）：顺序搬运与还原的纯函数。
- `client/test/assistantSessionOrder.test.ts`（新增）：16 条断言，覆盖越界、id 不存在、撤销窗口内增删、重复 id 等边界。
- `docs/UI-Optimization-Plan.md`：本章节。

CSS 未新增：`.reorder-controls` / `.reorder-btn` 是全站共用样式（`index.css` §「键盘排序控件」），
本次只做复用，因此不存在「同一控件两套样式」的漂移风险。

### 13.4 已知边界（不修，记录在案）

- **折叠态迷你会话浮层（`SessionMiniPanel`）没有排序按钮**：它的每一行本身就是 `<button>`
  （整行可点 = 切换会话），HTML 不允许按钮嵌套按钮，加进去会破坏可访问性语义。
  若要排序，需要先把行改成 `<div>` + 行内可聚焦元素，属于结构改造，另立 P7。
- 会话标题重命名（双击）与排序按钮同时可用，双击标题区域不会触发排序 —— 两者命中的是不同元素。

### 13.5 验证结果

- `npm run typecheck -w client`：通过。
- `npm run lint -w client`：0 错误、11 个 warning，与改动前**数量与位置完全一致**
  （唯一涉及 `Assistant.tsx` 的是既有的 `messages` exhaustive-deps 提示，位于 429/958 行，非本次代码）。
- `npm test -w client`：445 个测试全部通过（含本次新增 16 条）。
- `npm run build -w client`：构建成功（既有 chunk size warning）。
- 沙箱备注：本环境默认策略下 `vite build` 会因 Vite 的 Windows realpath 探测（内部 `exec('net use')`）
  被拦而报 `spawn EPERM`，与本次改动无关；`tsx`（esbuild 服务进程）同理。纯函数测试可用
  `node --experimental-strip-types test/assistantSessionOrder.test.ts` 直接跑通作为旁证。

### 13.6 下一步推荐动作

P1 完成后，剩余项里 **P2（Skeleton/Empty/InlineError 覆盖补齐）收益最大但面最广**，
建议按页面拆成独立提交（`Mastery` → `Contests` → `Plans` → `Calendar` → `Templates` → `Reviews` → `Settings`），
每页替换后跑一次 lint，避免一次性大改难以回滚。→ ✅ 已完成，见 §14

---

## 14. P2 落地：组件库覆盖补齐（2026-10-03 增量）

§12.3 的 P2 已实现。至此**有取数或空态的 12 个页面全部**接入 `PageSkeleton` / `CardSkeleton` /
`EmptyState` / `InlineError`（`About` 是纯静态说明页，没有加载态与空态可接）：
不再有「整页居中转圈」的首屏，也不再有任何一处把**请求失败**渲染成**空数据**。

### 14.1 逐页落地对照

| 页面 | 首屏骨架 | 失败态 | 空态给出的下一步 |
|---|---|---|---|
| `Mastery` | `PageSkeleton blocks={4} blockHeight={140}`（保留 stats：真实结构是统计带 + 档位卡） | `InlineError` + 重试 | 「显示未练习（N）」（被默认开关藏住时）/「去题目管理」+「去设置绑定账号」 |
| `Reviews` | `PageSkeleton stats={false} table rows={4}`（仅当一行都没有时） | `InlineError` + 重试（沿用当前筛选） | due：「去题目管理加题」+「查看全部队列」；all：「去题目管理」+「去看今日训练」 |
| `Contests` | `PageSkeleton stats={false} blocks={3} blockHeight={230}` | `InlineError` + 重试（**仅在该页签还没有任何数据时**；有旧列表的刷新失败只出 toast） | 参赛页签：「查看全部平台」/「去设置绑定账号」+「重新加载」；日历页签：清筛选 或「即将开始 ↔ 进行中」互跳 +「重新加载」 |
| `Plans` | `PageSkeleton stats={false} table rows={6}` | `InlineError` + 重试 | 「生成新计划」（直接开新建弹窗） |
| `Calendar` | 当天任务卡 `CardSkeleton variant="list" rows={3}`；月历失败时在日历**上方**插 `InlineError compact` | 天卡 `InlineError compact` + 重试 | 「去训练计划」+「看今日训练」 |
| `Templates` | `PageSkeleton stats={false} blocks={3} blockHeight={220}` | `InlineError` + 重试 | 分类内为空：「新建模板」且**预选当前分类**；清单为空：「重新加载」 |
| `Settings` | `PageSkeleton stats={false} blocks={2} blockHeight={260}` | `InlineError` + 重试（错误态**常驻**，重试按钮 loading） | —（设置页本就没有空态） |

### 14.2 本轮真正修掉的两个缺陷（不是样式问题）

1. **`Settings` 首屏会永远转圈**。旧实现是 `if (!data) return <Spin size="large" />`，而
   `load()` 失败时只弹一条 toast、`data` 永远是 `null` —— 接口挂了或超时，用户看到的是
   一个永不结束的转圈，既没有原因也没有重试入口。现在 `loading` / `loadError` 分开，
   失败给 `InlineError` + 重试。
2. **`Templates` 把失败写成了「模板课程加载失败」的空态**：文案说对了、形态错了 ——
   用的是 `<Empty>`，没有重试按钮，而且它出现在 `!data` 分支里，与「服务端真的返回空清单」
   共用同一个渲染结果。现在失败 → `InlineError`（带重试），空 → `EmptyState`（带「重新加载」）。

`Calendar` 是同类问题的轻量版：`load` 失败只弹 toast，卡片会继续显示**上一次选中日期**的任务，
或落成「当天没有计划任务」这个不实结论；月历取数失败时整月格子会静默全空。

### 14.3 统一约定（后续新增页面照此办理）

**分支顺序**（与 `Today.tsx` 一致）：

```
loading && 屏上还没有数据  →  PageSkeleton / CardSkeleton
loadError                 →  InlineError（message + hint + onRetry）
数据为空                   →  Card > EmptyState（必须至少一个真实可点的 action）
否则                       →  正常内容
```

- **`loading && 屏上还没有数据`**：不能只写 `loading`。像 `Reviews` / `Plans` 这类
  「点一下按钮就重新拉列表」的页面，只判 `loading` 会让整页每点一次闪一次骨架。
  反过来也不能判「只认首次加载」的标志位 —— 失败后点重试时屏上同样是空的，
  只有 `loading && 列表为空` 能保证重试期间不是一片空白。
- **`loadError` 与新请求的关系**：七页里六页在**新一轮取数开始时清掉 `loadError`**。
  理由是 `loadMonth` / `loadDay` / `load(filter)` / `load(tab, platform)` 这类函数
  的入参变了就是在查**另一份数据**，旧错误留着会张冠李戴。
  唯一例外是 `Settings`：它的 `load()` 没有入参、永远是同一个 `/api/settings`，
  所以保留错误态并让重试按钮转圈（这也是全站唯一真正用到 `InlineError#retrying` 的地方）。
  两种收口都是有意为之，不要「顺手统一」成第三种。
- **`hint` 必须写「这块本来该显示什么」**：失败态的价值在于让用户判断影响范围，
  只回显接口报错等于把问题丢回给用户。

### 14.4 明确没改的局部态（有意保留）

| 位置 | 为什么不改 |
|---|---|
| `Lists.tsx` 详情抽屉 `Spin`、`Templates`/`Plans` 的弹窗与 `Table loading` | 局部刷新，页面已有数据；换骨架反而更闪 |
| `Mastery` 抽屉「对应题目」的 `Spin` 与空文案 | 抽屉内局部；它的 `.catch(() => setTagProblems([]))` 仍是「失败伪装成空」，**已登记为 §12.3 P8** |
| `Dashboard` / `Today` 卡片内的 `<Empty>`（如「暂无足够样本」） | 卡片内说明性空态，结论本身就是信息、没有可执行的下一步 |
| `Assistant` 的 `Spin size="small"`（能力值、工具进度） | 局部加载指示 |

### 14.5 本次增量改动文件

- `client/src/pages/Mastery.tsx`、`Reviews.tsx`、`Contests.tsx`、`Plans.tsx`、`Calendar.tsx`、
  `Templates.tsx`、`Settings.tsx`：首屏骨架、`loadError` 分流、`Empty` → `EmptyState`。
- `docs/UI-Optimization-Plan.md`（本章节）、`docs/UI-Optimization-Report.md` §13。
- **没有新增任何 CSS 与组件**：四个组件库组件与 `.empty-state` / `.inline-error` / `.page-skeleton`
  样式都是第二轮就落地的，本轮只是把调用点补齐。

### 14.6 验证结果

- `npm run typecheck -w client`：通过。
- `npm run lint -w client`：0 错误 / **10 个 warning**。基线是 11 条；少的那条是 `Plans.tsx`
  的 `load` 回调补了显式 `eslint-disable-next-line react-hooks/exhaustive-deps`（`message` 来自
  `AntdApp.useApp()`，是稳定实例，注释已说明）。其余 10 条与基线同类同位置，**无新增**。
- `npm test -w client`：445 个测试全部通过。
- `npm run build -w client`：构建成功（既有 chunk size warning）。

### 14.7 下一步推荐动作

P2 完成后，§12.3 里剩下的是 **P3（Settings 锚点布局）、P4（断点文档）、P5（索引维护提醒）、
P6（赛事分类色 Token 化）、P7（迷你会话浮层排序）**，以及本轮新登记的
**P8（Mastery 抽屉的错误态）** —— 五件都是 0.5 天量级、互不依赖，可任意顺序推进。
其中 **P8 是本轮唯一的「同一类缺陷的残留」**，建议优先收掉，避免下一轮审计再翻出来。
→ ✅ P3–P8 已全部完成，见 §15

---

## 15. P3–P8 收尾（2026-10-03 增量）

§12.3 的剩余项一次性清空。本轮除了六项落地，还换来了一个更重要的东西：
**运行时验证能力**（见 §15.6）—— 前面几轮的 UI 改动只能在类型/编译层面确认，
这轮起可以真的把页面跑起来、把状态造出来、把几何量出来。

### 15.1 P8 · `Mastery` 抽屉的失败态

抽屉「对应题目」原来是 `.catch(() => setTagProblems([]))` —— 请求失败直接写成空数组，
于是渲染出「题库里还没有该知识点的题目，去题目管理同步吧」。用户会以为自己真的没题可练。

现在：`tagError` 独立成状态，失败 → `InlineError`（`compact`，带重试）；
空 → `EmptyState`（compact，按钮「去题目管理」）；加载 → `CardSkeleton variant="list"`。
重试靠 `tagRetry` 计数器驱动 effect 重跑（effect 依赖 `active`，重试同一知识点需要额外触发）。

### 15.2 P6 · 「赛事分类色 Token 化」前提不成立，关闭

原判据是「`Contests.tsx` 的 `CATEGORY_COLOR` / `EVIDENCE_TAG` 是硬编码 hex，需映射到主题变量」。
实查结论：**它们不是 hex，是 antd 的预设色名**（`volcano` / `geekblue` / `cyan` …）。这些名字由
`ConfigProvider` 的 `theme.algorithm`（`themeContext.tsx` 按亮/暗切 `defaultAlgorithm` /
`darkAlgorithm`）在运行时解析成**带配对前景色与边框色**的组合，本来就跟随主题。
换成 CSS 变量反而是退化：`Tag` 会只剩一块色底，丢掉配对的前景色。

全仓 hex 扫描的剩余结果只有 `ActivityHeatmap.tsx` 的 `light`/`dark` 两套色阶（有意为之，
见 Report §8）。**结论：不做**，并在 `Contests.tsx` 里加了显式警示注释，避免下一轮审计再翻出来。

### 15.3 P5 · 设置页索引自检（源码级不变量测试）

新增 `client/test/settingsIndex.test.ts`（7 条断言）。为什么不 import `SETTINGS_INDEX`：
它定义在 `Settings.tsx` 内部，而那是组件文件（import 它会拖进 antd/主题/路由），
仓库没有组件测试设施 —— 所以照 `credentialsTable.test.ts` 的做法对源码做结构断言。

钉住的静默失效：① 新增分区却忘了写 `id="settings-xxx"`（导航/搜索点了不滚动，无任何报错）；
② 新增设置项却忘了补 `SETTINGS_INDEX`（搜不到）；③ `sectionId` 拼错/分区改名
（搜索结果里「所属分区」为空）。另有「解析器自身没坏」的哨兵断言，防止测试变成空转。

**验证过它会红**：临时把一条索引的 `label` 改成与另一条重复 → 「索引 label 不重复」用例失败，
改回后 7/7 通过（不是只看绿灯就宣布有效）。

### 15.4 P3 · 设置页宽屏左侧竖排

`≥1280px`：分区导航从「页头下方吸顶横排」换成「左侧 220px 竖排 + 内容右栏」；
`<1280px` 完全保持原样。实现要点：

- 布局差异全在 CSS（`.settings-shell` 在宽屏变 `grid: 220px minmax(0,1fr)`，`align-items: start`
  让左栏保持自然高度、sticky 才有活动空间）。
- 但 **Segmented 的横/竖必须走 JS**（`useMediaQuery(BP.xlUp)`）：它是 antd 的 DOM 结构差异
  （竖排有独立的滑动指示块定位），CSS 强行 `flex-direction: column` 会得到滑块错位的伪竖排。
  DOM 仍只有一份，不产生重复 Tab 停靠点（这正是 §1「什么时候必须用 JS 断点」的判据）。
- 搜索命中浮层在宽屏改为向右展开（220px 的窄栏放不下 320px 的浮层，否则会溢出到页面外）。

**几何实测**（headless Chrome + CDP 量 `getBoundingClientRect`）：

| 视口 | shell | grid 列 | Segmented | 导航 / 内容 |
|---|---|---|---|---|
| 1440×900 | `grid` | `220px 945px` | `vertical: true` | 左（nav.right ≤ body.left） ✓ |
| 1200×900 | `block` | — | 横排 | 上（nav.bottom ≤ body.top） ✓ |

滚动 899px 后：导航 `y` 98 → 12（贴住 `top: 12px`），内容 `y` 98 → −801 ⇒ 左栏确实常驻可见。

### 15.5 P7 · 折叠态迷你会话浮层排序

原先不加排序按钮的硬障碍是：每一行本身就是 `<button>`，而 HTML 不允许按钮嵌套按钮。
本轮把行拆成 `div.mini-session-item.reorder-host`（容器）+ `button.mini-session-btn`
（铺满行的切换点击区）+ `.reorder-controls`（上移/下移）。a11y 上没有退化：
Tab 顺序仍是「切换会话 → 上移 → 下移」，`aria-current` 移到了内层按钮，
浮层靠 `.assistant-mini-rail:focus-within` 显形，所以键盘用户 Tab 进来就能看见并操作排序按钮。
CSS 只改了 `.mini-session-item` 一族（行容器改为纯布局 + 新增 `.mini-session-btn`，
并把浮层内的排序按钮缩到 18px，避免挤压 264px 宽的会话标题）。

### 15.6 本轮新增：运行时验证能力（值得记住）

内置浏览器不可用（Electron 二进制缺失），但**本机 Chrome/Edge 可以 headless 跑**，
于是用「外层 pwsh 拉起 `--remote-debugging-port` + Node 通过 CDP 驱动」的探针
（`.scratch/uiprobe.mjs`，在 gitignore 内，不进仓库）补齐了真实渲染验证。三种模式：

| 模式 | 做法 | 断言 |
|---|---|---|
| `normal` | 正常加载 | 每个路由 0 未捕获异常、不停在整页 Spin、有页头 |
| `fail` | 注入脚本把 `/api/*` 全部 reject | 页面必须出 `InlineError`，**且不得出现空态** |
| `empty` | 只把**指定端点**返回 `[]` | 页面必须出带下一步按钮的 `EmptyState` |

实测结论（13 条路由）：`normal` 全绿（`ex=0`、`bigSpin=0`）；`fail` 下
`/templates /settings /mastery /reviews /contests /plans /calendar` **7/7 全部出 InlineError、
0 空态**（Calendar 为月历 + 当天任务两个错误块）；`empty` 下 `/reviews /plans /contests
/calendar /lists` 5/5 出正确空态（`/problems`、`/today` 的端点返回对象而非数组，
本探针喂 `[]` 会让页面报错 —— 是探针口径问题，不是缺陷）。

**这层验证顺手抓到一个真 bug**：`updateContext.tsx` 启动时探测
`/api/update/progress` 的那次 `get()` 没有 `.catch` —— 后端重启/不可达时，
**每个页面的每次加载**都会产生一条未处理的 rejection（实测 7 个页面的 `ex` 计数全是它）。
`void` 只压住了 lint，压不住 rejection。已补 `.catch(() => undefined)`（失败即「没有待恢复的更新」）。
修完后 `fail` 模式 7 页 `ex` 全部归零。

### 15.7 P9 · 本轮探针发现的 antd 弃用告警（**已修，2026-10-03 收口轮**）

| 位置 | 告警 | 结论 / 处理 |
|---|---|---|
| `Calendar.tsx` | ``[antd: Calendar] `dateFullCellRender` is deprecated`` → 改用 `fullCellRender` | **已改**。`fullCellRender(date, info)` 直接接管整个「日」格子内容，返回结构与旧 API 一致，渲染回归实测 42 格 / 42 圆环 / 76px 高全部不变（`UI-Polish-Plan.md` §8 H1） |
| `Settings.tsx` | ``[antd: InputNumber] `addonAfter` is deprecated`` → 改用 `Space.Compact` | **已改**，6 处统一抽成 `NumberUnitInput`（`Space.Compact` + `disabled` 的 Button 作单位块）。窄屏 600px 实测不挤压数字框、无水平溢出（§8 M3） |
| `Settings.tsx` | `Instance created by 'useForm' is not connected to any Form element` | **根因已定位：不是功能缺陷**（详见下面两条），本轮按根治方案拆组件后告警清零 |

**`useForm` 未连接告警的根因（上一轮曾怀疑是「提交没反应」的真缺陷）**：

1. 设置页首屏 `!data` 时早退渲染骨架（`Settings.tsx:404`），而 `Form.useForm()` 在组件顶部**先于 Form 挂载**执行；
2. `ImportPlanModal`（常驻渲染）内部的 Form 在 Modal 首次打开前不渲染（antd Modal 默认懒渲染）。

两处都只是**数据到达 / 首次打开后即自动连接**的瞬时告警，不伴随任何功能失效。本轮按根治方案处理：
AI 配置表单拆为子组件 `AiSettingsCard`（form 实例与 Form 同生）、导入弹窗加 `forceRender`。
改后 13 路由控制台实测 **0 error / 0 warning**；不再需要「接受一条已知告警」的注释方案。

### 15.8 验证结果

- `npm run typecheck -w client`：通过。
- `npm run lint -w client`：0 错误 / **10 warning**，与上一轮同（无新增）。
- `npm test -w client`：**452 个测试全部通过**（新增 `settingsIndex.test.ts` 的 7 条）。
- `npm run build -w client`：构建成功。
- 运行时：13 条路由 `normal` 全绿；`fail` 7/7 正确分流；`empty` 5/5 正确空态；P3 几何实测通过。

### 15.9 下一步推荐动作

§12.3 的表已清空到只剩 **P9**。收尾建议按此顺序：
**① 定位 `useForm` 未连接告警**（可能是真缺陷）→ ② `Calendar` 改 `fullCellRender` →
③ `Settings` 的 `InputNumber` 改造（要看效果）→ ④ 把那 50 个文件、5 轮改动整理成语义化提交。

---

## 16. 删除设置页的「界面 / 侧边栏导航排序」板块（2026-10-03，按用户要求）

**决定**：设置页不再提供「恢复默认导航排序」入口，「界面」分区整块移除。

### 16.1 为什么可以安全删

该分区里**只有这一项功能**，而它本身是一份**冗余入口**：
`SiderMenu.tsx` 自己就有「恢复默认排序」按钮（`SiderMenu.tsx:251-266`，仅当顺序确实偏离默认、
且侧栏未折叠时出现）。删掉设置页这份不会丢失任何能力 —— 侧边栏的拖拽排序、
键盘上移/下移、以及恢复默认三条路径全部保留。

### 16.2 连带删除的四处（缺一处就会出现「点了没反应」的静默失效）

| 位置 | 内容 | 漏删的后果 |
|---|---|---|
| `<Col id="settings-ui">` 卡片 | 「侧边栏导航排序」+ 恢复按钮 + 说明文字 | 还在页面上，点了会重置顺序 |
| `SETTINGS_SECTIONS` | `{ id: 'settings-ui', label: '界面' }` | 分段导航多一个点不动的死标签 |
| `SETTINGS_INDEX` | 该分区的索引条目（含 `sidebar/排序/reset` 等关键词） | 搜「排序」命中的条目点击后落到不存在的锚点 |
| 组件内状态与 import | `useMenuOrder` / `menuCustomized` / `MENU_GROUPS` / `resetMenuOrder`、`LayoutOutlined` | 未使用 import 直接编译失败 |

> 这次正好是 §15.3 那个守卫测试的第一次实战：分区与索引必须成对增删，它把两边的
> 一致性和「DOM 锚点无孤儿」都钉住了。

### 16.3 验证

- `npm run typecheck -w client`：通过；`npm run lint -w client`：0 错误 / 10 warning（无新增）。
- `npm test -w client`：**452 个测试全部通过**（含 `settingsIndex` 的 7 条：分区与索引成对、锚点无孤儿）。
- `npm run build -w client`：构建成功。
- **运行时实测**（headless Chrome，1440px）：分段导航 = `AI / 账号与平台 / 同步 / 提醒 / 数据`（5 项）；
  `settings-body` 下锚点 = `settings-ai / -accounts / -sync / -reminder / -data`（无 `settings-ui`）；
  页面全文已不含「界面」与「恢复默认导航排序」；`SiderMenu` 的重置入口仍在。

### 16.4 保留未动

- 主题切换（跟随系统 / 亮色 / 暗色）仍在页头右上角 —— 它从来不属于「界面」分区，也未进搜索索引。
- `menuConfig.tsx` 的 order 存储与 `SiderMenu` 的自定义排序能力：本轮只删设置页入口。
  若后续决定「导航顺序不可自定义」，那是一处**更大的删除**（SiderMenu 的拖拽 + 键盘排序 +
  `menuConfig` 的持久化 + 相关测试），需单独确认。

### 16.5 顺手清掉的孤儿导出

`menuConfig.tsx` 的 `hasCustomMenuOrder()` 一并删除：它的唯一用途就是设置页那张卡片里
「恢复默认排序是否可用」的判定（它自己的注释就是这么写的），而卡片内部实际用的是
`useMenuOrder()` 订阅 —— 所以它**在本轮之前就已经没有任何调用方**（全仓 grep 只剩定义本身，
连测试都没有）。留着只会让下一个人以为「还有个读一次就够的入口」。

### 16.6 删除后的搜索行为（已实测）

| 输入 | 结果 |
|---|---|
| 「排序」 | `没有匹配的设置项`（原条目已随分区移除） |
| 「侧边栏」 | `没有匹配的设置项` |
| 「备份」 | 4 条命中，全部归属「数据」分区 —— 搜索功能本身未受影响 |

---

*文档由 UI Designer 专家基于 `client/src` 代码审计与 Ant Design / WCAG 规范制定。*
