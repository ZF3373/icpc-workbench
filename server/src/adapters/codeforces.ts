import type {
  NormalizedSubmission,
  PlatformId,
  SubmissionContext,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields } from '../../../shared/src/difficulty.ts';
import type { PlatformAdapter } from './types.ts';
import { asHttpClient, sleep, type HttpInit } from './http.ts';
import { recordWait } from './pagination.ts';
import { splitCodeforcesProblemKey } from './problemKey.ts';

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
  /** author：提交人信息。participantType 在真实响应里嵌在这里（2026-10-18 实测 Educational Round 195） */
  author?: { participantType?: string };
  /** 兼容声明：真实 API 从不在顶层下发 participantType，见 contextOf 的注释 */
  participantType?: string;
}

/**
 * participantType → 提交语境。现场参赛（含非正式）与虚拟赛都是「当场发挥」，算 contest/virtual；
 * PRACTICE 既含题单练习也含赛后补题（CF 的 user.status 对两者同义），能力值算法再结合
 * 尝试次数与跨度进一步降权。未知/缺省 → undefined（视为平台不下发）。
 *
 * 取值位置：真实响应里 participantType 嵌在 author 对象内（author.participantType）。
 * 曾经读顶层 s.participantType 且枚举拼成 CONTESTED——CF 顶层从不下发该字段、真实值
 * 是 CONTESTANT，两重错误叠加导致 context 恒为 null：赛事分析页对 CF 按 context
 * 判定赛时/赛后（contestAnalysis.ts），于是已同步的 CF 比赛全部显示「未尝试」，
 * 与赛事中心的计数互相矛盾。顶层字段仅作为 author 缺失时的兜底（实际不会命中）。
 */
