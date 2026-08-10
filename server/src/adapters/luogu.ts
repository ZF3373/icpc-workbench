import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';
import { ManualImportRequiredError } from './types.ts';

const API = 'https://www.luogu.com.cn';
const MAX_PAGES = 100;
const PROBLEM_FETCH_CONCURRENCY = 6;

// 洛谷提交状态数字枚举 → 统一 Verdict
const STATUS_MAP: Record<number, Verdict> = {
  2: 'AC',
  3: 'WA',
  4: 'TLE',
  5: 'MLE',
  6: 'RE',
  7: 'CE',
};

interface LuoguProblem {
  pid?: string;
  title?: string;
  difficulty?: number;
  tags?: Array<{ name?: string }>;
}

interface LuoguRecord {
  id: number;
  status: number;
  submitTime: number;
  language?: string;
  problem?: LuoguProblem;
}

interface LuoguListResp {
  code?: number;
  currentData?: {
    records?: { result?: LuoguRecord[] };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 洛谷 submitTime 为毫秒时间戳；缺失/非法时回退当前时间 */
function toIso(ts: number | string | undefined): string {
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts ?? ''));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

function requestHeaders(cookie: string, csrf?: string): Record<string, string> {
  return {
    Cookie: cookie,
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: 'https://www.luogu.com.cn/',
  };
}

/**
 * 洛谷适配器（需登录 Cookie + CSRF）：
 * - 提交列表：GET /record/list?user={uid}&page={n}&_contentOnly=1
 * - 题目信息（难度/标签）：GET /problem/{pid}?_contentOnly=1（进程内缓存，并发受限）
 * - 未配置 Cookie 时抛 ManualImportRequiredError 引导配置/手动导入
 */
export function createLuoguAdapter(fetchFn: typeof fetch = fetch): PlatformAdapter {
  const problemCache = new Map<string, { difficulty?: number; title?: string; tags: string[] }>();

  async function fetchProblemInfo(
    pid: string,
    cookie: string,
    csrf?: string,
  ): Promise<{ difficulty?: number; title?: string; tags: string[] }> {
    const hit = problemCache.get(pid);
    if (hit) return hit;
    const empty = { tags: [] };
    try {
      const res = await fetchFn(`${API}/problem/${pid}?_contentOnly=1`, {
        headers: requestHeaders(cookie, csrf),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        problemCache.set(pid, empty);
        return empty;
      }
      const data = (await res.json()) as {
        currentData?: { problem?: LuoguProblem };
      };
      const p = data?.currentData?.problem;
      const info = {
        ...(typeof p?.difficulty === 'number' ? { difficulty: p.difficulty } : {}),
        ...(typeof p?.title === 'string' ? { title: p.title } : {}),
        tags: (p?.tags ?? []).map((t) => t.name).filter((t): t is string => Boolean(t)),
      };
      problemCache.set(pid, info);
      return info;
    } catch {
      problemCache.set(pid, empty);
      return empty;
    }
  }

  return {
    platform: 'luogu',

    async fetchUserSubmissions(
      handle: string,
      opts?: { since?: string; cookie?: string; csrf?: string },
    ): Promise<NormalizedSubmission[]> {
      const cookie = opts?.cookie;
      if (!cookie) {
        throw new ManualImportRequiredError(
          'luogu',
          '未配置登录 Cookie：请在设置中填写洛谷 Cookie（含 CSRF 时一并填写）后重试，或使用手动导入',
        );
      }
      const raws: LuoguRecord[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${API}/record/list?user=${encodeURIComponent(handle)}&page=${page}&_contentOnly=1`;
        const res = await fetchFn(url, {
          headers: requestHeaders(cookie, opts.csrf),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
          throw new Error(`洛谷 API HTTP ${res.status}（Cookie 可能已过期或触发风控）`);
        }
        const data = (await res.json()) as LuoguListResp;
        if (![0, 200].includes(data.code ?? -1) || !data.currentData?.records) {
          throw new Error('洛谷 API 响应异常（Cookie 可能已过期或触发风控）');
        }
        const records = data.currentData.records.result;
        if (!Array.isArray(records) || records.length === 0) break;
        for (const rec of records) {
          // 过滤等待/评测中的非最终状态
          if (rec.status === 0 || rec.status === 1) continue;
          raws.push(rec);
        }
        await sleep(300);
      }

      // 按需补充题目难度/标签（并发受限，失败静默降级）；仅对合法 pid 查询
      const pids = [
        ...new Set(
          raws
            .map((r) => r.problem?.pid)
            .filter((p): p is string => typeof p === 'string' && /^[A-Za-z0-9]+$/.test(p)),
        ),
      ];
      for (let i = 0; i < pids.length; i += PROBLEM_FETCH_CONCURRENCY) {
        await Promise.allSettled(
          pids.slice(i, i + PROBLEM_FETCH_CONCURRENCY).map((pid) => fetchProblemInfo(pid, cookie, opts.csrf)),
        );
      }

      return raws.map((rec) => {
        const pid = rec.problem?.pid ?? `luogu-${rec.id}`;
        const info = problemCache.get(pid) ?? { tags: [] };
        return {
          problem: {
            platform: 'luogu' as PlatformId,
            problemKey: pid,
            title: info.title ?? rec.problem?.title ?? pid,
            ...(info.difficulty !== undefined ? { difficulty: info.difficulty } : {}),
            url: `https://www.luogu.com.cn/problem/${pid}`,
            tags: info.tags,
          },
          verdict: STATUS_MAP[rec.status] ?? 'SKIPPED',
          ...(rec.language ? { language: rec.language } : {}),
          submittedAt: toIso(rec.submitTime),
          externalId: String(rec.id),
        };
      });
    },

    problemUrl({ problemKey }) {
      return `https://www.luogu.com.cn/problem/${String(problemKey)}`;
    },
  };
}
