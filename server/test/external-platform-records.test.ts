import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNowcoderAdapter } from '../src/adapters/nowcoder.ts';
import { createVjudgeAdapter } from '../src/adapters/vjudge.ts';
import { numericUid } from '../src/adapters/remoteRecords.ts';
import { problemIdentity } from '../src/problems/identity.ts';
import { addReviewFromUrl } from '../src/reviews/fromUrl.ts';
import { createDb } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { computeOverall } from '../src/analysis/stats.ts';
import type { FetchOptions } from '../src/adapters/types.ts';

const uuid = '40bf74658879460bbf5f1bfe772e8580';
const timestamp = 1788487236000;
const emptyPractice = '<table><tr><th>运行ID</th><th>提交时间</th></tr></table>';
const community = (id: number) => ({ problem: { questionUuid: uuid, title: '排序' }, submission: { id, createdDate: timestamp }, language: 'C++', status: { desc: '答案正确' } });

test('Nowcoder merges online programming, ACM practice and contest, filters account and deduplicates shared ACM IDs', async () => {
  const fetchFn: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('contest-joined-history')) return Response.json({ code: 0, data: { dataList: [{ contestId: 100 }], pageInfo: { pageCount: 1 } } });
    if (url.includes('submission-history')) return Response.json({ code: 0, data: { records: [community(5001)] } });
    if (url.includes('practice-coding')) return new Response('<table><tr><td><a href="?submissionId=5001">5001</a></td><td><a href="/acm/problem/10">排序</a></td><td>答案正确</td><td>0</td><td>0</td><td>0</td><td>0</td><td>C++</td><td>2026-08-01 10:00:00</td></tr></table>');
    if (url.includes('status-list')) {
      assert.equal(new URL(url).searchParams.get('searchUserName'), '123');
      return Response.json({ code: 0, data: { data: [
        { submissionId: 5001, userId: 123, problemId: 10, index: 'A', statusMessage: '答案正确', submitTime: timestamp },
        { submissionId: 5002, userId: 123, problemId: 11, index: 'B', statusMessage: '答案错误', submitTime: timestamp },
        { submissionId: 9999, userId: 456, problemId: 11, index: 'B', statusMessage: '答案正确', submitTime: timestamp },
      ], basicInfo: { pageCount: 1 } } });
    }
    throw new Error(url);
  };
  const rows = await createNowcoderAdapter(fetchFn).fetchUserSubmissions('https://www.nowcoder.com/users/123');
  assert.deepEqual(rows.map(r => r.externalId), ['5001', 'community:5001', '5002']);
  assert.equal(rows[1].problem.url, `https://www.nowcoder.com/practice/${uuid}`);
  assert.equal(rows[2].verdict, 'WA');
  assert.ok(rows.every(r => r.problem.platform === 'nowcoder'));
});

test('Nowcoder capped composite pages resume without dropping another source or the tail of a page', async () => {
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('contest-joined-history')) return Response.json({ code: 0, data: { dataList: [], pageInfo: { pageCount: 0 } } });
    if (url.includes('practice-coding')) return new Response(emptyPractice);
    const { pageNo } = JSON.parse(String(init?.body));
    const records = pageNo <= 3 ? Array.from({ length: 20 }, (_, i) => community((pageNo - 1) * 20 + i + 1)) : [];
    return Response.json({ code: 0, data: { records } });
  };
  const adapter = createNowcoderAdapter(fetchFn);
  const known = new Set<string>();
  let cursor: number | undefined;
  for (let i = 0; i < 6; i++) {
    const opts: FetchOptions = { knownExternalIds: known, maxSubmissions: 13, backfill: i > 0, backfillFromPage: cursor, pageDelayMs: 0 };
    const rows = await adapter.fetchUserSubmissions('123', opts);
    for (const r of rows) { assert.ok(!known.has(r.externalId)); known.add(r.externalId); }
    cursor = opts.backfillReachedPage;
    if (!opts.truncated) break;
  }
  assert.equal(known.size, 60);
});

