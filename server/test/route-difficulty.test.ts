import { listenForTest } from './test-listen.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { SyncResult } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { register } from '../src/adapters/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';
import { backfillDifficulties, pickBackfillTargets } from '../src/analysis/difficultyBackfill.ts';
import { __resetBackfillRunForTest } from '../src/analysis/backfillRun.ts';
import { syncRoutes } from '../src/routes/sync.ts';
import { readSyncSettings, settingsRoutes } from '../src/routes/settings.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import {
  configureSyncScheduler,
  scheduleAutoContinue,
  __resetSyncSchedulerForTest,
} from '../src/adapters/syncScheduler.ts';

/**
 * Task 8：难度双标度 / 续拉状态 / 题库新参数 的 HTTP 暴露。
 * 这些能力此前只存在于模块层（problemBank 的 luoguTypes/atcoderTagsFromLuogu、syncScheduler 的
 * listAutoContinue），路由层未透传 → 前端拿不到。本文件按「HTTP 契约」而非模块内部行为断言。
 */

// ---------- 测试脚手架 ----------

/** mock fetch 路由器（与 problem-bank.test.ts 同款约定） */
function router(handlers: Record<string, (url: string) => unknown>): typeof fetch {
  return async (input: string | URL | Request) => {
    const u = String(input);
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (u.includes(prefix)) {
        const v = handler(u);
        if (typeof v === 'string') return new Response(v, { status: 200 });
        return new Response(JSON.stringify(v), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
  };
}

async function withApp(app: express.Express, fn: (base: string) => Promise<void>): Promise<void> {
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    srv.close();
  }
}

function problemsApp(db: Db, fetchFn: typeof fetch = fetch): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/problems', problemsRoutes(db, fetchFn));
  return app;
}

