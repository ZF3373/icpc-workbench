# UI 优化实施计划

## 📋 项目概览

本项目致力于将现有的硬编码样式系统化为统一的设计Token体系，提升可维护性、无障碍性和用户体验的一致性。

**设计原则**：
- **Token优先**：所有颜色、间距、时长使用语义Token，禁止硬编码
- **WCAG AA达标**：文字对比度 ≥ 4.5:1，UI组件对比度 ≥ 3:1
- **动效统一**：交互过渡使用标准时长档位 + Material Standard曲线
- **主题自适应**：所有Token在亮暗主题下成对声明，自动跟随切换

---

## ✅ 已完成（当前改动）

### 1. 设计Token体系建立
**文件**: `client/src/index.css`, `docs/UI-Design-Tokens.md`

#### 1.1 动效Token系统
- ✅ 新增4档标准时长：
  - `--dur-1: 120ms` - 快速反馈（hover、点击反馈）
  - `--dur-2: 140ms` - 标准过渡（默认选择）
  - `--dur-3: 200ms` - 复杂过渡（多属性同时变化）
  - `--dur-morph: 400ms` - 结构变形（展开/折叠、布局变化）
- ✅ 统一缓动曲线：`--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)`
- ✅ 迁移规则：
  - 130/150/160ms → 归并到最近档位（±20ms不可感知）
  - 450ms → 400ms（结构变形）
  - 关键帧动画保留字面量（骨架呼吸、流光、pageFadeIn）

#### 1.2 语义边框Token应用
- ✅ `.contest-countdown` 边框：`rgba(134,168,255,0.3)` → `var(--brand-line)`
- ✅ `.task-card:hover` 边框：同上
- ✅ `.task-done:hover` 边框：硬编码绿色 → `var(--green-line)`
- ✅ `.indent-switch-option.is-active` 阴影：硬编码蓝色 → `var(--brand-line)`

#### 1.3 同轮可访问性收口（L2：原生 title → Tooltip）
- ✅ 8 个文件约 15 处原生 `title` 换 antd `Tooltip`（键盘聚焦即显示），4 个无标签 icon-only 按钮补 `aria-label`
  （Lists / Plans / Reviews / Templates / Settings / Problems / Assistant / HistoryPanel / SyncProgressHint）。
  注：本小节早期版本误记为「各页面 transition Token 化」——页面 TSX 里的 transition 仅
  `Assistant.tsx` 会话行内联一处（已 Token 化）；其余 TSX 改动是提示形态与可访问名称，不是动效。

#### 1.4 清理冗余代码
- ✅ 删除 `App.css`（`.app` 规则无挂载点，`.mastery-tag` 已迁入index.css）
- ✅ `main.tsx` 移除 `App.css` 引用

---

## 📌 2026-10-24 第二轮实施记录

> 原则：先核实再动手。下述条目凡引用类名/行号的，均先对照过 `index.css` 实况；
> 核实为**虚构或过期**的计划项（阶段1.1/1.2/1.3、阶段2.1 的部分数值、阶段3.1 的前提）直接标注并说明，
> 不按原文盲目实施。

### ✅ 阶段1：动效收口（全部完成）

- **1.1 / 1.2 / 1.3 为虚构条目**：`.task-card.is-collapsed .task-body`、`.problem-item`、
  `.setting-item` 等类名在代码中**不存在**（行号亦不对应），无对应功能可修。
  替代动作：写了「基规则缺 transition 的 :hover 规则」一次性审计脚本，扫全站 58 条 hover 规则，
  甄别后确认 **7 处真实跳变缺口**并补齐（`.platform-link`、`.zoom-trigger`、`.dist-row`、
  `.list-item-row`、`.template-example`、`.today-problem-title`、`.note-tool-btn`，
  全部 `var(--dur-1/2)` + `var(--ease-standard)`）。有意不加的三类（拖拽把手显隐、
  滚动条伪元素、由宿主 transition 覆盖的修饰类）见 `UI-Design-Tokens.md` §5.2。
