import fs from 'node:fs';
import path from 'node:path';
import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';

const API = 'https://kenkoooo.com/atcoder';
const RESOURCES_TTL_MS = 24 * 3600 * 1000;
const SUBMISSION_PAGE = 500;
// 每次同步的保守页数上限（×1s sleep × 500/页：每次同步最多约 30 分钟），把全量分页拆成多次防封号
const PER_SYNC_MAX_PAGES = 60;
const PAGE_DELAY_MS = 1000; // 官方要求访问间隔 >= 1s

const RESULT_MAP: Record<string, Verdict> = {
  AC: 'AC',
  WA: 'WA',
  TLE: 'TLE',
  MLE: 'MLE',
  RE: 'RE',
  CE: 'CE',
  OLE: 'RE',
  IE: 'RE',
  WJ: 'SKIPPED',
  WR: 'SKIPPED',
  JUDGE: 'SKIPPED',
};

interface KenkoooSubmission {
  id: number;
  epoch_second: number;
  problem_id: string;
  contest_id: string;
  user_id: string;
  language: string;
  result: string;
}

/**
 * AtCoder 适配器：使用社区维护的 kenkoooo/AtCoderProblems 公开 API（v3）。
 * - 用户提交：/atcoder-api/v3/user/submissions?user=xxx&from_second=ts
 *   （指定时间点后最多 500 条；满页续拉即增量同步；官方要求页间 sleep >= 1s）
 * - 题目标题：/resources/problems.json（24h 磁盘缓存）
 * - 题目难度：/resources/problem-models.json（24h 磁盘缓存）
 */
export function createAtcoderAdapter(
  cacheDir?: string,
  fetchFn: typeof fetch = fetch,
): PlatformAdapter {
  let problems: Map<string, { title?: string }> | null = null;
  let models: Map<string, { difficulty?: number | null }> | null = null;

  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  async function cachedJson(
    url: string,
    cacheKey: string,
  ): Promise<unknown> {
    const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : '';
    if (cachePath && fs.existsSync(cachePath)) {
      const age = Date.now() - fs.statSync(cachePath).mtimeMs;
      if (age < RESOURCES_TTL_MS) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    }
    const res = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      throw new Error(`AtCoder resources HTTP ${res.status}`);
    }
    const data: unknown = await res.json();
    if (cachePath) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(data));
    }
    return data;
  }

  async function ensureMaps(): Promise<void> {
    if (problems && models) return;
    const [probData, modelData] = await Promise.all([
      cachedJson(`${API}/resources/problems.json`, 'atcoder-problems'),
      cachedJson(`${API}/resources/problem-models.json`, 'atcoder-problem-models'),
    ]);
    problems = new Map(
      (probData as { id: string; title?: string }[]).map((p) => [p.id, p]),
    );
    models = new Map(
      Object.entries(modelData as Record<string, { difficulty?: number | null }>),
    );
  }

  return {
    platform: 'atcoder',

    async fetchUserSubmissions(
      handle: string,
      opts?: FetchOptions,
    ): Promise<NormalizedSubmission[]> {
      const since = opts?.since
        ? Math.floor(Date.parse(opts.since) / 1000)
        : 0;
      const maxSubmissions = opts?.maxSubmissions;
      // 新增上限推算的页数预算（×2 裕量），上限 PER_SYNC_MAX_PAGES；首刷/增量无上限时取上限
      const budget =
        maxSubmissions && maxSubmissions > 0
          ? Math.min(Math.ceil(maxSubmissions / SUBMISSION_PAGE) * 2, PER_SYNC_MAX_PAGES)
          : PER_SYNC_MAX_PAGES;
      const seen = new Set<string>();
      const raws: KenkoooSubmission[] = [];
      let fromSecond = since;
      let naturalEnd = false; // 空页 / 满页判定终止
      let rowCapped = false;

      for (let page = 0; page < budget; page += 1) {
        const url = `${API}/atcoder-api/v3/user/submissions?user=${encodeURIComponent(handle)}&from_second=${fromSecond}`;
        const res = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) {
          throw new Error(`AtCoder API HTTP ${res.status}`);
        }
        const data: unknown = await res.json();
        if (!Array.isArray(data)) {
          const msg = (data as { message?: string }).message ?? 'unknown error';
          throw new Error(`AtCoder API: ${msg}`);
        }
        const rows = data as KenkoooSubmission[];
        if (rows.length === 0) {
          naturalEnd = true;
          break;
        }

        let added = 0;
        let maxSecond = fromSecond; // 初始化为当前起点：防止页内无更新时 fromSecond 回退导致重复请求
        for (const s of rows) {
          if (seen.has(String(s.id))) continue;
          seen.add(String(s.id));
          raws.push(s);
          added += 1;
          if (s.epoch_second > maxSecond) maxSecond = s.epoch_second;
          if (maxSubmissions && raws.length >= maxSubmissions) {
            rowCapped = true;
            break;
          }
        }
        if (rowCapped) break;
        if (rows.length < SUBMISSION_PAGE || added === 0) {
          naturalEnd = true;
          break;
        }
        // 防护：maxSecond 未推进（页内提交时间全 ≤ fromSecond）→ 强制 +1 跳过本页，避免死循环
        if (maxSecond <= fromSecond) maxSecond = fromSecond + 1;
        fromSecond = maxSecond;
        await sleep(PAGE_DELAY_MS); // 官方要求访问间隔 >= 1s
      }

      // 截断：触及上限，或页数预算耗尽（未自然结束）且有新增 → 仍有更早历史待补全
      // AtCoder 按 epoch 升序拉取，截断时同步层推进 last_sync_at 到本次最新提交时间，下次从此续拉
      const truncated = rowCapped || (!naturalEnd && raws.length > 0);
      if (truncated && opts) opts.truncated = true;

      if (raws.length === 0) return [];
      await ensureMaps();
      return raws.map((s) =>
        normalize(s, problems ?? new Map(), models ?? new Map()),
      );
    },

    problemUrl({ problemKey }) {
      return `https://atcoder.jp/tasks/${String(problemKey)}`;
    },
  };
}

function normalize(
  s: KenkoooSubmission,
  problems: Map<string, { title?: string }>,
  models: Map<string, { difficulty?: number | null }>,
): NormalizedSubmission {
  const title = problems.get(s.problem_id)?.title ?? s.problem_id;
  const difficulty = models.get(s.problem_id)?.difficulty ?? undefined;
  return {
    problem: {
      platform: 'atcoder' as PlatformId,
      problemKey: s.problem_id,
      title,
      ...(typeof difficulty === 'number' && Number.isFinite(difficulty)
        ? { difficulty }
        : {}),
      url: `https://atcoder.jp/contests/${s.contest_id}/tasks/${s.problem_id}`,
      tags: [],
    },
    verdict: RESULT_MAP[s.result] ?? 'SKIPPED',
    language: s.language,
    submittedAt: new Date(s.epoch_second * 1000).toISOString(),
    externalId: String(s.id),
  };
}
