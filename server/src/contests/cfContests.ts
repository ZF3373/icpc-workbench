import { createHash } from 'node:crypto';
import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';

/**
 * Codeforces 赛事数据源：官方公开 API contest.list。
 * - 公开榜：contest.list 匿名即可。
 * - 小组赛：contest.list?group=<code> 必须 apiKey+apiSig 认证（Key 主人须为该小组成员）；
 *   匿名调用 group 参数被静默忽略、返回公开榜（不能用作小组数据源）。
 * - 公开榜与各小组独立缓存 30 分钟，单源失败降级跳过，全部失败才报错。
 */

export interface CfApiAuth {
  apiKey: string;
  secret: string;
}

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

/** 小组赛固定「小组」分类，id 加 cfg- 前缀避免与公开赛撞号 */
function toGroupInfo(c: CfApiContest, groupCode: string): ContestInfo {
  return {
    id: `cfg-${groupCode}-${c.id}`,
    platform: 'codeforces' as PlatformId,
    name: c.name,
    category: '小组',
    startTimeIso: c.startTimeSeconds ? new Date(c.startTimeSeconds * 1000).toISOString() : null,
    durationMinutes: Math.round(c.durationSeconds / 60),
    phase: c.phase,
    url: `https://codeforces.com/group/${groupCode}/contest/${c.id}`,
  };
}

async function fetchList(
  fetchFn: typeof fetch,
  url: string,
  map: (c: CfApiContest) => ContestInfo,
): Promise<ContestInfo[]> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Codeforces API HTTP ${res.status}`);
  const body = (await res.json()) as { status: string; result?: CfApiContest[]; comment?: string };
  if (body.status !== 'OK' || !Array.isArray(body.result)) {
    throw new Error(body.comment ?? 'Codeforces API 返回异常');
  }
  return body.result.map(map);
}

interface CacheEntry {
  at: number;
  contests: ContestInfo[];
}
const CACHE_MS = 30 * 60 * 1000;
let publicCache: CacheEntry | null = null;
const groupCaches = new Map<string, CacheEntry>();

async function fetchPublicContests(fetchFn: typeof fetch): Promise<ContestInfo[]> {
  if (publicCache && Date.now() - publicCache.at < CACHE_MS) return publicCache.contests;
  const contests = await fetchList(fetchFn, 'https://codeforces.com/api/contest.list', toInfo);
  publicCache = { at: Date.now(), contests };
  return contests;
}

export async function fetchGroupContests(
  fetchFn: typeof fetch,
  groupCode: string,
  auth?: CfApiAuth,
): Promise<ContestInfo[]> {
  const cached = groupCaches.get(groupCode);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.contests;
  if (!auth?.apiKey || !auth.secret) {
    // 匿名 group= 返回公开榜（会被当成小组赛误展示），宁可不拉；
    // 每组只提示一次，避免每次刷新都刷日志。
    if (!warnedNoAuth.has(groupCode)) {
      warnedNoAuth.add(groupCode);
      console.warn(
        `[contests] CF 小组 ${groupCode} 未配置 Codeforces API Key，跳过（设置页可配置，codeforces.com/settings/api 生成）`,
      );
    }
    return [];
  }
  const url = signedContestListUrl(groupCode, auth);
  const contests = await fetchList(fetchFn, url, (c) => toGroupInfo(c, groupCode));
  groupCaches.set(groupCode, { at: Date.now(), contests });
  return contests;
}

const warnedNoAuth = new Set<string>();

/** contest.list 认证请求：apiSig = sha512("contest.list?<按参数名排序的 k=v&…>#<secret>") */
export function signedContestListUrl(groupCode: string, auth: CfApiAuth): string {
  const params = new URLSearchParams({
    group: groupCode,
    apiKey: auth.apiKey,
    time: String(Math.floor(Date.now() / 1000)),
  });
  const pairs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`);
  const toSign = `contest.list?${pairs.join('&')}#${auth.secret}`;
  const apiSig = createHash('sha512').update(toSign).digest('hex');
  return `https://codeforces.com/api/contest.list?${pairs.join('&')}&apiSig=${apiSig}`;
}

/** 公开榜 + 各小组赛聚合；单源失败降级跳过（仅全空时报最后一个错） */
export async function fetchCfContests(
  fetchFn: typeof fetch = fetch,
  groupCodes: string[] = [],
  auth?: CfApiAuth,
): Promise<ContestInfo[]> {
  const results = await Promise.allSettled([
    fetchPublicContests(fetchFn),
    ...groupCodes.map((code) => fetchGroupContests(fetchFn, code, auth)),
  ]);
  const contests: ContestInfo[] = [];
  let lastError: unknown;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') contests.push(...r.value);
    else {
      lastError = r.reason;
      const source = i === 0 ? '公开榜' : `小组 ${groupCodes[i - 1]}`;
      console.warn(`[contests] Codeforces ${source}拉取失败: ${(r.reason as Error)?.message ?? r.reason}`);
    }
  });
  if (contests.length === 0 && results.length > 0) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'CF 赛事拉取失败'));
  }
  return contests;
}

export function clearContestCache(): void {
  publicCache = null;
  groupCaches.clear();
}
