import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPtaAdapter,
  mapPtaVerdict,
  parsePtaUserId,
  parsePtaProblemList,
  parsePtaProblemSets,
  ptaErrorCode,
  ptaIdentity,
  ptaProblemKey,
  ptaProblemUrl,
  ptaSubmittedAt,
} from '../src/adapters/pta.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';
import { parseProblemListText } from '../src/problems/parseProblemList.ts';
import { platformMeta } from '../../shared/src/index.ts';
import { SyncError } from '../src/adapters/types.ts';

/**
 * PTA（pintia.cn）适配器测试。
 *
 * 夹具全部取自 2026-11 对线上接口的实测响应（字段名与取值都按真实返回裁剪），
 * 因为这套接口没有公开文档：照文档猜的字段名一个都对不上。
 *   GET /api/problem-sets/always-available                     → { problemSets: [{id,name,type,...}] }
 *   GET /api/problem-sets/{ps}/exam-problem-list?page=&limit=  → { total, problemSetProblems: [{id,label,title,...}] }
 *   GET /api/problem-sets/{ps}/users/{uid}/submissions?limit=&before=
 *     → { submissions: [{id,problemSetProblemId,submitAt,status,...}],
 *         hasBefore, problemSetProblemById: { [pspId]: {id,label,title} } }
 */

const PS = '994805342720868352';

function sub(o: {
  id: string;
  pspId?: string;
  status?: string;
  submitAt?: string;
  compiler?: string;
}): Record<string, unknown> {
  return {
    id: o.id,
    userId: '1693903232973955072',
    problemType: 'PROGRAMMING',
    problemSetProblemId: o.pspId ?? '994805516654460928',
    submitAt: o.submitAt ?? '2026-11-09T13:24:10Z',
    status: o.status ?? 'ACCEPTED',
    score: 25,
    compiler: o.compiler ?? 'GCC',
    time: 0.002,
    memory: 602112,
    previewSubmission: false,
    judgeAt: '2026-11-09T13:24:11Z',
  };
}

/** 用「路径 → 响应」路由表构造注入的 fetch（与既有适配器测试同风格） */
function router(
  pages: Record<string, unknown | (() => unknown)>,
  log: string[] = [],
): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = String(input);
    log.push(url);
    for (const [key, value] of Object.entries(pages)) {
      if (url.includes(key)) {
        const body = typeof value === 'function' ? (value as () => unknown)() : value;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 406 });
  };
}

const ALWAYS_AVAILABLE = {
  problemSets: [
    { id: PS, name: 'PAT (Advanced Level) Practice', type: 'EXERCISE' },
    { id: '12', name: '浙大版《C语言程序设计（第3版）》题目集', type: 'BOOK' },
  ],
};

const PROBLEM_LIST = {
  total: 179,
  problemSetProblems: [
    { id: '994805528788582400', label: '1001', title: 'A+B Format', type: 'PROGRAMMING', difficulty: 0 },
    { id: '994805516654460928', label: '1006', title: 'Sign In and Sign Out', type: 'PROGRAMMING', difficulty: 0 },
  ],
};

// ---------- 纯函数 ----------

test('pta: ptaProblemKey 需要两侧都是数字 id', () => {
  assert.equal(ptaProblemKey('994805342720868352', '994805528788582400'), '994805342720868352-994805528788582400');
  assert.equal(ptaProblemKey('12', '237'), '12-237');
  // 畸形（非数字 / 空）一律 null：宁可跳过，也不落一个打不开的题号
  assert.equal(ptaProblemKey('', '237'), null);
  assert.equal(ptaProblemKey('12', ''), null);
  assert.equal(ptaProblemKey('12', 'abc'), null);
  assert.equal(ptaProblemKey('a-b', '237'), null);
});

test('pta: ptaProblemUrl 拼站点真实路由（题目 id 在查询参数里），畸形键退回站点首页', () => {
  // 站点 SPA 的路由是 /problem-sets/:id/exam/problems/type/:type?problemSetProblemId=...
  // 旧实现拼的 /problem-sets/{ps}/problems/{psp} 在路由表里**不存在** → 点开渲染 404
  //（HTTP 仍是 200，只看状态码发现不了）。编程题的 type 序数是 7。
  assert.equal(
    ptaProblemUrl(`${PS}-994805528788582400`),
    `https://pintia.cn/problem-sets/${PS}/exam/problems/type/7?problemSetProblemId=994805528788582400`,
  );
  // 裸数字（历史行/手动导入）走站点的 /problems/{problemId} 别名页
  assert.equal(ptaProblemUrl('10007'), 'https://pintia.cn/problems/10007');
  assert.equal(ptaProblemUrl(''), 'https://pintia.cn');
  // 拼出来的链接必须能被「粘贴 URL 导入」反解回同一个键（见 problems/parseProblemList.ts）
  const back = parseProblemListText(ptaProblemUrl(`${PS}-994805528788582400`));
  assert.equal(back.length, 1);
  assert.equal(back[0]?.platform, 'pta');
  assert.equal(back[0]?.problemKey, `${PS}-994805528788582400`);
});

