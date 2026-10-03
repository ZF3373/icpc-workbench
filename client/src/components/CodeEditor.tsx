import CodeMirror from '@uiw/react-codemirror'
import { indentWithTab } from '@codemirror/commands'
import { cpp } from '@codemirror/lang-cpp'
import { markdown as markdownLang } from '@codemirror/lang-markdown'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { EditorView, keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import { useMemo } from 'react'
import { useIndentSize } from '../editorSettings'

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
  /** 只读模式：隐藏光标、禁用编辑，用于代码展示 */
  readOnly?: boolean
  /** 编辑器创建后的回调：拿到 EditorView 引用（NoteEditor 工具栏插入语法用） */
  onCreateEditor?: (view: EditorView) => void
  /** 额外扩展（粘贴/拖拽图片等 DOM 事件处理）：调用方用 useMemo/ref 保持引用稳定 */
  extraExtensions?: Extension[]
}

/**
 * 编辑器外观：颜色全部走 index.css 设计系统的 --code-* 变量，
 * 亮/暗主题由 [data-theme] 切换变量值，无需重新挂载编辑器。
 */
const appTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--code-text)', fontSize: '12.5px' },
    '.cm-content': {
      fontFamily: "'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace",
      caretColor: 'var(--brand)',
      lineHeight: '1.6',
      // Cascadia Code 默认开编程连字（!= 渲染成 ≠），代码里容易误读，关闭
      fontVariantLigatures: 'none',
      fontFeatureSettings: "'calt' 0, 'liga' 0",
    },
    '.cm-cursor': { borderLeftColor: 'var(--brand)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--code-gutter)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--overlay-1)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--overlay-2)' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--brand-soft)',
    },
    '.cm-placeholder': { color: 'var(--text-3)' },
  },
  { dark: true },
)

/** 语法配色：变量值随主题切换（暗色雾蓝系 / 亮色深调系），标签分组不变 */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--code-keyword)' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: 'var(--code-control)' },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: 'var(--code-text)' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--code-func)' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: 'var(--code-const)' },
  { tag: [t.definition(t.name), t.separator], color: 'var(--code-text)' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace], color: 'var(--code-type)' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.link, t.special(t.string)], color: 'var(--code-operator)' },
  { tag: [t.meta, t.comment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.heading], color: 'var(--code-func)', fontWeight: 'bold' },
  { tag: [t.invalid], color: 'var(--code-invalid)' },
])

/** 模板书写编辑器：代码框用 C++ 高亮，思路/大纲用 Markdown 高亮（GFM） */
export default function CodeEditor({
  value,
  onChange,
  language,
  height = 200,
  placeholder,
  maxLength,
  readOnly = false,
  onCreateEditor,
  extraExtensions,
}: CodeEditorProps) {
  const indentSize = useIndentSize()
  const extensions = useMemo(
    () => [
      language === 'cpp' ? cpp() : markdownLang(),
      // 缩进偏好来自设置页（2/4 空格）；indentWithTab 与自动缩进均读取此 facet
      indentUnit.of(' '.repeat(indentSize)),
      appTheme,
      syntaxHighlighting(highlight),
      ...(extraExtensions ?? []),
      ...(readOnly
        ? [
            EditorView.editable.of(false),
            // 只读展示：彻底隐藏光标、活动行高亮、活动行号高亮，
            // 让代码块像静态展示而非可交互编辑器
            EditorView.theme({
              '&': { caretColor: 'transparent' },
              '.cm-cursor': { display: 'none' },
              '.cm-activeLine': { backgroundColor: 'transparent' },
              '.cm-activeLineGutter': { backgroundColor: 'transparent' },
            }),
          ]
        : [keymap.of([indentWithTab])]),
      EditorView.lineWrapping,
    ],
    [language, indentSize, readOnly, extraExtensions],
  )
  return (
    <div className="code-editor">
      <CodeMirror
        value={value ?? ''}
        height={`${height}px`}
        theme={appTheme}
        extensions={extensions}
        onCreateEditor={(view) => onCreateEditor?.(view)}
        basicSetup={{
          foldGutter: false,
          searchKeymap: false,
          autocompletion: false,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
        }}
        placeholder={placeholder}
        editable={!readOnly}
        readOnly={readOnly}
        onChange={(v) => onChange?.(maxLength ? v.slice(0, maxLength) : v)}
      />
    </div>
  )
}
