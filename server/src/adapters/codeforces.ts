import type {
  NormalizedSubmission,
  PlatformId,
  SubmissionContext,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields } from '../../../shared/src/difficulty.ts';
import type { PlatformAdapter } from './types.ts';
import { asHttpClient, sleep, type HttpInit } from './http.ts';
import { recordWait, BACKFILL_KNOWN_PAGE_LIMIT } from './pagination.ts';

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
  /** 参赛方式：CONTESTED=比赛现场 / OUT_OF_COMPETITION=现场非正式 / VIRTUAL=虚拟赛 / PRACTICE=赛后补题或题单练习 */
  participantType?: string;
}

/**
 * participantType → 提交语境。现场参赛（含非正式）与虚拟赛都是「当场发挥」，算 contest/virtual；
 * PRACTICE 既含题单练习也含赛后补题（CF 的 user.status 对两者同义），能力值算法再结合
 * 尝试次数与跨度进一步降权。未知/缺省 → undefined（视为平台不下发）。
 */
function contextOf(participantType: string | undefined): SubmissionContext | undefined {
  switch (participantType) {
    case 'CONTESTED':
    case 'OUT_OF_COMPETITION':
      return 'contest';
    case 'VIRTUAL':
      return 'virtual';
    case 'PRACTICE':
      return 'practice';
    default:
      return undefined;
  }
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
  fetchFn: HttpInit = fetch,
): PlatformAdapter {
  const http = asHttpClient(fetchFn);
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
      let knownRun = 0;
      for (let n = 0; n < budget; n += 1) {
        const url = `${API_BASE}/user.status?handle=${encodeURIComponent(handle)}&from=${from}&count=${PAGE_SIZE}`;
        const res = await http.fetch(url, {}, {
          timeoutMs: 15000,
          // 退避等待计入本次同步的限速耗时（同步中心展示）
          recordWait: (ms) => recordWait(opts, ms),
        });
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
          // 补全模式下「整页已知」不代表已到尽头 —— 更旧的历史本来就还没进过库。
          // 与 pagination.ts 同口径：跳过该页继续向更旧，连续 BACKFILL_KNOWN_PAGE_LIMIT 页
          // 整页已知才认「补到尽头」。少了这一支，补全会在第 1 页就停手并回传「未截断」，
          // 同步层随即清掉 sync_truncated，更早的提交永远拉不回来。
          if (opts?.backfill && knownRun + 1 < BACKFILL_KNOWN_PAGE_LIMIT) {
            knownRun += 1;
            from += PAGE_SIZE;
            await sleep(PAGE_DELAY_MS);
            continue;
          }
          caughtUp = true; // 整页已知：更旧的提交也已在库，增量终止
          break;
        }
        knownRun = 0; // 本页出现过新行 → 仍在有效补全区段，重新计数
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
  const context = contextOf(s.participantType);
  return {
    problem: {
      platform: 'codeforces' as PlatformId,
      problemKey: key,
      title: s.problem.name,
      // 难度统一走 shared/src/difficulty.ts：未评级（rating 缺省）时不下发 difficulty 键
      ...difficultyFields('codeforces', s.problem.rating ?? null),
      url: problemUrlFor(contestId, index),
      tags: s.problem.tags ?? [],
    },
    verdict: s.verdict ? (VERDICT_MAP[s.verdict] ?? 'SKIPPED') : 'SKIPPED',
    ...(s.programmingLanguage ? { language: s.programmingLanguage } : {}),
    submittedAt: new Date(s.creationTimeSeconds * 1000).toISOString(),
    externalId: String(s.id),
    ...(context ? { context } : {}),
  };
}

function problemUrlFor(contestId: number | undefined, index: string): string {
  if (contestId === undefined) return `https://codeforces.com/problemset/problem/${index}`;
  const base = contestId >= 100000 ? 'gym' : 'contest';
  return `https://codeforces.com/${base}/${contestId}/problem/${index}`;
}
