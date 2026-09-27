import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  FETCH_URL_TRANSPORT,
  executeFetchUrl,
  htmlToText,
  extractTitle,
  validatePublicFetchUrl,
  isPrivateIp,
  resolveAndValidateHost,
  setDnsLookupForTest,
} from '../src/ai/fetch-url.ts';
import { throttledFetch } from '../src/net/hostThrottle.ts';
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

/**
 * 临时替换 globalThis.fetch，返回后用 restore 恢复（记录请求 URL 与 headers）。
 * 同时把 mock 作为 `fetchFn` 暴露给被测代码 —— 生产默认传输层是全局节流
 * （见 FETCH_URL_TRANSPORT），单测必须显式注入，否则会真的打网络。
 */
function mockGlobalFetch(
  responses: Array<{ status?: number; body?: string; headers?: Record<string, string> }>,
): {
  restore: () => void;
  calls: string[];
  headerCalls: Array<Record<string, string>>;
  fetchFn: typeof fetch;
} {
  const original = globalThis.fetch;
  let idx = 0;
  const calls: string[] = [];
  const headerCalls: Array<Record<string, string>> = [];
  const mock = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    headerCalls.push((init?.headers ?? {}) as Record<string, string>);
    const r = responses[idx] ?? { status: 200, body: '' };
    idx++;
    return new Response(r.body ?? '', {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    });
  }) as typeof fetch;
  globalThis.fetch = mock;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
    headerCalls,
    fetchFn: mock,
  };
}

/** directFetch 会做真实 DNS 解析：涉及网络的用例统一 stub 为「公网 IP」保证封闭性 */
function stubPublicDns(): void {
  setDnsLookupForTest(async () => [{ address: '93.184.216.34' }]);
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

describe('validatePublicFetchUrl', () => {
  it('rejects loopback, private, link-local and local hostnames', () => {
    for (const url of ['http://127.0.0.1/', 'http://10.0.0.8/', 'http://169.254.169.254/', 'http://[::1]/', 'http://localhost:3000/', 'https://host.local/a']) {
      assert.ok(validatePublicFetchUrl(url), `${url} should be rejected`);
    }
    assert.equal(validatePublicFetchUrl('https://example.com/problem'), null);
  });
});

describe('isPrivateIp', () => {
  it('识别 IPv4 私网/回环/链路本地/CGNAT/元数据', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '256.1.1.1']) {
      assert.ok(isPrivateIp(ip), `${ip} 应判为私网`);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1']) {
      assert.ok(!isPrivateIp(ip), `${ip} 应判为公网`);
    }
  });

  it('识别 IPv6 回环/未指定/链路本地/唯一本地/IPv4 映射', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1']) {
      assert.ok(isPrivateIp(ip), `${ip} 应判为私网`);
    }
    for (const ip of ['2606:4700::1111', '2001:db8::1', '::ffff:8.8.8.8']) {
      assert.ok(!isPrivateIp(ip), `${ip} 应判为公网`);
    }
  });
});

describe('resolveAndValidateHost', () => {
  afterEach(() => setDnsLookupForTest(null));

  it('公网域名解析到公网 IP → 放行', async () => {
    setDnsLookupForTest(async () => [{ address: '93.184.216.34' }]);
    assert.equal(await resolveAndValidateHost('example.com'), null);
  });

  it('公网域名解析到私网 IP → 拦截（DNS rebinding 防护）', async () => {
    setDnsLookupForTest(async () => [{ address: '10.9.9.9' }, { address: '192.168.0.2' }]);
    const r = await resolveAndValidateHost('evil.example.com');
    assert.ok(r);
    assert.match(r, /内网/);
  });

  it('解析失败（NXDOMAIN/非常规字面量）→ 拦截', async () => {
    setDnsLookupForTest(async () => {
      throw new Error('NXDOMAIN');
    });
    const r = await resolveAndValidateHost('0x7f000001');
    assert.ok(r);
    assert.match(r, /解析失败/);
  });
});

// ---------- executeFetchUrl 兜底路径（mock globalThis.fetch） ----------

