/**
 * issue #18（AI 输出格式渲染不完善）里的「列表 × 围栏」结构性修补。
 *
 * 这些用例的输入都是模型真实会写的形态，不是构造出来的边角：断的是
 * 「CommonMark 语义正确、但对读者明显不对」那一类。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indentFencesInLists } from '../src/components/markdownList'

test('有序列表项下顶格的围栏：缩进到该项的内容列（3 空格）', () => {
  const out = indentFencesInLists('1. 建栈\n```cpp\nint x;\n```\n2. 弹栈')
  assert.equal(out, '1. 建栈\n   ```cpp\n   int x;\n   ```\n2. 弹栈')
})

test('无序列表项下顶格的围栏：缩进 2 空格；嵌套一层则是 4', () => {
  assert.equal(
    indentFencesInLists('- 建栈\n```cpp\nint x;\n```'),
    '- 建栈\n  ```cpp\n  int x;\n  ```',
  )
  assert.equal(
    indentFencesInLists('- 外层\n  - 建栈\n```cpp\nint x;\n```'),
    '- 外层\n  - 建栈\n    ```cpp\n    int x;\n    ```',
  )
})

test('围栏整段一起补缩进（含收尾行与代码内容行），代码内部相对缩进不变', () => {
  const out = indentFencesInLists('1. 步骤\n```cpp\nif (a) {\n    b();\n}\n```')
  assert.equal(out, '1. 步骤\n   ```cpp\n   if (a) {\n       b();\n   }\n   ```')
})

test('流式未闭合：从开栏到文末一并补缩进，避免打字时贴边、写完又缩回去', () => {
  const out = indentFencesInLists('1. 建栈\n```cpp\nint x;')
  assert.equal(out, '1. 建栈\n   ```cpp\n   int x;')
})

test('不在「列表项紧跟围栏」形态里的一律不动', () => {
  const cases = [
    // 上一行不是列表项
    '说明文字\n```cpp\nint x;\n```',
    // 列表项与围栏之间隔了正文
    '1. 建栈\n补充说明\n```cpp\nint x;\n```',
    // 已经缩进过的围栏（第 0 列没有围栏）
    '1. 建栈\n   ```cpp\n   int x;\n   ```',
    // 行内代码里的三连反引号不算开栏
    '说明 `a` 与 `b`',
  ]
  for (const text of cases) assert.equal(indentFencesInLists(text), text, text)
})

test('幂等：再跑一次不会二次缩进', () => {
  const once = indentFencesInLists('1. 建栈\n```cpp\nint x;\n```\n2. 弹栈')
  assert.equal(indentFencesInLists(once), once)
})

test('不含围栏的文本原样返回（快速路径）', () => {
  const text = '- a\n  - b\n正文 `code`'
  assert.equal(indentFencesInLists(text), text)
})

test('一段普通围栏里的 `+ ` 续行不会被误认成列表项（曾把收尾当新开栏）', () => {
  // 用户截图里的真实形态：两段围栏，第一段内容行以 `+ (` 开头
  const text = [
    '在一次查询中，针对当前的 k，对每个 i 我们可以使用的资源数为',
    '',
    '```',
    'avail(i) = cnt[i]                  // 直接保留 i',
    '         + (i != k-i ? cnt[k-i] : 0) // 变换得到 i',
    '```',
    '',
    '因为每件资源只能被使用一次，遍历 i 时把已经使用的资源从 cnt 中减掉即可。',
    '',
    '```',
    'need = 0            // 已经成功构造了 0..need-1',
    'for i = 0 … n:',
    '    if cnt[i] > 0:          cnt[i]--, need++',
    '```',
  ].join('\n')
  assert.equal(indentFencesInLists(text), text)
})

test('已缩进的围栏整段跳过：里面的列表形态行不会触发新的补缩进', () => {
  const text = '1. 步骤\n   ```\n   - 这是代码里的 bullet\n   ```\n2. 下一步\n```\n独立的\n```'
  assert.equal(indentFencesInLists(text), '1. 步骤\n   ```\n   - 这是代码里的 bullet\n   ```\n2. 下一步\n   ```\n   独立的\n   ```')
})

test('一个闭合围栏之后的另一个列表项：各自按自己的缩进处理，不互相牵连', () => {
  // 第一个 ``` 就是它的收尾；随后 `- 二` 又开了一个新列表项 + 围栏（缩进 2）
  const out = indentFencesInLists('1. 一\n```\nx\n```\n- 二\n```\ny\n```')
  assert.equal(out, '1. 一\n   ```\n   x\n   ```\n- 二\n  ```\n  y\n  ```')
})
