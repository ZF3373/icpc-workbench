import type { ContestInfo } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { fetchAllContests } from './index.ts';

/**
 * 赛事日历持久化缓存（SQLite + stale-while-revalidate）。
 *
 * 背景：各平台日历源（contests/*Contests.ts）只做进程内缓存，软件每次重启即空；
 * 而 GET /api/contests/participated 与 AI 对话的日历注入都要先拿到日历（给本地
 * 推导的比赛补赛名/时间窗）—— 不落库的话，重开软件后的第一次请求就要等 5 个
 * 平台源的网络拉取（单源超时 15s），「读库秒出」形同虚设（用户反馈：每次重新
 * 打开软件「我参加的」都要重新加载很久）。
 *
 * 日历是公开、慢变的聚合数据（用于归因历史比赛，分钟级陈旧没有影响），落库后：
 * - 新鲜（<60min）：直接用 —— 内存热时零开销，重启后从库表恢复，零网络；
 * - 过期：立即返回库内旧值，同时后台重拉更新（失败保留旧值，5 分钟退避）；
 * - 库里没有（首次使用）：阻塞拉取一次并落库，全挂降级 undefined（原行为）。
 *
 * 落库读取只在内存未热时发生：单行 JSON（数百 KB 级）解析亚毫秒，只在过期窗口
 * 内的请求上发生，刷新成功后即回到内存直读。
 */

/** 与各平台源适配器的进程内缓存同周期 */
const FRESH_MS = 60 * 60_000;
/** 后台刷新失败后的重试退避：期间继续用库内旧值，不逐请求重打外网 */
const RETRY_BACKOFF_MS = 5 * 60_000;

export interface CalendarCache {
  /**
   * 取赛事日历。`fetchAll` 仅供单测注入替身（连同库表一起换成内存库 +
   * 新建实例，即得一份完全隔离的缓存；routes 共用下方单例）。
   */
  load(db: Db, fetchAll?: typeof fetchAllContests): Promise<ContestInfo[] | undefined>;
}

export function createCalendarCache(): CalendarCache {
  let memory: { at: number; contests: ContestInfo[] } | null = null;
  let refreshing: Promise<void> | null = null;
  let lastAttemptAt = 0;

  function persist(contests: ContestInfo[], db: Db): void {
    memory = { at: Date.now(), contests };
    db.prepare(
      'INSERT INTO calendar_cache (id, fetched_at, contests) VALUES (1, ?, ?) ' +
        'ON CONFLICT (id) DO UPDATE SET fetched_at = excluded.fetched_at, contests = excluded.contests',
    ).run(new Date().toISOString(), JSON.stringify(contests));
  }

  /** 后台重拉（去重 + 退避）；结果写回内存与库表，失败静默（旧值仍在） */
  function kickRefresh(db: Db, fetchAll: typeof fetchAllContests): void {
    if (refreshing || Date.now() - lastAttemptAt < RETRY_BACKOFF_MS) return;
    lastAttemptAt = Date.now();
    refreshing = (async () => {
      try {
        const { contests } = await fetchAll();
        persist(contests, db);
      } catch {
        // 拉取失败：保留内存与库里的旧值，退避后由下一次读取重新触发
      }
    })().finally(() => {
      refreshing = null;
    });
  }

  return {
    async load(db, fetchAll = fetchAllContests) {
      if (memory && Date.now() - memory.at < FRESH_MS) return memory.contests;

      const row = db
        .prepare('SELECT fetched_at, contests FROM calendar_cache WHERE id = 1')
        .get() as { fetched_at: string; contests: string } | undefined;
      if (row) {
        let contests: ContestInfo[] | null = null;
        try {
          const parsed = JSON.parse(row.contests) as ContestInfo[];
          if (Array.isArray(parsed)) contests = parsed;
        } catch {
          // 库内数据损坏：当作没有缓存，走首次拉取
        }
        if (contests) {
          const at = Date.parse(row.fetched_at);
          if (Number.isFinite(at) && Date.now() - at < FRESH_MS) {
            memory = { at, contests };
            return contests;
          }
          kickRefresh(db, fetchAll);
          return contests;
        }
      }

      // 首次使用（库里没有任何日历）：阻塞拉取一次并落库；全挂降级 undefined。
      // 刚失败过（含后台刷新失败）则在退避期内直接返回，不逐请求重打外网
      if (Date.now() - lastAttemptAt < RETRY_BACKOFF_MS) return undefined;
      lastAttemptAt = Date.now();
      try {
        const { contests } = await fetchAll();
        persist(contests, db);
        return contests;
      } catch {
        return undefined;
      }
    },
  };
}

/** 进程级单例（routes/contests.ts、routes/ai.ts 共用，避免重复打外网） */
export const calendarCache = createCalendarCache();
