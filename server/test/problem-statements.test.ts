import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import {
  collectStatementTargets,
  fetchProblemStatement,
  prefetchProblemStatementsBackground,
  readProblemStatements,
  renderStatementSection,
  statementLooksValid,
  statementSupport,
  statementUnavailableReason,
  __resetProblemStatementsForTest,
} from '../src/contests/problemStatements.ts';
import type { ContestReviewData } from '../src/contests/participated.ts';
import type { PlatformId } from '../../shared/src/index.ts';

/**
 * 题面预取 + 落库缓存的测试：预取、缓存命中、抓取失败降级、预算控制。
 * 全部走内存库，不访问网络（注入 mock fetch）。
 */

function makeReview(
  platform: PlatformId,
  contestId: string,
  submissions: Array<{ problemKey: string; verdict: string; url: string | null }>,
  unsubmitted: Array<{ id: string; index?: string }>,
): ContestReviewData {
  return {
    contest: {
      key: `${platform}:${contestId}`,
      platform,
      contestId,
      name: `Test Contest ${contestId}`,
      url: `https://example.com/contest/${contestId}`,
      startTimeIso: '2026-09-20T14:00:00.000Z',
      endTimeIso: '2026-09-20T16:00:00.000Z',
      submissionCount: submissions.length,
      problemCount: submissions.length + unsubmitted.length,
      acProblemCount: submissions.filter((s) => s.verdict === 'AC').length,
      lastSubmittedAt: '2026-09-20T15:00:00.000Z',
      evidence: 'contest',
      source: null,
    },
    submissions: submissions.map((s) => ({
      platform,
      problemKey: s.problemKey,
      title: `Problem ${s.problemKey}`,
      url: s.url,
      difficulty: 1000,
      tags: [],
      verdict: s.verdict,
      submittedAt: '2026-09-20T14:30:00.000Z',
      context: 'contest',
    })),
    problemSetKnown: unsubmitted.length > 0,
    unsubmittedProblems: unsubmitted.map((p) => ({
      id: p.id,
      index: p.index,
      title: `Unsubmitted ${p.id}`,
    })),
  };
}

test('readProblemStatements：空库返回空 Map', () => {
  const db = createDb(':memory:');
  try {
    const stmts = readProblemStatements(db, [
      { platform: 'codeforces', problemKey: '1877A' },
    ]);
    assert.equal(stmts.size, 0);
  } finally {
    db.close();
  }
});

