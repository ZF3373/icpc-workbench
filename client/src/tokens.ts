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
  /**
   * 品牌/强调色：亮色主题下是**纯黑**（极简扁平化：黑白高对比度点缀核心功能元素），
   * 暗色主题是**亮紫蓝**（深底上纯黑按钮不可见）。所有用到 colorPrimary 的控件
   * （主按钮、选中态、进度条）都会跟着变成黑/亮紫蓝，不再有第三种强调色。
   * 注意：这个值只用于「当文字/描边读」的场景；当实心按钮底衬白字时要用
   * index.css 的 --brand-fill（同一色相压暗一档，白字才有 5:1）。
   */
  brand: { cssVar: '--brand', dark: '#9aa1ff', light: '#111111' },
  /** 成功（antd colorSuccess ↔ --green）：亮色用低饱和绿，融入白底不抢眼 */
  green: { cssVar: '--green', dark: '#4fd18b', light: '#2f7a58' },
  /** 警告（antd colorWarning ↔ --amber）：亮色降饱和到暖灰，只做辅助提示 */
  amber: { cssVar: '--amber', dark: '#f0c274', light: '#9e5a2a' },
  /** 错误/危险（antd colorError ↔ --red） */
  red: { cssVar: '--red', dark: '#ff8b93', light: '#b0453c' },
  /** 信息（antd colorInfo ↔ --blue）：亮色收敛为中性石墨蓝，避免杂色 */
  blue: { cssVar: '--blue', dark: '#7fb0ff', light: '#1b4a94' },
  /** 正文与层级文本 */
  text: { cssVar: '--text', dark: '#f6f7f9', light: '#111111' },
  text2: { cssVar: '--text-2', dark: '#c6cad2', light: '#3f4247' },
  text3: { cssVar: '--text-3', dark: '#8f949e', light: '#686b70' },
  /** 容器/布局底色（colorBgContainer ↔ --surface；模态暗色抬一档 ↔ --surface-2） */
  surface: { cssVar: '--surface', dark: '#1a1a1d', light: '#ffffff' },
  surface2: { cssVar: '--surface-2', dark: '#212124', light: '#f6f6f7' },
  bg: { cssVar: '--bg', dark: '#0d0d0f', light: '#f4f5f6' },
  /** 描边 */
  line: { cssVar: '--line', dark: '#26262a', light: '#e8e8ea' },
  lineSoft: { cssVar: '--line-soft', dark: '#202024', light: '#f0f0f2' },
  /** 侧栏/顶栏底（Layout siderBg/headerBg、亮色 colorBgBase 同源） */
  siderBg: { cssVar: '--sider-bg', dark: '#17171a', light: '#ffffff' },
  /** 悬停底色（Menu darkItemHoverBg、Table rowHoverBg） */
  hoverBg: { cssVar: '--hover-bg', dark: '#232327', light: '#f2f2f3' },
  /** 主色浅底（Menu darkItemSelectedBg）：亮色 = 极浅中性灰，选中态靠黑字 + 灰底 */
  brandSoft: { cssVar: '--brand-soft', dark: 'rgba(154, 161, 255, 0.14)', light: 'rgba(17, 17, 17, 0.06)' },
} as const satisfies Record<string, TokenPair>

export type TokenPairKey = keyof typeof TOKEN_PAIRS
