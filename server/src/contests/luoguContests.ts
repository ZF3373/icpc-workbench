import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';
import { fetchWithChallenge } from '../adapters/luogu.ts';

/**
 * 洛谷赛事数据源：非官方 content-only 接口（匿名可访问，走 C3VK 反爬挑战流程）。
 * 仅取前两页（默认 40 条：未来排期 + 近期结束），进程内缓存 30 分钟。
 * 接口结构可能随平台变更；失败时由聚合器降级跳过，不影响其他平台。
 */

interface LuoguContestItem {
  id: number;
  startTime: number;
  endTime: number;
  name: string;
  rated?: number;
  host?: { name?: string };
  problemCount?: number;
}

/** 按赛事名归类（月赛 / 入门赛 / 重现赛 / Rated …） */
export function classifyLuoguContest(name: string, rated?: number): string {
  const n = name.toLowerCase();
  if (n.includes('月赛')) return '月赛';
  if (n.includes('入门')) return '入门赛';
  if (n.includes('icpc') || n.includes('重现')) return '重现赛';
  if (n.includes('训练营') || n.includes('练习')) return '训练';
  return rated ? 'Rated' : '比赛';
}

export function toLuoguContest(c: LuoguContestItem): ContestInfo {
  return {
    id: `lg-${c.id}`,
    platform: 'luogu' as PlatformId,
    name: c.name,
    category: classifyLuoguContest(c.name, c.rated),
    startTimeIso: c.startTime > 0 ? new Date(c.startTime * 1000).toISOString() : null,
    durationMinutes: Math.max(0, Math.round((c.endTime - c.startTime) / 60)),
    phase: 'UNKNOWN',
    url: `https://www.luogu.com.cn/contest/${c.id}`,
  };
}

let cache: { at: number; contests: ContestInfo[] } | null = null;
const CACHE_MS = 30 * 60 * 1000;
const PAGES = 2;

export async function fetchLuoguContests(fetchFn: typeof fetch = fetch): Promise<ContestInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.contests;
  const pages = await Promise.all(
    Array.from({ length: PAGES }, (_, i) =>
      fetchWithChallenge(
        fetchFn,
        `https://www.luogu.com.cn/contest/list?_contentOnly=1&page=${i + 1}`,
        '',
        undefined,
        { 'x-lentille-request': 'content-only' },
      ).then(async (res) => {
        if (!res.ok) throw new Error(`洛谷赛事接口 HTTP ${res.status}`);
        const body = (await res.json()) as {
          data?: { contests?: { result?: LuoguContestItem[] } };
        };
        return body.data?.contests?.result ?? [];
      }),
    ),
  );
  const seen = new Set<number>();
  const contests: ContestInfo[] = [];
  for (const page of pages) {
    for (const item of page) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      contests.push(toLuoguContest(item));
    }
  }
  cache = { at: Date.now(), contests };
  return contests;
}
