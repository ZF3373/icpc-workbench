import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ConfigProvider, App as AntdApp, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { TOKEN_PAIRS } from './tokens.ts'
import { ThemeContext, type ThemeContextValue, type ThemePreference, type ResolvedTheme } from './themeCore'

/**
 * 外观主题管理：
 * - preference: 用户偏好（system / light / dark），持久化到 localStorage
 * - resolved: 实际生效的主题（light / dark），system 时跟随 prefers-color-scheme
 * - 通过 document.documentElement.dataset.theme 驱动 CSS 变量切换
 * - 通过 ConfigProvider algorithm 驱动 antd 组件主题切换
 */

const STORAGE_KEY = 'icpc-theme'

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function getStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'system' || raw === 'light' || raw === 'dark') return raw
  } catch {
    // 隐私模式或无 localStorage
  }
  return 'system'
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? getSystemTheme() : pref
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved
}

// ---------- antd 主题配置 ----------
// 色值一律取自 tokens.ts 的配对表（与 index.css 同源，check:tokens 守护）；
// 这里只保留无 CSS 对应物的 antd 专有微调（表格表头、投影等）。

const FONT_FAMILY =
  "'Inter', 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei UI', sans-serif"

/** 两套主题共用的 antd 基础 Token（主题相关色不进来，各自从配对表取） */
const sharedTokens = {
  borderRadius: 10,
  fontFamily: FONT_FAMILY,
}

// 暗色主题：极简现代扁平化 —— 深灰/纯黑底 + 亮紫蓝主色，零投影零渐变。
// 层次靠 --bg(#0d0d0f) → --sider-bg(#141416) → --surface(#1a1a1d) → --surface-2(#212124)
// 四级底色差承担；卡片边框在 CSS 侧是 transparent（见 index.css 的 --card-border）。
const darkTheme = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...sharedTokens,
    colorPrimary: TOKEN_PAIRS.brand.dark,
    colorPrimaryHover: '#b3b8ff',
    colorPrimaryActive: '#8389f0',
    colorSuccess: TOKEN_PAIRS.green.dark,
    colorWarning: TOKEN_PAIRS.amber.dark,
    colorError: TOKEN_PAIRS.red.dark,
    colorInfo: TOKEN_PAIRS.blue.dark,
    colorText: TOKEN_PAIRS.text.dark,
    colorTextSecondary: TOKEN_PAIRS.text2.dark,
    colorTextTertiary: TOKEN_PAIRS.text3.dark,
    colorBgBase: TOKEN_PAIRS.bg.dark,
    colorBgContainer: TOKEN_PAIRS.surface.dark,
    colorBgElevated: TOKEN_PAIRS.surface2.dark,
    colorBgLayout: TOKEN_PAIRS.bg.dark,
    colorBorder: TOKEN_PAIRS.line.dark,
    colorBorderSecondary: TOKEN_PAIRS.lineSoft.dark,
    // 扁平化：antd 自带的浮层投影全部关掉，层次只靠底色差
    boxShadow: 'none',
    boxShadowSecondary: 'none',
    boxShadowTertiary: 'none',
    borderRadius: 12,
    borderRadiusLG: 16,
    borderRadiusSM: 8,
    controlHeight: 34,
    wireframe: false,
  },
  components: {
    Layout: {
      siderBg: TOKEN_PAIRS.siderBg.dark,
      headerBg: TOKEN_PAIRS.siderBg.dark,
      bodyBg: TOKEN_PAIRS.bg.dark,
    },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: TOKEN_PAIRS.surface2.dark,
      darkItemSelectedBg: TOKEN_PAIRS.brandSoft.dark,
      darkItemHoverBg: TOKEN_PAIRS.hoverBg.dark,
      darkItemSelectedColor: TOKEN_PAIRS.brand.dark,
      darkItemColor: TOKEN_PAIRS.text3.dark,
      itemBorderRadius: 12,
      itemMarginInline: 10,
      itemMarginBlock: 2,
      itemHeight: 40,
      iconSize: 17,
      activeBarBorderWidth: 0,
    },
    Card: {
      colorBgContainer: TOKEN_PAIRS.surface.dark,
      borderRadiusLG: 18,
      headerBg: 'transparent',
      headerFontSize: 14,
      paddingLG: 24,
    },
    Button: {
      borderRadius: 10,
      borderRadiusSM: 8,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      defaultBorderColor: TOKEN_PAIRS.line.dark,
    },
    Input: { borderRadius: 10, activeShadow: 'none', paddingBlock: 6 },
    Select: { borderRadius: 10, optionSelectedBg: '#2a2a2e' },
    Segmented: { borderRadius: 10, itemSelectedBg: '#2f2f35', trackBg: TOKEN_PAIRS.surface2.dark },
    Table: {
      headerBg: TOKEN_PAIRS.surface2.dark,
      headerColor: TOKEN_PAIRS.text3.dark,
      rowHoverBg: TOKEN_PAIRS.hoverBg.dark,
      borderColor: TOKEN_PAIRS.line.dark,
      headerBorderRadius: 12,
    },
    Modal: {
      contentBg: TOKEN_PAIRS.surface.dark,
      headerBg: TOKEN_PAIRS.surface.dark,
      borderRadiusLG: 20,
    },
    Drawer: { colorBgElevated: TOKEN_PAIRS.surface.dark },
    Tag: { borderRadiusSM: 8, defaultBg: TOKEN_PAIRS.surface2.dark, defaultColor: TOKEN_PAIRS.text2.dark },
    Tooltip: { borderRadius: 10, colorBgSpotlight: '#2a2a2e' },
    Dropdown: { borderRadiusLG: 14 },
  },
}

