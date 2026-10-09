/**
 * markdownMark.ts `==高亮==` 单元测试。
 * 用 node:test 运行：npx tsx --test test/markdownMark.test.ts
 *
 * 三条必须守住的不变量：
 *   1. **相等比较绝不能被当成高亮** —— `a == b`、`if (a == b)`、`cnt == 0`、
 *      `x==y`（无空格）、`dp[i]==dp[j]` 全部原样保留。这是本特性最大的误伤面。
 *   2. **代码区/公式区里的 `==` 是内容** —— 行内代码、围栏、`$a == b$` 里的
 *      相等运算符不能被换成哨兵（否则代码显示成高亮、公式被拆坏）。
 *   3. **哨兵绝不泄漏到用户可见文本** —— 未配对、逆序、code/pre 内、公式内，
 *      任何一条路径都要还原成字面 `==`，绝不能显示 U+E000/U+E001。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MARK_CLOSE,
  MARK_OPEN,
  needsMarkClose,
  rehypeMark,
  replaceMarkDelimiters,
  scanMarkDelimiters,
  stripMarkSentinels,
  stripMarkSentinelsInMath,
} from '../src/components/markdownMark.ts'

/** 把哨兵显示成可读符号，便于断言失败时看清结构 */
const show = (s: string): string => s.split(MARK_OPEN).join('«').split(MARK_CLOSE).join('»')

/** 跑一遍 rehypeMark，返回处理后的 hast 根节点 */
function transform(children: Array<Record<string, unknown>>): Record<string, unknown> {
  const tree = { type: 'root', children }
  rehypeMark()(tree as never)
  return tree
}

const text = (value: string) => ({ type: 'text', value })
const el = (tagName: string, children: Array<Record<string, unknown>>, properties: Record<string, unknown> = {}) => ({
  type: 'element',
  tagName,
  properties,
  children,
})

/** 递归收集树里所有 mark 元素 */
function collectMarks(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = []
  const walk = (n: Record<string, unknown>): void => {
    if (n.tagName === 'mark') found.push(n)
    for (const c of (n.children as Array<Record<string, unknown>>) ?? []) walk(c)
  }
  walk(node)
  return found
}

/** 递归收集所有可见文本（mark 结构之外的内容） */
function allText(node: Record<string, unknown>): string {
  if (node.type === 'text') return String(node.value ?? '')
  return ((node.children as Array<Record<string, unknown>>) ?? []).map(allText).join('')
}

// ---------- 1. 定界符识别：该标的标，不该标的绝不动 ----------

describe('replaceMarkDelimiters：只把真正的高亮定界符换成哨兵', () => {
  it('基本形态与紧贴中文', () => {
    assert.equal(show(replaceMarkDelimiters('==关键结论==')), '«关键结论»')
    assert.equal(show(replaceMarkDelimiters('这题 ==注意边界== ，别写错。')), '这题 «注意边界» ，别写错。')
  })

  it('一行里多组高亮各自配对', () => {
    assert.equal(show(replaceMarkDelimiters('==a== 和 ==b==')), '«a» 和 «b»')
  })

  it('与粗体嵌套（两个方向）', () => {
    assert.equal(show(replaceMarkDelimiters('==**重点**==')), '«**重点**»')
    assert.equal(show(replaceMarkDelimiters('**==重点==**')), '**«重点»**')
  })

  it('高亮里带公式定界符也照样换（公式由管线自己处理）', () => {
    assert.equal(show(replaceMarkDelimiters('==$O(n)$==')), '«$O(n)$»')
  })

  // --- 红线：相等比较 ---
  it('相等比较一律不动（有空格）', () => {
    for (const s of ['a == b 是相等', 'if (a == b)', 'cnt == 0', '当 a == b 时']) {
      assert.equal(replaceMarkDelimiters(s), s, s)
    }
  })

  it('相等比较一律不动（无空格、紧贴词字符）', () => {
    for (const s of ['x==y', 'dp[i]==dp[j]', 'a==b==c', 'n==0']) {
      assert.equal(replaceMarkDelimiters(s), s, s)
    }
  })

  it('开定界符后是空白不算高亮（`== a` 不是重点）', () => {
    assert.equal(replaceMarkDelimiters('== 留空格'), '== 留空格')
  })

  it('闭定界符前是空白不算高亮', () => {
    assert.equal(replaceMarkDelimiters('==重点 =='), '==重点 ==')
  })

  it('`==x==y` 后面紧跟词字符 → 不闭合，整体不动', () => {
    assert.equal(replaceMarkDelimiters('==x==y'), '==x==y')
  })

  it('未闭合的开定界符原样保留（不猜一个不存在的高亮）', () => {
    assert.equal(replaceMarkDelimiters('未闭合 ==一半'), '未闭合 ==一半')
  })

  it('不跨行配对（跨行会产出块级 mark，撑坏排版）', () => {
    const s = '==开头\n结尾=='
    assert.equal(replaceMarkDelimiters(s), s)
  })

  it('没有 `==` 时原样返回（快速路径）', () => {
    const s = '普通文本，没有定界符'
    assert.equal(replaceMarkDelimiters(s), s)
  })
})

