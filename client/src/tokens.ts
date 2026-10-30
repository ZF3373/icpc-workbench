/**
 * antd 主题色值 ↔ index.css CSS 变量的配对表：ts 侧唯一来源。
 *
 * 为什么需要它：antd Token 走 ConfigProvider、页面样式走 CSS 变量，两套实现天然
 * 双源——历史上已经漂移过（亮色 antd 语义色长期是暗色粉彩值，而 CSS 侧早按亮色底
 * 校准过）。themeContext 从这里取值，test/tokenCheck.mjs（check:tokens）逐项比对
 * 本表与 index.css 的 :root / [data-theme='light']，改色只改一处会被拦下。
 *
 * 注意：
 * - 配对值必须逐字符一致（含 rgba 空格、大小写）；亮色块未覆盖的变量按 CSS 级联
 *   继承 :root 值，本表 light 侧同样写 :root 的值。
 * - antd 专有微调值（Table 表头色、按钮投影等，无 CSS 对应物）不进本表，
 *   留在 themeContext 以字面量维护。
 */
export interface TokenPair {
  /** index.css 中对应的 CSS 变量名（check:tokens 按它取值比对） */
  cssVar: string
  dark: string
  light: string
}

export const TOKEN_PAIRS = {
  /** 品牌主色 */
  brand: { cssVar: '--brand', dark: '#45b8c8', light: '#177c68' },
  /** 成功（antd colorSuccess ↔ --green） */
  green: { cssVar: '--green', dark: '#68bba1', light: '#188960' },
  /** 警告（antd colorWarning ↔ --amber） */
  amber: { cssVar: '--amber', dark: '#f1cb79', light: '#b8781b' },
  /** 错误/危险（antd colorError ↔ --red） */
  red: { cssVar: '--red', dark: '#ff7b84', light: '#e5505a' },
  /** 信息（antd colorInfo ↔ --blue） */
  blue: { cssVar: '--blue', dark: '#58a3ff', light: '#2f6fb5' },
  /** 正文与层级文本 */
  text: { cssVar: '--text', dark: '#ecedef', light: '#212b2a' },
  text2: { cssVar: '--text-2', dark: '#c5c6ca', light: '#334541' },
  text3: { cssVar: '--text-3', dark: '#929397', light: '#667572' },
  /** 容器/布局底色（colorBgContainer ↔ --surface；模态暗色抬一档 ↔ --surface-2） */
  surface: { cssVar: '--surface', dark: '#19191b', light: '#fff' },
  surface2: { cssVar: '--surface-2', dark: '#202125', light: '#eaece9' },
  bg: { cssVar: '--bg', dark: '#090a0b', light: '#f5f5f2' },
  /** 描边 */
  line: { cssVar: '--line', dark: '#303135', light: '#d5dbd7' },
  lineSoft: { cssVar: '--line-soft', dark: '#26272b', light: '#e6eae7' },
  /** 侧栏/顶栏底（Layout siderBg/headerBg、亮色 colorBgBase 同源） */
  siderBg: { cssVar: '--sider-bg', dark: '#090a0b', light: '#f5f5f2' },
  /** 悬停底色（Menu darkItemHoverBg、Table rowHoverBg） */
  hoverBg: { cssVar: '--hover-bg', dark: '#242529', light: '#e1e8e3' },
  /** 主色浅底（Menu darkItemSelectedBg） */
  brandSoft: { cssVar: '--brand-soft', dark: '#45b8c818', light: '#177c6815' },
} as const satisfies Record<string, TokenPair>

export type TokenPairKey = keyof typeof TOKEN_PAIRS
