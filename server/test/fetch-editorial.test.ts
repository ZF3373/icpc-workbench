import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EDITORIAL_TRANSPORT,
  classifyNowcoderEditorial,
  executeFetchEditorial,
  extractLuoguSolutions,
  findNowcoderEditorialLink,
  findNowcoderTutorialsEntries,
} from '../src/ai/fetch-editorial.ts';
import { throttledFetch } from '../src/net/hostThrottle.ts';

/**
 * 防风控回归：工具默认传输层必须是全局按域名节流单例 —— 否则 AI 在一轮对话里
 * 连发多次题解抓取就能绕过所有平台的风控节奏。
 */
test('fetch_editorial 默认传输层 = 全局节流 throttledFetch', () => {
  assert.equal(EDITORIAL_TRANSPORT, throttledFetch);
});

/**
 * fetch_editorial 工具：按平台派发读取题解（fetch-editorial.ts）。
 * 全部走 stub fetch，不访问外网。核心断言：
 *   · 牛客两跳（比赛页 → 带「题解」标注的讨论帖 → 正文）；
 *   · 找不到题解入口 / 无 Cookie / CF 无源 → 明确报错文案（不编造、不静默给空）；
 *   · 洛谷 __INITIAL_STATE__ 提取 markdown 正文，剥掉非正文噪声。
 */