test('pta: parsePtaUserId 只接受数字 userId（昵称站点一律 400）', () => {
  assert.equal(parsePtaUserId('1693903232973955072'), '1693903232973955072');
  assert.equal(parsePtaUserId('  12  '), '12');
  assert.equal(parsePtaUserId('leonyret'), null);
  assert.equal(parsePtaUserId('12abc'), null);
  assert.equal(parsePtaUserId(''), null);
});

test('pta: mapPtaVerdict 覆盖站点 SubmissionStatus 字典', () => {
  assert.equal(mapPtaVerdict('ACCEPTED'), 'AC');
  assert.equal(mapPtaVerdict('PARTIAL_ACCEPTED'), 'WA');
  assert.equal(mapPtaVerdict('WRONG_ANSWER'), 'WA');
  assert.equal(mapPtaVerdict('PRESENTATION_ERROR'), 'WA');
  assert.equal(mapPtaVerdict('TIME_LIMIT_EXCEEDED'), 'TLE');
  assert.equal(mapPtaVerdict('TOTAL_TIME_LIMIT_EXCEEDED'), 'TLE');
  assert.equal(mapPtaVerdict('MEMORY_LIMIT_EXCEEDED'), 'MLE');
  assert.equal(mapPtaVerdict('COMPILE_ERROR'), 'CE');
  // 输出超限与「多种错误/判题侧异常」按 RE 归并（列表页拆不出更细的原因）
  assert.equal(mapPtaVerdict('OUTPUT_LIMIT_EXCEEDED'), 'RE');
  assert.equal(mapPtaVerdict('SEGMENTATION_FAULT'), 'RE');
  assert.equal(mapPtaVerdict('MULTIPLE_ERROR'), 'RE');
  assert.equal(mapPtaVerdict('INTERNAL_ERROR'), 'RE');
  // 评测中与不可靠终态 → null（不落库、也不计入已知）
  assert.equal(mapPtaVerdict('WAITING'), null);
  assert.equal(mapPtaVerdict('JUDGING'), null);
  assert.equal(mapPtaVerdict('REJUDGING'), null);
  assert.equal(mapPtaVerdict('NO_ANSWER'), null);
  assert.equal(mapPtaVerdict('OVERRIDDEN'), null);
  assert.equal(mapPtaVerdict(undefined), null);
  assert.equal(mapPtaVerdict(''), null);
});

test('pta: ptaSubmittedAt 归一为 ISO8601 UTC，坏值返回 null', () => {
  assert.equal(ptaSubmittedAt({ id: '1', submitAt: '2026-11-09T13:24:10Z' }), '2026-11-09T13:24:10.000Z');
  assert.equal(ptaSubmittedAt({ id: '1', submitAt: '2026-11-09T13:24:10.123Z' }), '2026-11-09T13:24:10.123Z');
  assert.equal(ptaSubmittedAt({ id: '1' }), null);
  assert.equal(ptaSubmittedAt({ id: '1', submitAt: 'not-a-date' }), null);
});

test('pta: parsePtaProblemSets 过滤畸形题集并去重', () => {
  const sets = parsePtaProblemSets({
    problemSets: [
      { id: '12', name: '浙大版 C 语言' },
      { id: '12', name: '重复项' },
      { id: 'abc', name: '题集 id 不是数字' },
      { name: '没有 id' },
      { id: '994805260223102976' }, // 没有名字：退到「PTA 题集 {id}」
    ],
  });
  assert.deepEqual(sets, [
    { id: '12', name: '浙大版 C 语言', type: undefined },
    { id: '994805260223102976', name: 'PTA 题集 994805260223102976' },
  ].map((s) => (s.type === undefined ? { id: s.id, name: s.name } : s)));
});

test('pta: parsePtaProblemList 取 total 并保留题号/标题', () => {
  const { items, total } = parsePtaProblemList(PROBLEM_LIST);
  assert.equal(total, 179);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    id: '994805528788582400',
    label: '1001',
    title: 'A+B Format',
    type: 'PROGRAMMING',
    difficulty: 0, // 站点原文透传（0 = UNLIMITED；换算在 shared/src/difficulty.ts）
  });
  assert.deepEqual(parsePtaProblemList(null), { items: [], total: null });
});