test('fetchProblemStatement：AtCoder 题面抓取并落库（含约束/输入输出/样例，且不混入日文块）', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    // 真实页面结构（abc454_a 实测）：lang-ja 在前、lang-en 在后，各自 span 独立
    const mockHtml = `
      <html><body>
        <nav>ナビゲーション</nav>
        <div id="task-statement">
          <span class="lang">
            <span class="lang-ja">
              <p>配点 : 100 点</p><h3>問題文</h3><p>整数 L,R が与えられます。</p><h3>制約</h3><p>1<=L<=R<=100</p>
            </span>
            <span class="lang-en">
              <p>Score : 100 points</p>
              <h3>Problem Statement</h3><p>You are given two integers L and R.</p>
              <h3>Constraints</h3><ul><li>1 <= L <= R <= 100</li></ul>
              <h3>Input</h3><p>Input is given from Standard Input in the following format:</p><pre>L R</pre>
              <h3>Output</h3><p>Print the number of integers between L and R, inclusive.</p>
              <h3>Sample Input 1</h3><pre>3 5</pre>
              <h3>Sample Output 1</h3><pre>3</pre>
            </span>
          </span>
        </div>
        <div class="a2a_kit">share widget</div>
        <footer class="footer">site footer</footer>
      </body></html>
    `;
    const mockFetch = (async () =>
      new Response(mockHtml, { status: 200, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
    const text = await fetchProblemStatement(
      db, 'atcoder', 'abc454_a',
      'https://atcoder.jp/contests/abc454/tasks/abc454_a', mockFetch,
    );
    assert.ok(text, '应返回非空题面正文');
    // 旧实现懒匹配到第一个 </span> 就结束，实测只抽到 68 字符（丢掉约束/输入输出/样例）
    assert.ok(text!.length > 200, `题面必须完整（实测旧实现只有 68 字符）：${text!.length}`);
    assert.ok(text!.includes('Problem Statement'), '应含题意');
    assert.ok(text!.includes('Constraints'), '应含约束');
    assert.ok(text!.includes('Input'), '应含输入格式');
    assert.ok(text!.includes('Sample Output 1'), '应含样例');
    assert.ok(!text!.includes('問題文'), '优先英文块，不混入日文（避免重复/噪声）');
    assert.ok(!text!.includes('share widget'), '不应带进分享组件');
    assert.ok(!text!.includes('site footer'), '不应带进页脚');

    const row = db
      .prepare('SELECT text, source_url FROM problem_statements WHERE platform = ? AND problem_key = ?')
      .get('atcoder', 'abc454_a') as { text: string; source_url: string };
    assert.ok(row.text.length > 200, '题面应已落库');
    assert.equal(row.source_url, 'https://atcoder.jp/contests/abc454/tasks/abc454_a');
  } finally {
    db.close();
  }
});

test('fetchProblemStatement：无来源/被拦平台不浪费请求；牛客为尽力抓（噪声校验兜底）', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response('<div class="problem-statement">x</div>', { status: 200 });
    }) as unknown as typeof fetch;
    // CF（Cloudflare 拦死，需 Cookie 才试）/ 计蒜客 / QOJ：直接跳过，不发请求
    for (const [platform, key] of [
      ['codeforces', '1877A'],
      ['jisuanke', '37170-101605'],
      ['qoj', '20028'],
    ] as const) {
      const text = await fetchProblemStatement(db, platform, key, 'https://example.com/p', spyFetch);
      assert.equal(text, null, `${platform} 不应抓取题面`);
    }
    assert.equal(calls, 0, '无来源/被拦的平台不应发出任何网络请求');

    // 牛客：尽力抓（用户库里 6/6 比赛题目页实测成功），但抓到导航页必须被拒
    const nav = '返回 首页 比赛 题库 课程 竞赛讨论区 登录/ 注册 去牛客 没有查看题目的权限哦 回首页 扫码加入竞赛交流群 下载牛客APP 意见反馈 关于我们。'.repeat(2);
    const navFetch = (async () => {
      calls += 1;
      return new Response(`<div>${nav}</div>`, { status: 200 });
    }) as unknown as typeof fetch;
    assert.equal(
      await fetchProblemStatement(db, 'nowcoder', '213096', 'https://ac.nowcoder.com/acm/problem/213096', navFetch),
      null,
      '牛客权限墙页面不能被当成题面',
    );
    assert.equal(calls, 1, '牛客要真的试一次（不是直接跳过）');
    const count = db.prepare('SELECT COUNT(*) AS n FROM problem_statements').get() as { n: number };
    assert.equal(count.n, 0, '噪声不落库');
  } finally {
    db.close();
  }
});

test('statementSupport / statementUnavailableReason：平台可抓性矩阵与原因文案', () => {
  assert.equal(statementSupport('atcoder'), 'ok');
  assert.equal(statementSupport('luogu'), 'ok');
  assert.equal(statementSupport('nowcoder'), 'gated');
  assert.equal(statementSupport('codeforces'), 'blocked');
  assert.equal(statementSupport('jisuanke'), 'unsupported');
  assert.match(statementUnavailableReason('codeforces'), /Cloudflare/);
  assert.match(statementUnavailableReason('nowcoder'), /登录/);
  assert.match(statementUnavailableReason('qoj'), /公开可抓/);
  assert.equal(statementUnavailableReason('atcoder'), '');
});

