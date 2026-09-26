/**
 * markdownBr.ts `<br>` 白名单单元测试。
 * 用 node:test 运行：node --experimental-strip-types test/markdownBr.test.ts
 *
 * 背景：react-markdown 默认把原始 HTML 当纯文本转义（Markdown.tsx 不引入
 * rehype-raw），而 AI 在 GFM 表格单元格里只能用 `<br>` 换行 —— 被转义后就成了
 * 用户看得见的字面 `<br>`（用户反馈：表格里公式旁出现多余的 <br>）。
 * 这里把「整段 raw 只由若干 `<br>` 标签组成」的白名单情形改写成真 br 元素，
 * 其余 HTML 一律不动。每条规则都配正反用例。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { brTagCount, rehypeBrAllowlist } from '../src/components/markdownBr.ts'

/** 构造一个只有 children 的根节点，跑一遍插件，返回处理后的 children */
function transform(children: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const tree = { type: 'root', children }
  rehypeBrAllowlist()(tree as never)
  return tree.children as Array<Record<string, unknown>>
}

const raw = (value: string) => ({ type: 'raw', value })
const text = (value: string) => ({ type: 'text', value })
const isBr = (node: Record<string, unknown>) => {
  if (node.type !== 'element' || node.tagName !== 'br') return false
  const props = node.properties as Record<string, unknown> | undefined
  return !!props && Object.keys(props).length === 0 && Array.isArray(node.children) && node.children.length === 0
}

describe('brTagCount：整段只由 <br> 组成才算数', () => {
  it('单个 <br> 各大小写与变体', () => {
    for (const v of ['<br>', '<br/>', '<br />', '<br >', '<BR>', '<Br/>']) {
      assert.equal(brTagCount(v), 1, v)
    }
  })
  it('多个 <br> 相邻（flow HTML 块会把连续标签合并成一个 raw 节点）', () => {
    assert.equal(brTagCount('<br><br>'), 2)
    assert.equal(brTagCount('<br>\n<br />'), 2)
  })
  it('夹着别的标签/文字就不放行', () => {
    for (const v of ['<b>x</b>', '<br>文字', '文字<br>', '<br class="x">', '<script>y</script>', '<hr>', '']) {
      assert.equal(brTagCount(v), 0, v)
    }
  })
})

describe('rehypeBrAllowlist：白名单内换成真元素，其余原样', () => {
  it('raw `<br>` → br 元素', () => {
    const out = transform([raw('<br>')])
    assert.equal(out.length, 1)
    assert.ok(isBr(out[0]!))
  })
  it('raw `<br><br>` → 两个 br 元素', () => {
    const out = transform([raw('<br><br>')])
    assert.equal(out.length, 2)
    assert.ok(isBr(out[0]!) && isBr(out[1]!))
  })
  it('非 br 的 raw 保持不动（转义是 react-markdown 的事）', () => {
    const node = raw('<b>粗体</b>')
    const out = transform([node])
    assert.equal(out.length, 1)
    assert.equal(out[0], node, '不应被替换或克隆')
  })
  it('带属性的 <br> 不放行', () => {
    const node = raw('<br class="x">')
    const out = transform([node])
    assert.equal(out[0], node)
  })
  it('递归进元素内部：段落里的 <br> 也要换到', () => {
    const p = { type: 'element', tagName: 'p', properties: {}, children: [text('第一行'), raw('<br>'), text('第二行')] }
    const out = transform([p])
    assert.equal(out.length, 1)
    const kids = (out[0] as { children: Array<Record<string, unknown>> }).children
    assert.equal(kids.length, 3)
    assert.ok(isBr(kids[1]!), '段落里的 raw <br> 应换成 br 元素')
  })
})
