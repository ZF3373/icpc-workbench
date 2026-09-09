import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';

const API_BASE = 'https://codeforces.com/api';
const PAGE_SIZE = 1000;
// 每次同步的保守页数上限（≤ 2 req/s × 500ms：约 5 分钟），把全量分页拆成多次小批量防封号
const PER_SYNC_MAX_PAGES = 50;
const PAGE_DELAY_MS = 500; // CF 建议 <= 2 req/s

interface CFProblem {
  contestId?: number;
  index: string;
  name: string;
  rating?: number;
  tags?: string[];
}

interface CFSubmission {
  id: number;
  contestId?: number;
  problem: CFProblem;
  verdict?: string;
  programmingLanguage?: string;
  creationTimeSeconds: number;
}

interface CFResponse {
  status: string;
  comment?: string;
  result?: CFSubmission[];
}

const VERDICT_MAP: Record<string, Verdict> = {
  OK: 'AC',
  WRONG_ANSWER: 'WA',
  TIME_LIMIT_EXCEEDED: 'TLE',
  RUNTIME_ERROR: 'RE',
  MEMORY_LIMIT_EXCEEDED: 'MLE',
  COMPILATION_ERROR: 'CE',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function splitKey(key: string): { contestId?: string; index: string } {
  const m = /^(\d+)(.+)$/.exec(key);
  return m ? { contestId: m[1], index: m[2] } : { index: key };
}

/**
 * Codeforces 适配器：官方公开 API user.status（无需登录）。
 * 提交按新到旧返回：同步层注入库中已知提交号后，整页已知即提前终止分页（增量），
 * 已知条目直接跳过；首刷无已知集合时全量分页，去重交由同步层按 externalId 处理。
 * 分批防封号：单次同步受 maxSubmissions 新增上限与页数预算约束，触及即停（opts.truncated），
 * 下次同步通过 knownExternalIds 跳过已拉页继续向更旧补全（from 偏移天然可恢复，无需游标）。
 */
export function createCodeforcesAdapter(
  fetchFn: typeof fetch = fetch,
): PlatformAdapter {
  return {
    platform: 'codeforces',
    knownIdsFilter: true,

    async fetchUserSubmissions(handle, opts) {
      const known = opts?.knownExternalIds;
      const maxSubmissions = opts?.maxSubmissions;
      // 新增上限推算的页数预算（×2 裕量），上限 PER_SYNC_MAX_PAGES；首刷/增量无上限时取上限
      const budget =
        maxSubmissions && maxSubmissions > 0
          ? Math.min(Math.ceil(maxSubmissions / PAGE_SIZE) * 2, PER_SYNC_MAX_PAGES)
          : PER_SYNC_MAX_PAGES;
      const out: NormalizedSubmission[] = [];
      let from = 1;
      let naturalEnd = false;
      let caughtUp = false;
      let rowCapped = false;
      for (let n = 0; n < budget; n += 1) {
        const url = `${API_BASE}/user.status?handle=${encodeURIComponent(handle)}&from=${from}&count=${PAGE_SIZE}`;
        const res = await fetchFn(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          throw new Error(`Codeforces API HTTP ${res.status}`);
        }
        const data = (await res.json()) as CFResponse;
        if (data.status !== 'OK') {
          throw new Error(`Codeforces API: ${data.comment ?? 'unknown error'}`);
        }
        const page = data.result ?? [];
        let unknownInPage = 0;
        for (const s of page) {
          if (known?.has(String(s.id))) continue;
          unknownInPage += 1;
          out.push(normalize(s));
          if (maxSubmissions && out.length >= maxSubmissions) {
            rowCapped = true;
            break;
          }
        }
        if (rowCapped) break;
        if (page.length < PAGE_SIZE) {
          naturalEnd = true; // 最后一页
          break;
        }
        if (known && unknownInPage === 0) {
          caughtUp = true; // 整页已知：更旧的提交也已在库，增量终止
          break;
        }
        from += PAGE_SIZE;
        await sleep(PAGE_DELAY_MS); // CF 建议 <= 2 req/s
      }
      // 截断：触及上限，或页数预算耗尽（未自然结束/未增量早停）且有新增 → 仍有更早历史待补全
      const truncated = rowCapped || (!naturalEnd && !caughtUp && out.length > 0);
      if (truncated && opts) opts.truncated = true;
      return out;
    },

    problemUrl({ problemKey }) {
      const { contestId, index } = splitKey(String(problemKey));
      if (!contestId) {
        return `https://codeforces.com/problemset/problem/${String(problemKey)}`;
      }
      const base = Number(contestId) >= 100000 ? 'gym' : 'contest';
      return `https://codeforces.com/${base}/${contestId}/problem/${index}`;
    },
  };
}

function normalize(s: CFSubmission): NormalizedSubmission {
  const { contestId, index } = s.problem;
  const key = contestId !== undefined ? `${contestId}${index}` : index;
  return {
    problem: {
      platform: 'codeforces' as PlatformId,
      problemKey: key,
      title: s.problem.name,
      ...(s.problem.rating !== undefined ? { difficulty: s.problem.rating } : {}),
      url: problemUrlFor(contestId, index),
      tags: s.problem.tags ?? [],
    },
    verdict: s.verdict ? (VERDICT_MAP[s.verdict] ?? 'SKIPPED') : 'SKIPPED',
    ...(s.programmingLanguage ? { language: s.programmingLanguage } : {}),
    submittedAt: new Date(s.creationTimeSeconds * 1000).toISOString(),
    externalId: String(s.id),
  };
}

function problemUrlFor(contestId: number | undefined, index: string): string {
  if (contestId === undefined) return `https://codeforces.com/problemset/problem/${index}`;
  const base = contestId >= 100000 ? 'gym' : 'contest';
  return `https://codeforces.com/${base}/${contestId}/problem/${index}`;
}
