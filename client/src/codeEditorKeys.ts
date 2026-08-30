import type { KeyboardEvent } from 'react'

/**
 * 代码编辑用 TextArea 的按键行为（模拟编辑器习惯）：
 * - Tab：插入缩进（多行选区则整块缩进）
 * - Shift+Tab：反缩进（多行选区整块反缩进）
 * - Enter：继承当前行缩进；行尾是 { ( [ 时额外加一层缩进
 * 未命中这些键时返回 false，保持浏览器默认行为。
 */

const INDENT = '    ' // 4 空格

export function codeEditorKeys(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  // 中文等输入法组词过程中的 Enter/Tab 不拦截
  if (e.nativeEvent.isComposing) return false
  const el = e.currentTarget
  if (e.key === 'Tab') {
    e.preventDefault()
    if (e.shiftKey) dedent(el)
    else indent(el)
    return true
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return autoIndent(el) !== null
  }
  return false
}

function indent(el: HTMLTextAreaElement): void {
  const { value, selectionStart, selectionEnd } = el
  if (selectionStart === selectionEnd) {
    insert(el, INDENT)
    return
  }
  // 多行选区：每行前加一层缩进，替换后保持选区覆盖整块
  const start = value.lastIndexOf('\n', selectionStart - 1) + 1
  const end = selectionEnd === selectionStart ? selectionEnd : value.indexOf('\n', selectionEnd) === -1 ? value.length : value.indexOf('\n', selectionEnd)
  const block = value
    .slice(start, end)
    .split('\n')
    .map((l) => (l.trim() ? INDENT + l : l))
    .join('\n')
  replace(el, start, end, block, start, start + block.length)
}

function dedent(el: HTMLTextAreaElement): void {
  const { value, selectionStart, selectionEnd } = el
  const start = value.lastIndexOf('\n', selectionStart - 1) + 1
  const endIdx = value.indexOf('\n', selectionEnd)
  const end = selectionStart === selectionEnd ? selectionEnd : endIdx === -1 ? value.length : endIdx
  const block = value.slice(start, end)
  // 每行去掉一层缩进：一个 tab 或最多 4 个空格（空行不动）
  const stripped = block
    .split('\n')
    .map((l) => {
      const m = /^(?:\t| {1,4})/.exec(l)
      return m ? l.slice(m[0].length) : l
    })
    .join('\n')
  if (stripped === block) return
  replace(el, start, end, stripped, start, start + stripped.length)
}

function autoIndent(el: HTMLTextAreaElement): string | null {
  const { value, selectionStart, selectionEnd } = el
  if (selectionStart !== selectionEnd) return null // 有选区保留默认（替换选区后换行）
  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
  const line = value.slice(lineStart, selectionStart)
  const indent = /^[ \t]*/.exec(line)![0]
  // 行尾是 { ( [ 时进一层；纯 `}` 前（如 "}" 单独成行的上一行结尾）回退一层
  const extra = /[{([]\s*$/.test(line) ? INDENT : ''
  const dedentAfterClose = indent && /^\s*\}/.test(value.slice(selectionStart)) ? INDENT : ''
  const finalIndent = indent.slice(0, Math.max(0, indent.length - dedentAfterClose.length)) + extra
  if (!finalIndent) return null
  insert(el, '\n' + finalIndent)
  return '\n' + finalIndent
}

/** 在光标处插入文本（保留原生撤销栈；替换当前选区），光标落在插入内容之后。 */
function insert(el: HTMLTextAreaElement, text: string): void {
  const { selectionStart, selectionEnd } = el
  replace(el, selectionStart, selectionEnd, text, selectionStart + text.length, selectionStart + text.length)
}

/** 替换 [from,to) 为 text 并把选区设为 [cursorStart,cursorEnd)，同时让 React/antd 感知变更。 */
function replace(el: HTMLTextAreaElement, from: number, to: number, text: string, cursorStart: number, cursorEnd: number): void {
  el.focus()
  el.setSelectionRange(from, to)
  // execCommand 走编辑器管线：原生触发 input（React onChange 正常同步）且保留 Ctrl+Z 撤销栈
  let ok = false
  try {
    ok = document.execCommand('insertText', false, text)
  } catch {
    ok = false
  }
  if (!ok) {
    if (el.setRangeText) {
      el.setRangeText(text, from, to, 'end')
    } else {
      // 极旧内核兜底
      el.value = el.value.slice(0, from) + text + el.value.slice(to)
    }
    // 派生原生 input 事件，触发 React 的 onChange（受控组件状态同步）
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  el.setSelectionRange(cursorStart, cursorEnd)
}
