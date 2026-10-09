/**
 * markdownStream.ts 流式未闭合容错单元测试。
 * 用 node:test 运行：node --experimental-strip-types test/markdownStream.test.ts
 *
 * 用例全部来自「流式输出每一帧都是半成品」这一真实场景：AI 逐字吐字时，
 * 消息末尾随时可能停在 `**加粗`、`` `dp_{i-1} ``、`$$` 公式的中间。
 * 每条规则都配正反用例 —— 补不补、以及**决定不补**的情况（金额 `$5`、
 * 乘法 `2 * 3`、列表标记 `* item`、snake_case `push_back`）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { repairStreamingMarkdown, findStableBlockSplit } from '../src/components/markdownStream.ts'
import { preprocessMath } from '../src/components/markdownMath.ts'

/** 断言"补了收尾"：期望结果等于原文 + 后缀 */
function assertAppends(input: string, suffix: string): void {
  const out = repairStreamingMarkdown(input)
  assert.equal(out, input + suffix, `期望补 ${JSON.stringify(suffix)}，实际: ${JSON.stringify(out)}`)
}

/** 断言"不动"：原文原样返回 */
function assertUnchanged(input: string): void {
  assert.equal(repairStreamingMarkdown(input), input, `不应改动: ${JSON.stringify(input)}`)
}

// ---------- 强调定界符 ----------

describe('未闭合强调定界符', () => {
  it('**加粗 → 补 **', () => {
    assertAppends('这段是 **重点', '**')
  })
  it('*斜体 → 补 *', () => {
    assertAppends('这段是 *重点', '*')
  })
  it('***粗斜体 → 补 ***', () => {
    assertAppends('这段是 ***重点', '***')
  })
  it('~~删除线 → 补 ~~', () => {
    assertAppends('这段是 ~~废弃', '~~')
  })
  it('下划线强调 __重点 → 补 __', () => {
    assertAppends('这段是 __重点', '__')
  })
  it('已闭合的 **重点** 不动', () => {
    assertUnchanged('这段是 **重点** 说明')
  })
  it('外层 ** 未闭合、内层 * 未闭合 → 两个都补（否则外层星号会露出来）', () => {
    /**
     * 修正前的期望是只补内层（`**加粗内的 *斜体*`），但那个结果渲染出来是**字面的 `**`** ——
     * 实测（remark-gfm + remark-math 全链路）：
     *   `**加粗内的 *斜体*`   → tags=[p, em]，text="**加粗内的 斜体"（`**` 可见）
     *   `**加粗内的 *斜体***` → tags=[p, strong, em]，text="加粗内的 斜体"（正确）
     * 即"只补栈顶"会让外层定界符永远补不上，与 unclosedDelimiters 末尾
     * 「后开的先收」的注释相矛盾。嵌套未闭合必须按内层→外层全部收尾。
     */
    assertAppends('**加粗内的 *斜体', '***')
  })
  it('行首 * 是列表标记：不补', () => {
    assertUnchanged('* 第一项\n* 第二项\n* 第三项')
  })
  it('乘法 2 * 3 = 6 不补', () => {
    assertUnchanged('结果是 2 * 3 = 6')
  })
  it('行尾孤立的 * 后面没有内容，不补', () => {
    assertUnchanged('步骤：\n*')
  })
  it('反斜杠转义的 \\* 不算定界符', () => {
    assertUnchanged('这里用 \\* 表示乘号')
  })
  it('行内代码里的 ** 不参与强调配对', () => {
    assertUnchanged('写法是 `**bold` 的记号')
  })
})

// ---------- `==高亮==` ----------

describe('未闭合的 ==高亮==', () => {
  it('==重点 → 补 ==', () => {
    assertAppends('结论是 ==关键', '==')
  })
  it('已闭合的 ==重点== 不动', () => {
    assertUnchanged('结论是 ==关键== 说明')
  })
  it('一行里已有一对、末尾又开一个 → 补 ==', () => {
    assertAppends('==a== 和 ==b', '==')
  })
  it('相等比较 a == b 不补（== 后面是空格，不构成开定界符）', () => {
    assertUnchanged('当 a == b 时')
  })
  it('相等比较 x==y 不补（紧贴词字符）', () => {
    assertUnchanged('判断 x==y 是否成立')
  })
  it('行内代码里的 == 不参与配对', () => {
    assertUnchanged('写法是 `a == b` 的记号')
  })
  it('围栏代码块里的 == 不参与配对', () => {
    assertUnchanged('```cpp\nif (a == b) return 1;\n```')
  })
  it('公式区里的 == 不参与配对', () => {
    assertUnchanged('公式 $a == b$ 里')
  })
  it('未闭合的开定界符在更早的行上 → 不补（补了也跨行配不成对）', () => {
    assertUnchanged('==开头\n后续正文')
  })
  it('高亮与加粗同时未闭合 → 收尾顺序是先加粗后高亮', () => {
    // 必须先补 `**` 再补 `==`，否则得到 `==**重点==**`（高亮与加粗互相穿插）
    assertAppends('==**重点', '**==')
  })
  it('补全后经管线能正常渲染成高亮（与 preprocessMath 串起来）', () => {
    const out = repairStreamingMarkdown('结论是 ==关键')
    assert.equal(out, '结论是 ==关键==')
    // 管线把定界符换成哨兵对（哨兵不在可见文本里，由 rehype 组装成 mark）
    const processed = preprocessMath(out)
    assert.ok(!processed.includes('=='), `定界符应已转成哨兵: ${JSON.stringify(processed)}`)
  })
})