- **1.4 完成**：无需「50-80 处」——第一轮后 transition 字面量残留即为 0。
  防回归脚本已建：`cd client && npm run check:durations`（白名单仅 `.ant-progress-bg` 0.6s）。

### ✅ 阶段2：对比度（发现问题为真、数值为假，已修复）

- **2.1**：`--link-text` Token 当时**不存在**（计划虚构），但底层问题是真的——
  `.markdown-body a` 用 `var(--brand)`，亮色 `#6b8eef` 在 surface 上实测 **2.69:1**，远低于 AA。
  已修复：新增 `--link-text` 成对声明（暗 `#86a8ff` 与 brand 同值；亮 `#3a5bc0`，
  surface 5.74:1 / surface-2 5.35:1），`.markdown-body a` 改用之。
  表中 `--strong-text` 的「3.38:1」为**过期数值**——前一轮已修至 5.16:1（`#3d5cc8`），
  `check:contrast` 一直在拦。脚本已扩展覆盖链接（暗/亮 × surface/surface-2 四组，全达标）。
- **2.2**：文字类 Token（text/text-2/text-3/mark/strong/link）已全部入脚本；
  组件描边类（`--brand-line` 等）为 3:1 的 UI 组件对比度口径，由 antd token 与 line Token 体系覆盖，
  不再单独建清单。

### ⛔ 阶段3：响应式（不实施，前提错误）

- 「项目未发现系统化的响应式断点定义」**不成立**：`docs/responsive-breakpoints.md` 就是
  断点唯一口径表（640/768/920/992/1024/1200/1280），并明确纪律「不要发明新数字」。
  本节提议的 480/1024/1440/1920 新断点会直接破坏该口径，**拒绝实施**。
- 触控目标：全站排序按钮已按 **WCAG 2.2 AA（24×24）**实测达标（含命中区不重叠断言）；
  44×44（AAA）与本工作台的信息密度定位冲突，维持 AA 口径，不升级。
- 78 组「路由 × 断点」0 水平溢出为前轮实测结论，本轮无新增响应式改动。

### ✅（部分）阶段4：间距系统

- ✅ `--space-1..8`（4/8/12/16/24/32/48/64px，4px 基准）已声明进 `:root` 并写入 Design-Tokens §5.1。
- ⏸ **存量不批量迁移**（有意决策）：数千处 px 等值替换 diff 巨大、用户不可见、回归风险为正。
  纪律：新写/改动的样式从 Token 取值（本轮迁移的 NoteCard 段已按此执行）。

### ✅ 阶段5：样式整合（完成）

- `NoteCard.css`（158 行）、`ContestAnalysis.css`（121 行）已整体迁回 `index.css` 末段
  （独立 css 文件清零），迁移时新增条目按 `--space-*` 取值并补齐缺失的过渡。
- 顺带收口：ContestAnalysis 的游离断点 **600px → 640px**（归并进全站手机断点），
  `responsive-breakpoints.md` §4.5 已记录。

### ⛔ 阶段6：动效体验提升（不实施，与项目取向冲突）

- 涟漪、stagger、模态缩放组合属于「散点装饰动效」，与既有取向（GPU 友好、克制、
  `prefers-reduced-motion` 已处理、动画即冻结机制）相悖；`frontend-design` 纪律同样是
  动效集中于一个签名元素而非铺量。维持现状。
- 6.3 的进度条平滑填充已存在（0.6s 白名单项），无需动。

---

## 🚧 待完成优化项

### 阶段1：完成剩余动效Token化（优先级：高）—— ✅ 已完成（2026-10-24，见上方实施记录：原 1.1–1.3 为虚构条目，替代动作 + 1.4 脚本已落地）

#### 1.1 `.task-card` 系列未迁移项
**位置**: `client/src/index.css:3045-3126`
```css
/* 待修复 */
.task-card {
  transition:
    box-shadow var(--dur-3) var(--ease-standard),  /* ✅ 已完成 */
    border-color var(--dur-3) var(--ease-standard), /* ✅ 已完成 */
    opacity var(--dur-3) var(--ease-standard),      /* ✅ 已完成 */
    transform var(--dur-3) var(--ease-standard);    /* ✅ 已完成 */
}

.task-card.is-collapsed .task-body {
  max-height: 0;
  opacity: 0;
  /* 🔴 需添加动效：transition: max-height var(--dur-morph) var(--ease-standard), 
                              opacity var(--dur-2) var(--ease-standard); */
}
```

