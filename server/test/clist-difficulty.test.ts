import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { backfillDifficulties, pickBackfillTargets } from '../src/analysis/difficultyBackfill.ts';
import {
  buildClistProblemUrl,
  clistAuthorization,
  clistCredentialsOf,
  clistRatingToDifficulty,
  clistSupportsPlatform,
  fetchClistRating,
  normalizeProblemName,
  normalizeProblemUrl,
  parseClistProblems,
  pickUniqueClistRating,
  testClistCredentials,
} from '../src/analysis/clistDifficulty.ts';

/**
 * issue #57：clist.by 第三方难度备选源。
 *
 * 2026-10-29 审查后，身份判定从「同名 + rating 唯一」改为「URL 归一后相等」：
 * 同名不同题在 clist 上是常态（真实响应：`Spy Detected!` 5 条、`Treasure Hunt` 16 条），
 * 而「同名候选里唯一非空 rating」可能来自另一道题 —— 本文件用当时抓到的**真实载荷**
 * （`Shortest Path`）做回归：gym `100153/E` 自身 rating 为 null，同名里唯一非空的是
 * 常规赛 `59/E` 的 2132，旧实现会把 2132 写给它。
 */

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

/** 记录请求的 mock fetch 路由器（返回 {body,status} 或 JSON 对象） */
function mockFetch(handlers: Record<string, (url: string, init?: RequestInit) => unknown>): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (!url.includes(prefix)) continue;
      const v = handler(url, init);
      if (typeof v === 'string') return new Response(v, { status: 200 });
      if (v && typeof v === 'object' && typeof (v as { status?: unknown }).status === 'number') {
        const r = v as { status: number; body?: string };
        return new Response(r.body ?? '', { status: r.status });
      }
      return new Response(JSON.stringify(v), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function seedProblem(
  db: Db,
  platform: string,
  key: string,
  title: string,
  opts: { difficulty?: number | null; native?: string | null; scale?: string | null; tags?: string; url?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title, url, difficulty, tags, difficulty_source, native_difficulty, difficulty_scale)
     VALUES (?, ?, ?, ?, ?, ?, 'sync', ?, ?)`,
  ).run(
    platform,
    key,
    title,
    opts.url ?? null,
    opts.difficulty ?? null,
    opts.tags ?? '[]',
    opts.native ?? null,
    opts.scale ?? null,
  );
}

/** 写入 clist.by 凭据（与设置页保存的键一致） */
function seedClistCreds(db: Db, username = 'tester', apiKey = 'secret-key'): void {
  const up = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  up.run('clist.username', username);
  up.run('clist.apiKey', apiKey);
}

/** CF 整表：一道**无 rating** 的题（gym/未评级场景），主来源因此给不出难度 */
function cfTableWithoutRating(): unknown {
  return {
    status: 'OK',
    result: { problems: [{ contestId: 1000, index: 'A', name: 'Watermelon', tags: [] }] },
  };
}

/**
 * 真实响应载荷（2026-10-29 抓取，`name=Shortest Path&resource__regex=codeforces\.com`）：
 * gym 100153/E 就是本库那行，自身 rating 为 null；同名里唯一非空的是常规赛 59/E 的 2132。
 */
const SHORTEST_PATH_PAYLOAD = {
  objects: [
    { name: 'Shortest Path', url: 'https://codeforces.com/gym/104076/problem/I', rating: null },
    { name: 'Shortest Path', url: 'https://codeforces.com/gym/100216/problem/E', rating: null },
    { name: 'Shortest Path', url: 'https://codeforces.com/gym/100153/problem/E', rating: null },
    { name: 'Shortest Path', url: 'https://codeforces.com/contest/59/problem/E', rating: 2132 },
    { name: 'Shortest Path', url: 'https://codeforces.com/gym/106163/problem/B', rating: null },
  ],
};

// ---------- URL 归一（身份判定的基础） ----------

test('normalizeProblemUrl：scheme/www/尾斜杠/query 差异归一，非 URL 视为无证据', () => {
  assert.equal(
    normalizeProblemUrl('http://codeforces.com/contest/1351/problem/A'),
    'https://codeforces.com/contest/1351/problem/A',
    'clist 有 http 与 https 两种写法（实测 1351A 是 http、1959A 是 https）',
  );
  assert.equal(normalizeProblemUrl('https://www.luogu.com.cn/problem/P1001/'), 'https://luogu.com.cn/problem/P1001');
  assert.equal(normalizeProblemUrl('https://codeforces.com/gym/100153/problem/E?x=1#f'), 'https://codeforces.com/gym/100153/problem/E');
  assert.equal(normalizeProblemUrl(''), '');
  assert.equal(normalizeProblemUrl(null), '');
  assert.equal(normalizeProblemUrl('not a url'), '');
});

// ---------- 模块层 ----------

test('clist 查询 URL：限定 resource + 精确题名 + 小 limit；未收录平台/空题名不发请求', () => {
  const url = buildClistProblemUrl('codeforces', 'Watermelon')!;
  assert.ok(url.startsWith('https://clist.by/api/v4/problem/?'));
  const q = new URL(url).searchParams;
  assert.equal(q.get('resource__regex'), 'codeforces\\.com');
  assert.equal(q.get('name'), 'Watermelon');
  assert.equal(q.get('limit'), '20');
  assert.equal(buildClistProblemUrl('qoj', 'Q1'), null);
  assert.equal(buildClistProblemUrl('jisuanke', 'A+B'), null);
  assert.equal(buildClistProblemUrl('codeforces', '   '), null);
  assert.equal(clistSupportsPlatform('atcoder'), true);
  assert.equal(clistSupportsPlatform('dashoj'), false);
});

test('clist 鉴权头：user:key 两种填法都支持', () => {
  assert.equal(clistAuthorization({ username: 'u', apiKey: 'k' }), 'ApiKey u:k');
  assert.equal(clistAuthorization({ username: '', apiKey: 'u:k' }), 'ApiKey u:k');
});

test('唯一命中：只认 URL 相等的行 —— 同名不同题不得采纳', () => {
  const rows = parseClistProblems({
    objects: [
      { name: 'Watermelon', rating: 1400, url: 'http://codeforces.com/contest/1000/problem/A' },
      { name: 'Watermelon', rating: 900, url: 'https://codeforces.com/contest/2000/problem/A' },
      { rating: 1200 }, // 无名字/无链接 → 解析时被丢弃（无名字）
      null,
    ],
  });
  // 本行是 1000A：http/https 差异不影响身份
  assert.equal(pickUniqueClistRating(rows, { title: 'Watermelon', url: 'https://codeforces.com/contest/1000/problem/A' }), 1400);
  // 同名但链接是另一道题 → 不采纳（旧实现会把 1400/900 之一写进来）
  assert.equal(pickUniqueClistRating(rows, { title: 'Watermelon', url: 'https://codeforces.com/contest/3000/problem/A' }), null);
  // 没有链接 = 没有身份证据
  assert.equal(pickUniqueClistRating(rows, { title: 'Watermelon', url: null }), null);
  assert.equal(pickUniqueClistRating(rows, { title: 'Watermelon', url: 'not a url' }), null);
  assert.equal(normalizeProblemName('  A   B '), 'a b');
  assert.deepEqual(parseClistProblems({ nope: true }), []);
});

test('唯一命中：同 URL 多条时 rating 去重后必须恰好一个', () => {
  const same = parseClistProblems({
    objects: [
      { name: 'X', rating: 1400, url: 'https://codeforces.com/contest/1/problem/A' },
      { name: 'X (dup)', rating: 1400, url: 'http://codeforces.com/contest/1/problem/A' },
    ],
  });
  assert.equal(pickUniqueClistRating(same, { title: 'X', url: 'https://codeforces.com/contest/1/problem/A' }), 1400);
  const conflicting = parseClistProblems({
    objects: [
      { name: 'X', rating: 1400, url: 'https://codeforces.com/contest/1/problem/A' },
      { name: 'X', rating: 1500, url: 'https://codeforces.com/contest/1/problem/A/' },
    ],
  });
  assert.equal(pickUniqueClistRating(conflicting, { title: 'X', url: 'https://codeforces.com/contest/1/problem/A' }), null);
});

test('真实载荷回归：gym 100153/E 不得拿走同名常规赛 59/E 的 2132（审查发现的写错路径）', () => {
  const rows = parseClistProblems(SHORTEST_PATH_PAYLOAD);
  // 旧实现（同名 + rating 唯一）会返回 2132
  assert.equal(
    pickUniqueClistRating(rows, { title: 'Shortest Path', url: 'https://codeforces.com/gym/100153/problem/E' }),
    null,
    '本行自己的 clist 记录 rating 为 null → 应保持未知',
  );
  // 对照：常规赛 59/E 拿自己的值是正确的（身份匹配上了）
  assert.equal(
    pickUniqueClistRating(rows, { title: 'Shortest Path', url: 'https://codeforces.com/contest/59/problem/E' }),
    2132,
  );
  // 对照：库里没有的同名题 → 不写
  assert.equal(
    pickUniqueClistRating(rows, { title: 'Shortest Path', url: 'https://codeforces.com/contest/9999/problem/Z' }),
    null,
  );
});

test('clist rating → difficulty：钳到 CF 标尺 800–3500', () => {
  assert.equal(clistRatingToDifficulty(1400), 1400);
  assert.equal(clistRatingToDifficulty(300), 800);
  assert.equal(clistRatingToDifficulty(9000), 3500);
});

test('fetchClistRating：401/403 与 429 是「凭据/限额」问题，其余失败只是这一题没查到', async () => {
  const creds = { username: 'u', apiKey: 'k' };
  const target = { title: 'Watermelon', url: 'https://codeforces.com/contest/1000/problem/A' };
  const auth = mockFetch({ 'clist.by': () => ({ status: 401, body: '' }) });
  assert.deepEqual(await fetchClistRating(auth.fetchFn, creds, 'codeforces', target), { status: 'unauthorized' });
  const limited = mockFetch({ 'clist.by': () => ({ status: 429, body: '' }) });
  assert.deepEqual(await fetchClistRating(limited.fetchFn, creds, 'codeforces', target), { status: 'rate_limited' });
  const broken = mockFetch({ 'clist.by': () => 'not json' });
  assert.deepEqual(await fetchClistRating(broken.fetchFn, creds, 'codeforces', target), { status: 'failed' });
  const notFound = mockFetch({ 'clist.by': () => ({ status: 500, body: '' }) });
  assert.deepEqual(await fetchClistRating(notFound.fetchFn, creds, 'codeforces', target), { status: 'failed' });
  const never = mockFetch({ 'clist.by': () => ({ objects: [] }) });
  assert.deepEqual(await fetchClistRating(never.fetchFn, creds, 'qoj', { title: 'Q1', url: 'https://qoj.ac/problem/1' }), { status: 'unsupported' });
  assert.equal(never.calls.length, 0);
});

test('testClistCredentials：成功/401/限流各自给出可执行的说明', async () => {
  const creds = { username: 'u', apiKey: 'k' };
  const ok = await testClistCredentials(mockFetch({ 'clist.by': () => ({ objects: [] }) }).fetchFn, creds);
  assert.equal(ok.ok, true);
  const bad = await testClistCredentials(mockFetch({ 'clist.by': () => ({ status: 401, body: '' }) }).fetchFn, creds);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /认证失败/);
  const limited = await testClistCredentials(mockFetch({ 'clist.by': () => ({ status: 429, body: '' }) }).fetchFn, creds);
  assert.match(limited.message, /限流/);
});

test('凭据读取：Key 为空视为未配置（用户名为空但 Key 为 user:key 整串则可用）', () => {
  const empty = clistCredentialsOf((key) => (key === 'clist.username' ? 'tester' : ''));
  assert.equal(empty, null);
  const full = clistCredentialsOf((key) => (key === 'clist.apiKey' ? ' tester:secret ' : undefined));
  assert.deepEqual(full, { username: '', apiKey: 'tester:secret' });
});

// ---------- 回填链路 ----------

test('回填：主来源无难度 → clist.by 按 URL 确认后补上，标度/来源如实记录（issue #57）', async () => {
  seedClistCreds(db, 'tester', 'secret-key');
  seedProblem(db, 'codeforces', '1000A', 'Watermelon', { url: 'https://codeforces.com/contest/1000/problem/A' });
  const mock = mockFetch({
    'problemset.problems': () => cfTableWithoutRating(),
    'clist.by/api/v4/problem/': (url) => {
      const q = new URL(url).searchParams;
      assert.equal(q.get('resource__regex'), 'codeforces\\.com');
      assert.equal(q.get('name'), 'Watermelon');
      // 故意用 http（clist 实测有这种写法），验证 scheme 归一后再比对
      return { objects: [{ name: 'Watermelon', rating: 1400, url: 'http://codeforces.com/contest/1000/problem/A' }] };
    },
  });
  const res = await backfillDifficulties(db, mock.fetchFn, { clistFallback: true });
  const cf = res.find((x) => x.platform === 'codeforces')!;
  assert.equal(cf.filled, 1);
  assert.equal(cf.clistQueried, 1, 'clist.by 只被问了一次');
  assert.equal(cf.clistFilled, 1);
  const row = db.prepare("SELECT * FROM problems WHERE problem_key = '1000A'").get() as Record<string, unknown>;
  assert.equal(row.difficulty, 1400);
  assert.equal(row.native_difficulty, '1400');
  assert.equal(row.difficulty_scale, 'clist-rating');
  assert.equal(row.difficulty_source, 'clist', '第三方值单独记账，便于日后被官方值覆盖');
  const clistCall = mock.calls.find((c) => c.url.includes('clist.by'));
  assert.ok(clistCall, '必须真的向 clist.by 发过一次查询');
  const headers = (clistCall.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers.Authorization, 'ApiKey tester:secret-key');
});

test('回填：同名兄弟有唯一非空 rating，但 URL 不是本行 → 一律不写（真实载荷）', async () => {
  seedClistCreds(db);
  seedProblem(db, 'codeforces', '100153E', 'Shortest Path', {
    url: 'https://codeforces.com/gym/100153/problem/E',
  });
  const mock = mockFetch({
    'problemset.problems': () => ({
      status: 'OK',
      result: { problems: [{ contestId: 100153, index: 'E', name: 'Shortest Path', tags: [] }] },
    }),
    'clist.by/api/v4/problem/': () => SHORTEST_PATH_PAYLOAD,
  });
  const res = await backfillDifficulties(db, mock.fetchFn, { clistFallback: true });
  const cf = res.find((x) => x.platform === 'codeforces')!;
  assert.equal(cf.clistQueried, 1);
  assert.equal(cf.clistFilled, 0, '不得把同名常规赛的 2132 写进 gym 题');
  assert.equal(cf.filled, 0);
  const row = db.prepare("SELECT difficulty, difficulty_source FROM problems WHERE problem_key = '100153E'").get() as {
    difficulty: number | null;
    difficulty_source: string | null;
  };
  assert.equal(row.difficulty, null, '本行在 clist 的记录 rating 为 null → 保持未知');
  assert.notEqual(row.difficulty_source, 'clist');
});

test('回填：同一份载荷下，URL 对得上的那道题能拿到自己的值', async () => {
  seedClistCreds(db);
  seedProblem(db, 'codeforces', '59E', 'Shortest Path', {
    url: 'https://codeforces.com/contest/59/problem/E',
  });
  const mock = mockFetch({
    'problemset.problems': () => ({
      status: 'OK',
      result: { problems: [{ contestId: 59, index: 'E', name: 'Shortest Path', tags: [] }] },
    }),
    'clist.by/api/v4/problem/': () => SHORTEST_PATH_PAYLOAD,
  });
  const res = await backfillDifficulties(db, mock.fetchFn, { clistFallback: true });
  const cf = res.find((x) => x.platform === 'codeforces')!;
  assert.equal(cf.clistFilled, 1);
  const row = db.prepare("SELECT difficulty FROM problems WHERE problem_key = '59E'").get() as { difficulty: number | null };
  assert.equal(row.difficulty, 2132);
});

test('回填：库内没有题目链接 → 不查 clist，并在明细里说明原因', async () => {
  seedClistCreds(db);
  seedProblem(db, 'codeforces', '1000A', 'Watermelon'); // 无 url
  const mock = mockFetch({
    'problemset.problems': () => cfTableWithoutRating(),
    'clist.by/api/v4/problem/': () => ({ objects: [{ name: 'Watermelon', rating: 1400 }] }),
  });
  const res = await backfillDifficulties(db, mock.fetchFn, { clistFallback: true });
  const cf = res.find((x) => x.platform === 'codeforces')!;
  assert.equal(cf.clistQueried, 0, '没有身份证据就不发请求');
  assert.equal(mock.calls.filter((c) => c.url.includes('clist.by')).length, 0);
  assert.match(cf.details[0]!.note!, /缺少题目链接/);
  const row = db.prepare("SELECT difficulty FROM problems WHERE problem_key = '1000A'").get() as { difficulty: number | null };
  assert.equal(row.difficulty, null);
});

test('回填：未配置 Key / 未开启时一次 clist 请求都不发', async () => {
  for (const setup of ['no-key', 'off'] as const) {
    const local = createDb(':memory:');
    try {
      seedProblem(local, 'codeforces', '1000A', 'Watermelon', { url: 'https://codeforces.com/contest/1000/problem/A' });
      const mock = mockFetch({
        'problemset.problems': () => cfTableWithoutRating(),
        'clist.by/api/v4/problem/': () => ({ objects: [{ name: 'Watermelon', rating: 1400, url: 'https://codeforces.com/contest/1000/problem/A' }] }),
      });
      if (setup !== 'no-key') seedClistCreds(local);
      const res = await backfillDifficulties(local, mock.fetchFn, { clistFallback: setup !== 'off' });
      const cf = res.find((x) => x.platform === 'codeforces')!;
      assert.equal(cf.clistQueried, 0);
      assert.equal(cf.clistFilled, 0);
      assert.equal(mock.calls.filter((c) => c.url.includes('clist.by')).length, 0);
      const row = local.prepare("SELECT difficulty FROM problems WHERE problem_key = '1000A'").get() as { difficulty: number | null };
      assert.equal(row.difficulty, null, '没有来源就该保持未知，不猜');
    } finally {
      local.close();
    }
  }
});

test('回填：查询失败 → 不写难度，按原逻辑记 missing 并在明细里说明', async () => {
  seedClistCreds(db);
  seedProblem(db, 'codeforces', '1000A', 'Watermelon', { url: 'https://codeforces.com/contest/1000/problem/A' });
  const mock = mockFetch({
    'problemset.problems': () => cfTableWithoutRating(),
    'clist.by/api/v4/problem/': () => ({ status: 500, body: '' }),
  });
  const res = await backfillDifficulties(db, mock.fetchFn, { clistFallback: true });
  const cf = res.find((x) => x.platform === 'codeforces')!;
  assert.equal(cf.clistQueried, 1);
  assert.equal(cf.clistFilled, 0);
  assert.equal(cf.missing, 1);
  assert.match(cf.details.find((d) => d.problemKey === '1000A')!.note!, /clist\.by/);
});

test('回填：clist 每轮查询次数受上限约束（10 次/分钟的额度不能一口气烧光）', async () => {
  seedClistCreds(db);
  seedProblem(db, 'codeforces', '1000A', 'A题', { url: 'https://codeforces.com/contest/1000/problem/A' });
  seedProblem(db, 'codeforces', '1000B', 'B题', { url: 'https://codeforces.com/contest/1000/problem/B' });
  seedProblem(db, 'codeforces', '1000C', 'C题', { url: 'https://codeforces.com/contest/1000/problem/C' });
  const mock = mockFetch({
    'problemset.problems': () => ({
      status: 'OK',
      result: {
        problems: [
          { contestId: 1000, index: 'A', name: 'A题', tags: [] },
          { contestId: 1000, index: 'B', name: 'B题', tags: [] },
          { contestId: 1000, index: 'C', name: 'C题', tags: [] },
        ],
      },
    }),
    'clist.by/api/v4/problem/': () => ({ objects: [] }),
  });
  const res = await backfillDifficulties(db, mock.fetchFn, { clistFallback: true, clistMaxLookups: 2 });
  const cf = res.find((x) => x.platform === 'codeforces')!;
  assert.equal(cf.clistQueried, 2, '只发 2 次请求');
  assert.equal(mock.calls.filter((c) => c.url.includes('clist.by')).length, 2);
});

test('回填：clist 认证失败后本轮不再继续打（避免把额度与时间浪费在必然失败的请求上）', async () => {
  seedClistCreds(db);
  seedProblem(db, 'codeforces', '1000A', 'A题', { url: 'https://codeforces.com/contest/1000/problem/A' });
  seedProblem(db, 'codeforces', '1000B', 'B题', { url: 'https://codeforces.com/contest/1000/problem/B' });
  const mock = mockFetch({
    'problemset.problems': () => ({
      status: 'OK',
      result: {
        problems: [
          { contestId: 1000, index: 'A', name: 'A题', tags: [] },
          { contestId: 1000, index: 'B', name: 'B题', tags: [] },
        ],
      },
    }),
    'clist.by/api/v4/problem/': () => ({ status: 401, body: '' }),
  });
  const res = await backfillDifficulties(db, mock.fetchFn, { clistFallback: true });
  const cf = res.find((x) => x.platform === 'codeforces')!;
  assert.equal(cf.clistQueried, 1);
  assert.equal(mock.calls.filter((c) => c.url.includes('clist.by')).length, 1);
  assert.match(cf.details[0]!.note!, /认证失败/);
});

test('回填目标：已有难度的题不会因为开了 clist 备选而变成目标', () => {
  seedProblem(db, 'codeforces', '1000A', 'Watermelon', {
    difficulty: 1200, native: '1200', scale: 'cf-rating', tags: '["math"]',
    url: 'https://codeforces.com/contest/1000/problem/A',
  });
  assert.deepEqual(pickBackfillTargets(db), []);
});
