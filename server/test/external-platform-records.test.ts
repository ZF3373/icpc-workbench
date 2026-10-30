import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNowcoderAdapter } from '../src/adapters/nowcoder.ts';
import { createVjudgeAdapter } from '../src/adapters/vjudge.ts';
import { numericUid } from '../src/adapters/remoteRecords.ts';
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
  assert.equal(rows[0].problem.problemKey, '洛谷-P1001');
});

test('VJudge preserves failed verdicts with judge-specific test suffixes and capitalization', async () => {
  const adapter = createVjudgeAdapter(async () => Response.json({ data: [
    { runId: 1, time: timestamp, oj: 'CodeForces', probNum: '123A', status: 'Wrong answer on test 2', processing: false, userName: 'Fantasy____' },
    { runId: 2, time: timestamp, oj: 'CodeForces', probNum: '123A', status: 'Time limit exceeded on test 3', processing: false, userName: 'Fantasy____' },
  ] }));
  const rows = await adapter.fetchUserSubmissions('Fantasy____');
  assert.deepEqual(rows.map(r => r.verdict), ['WA', 'TLE']);
});