#### 1.2 题目列表交互动效
**位置**: `client/src/index.css:2680-2850`（Problems页）
```css
/* 示例待修复项 */
.problem-item:hover {
  background: var(--hover-bg);
  /* 🔴 需添加：transition: background var(--dur-1) var(--ease-standard); */
}

.problem-tag {
  /* 🔴 需检查：hover时的颜色过渡是否Token化 */
}

.difficulty-badge {
  /* 🔴 需检查：难度标记的动效统一性 */
}
```

#### 1.3 设置面板交互
**位置**: `client/src/index.css:2950-3020`（Settings页）
```css
.setting-item:hover {
  /* 🔴 需添加hover过渡动效 */
}

.toggle-switch {
  /* 🔴 需统一开关切换动效为 var(--dur-2) */
}
```

#### 1.4 全局搜索残留硬编码时长
**方法**:
```bash
cd client/src
# 查找所有transition中的硬编码时长
grep -rn "transition.*[0-9]\+ms" --include="*.css" --include="*.tsx" --include="*.ts" .
# 查找animation中的硬编码（排除@keyframes内部）
grep -rn "animation:.*[0-9.]\+s" --include="*.css" . | grep -v "@keyframes"
```

**预估工作量**: 50-80处修改点，2-3小时

---

### 阶段2：颜色对比度修复（优先级：高）—— ✅ 已完成（2026-10-24：链接对比度为真实缺陷已修复；`--strong-text` 数值系过期信息）

#### 2.1 Markdown强调文本对比度不达标
**问题**: `docs/UI-Design-Tokens.md` 已记录两处不符合WCAG AA标准的Token

| Token | 用途 | 当前问题 | 目标对比度 |
|-------|------|----------|-----------|
| `--link-text` | Markdown链接 | 亮色主题 `#6e8df0` 对比度仅 **3.13:1** | ≥ 4.5:1 |
| `--strong-text` | `**粗体**` | 亮色主题 `#5a7de0` 对比度仅 **3.38:1** | ≥ 4.5:1 |

**修复方案**:
```css
/* client/src/index.css - 亮色主题段 */
[data-theme='light'] {
  /* 原值 */
  --link-text: #6e8df0;      /* 对比度 3.13:1 ❌ */
  --strong-text: #5a7de0;    /* 对比度 3.38:1 ❌ */
  
  /* 修复后（加深饱和度） */
  --link-text: #4a6bcf;      /* 预估对比度 4.6:1 ✅ */
  --strong-text: #3f5cc0;    /* 预估对比度 4.7:1 ✅ */
}
```

**验证**:
```bash
cd client
npm run check:contrast
```

#### 2.2 UI组件对比度审计
**待检查项**:
- [ ] 按钮边框对比度（`--brand-line` / `--green-line`）≥ 3:1
- [ ] 输入框边框对比度 ≥ 3:1
- [ ] 标签/徽章文字对比度 ≥ 4.5:1
- [ ] 次要文字（`--text-2`）对比度 ≥ 4.5:1
- [ ] 禁用状态元素对比度 ≥ 3:1

**工具辅助**:
```bash
# 使用现有的对比度检查脚本
cd client
npm run check:contrast

# 手动检查可疑Token（提取颜色值后用在线工具验证）
grep -E "(--text-|--brand-|--green-)" src/index.css
```

---

### 阶段3：响应式布局优化（优先级：中）—— ⛔ 不实施（前提错误：断点口径早已系统化，见 docs/responsive-breakpoints.md）

#### 3.1 移动端适配审计
**当前状态**: 项目未发现系统化的响应式断点定义

