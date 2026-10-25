import type {} from './uiTokens'

/**
 * 纯展示层工具的聚合入口（实现按职责拆分在同目录）：
 * - uiTokens.ts：语义色调 Token + 具体色值读取（recharts/SVG 场景）
 * - uiPlatform.ts：平台品牌色 / 平台名 / 训练任务类型
 * - uiFormat.ts：字节 / 难度 / 百分比格式化 + 标签散列色
 *
 * 「颜色从哪来」的唯一约定（UI 优化方案 §6.1 Design Token 治理）：
 * - 所有颜色在 `index.css` 的 `:root`（暗）与 `[data-theme='light']`（亮）里各定义一次；
 * - 页面里**不允许**再写任何 hex / rgba —— 需要 CSS 上下文（inline style、className）时用
 *   `toneVar(tone)` 或直接 `var(--token)`；
 * - 需要**具体色值**时（recharts 把 fill/stroke 写进 SVG 表现属性，`var()` 在其中不生效）
 *   用 `useTokenColors()` 取当前主题的计算值，亮/暗切换会自动重取。
 *
 * 有意保留的硬编码色（属于「数据本身」而非「主题」，不跟随亮暗切换）：
 * - `PLATFORM_COLOR`：各 OJ 的品牌色，换了就不是那个平台了；
 * - `TAG_PALETTE`：知识点标签的散列色板，同一标签必须永远同色（跨主题稳定）。
 */
export * from './uiTokens'
export * from './uiPlatform'
export * from './uiFormat'