test('statementLooksValid：权限墙 / 机器人校验页 / 站点导航一律拒收（宁缺毋滥）', () => {
  // 实测：牛客未登录题库页的真实正文（457 字符站点导航）
  const nowcoderNav =
    '首页 比赛 tracker 题库 课程 竞赛讨论区 登录/ 注册 去牛客 没有查看题目的权限哦 回首页 扫码添加企业微信 扫码加入竞赛交流群 扫描二维码，关注牛客 意见反馈 下载牛客APP，随时随地刷题 刷真题、补算法、看面经、得内推 使用第三方账号直接登录使用吧： 更多 牛客竞赛，专业的竞技算法训练营。';
  assert.equal(statementLooksValid(nowcoderNav), false, '站点导航不能当题面');
  assert.equal(statementLooksValid('Please wait. Your browser is being checked. It may take a few seconds...'), false);
  assert.equal(statementLooksValid('Just a moment...'), false);
  assert.equal(statementLooksValid('太短'), false);
  const real =
    'Problem Statement\nYou are given two integers L and R. Count the number of integers x such that L <= x <= R.\n' +
    'Constraints\n1 <= L <= R <= 100\nInput\nInput is given from Standard Input in the following format:\nL R\nOutput\nPrint the answer.\nSample Input 1\n3 5\nSample Output 1\n3';
  assert.equal(statementLooksValid(real), true, '真实题面应通过校验');
});

test('fetchProblemStatement：抓到挑战页/权限墙时不落库（宁缺毋滥）', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    const challengeFetch = (async () =>
      new Response(
        '<html><body><p>Please wait. Your browser is being checked. It may take a few seconds...</p>' +
          '<script>var x=1;</script></body></html>',
        { status: 200 },
      )) as typeof fetch;
    const text = await fetchProblemStatement(
      db, 'luogu', 'P1001', 'https://www.luogu.com.cn/problem/P1001', challengeFetch,
    );
    assert.equal(text, null, '挑战页不应被当成题面');
    const count = db.prepare('SELECT COUNT(*) AS n FROM problem_statements').get() as { n: number };
    assert.equal(count.n, 0, '噪声不落库');
  } finally {
    db.close();
  }
});

test('fetchProblemStatement：洛谷走 C3VK 反爬重试（302 下发新 cookie → 200 成功）', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    const cookiesSent: string[] = [];
    let calls = 0;
    const state =
      '<script>window.__INITIAL_STATE__={"currentData":{"problem":{"description":"## 题目描述\\n给出两个整数 L 和 R，求区间 [L, R] 内整数的个数。\\n\\n## 输入格式\\n一行两个整数 L 和 R，保证 1 <= L <= R <= 100。\\n\\n## 输出格式\\n输出一个整数，表示区间内整数的个数。\\n\\n## 输入输出样例\\n输入：\\n```\\n3 5\\n```\\n输出：\\n```\\n3\\n```\\n\\n## 说明提示\\n样例中 3、4、5 均在区间内，共 3 个。"}}};</script>';
    const c3vkFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const cookie = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? '');
      cookiesSent.push(cookie);
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { 'set-cookie': 'C3VK=abc123; Max-Age=300; Path=/' },
        });
      }
      return new Response(state, { status: 200 });
    }) as unknown as typeof fetch;

    const text = await fetchProblemStatement(
      db, 'luogu', 'P1001', 'https://www.luogu.com.cn/problem/P1001', c3vkFetch,
    );
    assert.equal(calls, 2, '应带新 C3VK 重试一次');
    assert.match(cookiesSent[1] ?? '', /C3VK=abc123/, '重试请求必须带上新下发的 C3VK');
    assert.ok(text && text.includes('题目描述'), '应抽到洛谷 __INITIAL_STATE__ 里的题面');
  } finally {
    db.close();
  }
});

