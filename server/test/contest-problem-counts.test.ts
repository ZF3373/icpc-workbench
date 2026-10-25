import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { contestsRoutes } from '../src/routes/contests.ts';
import { deriveParticipatedContests, resolveContestGroup } from '../src/contests/participated.ts';
import { refreshContestProblemSets } from '../src/contests/problemSetRefresh.ts';
import { readParticipationSnapshot, fetchContestProblemSet } from '../src/contests/participationSources.ts';
import { __resetCfProblemsetForTest } from '../src/contests/cfProblemset.ts';
import { listenForTest } from './test-listen.ts';

function seed(db: Db): void {
  for (const [platform, contest] of [['codeforces', '2222'], ['atcoder', 'abc400']]) {
    db.prepare('INSERT INTO platform_accounts(user_id,platform,handle,enabled) VALUES(1,?,?,1)').run(platform, 'main');
    db.prepare('INSERT INTO participation_sync(user_id,platform,account,last_sync_at,backlog_done) VALUES(1,?,?,?,1)').run(platform, 'main', new Date().toISOString());
    db.prepare('INSERT INTO participated_contests(user_id,platform,account,contest_id,fetched_at) VALUES(1,?,?,?,?)').run(platform, 'main', contest, new Date().toISOString());
  }
  db.prepare("INSERT INTO calendar_cache(id,fetched_at,contests) VALUES(1,?,'[]')").run(new Date().toISOString());
}
function list(db: Db) {
  return deriveParticipatedContests(db, { sources: readParticipationSnapshot(db).byPlatform });
}
const requests: string[] = [];
const fetchOfficial = (async (input: string | URL | Request) => {
  const url = String(input);
  requests.push(url);
  if (url.includes('problemset.problems')) return Response.json({ status: 'OK', result: { problems: [
    { contestId: 2222, index: 'A', name: 'A', tags: [] },
    { contestId: 2222, index: 'B', name: 'B', tags: [] },
    { contestId: 2222, index: 'C', name: 'C', tags: [] },
  ] } });
  if (url.includes('/abc400/tasks')) return new Response('<a href="/contests/abc400/tasks/abc400_a">A</a><a href="/contests/abc400/tasks/abc400_b">B</a>');
  return new Response('', { status: 503 });
}) as typeof fetch;

