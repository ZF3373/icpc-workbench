import type { NormalizedSubmission } from '../../../shared/src/index.ts';
import type { FetchOptions } from './types.ts';

/**
 * 分批同步（防封号）相关分页辅助。
 *
 * 单次同步受「新增条数上限 maxSubmissions」与「页数预算 pageBudget」双重约束：
 * - maxSubmissions：新增（未知）条目达此值即停，由调用方回写 opts.truncated。
 * - pageBudget：本次最多请求的页数。补全模式下页码型平台用 backfillFromPage 游标续拉，
 *   无需重扫已知页，故页数预算 = 新增上限推算的新页数 ×2（兼顾续拉起点的重叠页），
 *   并以平台 perSyncMax（每次同步的保守页数上限，按平台风控强度选定）封顶。
 *   首刷/增量（无 maxSubmissions）时回退 perSyncMax。
 */
export function pageBudget(
  maxSubmissions: number | undefined,
  pageSize: number,
  perSyncMax: number,
): number {
  if (!maxSubmissions || maxSubmissions <= 0) return perSyncMax;
  return Math.min(Math.ceil(maxSubmissions / pageSize) * 2, perSyncMax);
}

/** 适配器回写「本次触及上限而截断」的 out 信号（同步层据此驱动补全模式） */
export function markTruncated(opts: FetchOptions | undefined): void {
  if (opts) opts.truncated = true;
}

/**
 * 补全模式收尾判据：连续这么多个「整页已知」即认为已补到尽头，停止翻页。
 *
 * 为什么需要（实测）：补全模式原本遇到整页已知只会 `continue`，于是一路翻到页数预算尽头——
 * 在「库中已有全部提交、没有新提交」时，牛客/QOJ 会白打 60 次请求、洛谷 30 次、力扣 16 次
 * （见 .probe 探针的前后对比），而这一轮什么都不会导入。
 *
 * 取 2 而非 1：留一页重叠容差——续拉起点的重叠页本就可能是整页已知，
 * 若第一批已知页就停，真正的补全（游标之后第 1 页就有新行）会被误判为"已到尽头"。
 * 反之只要有一页出现新行，计数即归零，正常补全完全不受影响。
 */
export const BACKFILL_KNOWN_PAGE_LIMIT = 2;

/** 累计本次同步的限速等待耗时（同步层写入 sync_runs.waited_ms，同步中心展示） */
export function recordWait(opts: FetchOptions | undefined, ms: number): void {
  if (opts && ms > 0) opts.waitedMs = (opts.waitedMs ?? 0) + ms;
}

/** 页码型平台（牛客/力扣/代码源）分批拉取的统一配置 */
export interface PagedFetchConfig<R> {
  /** 每页条数（用于推算页数预算与「最后一页」判定） */
  pageSize: number;
  /** 每次同步的保守页数上限（按平台风控强度选定） */
  perSyncMax: number;
  /**
   * 拉取指定页（空数组 = 已到尽头）。
   * 也可返回 { rows, rawCount }：rawCount 为**平台侧原始数据行数**（解析丢弃畸形行前），
   * 「最后一页」判定只看 rawCount —— 解析层丢行（畸形行/页脚）会让 rows.length 偏小，
   * 若按解析后行数判短页，中间页会被误判为到底，更早历史被永久放弃。
   */
  fetchPage: (page: number) => Promise<R[] | { rows: R[]; rawCount: number }>;
  /** 原始行的平台侧提交号（去重 / 已知判定） */
  externalIdOf: (row: R) => string;
  /** 原始行 → 统一结构；返回 null 表示跳过（评测中 / 隐藏等，不计入已知也不计入新增） */
  normalize: (row: R) => NormalizedSubmission | null;
  /** 同步层注入：库中已有提交号（增量早停 / 补全跳页依据） */
  knownExternalIds?: Set<string>;
  /** 单次同步新增上限 */
  maxSubmissions?: number;
  /** 补全模式：跳过已知页继续向更旧翻，不因整页已知而提前终止 */
  backfill?: boolean;
  /** 补全续拉游标（从该页起续拉更早历史） */
  backfillFromPage?: number;
  /**
   * 同步窗口起点（ISO8601 UTC）。降序平台分页遇到早于该时间的提交时提前终止
   * （「仅同步最近 N 天」场景），终止不视为截断。
   */
  since?: string;
  /** 适配器 → 同步层 out 字段载体（回写 truncated / backfillReachedPage） */
  opts?: FetchOptions;
  /** 页间限速（毫秒），默认 0 */
  pageDelayMs?: number;
}

