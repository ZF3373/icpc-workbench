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
  return 'dark'
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

const darkTheme = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...sharedTokens,
    colorPrimary: TOKEN_PAIRS.brand.dark,
    colorSuccess: TOKEN_PAIRS.green.dark,
    colorWarning: TOKEN_PAIRS.amber.dark,
    colorError: TOKEN_PAIRS.red.dark,
    colorInfo: TOKEN_PAIRS.blue.dark,
    colorText: TOKEN_PAIRS.text.dark,
    colorTextSecondary: TOKEN_PAIRS.text2.dark,
    colorTextTertiary: TOKEN_PAIRS.text3.dark,
    colorBgContainer: TOKEN_PAIRS.surface.dark,
    colorBgElevated: TOKEN_PAIRS.surface2.dark,
    colorBgLayout: TOKEN_PAIRS.bg.dark,
    colorBorder: TOKEN_PAIRS.line.dark,
    colorBorderSecondary: TOKEN_PAIRS.lineSoft.dark,
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
      darkItemColor: '#8b94a3',
      itemBorderRadius: 10,
      itemMarginInline: 10,
      itemMarginBlock: 2,
      itemHeight: 40,
      iconSize: 17,
      activeBarBorderWidth: 0,
    },
    Card: { colorBgContainer: TOKEN_PAIRS.surface.dark, borderRadiusLG: 14 },
    Button: {
      borderRadius: 8,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Table: {
      headerBg: '#1b1f27',
      headerColor: '#929ba9',
      rowHoverBg: '#1d222a',
      borderColor: TOKEN_PAIRS.lineSoft.dark,
    },
    Modal: {
      contentBg: TOKEN_PAIRS.surface2.dark,
      headerBg: TOKEN_PAIRS.surface2.dark,
      borderRadiusLG: 14,
    },
    Drawer: { colorBgElevated: TOKEN_PAIRS.surface.dark },
    Tag: { borderRadiusSM: 6 },
  },
}

// 亮色主题：柔和灰蓝调，避免大面积纯白刺眼。
// 语义色（成功/警告/错误/信息）与 CSS 侧同源——此前 antd 一直是暗色粉彩值，
// 与已按亮色底校准的 --green/--amber/--red/--blue 漂移（见 tokens.ts 头注）。
const lightTheme = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    ...sharedTokens,
    colorPrimary: TOKEN_PAIRS.brand.light,
    colorSuccess: TOKEN_PAIRS.green.light,
    colorWarning: TOKEN_PAIRS.amber.light,
    colorError: TOKEN_PAIRS.red.light,
    colorInfo: TOKEN_PAIRS.blue.light,
    colorText: TOKEN_PAIRS.text.light,
    colorTextSecondary: TOKEN_PAIRS.text2.light,
    colorTextTertiary: TOKEN_PAIRS.text3.light,
    colorBgBase: TOKEN_PAIRS.siderBg.light,
    colorBgContainer: TOKEN_PAIRS.surface.light,
    colorBgElevated: '#fbfcfe',
    colorBgLayout: TOKEN_PAIRS.bg.light,
    colorBorder: TOKEN_PAIRS.line.light,
    colorBorderSecondary: TOKEN_PAIRS.lineSoft.light,
  },
  components: {
    Layout: {
      siderBg: TOKEN_PAIRS.siderBg.light,
      headerBg: TOKEN_PAIRS.siderBg.light,
      bodyBg: TOKEN_PAIRS.bg.light,
    },
    Menu: {
      itemBorderRadius: 10,
      itemMarginInline: 10,
      itemMarginBlock: 2,
      itemHeight: 40,
      iconSize: 17,
      activeBarBorderWidth: 0,
    },
    Card: { colorBgContainer: TOKEN_PAIRS.surface.light, borderRadiusLG: 14 },
    Button: {
      borderRadius: 8,
      primaryShadow: 'none',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Table: {
      headerBg: TOKEN_PAIRS.surface2.light,
      headerColor: '#6c7585',
      rowHoverBg: TOKEN_PAIRS.hoverBg.light,
      borderColor: '#dde2ea',
    },
    Modal: {
      contentBg: TOKEN_PAIRS.surface.light,
      headerBg: TOKEN_PAIRS.surface.light,
      borderRadiusLG: 14,
    },
    Drawer: { colorBgElevated: TOKEN_PAIRS.surface.light },
    Tag: { borderRadiusSM: 6 },
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