// ---------- 2. 代码区 / 公式区里的 `==` 是内容 ----------

describe('skip 回调：代码区与公式区里的 == 不是定界符', () => {
  /** 模拟调用方传入的 skip：下标集合内的字符视为"内容" */
  const skipAt = (indexes: number[]) => {
    const set = new Set(indexes)
    return (i: number) => set.has(i)
  }

  it('被跳过位置的 `==` 不参与配对', () => {
    //                   0123456789
    const line = '==a== x ==b=='
    // 跳过第二组（下标 8、9）→ 只有第一组被替换
    assert.equal(show(replaceMarkDelimiters(line, skipAt([8, 9]))), '«a» x ==b==')
  })

  it('scanMarkDelimiters 只报告未被跳过的定界符', () => {
    const line = '==a== b'
    const all = scanMarkDelimiters(line, 0)
    assert.deepEqual(all.map((e) => e.kind), ['open', 'close'])
    const none = scanMarkDelimiters(line, 0, () => true)
    assert.deepEqual(none, [])
  })

  it('base 偏移被正确计入 at（跨行调用时的下标对得上）', () => {
    const events = scanMarkDelimiters('==a==', 100)
    assert.deepEqual(events, [
      { at: 100, kind: 'open' },
      { at: 103, kind: 'close' },
    ])
  })
})

// ---------- 3. 流式自愈 ----------

describe('needsMarkClose：流式补收尾定界符', () => {
  it('最后一行有未闭合的开定界符 → 需要补', () => {
    assert.equal(needsMarkClose('结论是 ==关键'), true)
  })

  it('已配对 → 不补', () => {
    assert.equal(needsMarkClose('结论是 ==关键=='), false)
  })

  it('没有 `==` → 不补', () => {
    assert.equal(needsMarkClose('普通文本'), false)
  })

  it('相等比较 → 不补（`a == b` 里 `==` 后面是空格，不构成开定界符）', () => {
    assert.equal(needsMarkClose('当 a == b'), false)
    assert.equal(needsMarkClose('x==y'), false)
  })

  it('未闭合的开定界符在更早的行上 → 不补（补了也配不成对，只会多出两个可见 ==）', () => {
    assert.equal(needsMarkClose('==开头\n后续正文'), false)
  })

  it('skip 命中时不补（公式区里的 `==` 是内容）', () => {
    assert.equal(needsMarkClose('$a == b', () => true), false)
  })
})

// ---------- 4. rehype：哨兵 → mark 元素 ----------

