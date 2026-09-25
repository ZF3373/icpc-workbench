/**
 * 后台分批续拉：某平台同步因触及单次上限被截断（sync_truncated=1）时，
 * 按平台节奏在后台自动续拉下一批，直到补全或达到轮数上限。
 *
 * 设计取舍：
 * - 只服务于「用户点了一次同步」的会话：轮数上限默认 6（settings['sync.autoContinueRounds']，0=关闭）。
 * - 每平台独立间隔（保守取值，低于该值易触发平台风控）。
 * - 同平台串行：已有待执行或正在执行的续拉时，重复注册被忽略（返回既有状态，不叠加第二个定时器）。
 * - 进程内实现：服务重启后续拉计划丢失，但补全游标（backfill_page）已持久化，用户再点一次同步即续上。
 * - 任一轮失败（尤其鉴权/限流）→ 立即停止该平台续拉（避免把过期 Cookie 打成风控）。
 */
import type { SyncResult } from '../../../shared/src/index.ts';
import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { syncPlatform } from './sync.ts';

/**
 * 平台续拉间隔（毫秒）：本次整体翻倍（原 20s–90s → 40s–180s）。
 *
 * 理由：续拉是「用户点一次同步后自动连打」的路径，也是短时间请求密度最高的来源；
 * 单次上限下调（默认 300）后每轮请求量本就变小，把间隔拉开可进一步降低触发风控的概率。
 * 代价是补全历史的总时长变长——轮数上限也相应下调（见 DEFAULT_AUTO_CONTINUE_ROUNDS），
 * 用户可再次点击同步继续补。
 */
export const AUTO_CONTINUE_DELAY_MS: Record<PlatformId, number> = {
  codeforces: 40_000,
  atcoder: 120_000,
  luogu: 90_000,
  nowcoder: 180_000,
  jisuanke: 180_000,
  daimayuan: 120_000,
  leetcode: 120_000,
  qoj: 180_000,
};

/** 一次点击同步后最多自动续拉几轮（原 6）：更少的自动轮次 = 更低的短时请求密度 */
export const DEFAULT_AUTO_CONTINUE_ROUNDS = 3;

export interface AutoContinueState {
  platform: PlatformId;
  handle: string;
  round: number;
  maxRounds: number;
  nextAt: string;
  running: boolean;
}

export interface SchedulerDeps {
  db: Db;
  now: () => number;
  schedule: (fn: () => void, ms: number) => unknown;
  cancelTimer: (id: unknown) => void;
  run: (platform: PlatformId, handle: string) => Promise<SyncResult>;
}

let deps: SchedulerDeps | null = null;
const jobs = new Map<PlatformId, { state: AutoContinueState; timer: unknown }>();

/** 装配（服务启动调用一次）；测试传 partial 注入假时钟/假执行器 */
export function configureSyncScheduler(partial: Partial<SchedulerDeps>): void {
  const prev = deps;
  const database = partial.db ?? prev?.db;
  if (!database) throw new Error('syncScheduler 需要数据库：请先 configureSyncScheduler({ db })');
  deps = {
    db: database,
    now: partial.now ?? prev?.now ?? (() => Date.now()),
    schedule: partial.schedule ?? prev?.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
    cancelTimer: partial.cancelTimer ?? prev?.cancelTimer ?? ((id) => clearTimeout(id as NodeJS.Timeout)),
    run:
      partial.run ??
      prev?.run ??
      ((platform, handle) => syncPlatform(database, platform, handle, { triggeredBy: 'auto' })),
  };
}

/** 读取续拉轮数上限（0 = 关闭） */
export function getAutoContinueRounds(database: Db): number {
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get('sync.autoContinueRounds') as { value: string } | undefined;
  const n = Number(row?.value);
  if (!Number.isInteger(n) || n < 0 || n > 50) return DEFAULT_AUTO_CONTINUE_ROUNDS;
  return n;
}

export function listAutoContinue(): AutoContinueState[] {
  return [...jobs.values()].map((j) => j.state);
}

export function cancelAutoContinue(platform: PlatformId): boolean {
  const job = jobs.get(platform);
  if (!job) return false;
  deps?.cancelTimer(job.timer);
  jobs.delete(platform);
  return true;
}

/** 注册续拉；已在队列中返回既有状态，轮数上限为 0 或调度器未装配时返回 null */
export function scheduleAutoContinue(database: Db, platform: PlatformId, handle: string): AutoContinueState | null {
  const maxRounds = getAutoContinueRounds(database);
  if (maxRounds === 0) return null;
  // 未调用 configureSyncScheduler（脚本/测试直接调用 syncPlatform）时静默不排期，
  // 不能让「同步成功但没启动后台调度」变成同步失败
  if (!deps) return null;
  if (jobs.has(platform)) return jobs.get(platform)!.state;
  const delay = AUTO_CONTINUE_DELAY_MS[platform] ?? 60_000;
  const state: AutoContinueState = {
    platform,
    handle,
    round: 1,
    maxRounds,
    nextAt: new Date(deps.now() + delay).toISOString(),
    running: false,
  };
  const timer = deps.schedule(() => void runRound(platform), delay);
  jobs.set(platform, { state, timer });
  return state;
}

/**
 * 待执行的续拉所绑定的账号是否仍存在且启用（多账号 v0.8：按 (platform, handle) 校验）。
 *
 * 为什么必须每轮复查：job 在注册时捕获 handle，而用户随时可能在设置页解绑/停用该账号。
 * 若账号已被解绑（绑定行已删除）或停用后仍继续跑，syncPlatform 末尾的 upsert 会把
 * 绑定行原样建回来/置回启用——用户刚做的解绑被静默回滚。因此账号不存在或已停用时
 * 直接丢弃该任务：不跑同步、不写游标、不写 sync_runs。
 */
function handleStillBound(database: Db, platform: PlatformId, handle: string): boolean {
  const row = database
    .prepare('SELECT enabled FROM platform_accounts WHERE user_id = ? AND platform = ? AND handle = ?')
    .get(DEFAULT_USER_ID, platform, handle) as { enabled: number } | undefined;
  return row !== undefined && row.enabled === 1;
}

async function runRound(platform: PlatformId): Promise<void> {
  const job = jobs.get(platform);
  if (!job) return;
  // 每轮执行前复查账号绑定：改绑后旧 handle 的续拉作废
  if (!handleStillBound(deps!.db, platform, job.state.handle)) {
    jobs.delete(platform);
    return;
  }
  job.state.running = true;
  let result: SyncResult | null = null;
  try {
    result = await deps!.run(platform, job.state.handle);
  } catch {
    result = null;
  }
  // 执行期间任务可能已被取消（手动同步抢占 / __resetSyncSchedulerForTest）：不再排期
  if (jobs.get(platform) !== job) return;
  const failed = result === null || result.errors.length > 0;
  const truncated = result?.truncated === true;
  const round = job.state.round + 1;
  if (failed || !truncated || round > job.state.maxRounds) {
    jobs.delete(platform); // 失败（含鉴权/限流）、补全完成、轮次耗尽 → 停止该平台续拉
    return;
  }
  const delay = AUTO_CONTINUE_DELAY_MS[platform] ?? 60_000;
  job.state = {
    ...job.state,
    round,
    running: false,
    nextAt: new Date(deps!.now() + delay).toISOString(),
  };
  job.timer = deps!.schedule(() => void runRound(platform), delay);
}

/** 测试用：清空队列与依赖 */
export function __resetSyncSchedulerForTest(): void {
  for (const job of jobs.values()) deps?.cancelTimer(job.timer);
  jobs.clear();
  deps = null;
}
