import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import {
  collectStatementTargets,
  fetchProblemStatement,
  prefetchProblemStatementsBackground,
  readProblemStatements,
  renderStatementSection,
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

test('fetchProblemStatement：CF 题面抓取并落库', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    const mockHtml = `
      <html><body>
        <nav>navigation</nav>
        <div class="problem-statement">
          <div class="header">A. Water Problem</div>
          <div class="content"><p>Given an integer n, output YES or NO.</p></div>
          <div class="input-specification"><p>n is between 1 and 100.</p></div>
          <div class="output-specification"><p>Print YES or NO.</p></div>
        </div>
        <footer>footer stuff</footer>
      </body></html>
    `;
    const mockFetch = (async () =>
      new Response(mockHtml, { status: 200, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
    const text = await fetchProblemStatement(
      db, 'codeforces', '1877A',
      'https://codeforces.com/contest/1877/problem/A', mockFetch,
    );
    assert.ok(text && text.length > 10, '应返回非空题面正文');
    assert.ok(text!.includes('Water Problem') || text!.includes('YES or NO'), '应包含题面内容');
    assert.ok(!text!.includes('navigation'), '不应包含导航噪声');
    assert.ok(!text!.includes('footer stuff'), '不应包含页脚噪声');

    // 落库验证
    const row = db
      .prepare('SELECT text, source_url FROM problem_statements WHERE platform = ? AND problem_key = ?')
      .get('codeforces', '1877A') as { text: string; source_url: string };
    assert.ok(row.text.length > 10, '题面应已落库');
    assert.equal(row.source_url, 'https://codeforces.com/contest/1877/problem/A');

    // 读库验证
    const stmts = readProblemStatements(db, [{ platform: 'codeforces', problemKey: '1877A' }]);
    assert.equal(stmts.size, 1, '读库应命中');
    assert.ok(stmts.get('1877A')!.length > 10);
  } finally {
    db.close();
  }
});

test('fetchProblemStatement：失败返回 null 不落库', async () => {
  __resetProblemStatementsForTest();
  const db = createDb(':memory:');
  try {
    const brokenFetch = (async () => new Response('error', { status: 500 })) as typeof fetch;
    const text = await fetchProblemStatement(
      db, 'codeforces', '9999A',
      'https://codeforces.com/contest/9999/problem/A', brokenFetch,
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
      const body = 'This is a sufficiently long statement body. '.repeat(20);
      return new Response(
        `<div class="problem-statement"><div class="content"><p>${body}</p></div></div></div>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const review = makeReview('codeforces', '600', [
      { problemKey: '600A', verdict: 'AC', url: 'https://codeforces.com/contest/600/problem/A' },
    ], []);

    await prefetchProblemStatementsBackground(db, review, mockFetch);
    assert.deepEqual(
      requested,
      ['https://codeforces.com/contest/600/problem/A'],
      '赛时已 AC 的题必须被预取题面',
    );
    const cached = readProblemStatements(db, [{ platform: 'codeforces', problemKey: '600A' }]);
    assert.equal(cached.size, 1, '题面应已落库，下一条消息即可注入');
  } finally {
    __resetProblemStatementsForTest();
    db.close();
  }
});

test('renderStatementSection：无缓存题面时仍显式声明「未取到题面」（防编造信号）', () => {
  const db = createDb(':memory:');
  try {
    const review = makeReview('codeforces', '200', [
      { problemKey: '200A', verdict: 'WA', url: 'https://example.com/contest/200/problem/A' },
    ], []);
    const lines = renderStatementSection(db, review);
    const joined = lines.join('\n');
    assert.ok(lines.length > 0, '不能返回空数组——空态必须被说清，否则模型会把"没给"当成"可以编"');
    assert.ok(joined.includes('### 题面'));
    assert.ok(joined.includes('未取到题面'));
    assert.ok(joined.includes('200A'), '必须列出未取到题面的题号');
    assert.ok(joined.includes('后台按场次预取'), '有 URL 的题说明正在预取');
  } finally {
    db.close();
  }
});

test('renderStatementSection：平台无题面来源的题单独说明', () => {
  const db = createDb(':memory:');
  try {
    // 计蒜客题目页无稳定可抓取来源 → problemPageUrl 返回 null
    const review = makeReview('jisuanke', '37170', [], [{ id: '37170-101605', index: 'A' }]);
    const joined = renderStatementSection(db, review).join('\n');
    assert.match(joined, /未取到题面/);
    assert.match(joined, /没有可抓取的题面来源/, '无 URL 的题要说明平台不提供，而不是"正在抓取"');
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