describe('rehypeMark：哨兵组装成 mark，且绝不泄漏', () => {
  it('单个高亮 → 一个 mark 元素，文字与 class 正确', () => {
    const tree = transform([text(replaceMarkDelimiters('==关键结论=='))])
    const marks = collectMarks(tree)
    assert.equal(marks.length, 1)
    assert.equal(allText(marks[0]!), '关键结论')
    assert.deepEqual(marks[0]!.properties, { className: ['md-mark'] })
    // 哨兵不残留
    assert.equal(allText(tree).includes(MARK_OPEN), false)
    assert.equal(allText(tree).includes(MARK_CLOSE), false)
  })

  it('一行里两组高亮 → 两个 mark', () => {
    const tree = transform([text(replaceMarkDelimiters('==a== 和 ==b=='))])
    assert.equal(collectMarks(tree).length, 2)
  })

  it('跨兄弟节点配对：哨兵夹着公式元素时，公式被整体包进 mark', () => {
    // 模拟 `==$O(n)$==`：哨兵分处 KaTeX 元素前后
    const tree = transform([
      text(replaceMarkDelimiters('==$O(n)$==')),
    ])
    // 上面的形态里哨兵与公式源码同处一个文本节点；这里再构造"哨兵跨元素"的真实 hast 形态
    const tree2 = transform([
      text(`${MARK_OPEN}复杂度 `),
      el('span', [text('公式')], { className: ['katex'] }),
      text(` 很高${MARK_CLOSE}`),
    ])
    assert.equal(collectMarks(tree).length, 1)
    const marks = collectMarks(tree2)
    assert.equal(marks.length, 1, '跨元素的高亮应被组装成一个 mark')
    assert.equal(allText(marks[0]!), '复杂度 公式 很高', 'mark 应包含中间的公式元素')
    assert.equal(marks[0]!.children!.length, 3)
  })

  it('mark 的 class 就是 md-mark（CSS 钩子唯一来源）', () => {
    const tree = transform([text(`${MARK_OPEN}x${MARK_CLOSE}`)])
    assert.deepEqual(collectMarks(tree)[0]!.properties, { className: ['md-mark'] })
  })

  it('未配对（只有开）→ 降级为字面 ==，不产出 mark', () => {
    const tree = transform([text(`未闭合 ${MARK_OPEN}一半`)])
    assert.equal(collectMarks(tree).length, 0)
    assert.equal(allText(tree), '未闭合 ==一半')
  })

  it('逆序（先闭后开）→ 整体降级为字面 ==，绝不产出永不闭合的 mark', () => {
    const tree = transform([text(`结尾${MARK_CLOSE} 然后 ${MARK_OPEN}开头`)])
    assert.equal(collectMarks(tree).length, 0)
    assert.equal(allText(tree), '结尾== 然后 ==开头')
  })

  it('code 内的哨兵还原成字面 ==（那是代码内容，不该高亮）', () => {
    const tree = transform([
      el('code', [text(`${MARK_OPEN}a == b${MARK_CLOSE}`)]),
    ])
    assert.equal(collectMarks(tree).length, 0)
    assert.equal(allText(tree), '==a == b==')
  })

  it('pre 内的哨兵同样还原（不泄漏私有区字符）', () => {
    const tree = transform([
      el('pre', [el('code', [text(`${MARK_OPEN}if a == b${MARK_CLOSE}`)])]),
    ])
    assert.equal(collectMarks(tree).length, 0)
    assert.equal(allText(tree), '==if a == b==')
  })

  it('嵌套结构里的高亮照样处理（递归进元素内部）', () => {
    const tree = transform([
      el('p', [text('说明：'), text(replaceMarkDelimiters('==重点=='))]),
    ])
    const marks = collectMarks(tree)
    assert.equal(marks.length, 1)
    assert.equal(allText(marks[0]!), '重点')
  })

  it('已配对的 mark 里再嵌套结构（粗体）时结构不塌', () => {
    const tree = transform([
      el('p', [text(`${MARK_OPEN}结论 `), el('strong', [text('很重要')]), text(`${MARK_CLOSE}`)]),
    ])
    const marks = collectMarks(tree)
    assert.equal(marks.length, 1)
    assert.equal(marks[0]!.children!.length, 2, 'mark 里应有文本 + strong 两个子节点')
    assert.equal(marks[0]!.children![1]!.tagName, 'strong')
  })

  it('没有哨兵时不动 children（保持引用，避免无谓重渲染）', () => {
    const kids = [text('普通文本')]
    const tree = transform(kids)
    assert.equal((tree.children as unknown[])[0], kids[0])
  })
})

// ---------- 5. 哨兵防伪造与公式兜底 ----------

describe('哨兵防伪造与公式兜底', () => {
  it('stripMarkSentinels 剔除用户输入里伪造的哨兵', () => {
    assert.equal(stripMarkSentinels(`伪造${MARK_OPEN}高亮${MARK_CLOSE}`), '伪造高亮')
    assert.equal(stripMarkSentinels('普通文本'), '普通文本')
    assert.equal(stripMarkSentinels(`${MARK_OPEN}${MARK_OPEN}`), '')
  })

  it('stripMarkSentinelsInMath 去掉公式内的哨兵（KaTeX 遇私有区字符会解析失败）', () => {
    // 哨兵**落在 `$…$` 内部**：必须剔除，否则 KaTeX 拿到私有区字符直接解析失败
    assert.equal(stripMarkSentinelsInMath(`$x${MARK_OPEN}y${MARK_CLOSE}$`), '$xy$')
    // 哨兵在公式**外面**（`==$O(n)$==` 的正常形态）：必须保留，否则高亮丢了
    assert.equal(
      stripMarkSentinelsInMath(`${MARK_OPEN}$O(n)$${MARK_CLOSE}`),
      `${MARK_OPEN}$O(n)$${MARK_CLOSE}`,
    )
    assert.equal(
      stripMarkSentinelsInMath(`正文 ${MARK_OPEN}重点${MARK_CLOSE} 与 $x$`),
      `正文 ${MARK_OPEN}重点${MARK_CLOSE} 与 $x$`,
    )
  })
})