test('Nowcoder distinguishes an empty history, malformed HTML and a failed supplementary API', async () => {
  for (const mode of ['empty', 'markup', 'failure']) {
    const fetchFn: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('contest-joined-history')) return Response.json({ code: 0, data: { dataList: [], pageInfo: { pageCount: 0 } } });
      if (url.includes('practice-coding')) return new Response(mode === 'markup' ? '<h1>登录或验证</h1>' : emptyPractice);
      return mode === 'failure' ? new Response('', { status: 429 }) : Response.json({ code: 0, data: { records: [] } });
    };
    const result = createNowcoderAdapter(fetchFn).fetchUserSubmissions('123');
    if (mode === 'empty') assert.deepEqual(await result, []);
    else await assert.rejects(result, mode === 'markup' ? /未解析到/ : /HTTP 429/);
  }
  assert.throws(() => numericUid('Fantasy____', 'nowcoder'), /数字 UID/);
  assert.throws(() => numericUid('https://evil.test/users/123', 'nowcoder'), /数字 UID/);
});

test('VJudge uses offset paging, ignores placeholder totals, other users and pending submissions', async () => {
  const offsets: string[] = [];
  const fetchFn: typeof fetch = async input => {
    const url = new URL(String(input)); offsets.push(url.searchParams.get('start')!);
    const start = Number(url.searchParams.get('start'));
    return Response.json({ recordsTotal: 9999999, data: start === 0 ? Array.from({ length: 20 }, (_, i) => ({ runId: i + 1, time: timestamp, oj: '洛谷', probNum: 'P1001', status: 'Accepted', processing: i === 0, userName: i === 1 ? 'Other' : 'Fantasy____' })) : [] });
  };
  const rows = await createVjudgeAdapter(fetchFn).fetchUserSubmissions('https://vjudge.net/user/Fantasy____', { pageDelayMs: 0 });
  assert.equal(rows.length, 18);
  assert.deepEqual(offsets, ['0', '20']);
  // 记录一律映射回**原 OJ**：保留 vjudge 身份会让同一道题在库里变成两行
  // （同步落 vjudge/洛谷-P1001、URL 导入落 luogu/P1001），
  // 同步来的 AC 在「通过链接添加」的复习条目上永远不显示，统计里也各算一次。
  assert.equal(rows[0].problem.platform, 'luogu');
  assert.equal(rows[0].problem.problemKey, 'P1001');
  assert.equal(rows[0].problem.url, 'https://www.luogu.com.cn/problem/P1001');
});

test('VJudge preserves failed verdicts with judge-specific test suffixes and capitalization', async () => {
  const adapter = createVjudgeAdapter(async () => Response.json({ data: [
    { runId: 1, time: timestamp, oj: 'CodeForces', probNum: '123A', status: 'Wrong answer on test 2', processing: false, userName: 'Fantasy____' },
    { runId: 2, time: timestamp, oj: 'CodeForces', probNum: '123A', status: 'Time limit exceeded on test 3', processing: false, userName: 'Fantasy____' },
  ] }));
  const rows = await adapter.fetchUserSubmissions('Fantasy____');
  assert.deepEqual(rows.map(r => r.verdict), ['WA', 'TLE']);
});

/**
 * 回归（P1-4）：同一道 VJudge 题曾被存成两个不同身份 ——
 * 同步侧落 `vjudge/洛谷-P1001`，URL 导入侧落 `luogu/P1001`，
 * identity 不同 → 通过 VJudge 同步来的 AC 在「通过链接添加」的复习条目上永远不显示。
 */