test('参赛历史仍新鲜时 GET 也会后台补官方总题数，下一次读取自动显示且不重复请求', async () => {
  const db = createDb(':memory:');
  __resetCfProblemsetForTest();
  requests.length = 0;
  seed(db);
  const app = express();
  app.use('/api/contests', contestsRoutes(db, fetchOfficial));
  const server = await listenForTest(app);
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/contests/participated`;
    const first = await (await fetch(base)).json();
    assert.deepEqual(first.refreshing.sort(), ['atcoder', 'codeforces']);
    await refreshContestProblemSets(db, list(db), fetchOfficial).settled;
    const next = await (await fetch(base)).json();
    assert.deepEqual(next.refreshing, []);
    assert.equal(next.contests.find((c: { platform: string }) => c.platform === 'codeforces').totalProblemCount, 3);
    assert.equal(next.contests.find((c: { platform: string }) => c.platform === 'atcoder').totalProblemCount, 2);
    const count = requests.length;
    await refreshContestProblemSets(db, list(db), fetchOfficial).settled;
    assert.equal(requests.length, count);
    assert.ok(requests.every(url => !url.includes('standings') && !url.includes('user.rating')), '优先复用 CF 全集，不重刷参赛成绩');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    __resetCfProblemsetForTest();
  }
});

test('虚拟赛没有平台成绩行，也能持久缓存总题数与完整题单供列表和复盘共用', async () => {
  const db = createDb(':memory:');
  __resetCfProblemsetForTest();
  try {
    const id = db.prepare("INSERT INTO problems(platform,problem_key,title) VALUES('codeforces','2222A','A')").run().lastInsertRowid;
    db.prepare("INSERT INTO submissions(user_id,platform,account,problem_id,external_id,submitted_at,verdict,context) VALUES(1,'codeforces','main',?,'v1',?,'AC','virtual')").run(id, new Date().toISOString());
    await refreshContestProblemSets(db, deriveParticipatedContests(db), fetchOfficial).settled;
    const [c] = deriveParticipatedContests(db);
    assert.equal(c.totalProblemCount, 3);
    assert.equal(c.problemCountIsLowerBound, undefined, '题单已知时 problemCount 是权威总题数，不标下界');
    assert.equal(c.source, null, '题单不能伪造平台参赛成绩');
    const review = resolveContestGroup(db, c.key)!;
    assert.equal(review.problemSetKnown, true);
    assert.equal(review.unsubmittedProblems.length, 2);
    assert.equal((db.prepare('SELECT count(*) AS n FROM participated_contests').get() as { n: number }).n, 0);
  } finally { db.close(); __resetCfProblemsetForTest(); }
});

test('CF gym 场次题单两条路径都不可得时，problemCount 是已提交题数下界，不冒充全场总题数（issue #53）', async () => {
  const db = createDb(':memory:');
  __resetCfProblemsetForTest();
  try {
    // gym 虚拟赛：无平台成绩行；problemset.problems 全集不含 gym（contestId≥100000），
    // contest.standings 对 gym 匿名 401 —— 题单永远拉不到，总题数只能未知
    const g1 = db.prepare("INSERT INTO problems(platform,problem_key,title) VALUES('codeforces','103456A','G1')").run().lastInsertRowid;
    const g2 = db.prepare("INSERT INTO problems(platform,problem_key,title) VALUES('codeforces','103456B','G2')").run().lastInsertRowid;
    for (const [pid, eid] of [[g1, 'gv1'], [g2, 'gv2']] as const) {
      db.prepare("INSERT INTO submissions(user_id,platform,account,problem_id,external_id,submitted_at,verdict,context) VALUES(1,'codeforces','main',?,?,'2026-10-01T10:00:00.000Z','AC','virtual')").run(pid, eid);
    }
    const gym = list(db).find(c => c.platform === 'codeforces')!;
    assert.equal(gym.contestId, '103456');
    assert.equal(gym.problemCount, 2, '无题单时 problemCount 退化为已提交题数');
    assert.equal(gym.totalProblemCount ?? null, null);
    assert.equal(gym.problemCountIsLowerBound, true, '必须标记为下界，展示层不得写成「共 N 题」');
    const review = resolveContestGroup(db, gym.key)!;
    assert.equal(review.problemSetKnown, false);
  } finally { db.close(); __resetCfProblemsetForTest(); }
});

test('上游失败不阻断另一平台，重复 GET 去重，退避后可重试', async (t) => {
  const db = createDb(':memory:');
  __resetCfProblemsetForTest();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  seed(db);
  let attempts = 0;
  const flaky = (async (input: string | URL | Request) => {
    if (String(input).includes('atcoder.jp')) { attempts++; return attempts === 1 ? new Response('', { status: 503 }) : fetchOfficial(input); }
    return fetchOfficial(input);
  }) as typeof fetch;
  try {
    const first = refreshContestProblemSets(db, list(db), flaky);
    const duplicate = refreshContestProblemSets(db, list(db), flaky);
    assert.equal(first.settled, duplicate.settled);
    await first.settled;
    assert.equal(list(db).find(c => c.platform === 'codeforces')?.totalProblemCount, 3);
    assert.equal(list(db).find(c => c.platform === 'atcoder')?.totalProblemCount, null);
    await refreshContestProblemSets(db, list(db), flaky).settled;
    assert.equal(attempts, 1);
    t.mock.timers.tick(5 * 60_000 + 1);
    await refreshContestProblemSets(db, list(db), flaky).settled;
    assert.equal(list(db).find(c => c.platform === 'atcoder')?.totalProblemCount, 2);
  } finally { db.close(); __resetCfProblemsetForTest(); }
});

test('复盘抓取的题单同样可被参赛列表直接使用，不需要再次进入复盘', async () => {
  const db = createDb(':memory:');
  try {
    seed(db);
    await fetchContestProblemSet(db, 'atcoder', 'abc400', fetchOfficial);
    assert.equal(list(db).find(c => c.platform === 'atcoder')?.totalProblemCount, 2);
  } finally { db.close(); }
});

test('历史场次分批补齐，同场多个账号不重复请求，后续轮询继续处理剩余场次', async () => {
  const db = createDb(':memory:');
  let calls = 0;
  try {
    db.prepare("INSERT INTO platform_accounts(user_id,platform,handle,enabled) VALUES(1,'atcoder','main',1)").run();
    for (let i = 0; i < 7; i++) for (const account of ['main', 'alt']) {
      db.prepare("INSERT INTO participated_contests(user_id,platform,account,contest_id,fetched_at) VALUES(1,'atcoder',?,?,?)").run(account, `abc${700 + i}`, new Date().toISOString());
    }
    const fetchFn = (async (input: string | URL | Request) => {
      calls++;
      const slug = /contests\/([^/]+)/.exec(String(input))![1];
      return new Response(`<a href="/contests/${slug}/tasks/${slug}_a">A</a><a href="/contests/${slug}/tasks/${slug}_b">B</a>`);
    }) as typeof fetch;
    await refreshContestProblemSets(db, list(db), fetchFn).settled;
    assert.equal(calls, 6, '每轮有界，不把全量历史一次打给上游');
    assert.equal(list(db).filter(c => c.totalProblemCount === 2).length, 6);
    await refreshContestProblemSets(db, list(db), fetchFn).settled;
    assert.equal(calls, 7, '下一轮只补剩余一场');
    assert.equal(list(db).filter(c => c.totalProblemCount === 2).length, 7);
    assert.deepEqual(refreshContestProblemSets(db, list(db), fetchFn).platforms, []);
  } finally { db.close(); }
});

test('AtCoder 历史共用题按当前比赛官方题单归属，旧前缀题单可自动修复且题号用当前场次', async () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO platform_accounts(user_id,platform,handle,enabled) VALUES(1,'atcoder','main',1)").run();
    db.prepare("INSERT INTO participated_contests(user_id,platform,account,contest_id,problem_ids,fetched_at) VALUES(1,'atcoder','main','abc042',?,?)")
      .run(JSON.stringify([{ id: 'abc042_a', index: 'A' }, { id: 'abc042_b', index: 'B' }]), new Date().toISOString());
    db.prepare("INSERT INTO contest_problem_sets(platform,contest_id,refs,fetched_at) VALUES('atcoder','abc042',?,?)")
      .run(JSON.stringify([{ id: 'abc042_a' }, { id: 'abc042_b' }]), new Date().toISOString());
    const html = `<table><tbody>
      <tr><td><a href="/contests/abc042/tasks/abc042_a">A</a></td><td><a href="/contests/abc042/tasks/abc042_a">Iroha and Haiku</a></td></tr>
      <tr><td><a href="/contests/abc042/tasks/abc042_b">B</a></td><td><a href="/contests/abc042/tasks/abc042_b">Iroha Loves Strings</a></td></tr>
      <tr><td><a href="/contests/abc042/tasks/arc058_a">C</a></td><td><a href="/contests/abc042/tasks/arc058_a">Iroha's Obsession</a></td></tr>
      <tr><td><a href="/contests/abc042/tasks/arc058_b">D</a></td><td><a href="/contests/abc042/tasks/arc058_b">Iroha and a Grid</a></td></tr>
      <tr><td><a href="/contests/other/tasks/other_a">X</a></td></tr>
    </tbody></table>`;
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response(html); }) as typeof fetch;
    assert.equal(list(db)[0].totalProblemCount, null, '旧前缀题单未验证完整性，不先宣称全场只有两题');
    await refreshContestProblemSets(db, list(db), fetchFn).settled;
    assert.equal(list(db)[0].totalProblemCount, 4);
    const review = resolveContestGroup(db, 'atcoder:abc042', { sources: readParticipationSnapshot(db).byPlatform })!;
    assert.equal(review.problemSetKnown, true);
    assert.deepEqual(review.unsubmittedProblems.map(p => [p.id, p.index]), [
      ['abc042_a', 'A'], ['abc042_b', 'B'], ['arc058_a', 'C'], ['arc058_b', 'D'],
    ]);
    assert.equal(readParticipationSnapshot(db).byPlatform.atcoder?.[0].problems?.length, 4, '权威题单共用题不被旧归属校验丢弃');
    await refreshContestProblemSets(db, list(db), fetchFn).settled;
    assert.equal(calls, 1);
  } finally { db.close(); }
});
