import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  absolutizeSubmissionUrl,
  atcoderSubmissionUrl,
  codeforcesSubmissionUrl,
  nowcoderSubmissionUrl,
  resolveSubmissionUrl,
  submissionUrlOf,
} from '../src/adapters/submissionUrl.ts';
import { extractSourceFromHtml, decodeHtmlEntities, looksGated } from '../src/submissions/source.ts';

/**
 * 提交详情链接（issue #69）的口径：能给就给准，给不出就 null ——
 * 死链比没有链接更糟（用户点开 404 会以为软件坏了）。
 */

test('Codeforces：正式赛与 gym 路由不同，非法号一律 null', () => {
  assert.equal(codeforcesSubmissionUrl(1877, 240012345), 'https://codeforces.com/contest/1877/submission/240012345');
  assert.equal(codeforcesSubmissionUrl(100500, 240012345), 'https://codeforces.com/gym/100500/submission/240012345');
  // 100000 正好是 gym 的下界（与 problemUrlFor 同一阈值）
  assert.equal(codeforcesSubmissionUrl(100000, 1), 'https://codeforces.com/gym/100000/submission/1');
  assert.equal(codeforcesSubmissionUrl(99999, 1), 'https://codeforces.com/contest/99999/submission/1');
  assert.equal(codeforcesSubmissionUrl(0, 1), null);
  assert.equal(codeforcesSubmissionUrl(1877, 0), null);
  assert.equal(codeforcesSubmissionUrl('abc' as unknown as number, 1), null);
});

test('AtCoder：需要 contestId，slug 形态不符时 null', () => {
  assert.equal(atcoderSubmissionUrl('abc380', 79730001), 'https://atcoder.jp/contests/abc380/submissions/79730001');
  assert.equal(atcoderSubmissionUrl('', 1), null);
  assert.equal(atcoderSubmissionUrl('abc 380', 1), null);
  assert.equal(atcoderSubmissionUrl('abc380', -1), null);
});

test('只需提交号的平台：模板正确，形态不符时 null', () => {
  assert.equal(submissionUrlOf('luogu', '12345'), 'https://www.luogu.com.cn/record/12345');
  assert.equal(submissionUrlOf('qoj', '2924293'), 'https://qoj.ac/submission/2924293');
  assert.equal(submissionUrlOf('vjudge', '777'), 'https://vjudge.net/solution/777');
  assert.equal(submissionUrlOf('dashoj', '65f1c2d3e4b5a69788776655'), 'https://dashoj.com/record/65f1c2d3e4b5a69788776655');
  assert.equal(submissionUrlOf('luogu', 'abc'), null);
  assert.equal(submissionUrlOf('dashoj', 'not-an-objectid'), null);
  // 路由未知的平台不猜：计蒜客 / PTA / 力扣
  assert.equal(submissionUrlOf('jisuanke', '4zoBj7'), null);
  assert.equal(submissionUrlOf('pta', '1234567'), null);
  assert.equal(submissionUrlOf('leetcode', '100'), null);
});

test('nowcoder：竞赛/练习段有路由，社区在线编程段（community: 前缀）不给', () => {
  assert.equal(nowcoderSubmissionUrl('123456789'), 'https://ac.nowcoder.com/acm/contest/view-submission?submissionId=123456789');
  assert.equal(submissionUrlOf('nowcoder', '123456789'), 'https://ac.nowcoder.com/acm/contest/view-submission?submissionId=123456789');
  assert.equal(submissionUrlOf('nowcoder', 'community:987654321'), null);
});

test('resolveSubmissionUrl：适配器自算的优先，手动导入不给链接', () => {
  assert.equal(
    resolveSubmissionUrl('codeforces', '240012345', 'https://codeforces.com/contest/1877/submission/240012345'),
    'https://codeforces.com/contest/1877/submission/240012345',
  );
  // 适配器没给时回落到平台模板
  assert.equal(resolveSubmissionUrl('luogu', '12345'), 'https://www.luogu.com.cn/record/12345');
  // 手动导入：没有真实提交号
  assert.equal(resolveSubmissionUrl('luogu', 'manual:1'), null);
  assert.equal(resolveSubmissionUrl('codeforces', '1'), null);
});

test('absolutizeSubmissionUrl：只接受绝对 http(s) 与站内相对路径', () => {
  assert.equal(absolutizeSubmissionUrl('https://qoj.ac', '/submission/1'), 'https://qoj.ac/submission/1');
  assert.equal(absolutizeSubmissionUrl('https://qoj.ac', 'https://x.test/a'), 'https://x.test/a');
  assert.equal(absolutizeSubmissionUrl('https://qoj.ac', 'javascript:alert(1)'), null);
  assert.equal(absolutizeSubmissionUrl('https://qoj.ac', ''), null);
  assert.equal(absolutizeSubmissionUrl('https://qoj.ac', null), null);
});

test('源码抽取：实体反转义 + 去掉高亮标签 + 保留换行', () => {
  assert.equal(decodeHtmlEntities('a &lt; b &amp;&amp; c &gt; d'), 'a < b && c > d');
  assert.equal(decodeHtmlEntities('&#124;x&#x7C;'), '|x|');
  const html = '<pre id="program-source-text">int main() {\n  return 0;\n}</pre>';
  assert.deepEqual(extractSourceFromHtml('codeforces', html), { source: 'int main() {\n  return 0;\n}', language: null });
  // 语法高亮的 span 被剥掉，实体反转义回源码里的真实字符
  const highlighted = '<pre id="submission-code"><span>a</span> &lt; <span>b</span></pre>';
  assert.equal(extractSourceFromHtml('atcoder', highlighted)?.source.trim(), 'a < b');
});

test('源码抽取：登录墙/挑战页不算源码', () => {
  assert.equal(looksGated('<title>Sign In - AtCoder</title>'), true);
  assert.equal(extractSourceFromHtml('atcoder', '<title>Sign In - AtCoder</title><pre>登录后查看</pre>'), null);
  assert.equal(extractSourceFromHtml('codeforces', 'Just a moment...'), null);
  // 没有 pre 就是取不到，不要返回空串冒充源码
  assert.equal(extractSourceFromHtml('codeforces', '<html><body>hi</body></html>'), null);
});

test('源码抽取：洛谷/Hydro 从内嵌 JSON 的 code 字段取，转义还原', () => {
  const luogu = 'window._feInjection = {"code": "#include <bits/stdc++.h>\\nint main(){}"}';
  assert.equal(extractSourceFromHtml('luogu', luogu)?.source, '#include <bits/stdc++.h>\nint main(){}');
  const hydro = '{"rdoc":{"code":"print(1)\\nprint(2)"}}';
  assert.equal(extractSourceFromHtml('dashoj', hydro)?.source, 'print(1)\nprint(2)');
  assert.equal(extractSourceFromHtml('luogu', 'window.x = {}'), null);
});

test('源码抽取：不支持的平台返回 null（不瞎猜）', () => {
  assert.equal(extractSourceFromHtml('pta', '<pre>code</pre>'), null);
  assert.equal(extractSourceFromHtml('jisuanke', '<pre>code</pre>'), null);
});
