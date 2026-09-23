import type {
  PlatformId,
  SyncResult,
  Verdict,
} from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { insertNormalized } from '../import/importService.ts';
import { getAdapter } from './registry.ts';
import { createBackup } from '../backup.ts';
import { ManualImportRequiredError, SyncError, type FetchOptions, type SyncErrorCode } from './types.ts';
import { cancelAutoContinue, scheduleAutoContinue } from './syncScheduler.ts';
import { beginSync, endSync, jobSiteRequests, setSyncPhase } from './syncProgress.ts';

export interface SyncOptions {
  userId?: number;
  /** 仅同步最近 N 天（补充拉取窗口）：不改 platform_accounts 状态，插入仍按唯一键去重 */
  days?: number;
  /** 同步触发来源（写入 sync_runs.triggered_by，供同步中心展示）；auto = 后台分批续拉 */
  triggeredBy?: 'manual' | 'retry' | 'days' | 'all' | 'auto';
}

/** 每个平台建议的同步间隔（毫秒）：按平台风控强度选定，同步中心据此展示「下次推荐同步时间」。
 *  本次整体翻倍：默认单次上限下调 + 全局按域名节流后，请求密度已显著降低，间隔相应拉长。 */
const SUGGESTED_SYNC_INTERVAL_MS: Partial<Record<PlatformId, number>> = {
  codeforces: 4 * 3600_000,
  atcoder: 12 * 3600_000,
  luogu: 12 * 3600_000,
  nowcoder: 24 * 3600_000,
  leetcode: 24 * 3600_000,
  daimayuan: 24 * 3600_000,
  // QOJ：前置 Cloudflare，请求密度越低越安全；提交记录按页（10 条/页）拉取，不宜过于频繁
  qoj: 24 * 3600_000,
};
const DEFAULT_SYNC_INTERVAL_MS = 24 * 3600_000;

/**
 * 将同步过程中的异常归类为可解释错误码（sync_runs.error_code）：
 * 优先识别显式 SyncError，再按既有适配器错误消息的特征回退匹配。
 */
export function classifySyncError(e: unknown): SyncErrorCode {
  if (e instanceof SyncError) return e.code;
  if (e instanceof ManualImportRequiredError) return 'manual_required';
  const msg = String((e as Error)?.message ?? '');
  if (/HTTP 429|限流|Too Many Requests/i.test(msg)) return 'rate_limited';
  if (/HTTP 40[13]|Cookie|风控|登录|auth/i.test(msg)) return 'auth_expired';
  if (/结构|解析失败|页面异常|parse/i.test(msg)) return 'schema_changed';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|abort|网络/i.test(msg)) return 'network';
  return 'unknown';
}

/** 单次同步新增提交数默认上限与取值范围（分批拉取防封号）；与 settings 路由共用同一约束。
 *  保守取值：默认 300 条/次，可调 100–1500。这个值同时是分页预算的乘数
 *  （页数预算 = ⌈max/pageSize⌉×2），因此它直接决定单次同步对平台的请求次数：
 *  默认 300 时牛客 60 页、QOJ 60 页、洛谷 30 页。重型用户（>300 条）需多次点击同步逐步补全，
 *  但每次请求量小、耗时可控，最大程度避免触发平台风控封号。 */
export const DEFAULT_SYNC_MAX_SUBMISSIONS = 300;
export const MIN_SYNC_MAX_SUBMISSIONS = 100;
export const MAX_SYNC_MAX_SUBMISSIONS = 1500;

/** 库中该平台已有的平台侧提交号与当前 verdict（适配器提前终止分页 + 改判检测用） */
function loadKnownSubmissions(
  db: Db,
  userId: number,
  platform: PlatformId,
): { ids: Set<string>; verdicts: Map<string, Verdict> } {
  const rows = db
    .prepare('SELECT external_id, verdict FROM submissions WHERE user_id = ? AND platform = ?')
    .all(userId, platform) as Array<{ external_id: string; verdict: Verdict }>;
  const ids = new Set<string>();
  const verdicts = new Map<string, Verdict>();
  for (const r of rows) {
    if (r.external_id == null) continue;
    ids.add(r.external_id);
    verdicts.set(r.external_id, r.verdict);
  }
  return { ids, verdicts };
}