/**
 * 页码型平台统一分批拉取：按新→旧翻页，跳过已知条目，受新增上限与页数预算双重约束。
 * - 增量模式（非 backfill）：整页已知即提前终止（更旧都在库中）。
 * - 补全模式（backfill）：从 backfillFromPage 续拉，整页已知则跳过继续向更旧，
 *   但**连续 BACKFILL_KNOWN_PAGE_LIMIT 个整页已知即判定已补到尽头**（否则会在
 *   「没有更早历史可补」时空扫满整个页数预算）；回写 reachedPage 游标。
 * - 触及新增上限 / 页数预算耗尽且有新增 → 回写 truncated=true + backfillReachedPage。
 * - 自然结束（空页 / 最后一页）/ 增量早停 / 补全到尽头 → 不截断。
 */
export async function pagedFetch<R>(cfg: PagedFetchConfig<R>): Promise<NormalizedSubmission[]> {
  const budget = pageBudget(cfg.maxSubmissions, cfg.pageSize, cfg.perSyncMax);
  const startPage = cfg.backfill && cfg.backfillFromPage ? cfg.backfillFromPage : 1;
  const out: NormalizedSubmission[] = [];
  let reachedPage = startPage;
  let naturalEnd = false; // 空页 / 最后一页
  let caughtUp = false; // 增量模式整页已知早停 / 补全模式连续已知页到尽头
  let rowCapped = false; // 触及新增上限
  let windowEnd = false; // 早于 since 窗口起点（仅同步最近 N 天）
  let knownRun = 0; // 连续「整页已知」页数（补全模式收尾判据）
  const sleep = async (ms: number): Promise<void> => {
    if (ms <= 0) return;
    recordWait(cfg.opts, ms);
    await new Promise<void>((r) => setTimeout(r, ms));
  };

  for (let page = startPage, n = 0; n < budget; page += 1, n += 1) {
    reachedPage = page;
    const fetched = await cfg.fetchPage(page);
    const rawCount = Array.isArray(fetched) ? fetched.length : fetched.rawCount;
    const rows: R[] = Array.isArray(fetched) ? fetched : fetched.rows;
    if (rows.length === 0) {
      naturalEnd = true;
      break;
    }
    let knownInPage = 0;
    for (const row of rows) {
      const id = cfg.externalIdOf(row);
      if (cfg.knownExternalIds?.has(id)) {
        knownInPage += 1;
        continue;
      }
      const norm = cfg.normalize(row);
      if (norm === null) continue; // 评测中 / 隐藏等：不计入已知也不计入新增
      // 降序分页遇到早于窗口起点的行：本页后续与后续页都更旧，标记终止（不计截断）
      if (cfg.since && norm.submittedAt < cfg.since) {
        windowEnd = true;
        break;
      }
      out.push(norm);
      if (cfg.maxSubmissions && out.length >= cfg.maxSubmissions) {
        rowCapped = true;
        break;
      }
    }
    if (rowCapped || windowEnd) break;
    // 整页已知（所有行都在库中）：补全跳过该页继续向更旧，增量模式则终止（更旧都在库）
    if (cfg.knownExternalIds && knownInPage > 0 && knownInPage === rows.length) {
      if (cfg.backfill) {
        knownRun += 1;
        // 连续多个整页已知 → 视为已补到尽头（避免没有更早历史时空扫满预算，见常量注释）
        if (knownRun >= BACKFILL_KNOWN_PAGE_LIMIT) {
          caughtUp = true;
          break;
        }
        if (cfg.pageDelayMs) await sleep(cfg.pageDelayMs);
        continue;
      }
      caughtUp = true;
      break;
    }
    knownRun = 0; // 本页出现了新行 → 仍在有效补全区段，重新计数
    if (rawCount < cfg.pageSize) {
      naturalEnd = true; // 最后一页（按平台原始行数判，解析丢行不误判到底）
      break;
    }
    if (cfg.pageDelayMs) await sleep(cfg.pageDelayMs);
  }

  // 截断判定：触及上限，或页数预算耗尽（未自然结束 / 未增量早停 / 未到窗口起点）且有新增
  let truncated = rowCapped;
  if (!rowCapped && !naturalEnd && !caughtUp && !windowEnd && out.length > 0) truncated = true;
  if (truncated && cfg.opts) {
    cfg.opts.truncated = true;
    cfg.opts.backfillReachedPage = reachedPage;
  }
  return out;
}
