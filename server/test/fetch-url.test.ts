import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeFetchUrl,
  htmlToText,
  extractTitle,
} from '../src/ai/fetch-url.ts';
// 静态导入触发 fetch_url 注册副作用（registerTool 在模块顶层执行）
import '../src/ai/fetch-url.ts';
import { executeToolCall, getRegisteredToolNames } from '../src/ai/tools/registry.ts';
import type { AiConfig } from '../src/config.ts';
import type { ToolContext } from '../src/ai/tools/registry.ts';

/** 无 searchApiKey 的配置：跳过 Tavily 主路径，直接走兜底 directFetch（便于 mock globalThis.fetch） */
const CFG_NO_KEY: AiConfig = {
  enabled: true,
  baseURL: 'http://localhost/v1',
  apiKey: 'key',
  model: 'm',
};
const CTX_NO_KEY: ToolContext = { cfg: CFG_NO_KEY };

/** 临时替换 globalThis.fetch，返回后用 restore 恢复 */
function mockGlobalFetch(
  responses: Array<{ status?: number; body?: string; headers?: Record<string, string> }>,
): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  let idx = 0;
  const calls: string[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    const r = responses[idx] ?? { status: 200, body: '' };
    idx++;
    return new Response(r.body ?? '', {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

// ---------- htmlToText 纯函数 ----------

describe('htmlToText', () => {
  it('移除 script/style/nav/head/footer/noscript 块', () => {
    const html = [
      '<head><title>T</title><meta charset="utf-8"></head>',
      '<script>alert(1)</script>',
      '<style>body{color:red}</style>',
      '<nav>菜单 首页</nav>',
      '<header>页头</header>',
      '<footer>页脚</footer>',
      '<noscript>需 JS</noscript>',
      '<body><p>正文内容</p></body>',
    ].join('');
    const text = htmlToText(html);
    assert.match(text, /正文内容/);
    assert.doesNotMatch(text, /alert/);
    assert.doesNotMatch(text, /color:red/);
    assert.doesNotMatch(text, /菜单/);
    assert.doesNotMatch(text, /页头/);
    assert.doesNotMatch(text, /页脚/);
    assert.doesNotMatch(text, /需 JS/);
    assert.doesNotMatch(text, /charset/);
  });

  it('保留 pre/code 内容（OJ 样例 I/O 关键）', () => {
    const html = '<pre>3 5\n1 2 3\n4 5 6</pre><code>x &lt; y</code>';
    const text = htmlToText(html);
    assert.match(text, /3 5/);
    assert.match(text, /1 2 3/);
    assert.match(text, /4 5 6/);
    // code 内实体应被解码
    assert.match(text, /x < y/);
  });

  it('解码常见 HTML 实体', () => {
    const html = '<p>&amp; &lt; &gt; &quot; &#39; &nbsp;end</p>';
    const text = htmlToText(html);
    assert.equal(text, '& < > " \' end');
  });

  it('块级标签闭合转换行', () => {
    const html = '<p>第一段</p><p>第二段</p><div>块</div>';
    const text = htmlToText(html);
    assert.match(text, /第一段\n+/);
    assert.match(text, /第二段\n+/);
    assert.match(text, /块$/);
  });

  it('br 标签转换行', () => {
    const html = '<p>行1<br>行2<br/>行3</p>';
    const text = htmlToText(html);
    assert.match(text, /行1\n行2\n行3/);
  });

  it('截断超长正文并标注', () => {
    const long = 'a'.repeat(51000);
    const html = `<p>${long}</p>`;
    const text = htmlToText(html);
    assert.ok(text.length <= 50000 + 50, `text.length=${text.length} 应被截断到约 50000 字符`);
    assert.match(text, /内容已截断/);
  });

  it('折叠多余空白但保留换行结构', () => {
    const html = '<p>  多   个   空格  </p>\n\n\n\n<p>下一段</p>';
    const text = htmlToText(html);
    assert.doesNotMatch(text, / {2,}/);
    assert.match(text, /多 个 空格\s*\n\n下一段/);
  });
});

// ---------- extractTitle 纯函数 ----------

describe('extractTitle', () => {
  it('提取 <title> 文本', () => {
    assert.equal(extractTitle('<html><head><title>QOJ Contest 4071</title></head></html>'), 'QOJ Contest 4071');
  });

  it('无 title 时返回空字符串', () => {
    assert.equal(extractTitle('<html><body>无标题</body></html>'), '');
  });

  it('解码 title 中的实体', () => {
    assert.equal(extractTitle('<title>A &amp; B &lt;test&gt;</title>'), 'A & B <test>');
  });
});

// ---------- executeFetchUrl 兜底路径（mock globalThis.fetch） ----------

describe('executeFetchUrl fallback (direct fetch)', () => {
  it('成功读取 HTML 正文并返回 title', async () => {
    const html = '<html><head><title>测试页面</title></head><body><p>你好世界</p></body></html>';
    const mock = mockGlobalFetch([
      { status: 200, body: html, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ]);
    try {
      const r = await executeFetchUrl('https://example.com/page', CFG_NO_KEY);
      assert.equal(r.title, '测试页面');
      assert.match(r.content, /你好世界/);
      assert.equal(r.error, undefined);
    } finally {
      mock.restore();
    }
  });

  it('HTTP 错误返回 error 说明', async () => {
    const mock = mockGlobalFetch([
      { status: 404, body: 'Not Found', headers: { 'Content-Type': 'text/html' } },
    ]);
    try {
      const r = await executeFetchUrl('https://example.com/missing', CFG_NO_KEY);
      assert.equal(r.content, '');
      assert.match(r.error ?? '', /404/);
    } finally {
      mock.restore();
    }
  });

  it('非文本内容类型返回 error', async () => {
    const mock = mockGlobalFetch([
      { status: 200, body: '', headers: { 'Content-Type': 'image/png' } },
    ]);
    try {
      const r = await executeFetchUrl('https://example.com/img.png', CFG_NO_KEY);
      assert.equal(r.content, '');
      assert.match(r.error ?? '', /非文本/);
    } finally {
      mock.restore();
    }
  });
});

// ---------- 工具注册与 execute 包装 ----------

describe('fetch_url registration & execute', () => {
  it('fetch_url 已注册到工具表', () => {
    assert.ok(
      getRegisteredToolNames().includes('fetch_url'),
      'fetch_url 应在 import 后注册',
    );
  });

  it('空 url 返回友好错误', async () => {
    const result = await executeToolCall('fetch_url', { url: '' }, CTX_NO_KEY);
    assert.match(result.content, /url 参数不能为空/);
  });

  it('缺 url 参数返回友好错误', async () => {
    const result = await executeToolCall('fetch_url', {}, CTX_NO_KEY);
    assert.match(result.content, /url 参数不能为空/);
  });

  it('非 http(s) 协议返回错误', async () => {
    const result = await executeToolCall('fetch_url', { url: 'ftp://example.com' }, CTX_NO_KEY);
    assert.match(result.content, /http:\/\/ 或 https:\/\//);
  });

  it('成功读取时返回 content + metadata（{title,url}）', async () => {
    const html = '<html><head><title>题目页</title></head><body><p>求最短路径</p></body></html>';
    const mock = mockGlobalFetch([
      { status: 200, body: html, headers: { 'Content-Type': 'text/html' } },
    ]);
    try {
      const result = await executeToolCall('fetch_url', { url: 'https://qoj.ac/problem/1' }, CTX_NO_KEY);
      assert.match(result.content, /求最短路径/);
      assert.match(result.content, /https:\/\/qoj\.ac\/problem\/1/);
      assert.ok(Array.isArray(result.metadata));
      assert.equal((result.metadata as Array<{ title: string; url: string }>)[0].title, '题目页');
      assert.equal((result.metadata as Array<{ title: string; url: string }>)[0].url, 'https://qoj.ac/problem/1');
    } finally {
      mock.restore();
    }
  });

  it('读取失败时返回说明性 content 且无 metadata', async () => {
    const mock = mockGlobalFetch([
      { status: 403, body: 'Forbidden', headers: { 'Content-Type': 'text/html' } },
    ]);
    try {
      const result = await executeToolCall('fetch_url', { url: 'https://example.com/private' }, CTX_NO_KEY);
      assert.match(result.content, /读取 https:\/\/example\.com\/private 失败/);
      assert.match(result.content, /403/);
      assert.equal(result.metadata, undefined);
    } finally {
      mock.restore();
    }
  });
});
