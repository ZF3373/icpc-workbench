/**
 * 段内换行 → 真换行（`remark-breaks` 的等价实现，无新依赖）。
 *
 * 背景：AI 回复最常见的排版毛病是「把要点挤成一坨」——同一段里用换行分隔若干条，
 * 但 Markdown 会把段内单个换行渲染成**空格**，于是用户看到一整块密不透风的文字。
 * 开启本插件后，段内换行变成真正的换行，模型即使没写空行，版面也是分行的。
 *
 * 为什么不会拆散块级公式：`remark-math` 是通过 micromark 语法扩展在**解析阶段**
 * 生效的，而 unified 会在 `.parse()` 之前收集全部插件扩展 —— 所以 `$$…$$` 在任何
 * transformer 运行之前就已经是 `math` 节点，本插件看到的只有普通段落文本。
 * 叠加 `math` / `inlineMath` 是叶子节点（内容在 `value` 里、没有 `children`），
 * 两道保险都指向同一结论：**与 remarkMath 的注册顺序无关**（已实测两种顺序的
 * mdast 完全一致）。这里不去依赖顺序，而是显式跳过叶子节点。
 *
 * 不动的节点：`code` / `inlineCode` / `math` / `inlineMath` 都是叶子节点，
 * 本插件只处理有 `children` 的容器，因此代码与公式内容原样保留。
 *
 * 取舍（已知代价）：若模型把**散文**按固定列宽硬折行，开启后会渲染成参差的多行。
 * 提示词里已明确要求「不要按列宽硬折行，段内不要随意换行」，且中文模型普遍不硬折行，
 * 所以本插件默认关闭、只在 AI 生成内容处开启（用户手写的笔记保持 Markdown 原语义）。
 */

/** 与 markdownBr.ts 一致的 mdast 局部视图，避免展开完整联合类型 */
interface MdastLike {
  type: string
  value?: string
  children?: MdastLike[]
}

/** 内容存在 value 里的叶子节点：这些节点不参与换行转换 */
const LEAF_TYPES = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'html', 'yaml', 'toml'])

/**
 * remark 插件：把容器节点文本里的 `\n` 拆成 text + break 节点。
 *
 * 用「重建 children 数组」而不是原地 splice，避免在同一次遍历里既替换又递归时
 * 跳过还没访问到的兄弟节点（与 markdownBr.ts 的 rehypeBrAllowlist 同一手法）。
 */
export function remarkBreaks() {
  const walk = (node: MdastLike): void => {
    const children = node.children
    if (!children) return
    if (LEAF_TYPES.has(node.type)) return

    const next: MdastLike[] = []
    for (const child of children) {
      // 只有纯文本节点里的换行才是「段内换行」；其他节点递归处理
      if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
        const lines = child.value.split('\n')
        lines.forEach((line, i) => {
          // 第一个换行之前不插 break：`a\nb` → text(a) + break + text(b)
          if (i > 0) next.push({ type: 'break' })
          if (line !== '') next.push({ type: 'text', value: line })
        })
        continue
      }
      walk(child)
      next.push(child)
    }
    node.children = next
  }

  return (tree: MdastLike): void => {
    walk(tree)
  }
}