test('fetchProblemStatement：blocked 平台配了 Cookie 才尝试（CF + cf_clearance）', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    let calls = 0;
    const html = `<div class="problem-statement"><div class="content"><p>${'Given n, print YES. ' +
      'Input: n (1 <= n <= 100). Output: YES or NO. '.repeat(5)}</p></div></div></div>`;
    const spyFetch = (async () => {
      calls += 1;
      return new Response(html, { status: 200 });
    }) as unknown as typeof fetch;

    // 无 Cookie：直接拦截，不发请求
    assert.equal(
      await fetchProblemStatement(db, 'codeforces', '700A', 'https://codeforces.com/contest/700/problem/A', spyFetch),
      null,
    );
    assert.equal(calls, 0, '没配 Cookie 时不应试 CF（Cloudflare 必拦）');

    // 带 Cookie（cf_clearance）：尝试抓取，成功即落库
    const text = await fetchProblemStatement(
      db, 'codeforces', '700A', 'https://codeforces.com/contest/700/problem/A', spyFetch,
      'cf_clearance=abc; __cf_bm=x',
    );
    assert.equal(calls, 1, '配了 Cookie 就值得试一次');
    assert.ok(text && text.includes('Given n'), 'CF 题面抽取应生效');
    const cached = readProblemStatements(db, [{ platform: 'codeforces', problemKey: '700A' }]);
    assert.equal(cached.size, 1, '带 Cookie 抓到的题面应落库');
  } finally {
    __resetProblemStatementsForTest();
    db.close();
  }
});

test('fetchProblemStatement：失败返回 null 不落库', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    const brokenFetch = (async () => new Response('error', { status: 500 })) as typeof fetch;
    const text = await fetchProblemStatement(
      db, 'atcoder', 'abc999_a',
      'https://atcoder.jp/contests/abc999/tasks/abc999_a', brokenFetch,
    );
    assert.equal(text, null, '失败应返回 null');
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM problem_statements')
      .get() as { n: number };
    assert.equal(count.n, 0, '失败不落库');
  } finally {
    db.close();
  }
});

test('renderStatementSection：已 AC 的题同样注入题面（否则 AI 只能凭题名编造题意）', () => {
  const db = createDb(':memory:');
  try {
    // 预填题面到库
    db.prepare(
      'INSERT INTO problem_statements (platform, problem_key, text, source_url, fetched_at) VALUES (?, ?, ?, ?, ?)',
    ).run('codeforces', '100A', '题面 A：未通过的题', 'https://example.com/a', '2026-09-20T00:00:00Z');
    db.prepare(
      'INSERT INTO problem_statements (platform, problem_key, text, source_url, fetched_at) VALUES (?, ?, ?, ?, ?)',
    ).run('codeforces', '100B', '题面 B：已 AC 的题', 'https://example.com/b', '2026-09-20T00:00:00Z');

    const review = makeReview('codeforces', '100', [
      { problemKey: '100A', verdict: 'WA', url: 'https://example.com/a' },
      { problemKey: '100B', verdict: 'AC', url: 'https://example.com/b' },
    ], []);

    const lines = renderStatementSection(db, review);
    const joined = lines.join('\n');
    assert.ok(joined.includes('题面 A'), '应包含未通过题的题面');
    assert.ok(joined.includes('题面 B'), '已 AC 的题也必须注入题面——复盘要逐题点评，没题面就会编造');
    assert.ok(!joined.includes('未取到题面'), '两题都有缓存时不应出现空态声明');
    assert.ok(joined.includes('### 题面'), 'section 自带标题');
  } finally {
    db.close();
  }
});

test('renderStatementSection：已 AC 题按更小预算注入（1600 字符）', () => {
  const db = createDb(':memory:');
  try {
    // 已 AC 题面 3000 字符：应按 ACCEPTED_PROBLEM_BUDGET=1600 截断
    db.prepare(
      'INSERT INTO problem_statements (platform, problem_key, text, source_url, fetched_at) VALUES (?, ?, ?, ?, ?)',
    ).run('codeforces', '400B', '已 AC 题面正文 '.repeat(300), 'https://example.com/b', '2026-09-20T00:00:00Z');
    const review = makeReview('codeforces', '400', [
      { problemKey: '400B', verdict: 'AC', url: 'https://example.com/b' },
    ], []);
    const joined = renderStatementSection(db, review).join('\n');
    assert.ok(joined.includes('已 AC 题面正文'), '已 AC 题仍有题面');
    assert.ok(joined.includes('仅保留前 1600 字符'), '已 AC 题按更小预算截断');
  } finally {
    db.close();
  }
});

