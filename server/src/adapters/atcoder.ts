import fs from 'node:fs';
import path from 'node:path';
import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';

const API = 'https://kenkoooo.com/atcoder';
const RESOURCES_TTL_MS = 24 * 3600 * 1000;
const SUBMISSION_PAGE = 500;
const MAX_PAGES = 100; // 保护：最多拉 5 万条

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
      opts?: { since?: string },
    ): Promise<NormalizedSubmission[]> {
      const since = opts?.since
        ? Math.floor(Date.parse(opts.since) / 1000)
        : 0;
      const seen = new Set<string>();
      const raws: KenkoooSubmission[] = [];
      let fromSecond = since;

      for (let page = 0; page < MAX_PAGES; page += 1) {
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
        if (rows.length === 0) break;

        let added = 0;
        let maxSecond = 0;
        for (const s of rows) {
          if (seen.has(String(s.id))) continue;
          seen.add(String(s.id));
          raws.push(s);
          added += 1;
          if (s.epoch_second > maxSecond) maxSecond = s.epoch_second;
        }
        if (rows.length < SUBMISSION_PAGE || added === 0) break;
        fromSecond = maxSecond;
        await sleep(1000); // 官方要求访问间隔 >= 1s
      }

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
