import { createContext, useContext } from 'react'

export interface BackgroundSettings { file: string | null; kind: 'image' | 'video' | null; name: string; opacity: number; available: boolean }
interface AppearanceValue {
  settings: BackgroundSettings; busy: boolean; status: string; opacity: number;
  previewOpacity: (value: number) => void; saveOpacity: (value: number) => Promise<void>;
  importFile: (file: File) => Promise<void>; reset: () => Promise<void>;
}
export const AppearanceContext = createContext<AppearanceValue | null>(null)
export function useAppearance() { const value = useContext(AppearanceContext); if (!value) throw new Error('Missing AppearanceProvider'); return value }
