/**
 * `<br>` 白名单：把 AI 输出里的裸 `<br>` 标签在 rehype 阶段换成真正的 br 元素。
 *
 * 背景：react-markdown 默认把原始 HTML 当纯文本转义（Markdown.tsx 有意不引入
 * rehype-raw），而 GFM 表格单元格内换行**只有** `<br>` 一种惯用写法 —— 真实换行符
 * 会截断表格行，没有等价的 markdown 替代。于是 AI 一在单元格里换行（这是它的
 * 默认习惯），用户就看见一串字面 `<br>`（用户反馈：公式旁多出 `<br>`）。
 *
 * 为什么必须是 rehype 插件而不是字符串预处理：rehype 阶段能拿到 react-markdown
 * 产出的 raw 节点（它内部以 allowDangerousHtml: true 跑 remark-rehype），且
 * raw → 文本的转义发生在所有 rehype 插件之后 —— 在这里改写就能抢在转义前面；
 * 字符串层把 `<br>` 换成换行符则只会得到软换行（渲染成空格），表格行还会被截断。
 *
 * 安全边界：只放行「整段 raw 由若干个无属性 `<br>` 标签（和空白）组成」的节点，
 * 替换目标是我们自己构造的 `{tagName: 'br', properties: {}, children: []}` ——
 * void 元素、零属性、零子节点，没有任何用户输入流入，注入面为零；其余 HTML
 * （`<b>`、`<img onerror=…>`、`<script>`、带属性的 `<br class=…>`）一律维持
 * react-markdown 原有的转义行为。
 *
 * 行内代码 / 围栏代码块里的 `<br>` 是 code 节点的文本内容，不会成为 raw 节点，
 * 天然保持字面 —— 那是代码内容，本就不该变成换行。
 */

/** 与 Markdown.tsx 一致的 hast 局部视图，避免展开完整联合类型 */
interface HastLike {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastLike[]
}

/** 完整匹配一个无属性 `<br>` 标签（大小写不敏感，容忍 `<br/>` `<br />` `<br >`） */
const BR_TAG = /<br\s*\/?\s*>/gi

/**
 * raw 节点的值若只由若干个 `<br>` 标签（和空白）组成，返回标签个数，否则 0。
 * 连续标签会被 micromark 的 HTML 块规则合并进同一个 raw 节点（如逐行写的
 * `<br>\n<br>`），所以要按"剥光后不剩东西"判定，而不是整串比对。
 */
export function brTagCount(value: string): number {
  const rest = value.replace(BR_TAG, '')
  if (rest.trim() !== '') return 0
  return (value.match(BR_TAG) ?? []).length
}

/** 构造一个 br 元素：void、零属性、零子节点 */
function brElement(): HastLike {
  return { type: 'element', tagName: 'br', properties: {}, children: [] }
}

/**
 * rehype 插件：遍历 hast，把白名单内的 raw `<br>` 节点替换成 br 元素。
 * 用「重建 children 数组」而不是原地改：同一次遍历里既替换又递归，原地 splice
 * 容易把还没访问到的兄弟节点跳过去。
 */
export function rehypeBrAllowlist() {
  const walk = (node: HastLike): void => {
    const children = node.children
    if (!children) return
    const next: HastLike[] = []
    for (const child of children) {
      if (child.type === 'raw') {
        const count = brTagCount(child.value ?? '')
        if (count > 0) {
          for (let i = 0; i < count; i += 1) next.push(brElement())
          continue
        }
      }
      walk(child)
      next.push(child)
    }
    node.children = next
  }
  return (tree: HastLike): void => {
    walk(tree)
  }
}
