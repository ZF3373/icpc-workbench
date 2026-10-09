/**
 * markdownBreaks.ts 段内换行单元测试。
 * 用 node:test 运行：npx tsx --test test/markdownBreaks.test.ts
 *
 * 核心不变量：
 *   1. 文本节点里的 `\n` → text + break + text（段内换行渲染成真换行）；
 *   2. **叶子节点不参与** —— code / inlineCode / math / inlineMath 的内容存在
 *      `value` 里，改了就会破坏代码与公式（这是本插件最容易踩的坑）；
 *   3. 换行在文本节点**中间**时结构正确（不丢首尾片段、不产出空文本节点）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { remarkBreaks } from '../src/components/markdownBreaks.ts'

/** 跑一遍插件，返回处理后的树 */
function run(tree: Record<string, unknown>): Record<string, unknown> {
  remarkBreaks()(tree as never)
  return tree
}

const p = (children: Array<Record<string, unknown>>) => ({
  type: 'paragraph',
  children,
})
const text = (value: string) => ({ type: 'text', value })
const types = (node: Record<string, unknown>) =>
  ((node.children as Array<Record<string, unknown>>) ?? []).map((c) => c.type)

describe('remarkBreaks：段内换行 → break 节点', () => {
  it('单个换行 → text + break + text', () => {
    const tree = run(p([text('第一行\n第二行')]))
    assert.deepEqual(types(tree), ['text', 'break', 'text'])
    assert.equal((tree.children as Array<{ value?: string }>)[0]!.value, '第一行')
    assert.equal((tree.children as Array<{ value?: string }>)[2]!.value, '第二行')
  })

  it('多个换行 → 相应数量的 break', () => {
    const tree = run(p([text('a\nb\nc')]))
    assert.deepEqual(types(tree), ['text', 'break', 'text', 'break', 'text'])
  })

  it('换行在文本节点中间时首尾片段都不丢', () => {
    const tree = run(p([text('开头\n中间')]))
    assert.deepEqual(types(tree), ['text', 'break', 'text'])
    const kids = tree.children as Array<{ value?: string }>
    assert.equal(kids[0]!.value, '开头')
    assert.equal(kids[2]!.value, '中间')
  })

  it('文本以换行结尾时不产出空文本节点', () => {
    const tree = run(p([text('a\n')]))
    assert.deepEqual(types(tree), ['text', 'break'])
  })

  it('文本以换行开头时不产出空文本节点', () => {
    const tree = run(p([text('\na')]))
    assert.deepEqual(types(tree), ['break', 'text'])
  })

  it('没有换行的文本节点原样保留（保持引用，避免无谓重渲染）', () => {
    const node = text('普通文本')
    const tree = run(p([node]))
    assert.equal((tree.children as unknown[])[0], node)
  })

  it('文本节点之间的换行（兄弟节点情形）不误伤', () => {
    const tree = run(p([text('无换行'), text('也无换行')]))
    assert.deepEqual(types(tree), ['text', 'text'])
  })

  // --- 红线：叶子节点不参与 ---
  it('inlineCode 的内容不被拆（`a\\nb` 是代码内容）', () => {
    const node = { type: 'inlineCode', value: 'a\nb' }
    const tree = run(p([node]))
    assert.equal((tree.children as unknown[])[0], node, 'inlineCode 不应被改写')
    assert.equal((node as { value: string }).value, 'a\nb', '代码内容必须原样')
  })

  it('code 块的内容不被拆（多行代码是常态，拆了就废）', () => {
    const node = { type: 'code', value: 'int main() {\n  return 0;\n}', lang: 'cpp' }
    const tree = run({ type: 'root', children: [node] })
    assert.equal((tree.children as unknown[])[0], node)
    assert.equal((node as { value: string }).value, 'int main() {\n  return 0;\n}')
  })

  it('math / inlineMath 的内容不被拆（公式跨行是合法写法）', () => {
    for (const type of ['math', 'inlineMath']) {
      const node = { type, value: 'a\n+ b' }
      const tree = run({ type: 'root', children: [node] })
      assert.equal((tree.children as unknown[])[0], node, `${type} 不应被改写`)
      assert.equal((node as { value: string }).value, 'a\n+ b', `${type} 内容必须原样`)
    }
  })

  it('html / yaml / toml 也不参与（避免改坏原始块）', () => {
    for (const type of ['html', 'yaml', 'toml']) {
      const node = { type, value: 'x\ny' }
      const tree = run({ type: 'root', children: [node] })
      assert.equal((tree.children as unknown[])[0], node, `${type} 不应被改写`)
    }
  })

  // --- 递归 ---
  it('递归进嵌套结构（列表项里的换行也处理）', () => {
    const item = { type: 'listItem', children: [p([text('a\nb')])] }
    run({ type: 'list', children: [item] })
    const inner = ((item.children as Array<Record<string, unknown>>)[0]!.children) as Array<Record<string, unknown>>
    assert.deepEqual(inner.map((c) => c.type), ['text', 'break', 'text'])
  })

  it('叶子节点内部的 children 不存在时安全跳过（不抛错）', () => {
    assert.doesNotThrow(() => run({ type: 'root' }))
    assert.doesNotThrow(() => run({ type: 'root', children: [] }))
  })
})