describe('executeFetchUrl fallback (direct fetch)', () => {
  beforeEach(() => stubPublicDns());
  afterEach(() => setDnsLookupForTest(null));

  it('默认传输层 = 全局节流 throttledFetch（防风控：AI 工具不得绕过平台节奏）', () => {
    assert.equal(FETCH_URL_TRANSPORT, throttledFetch);
  });

  it('成功读取 HTML 正文并返回 title', async () => {
    const html = '<html><head><title>测试页面</title></head><body><p>你好世界</p></body></html>';
    const mock = mockGlobalFetch([
      { status: 200, body: html, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ]);
    try {
      const r = await executeFetchUrl('https://example.com/page', CFG_NO_KEY, undefined, mock.fetchFn);
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
      const r = await executeFetchUrl('https://example.com/missing', CFG_NO_KEY, undefined, mock.fetchFn);
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
      const r = await executeFetchUrl('https://example.com/img.png', CFG_NO_KEY, undefined, mock.fetchFn);
      assert.equal(r.content, '');
      assert.match(r.error ?? '', /非文本/);
    } finally {
      mock.restore();
    }
  });
});

// ---------- 重定向逐跳校验与 Cookie 隔离 ----------

describe('directFetch redirect hop validation', () => {
  beforeEach(() => stubPublicDns());
  afterEach(() => setDnsLookupForTest(null));

  it('跟随同/跨主机重定向并解析相对 Location', async () => {
    const html = '<html><head><title>落地页</title></head><body><p>重定向后内容</p></body></html>';
    const mock = mockGlobalFetch([
      { status: 302, headers: { Location: '/final' } },
      { status: 200, body: html, headers: { 'Content-Type': 'text/html' } },
    ]);
    try {
      const r = await executeFetchUrl('https://example.com/start', CFG_NO_KEY, undefined, mock.fetchFn);
      assert.equal(r.error, undefined);
      assert.match(r.content, /重定向后内容/);
      assert.deepEqual(mock.calls, ['https://example.com/start', 'https://example.com/final']);
    } finally {
      mock.restore();
    }
  });

  it('重定向跳向内网 IP 被拦截，且不会发起对该地址的请求', async () => {
    const mock = mockGlobalFetch([
      { status: 302, headers: { Location: 'http://10.0.0.5/admin' } },
    ]);
    try {
      const r = await executeFetchUrl('https://example.com/redirect', CFG_NO_KEY, undefined, mock.fetchFn);
      assert.match(r.error ?? '', /内网/);
      assert.equal(mock.calls.length, 1, '第二跳应在 fetch 前被拦截');
    } finally {
      mock.restore();
    }
  });

  it('公网重定向链中途 DNS 解析到私网被拦截', async () => {
    const mock = mockGlobalFetch([
      { status: 302, headers: { Location: 'https://rebind.example.net/a' } },
    ]);
    setDnsLookupForTest(async (host) => [
      { address: host === 'example.com' ? '93.184.216.34' : '127.0.0.1' },
    ]);
    try {
      const r = await executeFetchUrl('https://example.com/redirect', CFG_NO_KEY, undefined, mock.fetchFn);
      assert.match(r.error ?? '', /内网/);
      assert.equal(mock.calls.length, 1);
    } finally {
      mock.restore();
    }
  });

  it('重定向超过 5 跳返回错误', async () => {
    const responses = Array.from({ length: 8 }, (_, i) => ({
      status: 302,
      headers: { Location: `/hop${i + 1}` },
    }));
    const mock = mockGlobalFetch(responses);
    try {
      const r = await executeFetchUrl('https://example.com/hop0', CFG_NO_KEY, undefined, mock.fetchFn);
      assert.match(r.error ?? '', /重定向次数过多/);
      assert.equal(mock.calls.length, 6);
    } finally {
      mock.restore();
    }
  });

  it('跨主机重定向不携带平台 Cookie', async () => {
    const mock = mockGlobalFetch([
      { status: 302, headers: { Location: 'https://third.example.org/next' } },
      { status: 200, body: '<p>ok</p>', headers: { 'Content-Type': 'text/html' } },
    ]);
    try {
      await executeFetchUrl('https://www.luogu.com.cn/record/1', CFG_NO_KEY, { luogu: { cookie: '_uid=1; __gid=2' } }, mock.fetchFn);
      assert.equal(mock.headerCalls[0]['Cookie'], '_uid=1; __gid=2', '首跳应带平台 Cookie');
      assert.equal(mock.headerCalls[1]['Cookie'], undefined, '跨主机第二跳不得携带 Cookie');
    } finally {
      mock.restore();
    }
  });

  it('同主机重定向继续携带 Cookie（洛谷站内跳转）', async () => {
    const mock = mockGlobalFetch([
      { status: 302, headers: { Location: 'https://www.luogu.com.cn/record/1/mine' } },
      { status: 200, body: '<p>ok</p>', headers: { 'Content-Type': 'text/html' } },
    ]);
    try {
      await executeFetchUrl('https://www.luogu.com.cn/record/1', CFG_NO_KEY, { luogu: { cookie: '_uid=1' } }, mock.fetchFn);
      assert.equal(mock.headerCalls[1]['Cookie'], '_uid=1');
    } finally {
      mock.restore();
    }
  });
});

// ---------- 工具注册与 execute 包装 ----------

describe('fetch_url registration & execute', () => {
  beforeEach(() => stubPublicDns());
  afterEach(() => setDnsLookupForTest(null));
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
      const result = await executeToolCall(
        'fetch_url',
        { url: 'https://qoj.ac/problem/1' },
        { ...CTX_NO_KEY, fetchFn: mock.fetchFn },
      );
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
      const result = await executeToolCall(
        'fetch_url',
        { url: 'https://example.com/private' },
        { ...CTX_NO_KEY, fetchFn: mock.fetchFn },
      );
      assert.match(result.content, /读取 https:\/\/example\.com\/private 失败/);
      assert.match(result.content, /403/);
      assert.equal(result.metadata, undefined);
    } finally {
      mock.restore();
    }
  });
});
