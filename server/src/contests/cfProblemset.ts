import type { Db } from '../db/index.ts';
import { throttledFetch } from '../net/hostThrottle.ts';

/**
 * CF 题目集官方标签缓存（problemset.problems 全集 API，公开无登录）。
 *
 * 背景：复盘「未提交的题」需要知识点标签——contest.standings 只有题号/题名/难度
 * 没有 tags，而已提交题的官方 tags 随 user.status 同步入库（codeforces.ts）。
 * 全集 API 一次返回所有题目的官方 tags + rating + solvedCount，落库后复盘零请求。
 *
 * 缓存策略（对齐 calendarCache）：24h 新鲜期直接用；查题缺题（新比赛的题刚进
 * 题目集而缓存还旧）时阻塞强刷一次——复盘本就是网络路径，1 次请求换准确标签；
 * 强刷带 1h 退避，失败静默（旧缓存照常可用，缺的题只是没有 tags）。
 */

const FRESH_MS = 24 * 3600_000;
const REFRESH_BACKOFF_MS = 3600_000;

/** 单题官方元数据（key 为 problemKey，形如 "1877A"，与本地 problems.problem_key 同构） */
export interface CfProblemMeta {
  tags: string[];
  rating?: number | null;
  solvedCount?: number | null;
}

let memory: { at: number; byKey: Map<string, CfProblemMeta> } | null = null;
let lastAttemptAt = 0;
let refreshing: Promise<void> | null = null;

function parsePayload(raw: string): Map<string, CfProblemMeta> {
  const map = new Map<string, CfProblemMeta>();
  try {
    const obj = JSON.parse(raw) as Record<string, CfProblemMeta>;
    for (const [key, meta] of Object.entries(obj)) {
      if (meta && Array.isArray(meta.tags)) map.set(key, meta);
    }
  } catch {
    // 缓存损坏：当作空，走强刷
  }
  return map;
}

function hydrate(db: Db): Map<string, CfProblemMeta> {
  if (memory && Date.now() - memory.at < FRESH_MS) return memory.byKey;
  const row = db
    .prepare('SELECT fetched_at, payload FROM cf_problemset_cache WHERE id = 1')
    .get() as { fetched_at: string; payload: string } | undefined;
  if (!row) return memory?.byKey ?? new Map();
  const byKey = parsePayload(row.payload);
  const at = Date.parse(row.fetched_at);
  memory = { at: Number.isFinite(at) ? at : 0, byKey };
  // 过期缓存不主动后台刷新：新题不在缓存里时由 lookupCfProblems 的缺题强刷兜底，
  // 避免读取路径带着网络副作用（也免去测试打真网）
  return byKey;
}

function persist(db: Db, byKey: Map<string, CfProblemMeta>): void {
  memory = { at: Date.now(), byKey };
  db.prepare(
    'INSERT INTO cf_problemset_cache (id, fetched_at, payload) VALUES (1, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload',
  ).run(new Date().toISOString(), JSON.stringify(Object.fromEntries(byKey)));
}

async function refresh(db: Db, fetchFn: typeof fetch): Promise<void> {
  if (refreshing) {
    await refreshing.catch(() => {});
    return;
  }
  lastAttemptAt = Date.now();
  refreshing = (async () => {
    const res = await fetchFn('https://codeforces.com/api/problemset.problems', {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Codeforces API HTTP ${res.status}`);
    const body = (await res.json()) as {
      status?: string;
      result?: {
        problems?: Array<Record<string, unknown>>;
        problemStatistics?: Array<Record<string, unknown>>;
      };
    };
    if (body.status !== 'OK' || !Array.isArray(body.result?.problems)) {
      throw new Error('Codeforces API 响应结构异常');
    }
    const solved = new Map<string, number>();
    for (const s of body.result.problemStatistics ?? []) {
      if (typeof s.contestId === 'number' && typeof s.index === 'string' && typeof s.solvedCount === 'number') {
        solved.set(`${s.contestId}${s.index}`, s.solvedCount);
      }
    }
    const byKey = new Map<string, CfProblemMeta>();
    for (const p of body.result.problems) {
      if (typeof p.contestId !== 'number' || typeof p.index !== 'string') continue;
      byKey.set(`${p.contestId}${p.index}`, {
        tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
        rating: typeof p.rating === 'number' ? p.rating : null,
        solvedCount: solved.get(`${p.contestId}${p.index}`) ?? null,
      });
    }
    persist(db, byKey);
  })()
    .catch(() => undefined) // 失败静默：旧缓存照常可用，缺的题只是没有 tags
    .finally(() => {
      refreshing = null;
    });
  await refreshing;
}

/**
 * 查一批 problemKey 的官方元数据。缓存未覆盖的键（新比赛的题）触发一次阻塞强刷
 * （1h 退避），刷完仍没有的键就不出现在结果里——调用方按「拿不到就不写」处理。
 */
export async function lookupCfProblems(
  db: Db,
  keys: string[],
  fetchFn: typeof fetch = throttledFetch,
): Promise<Map<string, CfProblemMeta>> {
  const byKey = hydrate(db);
  let out = pick(byKey, keys);
  if (out.size < keys.length && Date.now() - lastAttemptAt > REFRESH_BACKOFF_MS) {
    try {
      await refresh(db, fetchFn);
    } catch {
      // 已在内部吞掉，这里兜底保持不抛
    }
    out = pick(hydrate(db), keys);
  }
  return out;
}

function pick(byKey: Map<string, CfProblemMeta>, keys: string[]): Map<string, CfProblemMeta> {
  const out = new Map<string, CfProblemMeta>();
  for (const key of keys) {
    const meta = byKey.get(key);
    if (meta) out.set(key, meta);
  }
  return out;
}

/** 仅供单测：清空进程内缓存状态（模块级 memory/backoff 会跨用例串数据） */
export function __resetCfProblemsetForTest(): void {
  memory = null;
  lastAttemptAt = 0;
  refreshing = null;
}