test('pta: ptaErrorCode 取站点错误体里的 code', () => {
  assert.equal(ptaErrorCode({ error: { code: 'USER_NOT_LOGGED_IN' } }), 'USER_NOT_LOGGED_IN');
  assert.equal(ptaErrorCode({ error: 'plain' }), null);
  assert.equal(ptaErrorCode(null), null);
});

// ---------- 同步主体 ----------

test('pta: 匿名同步公开发表记录（无 Cookie 也能拉到）', async () => {
  const log: string[] = [];
  const adapter = createPtaAdapter(
    router(
      {
        '/api/problem-sets/always-available': ALWAYS_AVAILABLE,
        '/users/1693903232973955072/submissions': {
          submissions: [
            sub({ id: '2119783105457266688', status: 'ACCEPTED' }),
            sub({ id: '2119781720125882368', status: 'PARTIAL_ACCEPTED', submitAt: '2026-11-09T13:20:00Z' }),
          ],
          hasBefore: false,
          problemSetProblemById: { '994805516654460928': { id: '994805516654460928', label: '1006', title: '' } },
        },
        '/exam-problem-list': PROBLEM_LIST,
      },
      log,
    ),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', { pageDelayMs: 0 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.verdict, 'AC');
  assert.equal(rows[1]?.verdict, 'WA');
  // 题号 = 题集 id + 题集内题目 id（与题库拉取同键）
  assert.equal(rows[0]?.problem.problemKey, `${PS}-994805516654460928`);
  assert.equal(rows[0]?.problem.difficulty, undefined); // 难度 0/缺失 = 未知：不臆造
  // 标度仍然是 pta-level-5：回填/前端据此知道「这个平台有 0-5 的难度域」，
  // 只是这批题恰好都是 0（公开题集实测 1906/1906 全 0）
  assert.equal(rows[0]?.problem.difficultyScale, 'pta-level-5');
  assert.equal(rows[0]?.externalId, '2119783105457266688');
  assert.equal(rows[0]?.submittedAt, '2026-11-09T13:02:10.000Z'.replace('13:02:10', '13:24:10'));
  assert.equal(rows[0]?.language, 'GCC');
  // 提交行不带标题：由题集题目表补上
  assert.equal(rows[0]?.problem.title, 'Sign In and Sign Out');
  // 没有 Cookie 时不应去碰「我加入的题集」
  assert.equal(log.some((u) => u.includes('/api/problem-sets?filter=')), false);
});

test('pta: 配了 Cookie 时并上「我加入的题集」并去重', async () => {
  const log: string[] = [];
  const adapter = createPtaAdapter(
    router(
      {
        '/api/problem-sets/always-available': ALWAYS_AVAILABLE,
        '/api/problem-sets?filter=': {
          problemSets: [
            { id: '2000000000000000001', name: '2026 秋季程序设计课程作业' },
            { id: PS, name: 'PAT (Advanced Level) Practice' }, // 与公开题集重复 → 去重
          ],
        },
        '/users/1693903232973955072/submissions': { submissions: [], hasBefore: false },
      },
      log,
    ),
  );
  await adapter.fetchUserSubmissions('1693903232973955072', { cookie: 'PTASession=abc', pageDelayMs: 0 });
  const filtered = log.filter((u) => u.includes('/api/problem-sets?filter='));
  assert.equal(filtered.length, 1);
  // 题集集合 = 「我加入的」(课程作业 + PAT) ∪ 公开的 (PAT + 浙大版 C 语言) = 3 套，
  // 重复的 PAT 只请求一次；每套都在增量判定里被看一眼（整页已知/空页即走）
  const submissionCalls = log.filter((u) => u.includes('/submissions'));
  assert.equal(submissionCalls.length, 3);
  const setIds = submissionCalls.map((u) => /problem-sets\/(\d+)\//.exec(u)?.[1]);
  assert.deepEqual(setIds, ['2000000000000000001', PS, '12']);
});

test('pta: handle 不是数字 userId → invalid_account（而不是 schema_changed）', async () => {
  const adapter = createPtaAdapter(router({}));
  await assert.rejects(
    () => adapter.fetchUserSubmissions('leonyret'),
    (e: unknown) => e instanceof SyncError && e.code === 'invalid_account',
  );
});

test('pta: 站点返回 401 → auth_expired；406 → schema_changed', async () => {
  const auth = createPtaAdapter(
    async () => new Response(JSON.stringify({ error: { code: 'USER_NOT_LOGGED_IN' } }), { status: 401 }),
  );
  await assert.rejects(
    () => auth.fetchUserSubmissions('12', { pageDelayMs: 0 }),
    (e: unknown) => e instanceof SyncError && e.code === 'auth_expired',
  );
  const broken = createPtaAdapter(async () => new Response('', { status: 406 }));
  await assert.rejects(
    () => broken.fetchUserSubmissions('12', { pageDelayMs: 0 }),
    (e: unknown) => e instanceof SyncError && e.code === 'schema_changed',
  );
});

test('pta: 分页用 before 游标（page 参数会被站点忽略）', async () => {
  const log: string[] = [];
  let page = 0;
  const adapter = createPtaAdapter(
    router(
      {
        '/api/problem-sets/always-available': { problemSets: [{ id: PS, name: 'PAT' }] },
        '/users/1693903232973955072/submissions': () => {
          page += 1;
          if (page === 1) {
            return {
              submissions: [
                sub({ id: '300', status: 'ACCEPTED', submitAt: '2026-11-09T13:00:00Z' }),
                sub({ id: '200', status: 'ACCEPTED', submitAt: '2026-11-09T12:00:00Z' }),
              ],
              hasBefore: true,
            };
          }
          return {
            submissions: [sub({ id: '100', status: 'WRONG_ANSWER', submitAt: '2026-11-09T11:00:00Z' })],
            hasBefore: false,
          };
        },
      },
      log,
    ),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', { pageDelayMs: 0 });
  assert.equal(rows.length, 3);
  const calls = log.filter((u) => u.includes('/submissions'));
  assert.equal(calls.length, 2);
  // 第二页必须带 before=上一页最后一条的 id
  assert.match(calls[1]!, /before=200/);
  assert.doesNotMatch(calls[0]!, /before=/);
});

test('pta: 整页已知即跳过该题集（增量早停），不继续翻页', async () => {
  const log: string[] = [];
  let page = 0;
  const adapter = createPtaAdapter(
    router(
      {
        '/api/problem-sets/always-available': { problemSets: [{ id: PS, name: 'PAT' }] },
        '/users/1693903232973955072/submissions': () => {
          page += 1;
          return {
            submissions: [
              sub({ id: '300', status: 'ACCEPTED', submitAt: '2026-11-09T13:00:00Z' }),
              sub({ id: '200', status: 'ACCEPTED', submitAt: '2026-11-09T12:00:00Z' }),
            ],
            hasBefore: true,
          };
        },
      },
      log,
    ),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', {
    pageDelayMs: 0,
    knownExternalIds: new Set(['300', '200']),
    knownVerdicts: new Map([['300', 'AC' as const], ['200', 'AC' as const]]),
  });
  assert.equal(rows.length, 0);
  assert.equal(page, 1); // 只打了 1 页就判定已追平
});

test('pta: 已入库但平台改判时重发该行（写入层据此刷新既有行）', async () => {
  const adapter = createPtaAdapter(
    router({
      '/api/problem-sets/always-available': { problemSets: [{ id: PS, name: 'PAT' }] },
      '/users/1693903232973955072/submissions': {
        submissions: [sub({ id: '300', status: 'ACCEPTED', submitAt: '2026-11-09T13:00:00Z' })],
        hasBefore: false,
      },
    }),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', {
    pageDelayMs: 0,
    knownExternalIds: new Set(['300']),
    knownVerdicts: new Map([['300', 'WA' as const]]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.verdict, 'AC');
});

test('pta: 评测中的行不落库，也不计入已知', async () => {
  const adapter = createPtaAdapter(
    router({
      '/api/problem-sets/always-available': { problemSets: [{ id: PS, name: 'PAT' }] },
      '/users/1693903232973955072/submissions': {
        submissions: [
          sub({ id: '300', status: 'WAITING' }),
          sub({ id: '200', status: 'JUDGING' }),
          sub({ id: '100', status: 'ACCEPTED' }),
        ],
        hasBefore: false,
      },
    }),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', { pageDelayMs: 0 });
  assert.deepEqual(rows.map((r) => r.externalId), ['100']);
});

test('pta: 窗口模式遇到早于起点的提交即收工', async () => {
  const adapter = createPtaAdapter(
    router({
      '/api/problem-sets/always-available': { problemSets: [{ id: PS, name: 'PAT' }] },
      '/users/1693903232973955072/submissions': {
        submissions: [
          sub({ id: '300', status: 'ACCEPTED', submitAt: '2026-11-09T13:00:00Z' }),
          sub({ id: '200', status: 'ACCEPTED', submitAt: '2026-10-01T13:00:00Z' }),
          sub({ id: '100', status: 'ACCEPTED', submitAt: '2026-11-01T13:00:00Z' }),
        ],
        hasBefore: true,
      },
    }),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', {
    pageDelayMs: 0,
    windowSince: '2026-11-05T00:00:00.000Z',
  });
  assert.deepEqual(rows.map((r) => r.externalId), ['300']); // 200 早于窗口起点 → 之后的 100 也不再采
});

test('pta: 触及单次新增上限时回写 truncated', async () => {
  const opts = { pageDelayMs: 0, maxSubmissions: 2 } as { pageDelayMs: number; maxSubmissions: number; truncated?: boolean };
  const adapter = createPtaAdapter(
    router({
      '/api/problem-sets/always-available': { problemSets: [{ id: PS, name: 'PAT' }] },
      '/users/1693903232973955072/submissions': {
        submissions: [
          sub({ id: '400', submitAt: '2026-11-09T13:04:00Z' }),
          sub({ id: '300', submitAt: '2026-11-09T13:03:00Z' }),
          sub({ id: '200', submitAt: '2026-11-09T13:02:00Z' }),
        ],
        hasBefore: true,
      },
    }),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', opts);
  assert.equal(rows.length, 2);
  assert.equal(opts.truncated, true);
});

test('pta: 题集题目表拉不到时只丢标题，不影响同步', async () => {
  const adapter = createPtaAdapter(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/problem-sets/always-available')) {
      return new Response(JSON.stringify({ problemSets: [{ id: PS, name: 'PAT' }] }), { status: 200 });
    }
    if (url.includes('/users/')) {
      return new Response(
        JSON.stringify({
          submissions: [sub({ id: '300', status: 'ACCEPTED' })],
          hasBefore: false,
          problemSetProblemById: { '994805516654460928': { id: '994805516654460928', label: '1006', title: '' } },
        }),
        { status: 200 },
      );
    }
    return new Response('', { status: 406 }); // 题目表接口坏了
  });
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', { pageDelayMs: 0 });
  assert.equal(rows.length, 1);
  // 退回页内给出的题号（label），而不是空标题
  assert.equal(rows[0]?.problem.title, '1006');
});


// ---------- 难度（0-5 枚举 → CF rating，映射表在 shared/src/difficulty.ts） ----------

test('pta: 题集题目表里的 1-5 档难度换算为 CF rating 并带回原生档位', async () => {
  const adapter = createPtaAdapter(
    router({
      '/api/problem-sets/always-available': ALWAYS_AVAILABLE,
      '/users/1693903232973955072/submissions': {
        submissions: [sub({ id: '300', status: 'ACCEPTED' })],
        hasBefore: false,
        problemSetProblemById: { '994805516654460928': { id: '994805516654460928', label: '1006', title: '' } },
      },
      // 同一套题集里两档：1006 标了「中等」(3)，1001 未标注 (0)
      '/exam-problem-list': {
        total: 2,
        problemSetProblems: [
          { id: '994805516654460928', label: '1006', title: 'Sign In and Sign Out', difficulty: 3 },
          { id: '994805528788582400', label: '1001', title: 'A+B Format', difficulty: 0 },
        ],
      },
    }),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', { pageDelayMs: 0 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.problem.difficulty, 1600); // 3 中等 → CF 1600
  assert.equal(rows[0]?.problem.nativeDifficulty, '3');
  assert.equal(rows[0]?.problem.difficultyScale, 'pta-level-5');
  assert.equal(rows[0]?.problem.title, 'Sign In and Sign Out');
});

test('pta: 难度 0（UNLIMITED）/缺失一律按未知，不下发 difficulty 键', async () => {
  const adapter = createPtaAdapter(
    router({
      '/api/problem-sets/always-available': ALWAYS_AVAILABLE,
      '/users/1693903232973955072/submissions': {
        submissions: [sub({ id: '300', status: 'ACCEPTED' })],
        hasBefore: false,
        problemSetProblemById: { '994805516654460928': { id: '994805516654460928', label: '1006', title: '' } },
      },
      '/exam-problem-list': {
        total: 2,
        problemSetProblems: [
          { id: '994805516654460928', label: '1006', title: 'Sign In and Sign Out', difficulty: 0 },
          { id: '994805528788582400', label: '1001', title: 'A+B Format' }, // 字段缺失
        ],
      },
    }),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', { pageDelayMs: 0 });
  assert.equal(rows[0]?.problem.difficulty, undefined);
  assert.equal(rows[0]?.problem.nativeDifficulty, '0'); // 原文如实留存（0 也是有效原文）
  assert.equal(rows[0]?.problem.difficultyScale, 'pta-level-5');
});

test('pta: 越界难度值不钳位、不猜，只留原文', async () => {
  const adapter = createPtaAdapter(
    router({
      '/api/problem-sets/always-available': ALWAYS_AVAILABLE,
      '/users/1693903232973955072/submissions': {
        submissions: [sub({ id: '300', status: 'ACCEPTED' })],
        hasBefore: false,
      },
      '/exam-problem-list': {
        total: 1,
        problemSetProblems: [
          { id: '994805516654460928', label: '1006', title: 'X', difficulty: 9 }, // 站点未来扩档
        ],
      },
    }),
  );
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', { pageDelayMs: 0 });
  assert.equal(rows[0]?.problem.difficulty, undefined);
  assert.equal(rows[0]?.problem.nativeDifficulty, '9');
  assert.equal(rows[0]?.problem.difficultyScale, 'pta-level-5');
});

test('pta: parsePtaProblemList 透传难度原文（0-5 序数，不做本地换算）', () => {
  const { items } = parsePtaProblemList({
    total: 3,
    problemSetProblems: [
      { id: '1', label: 'A', title: 'a', difficulty: 0 },
      { id: '2', label: 'B', title: 'b', difficulty: 4 },
      { id: '3', label: 'C', title: 'c' },
    ],
  });
  assert.equal(items[0]?.difficulty, 0);
  assert.equal(items[1]?.difficulty, 4);
  assert.equal('difficulty' in (items[2] ?? {}), false); // 缺失不补默认值
});


// ---------- 请求频率（限速 / 额外请求上限） ----------

test('pta: 元数据补拉有总量上限（20 套有新行也只发 12 次题目表请求）', async () => {
  // 每套题集都产出一行新提交，且题目表恒返回满页 200（原本会 5 页/集 × 20 集 = 100 次）
  const sets = Array.from({ length: 20 }, (_, i) => ({ id: String(100 + i), name: `S${i}` }));
  const log: string[] = [];
  const adapter = createPtaAdapter(async (input: string | URL | Request) => {
    const url = String(input);
    log.push(url);
    if (url.includes('always-available')) {
      return new Response(JSON.stringify({ problemSets: sets }), { status: 200 });
    }
    if (url.includes('/exam-problem-list')) {
      const rows = Array.from({ length: 200 }, (_, i) => ({
        id: String(900000 + i),
        label: `L${i}`,
        title: `T${i}`,
        difficulty: 3,
      }));
      return new Response(JSON.stringify({ total: 1000, problemSetProblems: rows }), { status: 200 });
    }
    const setId = /problem-sets\/(\d+)\/users/.exec(url)?.[1] ?? '';
    return new Response(
      JSON.stringify({
        submissions: [
          { id: `s${setId}`, problemSetProblemId: '900000', submitAt: '2026-11-09T13:00:00Z', status: 'ACCEPTED' },
        ],
        hasBefore: false,
        problemSetProblemById: { '900000': { id: '900000', label: 'L0', title: '' } },
      }),
      { status: 200 },
    );
  });
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', { pageDelayMs: 0 });
  assert.equal(rows.length, 20);
  const metaReqs = log.filter((u) => u.includes('/exam-problem-list')).length;
  const subReqs = log.filter((u) => u.includes('/users/')).length;
  assert.equal(subReqs, 20, '提交分页每集 1 次');
  assert.ok(metaReqs <= 12, `元数据请求必须被封顶到 12 次，实际 ${metaReqs}`);
  assert.ok(metaReqs > 0, '至少有新增行就该尝试补元数据');
  // 前几套题集仍拿到了标题与难度（预算没被浪费）
  assert.equal(rows.filter((r) => r.problem.title.startsWith('T')).length > 0, true);
  assert.equal(rows.find((r) => r.problem.title.startsWith('T'))?.problem.difficulty, 1600);
});

test('pta: 元数据分页的等待计入 waited_ms（同步中心的限速耗时）', async () => {
  const sets = [{ id: '100', name: 'S' }];
  const adapter = createPtaAdapter(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('always-available')) {
      return new Response(JSON.stringify({ problemSets: sets }), { status: 200 });
    }
    if (url.includes('/exam-problem-list')) {
      const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(900000 + i), label: `L${i}`, title: `T${i}` }));
      return new Response(JSON.stringify({ total: 1000, problemSetProblems: rows }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        submissions: [
          { id: 's1', problemSetProblemId: '900000', submitAt: '2026-11-09T13:00:00Z', status: 'ACCEPTED' },
        ],
        hasBefore: false,
      }),
      { status: 200 },
    );
  });
  const opts: { pageDelayMs: number; waitedMs?: number } = { pageDelayMs: 5 };
  await adapter.fetchUserSubmissions('1693903232973955072', opts);
  // 提交页间与元数据页间的等待都必须累计（此前元数据那段用裸 sleep，waited_ms 里看不见）
  assert.ok((opts.waitedMs ?? 0) > 0, `元数据分页的等待应计入 waited_ms，实际 ${opts.waitedMs}`);
});