test('collectStatementTargets：含已 AC 题，优先级 未通过 → 未提交 → 已 AC', () => {
  const review = makeReview(
    'codeforces',
    '500',
    [
      { problemKey: '500C', verdict: 'AC', url: 'https://example.com/contest/500/problem/C' },
      { problemKey: '500A', verdict: 'WA', url: 'https://example.com/contest/500/problem/A' },
    ],
    [{ id: '500D', index: 'D' }],
  );
  const targets = collectStatementTargets(review);
  assert.deepEqual(
    targets.map((t) => t.problemKey),
    ['500A', '500D', '500C'],
    '未通过 → 未提交 → 已 AC',
  );
  assert.equal(targets[0]!.priority, 'unpassed');
  assert.equal(targets[1]!.priority, 'unsubmitted');
  assert.equal(targets[2]!.priority, 'accepted');
  assert.match(targets[1]!.url ?? '', /problem\/D$/, '未提交题按平台规则拼出题目页 URL');
});

test('prefetchProblemStatementsBackground：已 AC 的题也会被抓取（本 bug 的回归用例）', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    const requested: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      const body = 'Score : 100 points Problem Statement This is a sufficiently long statement body. '.repeat(6);
      return new Response(
        `<div id="task-statement"><span class="lang"><span class="lang-en"><h3>Problem Statement</h3><p>${body}</p><h3>Constraints</h3><p>1 &lt;= n &lt;= 100</p></span></span></div>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const review = makeReview('atcoder', 'abc600', [
      { problemKey: 'abc600_a', verdict: 'AC', url: 'https://atcoder.jp/contests/abc600/tasks/abc600_a' },
    ], []);

    await prefetchProblemStatementsBackground(db, review, mockFetch);
    assert.deepEqual(
      requested,
      ['https://atcoder.jp/contests/abc600/tasks/abc600_a'],
      '赛时已 AC 的题必须被预取题面',
    );
    const cached = readProblemStatements(db, [{ platform: 'atcoder', problemKey: 'abc600_a' }]);
    assert.equal(cached.size, 1, '题面应已落库，下一条消息即可注入');
  } finally {
    __resetProblemStatementsForTest();
    db.close();
  }
});

test('prefetchProblemStatementsBackground：多场复盘串行排队，后一场不被丢弃', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    const requested: string[] = [];
    const mockFetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      const body = 'Problem Statement This is a sufficiently long statement body for the task. '.repeat(6);
      return new Response(
        `<div id="task-statement"><span class="lang"><span class="lang-en"><p>${body}</p></span></span></div>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const first = makeReview('atcoder', 'abc601', [
      { problemKey: 'abc601_a', verdict: 'AC', url: 'https://atcoder.jp/contests/abc601/tasks/abc601_a' },
    ], []);
    const second = makeReview('atcoder', 'abc602', [
      { problemKey: 'abc602_a', verdict: 'AC', url: 'https://atcoder.jp/contests/abc602/tasks/abc602_a' },
    ], []);

    // 第二场在第一场还在跑时入队：旧实现会直接丢弃 → 那场题面永远补不上
    const p1 = prefetchProblemStatementsBackground(db, first, mockFetch);
    const p2 = prefetchProblemStatementsBackground(db, second, mockFetch);
    await Promise.all([p1, p2]);
    assert.deepEqual(requested.sort(), [
      'https://atcoder.jp/contests/abc601/tasks/abc601_a',
      'https://atcoder.jp/contests/abc602/tasks/abc602_a',
    ]);
  } finally {
    __resetProblemStatementsForTest();
    db.close();
  }
});