function pageFetch(routes: Record<string, string>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = String(input);
    for (const [needle, html] of Object.entries(routes)) {
      if (u.includes(needle)) return new Response(html, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

test('findNowcoderEditorialLink：只认带「题解」标注的讨论帖，找不到返回 null', () => {
  const html = `
    <a href="/discuss/111">比赛公告</a>
    <a href="/discuss/1222870">牛客挑战赛92 题解</a>
    <a href="/discuss/1222899">D 题讨论</a>`;
  assert.equal(findNowcoderEditorialLink(html), 'https://ac.nowcoder.com/discuss/1222870');
  assert.equal(findNowcoderEditorialLink('<a href="/discuss/111">只有公告</a>'), null);
});

test('findNowcoderEditorialLink：转义 JSON 内嵌的锚点（href=\\"...\\"）也能发现', () => {
  const html =
    '<div class=\\"reward\\">【赛后题解】<a href=\\"https://ac.nowcoder.com/discuss/1223000\\" target=\\"_blank\\">牛客挑战赛92 题解</a></div>';
  assert.equal(findNowcoderEditorialLink(html), 'https://ac.nowcoder.com/discuss/1223000');
});

test('findNowcoderTutorialsEntries：只收题解条目并按 URL 去重，带绝对链接', () => {
  const html = `
    <a href="/discuss/917947188737507328">【题解】牛客小白月赛136</a>
    <a href="https://ac.nowcoder.com/discuss/917947188737507328">【题解】牛客小白月赛136（重复）</a>
    <a href="/discuss/1679079?type=0">(19)</a>`;
  const entries = findNowcoderTutorialsEntries(html);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!.title, /【题解】牛客小白月赛136/);
  assert.equal(entries[0]!.url, 'https://ac.nowcoder.com/discuss/917947188737507328');
});

test('牛客题解帖直达：discuss 帖子 URL 直接读正文', async () => {
  const body = 'A 题考察前缀和与统计。'.repeat(30);
  const fetchFn = pageFetch({
    '/discuss/917947188737507328': `<h1>【题解】牛客小白月赛136</h1><p>${body}</p>`,
  });
  const r = await executeFetchEditorial('https://www.nowcoder.com/discuss/917947188737507328', undefined, fetchFn);
  assert.equal(r.error, undefined);
  assert.match(r.content ?? '', /A 题考察前缀和与统计/);
  assert.equal(r.sourceUrl, 'https://www.nowcoder.com/discuss/917947188737507328');
});

test('牛客题解帖登录墙：仅作者可见的帖子报错而非把导航噪声当正文', async () => {
  const nav = '首页 比赛 题库 课程 竞赛讨论区 登录/注册 去牛客 仅作者可见！ 回首页看更多的题 扫码加入竞赛交流群 下载牛客APP 关于我们。'.repeat(3);
  const fetchFn = pageFetch({ '/discuss/1228444': `<div>${nav}</div>` });
  const r = await executeFetchEditorial('https://ac.nowcoder.com/discuss/1228444', undefined, fetchFn);
  assert.match(r.error ?? '', /仅作者可见/);
});

test('牛客登录墙出现在标题之后（>400 字符）也要判出来——否则把导航噪声当题解喂给模型', async () => {
  // 提示落在旧的 400 字符窗口之外：只看前 400 字符的实现会漏判，
  // 把 500+ 字符的导航噪声当成「够长」的题解正文返回
  const head = '牛客竞赛讨论区 · 题库 · 课程 · 竞赛 · 讨论区 '.repeat(20);
  assert.ok(head.length > 400, `前置噪声须超过旧窗口：${head.length}`);
  const fetchFn = pageFetch({
    '/discuss/1228445': `<h1>【题解】某场比赛</h1><div>${head}仅作者可见！${'回首页 更多题解 关于我们 '.repeat(20)}</div>`,
  });
  const r = await executeFetchEditorial('https://ac.nowcoder.com/discuss/1228445', undefined, fetchFn);
  assert.match(r.error ?? '', /仅作者可见/, '登录墙提示出现在 400 字符之后也必须判出');
  assert.equal(r.content, undefined, '绝不能把导航噪声当题解正文返回');
});

test('classifyNowcoderEditorial：登录墙与体量下限合并判定（窗口 2000 字符）', () => {
  const good = 'A 题考察前缀和与统计。'.repeat(30);
  assert.equal(classifyNowcoderEditorial(good), null, '正常长度的题解正文可用');
  assert.equal(classifyNowcoderEditorial('太短了'), 'too-short', '体量不足判噪声');
  assert.equal(classifyNowcoderEditorial(`   ${good}   `), null, '首尾空白不参与体量判定');

  const late = `${'导航 '.repeat(300)}仅作者可见！`;
  assert.equal(classifyNowcoderEditorial(late), 'gated', '400 字符之后的登录墙提示仍判 gated');

  // 窗口有界（2000 字符）：超长正文里偶然出现该词不再触发误判
  const veryLong = `${good.repeat(30)}仅作者可见`;
  assert.ok(veryLong.length > 2000, '样本须超过扫描窗口');
  assert.equal(classifyNowcoderEditorial(veryLong), null, '扫描窗口有界，避免长题解被误判');

  assert.equal(classifyNowcoderEditorial('短内容', 1), null, '自定义体量下限生效');
});

test('牛客题解列表：tutorials URL 返回「标题 → 链接」清单供模型链式取正文', async () => {
  const fetchFn = pageFetch({
    '/acm/discuss/tutorials': `
      <a href="https://www.nowcoder.com/discuss/917947188737507328">【题解】牛客小白月赛136</a>
      <a href="/discuss/1679079?type=0">(19)</a>`,
  });
  const r = await executeFetchEditorial(
    'https://ac.nowcoder.com/acm/discuss/tutorials?tagId=309737',
    undefined,
    fetchFn,
  );
  assert.equal(r.error, undefined);
  assert.match(r.content ?? '', /【题解】牛客小白月赛136：https:\/\/www\.nowcoder\.com\/discuss\/917947188737507328/);
  assert.doesNotMatch(r.content ?? '', /\(19\)/, '不带题解标注的条目不进清单');
});

test('牛客两跳：比赛页定位题解帖并返回正文', async () => {
  const fetchFn = pageFetch({
    '/acm/contest/140237': '<a href="/discuss/1222870">牛客挑战赛92 题解</a>',
    '/discuss/1222870': `<h1>题解</h1><p>${'A 题考察前缀和，B 题是构造，C 题需要离散化。'.repeat(20)}</p>`,
  });
  const r = await executeFetchEditorial('https://ac.nowcoder.com/acm/contest/140237', undefined, fetchFn);
  assert.equal(r.error, undefined);
  assert.match(r.content ?? '', /A 题考察前缀和/);
  assert.equal(r.sourceUrl, 'https://ac.nowcoder.com/discuss/1222870');
});

test('牛客比赛页没有题解帖入口 → 明确报错（不抓无关帖子）', async () => {
  const fetchFn = pageFetch({ '/acm/contest/1': '<a href="/discuss/111">比赛公告</a>' });
  const r = await executeFetchEditorial('https://ac.nowcoder.com/acm/contest/1', undefined, fetchFn);
  assert.match(r.error ?? '', /没有找到.*题解/);
});

test('AtCoder：读官方 editorial 页', async () => {
  const fetchFn = pageFetch({
    '/contests/abc380/editorial': '<main><p>Editorial for A: use sorting.</p></main>',
  });
  const r = await executeFetchEditorial('https://atcoder.jp/contests/abc380', undefined, fetchFn);
  assert.equal(r.error, undefined);
  assert.match(r.content ?? '', /Editorial for A: use sorting\./);
  assert.equal(r.sourceUrl, 'https://atcoder.jp/contests/abc380/editorial');
});

test('Codeforces：无稳定题解源 → 明确告知并建议替代路径', async () => {
  const r = await executeFetchEditorial(
    'https://codeforces.com/contest/1877',
    undefined,
    pageFetch({}),
  );
  assert.match(r.error ?? '', /没有稳定的读取来源|web_search/);
});

test('洛谷：未配置 Cookie 明确报错；有 Cookie 时从 __INITIAL_STATE__ 提取题解', async () => {
  const noCookie = await executeFetchEditorial(
    'https://www.luogu.com.cn/problem/P1422',
    undefined,
    pageFetch({}),
  );
  assert.match(noCookie.error ?? '', /洛谷 Cookie/);

  const stateHtml = `<script>window.__INITIAL_STATE__={"feeds":{"data":{"cells":[{"rows":[{"content":"## 思路\\n按功率拆位即可：把每个电器看作二进制位上的贡献，**注意** 2 的幂的边界。\\n\\n\`\`\`cpp\\nfor (int b = 0; b < 30; b++) cnt[b] += (a >> b) & 1;\\n\`\`\`\\n\\n逐位统计后取最小调整次数，总复杂度 O(30n)，能过最大数据。"}]}]}}};</script>`;
  const withCookie = await executeFetchEditorial(
    'https://www.luogu.com.cn/problem/P1422',
    { luogu: { cookie: '__uid=1; __client_id=abc' } },
    pageFetch({ '/problem/solution/P1422': stateHtml }),
  );
  assert.equal(withCookie.error, undefined);
  assert.match(withCookie.content ?? '', /按功率拆位即可/);
  assert.equal(withCookie.sourceUrl, 'https://www.luogu.com.cn/problem/solution/P1422');
});

test('extractLuoguSolutions：只收 markdown 特征的长文本，剥掉页面噪声', () => {
  const html = `<script>window.__INITIAL_STATE__={"a":{"content":"## 思路\\n这是正题解，含 **加粗** 与代码块。"},"b":{"title":"太短不收"},"c":{"content":"这是一段没有 markdown 特征的很长的普通文本，虽然超过八十字符，但是没有标题加粗代码块等特征，因此不应被当作题解正文收进来，避免把页面杂讯误当成题解内容返回给模型使用。"}};</script>`;
  const out = extractLuoguSolutions(html);
  assert.match(out, /正题解/);
  assert.doesNotMatch(out, /不应被当作题解正文/);
  assert.doesNotMatch(out, /太短不收/);
});
