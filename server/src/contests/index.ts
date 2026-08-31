import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';
import { fetchAtcoderContests } from './atcoderContests.ts';
import { fetchCfContests } from './cfContests.ts';
import { fetchLuoguContests } from './luoguContests.ts';
import { fetchNowcoderContests } from './nowcoderContests.ts';

/**
 * 多平台赛事聚合：Codeforces / AtCoder / 洛谷 / 牛客。
 * 单一数据源失败只降级跳过（记入 failures），全部失败才报错。
 */

export type ContestPhase = 'upcoming' | 'running' | 'finished';

/** 按开始时间 + 时长推导阶段（AtCoder / 洛谷数据源无 phase 字段，统一用时间推导） */
export function contestPhase(c: ContestInfo, now = Date.now()): ContestPhase | null {
  if (!c.startTimeIso) return null;
  const start = new Date(c.startTimeIso).getTime();
  const end = start + c.durationMinutes * 60_000;
  if (now < start) return 'upcoming';
  if (now < end) return 'running';
  return 'finished';
}

export interface AllContests {
  contests: ContestInfo[];
  /** 拉取失败的平台 → 错误信息（其余平台正常返回时仅降级提示） */
  failures: Partial<Record<PlatformId, string>>;
}

export async function fetchAllContests(fetchFn: typeof fetch = fetch): Promise<AllContests> {
  const results = await Promise.allSettled([
    fetchCfContests(fetchFn),
    fetchAtcoderContests(fetchFn),
    fetchLuoguContests(fetchFn),
    fetchNowcoderContests(fetchFn),
  ]);
  const platforms: PlatformId[] = ['codeforces', 'atcoder', 'luogu', 'nowcoder'];
  const contests: ContestInfo[] = [];
  const failures: AllContests['failures'] = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') contests.push(...r.value);
    else failures[platforms[i]] = (r.reason as Error)?.message ?? String(r.reason);
  });
  if (contests.length === 0) {
    throw new Error(
      Object.entries(failures)
        .map(([p, m]) => `${p}: ${m}`)
        .join('；') || '全部赛事数据源拉取失败',
    );
  }
  return { contests, failures };
}

export interface ContestFilter {
  type: ContestPhase;
  platform?: PlatformId;
  limit?: number;
}

/** 筛选 + 排序：即将开始按时间升序；已结束按结束时间降序 */
export function selectContests(all: ContestInfo[], filter: ContestFilter): ContestInfo[] {
  const now = Date.now();
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
  return all
    .filter((c) => contestPhase(c, now) === filter.type)
    .filter((c) => !filter.platform || c.platform === filter.platform)
    .sort((a, b) => {
      if (filter.type === 'upcoming') {
        return new Date(a.startTimeIso!).getTime() - new Date(b.startTimeIso!).getTime();
      }
      const endA = new Date(a.startTimeIso!).getTime() + a.durationMinutes * 60_000;
      const endB = new Date(b.startTimeIso!).getTime() + b.durationMinutes * 60_000;
      return endB - endA;
    })
    .slice(0, limit);
}