test('renderStatementSection：无缓存题面时仍显式声明「未取到题面」（防编造信号）', () => {
  const db = createDb(':memory:');
  try {
    const review = makeReview('atcoder', 'abc700', [
      { problemKey: 'abc700_a', verdict: 'WA', url: 'https://atcoder.jp/contests/abc700/tasks/abc700_a' },
    ], []);
    const lines = renderStatementSection(db, review);
    const joined = lines.join('\n');
    assert.ok(lines.length > 0, '不能返回空数组——空态必须被说清，否则模型会把"没给"当成"可以编"');
    assert.ok(joined.includes('### 题面'));
    assert.ok(joined.includes('未取到题面'));
    assert.ok(joined.includes('abc700_a'), '必须列出未取到题面的题号');
    assert.ok(joined.includes('后台按场次预取'), '有 URL 的可抓平台说明正在预取');
  } finally {
    db.close();
  }
});

test('renderStatementSection：平台无法抓题面时给出原因与替代路径（CF/牛客/无源平台）', () => {
  const db = createDb(':memory:');
  try {
    const cf = makeReview('codeforces', '1877', [
      { problemKey: '1877A', verdict: 'AC', url: 'https://codeforces.com/contest/1877/problem/A' },
    ], []);
    const cfJoined = renderStatementSection(db, cf).join('\n');
    assert.match(cfJoined, /无法自动抓取/);
    assert.match(cfJoined, /Cloudflare/, 'CF 要说明被 Cloudflare 拦');
    assert.match(cfJoined, /粘贴/, '要给出可执行替代路径：请用户粘贴题面');
    assert.doesNotMatch(cfJoined, /正在后台按场次预取/, '不能承诺取不到的题面');

    // 计蒜客：无公开来源，且题目链接也拿不到
    const jsk = makeReview('jisuanke', '37170', [], [{ id: '37170-101605', index: 'A' }]);
    const jskJoined = renderStatementSection(db, jsk).join('\n');
    assert.match(jskJoined, /无法自动抓取/);
    assert.match(jskJoined, /没有公开可抓的题面来源/);

    // 牛客：尽力抓（部分页面需登录）→ 不能写成"无法自动抓取"，要说明会尽量试、取不到请用户贴
    const nc = makeReview('nowcoder', '140489', [
      { problemKey: '323650', verdict: 'AC', url: 'https://ac.nowcoder.com/acm/problem/323650' },
    ], []);
    const ncJoined = renderStatementSection(db, nc).join('\n');
    assert.match(ncJoined, /尽力抓取/);
    assert.match(ncJoined, /仍取不到的题请让用户把题面粘贴/);
    assert.doesNotMatch(ncJoined, /无法自动抓取/);
    assert.match(ncJoined, /正在后台按场次预取/, '尽力抓的平台仍要说明在预取');
  } finally {
    db.close();
  }
});

test('renderStatementSection：预算超限时列出被跳过的题号', () => {
  const db = createDb(':memory:');
  try {
    // 填入大量题面（每题接近预算上限，超出总量预算）
    for (let i = 0; i < 10; i++) {
      const key = `300${String.fromCharCode(65 + i)}`;
      const text = 'x'.repeat(3500); // 每题 3500 字符，总量将超过 20000
      db.prepare(
        'INSERT INTO problem_statements (platform, problem_key, text, source_url, fetched_at) VALUES (?, ?, ?, ?, ?)',
      ).run('codeforces', key, text, `https://example.com/${key}`, '2026-09-20T00:00:00Z');
    }
    const review = makeReview(
      'codeforces', '300',
      Array.from({ length: 10 }, (_, i) => ({
        problemKey: `300${String.fromCharCode(65 + i)}`,
        verdict: 'WA',
        url: `https://example.com/${String.fromCharCode(65 + i)}`,
      })),
      [],
    );
    const lines = renderStatementSection(db, review);
    const joined = lines.join('\n');
    assert.ok(joined.includes('预算已满'), '应提示预算已满');
    assert.ok(joined.includes('未注入'), '应列出被跳过的题');
  } finally {
    db.close();
  }
});
