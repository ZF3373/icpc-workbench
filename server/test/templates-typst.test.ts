import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTypstToPdf, renderTemplatesTypst } from '../src/templates/typst.ts';
import type { ExportBundle } from '../src/routes/templates.ts';

function bundle(overrides: Partial<ExportBundle> = {}): ExportBundle {
  return {
    version: 1,
    exportedAt: '2026-09-17T12:00:00.000Z',
    customCount: 1,
    builtinNoteCount: 0,
    customTemplates: [
      {
        id: 'c-1',
        category: '基础算法',
        name: '标题 "X" # $ \\ path',
        difficulty: 3,
        tags: ['二分', '前缀和'],
        code: 'int x = 1;\n#set text(size: 10pt)',
        idea: '区间 "最值"',
        complexity: 'O(log n)',
        url: 'https://example.com/a?x=1&y=2',
        status: 'mastered',
        note: '注意 $ 与 #',
      },
    ],
    builtinNotes: [],
    ...overrides,
  };
}

test('renderTemplatesTypst safely renders user text and code', () => {
  const source = renderTemplatesTypst(bundle());

  assert.match(source, /#set text\(\n  font:/);
  assert.ok(source.includes('#text("1. 标题 \\"X\\" # $ \\\\ path")'));
  assert.ok(source.includes('#raw(block: true, lang: "cpp", "int x = 1;\\n#set text(size: 10pt)")'));
  assert.ok(source.includes('#text("注意 $ 与 #")'));
  assert.match(source, /#counter\(page\)\.display/);
});

test('renderTemplatesTypst renders note markdown instead of printing raw syntax', () => {
  const source = renderTemplatesTypst(
    bundle({
      customTemplates: [
        {
          id: 'c-md',
          category: '数据结构',
          name: '树状数组',
          difficulty: 3,
          tags: [],
          code: 'int c[N];',
          idea: [
            '## 思路',
            '单点加、区间和。',
            '',
            '- **lowbit**：`x & -x` 取最低位',
            '- 复杂度 `O(log n)`',
            '',
            '### 注意',
            '下标从 1 开始',
          ].join('\n'),
          complexity: '',
          url: 'https://example.com/x',
          status: 'mastered',
          note: '配合 `lowbit(x)` 使用',
        },
      ],
    }),
  );

  // ## / - / ** / ` 不再原样出现在 #text 字符串里
  assert.ok(source.includes('#heading(level: 4)[#text("思路")]'));
  assert.ok(source.includes('#text("单点加、区间和。")'));
  assert.ok(source.includes('#strong[#text("lowbit")]'));
  assert.ok(source.includes('#raw("x & -x")'));
  assert.ok(source.includes('#heading(level: 5)[#text("注意")]'));
  // 备注单行走行内渲染，行内代码成为 raw
  assert.ok(source.includes('#raw("lowbit(x)")'));
  // 出处成为可点击链接
  assert.ok(source.includes('#link("https://example.com/x")'));
  // 字面 \n 被还原为结构（而不是出现在任何字符串里）
  assert.doesNotMatch(source, /#text\("[^"]*## /);
  // 代码块可跨页断行
  assert.ok(source.includes('breakable: true,'));
});

test('renderTemplatesTypst heals literal \\n notes from legacy AI writes', () => {
  const source = renderTemplatesTypst(
    bundle({
      customTemplates: [
        {
          ...bundle().customTemplates[0]!,
          idea: '核心模型：\\n- **逐位处理**：从左到右\\n- 每步取模',
        },
      ],
    }),
  );

  assert.ok(source.includes('#text("核心模型：")'));
  assert.ok(source.includes('#strong[#text("逐位处理")]'));
  assert.ok(source.includes('#list(marker: ([•]), [#strong[#text("逐位处理")]#text("：从左到右")]'));
  assert.doesNotMatch(source, /\\\\n/);
});

test('compileTypstToPdf produces a real PDF from the generated source', async () => {
  const pdf = await compileTypstToPdf(renderTemplatesTypst(bundle()));

  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
});
