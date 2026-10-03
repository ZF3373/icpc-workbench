import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLiteralNewlines,
  renderInlineMarkdown,
  renderMarkdownToTypst,
} from '../src/templates/markdownTypst.ts';

test('normalizeLiteralNewlines 把字面 \\n 还原为真实换行', () => {
  assert.equal(normalizeLiteralNewlines('第一行\\n- 第二项\\n- 第三项'), '第一行\n- 第二项\n- 第三项');
  // 连续反斜杠同样按换行处理
  assert.equal(normalizeLiteralNewlines('a\\\\nb'), 'a\nb');
  // 行内代码 span 中的 \n 是代码内容，保持字面
  assert.equal(normalizeLiteralNewlines('写 `cout << "\\n"` 输出换行'), '写 `cout << "\\n"` 输出换行');
  // 围栏代码块内保持字面
  assert.equal(
    normalizeLiteralNewlines('```cpp\\nprintf("\\n");\\n```'),
    '```cpp\\nprintf("\\n");\\n```',
  );
});

test('normalizeLiteralNewlines 不动真实换行与 \\t', () => {
  assert.equal(normalizeLiteralNewlines('a\nb\tc'), 'a\nb\tc');
});

test('行内：加粗、行内代码、斜体', () => {
  assert.equal(
    renderInlineMarkdown('**逐位处理**：`res * 10` 左移一位'),
    '#strong[#text("逐位处理")]#text("：")#raw("res * 10")#text(" 左移一位")',
  );
  assert.equal(renderInlineMarkdown('这是 *斜体* 用法'), '#text("这是 ")#emph[#text("斜体")]#text(" 用法")');
  // snake_case 中的下划线不是斜体
  assert.equal(renderInlineMarkdown('用 max_value 表示'), '#text("用 max_value 表示")');
});

test('行内：转义与未配对记号保持字面', () => {
  assert.equal(renderInlineMarkdown('转义 \\* 不强调'), '#text("转义 * 不强调")');
  assert.equal(renderInlineMarkdown('a * b * c'), '#text("a * b * c")');
});

test('行内：链接与自动链接', () => {
  assert.equal(
    renderInlineMarkdown('[OI Wiki](https://oi-wiki.org) 参考'),
    '#link("https://oi-wiki.org")[#text("OI Wiki")]#text(" 参考")',
  );
  assert.match(renderInlineMarkdown('见 https://codeforces.com/blog。'), /#link\("https:\/\/codeforces\.com\/blog"\)\[#text\("https:\/\/codeforces\.com\/blog"\)\]/);
  // 结尾标点不属于 URL
  assert.match(renderInlineMarkdown('见 https://example.com/x.'), /#link\("https:\/\/example\.com\/x"\)\[#text\("https:\/\/example\.com\/x"\)\]#text\("\."\)/);
});

test('块级：标题、段落、列表、代码块', () => {
  const md = [
    '## 思路',
    '',
    '逐位处理大数。',
    '',
    '- 外层一',
    '  - 内层',
    '- 外层二',
    '',
    '1. 第一步',
    '2. 第二步',
    '',
    '```cpp',
    'int x = 1;',
    '```',
  ].join('\n');
  const out = renderMarkdownToTypst(md);
  assert.ok(out.includes('#heading(level: 4)[#text("思路")]'));
  assert.ok(out.includes('#text("逐位处理大数。")'));
  assert.ok(out.includes('#list(marker: ([•]), [#text("外层一")'));
  assert.ok(out.includes('#list(indent: 0.65em, marker: ([–]), [#text("内层")]'));
  assert.ok(out.includes('#enum(start: 1, numbering: "1.", [#text("第一步")]'));
  assert.ok(out.includes('#raw(block: true, lang: "cpp", "int x = 1;")'));
});

test('块级：有序列表起始号与用户内容转义', () => {
  const out = renderMarkdownToTypst('3. 从 3 开始：**重要**');
  assert.ok(out.includes('#enum(start: 3,'));
  assert.ok(out.includes('#strong[#text("重要")]'));
});

test('块级：GFM 表格', () => {
  const md = ['| 算法 | 复杂度 |', '| :--- | ---: |', '| 二分 | O(log n) |'].join('\n');
  const out = renderMarkdownToTypst(md);
  assert.ok(out.includes('#table('));
  assert.ok(out.includes('columns: 2,'));
  assert.ok(out.includes('align: (left, right),'));
  assert.ok(out.includes('table.header([#strong[#text("算法")]], [#strong[#text("复杂度")]])'));
  assert.ok(out.includes('#text("O(log n)")'));
});

test('块级：引用块', () => {
  const out = renderMarkdownToTypst('> 提示：先排序\n> 再扫描');
  assert.ok(out.startsWith('#quote(block: true)['));
  assert.ok(out.includes('#text("提示：先排序")'));
});

test('完整链路：字面 \\n 笔记被还原并渲染', () => {
  const out = renderMarkdownToTypst('核心要点：\\n- **乘 10 转移**：`res * 10`\\n- 取模防溢出');
  assert.ok(out.includes('#text("核心要点：")'));
  assert.ok(out.includes('#list(marker: ([•]), [#strong[#text("乘 10 转移")]#text("：")#raw("res * 10")]'));
  assert.ok(out.includes('#text("取模防溢出")'));
});
