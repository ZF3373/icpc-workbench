import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJisuankeAdapter,
  fetchJisuankePracticeProblems,
  fetchJisuankeProblemSubmissions,
  fetchParticipatedContests,
  mapJisuankeVerdict,
  parseJisuankeTime,
  jisuankeProblemUrl,
  type JisuankeSubmissionRow,
} from '../src/adapters/jisuanke.ts';
import { ManualImportRequiredError, type FetchOptions } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

/**
 * 计蒜客适配器测试。
 * 取数路径：GET /api/contests?page=N&hasParticipated=true（我参加的比赛，数组）
 *         → GET /api/contest/problems?contestId=X（identifier → problemId）
 *         → GET /api/contest/submissions?contestId=X（提交数组，未登录 302）。
 */

const COOKIE = 'session=jsk-session-token';

/** 请求路由器：按 URL 子串匹配返回预置响应（与 daimayuan 测试同款） */
function router(
  pages: Record<string, string | (() => string)>,
  opts: { status?: number; location?: string; seenUrls?: string[]; seenHeaders?: Record<string, string>[] } = {},
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    opts.seenUrls?.push(u);
    if (opts.seenHeaders) opts.seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
    for (const [key, value] of Object.entries(pages)) {
      if (u.includes(key)) {
        if (opts.status === 302) return new Response('', { status: 302, headers: { location: opts.location ?? '/login' } });
        return new Response(typeof value === 'function' ? value() : value, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** 计蒜客北京时间字符串 → 列表接口的 startTime 字段 */
function bjTime(epochMs: number): string {
  const d = new Date(epochMs + 8 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function submissionRow(o: Partial<JisuankeSubmissionRow>): JisuankeSubmissionRow {
  return { hashId: 'h-default', identifier: 'A', title: '默认题', time: 0, status: 'AC', language: 'c++', ...o };
}

// ---------- 纯函数 ----------

test('jisuanke: mapJisuankeVerdict maps ojStatus strings and numeric statuses', () => {
  assert.equal(mapJisuankeVerdict('AC'), 'AC');
  assert.equal(mapJisuankeVerdict('WA'), 'WA');
  assert.equal(mapJisuankeVerdict('PE'), 'WA');
  assert.equal(mapJisuankeVerdict('TL'), 'TLE');
  assert.equal(mapJisuankeVerdict('ML'), 'MLE');
  assert.equal(mapJisuankeVerdict('OL'), 'RE');
  assert.equal(mapJisuankeVerdict('RE_SEGV'), 'RE');
  assert.equal(mapJisuankeVerdict('CE'), 'CE');
  assert.equal(mapJisuankeVerdict('CTL'), 'CE');
  // 评测中 / 系统态不落库
  assert.equal(mapJisuankeVerdict('WT0'), null);
  assert.equal(mapJisuankeVerdict('RI'), null);
  assert.equal(mapJisuankeVerdict('JE'), null);
  // 数字域：二元结果制 0/1；挑战题 ojStatus 序号
  assert.equal(mapJisuankeVerdict(0), 'WA');
  assert.equal(mapJisuankeVerdict(1), 'AC');
  assert.equal(mapJisuankeVerdict(4), 'AC');
  assert.equal(mapJisuankeVerdict(6), 'WA');
  assert.equal(mapJisuankeVerdict(7), 'TLE');
  assert.equal(mapJisuankeVerdict(11), 'CE');
  assert.equal(mapJisuankeVerdict(2), null); // CI 编译中
  assert.equal(mapJisuankeVerdict('42'), null);
  assert.equal(mapJisuankeVerdict(undefined), null);
});

test('jisuanke: parseJisuankeTime treats Beijing time, invalid → 0', () => {
  // 2026-09-05 10:00:00 北京时间 = 2026-09-05 02:00:00 UTC
  assert.equal(parseJisuankeTime('2026-09-05 10:00:00'), Date.UTC(2026, 8, 5, 2, 0, 0));
  assert.equal(parseJisuankeTime('garbage'), 0);
  assert.equal(parseJisuankeTime(undefined), 0);
});

test('jisuanke: jisuankeProblemUrl parses contest-problem key', () => {
  assert.equal(jisuankeProblemUrl('37176-123'), 'https://www.jisuanke.com/contest/37176/problem/123');
  assert.equal(jisuankeProblemUrl('no-key'), 'https://www.jisuanke.com/contests');
});

// ---------- fetchParticipatedContests ----------

test('jisuanke: fetchParticipatedContests pages until empty and sorts newest first', async () => {
  const seenUrls: string[] = [];
  const fetchFn = router(
    {
      'page=1': JSON.stringify([
        { contestId: 101, title: '旧赛', startTime: bjTime(Date.UTC(2026, 0, 1)) },
        { contestId: 102, title: '新赛', startTime: bjTime(Date.UTC(2026, 8, 1)) },
      ]),
      'page=2': JSON.stringify([]),
    },
    { seenUrls },
  );
  const contests = await fetchParticipatedContests(fetchFn, COOKIE);
  assert.deepEqual(contests.map((c) => c.contestId), [102, 101]); // 新→旧
  assert.ok(seenUrls.some((u) => u.includes('hasParticipated=true')));
});

// ---------- fetchUserSubmissions ----------

test('jisuanke: without cookie throws ManualImportRequiredError', async () => {
  const adapter = createJisuankeAdapter();
  await assert.rejects(() => adapter.fetchUserSubmissions('nick'), ManualImportRequiredError);
});

test('jisuanke: empty participated list raises ManualImportRequiredError', async () => {
  const adapter = createJisuankeAdapter(router({ 'hasParticipated=true': '[]' }));
  await assert.rejects(
    () => adapter.fetchUserSubmissions('nick', { cookie: COOKIE }),
    /参赛列表为空/,
  );
});

test('jisuanke: fetch maps verdicts per contest, builds urls, skips judging rows', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([{ contestId: 37176, startTime: bjTime(Date.UTC(2026, 8, 5)) }]),
    'api/contest/problems?contestId=37176': JSON.stringify([ // /api/contest/problems
      { problemId: 90001, identifier: 'A', title: 'A 题' },
      { problemId: 90002, identifier: 'B', title: 'B 题' },
    ]),
    'api/contest/submissions?contestId=37176': JSON.stringify([
      submissionRow({ hashId: 'h1', identifier: 'A', title: 'A 题', time: 1788768000, status: 'AC' }),
      submissionRow({ hashId: 'h2', identifier: 'B', title: 'B 题', time: 1788767900, status: 'TL' }),
      submissionRow({ hashId: 'h3', identifier: 'A', title: 'A 题', time: 1788767800, status: 'WT0' }), // 评测中跳过
      submissionRow({ hashId: 'h4', identifier: 'B', title: 'B 题', time: 1788767700, status: 1 }), // 二元结果制 AC
      submissionRow({ hashId: 'h5', identifier: 'A', title: 'A 题', time: 1788767600, status: 0 }), // 二元结果制 WA
    ]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('nick', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(subs.length, 4); // WT0（评测中）跳过
  assert.equal(subs[0].verdict, 'AC');
  assert.equal(subs[0].problem.platform, 'jisuanke');
  assert.equal(subs[0].problem.problemKey, '37176-90001'); // 经题目表映射到 problemId
  assert.equal(subs[0].problem.url, 'https://www.jisuanke.com/contest/37176/problem/90001');
  assert.equal(subs[0].language, 'c++');
  assert.equal(subs[0].submittedAt, '2026-09-07T08:00:00.000Z');
  assert.equal(subs[1].verdict, 'TLE');
  assert.equal(subs[2].verdict, 'AC'); // 二元结果制 status=1
  assert.equal(subs[2].problem.problemKey, '37176-90002');
  assert.equal(subs[3].verdict, 'WA'); // 二元结果制 status=0
});

test('jisuanke: incremental stops at first fully-known contest', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([
      { contestId: 201, startTime: bjTime(Date.UTC(2026, 7, 1)) },
      { contestId: 202, startTime: bjTime(Date.UTC(2026, 6, 1)) },
    ]),
    'api/contest/submissions?contestId=201': JSON.stringify([
      submissionRow({ hashId: 'known1', time: 100 }),
      submissionRow({ hashId: 'known2', time: 90 }),
    ]),
    'api/contest/submissions?contestId=202': () => {
      throw new Error('should not fetch older contest');
    },
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('nick', {
    cookie: COOKIE,
    knownExternalIds: new Set(['known1', 'known2']),
    pageDelayMs: 0,
  });
  assert.equal(subs.length, 0);
});

test('jisuanke: known rows skipped, newer contest still fetched; unknown contests continue', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([
      { contestId: 301, startTime: bjTime(Date.UTC(2026, 8, 1)) },
      { contestId: 302, startTime: bjTime(Date.UTC(2026, 7, 1)) },
    ]),
    // 302 场无提交（HasNoSubmissions 错误对象形态）：跳过不中断
    'api/contest/submissions?contestId=301': JSON.stringify({ error: 'HasNoSubmissions' }),
    'api/contest/submissions?contestId=302': JSON.stringify([
      submissionRow({ hashId: 'old-known', time: 50, status: 'AC' }),
      submissionRow({ hashId: 'old-new', time: 40, status: 'WA' }),
    ]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const subs = await adapter.fetchUserSubmissions('nick', {
    cookie: COOKIE,
    knownExternalIds: new Set(['old-known']),
    pageDelayMs: 0,
  });
  assert.deepEqual(subs.map((s) => s.externalId), ['old-new']);
});

test('jisuanke: maxSubmissions cap marks truncated with contest index cursor', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([
      { contestId: 401, startTime: bjTime(Date.UTC(2026, 8, 1)) },
      { contestId: 402, startTime: bjTime(Date.UTC(2026, 7, 1)) },
      { contestId: 403, startTime: bjTime(Date.UTC(2026, 6, 1)) },
    ]),
    'api/contest/submissions?contestId=401': JSON.stringify([
      submissionRow({ hashId: 'c1a', time: 300, status: 'AC' }),
      submissionRow({ hashId: 'c1b', time: 290, status: 'AC' }),
    ]),
    'api/contest/submissions?contestId=402': JSON.stringify([
      submissionRow({ hashId: 'c2a', time: 200, status: 'AC' }),
      submissionRow({ hashId: 'c2b', time: 190, status: 'AC' }), // 达到 max=3 截断
    ]),
    'api/contest/submissions?contestId=403': JSON.stringify([submissionRow({ hashId: 'c3a', time: 100 })]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const opts: FetchOptions = { cookie: COOKIE, maxSubmissions: 3, pageDelayMs: 0 };
  const subs = await adapter.fetchUserSubmissions('nick', opts);
  assert.equal(subs.length, 3);
  assert.equal(opts.truncated, true);
  assert.equal(opts.backfillReachedPage, 2); // 处理到第 2 场
});

test('jisuanke: backfill resumes from contest index cursor and skips known rows', async () => {
  const fetchFn = router({
    'hasParticipated=true': JSON.stringify([
      { contestId: 501, startTime: bjTime(Date.UTC(2026, 8, 1)) },
      { contestId: 502, startTime: bjTime(Date.UTC(2026, 7, 1)) },
      { contestId: 503, startTime: bjTime(Date.UTC(2026, 6, 1)) },
    ]),
    'api/contest/submissions?contestId=501': () => {
      throw new Error('backfill should reprocess contest 501 but fetch is stubbed here');
    },
    'api/contest/submissions?contestId=502': JSON.stringify([submissionRow({ hashId: 'seen', time: 200, status: 'AC' })]),
    'api/contest/submissions?contestId=503': JSON.stringify([submissionRow({ hashId: 'ancient', time: 100, status: 'AC' })]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  // backfillFromPage=2：跳过第 1 场（501），从 502 续拉
  const subs = await adapter.fetchUserSubmissions('nick', {
    cookie: COOKIE,
    backfill: true,
    backfillFromPage: 2,
    knownExternalIds: new Set(['seen']),
    pageDelayMs: 0,
  });
  assert.deepEqual(subs.map((s) => s.externalId), ['ancient']);
});

test('jisuanke: expired login (302 on submissions) raises ManualImportRequiredError', async () => {
  const adapter = createJisuankeAdapter(
    router(
      {
        'hasParticipated=true': JSON.stringify([{ contestId: 601 }]),
        'api/contest/submissions?contestId=601': '[]',
      },
      { status: 302, location: '/login' },
    ),
  );
  await assert.rejects(() => adapter.fetchUserSubmissions('nick', { cookie: 'stale', pageDelayMs: 0 }), /登录态已失效/);
});

// ---------- 练习（题库）提交：默认开启，settings['jisuanke.practiceSync'] 可关 ----------

/** JSON 响应小工具（练习路径需要按 page/status 参数分流，用不上通用 router） */
function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('jisuanke: 练习预筛：status=passed/attempted 两次过滤请求，解析题库行', async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    seen.push(u);
    if (u.includes('status=passed')) {
      return new Response(JSON.stringify({ total: 2, problems: [
        { problemId: 34486, problemIdentifier: 'T1001', title: '计算A+B', difficultyType: 'level1', problemTags: [{ tagName: '入门', type: 'difficulty' }, { tagName: '输入和输出', type: 'knowledge' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('status=attempted')) {
      return new Response(JSON.stringify({ total: 1, problems: [
        { problemId: 34487, problemIdentifier: 'T1002', title: '输出马里奥', difficultyType: 'level1', problemTags: [] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const r = await fetchJisuankePracticeProblems(fetchFn, COOKIE, { pageDelayMs: 0 });
  assert.deepEqual(r.problems.map((p) => p.problemIdentifier), ['T1001', 'T1002']);
  assert.equal(r.problems[0].difficultyType, 'level1');
  assert.deepEqual(r.problems[0].tags, ['输入和输出']);
  assert.ok(seen.some((u) => u.includes('status=passed')));
  assert.ok(seen.some((u) => u.includes('status=attempted')));
});

test('jisuanke: 练习提交：北京时间字符串 → ISO，hashId 为 externalId，total 用于早停', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({
    submissions: [{ hashId: '4zoBj7', language: 'c++', status: 'AC', time: '2026-09-13 12:37:47', usedTime: 1, usedMemory: 3820 }],
    total: 1,
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const r = await fetchJisuankeProblemSubmissions(fetchFn, COOKIE, 34486, 1);
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].hashId, '4zoBj7');
  assert.equal(r.rows[0].time, '2026-09-13 12:37:47');
});

test('jisuanke: 练习提交入库键用 problemIdentifier，且带难度与标签（与题库行合并）', async () => {
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    if (u.includes('/api/problems')) {
      return new Response(JSON.stringify({ total: 1, problems: [
        { problemId: 34486, problemIdentifier: 'T1001', title: '计算A+B', difficultyType: 'level1', problemTags: [{ tagName: '输入和输出', type: 'knowledge' }] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/problem/submissions')) {
      return new Response(JSON.stringify({ submissions: [{ hashId: 'h1', status: 'AC', time: '2026-09-13 12:37:47', language: 'c++' }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const adapter = createJisuankeAdapter(fetchFn);
  const out = await adapter.fetchUserSubmissions('hieZF123', { cookie: COOKIE, pageDelayMs: 0 });
  const practice = out.find((s) => s.problem.problemKey === 'T1001');
  assert.ok(practice, '练习提交应按 problemIdentifier 入库');
  assert.equal(practice.verdict, 'AC');
  assert.equal(practice.problem.difficulty, 800);
  assert.equal(practice.problem.nativeDifficulty, 'level1');
  assert.deepEqual(practice.problem.tags, ['输入和输出']);
  assert.equal(practice.problem.url, 'https://www.jisuanke.com/problem/T1001');
});

test('jisuanke: 练习增量——整页已知且 total 已覆盖则跳过该题（1 次请求），有新题的题翻满剩余页', async () => {
  const calls: string[] = [];
  const knownRows = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ hashId: `${prefix}-${i}`, status: 'AC', time: '2026-09-13 12:37:47' }));
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    const url = new URL(u);
    if (u.includes('/api/problems')) {
      const status = url.searchParams.get('status');
      if (status !== 'passed') return jsonRes({ total: 0, problems: [] });
      return jsonRes({ total: 3, problems: [
        { problemId: 1, problemIdentifier: 'T2001', title: 'A', difficultyType: 'level1', problemTags: [] },
        { problemId: 2, problemIdentifier: 'T2002', title: 'B', difficultyType: 'level2', problemTags: [] },
        { problemId: 3, problemIdentifier: 'T2003', title: 'C', difficultyType: 'level3', problemTags: [] },
      ] });
    }
    if (u.includes('/api/problem/submissions')) {
      const problemId = Number(url.searchParams.get('problemId'));
      const page = Number(url.searchParams.get('page'));
      calls.push(`${problemId}:${page}`);
      // 题 1：整页已知且 total=1（一次请求即可判定无新增）
      if (problemId === 1) return jsonRes({ submissions: knownRows(1, 'k1'), total: 1 });
      // 题 2：有新提交
      if (problemId === 2) return jsonRes({ submissions: [{ hashId: 'new-2', status: 'WA', time: '2026-09-13 12:37:47' }], total: 1 });
      // 题 3：首页 20 条全已知，但 total=21 → 必须继续翻第 2 页拿到新提交
      if (page === 1) return jsonRes({ submissions: knownRows(20, 'k3'), total: 21 });
      return jsonRes({ submissions: [{ hashId: 'new-3', status: 'AC', time: '2026-09-13 12:37:47' }], total: 21 });
    }
    return jsonRes([]);
  }) as unknown as typeof fetch;

  const adapter = createJisuankeAdapter(fetchFn);
  const known = new Set<string>([...knownRows(1, 'k1').map((r) => r.hashId), ...knownRows(20, 'k3').map((r) => r.hashId)]);
  const out = await adapter.fetchUserSubmissions('u', { cookie: COOKIE, pageDelayMs: 0, knownExternalIds: known });
  assert.deepEqual(calls, ['1:1', '2:1', '3:1', '3:2']); // 题 1 只 1 次请求（早停）；题 3 翻满 2 页
  assert.deepEqual(out.map((s) => s.externalId), ['new-2', 'new-3']);
});

test('jisuanke: 练习分批——单次最多 40 题，回写负数游标，下一轮从游标续拉', async () => {
  const TOTAL = 45;
  const all = Array.from({ length: TOTAL }, (_, i) => ({
    problemId: 9001 + i,
    problemIdentifier: `T${9001 + i}`,
    title: `题 ${9001 + i}`,
    difficultyType: 'level1',
    problemTags: [],
  }));
  const requested: number[] = [];
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    const url = new URL(u);
    if (u.includes('/api/problems')) {
      const page = Number(url.searchParams.get('page'));
      if (url.searchParams.get('status') !== 'passed') return jsonRes({ total: 0, problems: [] });
      return jsonRes({ total: TOTAL, problems: all.slice((page - 1) * 20, page * 20) });
    }
    if (u.includes('/api/problem/submissions')) {
      const problemId = Number(url.searchParams.get('problemId'));
      requested.push(problemId);
      return jsonRes({ submissions: [{ hashId: `h-${problemId}`, status: 'AC', time: '2026-09-13 12:37:47' }], total: 1 });
    }
    return jsonRes([]);
  }) as unknown as typeof fetch;

  const adapter = createJisuankeAdapter(fetchFn);
  const opts: FetchOptions = { cookie: COOKIE, pageDelayMs: 0 };
  const first = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(first.length, 40); // 单次处理题目数上限
  assert.equal(requested.length, 40);
  assert.equal(opts.truncated, true);
  assert.equal(opts.backfillReachedPage, -40); // 负数 = 练习题目序号（与比赛序号区分）

  // 第二轮：从游标续拉（-40 → 第 40 题起），已入库的题按已知跳过
  const opts2: FetchOptions = {
    cookie: COOKIE, pageDelayMs: 0, backfill: true, backfillFromPage: -40,
    knownExternalIds: new Set(first.map((s) => s.externalId)),
  };
  const second = await adapter.fetchUserSubmissions('u', opts2);
  assert.deepEqual(second.map((s) => s.problem.problemKey), ['T9041', 'T9042', 'T9043', 'T9044', 'T9045']);
  assert.notEqual(opts2.truncated, true); // 续拉到底，不再截断
});

test('jisuanke: practiceSync=false 时不请求题库接口（仅比赛路径）', async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    seen.push(u);
    if (u.includes('hasParticipated=true')) return jsonRes([{ contestId: 9101, startTime: '2026-09-05 10:00:00' }]);
    if (u.includes('api/contest/submissions')) return jsonRes([{ hashId: 'c1', identifier: 'A', title: 'A 题', time: 1788768000, status: 'AC' }]);
    return jsonRes([]);
  }) as unknown as typeof fetch;
  const adapter = createJisuankeAdapter(fetchFn);
  const out = await adapter.fetchUserSubmissions('u', { cookie: COOKIE, pageDelayMs: 0, practiceSync: false });
  assert.equal(seen.filter((u) => u.includes('/api/problems')).length, 0);
  assert.deepEqual(out.map((s) => s.externalId), ['c1']);
});

test('jisuanke: days 窗口模式不跑练习段（无 knownIds/无可持久化游标），比赛段照常', async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const u = String(input);
    seen.push(u);
    if (u.includes('hasParticipated=true')) return jsonRes([{ contestId: 9201, startTime: '2026-09-05 10:00:00' }]);
    if (u.includes('api/contest/submissions')) return jsonRes([{ hashId: 'w1', identifier: 'A', title: 'A 题', time: 1788768000, status: 'AC' }]);
    return jsonRes([]);
  }) as unknown as typeof fetch;
  const adapter = createJisuankeAdapter(fetchFn);
  const out = await adapter.fetchUserSubmissions('u', {
    cookie: COOKIE, pageDelayMs: 0, windowSince: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(seen.filter((u) => u.includes('/api/problems')).length, 0);
  assert.deepEqual(out.map((s) => s.externalId), ['w1']);
});

// ---------- checkAuth / 注册 ----------

test('jisuanke: checkAuth validates via /api/user/info uuid field', async () => {
  const ok = createJisuankeAdapter(router({ 'api/user/info': JSON.stringify({ websocket: {}, uuid: 'u-123', name: '蒜徒' }) }));
  const rOk = await ok.checkAuth!({ cookie: COOKIE });
  assert.equal(rOk.ok, true);
  assert.match(rOk.message, /蒜徒/);

  // 未登录响应不含 uuid
  const bad = createJisuankeAdapter(router({ 'api/user/info': JSON.stringify({ websocket: {} }) }));
  const rBad = await bad.checkAuth!({ cookie: 'stale' });
  assert.equal(rBad.ok, false);
  assert.match(rBad.message, /Cookie 未通过登录校验/);

  const stale302 = createJisuankeAdapter(router({ 'api/user/info': '{}' }, { status: 302 }));
  const r302 = await stale302.checkAuth!({ cookie: 'stale' });
  assert.equal(r302.ok, false);

  const netFail = createJisuankeAdapter((async () => {
    throw new Error('fetch failed');
  }) as typeof fetch);
  const rNet = await netFail.checkAuth!({ cookie: 'c' });
  assert.equal(rNet.ok, false);
  assert.match(rNet.message, /无法连接/);
});

test('jisuanke: registered via initAdapters, problemUrl format', () => {
  initAdapters();
  assert.equal(getAdapter('jisuanke')?.platform, 'jisuanke');
  const adapter = createJisuankeAdapter();
  assert.equal(adapter.problemUrl({ problemKey: '37176-123' }), 'https://www.jisuanke.com/contest/37176/problem/123');
});

// ---------- Phase 2：题库难度映射 / 公开题库拉取 / 赛事归一化 ----------

import { jisuankeDifficultyToRating } from '../src/adapters/jisuanke.ts';
import { fetchJisuankeBank } from '../src/adapters/problemBank.ts';
import { classifyJisuankeContest, fetchJisuankeContests, toJisuankeContest } from '../src/contests/jisuankeContests.ts';

test('jisuanke: jisuankeDifficultyToRating maps level strings/numbers via 统一难度表', () => {
  assert.equal(jisuankeDifficultyToRating('level1'), 800);
  assert.equal(jisuankeDifficultyToRating('level4'), 1800); // 实测表：4 → 1800（原本地表 1600）
  assert.equal(jisuankeDifficultyToRating('level8'), 3400); // 实测表：8 → 3400（原本地表 2800）
  assert.equal(jisuankeDifficultyToRating('level12'), null); // 越界档位：未知就是未知（原本地表封顶当 level8）
  assert.equal(jisuankeDifficultyToRating(5), 2200); // 整数档位一并接受（原本地表 1900）
  assert.equal(jisuankeDifficultyToRating('level0'), null);
  assert.equal(jisuankeDifficultyToRating(undefined), null);
  assert.equal(jisuankeDifficultyToRating('weird'), null);
});

test('jisuanke: fetchJisuankeBank pages, maps difficulty/tags/urls, dedupes total', async () => {
  const page = (rows: unknown[]) => JSON.stringify({ data: rows, total: 103 });
  const seenPages: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const u = String(input);
    seenPages.push(u);
    if (u.includes('page=1')) {
      return new Response(
        page([
          {
            problemIdentifier: 'T1001',
            title: '入门题',
            difficultyType: 'level1',
            // 实测 /api/problems 行内 problemTags 为 [{ tagName, type }]：difficulty 类为难度档位、其余为知识点
            problemTags: [
              { tagName: '入门', type: 'difficulty' },
              { tagName: '模拟', type: 'knowledge' },
            ],
          },
          {
            problemIdentifier: 'T1002',
            title: '进阶题',
            difficultyType: 'level5',
            problemTags: [{ tagName: '动态规划', type: 'knowledge' }],
          },
          { problemIdentifier: '', title: '无题号应跳过' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(page([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await fetchJisuankeBank(fetchFn, { max: 500 });
  assert.equal(r.platform, 'jisuanke');
  assert.equal(r.total, 103);
  assert.equal(r.problems.length, 2);
  assert.equal(r.problems[0].problemKey, 'T1001');
  assert.equal(r.problems[0].difficulty, 800);
  assert.equal(r.problems[0].nativeDifficulty, 'level1'); // 原生档位原文
  assert.equal(r.problems[0].difficultyScale, 'jisuanke-level-8');
  assert.deepEqual(r.problems[0].tags, ['模拟']); // 只取 knowledge 类（难度类由 difficultyType 表达）
  assert.equal(r.problems[0].url, 'https://www.jisuanke.com/problem/T1001');
  assert.equal(r.problems[1].difficulty, 2200); // level5 → CF 2200（统一实测表）
  assert.deepEqual(r.problems[1].tags, ['动态规划']);
  assert.ok(seenPages[0].includes('page=1'));
  assert.ok(seenPages[1].includes('page=2'), '首页未满 max 应继续翻页');
  assert.ok(seenPages[seenPages.length - 1].includes('page=2'), '空页（第 2 页）后终止，不再翻第 3 页');
});

test('jisuanke: fetchJisuankeBank stops at max and unwraps bare arrays', async () => {
  const fetchFn: typeof fetch = async () =>
    new Response(
      JSON.stringify([
        { problemIdentifier: 'T1', title: 'A', difficultyType: 'level2' },
        { problemIdentifier: 'T2', title: 'B', difficultyType: 'level3' },
        { problemIdentifier: 'T3', title: 'C', difficultyType: 'level4' },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const r = await fetchJisuankeBank(fetchFn, { max: 2 });
  assert.equal(r.problems.length, 2);
  assert.equal(r.problems[1].difficulty, 1500); // level3 → CF 1500（统一实测表）
});

test('jisuanke: bank endpoint error surfaces message', async () => {
  const fetchFn: typeof fetch = async () => new Response('', { status: 502 });
  await assert.rejects(() => fetchJisuankeBank(fetchFn), /HTTP 502/);
});

test('jisuanke: toJisuankeContest normalizes beijing start / seconds duration / type tag', () => {
  const c = toJisuankeContest({
    contestId: 37176,
    title: '计蒜客 2026 新手赛',
    startTime: '2026-09-05 10:00:00',
    duration: 7200,
    rule: 'IOI',
    type: '计蒜客新手赛',
  });
  assert.ok(c);
  assert.equal(c.id, 'jsk-37176');
  assert.equal(c.platform, 'jisuanke');
  assert.equal(c.category, '计蒜客新手赛'); // type 优先作分类
  assert.equal(c.startTimeIso, '2026-09-05T02:00:00.000Z'); // 北京时间 → UTC
  assert.equal(c.durationMinutes, 120); // 秒 → 分钟
  assert.equal(c.url, 'https://www.jisuanke.com/contest/37176');

  // 数字 startTime（unix 秒）与毫秒 duration 防御；无 contestId → null
  const c2 = toJisuankeContest({ contestId: 1, startTime: 1796000000, duration: 5400000 });
  assert.equal(c2?.startTimeIso, new Date(1796000000 * 1000).toISOString());
  assert.equal(c2?.durationMinutes, 90);
  assert.equal(toJisuankeContest({ title: 'x' }), null);
  assert.equal(classifyJisuankeContest('新手入门赛', '', 'IOI'), '新手赛');
});

test('jisuanke: fetchJisuankeContests pages twice, dedupes, caches', async () => {
  const mk = (id: number, page: number) =>
    new Response(
      JSON.stringify({ contests: [{ contestId: id, title: `赛${id}`, startTime: '2026-10-01 19:00:00', duration: 10800 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  let calls = 0;
  const fetchFn: typeof fetch = async (input) => {
    calls += 1;
    const u = String(input);
    return mk(u.includes('page=1') ? 100 + pageOf(u) : 200 + pageOf(u), pageOf(u));
  };
  const pageOf = (u: string): number => (u.includes('page=2') ? 2 : 1);
  const first = await fetchJisuankeContests(fetchFn);
  assert.equal(calls, 2, '取前两页');
  assert.ok(first.length >= 2);
  assert.ok(first.every((c) => c.platform === 'jisuanke'));
  await fetchJisuankeContests(fetchFn);
  assert.equal(calls, 2, '30 分钟缓存内不再请求');
});

test('jisuanke: 平台侧改判（挑战题 WT0 曾按二元域落库）→ 已知行重发，交由写入层刷新 verdict', async () => {
  // 数字域冲突：0/1 在二元训练赛是终态（未通过/通过），在挑战题域是瞬态（WT0/WT1）。
  // 若 challenge 提交以 status=0 被落库为 WA，终态 AC（status=4）到达后必须能刷新，
  // 否则该提交永远是 WA（永久错误状态）。knownVerdicts 携带库中存储 verdict 供比对。
  const contestId = 9001;
  const pages: Record<string, string | (() => string)> = {
    '/api/contests?page=1': () => JSON.stringify([{ contestId, title: '挑战赛', startTime: bjTime(Date.UTC(2026, 8, 1)) }]),
    '/api/contests?page=2': () => JSON.stringify([]),
    '/api/contest/submissions': () =>
      JSON.stringify([submissionRow({ hashId: 'h-rev', identifier: 'A', time: 1, status: 4 })]), // 终态 AC
  };
  const adapter = createJisuankeAdapter(router(pages));
  const known = new Set(['h-rev']);
  const knownVerdicts = new Map([['h-rev', 'WA' as const]]); // 库里存的是当初 WT0(→0) 按二元域落的 WA
  const out = await adapter.fetchUserSubmissions('u', {
    cookie: COOKIE,
    knownExternalIds: known,
    knownVerdicts: knownVerdicts,
    pageDelayMs: 0,
  });
  assert.equal(out.length, 1, '已知但改判的行必须重发');
  assert.equal(out[0].externalId, 'h-rev');
  assert.equal(out[0].verdict, 'AC');
});

test('jisuanke: backfill 比赛预算耗尽且还有未扫比赛 → 0 新增也标记截断推进游标', async () => {
  // 死端场景：35 场比赛、每场提交全部已知 → 旧逻辑 truncated=false → sync_truncated 被清空，
  // 第 31 场及更早的比赛被永久放弃。预算耗尽且 hasMore 时必须如实回写 truncated + 游标。
  const contests = Array.from({ length: 35 }, (_, i) => ({
    contestId: i + 1,
    title: `C${i + 1}`,
    startTime: bjTime(Date.UTC(2026, 0, (i % 28) + 1)),
  }));
  const known = new Set(Array.from({ length: 35 }, (_, i) => `h-${i + 1}`));
  // jisuanke 的 router 不给 handler 传 URL：用计数器按处理顺序回吐每场的（已知）提交行
  let processedContests = 0;
  const fetchFn = router({
    '/api/contests?page=1': () => JSON.stringify(contests),
    '/api/contests?page=2': () => JSON.stringify([]),
    '/api/contest/submissions': () => {
      processedContests += 1;
      return JSON.stringify([submissionRow({ hashId: `h-${processedContests}`, identifier: 'A', time: 1, status: 'AC' })]);
    },
    '/api/contest/problems': () => JSON.stringify([]),
  });
  const adapter = createJisuankeAdapter(fetchFn);
  const opts: FetchOptions = {
    cookie: COOKIE,
    backfill: true,
    backfillFromPage: 1,
    knownExternalIds: known,
    pageDelayMs: 0,
  };
  const out = await adapter.fetchUserSubmissions('u', opts);
  assert.equal(out.length, 0); // 全部已知，无新增
  assert.equal(opts.truncated, true, '预算耗尽且还有未扫比赛时必须标记截断');
  assert.equal(opts.backfillReachedPage, 30); // 游标推进到第 30 场，下轮从 31 继续
});
