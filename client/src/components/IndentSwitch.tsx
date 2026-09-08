import { INDENT_OPTIONS, setIndentSize, useIndentSize, type IndentSize } from '../editorSettings'

/**
 * 缩进空格数选择器（模板库页头）。
 * 自绘 segmented 而非 antd Segmented：暗色主题下选中态用品牌蓝实色填充 + 深色文字，一眼可辨。
 * 状态来自 editorSettings（localStorage），切换即时生效，模板库的 CodeEditor 自动跟随。
 */
export default function IndentSwitch() {
  const indentSize = useIndentSize()
  return (
    <div className="indent-switch" role="group" aria-label="缩进空格数">
      <span className="indent-switch-label">缩进</span>
      <div className="indent-switch-track">
        {INDENT_OPTIONS.map((n) => {
          const active = n === indentSize
          return (
            <button
              key={n}
              type="button"
              className={'indent-switch-option' + (active ? ' is-active' : '')}
              onClick={() => setIndentSize(n as IndentSize)}
              aria-pressed={active}
            >
              {n} 空格
            </button>
          )
        })}
      </div>
    </div>
  )
}