test('pta: checkAuth 依据 passport /api/u/current 的内容判定（该接口未登录也是 200）', async () => {
  const anonymous = createPtaAdapter(
    async () =>
      new Response(
        JSON.stringify({ emailLogin: false, omsLogin: false, studentUserLogin: false, phoneLogin: false, userMfa: [] }),
        { status: 200 },
      ),
  );
  const anonResult = await anonymous.checkAuth!({ cookie: 'PTASession=expired' });
  assert.equal(anonResult.ok, false);
  assert.match(anonResult.message, /PTASession/);

  const loggedIn = createPtaAdapter(
    async () =>
      new Response(JSON.stringify({ user: { id: '1693903232973955072', nickname: 'leonyret', emailLogin: true } }), {
        status: 200,
      }),
  );
  const okResult = await loggedIn.checkAuth!({ cookie: 'PTASession=good' });
  assert.equal(okResult.ok, true);
  assert.match(okResult.message, /leonyret/);
});

test('pta: ptaIdentity 只认真正登录的身份（游客身份 id="0" 必须被排除）', () => {
  // 游客：站点前端模型里的空身份，id 是字符串 "0" 而不是缺字段
  assert.equal(ptaIdentity({ id: '0', nickname: '', isGuest: true }), null);
  // 真登录：包在 user 里 / 平铺两种形状都接受
  assert.deepEqual(ptaIdentity({ user: { id: '1693903232973955072', nickname: 'leonyret' } }), {
    id: '1693903232973955072',
    nickname: 'leonyret',
  });
  assert.deepEqual(ptaIdentity({ id: '42', emailLogin: true }), { id: '42' });
  // 有 login 标志但没 id → 仍不算（拿不到可用 handle）
  assert.equal(ptaIdentity({ id: '0', emailLogin: true }), null);
  assert.equal(ptaIdentity({}), null);
  assert.equal(ptaIdentity(null), null);
});