test('VJudge 同步与原 OJ 链接导入落到同一个身份（identity 一致）', async () => {
  const cases = [
    { oj: '洛谷', probNum: 'P1001', platform: 'luogu', key: 'P1001' },
    { oj: 'CodeForces', probNum: '1234A', platform: 'codeforces', key: '1234A' },
    { oj: 'Gym', probNum: '104821A', platform: 'codeforces', key: '104821A' },
    { oj: 'AtCoder', probNum: 'abc300_a', platform: 'atcoder', key: 'abc300_a' },
    { oj: 'QOJ', probNum: '9242', platform: 'qoj', key: '9242' },
  ] as const;
  const adapter = createVjudgeAdapter(async () => Response.json({
    data: cases.map((c, i) => ({
      runId: i + 1, time: timestamp, oj: c.oj, probNum: c.probNum,
      status: 'Accepted', processing: false, userName: 'Fantasy____',
    })),
  }));
  const rows = await adapter.fetchUserSubmissions('Fantasy____');

  const db = createDb(':memory:');
  try {
    for (const [i, c] of cases.entries()) {
      const synced = rows[i]!;
      assert.equal(synced.problem.platform, c.platform, c.oj);
      assert.equal(synced.problem.problemKey, c.key, c.oj);

      // 同一个平台：URL 导入侧解析出来的身份必须与之相同
      const imported = addReviewFromUrl(db, `https://vjudge.net/problem/${encodeURIComponent(c.oj)}-${c.probNum}`);
      const syncedIdentity = problemIdentity({ platform: synced.problem.platform, problemKey: synced.problem.problemKey });
      const importedIdentity = problemIdentity({ platform: imported.platform, problemKey: imported.problemKey });
      assert.equal(importedIdentity, syncedIdentity, `${c.oj}: 同步与导入必须是同一道题`);
    }
  } finally { db.close(); }
});

test('VJudge 未接入的原 OJ（SPOJ / SGU 等）不落库，避免幽灵题目', async () => {
  const adapter = createVjudgeAdapter(async () => Response.json({ data: [
    { runId: 1, time: timestamp, oj: 'SPOJ', probNum: 'TEST', status: 'Accepted', processing: false, userName: 'Fantasy____' },
    { runId: 2, time: timestamp, oj: 'SGU', probNum: '123', status: 'Accepted', processing: false, userName: 'Fantasy____' },
    { runId: 3, time: timestamp, oj: '洛谷', probNum: 'P1001', status: 'Accepted', processing: false, userName: 'Fantasy____' },
  ] }));
  const rows = await adapter.fetchUserSubmissions('Fantasy____');
  assert.deepEqual(rows.map(r => r.externalId), ['3'], '只有映射得到的 OJ 才落库');
});

/**
 * 映射回原 OJ 的连带影响：提交的「来源平台」不能跟着题目平台走。
 * 若不分开，VJudge 账号的提交会全部记在原 OJ 名下，
 * 「VJudge」在平台分布里永远显示 0，按账号筛选也查不到自己的记录。
 */
test('VJudge 提交记在 VJudge 名下，题目归原 OJ（来源与题目身份分离）', async () => {
  const adapter = createVjudgeAdapter(async () => Response.json({ data: [
    { runId: 1, time: timestamp, oj: '洛谷', probNum: 'P1001', status: 'Accepted', processing: false, userName: 'Fantasy____' },
  ] }));
  const rows = await adapter.fetchUserSubmissions('Fantasy____');

  const db = createDb(':memory:');
  try {
    insertNormalized(db, 1, rows, { account: 'Fantasy____', sourcePlatform: 'vjudge' });
    const sub = db.prepare('SELECT platform, account FROM submissions').get() as { platform: string; account: string };
    assert.equal(sub.platform, 'vjudge', '提交来源是 VJudge（用户在 VJudge 上提交的）');
    assert.equal(sub.account, 'Fantasy____');

    const prob = db.prepare('SELECT platform, problem_key FROM problems').get() as { platform: string; problem_key: string };
    assert.equal(prob.platform, 'luogu', '题目身份归原 OJ');
    assert.equal(prob.problem_key, 'P1001');

    // 平台分布：VJudge 有数据（而不是 0）
    const stats = computeOverall(db, 1);
    const vj = stats.byPlatform.find(p => p.platform === 'vjudge');
    assert.ok(vj && vj.attempts > 0, 'VJudge 必须出现在平台分布里且有数据');
  } finally { db.close(); }
});

