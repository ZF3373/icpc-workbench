# 复习笔记全屏三栏的字号缩放（issue #62）

issue #62：「复习笔记区的 2，3 模块希望字体放大，或者增加调节功能」，配图是全屏三栏写作的截图。
作者随后在评论里补充：「目前的放大是只要 1 版块的笔记查看的能放大」。

## 判断

缩放入口本身一直是有的 —— 全屏顶栏的 `ZoomControl`（「笔记文字」50%–200%，
Ctrl+滚轮 / 加减按钮，独立持久化）。缺的是**作用范围**：

`--note-text-zoom` 只作用在被打了 `data-note-zoom` 锚点的元素上，而全屏三栏里只有

- 01「实时预览」的滚动区；
- 02「写作上下文」里**模板大纲**那一个渲染块（`reference`，只有模板库传）

挂了锚点。于是：

- 02 栏的复习节奏（`context`）、标签（`meta`）与「写作提示」不缩放；
- 03「MD 写作」的 CodeMirror 编辑器完全不缩放 —— 它的字号写死在
  `CodeEditor.tsx` 的 `EditorView.theme` 里（12.5px），根本不读 CSS 变量。

这正是「只有 1 版块能放大」：用户看到顶栏百分数在涨，2、3 两栏纹丝不动。

## 改动

三栏读的是同一篇笔记，字号理应同进同退，所以把 02 / 03 两栏纳入同一个缩放系数：

- `NoteWriterModal.tsx`：02 栏的滚动区（`.note-writer-side-scroll`）统一挂
  `data-note-zoom`，原来打在模板大纲块上的那个锚点随之去掉（同一栏不应有两套作用域）；
  03 栏给 `NoteEditor` 包一层 `.note-writer-pane-editor` 并挂 `data-note-zoom`。
- `index.css`：02 栏各块按自身基准字号乘 `--note-text-zoom`；03 栏用
  `[data-note-zoom] .cm-editor` 覆盖 CodeMirror 主题里写死的 12.5px —— 主题选择器是
  CodeMirror 运行时生成的随机类名（`.cm-xxxx`，单个类），两个类的后代选择器就能稳定压过，
  不需要 `!important`，也不必改 `CodeEditor`（模板库等共用）。行号栏一并缩放。
- `noteWriterView.ts`：新增 `NOTE_WRITER_ZOOM_PANES` 记录「三栏都在缩放作用域内」这条事实。
- `noteWriterView.test.ts`：新增 3 项 —— 三栏锚点齐全、02 栏各块真的乘了缩放系数、
  栏头（01/02/03 标题与字数）不参与缩放。

基准字号全部沿用原值（11 / 11.5 / 12 / 12.5px），100% 时排版与改动前一致。
缩放作用于**正文**：栏头、栏号、字数与顶栏控件都不跟着变大，与卡片态
「缩放读长笔记的正文，而不是整张 UI」同一口径。

## 验证

- `tsc` 双端 exit 0；`oxlint` 0 error（1 个先前已存在的 `useMemo` 依赖 warning）
- `npm test -w client` 672/672、`npm test -w server` 全绿
- headless Chrome 实测（真实 CodeMirror 实例，非 mock）：
  - 03 栏编辑器 12.5px → 140% 时 17.5px → 200% 时 25px，行高 20 / 28 / 40px 同步；
  - 02 栏各块 11 / 11.5 / 11.5 / 12 / 11.5px → 140% 时 15.4 / 16.1 / 16.1 / 16.8 / 16.1px；
  - 栏头 `.note-writer-pane-title` 在 140% 下仍为 12px（不参与缩放）。

## 已知局限（未在本次修复范围内）

CodeMirror 的行高是**异步测量 + 只测可见区域**（`measureVisibleLineHeights`），
快速连续跳档时滚动条总长可能短暂停在上一档，滚到底再滚回来即自愈。
这个问题在字号完全不变时也能复现（对照实验：全程 100%、只重建编辑器，仍会出现偏差），
属于 CodeMirror 虚拟滚动的既有行为，与本次改动无关，故不做处理。
