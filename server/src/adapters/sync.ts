import type {
  PlatformId,
  SyncResult,
  Verdict,
} from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { insertNormalized } from '../import/importService.ts';
import { getAdapter } from './registry.ts';
import { effectiveCredentials } from './accountCreds.ts';
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
  // 注意「风控」是析取式提示词（如「403（Cookie 过期或触发风控）」「503（可能触发风控）」），
  // 不能单独作为分类信号；按状态码区分：403=鉴权、503=限流/风控、429=限流。
  if (/HTTP 429|HTTP 503|限流|Too Many Requests/i.test(msg)) return 'rate_limited';
  if (/HTTP 40[13]|Cookie|登录|auth/i.test(msg)) return 'auth_expired';
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

/** 库中该账号已有的平台侧提交号与当前 verdict / 题目键（适配器提前终止分页 + 改判/改题号检测用），
 *  以及该账号最新一条提交时刻 maxSubmittedAt（升序平台的增量锚点，见 ascendingIncrementalSince）。
 *  多账号（v0.8）后按账号过滤：增量「整页已知提前终止」只看本账号的提交号，
 *  否则 A 账号会把 B 账号已入库的页误判为已知而漏拉。 */
function loadKnownSubmissions(
  db: Db,
  userId: number,
  platform: PlatformId,
  account: string,
): {
  ids: Set<string>;
  verdicts: Map<string, Verdict>;
  problemKeys: Map<string, string>;
  maxSubmittedAt: string | null;
} {
  const rows = db
    .prepare(
      `SELECT s.external_id, s.verdict, s.submitted_at, p.problem_key AS problem_key
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = ? AND s.platform = ? AND s.account = ?`,
    )
    .all(userId, platform, account) as Array<{
    external_id: string;
    verdict: Verdict;
    submitted_at: string;
    problem_key: string;
  }>;
  const ids = new Set<string>();
  const verdicts = new Map<string, Verdict>();
  const problemKeys = new Map<string, string>();
  let maxSubmittedAt: string | null = null;
  for (const r of rows) {
    if (r.external_id == null) continue;
    ids.add(r.external_id);
    verdicts.set(r.external_id, r.verdict);
    if (r.problem_key != null) problemKeys.set(r.external_id, r.problem_key);
    // Date.parse 比较而非字符串比较：提交时刻虽约定 ISO8601 UTC，但手动导入等路径
    // 可能写入不带毫秒的变体格式，字符串序对毫秒位缺失的写法会判错
    if (maxSubmittedAt === null || Date.parse(r.submitted_at) > Date.parse(maxSubmittedAt)) {
      maxSubmittedAt = r.submitted_at;
    }
  }
  return { ids, verdicts, problemKeys, maxSubmittedAt };
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
 * 升序平台增量同步的回看窗口（毫秒）。
 *
 * 背景（2026-10-03 排查到的真实数据丢失）：kenkoooo 的 `/user/submissions` 是**窗口式接口** ——
 * 每次至多返回 500 行，`from_second` 只能指定「从哪一秒开始」，**没有按行数偏移的能力**。
 * 这意味着「上一次同步结束到本次之间」的边界上，如果某个秒的提交数超过一整个窗口，
 * 无论适配器怎么翻页都无法把该秒取全（同一 from_second 只会反复给出同一窗）。
 * 更常见也更危险的是：光标若因为任何原因（瞬时上游空响应、时钟偏差、接口抖动）
 * 停在「比最新提交更晚」的位置，那么这之间的提交**再也拉不回来**——用户看到的就是
 * 「点了同步，但是最新的提交一直不进来」。
 *
 * 但只有回看窗口是不够的（2026-10-06 第二轮排查）：窗口是**锚定墙钟**的（last_sync_at − 12h），
 * 而 AtCoder 的上游是社区镜像 AtCoder Problems，收录存在延迟——比赛中的提交约几分钟到 2 小时，
 * 赛后补题/练习提交依赖它重爬旧比赛页，延迟可达数天。每次「一无所获但正常结束」的增量同步
 * 都会把 last_sync_at 推进到当前时刻，于是「提交发生 → 上游收录」之间每次同步都在把墙钟光标
 * 越推越远；一旦收录延迟超过「提交距上次同步的间隔 + 12h」，那段提交就落在所有后续回看窗口
 * 之外，永久丢失。当晚 abc478 的 7 条比赛提交就逼到过这个边缘（增量拉不到，靠 days 窗口补拉救回）。
 *
 * 因此升序平台的增量起点改为**锚定数据**：取「last_sync_at」与「库中该账号最新一条提交时刻」
 * 的较早者再回看（见 ascendingIncrementalSince）。锚在数据上意味着：只要某条提交还没进库，
 * 它就始终比锚点新、始终落在扫描范围内——收录延迟无论多长，收录后任意一次同步都能拉回，
 * 不再依赖「用户在上游收录前别点同步」。
 *
 * 回看 12 小时的直接目的退居其次：覆盖「锚点同一秒边界」的取全与重扫去重的安全垫。
 * 重复的提交由唯一键（user_id, platform, account, external_id）去重，代价是每次多扫
 * `回看窗口 / 500 行窗口` 个请求（已知行不占单次上限预算，见 atcoder.ts 行循环）。
 */
export const ASCENDING_SYNC_LOOKBACK_MS = 12 * 3600_000;

/**
 * 升序平台（AtCoder）的增量起点 = min(last_sync_at, 库中该账号最新提交时刻) − 回看窗口。
 * 导出以便单测直接断言「锚定数据」确实生效。
 *
 * - last_sync_at 缺失（全量首刷）→ undefined，不得凭空造出时间点。
 * - 库中最新提交比 last_sync_at 还早（常规形态：每次同步都把光标推进到墙钟当前时刻，而
 *   上游收录延迟使最新提交晚于最后一次扫描）→ 锚到**库中最新提交**，扫描范围重新覆盖
 *   「库末尾 → 现在」整段，晚收录的提交不丢。
 * - 库中最新提交比 last_sync_at 晚（days 窗口补拉导入过超出光标的新行）→ 锚回 last_sync_at：
 *   days 导入的行已知（唯一键/knownIds 跳过），从更晚的墙钟锚点扫起不重复回扫整段。
 * - 库中一行都没有 → 锚回 last_sync_at，行为与旧实现一致。
 */
export function ascendingIncrementalSince(
  lastSyncAt: string | undefined,
  maxKnownSubmittedAt: string | null | undefined,
): string | undefined {
  if (!lastSyncAt) return undefined;
  let anchor = lastSyncAt;
  if (maxKnownSubmittedAt && Date.parse(maxKnownSubmittedAt) < Date.parse(anchor)) {
    anchor = maxKnownSubmittedAt;
  }
  return ascendingSinceWithLookback(anchor);
}

/**
 * 升序平台的增量起点（含回看窗口）：对给定锚点回看 `ASCENDING_SYNC_LOOKBACK_MS`。
 * `since` 缺失（全量首刷）时返回 undefined。
 * 导出以便单测直接断言「回看窗口确实生效」。
 */
export function ascendingSinceWithLookback(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return since;
  return new Date(t - ASCENDING_SYNC_LOOKBACK_MS).toISOString();
}

/**
 * 升序平台（AtCoder）本批同步结束后的 last_sync_at 推进决策（纯函数，导出以便单测）：
 * - 未截断：推进到当前时刻（本批已拉到最新一条，下一轮从 now 起算增量）。
 * - 截断且本批有行：推进到**本批最新一条提交的时刻**——适配器返回的是「按提交时间升序的连续
 *   前缀」，砍点那一秒整秒收下，故光标正好落在已导入区间末尾；下轮从该时刻（含 12h 回看）续拉
 *   不会漏，也不会把已导入区间反复重扫。
 * - 截断且本批一行都没有（页预算被已入库行吃满，见 atcoder.ts 的 scannedUntil 回传）：
 *   推进到**实际扫描到的位置**，绝不能跳到当前时刻——(扫描点, now) 之间还没扫到的提交
 *   否则会被回看窗口永久漏掉，成为空洞。适配器没回报扫描点时只能保守取 now。
 */
export function ascendingNextLastSyncAt(args: {
  rows: Array<{ submittedAt: string }>;
  truncated: boolean;
  scannedUntil?: string;
  now: string;
}): string {
  if (!args.truncated) return args.now;
  if (args.rows.length > 0) {
    return args.rows.reduce(
      (max, x) => (x.submittedAt > max ? x.submittedAt : max),
      args.rows[0]!.submittedAt,
    );
  }
  return args.scannedUntil ?? args.now;
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

/** 互斥锁拒绝重复触发时返回的固定文案（调度器据此识别「被跳过」并原样重排本轮） */
export const SYNC_BUSY_MESSAGE = (platform: PlatformId): string =>
  `平台 ${platform} 正在同步中：已跳过本次重复触发（同平台串行执行，请等待当前同步结束）`;

/**
 * 该结果是否为「同平台已在同步、本次被互斥锁跳过」：它没有发出任何平台请求、
 * 也不是同步失败（见互斥锁注释），后台续拉调度器据此把它与真实失败区分开。
 */
export function isSyncBusyResult(result: SyncResult): boolean {
  return (
    result.imported === 0 &&
    result.skipped === 0 &&
    result.errors.length === 1 &&
    result.errors[0] === SYNC_BUSY_MESSAGE(result.platform)
  );
}

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
      errors: [SYNC_BUSY_MESSAGE(platform)],
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
    .prepare('SELECT handle, last_sync_at, sync_truncated, backfill_page FROM platform_accounts WHERE user_id = ? AND platform = ? AND handle = ?')
    .get(userId, platform, handle) as { handle: string; last_sync_at: string | null; sync_truncated: number; backfill_page: number | null } | undefined;
  // 全量判定：该账号从未成功同步过（last_sync_at 为空，如新绑定/删除后重绑）。
  // 多账号（v0.8）后同步按账号隔离：新增/删除账号**不再清空任何提交**——各账号数据以
  // submissions.account 隔离共存，重复数据由 (user_id, platform, account, external_id) 唯一键去重兜底，
  // 因此不再有「换账号先清库」的破坏性路径，重置前的备份也随之不需要。
  // days 窗口模式是补充拉取，不触发全量。
  const fullMode =
    !daysWindow &&
    (account === undefined || account.last_sync_at === null);

  try {
    // 全量重拉（不沿用可能属于其他账号/过期的增量起点）：last_sync_at 为空时 since 置空
    const rawSince =
      daysWindow
        ? new Date(Date.now() - daysWindow * 86_400_000).toISOString()
        : !fullMode && account?.last_sync_at ? account.last_sync_at : undefined;
    // 声明支持已知提交号过滤的适配器（CF/洛谷/牛客/AtCoder）：注入库中该账号已有提交号。
    // - 降序平台（CF/洛谷/牛客，拉取按新到旧排序）：适配器整页已知即提前终止分页，实现真实增量。
    //   days 窗口模式不注入（否则整页已知会提前终止，覆盖不到窗口内漏拉的历史），
    //   窗口终止由 since 早停承担，重复插入由唯一键去重兜底。全量模式同样注入：
    //   重复绑定/重拉时已知页可直接跳过，唯一键保证不会漏插也不会重插。
    // - 升序平台（AtCoder）：只用于跳过已入库行且不占单次上限预算（回看窗口重扫的旧行若计入
    //   预算，重度用户会被旧行吃满预算、游标停滞），不做整页提前终止，因此 days 窗口模式同样注入。
    //   其 maxSubmittedAt 同时是增量锚点的数据侧输入（见 ascendingIncrementalSince），须在算 since 前加载。
    const knownSubs =
      (!daysWindow || isAscendingPlatform(platform)) && adapter.knownIdsFilter
        ? loadKnownSubmissions(db, userId, platform, handle)
        : undefined;
    // 升序平台（AtCoder）的增量起点锚定「墙钟光标与库中最新提交的较早者」并回看一段：
    // 窗口式上游 + 只按秒定位的游标一旦停在最新提交之后，这之间的提交就再也拉不回来；
    // 且社区镜像收录有延迟，墙钟光标会在收录前被一次次空同步推远（详见
    // ASCENDING_SYNC_LOOKBACK_MS 注释）。锚到数据上后，收录无论多晚，收录后的任意一次
    // 同步都能把提交拉回。days 窗口模式是显式的补充拉取，锚点就是窗口起点（同样回看）。
    // 降序平台依赖 knownExternalIds 增量，不做回看（会白扫整页）。
    const since = isAscendingPlatform(platform)
      ? daysWindow
        ? ascendingSinceWithLookback(rawSince)
        : ascendingIncrementalSince(rawSince, knownSubs?.maxSubmittedAt)
      : rawSince;
    // 需登录平台：取该账号的生效凭据注入适配器。v0.9 起各账号**只用自己**的 Cookie
    //（accountCreds 槽位），不再回退平台级——没配置就明确报「未配置 Cookie」，
    // 谁过期续谁，互不牵连。UA 仍为平台级（浏览器属性，与账号无关）。
    const readSetting = (key: string): string | undefined => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    };
    const { cookie, csrf } = effectiveCredentials(db, platform, handle);
    // 复刻浏览器 UA（QOJ 等 cf_clearance 绑定 UA 的平台需要；缺省由适配器用内置 UA）
    const ua = readSetting(`ua.${platform}`);
    const maxSubmissions = readMaxSubmissions(db);
    // 计蒜客练习（题库）提交开关：缺省开启，仅字面量 'false' 关闭
    const practiceSync = platform === 'jisuanke'
      ? readSetting('jisuanke.practiceSync') !== 'false'
      : undefined;
    // 补全模式：上次同步被截断（仍有更早历史待拉），且非全量重拉
    const backfill = !daysWindow && !fullMode && account?.sync_truncated === 1;
    mode = daysWindow ? 'days' : fullMode ? 'full' : backfill ? 'backfill' : 'incremental';

    // 始终传入一个完整对象，便于适配器回写 truncated / backfillReachedPage / waitedMs out 字段。
    // windowSince 仅在 days 窗口模式注入：降序平台分页按窗口起点提前终止；
    // 常规增量绝不注入时间截断（牛客存在提交晚于其提交时间出现在列表的真实场景）。
    const fetchOpts: FetchOptions = {
      ...(since ? { since } : {}),
      ...(daysWindow && since ? { windowSince: since } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { csrf } : {}),
      ...(ua ? { ua } : {}),
      ...(knownSubs ? { knownExternalIds: knownSubs.ids, knownVerdicts: knownSubs.verdicts, knownProblemKeys: knownSubs.problemKeys } : {}),
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

    // 多账号按账号隔离入库：不同账号数据共存，重复由唯一键去重，不再有任何清库路径
    const r = insertNormalized(db, userId, rows, { account: handle });
    result.imported = r.imported;
    result.skipped = r.skipped;
    if (!daysWindow && !fullMode && (since || (knownSubs && knownSubs.ids.size > 0))) {
      result.incremental = true;
    }

    // 直连补充扫描（AtCoder Cookie 抓 own-submissions）的结果说明：补充条数与失败原因都以
    // note（而非 error）呈现——直连是镜像路径的补充，它的成败不改变本次同步的成败判定。
    const applyDirectScanNote = (result: SyncResult): void => {
      const parts: string[] = [];
      if (fetchOpts.directScanAdded) parts.push(`直连通道补充 ${fetchOpts.directScanAdded} 条`);
      if (fetchOpts.directScanNote) parts.push(fetchOpts.directScanNote);
      if (parts.length > 0) result.note = result.note ? `${result.note}（${parts.join('；')}）` : parts.join('；');
    };

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
      applyDirectScanNote(result);
      recordSyncRun(db, userId, platform, handle, startedAt, startedTick, {
        mode, status: 'ok', imported: r.imported, skipped: r.skipped, truncated, waitedMs,
        triggeredBy: opts.triggeredBy ?? 'days', nextSuggestedSyncAt: null,
      });
      return result;
    }

    // last_sync_at 推进策略：升序平台走 ascendingNextLastSyncAt（含「预算耗尽却一无所获时
    // 停在扫描点」的分支，见该函数注释）；降序平台始终推进到当前时刻。
    let nextLastSyncAt: string;
    if (isAscendingPlatform(platform)) {
      nextLastSyncAt = ascendingNextLastSyncAt({
        rows,
        truncated,
        ...(fetchOpts.scannedUntil ? { scannedUntil: fetchOpts.scannedUntil } : {}),
        now: new Date().toISOString(),
      });
    } else {
      // 降序平台：增量靠 knownExternalIds、补全靠 sync_truncated 驱动 backfill 跳页，
      // last_sync_at 只用于换账号判定与增量标记 → 始终推进到当前时刻
      nextLastSyncAt = new Date().toISOString();
    }
    // sync_truncated：截断（仍有更早历史）置 1，否则（自然结束 / 补全一无所获）清 0
    const nextTruncated = truncated ? 1 : 0;
    // backfill_page：截断时记录本次拉到的最深页（下次续拉），自然结束/补全完成时清空
    const nextBackfillPage = truncated && reachedPage ? reachedPage : null;

    db.prepare(
      `INSERT INTO platform_accounts (user_id, platform, handle, last_sync_at, enabled, sync_truncated, backfill_page)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, platform, handle) DO UPDATE SET
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
    applyDirectScanNote(result);
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
