/**
 * 主题的 Context 对象、类型与消费 hook（Provider 组件见 themeContext.tsx）。
 * 拆成独立文件的原因：react-refresh 要求组件文件只导出组件（热更新不打回子树重挂载）。
 */
import { createContext, useContext } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (p: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 <ThemeProvider> 内使用')
  return ctx
}