// 亮色主题：极简现代扁平化 —— 纯白卡片 + 浅灰白内容底，纯黑主色，零投影零渐变。
// 语义色（成功/警告/错误/信息）与 CSS 侧同源——此前 antd 一直是暗色粉彩值，
// 与已按亮色底校准的 --green/--amber/--red/--blue 漂移（见 tokens.ts 头注）。
const lightTheme = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    ...sharedTokens,
    colorPrimary: TOKEN_PAIRS.brand.light,
    colorPrimaryHover: '#2b2b2b',
    colorPrimaryActive: '#000000',
    colorSuccess: TOKEN_PAIRS.green.light,
    colorWarning: TOKEN_PAIRS.amber.light,
    colorError: TOKEN_PAIRS.red.light,
    colorInfo: TOKEN_PAIRS.blue.light,
    colorText: TOKEN_PAIRS.text.light,
    colorTextSecondary: TOKEN_PAIRS.text2.light,
    colorTextTertiary: TOKEN_PAIRS.text3.light,
    colorBgBase: '#ffffff',
    colorBgContainer: TOKEN_PAIRS.surface.light,
    colorBgElevated: '#ffffff',
    colorBgLayout: TOKEN_PAIRS.bg.light,
    colorBorder: TOKEN_PAIRS.line.light,
    colorBorderSecondary: TOKEN_PAIRS.lineSoft.light,
    // 扁平化：antd 自带的浮层投影全部关掉，层次只靠 1px 描边
    boxShadow: 'none',
    boxShadowSecondary: 'none',
    boxShadowTertiary: 'none',
    borderRadius: 12,
    borderRadiusLG: 16,
    borderRadiusSM: 8,
    controlHeight: 34,
    wireframe: false,
  },
  components: {
    Layout: {
      siderBg: TOKEN_PAIRS.siderBg.light,
      headerBg: TOKEN_PAIRS.siderBg.light,
      bodyBg: TOKEN_PAIRS.bg.light,
    },
    Menu: {
      itemBorderRadius: 12,
      itemMarginInline: 10,
      itemMarginBlock: 2,
      itemHeight: 40,
      iconSize: 17,
      activeBarBorderWidth: 0,
    },
    Card: {
      colorBgContainer: TOKEN_PAIRS.surface.light,
      borderRadiusLG: 18,
      headerBg: 'transparent',
      headerFontSize: 14,
      paddingLG: 24,
    },
    Button: {
      borderRadius: 10,
      borderRadiusSM: 8,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
      defaultBorderColor: TOKEN_PAIRS.line.light,
    },
    Input: { borderRadius: 10, activeShadow: 'none', paddingBlock: 6 },
    Select: { borderRadius: 10, optionSelectedBg: '#f2f2f3' },
    Segmented: { borderRadius: 10, itemSelectedBg: '#ffffff', trackBg: '#f2f2f3' },
    Table: {
      headerBg: TOKEN_PAIRS.surface2.light,
      headerColor: '#6b6e73',
      rowHoverBg: TOKEN_PAIRS.hoverBg.light,
      borderColor: TOKEN_PAIRS.line.light,
      headerBorderRadius: 12,
    },
    Modal: {
      contentBg: TOKEN_PAIRS.surface.light,
      headerBg: TOKEN_PAIRS.surface.light,
      borderRadiusLG: 20,
    },
    Drawer: { colorBgElevated: TOKEN_PAIRS.surface.light },
    Tag: { borderRadiusSM: 8, defaultBg: '#f4f4f5', defaultColor: '#3f4247' },
    Tooltip: { borderRadius: 10, colorBgSpotlight: '#111111' },
    Dropdown: { borderRadiusLG: 14 },
  },
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(getStoredPreference)
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(getStoredPreference()))

  // 应用主题到 DOM
  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  // 偏好变化时重新解析
  useEffect(() => {
    setResolved(resolveTheme(preference))
  }, [preference])

  // system 模式下监听系统主题变化
  useEffect(() => {
    if (preference !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => setResolved(getSystemTheme())
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [preference])

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, p)
    } catch {
      // 隐私模式写入失败忽略
    }
    setPreferenceState(p)
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  )

  const antdThemeConfig = resolved === 'dark' ? darkTheme : lightTheme

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider locale={zhCN} theme={antdThemeConfig}>
        <AntdApp>{children}</AntdApp>
      </ConfigProvider>
    </ThemeContext.Provider>
  )
}
