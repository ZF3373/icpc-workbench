/**
 * 细线条线性图标集（极简扁平化重构专用）。
 *
 * 为什么自建而不是继续用 @ant-design/icons：
 * - antd 图标是**面性**（filled）为主、线宽固定 1px 且随字号缩放后描边发虚，
 *   在纯白底 + 黑色强调的极简界面里显得厚重；
 * - 这里统一 24×24 画布、stroke-width 1.5、round 端点/拐角、currentColor 描边，
 *   尺寸只由 font-size / width 控制，描边粗细不随字号变形；
 * - 不引入新依赖：图标是纯内联 SVG 组件，tree-shaking 与 SSR 都无副作用。
 *
 * 约定：
 * - 颜色一律 currentColor —— 调用方用 CSS 的 color 决定黑/灰；
 * - 需要"实心强调"的地方（如选中态圆点）用 <circle fill="currentColor" stroke="none">，
 *   仍然只有一个颜色来源。
 */
import type { CSSProperties, ReactNode, SVGProps } from 'react'

export interface LinearIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** 像素尺寸（宽高一致），默认 16 */
  size?: number
  /** 描边粗细，默认 1.5（细线条风格的关键参数） */
  strokeWidth?: number
  style?: CSSProperties
}

/** 统一外壳：24×24 画布 + 线性描边 + currentColor */
function Svg({ size = 16, strokeWidth = 1.5, children, ...rest }: LinearIconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/* ---------------- 侧边栏导航 ---------------- */

/** 数据概览：四宫格 */
export const IconDashboard = (p: LinearIconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
  </Svg>
)

/** 今日训练：闪电 */
export const IconBolt = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M13 2.8 4.8 13.2h6.1l-.9 8 8.2-10.4h-6.1z" />
  </Svg>
)

/** AI 助手：对话气泡 + 星点 */
export const IconSparkChat = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M20.5 12.4a7.6 7.6 0 0 1-8.1 7.6L7 21.2l1.2-3.6A7.6 7.6 0 1 1 20.5 12.4Z" />
    <path d="M9.6 11.6h.01M12.4 11.6h.01M15.2 11.6h.01" strokeWidth={2.1} />
  </Svg>
)

/** 模板库：代码尖括号 */
export const IconCode = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="m8.6 8.2-4.4 3.8 4.4 3.8M15.4 8.2l4.4 3.8-4.4 3.8M13.4 5.4l-2.8 13.2" />
  </Svg>
)

/** 题单整理：标签 */
export const IconTag = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M11.6 3.4H19a1.6 1.6 0 0 1 1.6 1.6v7.4a2 2 0 0 1-.6 1.4l-7.2 7.2a2 2 0 0 1-2.8 0l-6.4-6.4a2 2 0 0 1 0-2.8l7.2-7.2a2 2 0 0 1 1.4-.6Z" />
    <path d="M16.2 8h.01" strokeWidth={2.1} />
  </Svg>
)

/** 题目管理：文档 + 横线 */
export const IconDocument = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M14 3.2H7.2A2.2 2.2 0 0 0 5 5.4v13.2a2.2 2.2 0 0 0 2.2 2.2h9.6a2.2 2.2 0 0 0 2.2-2.2V8Z" />
    <path d="M14 3.2V8h5M8.6 12.6h6.8M8.6 16.2h4.6" />
  </Svg>
)

/** 掌握度地图：热力方格 */
export const IconGridHeat = (p: LinearIconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7.4" height="7.4" rx="1.8" />
    <rect x="13.1" y="3.5" width="7.4" height="7.4" rx="1.8" />
    <rect x="3.5" y="13.1" width="7.4" height="7.4" rx="1.8" />
    <rect x="13.1" y="13.1" width="7.4" height="7.4" rx="1.8" />
    <path d="M5.4 10.9v2.2M18.6 10.9v2.2" />
  </Svg>
)

/** 训练计划：日历清单 */
export const IconCalendarCheck = (p: LinearIconProps) => (
  <Svg {...p}>
    <rect x="3.4" y="5.2" width="17.2" height="15.4" rx="2.6" />
    <path d="M8 3.4v3.4M16 3.4v3.4M3.4 10h17.2M9 15.2l2.2 2.2 4-4.4" />
  </Svg>
)

