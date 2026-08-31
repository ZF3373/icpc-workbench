import CodeMirror from '@uiw/react-codemirror'
import { indentWithTab } from '@codemirror/commands'
import { cpp } from '@codemirror/lang-cpp'
import { markdown as markdownLang } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { useMemo } from 'react'

export type CodeEditorLanguage = 'cpp' | 'markdown'

interface CodeEditorProps {
  /** antd Form.Item 会注入 value/onChange，故为可选 */
  value?: string
  onChange?: (value: string) => void
  language: CodeEditorLanguage
  /** 固定高度（px） */
  height?: number
  placeholder?: string
  maxLength?: number
}

/** 与全局暗色工作台（index.css 设计系统）配套的编辑器外观 */
const appTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: '#d8e0ee', fontSize: '12.5px' },
    '.cm-content': {
      fontFamily: "'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace",
      caretColor: '#86a8ff',
      lineHeight: '1.6',
      // Cascadia Code 默认开编程连字（!= 渲染成 ≠），代码里容易误读，关闭
      fontVariantLigatures: 'none',
      fontFeatureSettings: "'calt' 0, 'liga' 0",
    },
    '.cm-cursor': { borderLeftColor: '#86a8ff' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#5b6472', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(134, 168, 255, 0.06)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(134, 168, 255, 0.08)' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(134, 168, 255, 0.22)',
    },
    '.cm-placeholder': { color: '#5b6472' },
  },
  { dark: true },
)

/** 语法配色：取自应用强调色（雾蓝 / 段位绿 / 琥珀 / 红），评论区压灰 */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7497f5' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#c792ea' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: '#d8e0ee' },
  { tag: [t.function(t.variableName), t.labelName], color: '#86a8ff' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#f2c46d' },
  { tag: [t.definition(t.name), t.separator], color: '#d8e0ee' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace], color: '#5ad4e6' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: '#69d7a5' },
  { tag: [t.meta, t.comment], color: '#8993a2', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.heading], color: '#86a8ff', fontWeight: 'bold' },
  { tag: [t.invalid], color: '#ff7b84' },
])

/** 模板书写编辑器：代码框用 C++ 高亮，思路/大纲用 Markdown 高亮（GFM） */
export default function CodeEditor({
  value,
  onChange,
  language,
  height = 200,
  placeholder,
  maxLength,
}: CodeEditorProps) {
  const extensions = useMemo(
    () => [
      language === 'cpp' ? cpp() : markdownLang(),
      appTheme,
      syntaxHighlighting(highlight),
      keymap.of([indentWithTab]),
      EditorView.lineWrapping,
    ],
    [language],
  )
  return (
    <div className="code-editor">
      <CodeMirror
        value={value ?? ''}
        height={`${height}px`}
        theme={appTheme}
        extensions={extensions}
        basicSetup={{ foldGutter: false, searchKeymap: false, autocompletion: false }}
        placeholder={placeholder}
        onChange={(v) => onChange?.(maxLength ? v.slice(0, maxLength) : v)}
      />
    </div>
  )
}
