/**
 * markdownMath.ts 预处理管线单元测试。
 * 用 node:test 运行（Node 22 内置，无需额外依赖）。
 *
 * 用例来源于真实 AI 消息（Permutation Inversions 讲解）中暴露的渲染 bug：
 * 代码块被公式逻辑污染、** 加粗定界符卷入公式、片段重叠导致文本重复、
 * Unicode 省略号/减号截断公式。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  preprocessMath,
  stripOuterCodeFence,
  normalizeMathDelimiters,
  wrapBareMath,
} from '../src/components/markdownMath.ts'

// ---------- stripOuterCodeFence ----------

describe('stripOuterCodeFence', () => {
  it('剥离整段包裹的 ```markdown 围栏', () => {
    assert.equal(stripOuterCodeFence('```markdown\n# 标题\n内容\n```'), '# 标题\n内容\n')
  })
  it('cpp 等代码语言的围栏不剥离（整段是代码块）', () => {
    const text = '```cpp\nint x;\n```'
    assert.equal(stripOuterCodeFence(text), text)
  })
  it('内部嵌套围栏时不剥离', () => {
    const text = '```\n标题\n```cpp\nint x;\n```\n```'
    assert.equal(stripOuterCodeFence(text), text)
  })
  it('无围栏时原样返回', () => {
    assert.equal(stripOuterCodeFence('# 标题'), '# 标题')
  })
  it('围栏只是内容一部分时不剥离', () => {
    const text = '正文\n```\ncode\n```\n结尾'
    assert.equal(stripOuterCodeFence(text), text)
  })
})

// ---------- normalizeMathDelimiters ----------

describe('normalizeMathDelimiters', () => {
  it('\\(...\\) → $...$', () => {
    assert.equal(normalizeMathDelimiters('已知 \\(x < y\\) 求解'), '已知 $x < y$ 求解')
  })
  it('\\[...\\] → $$...$$', () => {
    assert.equal(normalizeMathDelimiters('公式：\n\\[a + b = c\\]\n完毕'), '公式：\n$$a + b = c$$\n完毕')
  })
  it('代码块内的 \\(...\\) 不转换', () => {
    const text = '`\\(x\\)` 是内联代码'
    assert.equal(normalizeMathDelimiters(text), text)
  })
})

// ---------- 代码块保护（本次修复的核心回归） ----------

describe('代码块不被公式逻辑污染', () => {
  it('C++ 代码块内的下划线标识符/箭头注释保持原样', () => {
    const code = [
      '```cpp',
      'ios::sync_with_stdio(false);',
      'g[prev].push_back(cur);',
      'priority_queue<int, vector<int>, greater<int>> pq;',
      '// 连 qj -> q(j+1)',
      'cout << p[i] << (i == n ? \'\\n\' : \' \');',
      '```',
    ].join('\n')
    const out = preprocessMath(code)
    assert.ok(out.includes('ios::sync_with_stdio(false);'), 'sync_with_stdio 被包进公式')
    assert.ok(out.includes('g[prev].push_back(cur);'), 'push_back 被包进公式')
    assert.ok(out.includes('priority_queue<int, vector<int>, greater<int>> pq;'), 'priority_queue 被包进公式')
    assert.ok(out.includes('// 连 qj -> q(j+1)'), '箭头注释被包进公式')
    // 代码围栏本身必须保留
    assert.ok(out.includes('```cpp'), '代码围栏被移除')
  })

  it('q1 → q2 链式文本不被包裹（→ 不是数学种子）', () => {
    const out = wrapBareMath('对每条约束，相邻两项连边：q1 → q2 → q3 → … → qk')
    assert.equal(out, '对每条约束，相邻两项连边：q1 → q2 → q3 → … → qk')
  })
})

// ---------- 加粗 + 公式（本次修复的第二个回归） ----------

describe('加粗定界符不卷入公式', () => {
  it('**p_{qi,1} < ... < p_{qi,k}** 渲染为加粗包裹公式', () => {
    const out = preprocessMath('**p_{qi,1} < p_{qi,2} < … < p_{qi,k}**')
    // ** 保留在公式外，remark-math 已验证可解析为 strong > inlineMath
    assert.ok(out.startsWith('**$'), `** 应在公式外: ${out}`)
    assert.ok(out.endsWith('$**'), `** 应在公式外: ${out}`)
    assert.ok(!out.includes('$**p_'), `公式内部不应含 **: ${out}`)
  })
})

// ---------- 片段不重复（本次修复的第三个回归） ----------

describe('文本不重复', () => {
  it('g[prev].push_back(cur) 类文本在普通段落中不出现两遍', () => {
    // 模拟正文段落中出现的代码引用（非代码块）
    const out = preprocessMath('调用 g[prev].push_back(cur) 追加边')
    const occurrences = out.split('g[prev].push_back').length - 1
    assert.equal(occurrences, 1, `文本被重复输出: ${out}`)
  })
})

// ---------- Unicode 数学符号 ----------

describe('Unicode 数学符号归一化', () => {
  it('Σ(ri − li + 1) ≤ 10^6 转为完整 LaTeX 公式', () => {
    const out = preprocessMath('所有测试的 Σ(ri − li + 1) ≤ 10^6。')
    // 公式不应在 − 或 … 处断开：应产生单个 $...$ 包裹
    assert.ok(out.includes('$\\sum (ri - li + 1) \\le  10^6$'), out)
  })
  it('… → \\dots', () => {
    const out = preprocessMath('设 x_{i} … 为序列')
    assert.ok(out.includes('\\dots'), out)
  })
})

// ---------- 原有能力回归 ----------

describe('原有能力回归', () => {
  it('裸下标 c_i 被包裹', () => {
    assert.ok(preprocessMath('复杂度与 c_i 有关').includes('$c_i$'))
  })
  it('裸上标 2^k 被包裹', () => {
    assert.ok(preprocessMath('枚举 2^k 个子集').includes('$2^k$'))
  })
  it('LaTeX 命令 \\frac{...}{...} 被包裹', () => {
    const out = preprocessMath('答案是 \\frac{n(n+1)}{2}')
    assert.ok(out.includes('$\\frac{n(n+1)}{2}$'), out)
  })
  it('行内代码中的数学样式被转为公式', () => {
    assert.ok(preprocessMath('`f_{i mod a_m} ← f_i`').includes('$f_{i mod a_m}'))
  })
  it('数学代码块被转为公式（· 不再截断片段）', () => {
    const out = preprocessMath('```\nO(n·3^{n/6})\n```')
    assert.ok(out.includes('$O(n\\cdot 3^{n/6})$'), out)
  })
  it('已有 $...$ 公式内部不被二次处理', () => {
    const out = preprocessMath('已知 $a_i + b_i$ 求和')
    assert.equal(out, '已知 $a_i + b_i$ 求和')
  })
})