// ---------- 行内代码 ----------

describe('未闭合行内代码', () => {
  it('`push_back → 补反引号', () => {
    assertAppends('用 `push_back', '`')
  })
  it('`dp_{i-1} → 补反引号（随后交给公式管线剥反引号渲染）', () => {
    const out = repairStreamingMarkdown('递推 `dp_{i-1}')
    assert.equal(out, '递推 `dp_{i-1}`')
    // 与 preprocessMath 串起来：补上的反引号让这段被识别为 LaTeX 公式
    assert.ok(preprocessMath(out).includes('$dp_{i-1}$'), preprocessMath(out))
  })
  it('多反引号 span 用等长反引号收尾', () => {
    assertAppends('``code', '``')
  })
  it('反引号内为空时不补（空 span 不合法）', () => {
    assertUnchanged('这里是一个孤立的 `')
  })
  it('行内代码不跨行：上一行的孤立反引号不会在文末收尾', () => {
    assertUnchanged('第一行 `未闭合\n第二行没有反引号')
  })
})

// ---------- 围栏代码块 ----------

describe('未闭合围栏代码块', () => {
  it('未闭合围栏内一律不动（含内部的 ** 与孤立反引号）', () => {
    assertUnchanged('```cpp\nint a = 1;\nif (a ** 2) {')
    assertUnchanged('```\n`code')
  })
  it('已闭合围栏之后的正文照常修复', () => {
    assertAppends('```cpp\nint a = 1;\n```\n这段是 **重点', '**')
  })
})

// ---------- 公式定界符 ----------

describe('未闭合块级公式', () => {
  it('$$ 独占一行时补一个同样独占一行的收尾 $$', () => {
    const out = repairStreamingMarkdown('推导如下：\n$$\nx_1 + x_2')
    assert.equal(out, '推导如下：\n$$\nx_1 + x_2\n$$')
  })
  it('引用块里的 $$ 收尾带 > 前缀（否则引用块被截断）', () => {
    const out = repairStreamingMarkdown('> 推导：\n> $$\n> x_1 + x_2')
    assert.equal(out, '> 推导：\n> $$\n> x_1 + x_2\n> $$')
  })
  it('行中间的 $$ 不补（本来就不是块级写法，补了也变不成合法公式）', () => {
    assertUnchanged('价格是 $$x 元')
  })
  it('已闭合的 $$ 块不动', () => {
    assertUnchanged('$$\nx_1 + x_2\n$$\n结束')
  })
  it('未闭合的 \\[ … 补 \\]', () => {
    assertAppends('公式 \\[a + b', '\\]')
  })
})

describe('未闭合行内公式', () => {
  it('未闭合的 \\( … 补 \\)', () => {
    assertAppends('已知 \\(x < y', '\\)')
  })
  it('$x_{i-1} → 补 $（有强数学特征）', () => {
    assertAppends('下标 $x_{i-1}', '$')
  })
  it('$\\frac{1}{2} → 补 $（LaTeX 命令）', () => {
    assertAppends('值为 $\\frac{1}{2}', '$')
  })
  it('金额 $5 / $1,000 不补（单个 $ 更可能是货币符号）', () => {
    assertUnchanged('花了 $5')
    assertUnchanged('总计 $1,000')
  })
  it('尾部是空白时不补（收尾定界符前面不能是空白）', () => {
    assertUnchanged('记作 $x_1 = ')
  })
  it('行内公式不跨行：上一行的孤立 $ 不在文末收尾', () => {
    assertUnchanged('第一行 $a_1\n第二行 b_2$')
  })
  it('转义的 \\$ 不算定界符', () => {
    assertUnchanged('价格 \\$5 到 \\$10')
  })
})

// ---------- snake_case / 词内下划线 ----------

describe('词内下划线不是强调', () => {
  it('push_back / dp_i / sync_with_stdio 都不补下划线', () => {
    assertUnchanged('用 push_back 插入')
    assertUnchanged('状态 dp_i 表示前 i 个')
    assertUnchanged('调用 ios::sync_with_stdio')
    assertUnchanged('函数 max_element 与 vis_cnt')
  })
  it('但单独的 _斜体 仍然补', () => {
    assertAppends('这是 _斜体', '_')
  })
})

// ---------- 波浪号 ----------

describe('单个词内波浪号转义', () => {
  it('20~25 → 20\\~25（防止 GFM 单波浪线删除线）', () => {
    assert.equal(repairStreamingMarkdown('区间 20~25 之间'), '区间 20\\~25 之间')
  })
  it('代码区里的 ~ 不转义', () => {
    assertUnchanged('`a~b`')
  })
})

// ---------- 整体性质 ----------

