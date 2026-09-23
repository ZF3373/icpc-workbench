/**
 * 进行中的同步进度（进程内内存，不落库、重启即空）。
 *
 * 背景：单次同步现在按平台节奏限速（几十秒到几分钟），而 `POST /api/sync/:platform`
 * 是一发到底的长请求、中途没有任何响应。前端需要真实证据证明「它还在动」，
 * 否则用户会以为卡住而关掉应用。
 *
 * 数据来源刻意只用**已经发生的真实请求**：
 * - 起止/阶段/模式由同步层登记（见 adapters/sync.ts）；
 * - 「该站点请求数 + 最后一次请求距今」取自节流层（net/hostThrottle.ts）的按域名累计，
 *   调用时取窗口差值。
 * 适配器内部的页数/条数知识不下放到这里，因此**不产出百分比**——宁可不给进度，
 * 也不给一个会骗人的假进度。
 *
 * 与 `sync_runs` 的分工：sync_runs 是结束后的历史（同步中心）；这里只描述「此刻在跑什么」。
 */
import type {
  PlatformId,
  SyncProgressBatch,
  SyncProgressBatchItem,
  SyncProgressJob,
  SyncProgressSnapshot,
  SyncRun,
} from '../../../shared/src/index.ts';
import { hostThrottle } from '../net/hostThrottle.ts';

/**
 * 平台 → 用于统计请求数的站点（与该平台提交/题库请求的主域名一致，
 * 键名与 net/hostThrottle.ts 的 HOST_MIN_INTERVAL_MS 保持一致）。
 * AtCoder 取 kenkoooo.com：提交同步与题库拉取都打 kenkoooo 的 AtCoderProblems API，
 * atcoder.jp 只出现在题目链接里 —— 记成 atcoder.jp 会让这条同步的「请求数 / 心跳」永远是 0。
 */
const PLATFORM_HOST: Record<PlatformId, string> = {
  codeforces: 'codeforces.com',
  atcoder: 'kenkoooo.com',
  luogu: 'www.luogu.com.cn',
  nowcoder: 'ac.nowcoder.com',
  qoj: 'qoj.ac',
  leetcode: 'leetcode.cn',
  daimayuan: 'bs.daimayuan.top',
  jisuanke: 'www.jisuanke.com',
};

/** 已登记的一次同步（含起算基线，快照时才换算成对外可读字段） */
interface JobState {
  platform: PlatformId;
  handle: string;
  mode: SyncRun['mode'];
  days?: number;
  maxSubmissions?: number;
  phase: 'fetching' | 'saving';
  startedAtMs: number;
  /** 起始时刻该站点的累计请求数（窗口基线） */
  baseRequests: number;
}

interface BatchState {
  platforms: PlatformId[];
  current: PlatformId | null;
  completed: SyncProgressBatchItem[];
  startedAtMs: number;
  /** 整批结束时刻；null = 仍在进行 */
  finishedAtMs: number | null;
}

/**
 * 已结束批次在快照里保留多久：让前端能看到「已完成 N/M」的收尾状态。
 * 结束后**不能**立刻清空——最后一步「某平台完成」与「批次清空」发生在同一刻，
 * 轮询永远抓不到收尾状态。超过该时长后服务端自行丢弃，避免快照长期报旧数据。
 */
const BATCH_KEEP_MS = 5 * 60 * 1000;

export interface SyncProgressDeps {
  /** 注入时钟（测试用），缺省 Date.now */
  now?: () => number;
  /** 注入节流统计（测试用），缺省读生产节流单例 */
  statsOf?: (host: string) => { requests: number; lastRequestAt: number };
}

const jobs = new Map<PlatformId, JobState>();
let batch: BatchState | null = null;
let now: () => number = () => Date.now();
let statsOf: (host: string) => { requests: number; lastRequestAt: number } = (host) =>
  hostThrottle.stats(host);

/** 装配/测试注入（与 syncScheduler 的 configure 风格一致） */
export function configureSyncProgress(deps: SyncProgressDeps = {}): void {
  now = deps.now ?? (() => Date.now());
  statsOf = deps.statsOf ?? ((host) => hostThrottle.stats(host));
}

/** 开始一次同步（在 mode 算出之后、真正打上游之前调用） */
export function beginSync(input: {
  platform: PlatformId;
  handle: string;
  mode: SyncRun['mode'];
  days?: number;
  maxSubmissions?: number;
}): void {
  const host = PLATFORM_HOST[input.platform];
  jobs.set(input.platform, {
    platform: input.platform,
    handle: input.handle,
    mode: input.mode,
    ...(input.days !== undefined ? { days: input.days } : {}),
    ...(input.maxSubmissions !== undefined ? { maxSubmissions: input.maxSubmissions } : {}),
    phase: 'fetching',
    startedAtMs: now(),
    baseRequests: statsOf(host).requests,
  });
  // 属于当前批量的平台 → 标为「进行中」（批量进度里的 current）
  if (batch && batch.platforms.includes(input.platform)) batch.current = input.platform;
}