/** 日历打卡：日历 + 圆点 */
export const IconCalendar = (p: LinearIconProps) => (
  <Svg {...p}>
    <rect x="3.4" y="5.2" width="17.2" height="15.4" rx="2.6" />
    <path d="M8 3.4v3.4M16 3.4v3.4M3.4 10h17.2" />
    <path d="M12 14.6h.01" strokeWidth={2.4} />
  </Svg>
)

/** 复习库：书本 */
export const IconBook = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M4 5.2A2.2 2.2 0 0 1 6.2 3h4.6A2.2 2.2 0 0 1 13 5.2v15a1.6 1.6 0 0 0-1.6-1.6H6.2A2.2 2.2 0 0 1 4 16.4Z" />
    <path d="M20 5.2A2.2 2.2 0 0 0 17.8 3h-4.6A2.2 2.2 0 0 0 11 5.2v15a1.6 1.6 0 0 1 1.6-1.6h5.2A2.2 2.2 0 0 0 20 16.4Z" />
  </Svg>
)

/** 赛事中心：旗帜 */
export const IconFlag = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M5.6 21V4.2M5.6 4.8h11.2l-1.7 3.6 1.7 3.6H5.6" />
  </Svg>
)

/** 设置：滑块 */
export const IconSliders = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M4 7.4h10.2M18.4 7.4H20M4 16.6h3.6M11.8 16.6H20" />
    <circle cx="16.2" cy="7.4" r="2.2" />
    <circle cx="9.6" cy="16.6" r="2.2" />
  </Svg>
)

/** 关于：信息圆 */
export const IconInfo = (p: LinearIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 11.2v5M12 7.9h.01" strokeWidth={2.1} />
  </Svg>
)

/* ---------------- 顶部操作栏 / 通用控件 ---------------- */

/** 搜索：放大镜 */
export const IconSearch = (p: LinearIconProps) => (
  <Svg {...p}>
    <circle cx="10.8" cy="10.8" r="6.4" />
    <path d="m15.6 15.6 4 4" />
  </Svg>
)

/** 同步：双箭头循环 */
export const IconSync = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M20.2 12a8.2 8.2 0 0 1-14 5.8M3.8 12a8.2 8.2 0 0 1 14-5.8" />
    <path d="M17.8 2.8v3.6h-3.6M6.2 21.2v-3.6h3.6" />
  </Svg>
)

/** 收起侧栏：双箭头左 */
export const IconPanelLeft = (p: LinearIconProps) => (
  <Svg {...p}>
    <rect x="3.4" y="4.2" width="17.2" height="15.6" rx="2.6" />
    <path d="M9.6 4.2v15.6M16.4 9.6 13.6 12l2.8 2.4" />
  </Svg>
)

/** 展开侧栏：双箭头右 */
export const IconPanelRight = (p: LinearIconProps) => (
  <Svg {...p}>
    <rect x="3.4" y="4.2" width="17.2" height="15.6" rx="2.6" />
    <path d="M9.6 4.2v15.6M13.6 9.6 16.4 12l-2.8 2.4" />
  </Svg>
)

/** 上移 */
export const IconArrowUp = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M12 19.2V4.8M6.4 10.4 12 4.8l5.6 5.6" />
  </Svg>
)

/** 下移 */
export const IconArrowDown = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M12 4.8v14.4M6.4 13.6 12 19.2l5.6-5.6" />
  </Svg>
)

/** 折叠模块（向上） */
export const IconChevronUp = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="m6.4 14.6 5.6-5.4 5.6 5.4" />
  </Svg>
)

/** 展开模块（向下） */
export const IconChevronDown = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="m6.4 9.4 5.6 5.4 5.6-5.4" />
  </Svg>
)

/** 右箭头（面包屑/跳转） */
export const IconArrowRight = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M4.8 12h14.4M13.6 6.4 19.2 12l-5.6 5.6" />
  </Svg>
)

/** 撤销 */
export const IconUndo = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M4.2 9.4h9.6a5.6 5.6 0 0 1 0 11.2H8.4" />
    <path d="m8.2 5.2-4 4.2 4 4.2" />
  </Svg>
)