**建议新增断点Token**:
```css
/* client/src/index.css - 在:root段添加 */
:root {
  /* 响应式断点（媒体查询直接引用，不用 var()） */
  --screen-xs: 480px;   /* 手机竖屏 */
  --screen-sm: 768px;   /* 平板竖屏 */
  --screen-md: 1024px;  /* 平板横屏 / 小笔记本 */
  --screen-lg: 1440px;  /* 标准桌面 */
  --screen-xl: 1920px;  /* 大屏 */
}
```

**待审计页面**:
- [ ] `Assistant.tsx` - 对话界面在窄屏下的布局
- [ ] `Lists.tsx` - 列表项在移动端的堆叠方式
- [ ] `Plans.tsx` - 计划卡片的响应式网格
- [ ] `Problems.tsx` - 题目列表的触控友好性
- [ ] `HistoryPanel.tsx` - 侧边栏在窄屏下的表现

**测试方法**:
```bash
# 使用浏览器DevTools测试以下视口
# - 375x667 (iPhone SE)
# - 390x844 (iPhone 14)
# - 768x1024 (iPad竖屏)
# - 1024x768 (iPad横屏)
```

#### 3.2 触控目标尺寸检查
**WCAG 2.1 Level AAA标准**: 触控目标 ≥ 44x44px

**待检查组件**:
- [ ] 按钮最小尺寸
- [ ] 复选框/单选框点击区域
- [ ] 标签云中的标签
- [ ] 下拉菜单选项
- [ ] 导航链接

---

### 阶段4：间距系统标准化（优先级：中）—— ✅ Token 尺度已建立；⏸ 存量批量迁移有意不做（收益为负）

#### 4.1 当前间距Token梳理
**位置**: `client/src/index.css`

需从现有代码中提取并标准化为8px基准的间距阶梯:
```css
:root {
  --space-1: 4px;    /* 超紧凑（内联元素间隙）*/
  --space-2: 8px;    /* 紧凑（表单标签与输入框） */
  --space-3: 12px;   /* 标准内边距 */
  --space-4: 16px;   /* 组件间距 */
  --space-5: 24px;   /* 卡片内边距 */
  --space-6: 32px;   /* 区块间距 */
  --space-8: 48px;   /* 页面级间距 */
  --space-10: 64px;  /* 大区块分割 */
}
```

#### 4.2 迁移策略
1. **统计现有硬编码间距**:
```bash
grep -rn "padding:\|margin:" client/src --include="*.css" | \
  grep -oE "[0-9]+px" | sort | uniq -c | sort -rn
```

2. **优先迁移高频值** (如 `8px`, `12px`, `16px`, `24px`)
3. **特殊值归档** (如 `5px` 的微调保持字面量，注释说明原因)

---

### 阶段5：组件样式整合（优先级：低）—— ✅ 已完成（2026-10-24，独立 css 文件清零）

#### 5.1 历史遗留独立CSS文件迁移
**当前状态**: 文档提到两个历史遗留文件
- `NoteCard.css` - 待确认是否存在
- `ContestAnalysis.css` - 待确认是否存在

**迁移原则**:
- 改动这些组件时，**优先将样式迁回 `index.css`**
- 按组件类型归类到对应段落（如 `.note-card { ... }` 归入卡片类组件段）
- 删除独立CSS文件及其引用

#### 5.2 内联样式审计
**查找方法**:
```bash
cd client/src
grep -rn 'style={{' --include="*.tsx" . | wc -l
```

**迁移标准**:
- 静态样式 → 提取到 `index.css` 作为CSS类
- 动态样式（依赖props/state）→ 保留，但颜色/间距必须用Token
  ```tsx
  // ❌ 错误
  <div style={{ color: '#6e8df0', padding: '12px' }} />
  
  // ✅ 正确
  <div style={{ color: 'var(--link-text)', padding: 'var(--space-3)' }} />
  ```

---

### 阶段6：动效体验提升（优先级：低）—— ⛔ 不实施（散点装饰动效与项目克制取向冲突；进度条平滑已存在）

#### 6.1 加载骨架屏优化
**当前状态**: 文档提到"骨架呼吸"动画保留字面量

**优化方向**:
- [ ] 统一骨架屏组件样式
- [ ] 添加渐进式加载动画
- [ ] 确保骨架屏与实际内容布局匹配（避免CLS）

