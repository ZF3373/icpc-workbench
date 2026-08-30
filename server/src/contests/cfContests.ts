import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';

/**
 * Codeforces 赛事数据源：官方公开 API contest.list（无需登录）。
 * 进程内缓存 30 分钟，避免频繁打官方接口。
 */

interface CfApiContest {
  id: number;
  name: string;
  type: string;
  phase: string;
  frozen: boolean;
  durationSeconds: number;
  startTimeSeconds?: number;
  relativeTimeSeconds?: number;
}

/** 按赛事名归类（展示文案，前端直接上 Tag） */
export function classifyContest(name: string): string {
  const n = name.toLowerCase();
  if (/educational/.test(n)) return 'Educational';
  if (/global/.test(n)) return 'Global';
  if (/icpc/.test(n) || /\(mirrors?(\s+[^)]*)?\)/.test(n)) return 'ICPC';
  if (/div\.\s*1[^0-9]|div\.\s*1$/.test(n)) return 'Div. 1';
  if (/div\.\s*2[^0-9]|div\.\s*2$/.test(n)) return 'Div. 2';
  if (/div\.\s*3[^0-9]|div\.\s*3$/.test(n)) return 'Div. 3';
  if (/div\.\s*4[^0-9]|div\.\s*4$/.test(n)) return 'Div. 4';
  return '其他';
}

function toInfo(c: CfApiContest): ContestInfo {
  return {
    id: `cf-${c.id}`,
    platform: 'codeforces' as PlatformId,
    name: c.name,
    category: classifyContest(c.name),
    startTimeIso: c.startTimeSeconds ? new Date(c.startTimeSeconds * 1000).toISOString() : null,
    durationMinutes: Math.round(c.durationSeconds / 60),
    phase: c.phase,
    url: `https://codeforces.com/contests/${c.id}`,
  };
}

let cache: { at: number; contests: ContestInfo[] } | null = null;
const CACHE_MS = 30 * 60 * 1000;

export async function fetchCfContests(fetchFn: typeof fetch = fetch): Promise<ContestInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.contests;
  const res = await fetchFn('https://codeforces.com/api/contest.list', {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Codeforces API HTTP ${res.status}`);
  const body = (await res.json()) as { status: string; result?: CfApiContest[]; comment?: string };
  if (body.status !== 'OK' || !Array.isArray(body.result)) {
    throw new Error(body.comment ?? 'Codeforces API 返回异常');
  }
  const contests = body.result.map(toInfo);
  cache = { at: Date.now(), contests };
  return contests;
}

export function clearContestCache(): void {
  cache = null;
}
