import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';

/**
 * DashOJ 赛事数据源（dashoj.com，Hydro OJ；匿名可访问，无需登录）。
 * GET /contest?page={n} + `Accept: application/json` 走 Hydro 原生 JSON 内容协商，返回
 * `{ page, tpcount, tdocs: [{_id, docId, title, beginAt, endAt, attend, rule}] }`
 *（2026-10-22 实测：beginAt/endAt 为 ISO8601 UTC，docId 为比赛 ObjectId，/contest/{docId} 可访问）。
 *
 * Hydro 比赛列表默认返回即将开始 + 近期结束的场次；进程内缓存 60 分钟。
 * 页面结构变化 / 触发风控时由聚合器（contests/index.ts）降级跳过，不影响其他平台。
 */

interface DashojTdoc {
  _id?: string;
  docId?: string;
  title?: string;
  beginAt?: string;
  endAt?: string;
}

/** 按赛事名归类（蓝桥杯 / 赏金周赛 / 周赛 / 模拟赛 / 比赛） */
export function classifyDashojContest(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('蓝桥杯') || n.includes('lqb')) return '蓝桥杯';
  if (n.includes('赏金')) return '赏金周赛';
  if (n.includes('周赛')) return '周赛';
  if (n.includes('模拟') || n.includes('押题')) return '模拟赛';
  if (n.includes('月赛')) return '月赛';
  return '比赛';
}

/** tdoc → ContestInfo；beginAt 缺失（时间待定）时 startTimeIso 为 null，不参与日程排序 */
export function toDashojContest(t: DashojTdoc): ContestInfo | null {
  const id = t.docId ?? t._id;
  if (!id) return null;
  const begin = t.beginAt ? Date.parse(t.beginAt) : NaN;
  const end = t.endAt ? Date.parse(t.endAt) : NaN;
  const durationMinutes =
    Number.isFinite(begin) && Number.isFinite(end) && end > begin
      ? Math.round((end - begin) / 60_000)
      : 0;
  return {
    id: `dashoj-${id}`,
    platform: 'dashoj' as PlatformId,
    name: (t.title ?? '').trim() || `DashOJ 比赛 ${id}`,
    category: classifyDashojContest(t.title ?? ''),
    startTimeIso: Number.isFinite(begin) ? new Date(begin).toISOString() : null,
    durationMinutes,
    phase: 'UNKNOWN', // 阶段由聚合器按开始时间 + 时长统一推导（见 contestPhase）
    url: `https://dashoj.com/contest/${id}`,
  };
}

let cache: { at: number; contests: ContestInfo[] } | null = null;
const CACHE_MS = 60 * 60 * 1000;

export async function fetchDashojContests(fetchFn: typeof fetch = fetch, force = false): Promise<ContestInfo[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.contests;
  const res = await fetchFn('https://dashoj.com/contest?page=1', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
      Referer: 'https://dashoj.com/contest',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`DashOJ 赛事接口 HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { tdocs?: DashojTdoc[] } | null;
  if (body === null) throw new Error('DashOJ 赛事接口返回非 JSON（接口变化）');
  const tdocs = Array.isArray(body.tdocs) ? body.tdocs : [];
  const seen = new Set<string>();
  const contests: ContestInfo[] = [];
  for (const t of tdocs) {
    const c = toDashojContest(t);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    contests.push(c);
  }
  cache = { at: Date.now(), contests };
  return contests;
}