test('pta: identify 由登录凭据反查 userId；匿名会话（200 + 空身份）判失败', async () => {
  const seen: string[] = [];
  const loggedIn = createPtaAdapter(
    async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ user: { id: '1693903232973955072', nickname: 'leonyret' } }), {
        status: 200,
      });
    },
  );
  const ok = await loggedIn.identify!({ cookie: 'PTASession=good' });
  assert.equal(ok.ok, true);
  // handle 就是可直接用于同步的 userId —— 这正是「不用手抄 19 位数字」的价值
  assert.equal(ok.handle, '1693903232973955072');
  assert.equal(ok.nickname, 'leonyret');
  assert.match(ok.message, /1693903232973955072/);
  assert.match(ok.message, /leonyret/);
  assert.match(seen[0]!, /passport\.pintia\.cn\/api\/u\/current/);

  // 匿名：passport 对游客返回 200 + 空身份（实测），不能被当成登录成功
  const anonymous = createPtaAdapter(
    async () =>
      new Response(JSON.stringify({ emailLogin: false, omsLogin: false, studentUserLogin: false, phoneLogin: false }), {
        status: 200,
      }),
  );
  const anon = await anonymous.identify!({ cookie: 'PTASession=guest' });
  assert.equal(anon.ok, false);
  assert.equal(anon.handle, undefined);
  assert.match(anon.message, /PTASession/);

  // 没有 Cookie 就不该发请求
  const noCookie = createPtaAdapter(async () => {
    throw new Error('不该被调用');
  });
  const none = await noCookie.identify!({ cookie: '' });
  assert.equal(none.ok, false);
});