describe('整体性质', () => {
  it('不带任何定界符的普通文本原样返回', () => {
    assertUnchanged('这是一段普通的说明文字，没有任何标记。')
  })
  it('完整消息原样返回（大段真实回复）', () => {
    const text = [
      '## 思路',
      '',
      '设 $dp_i$ 表示前 $i$ 个位置的最优解，则',
      '',
      '$$',
      'dp_i = \\max_{j < i} (dp_j + 1)',
      '$$',
      '',
      '用 `push_back` 维护转移，复杂度 $O(n \\log n)$。',
      '',
      '- 第一步：读入',
      '- 第二步：转移',
      '',
      '```cpp',
      'int main() { return 0; } // 结束',
      '```',
    ].join('\n')
    assertUnchanged(text)
  })
  it('幂等：对已修复的文本再跑一次不再改变', () => {
    const inputs = [
      '这段是 **重点',
      '这段是 *重点',
      '这段是 ~~废弃',
      '推导：\n$$\nx_1 + x_2',
      '公式 \\[a + b',
      '已知 \\(x < y',
      '下标 $x_{i-1}',
      '用 `push_back',
      '> $$\n> x_1',
    ]
    for (const input of inputs) {
      const once = repairStreamingMarkdown(input)
      assert.equal(repairStreamingMarkdown(once), once, `不幂等: ${JSON.stringify(input)} → ${JSON.stringify(once)}`)
    }
  })
})

// ---------- 写了一半的链接 / 图片 ----------

describe('未闭合链接与图片', () => {
  it('写到一半的链接整段截掉，不留字面 ](https://…', () => {
    assert.equal(repairStreamingMarkdown('参考[快速排序](https://examp'), '参考')
  })
  it('刚打出 ]( 也截掉', () => {
    assert.equal(repairStreamingMarkdown('见[这里]('), '见')
  })
  it('图片语法连 ! 一起截掉', () => {
    assert.equal(repairStreamingMarkdown('图示：![示意](https://x.com/a.pn'), '图示：')
  })
  it('写完整的链接不动', () => {
    assertUnchanged('参考[快速排序](https://example.com) 这篇')
  })
  it('URL 里带括号且已闭合时不动', () => {
    assertUnchanged('见[文档](https://a.com/x_(y)) 说明')
  })
  it('只有 [ 而没到 ]( 的形态不动（a[i] 写到一半）', () => {
    // 截掉会让已经打出来的字缩回去，抖得更明显；渲染出来只是一个普通 `[`
    assertUnchanged('数组 a[i')
    assertUnchanged('数组 a[i] 结束')
  })
  it('代码区里的 [ 不是链接，不动', () => {
    assertUnchanged('取 `a[prev]` 的值')
  })
  it('链接后面还有正文时不误截', () => {
    assertUnchanged('见[文档](https://a.com) 然后继续写')
  })
})

// ---------- 增量渲染切点 ----------

describe('findStableBlockSplit（流式增量渲染切点）', () => {
  /** 造一段由空行分隔的多段文本，保证总长超过切点阈值 */
  const longDoc = (tail: string): string => {
    const head = Array.from({ length: 30 }, (_, i) => `第 ${i} 段：这是一段足够长的说明文字，用来把文档撑过阈值。`).join('\n\n')
    return `${head}\n\n${tail}`
  }

  it('文末正在打字的那一段被切出来，前面整段保持稳定', () => {
    const tail = '正在打字的最后一段'
    const text = longDoc(tail)
    const cut = findStableBlockSplit(text)
    assert.ok(cut > 0, '应当找到切点')
    assert.equal(text.slice(cut), tail, '尾段应当正好是还在增长的那一块')
    assert.ok(text.slice(0, cut).includes('第 29 段'), '前段应当保留已写定的内容')
  })

  it('未闭合的代码围栏内部不是切点：整块代码留在尾段', () => {
    const tail = '```cpp\nint a = 1;'
    const text = longDoc(tail)
    const cut = findStableBlockSplit(text)
    assert.ok(cut > 0, '应当找到切点')
    assert.equal(text.slice(cut), tail, '围栏不能被切开，否则代码块会被撕裂')
    assert.ok(!text.slice(0, cut).includes('```cpp'), '围栏应当留在尾段')
  })

  it('未闭合的块级公式内部不是切点', () => {
    const tail = '$$ x = 1'
    const text = longDoc(tail)
    const cut = findStableBlockSplit(text)
    assert.ok(cut > 0, '应当找到切点')
    assert.equal(text.slice(cut), tail, '公式不能被切开')
  })

  it('短文档不切（走原来的整体渲染，行为不变）', () => {
    assert.equal(findStableBlockSplit('很短的一段话。'), -1)
    assert.equal(findStableBlockSplit(''), -1)
  })

  it('随着内容增长，切点只会前进不会回退', () => {
    const base = longDoc('')
    let prev = 0
    for (const extra of ['一', '一段', '一段话', '一段话。', '一段话。\n\n第二段开始']) {
      const cut = findStableBlockSplit(base + extra)
      assert.ok(cut >= prev, `切点回退了: ${prev} → ${cut}`)
      prev = cut
    }
  })
})