#### 6.2 页面切换动效
**当前状态**: 存在 `pageFadeIn 0.35s` 动画

**待实现**:
- [ ] 路由切换时的淡入淡出
- [ ] 列表项的交错进入动画（stagger effect）
- [ ] 模态框的缩放+淡入组合动效

#### 6.3 微交互细节
- [ ] 按钮点击的涟漪效果（Material Design风格）
- [ ] 复选框勾选动画
- [ ] 成功/错误提示的滑入动画
- [ ] 进度条的流畅填充（已存在 `.ant-progress-bg` 的0.6s过渡，需验证体验）

---

## 🛠️ 实施工具与流程

### 自动化检查脚本
```bash
# 1. 对比度检查（已有）
cd client && npm run check:contrast

# 2. 硬编码时长检查（需新增）
cd client && npm run check:hardcoded-durations

# 3. 内联样式审计（需新增）
cd client && npm run check:inline-styles
```

### Git Commit规范
```
feat(ui): 完成XX组件的动效Token化

- 迁移12处transition为var(--dur-*)
- 统一缓动曲线为var(--ease-standard)
- 修复.task-card的折叠动效缺失

Ref: docs/UI-优化实施计划.md 阶段1.1
```

### PR审查清单
- [ ] 新增/修改的样式100%使用Token（无硬编码颜色/时长/间距）
- [ ] 对比度检查脚本通过
- [ ] 在亮暗两种主题下均测试通过
- [ ] 移动端视口测试通过（至少375px和768px）
- [ ] 动效在60fps下流畅运行（Chrome DevTools Performance面板验证）

---

## 📊 进度追踪

> 2026-10-24 更新：原表按「计划条目数」统计，但其中若干条目经核实为虚构/前提错误，
> 已改为按实际状态记录（详见上方第二轮实施记录）。

| 阶段 | 状态 | 说明 |
|------|------|------|
| 阶段1：动效Token化 | ✅ 完成 | 全站 transition 100% Token 化 + 7 处 hover 补口 + `check:durations` 防回归 |
| 阶段2：对比度修复 | ✅ 完成 | 亮色链接 2.69:1 → 5.35~5.74:1；`check:contrast` 扩展至链接 |
| 阶段3：响应式优化 | ⛔ 不实施 | 断点口径已系统化；24×24 命中区已达标；新断点提议破坏口径 |
| 阶段4：间距标准化 | ✅ 尺度建立 / ⏸ 存量不迁移 | `--space-1..8` 入 :root；批量替换收益为负 |
| 阶段5：样式整合 | ✅ 完成 | NoteCard / ContestAnalysis 迁回，独立 css 清零；600→640 归并 |
| 阶段6：动效提升 | ⛔ 不实施 | 与克制取向冲突 |

---

## 🎯 里程碑目标

### M1：核心体验达标（2周）
- ✅ 动效Token系统建立
- ⏳ 完成80%动效迁移
- ⏳ 修复所有WCAG AA不达标项
- ⏳ 移动端基础适配（375px-768px可用）

### M2：系统化完善（4周）
- ⏳ 间距系统全面落地
- ⏳ 组件样式100%集中管理
- ⏳ 响应式布局全面优化
- ⏳ 建立自动化检查流程

### M3：体验精进（6周）
- ⏳ 动效体验细节打磨
- ⏳ 性能优化（FPS/CLS指标）
- ⏳ 暗色主题细节校准
- ⏳ 形成完整的设计系统文档

---

## 📚 参考资料

- [WCAG 2.1 对比度标准](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html)
- [Material Design Motion](https://m3.material.io/styles/motion/overview)
- [8点网格系统](https://builttoadapt.io/intro-to-the-8-point-grid-system-d2573cde8632)
- 项目内文档：`docs/UI-Design-Tokens.md`

---

**文档版本**: v1.1（2026-10-24 第二轮实施收口：各阶段状态已核实标注，虚构条目已更正）  
**最后更新**: 2026-10-24  
**维护者**: UI优化工作组