test('pta: 已注册到适配器注册表', () => {
  initAdapters();
  const adapter = getAdapter('pta');
  assert.ok(adapter);
  assert.equal(adapter!.platform, 'pta');
  assert.equal(
    adapter!.problemUrl({ problemKey: `${PS}-994805528788582400` }),
    `https://pintia.cn/problem-sets/${PS}/exam/problems/type/7?problemSetProblemId=994805528788582400`,
    '适配器下发的题目链接必须是站点 SPA 真实路由（旧路径点开是 404）',
  );
});

test('pta: 平台元数据的 identify 标记与适配器能力一致（防止前端渲染出必然失败的按钮）', () => {
  initAdapters();
  const adapter = getAdapter('pta');
  assert.equal(typeof adapter!.identify, 'function', '适配器实现了 identify');
  // shared 的 PlatformMeta.identify 决定设置页是否渲染「识别账号」按钮：
  // 两边漂移的后果是「按钮在但必然失败」或「有这能力却没有入口」
  assert.equal(platformMeta('pta').identify, true);
  // 未声明该能力的平台不该被误标
  assert.notEqual(platformMeta('codeforces').identify, true);
});

test('pta: 题集被页预算挡住时回写续拉游标，下次从该题集续拉', async () => {
  // 3 套题集、每次只有 2 页预算：第 1 轮必须停在能看完全部题集之前，并回写游标
  const sets = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }];
  const makeAdapter = (log: string[]) =>
    createPtaAdapter(
      router(
        {
          '/api/problem-sets/always-available': { problemSets: sets },
          '/users/1693903232973955072/submissions': {
            submissions: [sub({ id: '300', status: 'ACCEPTED', submitAt: '2026-11-09T13:00:00Z' })],
            hasBefore: true, // 永远还有更旧页 → 逼着继续翻页
          },
        },
        log,
      ),
    );
  const log1: string[] = [];
  const opts1 = { pageDelayMs: 0, maxSubmissions: 2 } as { pageDelayMs: number; maxSubmissions: number; truncated?: boolean; backfillReachedPage?: number };
  // maxSubmissions=2 → pageBudget = ceil(2/200)*2 = 2；题集数 3 → 预算取 max(3, 2) = 3
  const rows1 = await makeAdapter(log1).fetchUserSubmissions('1693903232973955072', opts1);
  assert.ok(rows1.length > 0);
  // 预算 3 页：第 1 套吃掉 1 页（hasBefore 恒 true → 但单集上限 4 页，会继续翻），
  // 因此第 1 套就用光预算 → 游标停在第 1 套（1 基 = 1），下次从它重扫（已入库行跳过）
  assert.equal(opts1.truncated, true);
  assert.equal(opts1.backfillReachedPage, 1);

  // 第 2 轮从第 1 套续拉：仍然只够第 1 套 → 游标不前进（不会跳过它去扫第 2 套）
  const log2: string[] = [];
  const opts2 = { pageDelayMs: 0, maxSubmissions: 2, backfill: true, backfillFromPage: 1 } as typeof opts1;
  await makeAdapter(log2).fetchUserSubmissions('1693903232973955072', opts2);
  assert.equal(opts2.backfillReachedPage, 1);
});

