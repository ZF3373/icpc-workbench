import { PLATFORMS, type ContestInfo, type PlatformId } from '../../../shared/src/index.ts';
import { fetchAtcoderContests } from './atcoderContests.ts';
import { fetchCfContests } from './cfContests.ts';
import { fetchJisuankeContests } from './jisuankeContests.ts';
import { fetchLuoguContests } from './luoguContests.ts';
import { fetchNowcoderContests } from './nowcoderContests.ts';
import { throttledFetch } from '../net/hostThrottle.ts';

/**
 * 多平台赛事聚合：Codeforces / AtCoder / 洛谷 / 牛客 / 计蒜客。
 * 单一数据源失败只降级跳过（记入 failures），全部失败才报错。
 */

export type ContestPhase = 'upcoming' | 'running' | 'finished';

/** 按开始时间 + 时长推导阶段（AtCoder / 洛谷数据源无 phase 字段，统一用时间推导） */
export function contestPhase(c: ContestInfo, now = Date.now()): ContestPhase | null {
  if (!c.startTimeIso) return null;
  const start = new Date(c.startTimeIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(c.durationMinutes) || c.durationMinutes < 0) return null;
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

export async function fetchAllContests(fetchFn: typeof fetch = throttledFetch, force = false): Promise<AllContests> {
  const results = await Promise.allSettled([
    fetchCfContests(fetchFn, force),
    fetchAtcoderContests(fetchFn, force),
    fetchLuoguContests(fetchFn, force),
    fetchNowcoderContests(fetchFn, force),
    fetchJisuankeContests(fetchFn, force),
  ]);
  const platforms: PlatformId[] = ['codeforces', 'atcoder', 'luogu', 'nowcoder', 'jisuanke'];
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
  offset?: number;
  query?: string;
  category?: string;
}

/** 先筛选排序再分页，搜索不能只在默认首屏的几十场中查找。 */
export function browseContests(all: ContestInfo[], filter: ContestFilter): { contests: ContestInfo[]; total: number; categories: string[] } {
  const now = Date.now();
  const limit = Number.isFinite(filter.limit) ? Math.min(100, Math.max(1, Math.floor(filter.limit!))) : 20;
  const offset = Number.isFinite(filter.offset) ? Math.max(0, Math.floor(filter.offset!)) : 0;
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase();
  const terms = normalize(filter.query ?? '').trim().split(/\s+/).filter(Boolean);
  const base = all
    .filter((c) => contestPhase(c, now) === filter.type)
    .filter((c) => !filter.platform || c.platform === filter.platform);
  const categories = [...new Set(base.map(c => c.category))].sort((a, b) => a.localeCompare(b));
  const matching = base
    .filter(c => !filter.category || c.category === filter.category)
    .filter(c => {
      const text = normalize([c.name, c.id, c.platform, PLATFORMS.find(p => p.id === c.platform)?.name, c.category].join(' '));
      return terms.every(term => text.includes(term));
    })
    .sort((a, b) => {
      if (filter.type === 'upcoming') {
        return new Date(a.startTimeIso!).getTime() - new Date(b.startTimeIso!).getTime();
      }
      const endA = new Date(a.startTimeIso!).getTime() + a.durationMinutes * 60_000;
      const endB = new Date(b.startTimeIso!).getTime() + b.durationMinutes * 60_000;
      return filter.type === 'running' ? endA - endB : endB - endA;
    });
  return { contests: matching.slice(offset, offset + limit), total: matching.length, categories };
}

export function selectContests(all: ContestInfo[], filter: ContestFilter): ContestInfo[] {
  return browseContests(all, filter).contests;
}
