import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { ConfigProvider, App as AntdApp, theme as antdTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'

/**
 * 外观主题管理：
 * - preference: 用户偏好（system / light / dark），持久化到 localStorage
 * - resolved: 实际生效的主题（light / dark），system 时跟随 prefers-color-scheme
 * - 通过 document.documentElement.dataset.theme 驱动 CSS 变量切换
 * - 通过 ConfigProvider algorithm 驱动 antd 组件主题切换
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'icpc-theme'

interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (p: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

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

const sharedTokens = {
  colorPrimary: '#86a8ff',
  colorSuccess: '#69d7a5',
  colorWarning: '#f2c46d',
  colorError: '#ff7b84',
  colorInfo: '#58a3ff',
  borderRadius: 10,
  fontFamily:
    "'Segoe UI Variable Text', 'Segoe UI', 'Inter', system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei UI', sans-serif",
}

const darkTheme = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...sharedTokens,
    colorText: '#f5f7fb',
    colorTextSecondary: '#c4cad4',
    colorTextTertiary: '#8993a2',
    colorBgContainer: '#181b22',
    colorBgElevated: '#1d212a',
    colorBgLayout: '#111318',
    colorBorder: '#2a3039',
    colorBorderSecondary: '#222831',
  },
  components: {
    Layout: { siderBg: '#12151a', headerBg: '#12151a', bodyBg: '#111318' },
    Menu: {
      darkItemBg: 'transparent',
      darkSubMenuItemBg: '#1d212a',
      darkItemSelectedBg: 'rgba(134, 168, 255, 0.13)',
      darkItemHoverBg: '#20242c',
      darkItemSelectedColor: '#86a8ff',
      darkItemColor: '#8b94a3',
      itemBorderRadius: 10,
      itemMarginInline: 10,
      itemMarginBlock: 2,
      itemHeight: 40,
      iconSize: 17,
      activeBarBorderWidth: 0,
    },
    Card: { colorBgContainer: '#181b22', borderRadiusLG: 14 },
    Button: {
      borderRadius: 8,
      primaryShadow: '0 6px 18px rgba(58, 76, 128, 0.28)',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Table: {
      headerBg: '#1b1f27',
      headerColor: '#929ba9',
      rowHoverBg: '#1d222a',
      borderColor: '#222831',
    },
    Modal: { contentBg: '#1d212a', headerBg: '#1d212a', borderRadiusLG: 14 },
    Drawer: { colorBgElevated: '#181b22' },
    Tag: { borderRadiusSM: 6 },
  },
}

// 亮色主题：柔和灰蓝调，避免大面积纯白刺眼
const lightTheme = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    ...sharedTokens,
    colorPrimary: '#6b8eef',
    colorText: '#23272f',
    colorTextSecondary: '#4a5260',
    colorTextTertiary: '#8993a2',
    colorBgBase: '#eef1f6',
    colorBgContainer: '#f6f8fb',
    colorBgElevated: '#fbfcfe',
    colorBgLayout: '#e7ebf1',
    colorBorder: '#d3d9e3',
    colorBorderSecondary: '#e4e8ef',
  },
  components: {
    Layout: { siderBg: '#eef1f6', headerBg: '#eef1f6', bodyBg: '#e7ebf1' },
    Menu: {
      itemBorderRadius: 10,
      itemMarginInline: 10,
      itemMarginBlock: 2,
      itemHeight: 40,
      iconSize: 17,
      activeBarBorderWidth: 0,
    },
    Card: { colorBgContainer: '#f6f8fb', borderRadiusLG: 14 },
    Button: {
      borderRadius: 8,
      primaryShadow: '0 6px 18px rgba(58, 76, 128, 0.18)',
      defaultShadow: 'none',
      dangerShadow: 'none',
    },
    Table: {
      headerBg: '#edf0f5',
      headerColor: '#6c7585',
      rowHoverBg: '#e7ebf2',
      borderColor: '#dde2ea',
    },
    Modal: { contentBg: '#f6f8fb', headerBg: '#f6f8fb', borderRadiusLG: 14 },
    Drawer: { colorBgElevated: '#f6f8fb' },
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

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 <ThemeProvider> 内使用')
  return ctx
}