test('pta: 单集翻完（hasBefore=false）后游标前进到下一套', async () => {
  const sets = [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }];
  let call = 0;
  const adapter = createPtaAdapter(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/problem-sets/always-available')) {
      return new Response(JSON.stringify({ problemSets: sets }), { status: 200 });
    }
    call += 1;
    // 第 1 套返回 1 条且没有更旧页；第 2 套起同样处理 → 每套 1 次请求
    return new Response(
      JSON.stringify({
        submissions: [sub({ id: String(1000 + call), status: 'ACCEPTED', submitAt: '2026-11-09T13:00:00Z' })],
        hasBefore: false,
      }),
      { status: 200 },
    );
  });
  const opts = { pageDelayMs: 0 } as { pageDelayMs: number; truncated?: boolean; backfillReachedPage?: number };
  const rows = await adapter.fetchUserSubmissions('1693903232973955072', opts);
  assert.equal(rows.length, 3); // 3 套各 1 条
  assert.equal(opts.truncated, undefined); // 自然结束，不算截断
  assert.equal(opts.backfillReachedPage, undefined);
});

test('pta: 补全模式从 backfillFromPage 指定的题集续拉（不从头重扫）', async () => {
  const log: string[] = [];
  const adapter = createPtaAdapter(
    router(
      {
        '/api/problem-sets/always-available': {
          problemSets: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }],
        },
        '/users/1693903232973955072/submissions': { submissions: [], hasBefore: false },
      },
      log,
    ),
  );
  await adapter.fetchUserSubmissions('1693903232973955072', {
    pageDelayMs: 0,
    backfill: true,
    backfillFromPage: 3, // 从第 3 套续拉
  });
  const setIds = log
    .filter((u) => u.includes('/submissions'))
    .map((u) => /problem-sets\/(\d+)\//.exec(u)?.[1]);
  assert.deepEqual(setIds, ['3']); // 第 1、2 套不再重扫
});