function contextOf(s: CFSubmission): SubmissionContext | undefined {
  const p = s.author?.participantType ?? s.participantType;
  switch (p) {
    case 'CONTESTANT':
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

/**
 * CF 题号 → { contestId, index }：规则唯一真源在 adapters/problemKey.ts 的
 * splitCodeforcesProblemKey（与 contests/participated.ts 的 contestIdOf 同一口径）。
 * 这里只负责把「拆不出来」转成 problemUrl 的保守退化（整键当普通题号拼链接）。
 */
function splitKey(key: string): { contestId?: string; index: string } {
  return splitCodeforcesProblemKey(key) ?? { index: key };
}

/**
 * Codeforces 适配器：官方公开 API user.status（无需登录）。
 * 提交按新到旧返回：同步层注入库中已知提交号后，整页已知即提前终止分页（增量），
 * 已知条目直接跳过；首刷无已知集合时全量分页，去重交由同步层按 externalId 处理。
 * 分批防封号：单次同步受 maxSubmissions 新增上限与页数预算约束，触及即停（opts.truncated）。
 * 补全续拉：backfill_page 记录已拉到的最深页（下一页起点），下次回退至多 2 页续拉（CF 列表
 * 只在头部增长，旧行只会后移，从游标页继续不会跳过未知行）——CF 必须穿过任意长的已知前缀
 * 走向更旧，「连续 N 页整页已知即收尾」对无游标直穿的场景会把更早历史永久锁死，故补全模式
 * 不设该判据。**重叠页必须小于页数预算**（否则「每轮推进 = 预算 - 重叠 = 0」，游标原地打转）。
 * days 窗口（opts.windowSince）：列表按新到旧，遇到早于窗口起点的行即收尾，不计截断——
 * 与 pagination.ts 的语义一致，避免向用户谎报「窗口内仍有未覆盖的记录」。
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
      const knownVerdicts = opts?.knownVerdicts;
      const knownProblemKeys = opts?.knownProblemKeys;
      const maxSubmissions = opts?.maxSubmissions;
      // 新增上限推算的页数预算（×2 裕量），上限 PER_SYNC_MAX_PAGES；首刷/增量无上限时取上限
      const budget =
        maxSubmissions && maxSubmissions > 0
          ? Math.min(Math.ceil(maxSubmissions / PAGE_SIZE) * 2, PER_SYNC_MAX_PAGES)
          : PER_SYNC_MAX_PAGES;
      const out: NormalizedSubmission[] = [];
      /**
       * 「仅同步最近 N 天」窗口起点（毫秒）。同步层只在 days 窗口模式注入（见 types.ts）。
       * CF 的 user.status 没有按时间过滤的参数（`from` 是 1 起的条目索引，实测传 UNIX 秒会被拒：
       * `from: Field should be no more than 1000000000`），窗口只能靠逐行比较 creationTimeSeconds
       * 实现：列表按新到旧返回，遇到早于窗口起点的行即停，该行及后续都更旧。
       */
      const windowSinceMs = opts?.windowSince ? Date.parse(opts.windowSince) : NaN;
      const hasWindow = Number.isFinite(windowSinceMs);
      // 补全续拉游标（backfill_page，1 起的页码）：CF 列表只会在头部增长（旧行只会后移），
      // 从游标页继续不会跳过任何未知行；回退 OVERLAP_PAGES 页覆盖轮间新增的提交——
      // 已知行由 knownExternalIds 去重，代价每轮仅几次重复请求。轮间新增超过 2 整页的
      // 部分推迟到补全结束后由增量同步补上（不丢，只是晚到）。
      const OVERLAP_PAGES = 2;
      const cursorPage =
        opts?.backfill && Number.isInteger(opts.backfillFromPage) && (opts.backfillFromPage as number) > 0
          ? (opts.backfillFromPage as number)
          : 0;
      // 重叠页不得吃掉整个页数预算：预算是「本次最多请求的页数」，若重叠 ≥ 预算，每轮
      // 净推进 = 预算 - 重叠 ≤ 0，游标原地打转（默认 maxSubmissions=300 → 预算 2 页，
      // 与回退 2 页相抵，实测每轮都只请求 from=1,1001，第 3 页永远到不了 —— 死端没被修掉，
      // 只是从「已知前缀收尾」换成了「游标不推进」）。上限取 预算-1，保证每轮至少推进 1 页。
      const overlapPages = Math.min(OVERLAP_PAGES, Math.max(0, budget - 1));
      const startPage = cursorPage > 0 ? Math.max(1, cursorPage - overlapPages) : 1;
      let from = (startPage - 1) * PAGE_SIZE + 1;
      let naturalEnd = false;
      let caughtUp = false;
      let rowCapped = false;
      let windowEnded = false; // 已越过「仅同步最近 N 天」的窗口起点（不是截断）
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
          const id = String(s.id);
          const norm = normalize(s);
          // 窗口终止：列表按新到旧，本行已早于窗口起点 → 本行与后续页都更旧，直接收尾。
          // 与 pagination.ts 的口径一致（洛谷/牛客/力扣/代码源同一语义），且**不计截断**：
          // 窗口内能拉到的已经全在 out 里，报「窗口内仍有未覆盖的记录」是谎报。
          if (hasWindow && Date.parse(norm.submittedAt) < windowSinceMs) {
            windowEnded = true;
            break;
          }
          if (known?.has(id)) {
            // 已入库：仅平台侧改判（评测中 TESTING → 终态、平台重判）或改题号时重发，交由写入层
            // refreshVerdict / mergeProblemRow 刷新既有行——否则评测中被同步到的提交会被
            // INSERT OR IGNORE 永久冻结在 SKIPPED（CF 的 VERDICT_MAP 只收 6 个终态，TESTING/
            // PARTIAL/CHALLENGED 等一律落 SKIPPED）。与 atcoder/jisuanke/luogu 同一自愈机制，
            // 见 types.ts 的 knownVerdicts 契约。重发行不计入 unknownInPage：整页已知（含少量
            // 改判）时增量早停仍然成立，改判行数量极少、照常计入新增上限预算。
            // knownMissingContext：participantType 读错位置的历史 bug 造成库内 context 全空，
            // 本次能解析出语境的已知行重发一次，由写入层 backfillContext 补上。
            const storedVerdict = knownVerdicts?.get(id);
            const storedKey = knownProblemKeys?.get(id);
            const changed =
              (storedVerdict !== undefined && storedVerdict !== norm.verdict) ||
              (storedKey !== undefined && storedKey !== norm.problem.problemKey) ||
              (norm.context !== undefined && opts?.knownMissingContext?.has(id) === true);
            if (!changed) continue;
          } else {
            unknownInPage += 1;
          }
          out.push(norm);
          if (maxSubmissions && out.length >= maxSubmissions) {
            rowCapped = true;
            break;
          }
        }
        if (rowCapped) break;
        if (windowEnded) break;
        if (page.length < PAGE_SIZE) {
          naturalEnd = true; // 最后一页
          break;
        }
        if (known && unknownInPage === 0 && !opts?.backfill) {
          // 增量模式「整页已知」：后续页必然已知，立即终止。
          // 补全模式**不能**用「连续 N 页整页已知」收尾——CF 没有服务端游标、必须穿过
          // 任意长的已知前缀走向更旧，库里只要覆盖了最新 N 整页（重度用户 2000 条很常见），
          // 该判据就会把更早的历史永久锁在 N 页之外（2026-10 审查确认的补全死端）。
          // 补全的收尾只认自然结束（短页）或页数预算，配合上面的游标续拉保证推进。
          caughtUp = true;
          break;
        }
        from += PAGE_SIZE;
        await sleep(PAGE_DELAY_MS); // CF 建议 <= 2 req/s
      }
      // 截断：触及上限，或页数预算耗尽（未自然结束/未增量早停/未到 windowSince 窗口起点）。
      // 补全模式下即使 0 新增（预算全花在穿越已知前缀）也要如实回传截断并回写游标——
      // 否则同步层清掉 sync_truncated/backfill_page，已知前缀之后的更早历史被永久放弃。
      // from 此刻指向下一页起点；rowCapped 中断时仍指向正在处理的页——两种情况
      // 「从这一页重新开始」都是安全的（已知行被 knownExternalIds 去重）。
      // windowEnded 是「窗口到头」，窗口内能拉到的已经全在 out 里，不是截断（与 pagination.ts 同口径）。
      const truncated = rowCapped || (!naturalEnd && !caughtUp && !windowEnded);
      if (truncated && opts) {
        opts.truncated = true;
        opts.backfillReachedPage = Math.floor((from - 1) / PAGE_SIZE) + 1;
      }
      return out;
    },

    problemUrl({ problemKey }) {
      // 与 normalize 的 problemUrlFor 同一映射（gym/contest 分流），改一处漏一处是
      // 历史包袱；这里把题号拆分结果转成 (contestId, index) 委托过去，仅「拆不出来」
      // 的退化分支（整键当普通题号）留在这边。
      const { contestId, index } = splitKey(String(problemKey));
      if (!contestId) {
        return `https://codeforces.com/problemset/problem/${String(problemKey)}`;
      }
      return problemUrlFor(Number(contestId), index);
    },
  };
}

function normalize(s: CFSubmission): NormalizedSubmission {
  const { contestId, index } = s.problem;
  const key = contestId !== undefined ? `${contestId}${index}` : index;
  const context = contextOf(s);
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