/** 读取单次同步上限设置（sync.maxSubmissions），越界回退默认值 */
export function readMaxSubmissions(db: Db): number {
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('sync.maxSubmissions') as { value: string } | undefined;
  const n = Number(row?.value);
  if (!Number.isInteger(n) || n < MIN_SYNC_MAX_SUBMISSIONS || n > MAX_SYNC_MAX_SUBMISSIONS) {
    return DEFAULT_SYNC_MAX_SUBMISSIONS;
  }
  return n;
}

/** AtCoder 按 epoch 升序拉取（最旧→最新），其余平台均按新→旧 */
function isAscendingPlatform(platform: PlatformId): boolean {
  return platform === 'atcoder';
}

/**
 * 同平台互斥锁（进程内）：手动点击、一键同步、失败重试、days 补拉与后台分批续拉可能同时到达
 * 同一平台，并发请求会成倍放大平台风控/封号风险，故同一平台同时只允许一个同步在跑。
 *
 * 重复触发**不排队**：直接返回一个带解释的 SyncResult，且不写 sync_runs 行——它没有产生任何
 * 平台请求，不是「同步失败」，写失败行会污染同步中心的健康度推导。
 * 锁在所有退出路径（含异常）释放，见 syncPlatform 的 try/finally。
 */
const SYNC_IN_FLIGHT = new Set<PlatformId>();

/**
 * 会抢占后台续拉队列的触发来源：**用户主动发起的完整同步**（manual 手动点同步 / all 一键全同步 /
 * retry 失败重试）。只有它们接管队列——它们会完整走一遍「拉取 → 写 platform_accounts →
 * 若仍被截断则在末尾重新注册第 1 轮」，队列语义因此被新任务接续。
 *
 * 明确排除：
 * - `days`：补充拉取窗口，不改 platform_accounts、末尾也不重新注册（见 runSyncPlatform）。
 *   若在此取消待续拉，DB 里仍标着 sync_truncated=1 / backfill_page=N，但剩余轮次已被静默丢弃。
 * - `auto`：后台续拉自身，当然不清自己的队列。
 * - `undefined`（未声明来源的调用方，如模板页「例题一键同步」）：不是「完整同步」语义，
 *   不清队列；本次若被截断，末尾的注册逻辑会复用/接续既有队列。
 */
function preemptsAutoContinue(triggeredBy: SyncOptions['triggeredBy']): boolean {
  return triggeredBy === 'manual' || triggeredBy === 'all' || triggeredBy === 'retry';
}

/**
 * 同步某个平台账号的刷题记录（分批防封号）：
 * 1. 同平台互斥 + 抢占续拉队列（仅用户主动发起的完整同步会取消该平台待执行的续拉）
 * 2. 检查平台开关（settings.adapter.<platform>.enabled，缺省启用）
 * 3. 读取 platform_accounts.last_sync_at / sync_truncated 做增量或补全
 * 4. 适配器按 maxSubmissions 上限分批拉取 → insertNormalized 事务入库
 * 5. 更新 last_sync_at / sync_truncated 与账号信息；截断时注册后台续拉
 *
 * 防封号策略：单次同步只拉 maxSubmissions 条新增（默认 300），触及上限即停止并标记
 * sync_truncated=1；下次同步自动进入补全模式（backfill）继续拉取更早的历史，把原本一次性的
 * 全量拉取拆成多次小批量，避免短时间内大量请求触发平台风控。补全模式跳过已入库的页继续向更旧翻；
 * 当某次补全一无所获（已无可达早期记录）时自动结束补全。
 * 平台无公开 API（ManualImportRequiredError）→ 转为引导提示而非失败。
 */
export async function syncPlatform(
  db: Db,
  platform: PlatformId,
  handle: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  // 用户主动触发的完整同步（manual / all / retry）抢占后台续拉队列：先取消该平台待执行的续拉，
  // 本次若仍被截断会在末尾重新注册一个第 1 轮任务——用户的一次同步即接管队列，
  // 不会与后台续拉交错请求同一平台。days（补充拉取，末尾不重新注册）与 auto（续拉自身）
  // 都不抢占；triggeredBy 缺省同样不抢占（未见声明即不假设是完整同步）。
  //
  // 位置：必须在内存互斥锁**之后**。被锁拒绝的重复触发没有发出任何平台请求、也没写
  // platform_accounts，若在锁前取消，则「正在同步中：已跳过本次重复触发」会顺带杀掉待续拉队列
  // （调度器 settle 时 jobs.get(platform) !== job → 不再排期），用户不点第二次就永远不续拉。
  if (SYNC_IN_FLIGHT.has(platform)) {
    return {
      platform,
      handle,
      imported: 0,
      skipped: 0,
      errors: [`平台 ${platform} 正在同步中：已跳过本次重复触发（同平台串行执行，请等待当前同步结束）`],
    };
  }
  SYNC_IN_FLIGHT.add(platform);
  try {
    if (preemptsAutoContinue(opts.triggeredBy)) cancelAutoContinue(platform);
    return await runSyncPlatform(db, platform, handle, opts);
  } finally {
    SYNC_IN_FLIGHT.delete(platform);
    // 进度登记与锁同生命周期：成功 / 失败 / 抛错都必须清掉，否则前端会长期显示幽灵进度
    endSync(platform);
  }
}