function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 造一行题库题（无提交记录） */
function seedProblem(
  db: Db,
  platform: string,
  key: string,
  opts: { difficulty?: number | null; native?: string | null; scale?: string | null; tags?: string } = {},
): void {
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, tags, difficulty_source, native_difficulty, difficulty_scale)
     VALUES (?, ?, ?, ?, ?, 'sync', ?, ?)`,
  ).run(
    platform,
    key,
    `${key} 标题`,
    opts.difficulty ?? null,
    opts.tags ?? '[]',
    opts.native ?? null,
    opts.scale ?? null,
  );
}

// ---------- A. 题目行：原生难度 + 派生标签 ----------

test('GET /api/problems 返回原生难度/标度与派生标签（原生未知 → label null）', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P3373', { difficulty: 1800, native: '4', scale: 'luogu-2026-06', tags: '["线段树"]' });
  seedProblem(db, 'luogu', 'P9999', { difficulty: 2200, native: '5', scale: 'luogu-2026-06' });
  seedProblem(db, 'codeforces', '1A', { difficulty: 1000 }); // 旧数据：无原生难度
  await withApp(problemsApp(db), async (base) => {
    const rows = (await (await fetch(`${base}/api/problems?bank=1`)).json()) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.problem_key === 'P3373')!;
    assert.equal(row.difficulty, 1800);
    assert.equal(row.nativeDifficulty, '4');
    assert.equal(row.difficultyScale, 'luogu-2026-06');
    // 洛谷 4 档 = 普及+/提高−（shared/src/difficulty.ts 的 LUOGU_LEVEL_NAMES；5 档才是「提高」）
    assert.equal(row.difficultyLabel, '普及+/提高−');
    // 派生标签与 shared 的映射同源（5 档 → 提高）
    const lv5 = rows.find((r) => r.problem_key === 'P9999')!;
    assert.equal(lv5.difficultyLabel, '提高');

    const legacy = rows.find((r) => r.problem_key === '1A')!;
    assert.equal(legacy.nativeDifficulty, null);
    assert.equal(legacy.difficultyScale, null);
    assert.equal(legacy.difficultyLabel, null);
  });
  db.close();
});

test('GET /api/problems 的 difficultyGap：只在「上游确认无难度」且未过期时为真', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'codeforces', '100001A', { difficulty: null }); // 已确认无难度（gym）
  seedProblem(db, 'codeforces', '100002B', { difficulty: null }); // 同上，但记录已过期
  seedProblem(db, 'codeforces', '100003C', { difficulty: 1500 }); // 后来被评级：有难度 → 不算缺口
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString(); // 31 天前 → 已过 TTL
  db.prepare("UPDATE problems SET gap_state = 'difficulty', gap_checked_at = ? WHERE problem_key IN ('100001A','100002B','100003C')").run(stale);
  db.prepare("UPDATE problems SET gap_checked_at = ? WHERE problem_key = '100001A'").run(fresh);
  await withApp(problemsApp(db), async (base) => {
    const rows = (await (await fetch(`${base}/api/problems?bank=1`)).json()) as Array<Record<string, unknown>>;
    const by = (k: string) => rows.find((r) => r.problem_key === k)!;
    assert.equal(by('100001A').difficultyGap, true, '新鲜记录 → 显示「平台无公开难度」');
    assert.equal(by('100002B').difficultyGap, false, '过期记录 → 回到「难度未知」（下轮会重查）');
    assert.equal(by('100003C').difficultyGap, false, '难度已有值时不得再报「无公开难度」');
    // 负缓存两列是实现细节，不原样下发
    assert.equal(Object.hasOwn(by('100001A'), 'gap_state'), false);
  });
  db.close();
});

test('GET /api/problems/page 的行同样带 nativeDifficulty / difficultyScale / difficultyLabel', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'nowcoder', '321126', { difficulty: 800, native: '700', scale: 'nowcoder-score' });
  await withApp(problemsApp(db), async (base) => {
    const body = (await (await fetch(`${base}/api/problems/page?bank=1&pageSize=10`)).json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    assert.equal(body.total, 1);
    assert.equal(body.items[0].nativeDifficulty, '700');
    assert.equal(body.items[0].difficultyScale, 'nowcoder-score');
    assert.equal(body.items[0].difficultyLabel, '700');
  });
  db.close();
});

// ---------- B. POST /api/problems/bank：新参数可经 HTTP 触达 ----------

test('POST /api/problems/bank: luoguTypes 透传到拉取器，入库行带原生难度三字段', async () => {
  const db = createDb(':memory:');
  const seen: string[] = [];
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [] }),
    'problem/list': (url) => {
      const u = new URL(url);
      const type = u.searchParams.get('type') ?? '';
      const page = u.searchParams.get('page') ?? '';
      seen.push(`${type}:${page}`);
      if (page !== '1') return { data: { problems: { count: 0, perPage: 50, result: [] } } };
      const pid = type === 'CF' ? 'CF1A' : 'P1000';
      return { data: { problems: { count: 1, perPage: 50, result: [{ pid, name: pid, difficulty: 4, tags: [] }] } } };
    },
  });
  await withApp(problemsApp(db, fetchFn), async (base) => {
    const res = await postJson(base, '/api/problems/bank', { platform: 'luogu', max: 50, luoguTypes: ['P', 'CF'] });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; fetched: number; inserted: number };
    assert.equal(body.ok, true);
    assert.equal(body.inserted, 2);
    assert.deepEqual(seen, ['P:1', 'CF:1']); // 镜像题类型真的被请求（此前只可能是默认 'P'）

    const rows = (await (await fetch(`${base}/api/problems?bank=1&platform=luogu`)).json()) as Array<
      Record<string, unknown>
    >;
    const mirror = rows.find((r) => r.problem_key === 'CF1A')!;
    assert.equal(mirror.nativeDifficulty, '4');
    assert.equal(mirror.difficultyScale, 'luogu-2026-06');
    assert.equal(mirror.difficultyLabel, '普及+/提高−');
  });
  db.close();
});

test('POST /api/problems/bank: atcoderTags=true 开启标签桥并回传计数', async () => {
  const db = createDb(':memory:');
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [{ id: 2, name: '模拟' }] }),
    'problem/list': (url) => {
      const page = new URL(url).searchParams.get('page');
      return page === '1'
        ? {
            data: {
              problems: {
                count: 2,
                perPage: 50,
                result: [
                  { pid: 'AT_abc300_a', name: 'A', difficulty: 1, tags: [2] },
                  { pid: 'AT1202Contest_a', name: 'X', difficulty: 1, tags: [2] }, // 自定义比赛号：不可映射
                ],
              },
            },
          }
        : { data: { problems: { count: 2, perPage: 50, result: [] } } };
    },
    'resources/problems.json': () => [{ id: 'abc300_a', contest_id: 'abc300', name: 'A', title: 'A - A' }],
    'resources/problem-models.json': () => ({ abc300_a: { difficulty: 800 } }),
  });
  await withApp(problemsApp(db, fetchFn), async (base) => {
    const res = await postJson(base, '/api/problems/bank', { platform: 'atcoder', max: 50, atcoderTags: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      fetched: number;
      tagScanned?: number;
      tagMatched?: number;
      tagWithTags?: number;
      tagSkipped?: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.tagScanned, 2);
    assert.equal(body.tagMatched, 1);
    assert.equal(body.tagWithTags, 1);
    assert.equal(body.tagSkipped, 1);

    const rows = (await (await fetch(`${base}/api/problems?bank=1&platform=atcoder`)).json()) as Array<{
      problem_key: string;
      tags: string[];
      nativeDifficulty: string | null;
      difficultyScale: string | null;
    }>;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].tags, ['模拟']); // 桥接来的标签真的落库了
    assert.equal(rows[0].difficultyScale, 'atcoder-kenkoooo-irt');
  });
  db.close();
});

test('POST /api/problems/bank: 未开标签桥时不返回标签计数', async () => {
  const db = createDb(':memory:');
  let luoguCalls = 0;
  const fetchFn = router({
    'problem/list': () => {
      luoguCalls += 1;
      return { data: { problems: { result: [] } } };
    },
    'resources/problems.json': () => [{ id: 'abc300_a', contest_id: 'abc300', name: 'A', title: 'A - A' }],
    'resources/problem-models.json': () => ({ abc300_a: { difficulty: 800 } }),
  });
  await withApp(problemsApp(db, fetchFn), async (base) => {
    const res = await postJson(base, '/api/problems/bank', { platform: 'atcoder', max: 50 });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.tagScanned, undefined);
    assert.equal(luoguCalls, 0); // 默认不做洛谷镜像扫描
  });
  db.close();
});

test('POST /api/problems/bank: 非法 luoguTypes / atcoderTags → 400', async () => {
  const db = createDb(':memory:');
  await withApp(problemsApp(db), async (base) => {
    const bad = await postJson(base, '/api/problems/bank', { platform: 'luogu', luoguTypes: ['XX'] });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /luoguTypes/);
    const notArray = await postJson(base, '/api/problems/bank', { platform: 'luogu', luoguTypes: 'P' });
    assert.equal(notArray.status, 400);
    const badFlag = await postJson(base, '/api/problems/bank', { platform: 'atcoder', atcoderTags: 'yes' });
    assert.equal(badFlag.status, 400);
    assert.match(((await badFlag.json()) as { error: string }).error, /atcoderTags/);
  });
  db.close();
});

test('POST /api/problems/bank: platform=qoj → 400 并说明原因（不落到别的平台拉取器）', async () => {
  const db = createDb(':memory:');
  let upstreamCalls = 0;
  const fetchFn = router({
    '': () => {
      upstreamCalls += 1;
      return { message: 'should not be called' };
    },
  });
  await withApp(problemsApp(db, fetchFn), async (base) => {
    const res = await postJson(base, '/api/problems/bank', { platform: 'qoj' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /qoj/);
    assert.match(body.error, /难度|Cloudflare|公开/); // 短原因：无公开题库页 / 平台无难度字段
    assert.equal(upstreamCalls, 0);
  });
  db.close();
});

// ---------- C. POST /api/problems/backfill-difficulty：每平台 nativeFilled ----------

test('POST /api/problems/backfill-difficulty: 回传每平台 nativeFilled 计数', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'jisuanke', 'JS1'); // 难度/原生难度/标签全空 → 回填目标
  const fetchFn = router({
    'api/problems': () => ({
      total: 1,
      problems: [{ problemIdentifier: 'JS1', title: '计蒜客题', difficultyType: 'level5', problemTags: [] }],
    }),
  });
  await withApp(problemsApp(db, fetchFn), async (base) => {
    const res = await postJson(base, '/api/problems/backfill-difficulty', {});
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      unknownLeft: number;
      results: Array<{ platform: string; scanned: number; filled: number; nativeFilled: number; deferred: number }>;
    };
    assert.equal(body.ok, true);
    const js = body.results.find((r) => r.platform === 'jisuanke')!;
    assert.equal(js.scanned, 1);
    assert.equal(js.filled, 1);
    assert.equal(js.nativeFilled, 1); // 原生难度由 NULL 被补上
    assert.equal(js.deferred, 0); // 真缺难度的题不会被跳过
    assert.equal(body.unknownLeft, 0);

    const rows = (await (await fetch(`${base}/api/problems?bank=1&platform=jisuanke`)).json()) as Array<
      Record<string, unknown>
    >;
    assert.equal(rows[0].nativeDifficulty, 'level5');
    assert.equal(rows[0].difficultyScale, 'jisuanke-level-8');
    assert.equal(rows[0].difficultyLabel, '提高');
  });
  db.close();
});

test('POST /api/problems/backfill-difficulty: 逐题平台的「仅缺原生值」行回传 deferred（不打扰上游）', async () => {
  const db = createDb(':memory:');
  // 洛谷：难度已有 1800、原生值缺失、标签齐备 → 属于「仅缺原生值」
  seedProblem(db, 'luogu', 'P1', { difficulty: 1800, tags: '["dp"]' });
  let problemFetches = 0;
  const fetchFn = router({
    '_lfe/tags': () => ({ tags: [] }),
    'problem/P1': () => {
      problemFetches += 1;
      return { data: { problem: { pid: 'P1', name: 'X', difficulty: 5, tags: [] } } };
    },
  });
  await withApp(problemsApp(db, fetchFn), async (base) => {
    const res = await postJson(base, '/api/problems/backfill-difficulty', {});
    const body = (await res.json()) as {
      results: Array<{ platform: string; scanned: number; deferred: number }>;
    };
    const lg = body.results.find((r) => r.platform === 'luogu')!;
    assert.equal(lg.scanned, 0);
    assert.equal(lg.deferred, 1);
    assert.equal(problemFetches, 0, 'deferred 的行不得发逐题请求');

    // 显式要求逐题重查时才真正打上游
    const forced = await postJson(base, '/api/problems/backfill-difficulty', { includeNativeOnly: true });
    const forcedBody = (await forced.json()) as {
      results: Array<{ platform: string; scanned: number; deferred: number; nativeFilled: number }>;
    };
    const lgForced = forcedBody.results.find((r) => r.platform === 'luogu')!;
    assert.equal(lgForced.scanned, 1);
    assert.equal(lgForced.nativeFilled, 1);
    assert.equal(problemFetches, 1);
    const row = db.prepare("SELECT native_difficulty, difficulty_scale FROM problems WHERE problem_key='P1'").get() as {
      native_difficulty: string;
      difficulty_scale: string;
    };
    assert.equal(row.native_difficulty, '5');
    assert.equal(row.difficulty_scale, 'luogu-2026-06');
  });
  db.close();
});

// ---------- D. 设置：续拉轮数 ----------

function settingsApp(db: Db): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes(db, DEFAULT_CONFIG));
  return app;
}

/** POST /api/settings/sync 现还返回 requestIntervalScale / requestIntervalBase（拉取速度倍率）。
 *  下面这些用例只关心三项核心字段，挑出来比对，避免与后续新增字段强耦合。 */
function coreSync(j: unknown): {
  maxSubmissions: number;
  autoContinueRounds: number;
  jisuankePracticeSync: boolean;
} {
  const o = j as Record<string, unknown>;
  return {
    maxSubmissions: o.maxSubmissions as number,
    autoContinueRounds: o.autoContinueRounds as number,
    jisuankePracticeSync: o.jisuankePracticeSync as boolean,
  };
}

test('GET /api/settings: sync 给出 autoContinueRounds（默认 3）与 jisuankePracticeSync（默认开启）', async () => {
  const db = createDb(':memory:');
  await withApp(settingsApp(db), async (base) => {
    const body = (await (await fetch(`${base}/api/settings`)).json()) as {
      sync: { maxSubmissions: number; autoContinueRounds: number; jisuankePracticeSync: boolean };
    };
    assert.equal(body.sync.maxSubmissions, 300);
    assert.equal(body.sync.autoContinueRounds, 3);
    assert.equal(body.sync.jisuankePracticeSync, true, '键缺失 = 默认开启（与适配器口径一致）');
  });
  db.close();
});

test('POST /api/settings/sync: autoContinueRounds 可选（省略则保留已存值）', async () => {
  const db = createDb(':memory:');
  await withApp(settingsApp(db), async (base) => {
    const first = await postJson(base, '/api/settings/sync', { maxSubmissions: 1000, autoContinueRounds: 3 });
    assert.equal(first.status, 200);
    assert.deepEqual(coreSync(await first.json()), { maxSubmissions: 1000, autoContinueRounds: 3, jisuankePracticeSync: true });

    // 只改上限：轮数保持上一次写入的值
    const second = await postJson(base, '/api/settings/sync', { maxSubmissions: 1500 });
    assert.deepEqual(coreSync(await second.json()), { maxSubmissions: 1500, autoContinueRounds: 3, jisuankePracticeSync: true });

    // 0 = 关闭续拉，属合法值
    const off = await postJson(base, '/api/settings/sync', { maxSubmissions: 1500, autoContinueRounds: 0 });
    assert.deepEqual(coreSync(await off.json()), { maxSubmissions: 1500, autoContinueRounds: 0, jisuankePracticeSync: true });
  });
  db.close();
});

test('POST /api/settings/sync: jisuankePracticeSync 落库为 true/false 字符串，非法类型 400 且不落库', async () => {
  const db = createDb(':memory:');
  await withApp(settingsApp(db), async (base) => {
    const read = () =>
      db.prepare("SELECT value FROM settings WHERE key = 'jisuanke.practiceSync'").get() as
        | { value: string }
        | undefined;

    const off = await postJson(base, '/api/settings/sync', { maxSubmissions: 500, jisuankePracticeSync: false });
    assert.equal(off.status, 200);
    assert.equal(read()?.value, 'false');
    assert.equal(readSyncSettings(db).jisuankePracticeSync, false);

    // 只改上限：练习同步开关保持上次写入的 false（省略即保留）
    const keep = await postJson(base, '/api/settings/sync', { maxSubmissions: 500 });
    assert.deepEqual(coreSync(await keep.json()), { maxSubmissions: 500, autoContinueRounds: 3, jisuankePracticeSync: false });

    const on = await postJson(base, '/api/settings/sync', { maxSubmissions: 500, jisuankePracticeSync: true });
    assert.equal(read()?.value, 'true');
    assert.deepEqual(coreSync(await on.json()), { maxSubmissions: 500, autoContinueRounds: 3, jisuankePracticeSync: true });

    // 非布尔（含字符串 'false'）：拒绝且不改动已存值
    for (const bad of ['false', 0, 1, null]) {
      const res = await postJson(base, '/api/settings/sync', { maxSubmissions: 500, jisuankePracticeSync: bad });
      assert.equal(res.status, 400, `jisuankePracticeSync=${String(bad)} 应被拒`);
      assert.match(((await res.json()) as { error: string }).error, /jisuankePracticeSync/);
    }
    assert.equal(read()?.value, 'true');
  });
  db.close();
});

test('POST /api/settings/sync: 越界/非数字 autoContinueRounds → 400 且原始行不变（不落库）', async () => {
  const db = createDb(':memory:');
  await withApp(settingsApp(db), async (base) => {
    /** 直接读原始行：读侧会把越界脏值钳回默认 3，只走 GET /api/settings 断言的话
     *  「写入 51 失败→读回 3」与「没写→读回 3」结果相同，测试不具区分力。 */
    const raw = () =>
      (db.prepare("SELECT value FROM settings WHERE key = 'sync.autoContinueRounds'").get() as
        | { value: string }
        | undefined)?.value;

    for (const bad of [51, -1, 2.5, 'x']) {
      const res = await postJson(base, '/api/settings/sync', { maxSubmissions: 500, autoContinueRounds: bad });
      assert.equal(res.status, 400, `autoContinueRounds=${String(bad)} 应被拒`);
      assert.match(((await res.json()) as { error: string }).error, /autoContinueRounds/);
    }
    assert.equal(raw(), undefined, '被拒的写入不得落库');
    const after = (await (await fetch(`${base}/api/settings`)).json()) as {
      sync: { autoContinueRounds: number };
    };
    assert.equal(after.sync.autoContinueRounds, 3);
  });
  db.close();
});

test('POST /api/settings/sync: null / 空串 / 布尔 / 数组等非数字 autoContinueRounds → 400 且保留已存值', async () => {
  const db = createDb(':memory:');
  await withApp(settingsApp(db), async (base) => {
    const raw = () =>
      (db.prepare("SELECT value FROM settings WHERE key = 'sync.autoContinueRounds'").get() as
        | { value: string }
        | undefined)?.value;

    // 先落一个合法值：被拒的写入绝不能把它改成 '0'（历史缺陷：Number(null)===0 且 0 合法 →
    // 传 JSON null（「保持已存值」的自然写法）会静默关闭后台续拉）
    const saved = await postJson(base, '/api/settings/sync', { maxSubmissions: 500, autoContinueRounds: 7 });
    assert.equal(saved.status, 200);
    assert.equal(raw(), '7');

    for (const bad of [null, '', false, [], {}, '7']) {
      const res = await postJson(base, '/api/settings/sync', { maxSubmissions: 500, autoContinueRounds: bad });
      assert.equal(res.status, 400, `autoContinueRounds=${JSON.stringify(bad)} 应被拒`);
      assert.match(((await res.json()) as { error: string }).error, /autoContinueRounds/);
      assert.equal(raw(), '7', `被拒后已存值应保持 '7'（不能变成 '0'）`);
    }

    // 「保留已存值」的正确写法是**省略该字段**（不是传 null）
    const omitted = await postJson(base, '/api/settings/sync', { maxSubmissions: 500 });
    assert.deepEqual(coreSync(await omitted.json()), { maxSubmissions: 500, autoContinueRounds: 7, jisuankePracticeSync: true });
    assert.equal(raw(), '7');
  });
  db.close();
});

test('readSyncSettings: 库内脏值（越界/非整数）回退默认 3', () => {
  const db = createDb(':memory:');
  const upsert = db.prepare(
    "INSERT INTO settings (key, value) VALUES ('sync.autoContinueRounds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const dirty of ['99', '-3', 'abc', '2.5']) {
    upsert.run(dirty);
    assert.equal(readSyncSettings(db).autoContinueRounds, 3, `脏值 ${dirty} 应回退默认`);
  }
  // 读侧不自己实现一套校验，而是复用调度器的 getAutoContinueRounds（读侧与执行侧同源）
  upsert.run('12');
  assert.equal(readSyncSettings(db).autoContinueRounds, 12);
  upsert.run('0');
  assert.equal(readSyncSettings(db).autoContinueRounds, 0); // 0 = 关闭，合法值不回退
  db.close();
});

// ---------- E. 续拉状态与取消 ----------

function syncApp(db: Db): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/sync', syncRoutes(db));
  return app;
}

interface StatusBody {
  statuses: Array<{ platform: string; autoContinue: Record<string, unknown> | null }>;
}

function bindAccount(db: Db, platform: string, handle: string): void {
  db.prepare(
    'INSERT INTO platform_accounts (user_id, platform, handle, enabled) VALUES (1, ?, ?, 1)',
  ).run(platform, handle);
}

test('GET /api/sync/status: 每平台给出 autoContinue（无排期 → null）', async () => {
  const db = createDb(':memory:');
  bindAccount(db, 'codeforces', 'tourist');
  configureSyncScheduler({
    db,
    now: () => Date.parse('2026-09-15T00:00:00.000Z'),
    schedule: () => 0,
    cancelTimer: () => {},
    run: async () => ({}) as unknown as SyncResult,
  });
  try {
    await withApp(syncApp(db), async (base) => {
      const before = (await (await fetch(`${base}/api/sync/status`)).json()) as StatusBody;
      assert.equal(before.statuses.length, 1);
      assert.equal(before.statuses[0].autoContinue, null);

      const state = scheduleAutoContinue(db, 'codeforces', 'tourist');
      assert.ok(state);
      const during = (await (await fetch(`${base}/api/sync/status`)).json()) as StatusBody;
      assert.deepEqual(during.statuses[0].autoContinue, {
        platform: 'codeforces',
        handle: 'tourist',
        round: 1,
        maxRounds: 3,
        nextAt: state!.nextAt,
        running: false,
      });

      // 取消 → cancelled: true，并立即从状态里消失
      const cancelled = await postJson(base, '/api/sync/auto-continue/cancel', { platform: 'codeforces' });
      assert.equal(cancelled.status, 200);
      assert.deepEqual(await cancelled.json(), { ok: true, cancelled: true });
      const after = (await (await fetch(`${base}/api/sync/status`)).json()) as StatusBody;
      assert.equal(after.statuses[0].autoContinue, null);

      // 重复取消 → cancelled: false（幂等）
      const again = await postJson(base, '/api/sync/auto-continue/cancel', { platform: 'codeforces' });
      assert.deepEqual(await again.json(), { ok: true, cancelled: false });
    });
  } finally {
    __resetSyncSchedulerForTest();
    db.close();
  }
});

test('POST /api/sync/:platform: retry=true 记为 triggered_by=retry；非布尔 → 400', async () => {
  const db = createDb(':memory:');
  // 假适配器：只关心 sync_runs 的 triggered_by，不关心拉取内容
  register({
    platform: 'codeforces',
    async fetchUserSubmissions() {
      return [];
    },
    problemUrl: () => 'https://codeforces.com/',
  });
  await withApp(syncApp(db), async (base) => {
    assert.equal((await postJson(base, '/api/sync/codeforces', { handle: 'tourist' })).status, 200);
    assert.equal((await postJson(base, '/api/sync/codeforces', { handle: 'tourist', retry: true })).status, 200);

    const rows = db
      .prepare('SELECT triggered_by FROM sync_runs ORDER BY id ASC')
      .all() as Array<{ triggered_by: string }>;
    assert.deepEqual(rows.map((r) => r.triggered_by), ['manual', 'retry'], '重试要能在历史里区分出来');

    // retry 只接受布尔值：字符串等一律拒绝（避免静默降级成 manual，历史里看不出是重试）
    const bad = await postJson(base, '/api/sync/codeforces', { handle: 'tourist', retry: 'true' });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /retry/);
  });
  db.close();
});

test('POST /api/sync/auto-continue/cancel: 非法 platform → 400', async () => {
  const db = createDb(':memory:');
  await withApp(syncApp(db), async (base) => {
    const res = await postJson(base, '/api/sync/auto-continue/cancel', { platform: 'nope' });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /platform/);
    const missing = await postJson(base, '/api/sync/auto-continue/cancel', {});
    assert.equal(missing.status, 400);
  });
  db.close();
});

// ---------- 关键词搜索：LIKE 通配符必须按字面量匹配 ----------

test('GET /api/problems?q= 把 % 与 _ 当字面量，不当通配符', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P1_0'); // 题号里就有下划线
  seedProblem(db, 'luogu', 'P1X0');
  seedProblem(db, 'luogu', 'P100');
  await withApp(problemsApp(db), async (base) => {
    const keys = async (q: string): Promise<string[]> => {
      const rows = (await (await fetch(`${base}/api/problems?bank=1&q=${encodeURIComponent(q)}`)).json()) as Array<{
        problem_key: string;
      }>;
      return rows.map((r) => r.problem_key).sort();
    };
    assert.deepEqual(await keys('P1_0'), ['P1_0'], "下划线不应当「任意一个字符」，否则 'P1X0' 会被误命中");
    assert.deepEqual(await keys('%'), [], '% 不应当「任意串」，否则搜一个百分号等于不过滤');
  });
});

// ---------- D. 可中止回填：/run 进度、/stop 停止、运行中重复触发 409 ----------

const waitMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('可中止回填：运行中 /run 报进度、重复触发 409、/stop 中断且已落库的保留、再点一次继续', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P1', { tags: '["dp"]' });
  seedProblem(db, 'luogu', 'P2', { tags: '["dp"]' });
  __resetBackfillRunForTest();
  let hangP2 = true;
  let p2Hanging = false;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('_lfe/tags')) return new Response(JSON.stringify({ tags: [] }), { status: 200 });
    if (!hangP2 || url.includes('problem/P1')) {
      const pid = url.includes('problem/P2') ? 'P2' : 'P1';
      const difficulty = pid === 'P1' ? 5 : 3;
      return new Response(
        JSON.stringify({ data: { problem: { pid, name: pid, difficulty, tags: [] } } }),
        { status: 200 },
      );
    }
    // P2 挂起：等用户点「停止」（signal 中止）
    p2Hanging = true;
    await new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = (): void => reject(signal?.reason ?? new Error('aborted'));
      if (signal?.aborted) return fail();
      signal?.addEventListener('abort', fail, { once: true });
    });
    throw new Error('unreachable');
  }) as typeof fetch;

  await withApp(problemsApp(db, fetchFn), async (base) => {
    const runUrl = `${base}/api/problems/backfill-difficulty/run`;
    const firstPending = postJson(base, '/api/problems/backfill-difficulty', {});
    // 等 P2 的请求挂起（= P1 已处理并写库）
    while (!p2Hanging) await waitMs(10);

    const running = (await (await fetch(runUrl)).json()) as {
      ok: boolean;
      run: { running: boolean; platform: string | null; done: number; total: number };
    };
    assert.equal(running.ok, true);
    assert.equal(running.run.running, true, '刷新页面后 /run 必须能看出回填正在进行');
    assert.equal(running.run.platform, 'luogu');
    assert.equal(running.run.total, 2);
    assert.equal(running.run.done, 1, 'P1 已处理完 → 进度 1/2');

    // 互斥：运行中再点一次不得并发跑第二轮
    const again = await postJson(base, '/api/problems/backfill-difficulty', {});
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /正在进行/);

    // 停止：在途请求立即中断，路由返回部分结果 + stopped
    const stop = await postJson(base, '/api/problems/backfill-difficulty/stop', {});
    assert.deepEqual(await stop.json(), { ok: true, stopped: true });
    const firstBody = (await (await firstPending).json()) as {
      ok: boolean;
      stopped: boolean;
      results: Array<{ platform: string; stopped?: boolean; failed: number }>;
    };
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.stopped, true);
    assert.equal(firstBody.results.find((r) => r.platform === 'luogu')!.stopped, true);

    // 已落库的不受影响
    const p1 = db.prepare("SELECT difficulty FROM problems WHERE problem_key='P1'").get() as { difficulty: number | null };
    assert.equal(p1.difficulty, 2200, '停止前已回填的题必须留在库里（洛谷等级 5 → 2200）');

    // 停完 /run 回到未运行；重复 /stop 幂等
    const after = (await (await fetch(runUrl)).json()) as { run: { running: boolean } };
    assert.equal(after.run.running, false);
    assert.deepEqual(await (await postJson(base, '/api/problems/backfill-difficulty/stop', {})).json(), {
      ok: true,
      stopped: false,
    });

    // 再点一次继续：剩下的 P2 这次补上（分多次回填）
    hangP2 = false;
    const secondBody = (await (await postJson(base, '/api/problems/backfill-difficulty', {})).json()) as {
      stopped: boolean;
      unknownLeft: number;
    };
    assert.equal(secondBody.stopped, false);
    const p2 = db.prepare("SELECT difficulty FROM problems WHERE problem_key='P2'").get() as { difficulty: number | null };
    assert.equal(p2.difficulty, 1500, '第二次点击把剩下的题补完');
    assert.equal(secondBody.unknownLeft, 0);
  });
  __resetBackfillRunForTest();
  db.close();
});

// ---------- G. PATCH /api/problems/:platform/:key/difficulty：手动填写难度 ----------
//
// 上游确实给不出难度的题（已删除/私有、洛谷「暂无评定」、CF 的 gym 与官方 Unrated）此前在界面上
// 永远停在「难度未知」，掌握度地图与弱项分析里也永远缺席。手动入口是这类题唯一的出路。

/** 读行的难度四列 + 负缓存两列 */
function diffRow(db: Db, key: string): {
  difficulty: number | null;
  difficulty_source: string | null;
  native_difficulty: string | null;
  difficulty_scale: string | null;
  gap_state: string | null;
  gap_checked_at: string | null;
} {
  return db
    .prepare(
      `SELECT difficulty, difficulty_source, native_difficulty, difficulty_scale, gap_state, gap_checked_at
         FROM problems WHERE problem_key = ?`,
    )
    .get(key) as never;
}

test('PATCH 手动难度：置 manual 来源 + 同源原生值/标度 + 清掉「平台无公开难度」记录', async () => {
  const db = createDb(':memory:');
  // 复现现场：洛谷 T 号题（已删/私有）匿名 401、带 Cookie 403 → 回填写下「无公开来源」的负缓存
  seedProblem(db, 'luogu', 'T822401', { difficulty: null, tags: '["dp"]' });
  db.prepare("UPDATE problems SET gap_state = 'difficulty', gap_checked_at = ? WHERE problem_key = 'T822401'").run(
    new Date().toISOString(),
  );
  await withApp(problemsApp(db), async (base) => {
    const res = await patchJson(base, '/api/problems/luogu/T822401/difficulty', { difficulty: 1800 });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.difficulty, 1800);
    assert.equal(body.difficultySource, 'manual');
    // 原生值与标度必须与难度**同源**写入：否则会落成「手动 1800 + 洛谷原生『提高』(≈2200)」这种
    // 自相矛盾的组合（见 import/problemWritePolicy.ts 注释里修掉的历史缺陷）
    assert.equal(body.nativeDifficulty, '1800');
    assert.equal(body.difficultyScale, 'cf-rating');

    const row = diffRow(db, 'T822401');
    assert.equal(row.difficulty, 1800);
    assert.equal(row.difficulty_source, 'manual');
    assert.equal(row.gap_state, null, '难度已由用户给定 → 不得再显示「平台无公开难度」');
    assert.equal(row.gap_checked_at, null);

    // 该行退出回填目标（难度与原生值都有值）
    assert.deepEqual(
      pickBackfillTargets(db).filter((t) => t.problemKey === 'T822401'),
      [],
      '手动标定后不该再被回填反复打扰',
    );

    // 列表接口下发 difficultySource（前端据此标出「手动」并画出虚线难度丸）
    const rows = (await (await fetch(`${base}/api/problems?bank=1`)).json()) as Array<Record<string, unknown>>;
    assert.equal(rows[0].difficultySource, 'manual');
    assert.equal(rows[0].difficultyGap, false);
    assert.equal(rows[0].difficultyLabel, null, 'cf-rating 标度下不臆造平台档位名');
  });
  db.close();
});

test('PATCH 手动难度：回填/题库写入不得覆盖 manual 值（优先级 4 > backfill 3）', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'codeforces', '1116Q', { difficulty: null }); // 缺难度 + 缺标签
  const fetchFn = router({
    'problemset.problems': () => ({
      status: 'OK',
      result: { problems: [{ contestId: 1116, index: 'Q', name: 'Q#', rating: 1400, tags: ['math'] }] },
    }),
  });
  await withApp(problemsApp(db), async (base) => {
    const set = await patchJson(base, '/api/problems/codeforces/1116Q/difficulty', { difficulty: 2600 });
    assert.equal(set.status, 200);

    // 该题仍缺标签 → 仍是回填目标；回填会把标签补上，但难度三元组必须纹丝不动
    const results = await backfillDifficulties(db, fetchFn);
    const cf = results.find((r) => r.platform === 'codeforces')!;
    assert.equal(cf.filled, 0, 'manual 值不参与「补难度」计数');
    const row = diffRow(db, '1116Q');
    assert.equal(row.difficulty, 2600, 'manual(4) 高于 backfill(3) → 上游的 1400 不得覆盖');
    assert.equal(row.difficulty_source, 'manual');
    assert.equal(row.native_difficulty, '2600');
    const tags = db.prepare("SELECT tags FROM problems WHERE problem_key='1116Q'").get() as { tags: string };
    assert.deepEqual(JSON.parse(tags.tags), ['数学（综合）'], '缺标签的缺口照常被回填补上');
  });
  db.close();
});

test('PATCH 手动难度：null 清除 → 恢复未知并重新成为回填目标', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'atcoder', 'abc308i', { difficulty: 1800, native: '1800', scale: 'cf-rating' });
  db.prepare("UPDATE problems SET difficulty_source = 'manual' WHERE problem_key = 'abc308i'").run();
  await withApp(problemsApp(db), async (base) => {
    const res = await patchJson(base, '/api/problems/atcoder/abc308i/difficulty', { difficulty: null });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.difficulty, null);
    assert.equal(body.difficultySource, null);
    const row = diffRow(db, 'abc308i');
    assert.equal(row.difficulty, null);
    assert.equal(row.native_difficulty, null);
    assert.equal(row.difficulty_source, null);
    assert.deepEqual(
      pickBackfillTargets(db).filter((t) => t.problemKey === 'abc308i').map((t) => t.problemKey),
      ['abc308i'],
      '清除后重新进入回填目标（下次回填会去上游查一次）',
    );
  });
  db.close();
});

test('PATCH 手动难度：越界 / 小数 / 非数值一律 400 且不改动库内行', async () => {
  const db = createDb(':memory:');
  seedProblem(db, 'luogu', 'P1001', { difficulty: 1500, native: '3', scale: 'luogu-2026-06' });
  await withApp(problemsApp(db), async (base) => {
    for (const bad of [799, 3501, 1800.5, '1800', true, [], {}, undefined]) {
      const res = await patchJson(base, '/api/problems/luogu/P1001/difficulty', { difficulty: bad });
      assert.equal(res.status, 400, `difficulty=${JSON.stringify(bad)} 应被拒（静默钳位会让落库值≠输入值）`);
      assert.match(((await res.json()) as { error: string }).error, /difficulty/);
    }
    const row = diffRow(db, 'P1001');
    assert.equal(row.difficulty, 1500, '被拒的写入不得落库');
    assert.equal(row.difficulty_source, 'sync');
  });
  db.close();
});

test('PATCH 手动难度：题目不存在 → 404；platform 非法 → 400', async () => {
  const db = createDb(':memory:');
  await withApp(problemsApp(db), async (base) => {
    const missing = await patchJson(base, '/api/problems/luogu/NOPE/difficulty', { difficulty: 1200 });
    assert.equal(missing.status, 404);
    const badPlatform = await patchJson(base, '/api/problems/nope-oj/X1/difficulty', { difficulty: 1200 });
    assert.equal(badPlatform.status, 400);
    assert.match(((await badPlatform.json()) as { error: string }).error, /platform/);
  });
  db.close();
});
