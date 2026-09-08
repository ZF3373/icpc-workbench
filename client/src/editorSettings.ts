/**
 * 代码编辑器缩进偏好（纯 localStorage，无后端）。
 * 设置页写入，CodeEditor 通过 useIndentSize 订阅，同标签页即时生效、跨标签页经 storage 事件同步。
 */
import { useSyncExternalStore } from 'react'

export const INDENT_KEY = 'editor.indentSize'
/** 同标签页内写入后广播的自定义事件（storage 事件不在同标签页触发） */
const CHANGE_EVENT = 'editor-indent-change'

/** 可选缩进：2 或 4 */
export const INDENT_OPTIONS = [2, 4] as const
export type IndentSize = (typeof INDENT_OPTIONS)[number]
export const DEFAULT_INDENT: IndentSize = 2

/** 把任意输入归一为合法缩进：仅 4 返回 4，其余回退默认 2（容忍 localStorage 的字符串值） */
export function normalizeIndent(raw: unknown): IndentSize {
  const n = Number(raw)
  return n === 4 ? 4 : 2
}

/** 当前缩进：localStorage 优先，非法或缺失回退默认 2 */
export function getIndentSize(): IndentSize {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(INDENT_KEY)
  } catch {
    // 隐私模式或无 localStorage 环境：回退默认
  }
  return normalizeIndent(raw)
}

/** 写入缩进并广播变更（同标签页立即生效；跨标签页由 storage 事件处理） */
export function setIndentSize(size: IndentSize): void {
  try {
    localStorage.setItem(INDENT_KEY, String(size))
  } catch {
    // 忽略隐私模式写入失败
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
}

function subscribe(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onChange = () => cb()
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** React hook：订阅缩进设置变更，返回当前缩进（2 或 4） */
export function useIndentSize(): IndentSize {
  return useSyncExternalStore(subscribe, getIndentSize, () => DEFAULT_INDENT)
}