/** 阶段切换：拉取完成、开始写库（批量写入对 CF 这类整页拉取很快，但逐题平台会明显） */
export function setSyncPhase(platform: PlatformId, phase: JobState['phase']): void {
  const job = jobs.get(platform);
  if (job) job.phase = phase;
}

/**
 * 结束一次同步。**必须在 finally 里调用**（成功/失败/取消都要走到），
 * 否则前端会长期显示一个幽灵进度。
 */
export function endSync(platform: PlatformId): void {
  jobs.delete(platform);
  if (batch && batch.current === platform) batch.current = null;
}

/** 开始一键同步整批（routes/sync.ts 的 POST /all）；开始的瞬间丢弃上一批的残留。
 *  空列表（未绑定任何账号）不建批次——否则前端会显示一个 0/0 的幽灵进度。 */
export function beginBatch(platforms: PlatformId[]): void {
  if (platforms.length === 0) {
    batch = null;
    return;
  }
  batch = {
    platforms: [...platforms],
    current: null,
    completed: [],
    startedAtMs: now(),
    finishedAtMs: null,
  };
}

/** 批量里完成一个平台（成功或失败都登记，失败带首条错误原因） */
export function completeBatchItem(
  platform: PlatformId,
  item: { status: 'ok' | 'failed'; imported: number; error?: string },
): void {
  if (!batch) return;
  batch.completed.push({
    platform,
    status: item.status,
    imported: item.imported,
    ...(item.error !== undefined && item.error !== '' ? { error: item.error } : {}),
  });
  if (batch.current === platform) batch.current = null;
}

/** 整批结束（在 finally 里调用）：标记结束时刻而非立刻丢弃，供前端展示收尾状态 */
export function endBatch(): void {
  if (!batch) return;
  batch.current = null;
  batch.finishedAtMs = now();
}

/**
 * 进行中的这次同步已对本站点发出的请求数（该平台未在同步中时返回 null）。
 * 供同步结果文案使用，例如「补全检查：未发现更早历史，本次仅做检查，共发出 2 次请求」——
 * 让"没有新提交为什么还请求了"这件事在结果里就有解释。
 */
export function jobSiteRequests(platform: PlatformId): number | null {
  const job = jobs.get(platform);
  if (!job) return null;
  const stat = statsOf(PLATFORM_HOST[platform]);
  return Math.max(0, stat.requests - job.baseRequests);
}

/** 当前快照（生产：GET /api/sync/progress；无同步时 jobs 为空、batch 为 null） */export function snapshot(): SyncProgressSnapshot {
  const t = now();
  // 已结束的批次超期即丢弃（避免接口长期报旧数据；前端也会在展示一小段时间后自行隐藏）
  if (batch && batch.finishedAtMs !== null && t - batch.finishedAtMs > BATCH_KEEP_MS) batch = null;
  const out: SyncProgressJob[] = [];
  for (const job of jobs.values()) {
    const stat = statsOf(PLATFORM_HOST[job.platform]);
    const siteRequests = Math.max(0, stat.requests - job.baseRequests);
    out.push({
      platform: job.platform,
      handle: job.handle,
      mode: job.mode,
      ...(job.days !== undefined ? { days: job.days } : {}),
      ...(job.maxSubmissions !== undefined ? { maxSubmissions: job.maxSubmissions } : {}),
      phase: job.phase,
      startedAt: new Date(job.startedAtMs).toISOString(),
      elapsedMs: Math.max(0, t - job.startedAtMs),
      siteRequests,
      // 只有**本次窗口内**发过请求才算 liveness 证据：窗口前的历史请求不能让它看起来还在动
      lastRequestAgoMs:
        siteRequests > 0 && stat.lastRequestAt > 0 ? Math.max(0, t - stat.lastRequestAt) : null,
    });
  }
  return {
    // 同一时刻可能既有批量、又有别的来源的单平台同步：按平台名稳定排序，前端展示不跳动
    jobs: out.sort((a, b) => a.platform.localeCompare(b.platform)),
    batch: batch
      ? {
          platforms: [...batch.platforms],
          current: batch.current,
          completed: batch.completed.map((c) => ({ ...c })),
          startedAt: new Date(batch.startedAtMs).toISOString(),
          elapsedMs: Math.max(0, t - batch.startedAtMs),
          finishedAt: batch.finishedAtMs === null ? null : new Date(batch.finishedAtMs).toISOString(),
        }
      : null,
  };
}

/** 测试用：清空进度与注入的依赖 */
export function __resetSyncProgressForTest(): void {
  jobs.clear();
  batch = null;
  now = () => Date.now();
  statsOf = (host) => hostThrottle.stats(host);
}
