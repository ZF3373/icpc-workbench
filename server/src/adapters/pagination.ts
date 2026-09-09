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

/** 页码型平台（牛客/力扣/代码源）分批拉取的统一配置 */
export interface PagedFetchConfig<R> {
  /** 每页条数（用于推算页数预算与「最后一页」判定） */
  pageSize: number;
  /** 每次同步的保守页数上限（按平台风控强度选定） */
  perSyncMax: number;
  /** 拉取指定页的全部原始行（空数组 = 已到尽头） */
  fetchPage: (page: number) => Promise<R[]>;
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
  /** 适配器 → 同步层 out 字段载体（回写 truncated / backfillReachedPage） */
  opts?: FetchOptions;
  /** 页间限速（毫秒），默认 0 */
  pageDelayMs?: number;
}

/**
 * 页码型平台统一分批拉取：按新→旧翻页，跳过已知条目，受新增上限与页数预算双重约束。
 * - 增量模式（非 backfill）：整页已知即提前终止（更旧都在库中）。
 * - 补全模式（backfill）：从 backfillFromPage 续拉，整页已知则跳过继续向更旧，回写 reachedPage 游标。
 * - 触及新增上限 / 页数预算耗尽且有新增 → 回写 truncated=true + backfillReachedPage。
 * - 自然结束（空页 / 最后一页）/ 增量早停 / 补全一无所获 → 不截断。
 */
export async function pagedFetch<R>(cfg: PagedFetchConfig<R>): Promise<NormalizedSubmission[]> {
  const budget = pageBudget(cfg.maxSubmissions, cfg.pageSize, cfg.perSyncMax);
  const startPage = cfg.backfill && cfg.backfillFromPage ? cfg.backfillFromPage : 1;
  const out: NormalizedSubmission[] = [];
  let reachedPage = startPage;
  let naturalEnd = false; // 空页 / 最后一页
  let caughtUp = false; // 增量模式整页已知早停
  let rowCapped = false; // 触及新增上限
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  for (let page = startPage, n = 0; n < budget; page += 1, n += 1) {
    reachedPage = page;
    const rows = await cfg.fetchPage(page);
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
      out.push(norm);
      if (cfg.maxSubmissions && out.length >= cfg.maxSubmissions) {
        rowCapped = true;
        break;
      }
    }
    if (rowCapped) break;
    // 整页已知（所有行都在库中）：补全跳过该页继续向更旧，增量模式则终止（更旧都在库）
    if (cfg.knownExternalIds && knownInPage > 0 && knownInPage === rows.length) {
      if (cfg.backfill) {
        if (cfg.pageDelayMs) await sleep(cfg.pageDelayMs);
        continue;
      }
      caughtUp = true;
      break;
    }
    if (rows.length < cfg.pageSize) {
      naturalEnd = true; // 最后一页
      break;
    }
    if (cfg.pageDelayMs) await sleep(cfg.pageDelayMs);
  }

  // 截断判定：触及上限，或页数预算耗尽（未自然结束 / 未增量早停）且有新增 → 仍有更早历史待补全
  let truncated = rowCapped;
  if (!rowCapped && !naturalEnd && !caughtUp && out.length > 0) truncated = true;
  if (truncated && cfg.opts) {
    cfg.opts.truncated = true;
    cfg.opts.backfillReachedPage = reachedPage;
  }
  return out;
}
