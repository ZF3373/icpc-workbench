import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb } from '../src/db/index.ts';
import { templatesRoutes } from '../src/routes/templates.ts';
import { CURRICULUM } from '../src/templates/curriculum.ts';

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRoutes(db));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/templates`;
  try {
    await fn(base);
  } finally {
    srv.close();
    db.close();
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' };

/** 导出端点：空库 → 友好提示，无模板正文 */
test('export.md: empty library yields a hint with no template bodies', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/export.md`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="icpc-templates\.md"/);
    const md = await res.text();
    assert.match(md, /ICPC 算法模板库 · 导出/);
    assert.match(md, /自建模板：0 篇 · 内置模板笔记：0 篇/);
    assert.match(md, /暂无可导出的模板/);
    // 不应出现任何模板代码围栏或正文标题
    assert.doesNotMatch(md, /### \d+\./);
  });
});

/** 导出端点：自建模板 + 内置笔记都出现，含分类、难度、状态、代码 */
test('export.md: custom template + builtin note both rendered', async () => {
  await withServer(async (base) => {
    // 自建模板
    const created = await fetch(`${base}/custom`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        categoryKey: 'ds',
        name: '吉司机线段树（自用）',
        difficulty: 5,
        tags: ['线段树', '势能分析'],
        code: 'struct SegBeats { int n; };',
        idea: '区间最值操作的势能分析版本',
        complexity: 'O(n log^2 n)',
        url: 'https://example.com/seg-beats',
      }),
    });
    const { id } = (await created.json()) as { id: string };
    // 自建模板置为已掌握 + 记笔记
    await fetch(`${base}/${id}/status`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 'mastered' }),
    });
    await fetch(`${base}/${id}/note`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ note: '注意势能释放条件' }),
    });

    // 内置条目写入内容（第一个分类第一个模板）
    const builtin = CURRICULUM[0].templates[0];
    await fetch(`${base}/${builtin.id}/content`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({
        code: '// my binary search',
        idea: '找第一个 >= x',
        complexity: 'O(log n)',
        url: 'https://notes.example/x',
      }),
    });
    await fetch(`${base}/${builtin.id}/status`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 'learning' }),
    });

    const md = await (await fetch(`${base}/export.md`)).text();

    // 统计行
    assert.match(md, /自建模板：1 篇 · 内置模板笔记：1 篇/);

    // 自建模板分节
    assert.match(md, /一、自建模板（1 篇）/);
    assert.match(md, /吉司机线段树（自用）/);
    assert.match(md, /线段树、势能分析/);
    assert.match(md, /O\(n log\^2 n\)/);
    assert.match(md, /https:\/\/example\.com\/seg-beats/);
    assert.match(md, /\*\*状态：\*\* 已掌握/);
    assert.match(md, /\*\*笔记：\*\* 注意势能释放条件/);
    assert.match(md, /struct SegBeats \{ int n; \};/);

    // 内置笔记分节
    assert.match(md, /二、内置模板笔记（1 篇）/);
    assert.match(md, new RegExp(builtin.name));
    assert.match(md, /我的思路/);
    assert.match(md, /找第一个 >= x/);
    assert.match(md, /\/\/ my binary search/);
    assert.match(md, /https:\/\/notes\.example\/x/);
    assert.match(md, /\*\*状态：\*\* 学习中/);
  });
});

/** 内置条目未写入内容时不被导出（避免倒出整本空大纲） */
test('export.md: builtin item without written content is excluded', async () => {
  await withServer(async (base) => {
    const md = await (await fetch(`${base}/export.md`)).text();
    assert.match(md, /内置模板笔记：0 篇/);
    // 任何内置模板名都不应出现
    for (const cat of CURRICULUM) {
      for (const t of cat.templates) {
        assert.ok(!md.includes(t.name), `未写入的内置模板 ${t.id} 不应被导出`);
      }
    }
  });
});

/** 用户代码里含 ``` 反引号串时，围栏自动加长，不破坏 Markdown 结构 */
test('export.md: code fences grow to outbid backticks in user code', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/custom`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        categoryKey: 'basic',
        name: '反引号测试',
        difficulty: 1,
        tags: [],
        code: '```\nint x = 0;\n```\n// has 4 backticks ````',
        idea: '边界',
      }),
    });
    const md = await (await fetch(`${base}/export.md`)).text();
    // 应出现至少 5 个反引号开头的围栏（用户代码最长串是 4 个）
    assert.match(md, /`````+cpp/);
    assert.match(md, /`````+cpp[\s\S]*int x = 0;/);
  });
});
