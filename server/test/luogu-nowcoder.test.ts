import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLuoguAdapter } from '../src/adapters/luogu.ts';
import { createNowcoderAdapter } from '../src/adapters/nowcoder.ts';
import { ManualImportRequiredError } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

function router(
  handlers: Record<string, (url: string) => unknown>,
): typeof fetch {
  return async (input: string | URL | Request) => {
    const u = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (u.includes(prefix)) {
        const v = handler(u);
        if (typeof v === 'string') return new Response(v, { status: 200 });
        if (v && typeof v === 'object' && 'status' in v) {
          const r = v as { status: number; body: string; headers?: Record<string, string> };
          return new Response(r.body, {
            status: r.status,
            headers: r.headers ?? {},
          });
        }
        return new Response(JSON.stringify(v), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

const COOKIE = '__client_id=abc; _uid=123';

// ---------- 洛谷 ----------

test('luogu: without cookie throws ManualImportRequiredError, url works', async () => {
  const adapter = createLuoguAdapter();
  await assert.rejects(() => adapter.fetchUserSubmissions('uid'), ManualImportRequiredError);
  assert.equal(
    adapter.problemUrl({ problemKey: 'P1001' }),
    'https://www.luogu.com.cn/problem/P1001',
  );
});

test('luogu: checkAuth reports valid cookie via record/list self-check', async () => {
  const fetchFn = router({
    'record/list': (url) => {
      // 检测应从 Cookie 提取 _uid 并走同步同款接口
      assert.ok(url.includes('user=123'), 'checkAuth should use _uid from cookie');
      return { code: 200, currentData: { records: { result: [] } } };
    },
  });
  const adapter = createLuoguAdapter(fetchFn);
  const r = await adapter.checkAuth!({ cookie: COOKIE, csrf: 'tok' });
  assert.equal(r.ok, true);
});

test('luogu: checkAuth works with new Lentille structure (data.data.records)', async () => {
  // 洛谷升级 Lentille 管线后，_contentOnly=1 失效，需 x-lentille-request: content-only 请求头
  // 响应结构从 data.currentData.records 变为 data.data.records
  const fetchFn = router({
    'record/list': () => ({
      code: 200,
      data: { records: { result: [{ id: 1, status: 12, submitTime: 1700000000 }] } },
    }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const r = await adapter.checkAuth!({ cookie: COOKIE });
  assert.equal(r.ok, true);
});

test('luogu: checkAuth reports invalid cookie missing _uid', async () => {
  const adapter = createLuoguAdapter(router({}));
  const r = await adapter.checkAuth!({ cookie: '__client_id=abc' });
  assert.equal(r.ok, false);
  assert.match(r.message, /缺少 _uid/);
});

test('luogu: checkAuth reports expired cookie on 302 without fresh C3VK', async () => {
  const fetchFn = router({
    'record/list': () => ({ status: 302, body: '' }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const r = await adapter.checkAuth!({ cookie: COOKIE });
  assert.equal(r.ok, false);
  assert.match(r.message, /Cookie 无效或已过期/);
});

test('luogu: checkAuth reports non-JSON response as invalid', async () => {
  const fetchFn = router({
    'record/list': () => ({ status: 200, body: '<html>login page</html>' }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const r = await adapter.checkAuth!({ cookie: COOKIE });
  assert.equal(r.ok, false);
  assert.match(r.message, /返回非 JSON/);
});

test('luogu: checkAuth reports abnormal structure as invalid', async () => {
  const fetchFn = router({
    'record/list': () => ({ code: 403, currentData: null }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const r = await adapter.checkAuth!({ cookie: COOKIE });
  assert.equal(r.ok, false);
  assert.match(r.message, /结构异常/);
});

test('luogu: checkAuth tolerates network failure', async () => {
  const fetchFn = (async () => {
    throw new Error('fetch failed');
  }) as typeof fetch;
  const adapter = createLuoguAdapter(fetchFn);
  const r = await adapter.checkAuth!({ cookie: COOKIE });
  assert.equal(r.ok, false);
  assert.match(r.message, /网络异常/);
});

test('luogu: with cookie normalizes records and problem info', async () => {
  const fetchFn = router({
    'record/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') {
        return { code: 200, currentData: { records: { result: [] } } };
      }
      return {
        code: 200,
        currentData: {
          records: {
            result: [
              // language 线上真实形态是数字 langId（洛谷不给名称字典）：夹具必须照实写，
              // 早先写成 'C++17' 字符串让「数字被存成 "34.0"」的 bug 一路漏测
              { id: 9001, status: 12, submitTime: 1700000000000, language: 34, problem: { pid: 'P1001', title: 'A+B Problem', difficulty: 2 } },
              { id: 9002, status: 14, submitTime: 1700000100000, language: 2, problem: { pid: 'P1002' } },
              { id: 9003, status: 11, submitTime: 1700000200000, problem: { pid: 'P1003' } },
              { id: 9004, status: 1, submitTime: 1700000300000, problem: { pid: 'P1004' } }, // 评测中：应被过滤
            ],
          },
        },
      };
    },
    '/problem/': (url) => {
      const pid = url.includes('P1001') ? 'P1001' : url.includes('P1002') ? 'P1002' : 'P1003';
      // 线上 Lentille 接口真实结构：data.problem（非 currentData），标题字段为 name（非 title）
      // tags 为 tag id 数组，经 /_lfe/tags 字典转名称
      return {
        code: 200,
        data: {
          problem: {
            pid,
            name: pid === 'P1001' ? 'A+B Problem' : `T ${pid}`,
            difficulty: pid === 'P1001' ? 2 : undefined,
            tags: pid === 'P1001' ? [42, 108] : [],
          },
        },
      };
    },
    '_lfe/tags': () => ({
      tags: [
        { id: 42, name: '入门' },
        { id: 108, name: '模拟' },
      ],
    }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('123', { cookie: COOKIE, csrf: 'tok' });

  assert.equal(rows.length, 3); // 9004（评测中）被过滤
  const r0 = rows[0];
  assert.equal(r0.verdict, 'AC'); // status 12 = AC
  assert.equal(r0.problem.problemKey, 'P1001');
  assert.equal(r0.problem.title, 'A+B Problem');
  assert.equal(r0.problem.difficulty, 1000); // 洛谷难度 2（普及-）→ CF 1000（统一实测表：2 → 1000）
  assert.equal(r0.problem.nativeDifficulty, '2');
  assert.equal(r0.problem.difficultyScale, 'luogu-2026-06');
  assert.deepEqual(r0.problem.tags, ['入门', '模拟']);
  assert.equal(r0.problem.url, 'https://www.luogu.com.cn/problem/P1001');
  // 数字 langId 归一为整数字符串（不得出现 "34.0"），缺失语言的行不下发该键
  assert.equal(r0.language, '34');
  assert.equal(rows[1].language, '2');
  assert.equal('language' in rows[2], false);
  assert.equal(r0.externalId, '9001');
  assert.equal(new Date(r0.submittedAt).toISOString(), new Date(1700000000000).toISOString());
  assert.equal(rows[1].verdict, 'WA'); // status 14 = Unaccepted → WA
  assert.equal(rows[1].problem.title, 'T P1002');
  assert.equal('difficulty' in rows[1].problem, false); // 无难度时不写入
  assert.equal(rows[2].verdict, 'RE'); // status 11 = UKE → RE
});

test('luogu: fetchUserSubmissions works with new Lentille structure (data.data.records)', async () => {
  // 洛谷升级 Lentille 管线后响应结构从 data.currentData.records 变为 data.data.records
  const fetchFn = router({
    'record/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') return { code: 200, data: { records: { result: [] } } };
      return {
        code: 200,
        data: {
          records: {
            result: [
              { id: 9301, status: 12, submitTime: 1700000000000, problem: { pid: 'P1001', difficulty: 2 } },
            ],
          },
        },
      };
    },
    '/problem/': () => ({ code: 200, data: { problem: { pid: 'P1001', difficulty: 2, tags: [] } } }),
    '_lfe/tags': () => ({ tags: [] }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('123', { cookie: COOKIE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalId, '9301');
  assert.equal(rows[0].verdict, 'AC');
});

test('luogu: 补全连续 2 个整页已知即收尾（回归：曾空扫满 30 页预算）', async () => {
  // 实测：库中已有全部提交时，补全模式旧实现会翻满页数预算（默认 30 次请求、0 新增）
  let calls = 0;
  const fetchFn = router({
    'record/list': (url) => {
      calls += 1;
      const page = Number(new URL(url).searchParams.get('page'));
      return {
        code: 200,
        data: {
          records: {
            result: [0, 1].map((i) => ({
              id: page * 1000 + i,
              status: 12,
              submitTime: 1_700_000_000 - i,
              problem: { pid: `P${page}${i}`, difficulty: 3, tags: [] },
            })),
          },
        },
      };
    },
  });
  const known = new Set(['1000', '1001', '2000', '2001', '3000', '3001']);
  const opts: { cookie: string; knownExternalIds: Set<string>; backfill: boolean; maxSubmissions: number; pageDelayMs: number; truncated?: boolean } = {
    cookie: COOKIE,
    knownExternalIds: known,
    backfill: true,
    maxSubmissions: 100, // 预算 = ⌈100/20⌉×2 = 10 页
    pageDelayMs: 0,
  };
  const rows = await createLuoguAdapter(fetchFn).fetchUserSubmissions('123', opts);
  assert.equal(rows.length, 0);
  assert.equal(calls, 2, '连续 2 个整页已知即停（旧实现会请求满 10 页）');
  assert.equal(opts.truncated, undefined, '补全到尽头不算截断');
});

test('luogu: 秒级 submitTime 正确转毫秒（回归：曾被当毫秒解析全部落回 1970）', async () => {
  // 线上实测洛谷 record.submitTime 是 10 位秒级时间戳
  const fetchFn = router({
    'record/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') return { code: 200, currentData: { records: { result: [] } } };
      return {
        code: 200,
        currentData: {
          records: {
            result: [
              { id: 9101, status: 12, submitTime: 1790000000, problem: { pid: 'P1001', difficulty: 2 } },
            ],
          },
        },
      };
    },
    '/problem/': () => ({ code: 200, data: { problem: { pid: 'P1001', difficulty: 2, tags: [] } } }),
    '_lfe/tags': () => ({ tags: [] }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('123', { cookie: COOKIE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].submittedAt, new Date(1790000000 * 1000).toISOString());
});

test('luogu: 题目页返回 data.problem.name（无 title）时标题取 name 而非退化 pid', async () => {
  // 回归：LuoguProblem 曾缺 name 字段，fetchProblemInfo 只读 p.title 得到 undefined，
  // 标题退化为 pid。线上 Lentille 接口标题字段为 name，需兼容取值。
  const fetchFn = router({
    'record/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') return { code: 200, currentData: { records: { result: [] } } };
      return {
        code: 200,
        currentData: {
          records: {
            result: [
              { id: 9201, status: 12, submitTime: 1700000000000, problem: { pid: 'P3372' } },
            ],
          },
        },
      };
    },
    '/problem/': () => ({
      code: 200,
      data: { problem: { pid: 'P3372', name: '【模板】线段树 1', difficulty: 4, tags: [42, 523] } },
    }),
    '_lfe/tags': () => ({ tags: [{ id: 42, name: '线段树' }, { id: 523, name: '模板题' }] }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('123', { cookie: COOKIE });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].problem.title, '【模板】线段树 1', '标题应取 name 而非退化成 pid');
  assert.deepEqual(rows[0].problem.tags, ['线段树', '模板题']);
});

test('luogu: 分页可超过 100 页（>2000 条提交的首次全量同步不被截断）', async () => {
  // 回归：原 MAX_PAGES=100，洛谷提交 >2000 的用户首次同步只拉到最近 100 页
  const PAGES = 120;
  let pageHits = 0;
  const fetchFn = router({
    'record/list': (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      pageHits += 1;
      if (page <= PAGES) {
        return {
          code: 200,
          currentData: {
            records: {
              result: [
                // 同一题目的多条提交（题目信息走缓存，避免逐题抓取拖慢测试）
                { id: 1000 + page, status: 12, submitTime: 1700000000000 + page, language: 28, problem: { pid: 'P1001', title: 'A+B Problem', difficulty: 2 } },
              ],
            },
          },
        };
      }
      return { code: 200, currentData: { records: { result: [] } } }; // 空页 → 终止
    },
  });
  const adapter = createLuoguAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('123', { cookie: COOKIE, csrf: 'tok', pageDelayMs: 0 });
  assert.equal(rows.length, PAGES);
  assert.equal(pageHits, PAGES + 1); // 拉到空页才停
});

test('luogu: 7000+ 提交分批拉取防封号（首刷截断 + 补全续拉 + 完成）', async () => {
  // 模拟用户反馈场景：7000 条提交（350 页 × 20 条），单次上限 1000 → 需多次同步补全
  const TOTAL_PAGES = 350;
  const PAGE_SIZE = 20;
  // 构造 350 页数据：每页 20 条 AC，id 全局唯一
  const fetchFn = router({
    'record/list': (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      if (page < 1 || page > TOTAL_PAGES) {
        return { code: 200, currentData: { records: { result: [] } } }; // 越界 → 空页终止
      }
      const result = Array.from({ length: PAGE_SIZE }, (_, i) => ({
        id: (page - 1) * PAGE_SIZE + i + 1,
        status: 12,
        submitTime: 1700000000 + (TOTAL_PAGES - page) * 100 + i,
        language: 28,
        problem: { pid: 'P1001', title: 'A+B', difficulty: 2 },
      }));
      return { code: 200, currentData: { records: { result } } };
    },
  });
  const adapter = createLuoguAdapter(fetchFn);

  // 模拟同步层的真实流程：每次同步注入已知 id（已入库的），补全模式跳过已知页续拉
  // 第一次同步：无已知 id，maxSubmissions=1000 → 拉 50 页后截断
  const known = new Set<string>();
  const mkOpts = (extra: Record<string, unknown>) => ({
    cookie: COOKIE,
    csrf: 'tok',
    maxSubmissions: 1000,
    pageDelayMs: 0,
    knownExternalIds: known,
    ...extra,
  }) as { truncated?: boolean; backfillReachedPage?: number; [k: string]: unknown };
  const opts1 = mkOpts({});
  const rows1 = await adapter.fetchUserSubmissions('123', opts1);
  assert.equal(rows1.length, 1000);
  assert.equal(opts1.truncated, true);
  for (const r of rows1) known.add(r.externalId); // 入库后成为已知

  // 第二次同步：补全模式从游标续拉，knownIds 跳过已入库页
  const opts2 = mkOpts({ backfill: true, backfillFromPage: opts1.backfillReachedPage });
  const rows2 = await adapter.fetchUserSubmissions('123', opts2);
  assert.equal(opts2.truncated, true);
  for (const r of rows2) known.add(r.externalId);

  // 第三次补全：继续续拉
  const opts3 = mkOpts({ backfill: true, backfillFromPage: opts2.backfillReachedPage });
  const rows3 = await adapter.fetchUserSubmissions('123', opts3);
  for (const r of rows3) known.add(r.externalId);

  // 验证三次拉取的 id 不重叠（knownIds 跳过已知页，分批正确无重复）
  const allIds = [...rows1, ...rows2, ...rows3].map((r) => r.externalId);
  assert.equal(new Set(allIds).size, allIds.length); // 无重复
  assert.equal(allIds.length, 3000); // 三批各 1000 条
});

test('luogu: non-success code throws (cookie invalid/risk control)', async () => {
  const fetchFn = router({
    'record/list': () => ({ code: 401, message: 'invalid token' }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: 'bad' }),
    /响应异常/,
  );
});

test('luogu: missing structure throws instead of silent empty', async () => {
  const fetchFn = router({
    'record/list': () => ({ code: 200 }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: 'c' }),
    /响应异常/,
  );
});

test('luogu: HTML login page (302 follow) throws clear not-logged-in error', async () => {
  const fetchFn = router({
    'record/list': () => ({ status: 200, body: '<!DOCTYPE html><html><head><title>登录</title></head><body>登录洛谷</body></html>' }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: '__client_id=test; _uid=1' }),
    /未登录页面.*Cookie 无效或已过期/,
  );
});

test('luogu: 302 redirect (not logged in) throws clear login-required error', async () => {
  const fetchFn = router({
    'record/list': () => ({ status: 302, body: '' }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('123', { cookie: '__client_id=test; _uid=1' }),
    /登录跳转.*Cookie 无效或已过期/,
  );
});

test('luogu: C3VK challenge — 302 with new cookie then retry succeeds', async () => {
  let calls = 0;
  const fetchFn = router({
    'record/list': () => {
      calls += 1;
      if (calls === 1) {
        // 首次：302 + 下发新 C3VK（反爬挑战）
        return {
          status: 302,
          body: '<html><head><title>302 Found</title></head></html>',
          headers: { 'set-cookie': 'C3VK=118e41; Max-Age=300; Path=/' },
        };
      }
      if (calls === 2) {
        // 重试：带新 C3VK 后放行（第 1 页数据）
        return {
          code: 200,
          currentData: {
            records: {
              result: [{ id: 9001, status: 2, submitTime: 1700000000000, problem: { pid: 'P1001' } }],
            },
          },
        };
      }
      // 后续页为空 → 分页终止
      return { code: 200, currentData: { records: { result: [] } } };
    },
  });
  const adapter = createLuoguAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('12345678', {
    cookie: '__client_id=x; _uid=12345678; C3VK=old',
    csrf: 'tok',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].externalId, '9001');
  assert.ok(calls >= 2); // 挑战后重试过
});

// ---------- 牛客 ----------

/** 构造牛客 practice-coding 页 HTML（表头 <th> + 数据行） */
function ncPage(rows: Array<[sid: string, pid: string, title: string, result: string, lang: string, time: string]>): string {
  const trs = rows
    .map(
      ([sid, pid, title, result, lang, time]) =>
        `<tr>
          <td><a href="/acm/contest/view-submission?submissionId=${sid}&uid=123">${sid}</a></td>
          <td><a href="/acm/problem/${pid}">${title}</a></td>
          <td><span>${result}</span></td>
          <td>30</td><td>1000</td><td>0</td><td>528</td>
          <td>${lang}</td><td>${time}</td>
        </tr>`,
    )
    .join('');
  return `<table><thead><tr><th>运行ID</th><th>题目</th><th>运行结果</th><th>得分</th><th>运行时间(ms)</th><th>使用内存(KB)</th><th>代码长度</th><th>使用语言</th><th>提交时间</th></tr></thead><tbody>${trs}</tbody></table>`;
}

test('nowcoder: parses practice-coding HTML without cookie, url works', async () => {
  const fetchFn = router({
    'practice-coding': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') return ncPage([]); // 第二页空 → 停止
      return ncPage([
        ['5001', '10001', 'A+B', '答案正确', 'C++', '2026-08-02 20:29:23'],
        ['5002', '10002', 'B+C', '答案错误', 'Java', '2026-08-02 20:20:00'],
        ['5003', '10003', 'C+D', '运行超时', 'Python', '2026-08-02 19:59:55'],
      ]);
    },
  });
  const adapter = createNowcoderAdapter(fetchFn);
  // 无需 cookie（公开页面）
  const rows = await adapter.fetchUserSubmissions('87654321', {});

  assert.equal(rows.length, 3);
  assert.equal(rows[0].verdict, 'AC');
  assert.equal(rows[0].problem.problemKey, '10001');
  assert.equal(rows[0].problem.title, 'A+B');
  assert.equal(rows[0].problem.url, 'https://ac.nowcoder.com/acm/problem/10001');
  assert.equal(rows[0].externalId, '5001');
  assert.equal(rows[0].language, 'C++');
  assert.equal(rows[0].submittedAt, '2026-08-02T12:29:23.000Z'); // +08:00 → UTC
  assert.equal(rows[1].verdict, 'WA');
  assert.equal(rows[2].verdict, 'TLE');
  assert.equal(
    adapter.problemUrl({ problemKey: 'P1001' }),
    'https://ac.nowcoder.com/acm/problem/P1001',
  );
});

test('nowcoder: 增量依赖 knownExternalIds 精确判重，不用 since 时间截断', async () => {
  // 场景：提交时间早于 since（上次同步时刻）的新记录（评测/列表延迟导致）
  // 必须照常入库——时间截断会漏掉它（真实踩坑：84681878 提交于上次同步前却晚出现在列表）
  const fetchFn = router({
    'practice-coding': () =>
      ncPage([['5001', '10001', 'A+B', '答案正确', 'C++', '2026-08-01 10:00:00']]),
  });
  const adapter = createNowcoderAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('87654321', {
    since: '2026-08-02T00:00:00.000Z', // 晚于提交时间，也不应截断
  });
  assert.equal(rows.length, 1, '提交时间早于 since 的新记录必须入库（knownExternalIds 才是增量依据）');
  assert.equal(rows[0].externalId, '5001');
});

test('nowcoder: 整页已知时增量早停（knownExternalIds）', async () => {
  // 首页全为已知提交 → 不再翻更旧的页（增量早停，防全量重扫）
  let pageCalls = 0;
  const fetchFn = router({
    'practice-coding': (url) => {
      pageCalls += 1;
      return ncPage([['5001', '10001', 'A+B', '答案正确', 'C++', '2026-08-01 10:00:00']]);
    },
  });
  const adapter = createNowcoderAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('87654321', {
    knownExternalIds: new Set(['5001']),
  });
  assert.equal(rows.length, 0);
  assert.equal(pageCalls, 1, '整页已知应只请求一页即停');
});

/**
 * 上面那条早停测试直接把 knownExternalIds 传进适配器，绕过了同步层的注入条件，
 * 因而测不到真正的断点：sync.ts 只对声明了 knownIdsFilter 的适配器注入该集合。
 * 牛客漏了这个标记 → 线上增量同步永远拿不到已知提交号（每轮全量重扫 + 永远报待补全）。
 */
test('nowcoder: 声明 knownIdsFilter，同步层才会注入 knownExternalIds', () => {
  // 不注入 fetch：这里只看契约标记，不会真的发请求
  assert.equal(createNowcoderAdapter().knownIdsFilter, true);
});

test('nowcoder: HTTP failure throws', async () => {
  const fetchFn = router({
    'practice-coding': () => ({ status: 403, body: '<html>blocked</html>' }),
  });
  const adapter = createNowcoderAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('87654321', {}),
    /HTTP 403/,
  );
});

test('nowcoder: first page with no rows throws (structure changed / risk control)', async () => {
  const fetchFn = router({
    'practice-coding': () => ncPage([]),
  });
  const adapter = createNowcoderAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('87654321', {}),
    /未解析到提交记录/,
  );
});

test('nowcoder: unknown result maps to SKIPPED, short rows skipped', async () => {
  const html =
    '<table><tbody>' +
    // 正常行：未知状态
    '<tr><td><a href="/acm/contest/view-submission?submissionId=6001&uid=1">6001</a></td>' +
    '<td><a href="/acm/problem/20001">X</a></td><td>系统异常状态</td><td>0</td><td>1</td><td>2</td><td>3</td><td>C++</td><td>2026-08-01 10:00:00</td></tr>' +
    // 异常行：仅 8 列（缺提交时间）→ 应跳过不崩溃
    '<tr><td><a href="/acm/contest/view-submission?submissionId=6002&uid=1">6002</a></td>' +
    '<td><a href="/acm/problem/20002">Y</a></td><td>答案正确</td><td>0</td><td>1</td><td>2</td><td>3</td><td>C++</td></tr>' +
    '</tbody></table>';
  const fetchFn = router({
    'practice-coding': (url) => {
      const page = new URL(url).searchParams.get('page');
      return page === '1' ? html : ncPage([]);
    },
  });
  const adapter = createNowcoderAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('87654321', {});
  assert.equal(rows.length, 1); // 6002（8 列异常行）被跳过
  assert.equal(rows[0].externalId, '6001');
  assert.equal(rows[0].verdict, 'SKIPPED'); // 未知状态 → SKIPPED
});

test('luogu: C3VK challenge retry carries fresh cookie in request', async () => {
  const seenCookies: string[] = [];
  const fetchFn = router({
    'record/list': () => {
      return {
        status: 302,
        body: '',
        headers: { 'set-cookie': 'C3VK=118e41; Max-Age=300; Path=/' },
      };
    },
  });
  // 拦截 fetch 记录 Cookie 头
  const recordFetch: typeof fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    seenCookies.push(headers?.Cookie ?? '');
    return fetchFn(input, init);
  };
  const adapter = createLuoguAdapter(recordFetch);
  // mock 每次 302 都下发新 C3VK → 挑战重试耗尽后 504
  await assert.rejects(
    () => adapter.fetchUserSubmissions('12345678', { cookie: '__client_id=x; _uid=12345678; C3VK=old', csrf: 'tok' }),
    /HTTP 504/,
  );
  // 重试请求的 Cookie 中 C3VK 已从 old 替换为 118e41
  assert.ok(seenCookies.some((c) => c.includes('C3VK=118e41')));
});

test('luogu: C3VK challenge exhaustion (always 302) reports HTTP 504', async () => {
  const fetchFn = router({
    'record/list': () => ({
      status: 302,
      body: '',
      headers: { 'set-cookie': 'C3VK=abc; Max-Age=300; Path=/' },
    }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  await assert.rejects(
    () => adapter.fetchUserSubmissions('12345678', { cookie: '__client_id=x; _uid=1; C3VK=old', csrf: 'tok' }),
    /HTTP 504/,
  );
});

test('manual-required error carries code MANUAL_REQUIRED', () => {
  const e = new ManualImportRequiredError('luogu', '说明');
  assert.equal(e.code, 'MANUAL_REQUIRED');
  assert.match(e.message, /luogu/);
});

test('luogu/nowcoder registered in registry', () => {
  initAdapters();
  assert.ok(getAdapter('luogu'));
  assert.ok(getAdapter('nowcoder'));
});

test('nowcoder: 瞬态/未终态结果（等待评测/运行中/系统错误/未知错误）不落库不计已知', async () => {
  // 契约（pagination.ts normalize）：评测中/瞬态行返回 null —— 既不计入已知也不计入新增。
  // 若按 SKIPPED 带真实提交号入库，该行下次同步即被判「已知」，终局判定（答案正确/答案错误）
  // 永远补不回来（永久丢数据）。洛谷对 status 0/1/-1 同口径。
  const fetchFn = router({
    'practice-coding': (url) => {
      const page = new URL(url).searchParams.get('page');
      if (page !== '1') return ncPage([]);
      return ncPage([
        ['6001', '10001', 'A+B', '答案正确', 'C++', '2026-08-02 20:29:23'],
        ['6002', '10002', 'B+C', '等待评测', 'C++', '2026-08-02 20:29:00'],
        ['6003', '10003', 'C+D', '运行中', 'C++', '2026-08-02 20:28:00'],
        ['6004', '10004', 'D+E', '系统错误', 'C++', '2026-08-02 20:27:00'],
        ['6005', '10005', 'E+F', '未知错误', 'C++', '2026-08-02 20:26:00'],
      ]);
    },
  });
  const adapter = createNowcoderAdapter(fetchFn);
  const rows = await adapter.fetchUserSubmissions('87654321', {});
  // 只有终态行产出；瞬态行等待终态出现后由后续同步正常导入
  assert.deepEqual(rows.map((r) => r.externalId), ['6001']);
});

test('luogu: 题目详情风控失败 → 退避后重试补全，而非进程级负缓存', async (t) => {
  // 旧实现在 302/异常时 problemCache.set(pid, {tags:[]})：进程生命周期内的「永久负缓存」，
  // 风控窗口过后同一适配器实例也拿不回难度/标题。改为 5 分钟退避（同 tagDictFailedAt 做法）。
  t.mock.timers.enable({ now: Date.parse('2026-09-01T00:00:00Z'), apis: ['Date'] });
  let problemOk = false;
  let problemCalls = 0;
  const recordPage = () => ({
    code: 200,
    data: {
      records: {
        result: [
          { id: 777, status: 12, language: 'C++14', submitTime: 1789000000, problem: { pid: 'P1001' } },
        ],
      },
    },
  });
  const fetchFn = router({
    'record/list': (url: string) => {
      const page = new URL(url).searchParams.get('page');
      return page === '1' ? recordPage() : { code: 200, data: { records: { result: [] } } };
    },
    '/problem/P1001': () => {
      problemCalls += 1;
      if (!problemOk) return { status: 504, body: '' }; // 风控窗口内失败
      return {
        code: 0,
        currentData: { problem: { pid: 'P1001', name: 'A+B Problem', difficulty: 1, tags: [7] } },
      };
    },
    '_lfe/tags': () => ({ tags: [{ id: 7, name: '暴力枚举' }] }),
  });
  const adapter = createLuoguAdapter(fetchFn);
  const first = await adapter.fetchUserSubmissions('uid', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(first.length, 1);
  assert.equal(first[0].problem.difficulty, undefined, '风控窗口内：无难度可补');

  problemOk = true;
  t.mock.timers.setTime(Date.parse('2026-09-01T00:06:00Z')); // 越过 5 分钟退避期
  const second = await adapter.fetchUserSubmissions('uid', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(problemCalls, 2, '退避期过后必须重试题目详情');
  assert.equal(second[0].problem.difficulty, 800, '重试成功 → 难度随提交补全（洛谷 1 档 → CF800）');
  assert.equal(second[0].problem.title, 'A+B Problem');
});