/** syncPlatform 的实际执行体（仅在同平台互斥锁内调用，不对外导出）。 */
async function runSyncPlatform(
  db: Db,
  platform: PlatformId,
  handle: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const userId = opts.userId ?? DEFAULT_USER_ID;
  const result: SyncResult = { platform, handle, imported: 0, skipped: 0, errors: [] };

  const adapter = getAdapter(platform);
  if (!adapter) {
    result.errors.push(`未注册适配器: ${platform}`);
    return result;
  }
  const enabledRaw = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(`adapter.${platform}.enabled`) as { value: string } | undefined;
  if (enabledRaw?.value === 'false') {
    result.errors.push(`平台 ${platform} 已禁用（可在设置中开启）`);
    return result;
  }

  // 同步历史（sync_runs）：无论成败都记录，供同步中心展示失败原因与限速等待
  const startedAt = new Date().toISOString();
  const startedTick = Date.now();
  let mode: 'full' | 'incremental' | 'backfill' | 'days' = 'incremental';
  let waitedMs = 0;
  let truncated = false;

  const daysWindow = opts.days && opts.days > 0 ? opts.days : 0;

  const account = db
    .prepare('SELECT handle, last_sync_at, sync_truncated, backfill_page FROM platform_accounts WHERE user_id = ? AND platform = ?')
    .get(userId, platform) as { handle: string; last_sync_at: string | null; sync_truncated: number; backfill_page: number | null } | undefined;
  // 换账号判定：handle 不同，或从未成功同步过（last_sync_at 为空，如设置页改绑后）。
  // 两种情况都要求全量重拉 + 清空该平台旧数据，避免跨账号数据混入或增量起点错乱。
  // 注意：同 handle 首次成功同步时也会清空该平台旧数据（含手动导入记录）——
  // 语义是"同步以平台数据为准"，手动导入数据会被平台数据取代。
  // days 窗口模式是补充拉取，不改账号状态、不触发清空。
  const handleChanged =
    !daysWindow &&
    account !== undefined &&
    (account.handle !== handle || !account.last_sync_at);

  try {
    // 换账号会清空该平台旧提交：先建「重置前」恢复点（失败只记日志，不阻塞同步）
    if (handleChanged) {
      try {
        const b = createBackup(db, 'pre-reset');
        console.log(`[backup] 换账号重置前备份已创建: ${b.file}`);
      } catch (e) {
        console.error(`[backup] 重置前备份失败（继续同步）: ${(e as Error).message}`);
      }
    }
    // 换账号/未成功同步过：全量重拉（不沿用可能属于旧账号的增量起点）
    const since =
      daysWindow
        ? new Date(Date.now() - daysWindow * 86_400_000).toISOString()
        : !handleChanged && account?.last_sync_at ? account.last_sync_at : undefined;
    // 声明支持已知提交号过滤的适配器（CF/洛谷/牛客，拉取按新到旧排序）：
    // 注入库中已有提交号，适配器整页已知即提前终止分页，实现真实增量。
    // days 窗口模式不注入（否则整页已知会提前终止，覆盖不到窗口内漏拉的历史），
    // 窗口终止由 since 早停承担，重复插入由唯一键去重兜底。
    const knownSubs =
      !daysWindow && !handleChanged && adapter.knownIdsFilter
        ? loadKnownSubmissions(db, userId, platform)
        : undefined;
    // 需登录平台：从 settings 读取 Cookie / CSRF 注入适配器
    const readSetting = (key: string): string | undefined => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    };
    const cookie = readSetting(`cookie.${platform}`);
    const csrf = readSetting(`csrf.${platform}`);
    // 复刻浏览器 UA（QOJ 等 cf_clearance 绑定 UA 的平台需要；缺省由适配器用内置 UA）
    const ua = readSetting(`ua.${platform}`);
    const maxSubmissions = readMaxSubmissions(db);
    // 计蒜客练习（题库）提交开关：缺省开启，仅字面量 'false' 关闭
    const practiceSync = platform === 'jisuanke'
      ? readSetting('jisuanke.practiceSync') !== 'false'
      : undefined;
    // 补全模式：上次同步被截断（仍有更早历史待拉），且非换账号全量重拉
    const backfill = !daysWindow && !handleChanged && account?.sync_truncated === 1;
    mode = daysWindow ? 'days' : handleChanged ? 'full' : backfill ? 'backfill' : 'incremental';

    // 始终传入一个完整对象，便于适配器回写 truncated / backfillReachedPage / waitedMs out 字段。
    // windowSince 仅在 days 窗口模式注入：降序平台分页按窗口起点提前终止；
    // 常规增量绝不注入时间截断（牛客存在提交晚于其提交时间出现在列表的真实场景）。
    const fetchOpts: FetchOptions = {
      ...(since ? { since } : {}),
      ...(daysWindow && since ? { windowSince: since } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { csrf } : {}),
      ...(ua ? { ua } : {}),
      ...(knownSubs ? { knownExternalIds: knownSubs.ids, knownVerdicts: knownSubs.verdicts } : {}),
      maxSubmissions,
      ...(practiceSync !== undefined ? { practiceSync } : {}),
      ...(backfill ? { backfill: true } : {}),
      ...(backfill && account?.backfill_page ? { backfillFromPage: account.backfill_page } : {}),
    };
    // 进度登记：模式与上限都已知，真正打上游之前（前端据此显示已用时 + 站点请求数 + 心跳）
    beginSync({
      platform,
      handle,
      mode,
      ...(daysWindow ? { days: daysWindow } : {}),
      maxSubmissions,
    });
    const rows = await adapter.fetchUserSubmissions(handle, fetchOpts);
    setSyncPhase(platform, 'saving');
    truncated = fetchOpts.truncated === true;
    waitedMs = fetchOpts.waitedMs ?? 0;
    const reachedPage = fetchOpts.backfillReachedPage;

    // 换账号：全量重拉，并在同一事务内清空该平台旧提交再写入新数据
    const r = insertNormalized(db, userId, rows, {
      clearPlatform: handleChanged ? platform : undefined,
    });
    result.imported = r.imported;
    result.skipped = r.skipped;
    if (!daysWindow && !handleChanged && (since || (knownSubs && knownSubs.ids.size > 0))) {
      result.incremental = true;
    }

    // days 窗口模式为补充拉取：不改 platform_accounts 状态（last_sync_at / 补全游标保持原样）；
    // 但触及上限时必须如实上报（result.truncated + sync_runs.truncated）——否则用户被告知
    // 「已同步最近 N 天」，窗口内未覆盖完的历史被静默丢弃。不注册后台续拉（避免无限循环），
    // 提示用户再次点击同步或调大单次上限即可续拉。
    if (daysWindow) {
      if (truncated) {
        result.truncated = true;
        result.note =
          `最近 ${daysWindow} 天内提交较多，已达单次上限：本次新增 ${r.imported} 条，窗口内仍有未覆盖的记录` +
          `（重复 ${r.skipped} 条自动跳过）。再次点击同步可继续补全，或在「设置 → 平台账号与适配器」调大单次上限。`;
      } else {
        result.note = `已同步最近 ${daysWindow} 天：新增 ${r.imported} 条（重复 ${r.skipped} 条自动跳过）。`;
      }
      recordSyncRun(db, userId, platform, handle, startedAt, startedTick, {
        mode, status: 'ok', imported: r.imported, skipped: r.skipped, truncated, waitedMs,
        triggeredBy: opts.triggeredBy ?? 'days', nextSuggestedSyncAt: null,
      });
      return result;
    }

    // last_sync_at 推进策略：
    // - 升序平台（AtCoder，按 epoch 升序、用 since/from_second 续拉）：被截断时推进到「本次拉到的
    //   最新提交时间」，下次同步从该时间点继续向前补全；未截断则推进到当前时刻。
    // - 降序平台（CF/洛谷/牛客等，按新→旧、用 knownIds 增量）：始终推进到当前时刻——它们的增量
    //   依赖 knownExternalIds 而非 since，last_sync_at 仅用于换账号判定与增量标记，补全由
    //   sync_truncated 驱动 backfill 跳页实现，与 last_sync_at 取值无关。
    let nextLastSyncAt: string;
    if (truncated && isAscendingPlatform(platform) && rows.length > 0) {
      nextLastSyncAt = rows.reduce(
        (max, x) => (x.submittedAt > max ? x.submittedAt : max),
        rows[0].submittedAt,
      );
    } else {
      nextLastSyncAt = new Date().toISOString();
    }
    // sync_truncated：截断（仍有更早历史）置 1，否则（自然结束 / 补全一无所获）清 0
    const nextTruncated = truncated ? 1 : 0;
    // backfill_page：截断时记录本次拉到的最深页（下次续拉），自然结束/补全完成时清空
    const nextBackfillPage = truncated && reachedPage ? reachedPage : null;

    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled, sync_truncated, backfill_page)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, platform) DO UPDATE SET
         handle = excluded.handle,
         last_sync_at = excluded.last_sync_at,
         enabled = 1,
         sync_truncated = excluded.sync_truncated,
         backfill_page = excluded.backfill_page`,
    ).run(userId, platform, handle, nextLastSyncAt, nextTruncated, nextBackfillPage);

    if (truncated) {
      result.truncated = true;
      result.note =
        `提交记录较多，已分批同步 ${r.imported} 条以防触发平台风控；再次点击同步可继续补全更早的历史记录。` +
        `（单次上限可在「设置 → 平台账号与适配器」中调整）`;
    } else if (mode === 'backfill' && r.imported === 0) {
      // 补全轮次一无所获：把「没有新提交为什么还请求了」解释清楚（请求数取节流层窗口增量）
      const requests = jobSiteRequests(platform);
      result.note =
        '补全检查完成：未发现更早的历史记录（库中已是最全），本次仅做检查、未新增提交' +
        (requests !== null && requests > 0 ? `，共发出 ${requests} 次请求。` : '。');
    }
    // 截断后按平台节奏注册后台续拉：把「多次点击同步」变成自动分批。
    // days 窗口模式是补充拉取（不改账号状态）、auto 是续拉自身再截断——两者都不注册，避免无限续拉。
    if (truncated && opts.triggeredBy !== 'auto' && opts.triggeredBy !== 'days') {
      const state = scheduleAutoContinue(db, platform, handle);
      if (state) {
        result.autoContinue = { round: state.round, maxRounds: state.maxRounds, nextAt: state.nextAt };
      }
    }
    recordSyncRun(db, userId, platform, handle, startedAt, startedTick, {
      mode, status: 'ok', imported: r.imported, skipped: r.skipped, truncated, waitedMs,
      triggeredBy: opts.triggeredBy ?? 'manual',
      nextSuggestedSyncAt: new Date(Date.now() + (SUGGESTED_SYNC_INTERVAL_MS[platform] ?? DEFAULT_SYNC_INTERVAL_MS)).toISOString(),
    });
  } catch (e) {
    const code = classifySyncError(e);
    if (e instanceof ManualImportRequiredError) {
      result.errors.push(e.message);
    } else {
      result.errors.push((e as Error).message);
    }
    recordSyncRun(db, userId, platform, handle, startedAt, startedTick, {
      mode, status: 'failed', imported: 0, skipped: 0, truncated: false, waitedMs,
      triggeredBy: opts.triggeredBy ?? 'manual', nextSuggestedSyncAt: null,
      errorCode: code, errorMessage: (e as Error).message,
    });
  }
  return result;
}

/** 写入一条同步历史（sync_runs）。 */
function recordSyncRun(
  db: Db,
  userId: number,
  platform: PlatformId,
  handle: string,
  startedAt: string,
  startedTick: number,
  data: {
    mode: string;
    status: 'ok' | 'failed';
    imported: number;
    skipped: number;
    truncated: boolean;
    waitedMs: number;
    triggeredBy: string;
    nextSuggestedSyncAt: string | null;
    errorCode?: SyncErrorCode;
    errorMessage?: string;
  },
): void {
  db.prepare(
    `INSERT INTO sync_runs (user_id, platform, handle, started_at, finished_at, duration_ms,
       imported, skipped, truncated, waited_ms, mode, status, error_code, error_message,
       triggered_by, next_suggested_sync_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId, platform, handle, startedAt, new Date().toISOString(), Date.now() - startedTick,
    data.imported, data.skipped, data.truncated ? 1 : 0, data.waitedMs, data.mode, data.status,
    data.errorCode ?? null, data.errorMessage ?? null, data.triggeredBy, data.nextSuggestedSyncAt,
  );
}