/**
 * 回归（P1-6）：竞赛行把好标题覆盖成「牛客 <id>」。
 *
 * problemWritePolicy 的守卫是 `excluded.title != problems.problem_key`，
 * 而兜底标题 `'牛客 ' + problemId` 既不等于键也不像真标题 → 通过守卫，
 * 把练习行先落下的好标题覆盖掉，url 也从 /acm/problem/10 换成竞赛页地址。
 * 竞赛与练习共享题号空间，这条是常态路径而非边角。
 */
test('Nowcoder 竞赛行缺题名时不覆盖练习行已落的好标题', async () => {
  const fetchFn: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('contest-joined-history')) return Response.json({ code: 0, data: { dataList: [{ contestId: 100 }], pageInfo: { pageCount: 1 } } });
    if (url.includes('submission-history')) return Response.json({ code: 0, data: { records: [] } });
    if (url.includes('practice-coding')) return new Response('<table><tr><td><a href="?submissionId=5001">5001</a></td><td><a href="/acm/problem/10">A+B Problem</a></td><td>答案正确</td><td>0</td><td>0</td><td>0</td><td>0</td><td>C++</td><td>2026-08-01 10:00:00</td></tr></table>');
    if (url.includes('status-list')) {
      // 竞赛行：problemName 缺失（实测常态）
      return Response.json({ code: 0, data: { data: [
        { submissionId: 6002, userId: 123, problemId: 10, index: 'A', statusMessage: '答案错误', submitTime: timestamp },
      ], basicInfo: { pageCount: 1 } } });
    }
    throw new Error(url);
  };
  const rows = await createNowcoderAdapter(fetchFn).fetchUserSubmissions('123');
  const db = createDb(':memory:');
  try {
    // 先落练习行（有真标题），再落竞赛行（无题名）
    insertNormalized(db, 1, [rows.find(r => r.externalId === '5001')!], { account: '123' });
    insertNormalized(db, 1, [rows.find(r => r.externalId === '6002')!], { account: '123' });
    const prob = db.prepare("SELECT title, url FROM problems WHERE platform='nowcoder' AND problem_key='10'").get() as { title: string; url: string };
    assert.equal(prob.title, 'A+B Problem', '缺题名的竞赛行不得覆盖已有好标题');
    assert.equal(prob.url, 'https://ac.nowcoder.com/acm/problem/10', 'url 同样不得被换成竞赛页地址');
  } finally { db.close(); }
});

test('Nowcoder 竞赛行有真实题名时照常写入（守卫不是一刀切）', async () => {
  const fetchFn: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('contest-joined-history')) return Response.json({ code: 0, data: { dataList: [{ contestId: 100 }], pageInfo: { pageCount: 1 } } });
    if (url.includes('submission-history')) return Response.json({ code: 0, data: { records: [] } });
    if (url.includes('practice-coding')) return new Response('<table><tr><th>运行ID</th></tr></table>');
    if (url.includes('status-list')) {
      return Response.json({ code: 0, data: { data: [
        { submissionId: 6003, userId: 123, problemId: 20, index: 'B', statusMessage: '答案正确', submitTime: timestamp, problemName: '最长上升子序列' },
      ], basicInfo: { pageCount: 1 } } });
    }
    throw new Error(url);
  };
  const rows = await createNowcoderAdapter(fetchFn).fetchUserSubmissions('123');
  assert.equal(rows[0]!.problem.title, '最长上升子序列', '真实题名必须原样保留');
});
