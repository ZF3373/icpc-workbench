import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { SyncResult } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { register } from '../src/adapters/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';
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
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
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
      results: Array<{ platform: string; scanned: number; filled: number; nativeFilled: number }>;
    };
    assert.equal(body.ok, true);
    const js = body.results.find((r) => r.platform === 'jisuanke')!;
    assert.equal(js.scanned, 1);
    assert.equal(js.filled, 1);
    assert.equal(js.nativeFilled, 1); // 原生难度由 NULL 被补上
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