/** 拖拽把手：六点 */
export const IconGrip = (p: LinearIconProps) => (
  <Svg {...p} strokeWidth={0}>
    <g fill="currentColor" stroke="none">
      <circle cx="9.4" cy="7" r="1.15" />
      <circle cx="14.6" cy="7" r="1.15" />
      <circle cx="9.4" cy="12" r="1.15" />
      <circle cx="14.6" cy="12" r="1.15" />
      <circle cx="9.4" cy="17" r="1.15" />
      <circle cx="14.6" cy="17" r="1.15" />
    </g>
  </Svg>
)

/** 提交（右上箭头出框） */
export const IconSend = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M20.4 3.6 10.8 13.2M20.4 3.6l-6.1 17.1-3.5-7.5-7.5-3.5z" />
  </Svg>
)

/** 通过（圆内对勾） */
export const IconCheckCircle = (p: LinearIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="m8.2 12.2 2.6 2.6 5-5.2" />
  </Svg>
)

/** 奖杯 */
export const IconTrophy = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M7.6 4.2h8.8v4.4a4.4 4.4 0 0 1-8.8 0Z" />
    <path d="M7.6 5.6H4.8v1.6a3 3 0 0 0 2.8 3M16.4 5.6h2.8v1.6a3 3 0 0 1-2.8 3M12 13v4.2M8.4 20.2h7.2l-.6-3H9Z" />
  </Svg>
)

/** 雷达/平台分布 */
export const IconRadar = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M12 3.6 20.4 12 12 20.4 3.6 12Z" />
    <path d="M12 7.8 16.2 12 12 16.2 7.8 12Z" />
    <path d="M12 12h.01" strokeWidth={2.1} />
  </Svg>
)

/** 历史记录：时钟 */
export const IconHistory = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M3.8 12a8.2 8.2 0 1 0 2.6-6" />
    <path d="M3.6 3.8v4.6h4.6M12 7.8V12l3 1.8" />
  </Svg>
)

/** 切换账号视角：用户 */
export const IconUser = (p: LinearIconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.2" r="3.8" />
    <path d="M4.8 20.4a7.2 7.2 0 0 1 14.4 0" />
  </Svg>
)

/** 重置/恢复默认：回环箭头 */
export const IconReset = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M4.4 10.4A7.8 7.8 0 1 1 6.8 17" />
    <path d="M4 4.6v5.8h5.8" />
  </Svg>
)

/** 外部链接 */
export const IconExternal = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M13.4 4.2h6.4v6.4M19.8 4.2 11 13" />
    <path d="M18.6 14v4.6a2 2 0 0 1-2 2H5.8a2 2 0 0 1-2-2V7.8a2 2 0 0 1 2-2H10" />
  </Svg>
)

/** 关闭 */
export const IconClose = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
)

/** 更多（横向三点） */
export const IconMore = (p: LinearIconProps) => (
  <Svg {...p} strokeWidth={0}>
    <g fill="currentColor" stroke="none">
      <circle cx="6" cy="12" r="1.35" />
      <circle cx="12" cy="12" r="1.35" />
      <circle cx="18" cy="12" r="1.35" />
    </g>
  </Svg>
)

/** 警告三角（错误态） */
export const IconAlert = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M12 3.9 21.2 20H2.8Z" />
    <path d="M12 9.6v4.4M12 17.1h.01" strokeWidth={2} />
  </Svg>
)

/** 加载中：圆弧（配 .icon-spin 使用） */
export const IconSpinner = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M12 3.6a8.4 8.4 0 1 1-8.4 8.4" />
  </Svg>
)

/** 对勾（无外圈） */
export const IconCheck = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="m5 12.6 4.4 4.4L19 6.8" />
  </Svg>
)

/** 加号 */
export const IconPlus = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M12 5.2v13.6M5.2 12h13.6" />
  </Svg>
)

/** 垃圾桶 / 清空 */
export const IconTrash = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M4.6 6.8h14.8M9.4 6.8V4.6h5.2v2.2M6.6 6.8l.9 12.4a1.6 1.6 0 0 0 1.6 1.4h5.8a1.6 1.6 0 0 0 1.6-1.4l.9-12.4" />
    <path d="M10.4 10.6v6M13.6 10.6v6" />
  </Svg>
)

/** 筛选漏斗 */
export const IconFilter = (p: LinearIconProps) => (
  <Svg {...p}>
    <path d="M3.6 5.4h16.8l-6.6 7.8v6l-3.6 1.8v-7.8Z" />
  </Svg>
)
