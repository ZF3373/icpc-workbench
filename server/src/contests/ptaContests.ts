import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';

/**
 * PTA 赛事数据源（pintia.cn，拼题 A）。
 *
 * 数据来自公开的 XCPC 赛事列表 `GET /api/competitions/public?page=&limit=`（匿名 200）：
 * `{ total, competitions: [{ id, name, startAt, endAt, type, publicRanking, ... }] }`，
 * startAt / endAt 是 ISO8601 UTC（2026-11 实测 46 场，全部 type=XCPC、均含完整起止时间）。
 *
 * 口径说明：
 * - 这里只取**公开赛事**（站点自己公开的网络赛/省赛榜单）。站点不公开未开放的内部赛，
 *   因此列表里通常没有「即将开始」的场次 —— 这是数据源的边界，不做猜测性补齐。
 * - 赛事详情接口 `/api/competitions/{id}` 需要登录，故这里不拉详情：列表字段已足够
 *   推导阶段（开始时间 + 时长），也避免为每一场都多打一次请求。
 * - 拉取失败由聚合器（contests/index.ts）降级跳过，不影响其他平台。
 */

interface PtaCompetition {
  id?: string;
  name?: string;
  startAt?: string;
  endAt?: string;
  type?: string;
}

/**
 * 赛事名 → 分类标签（网络预选赛 / 总决赛 / 省赛 / 邀请赛 / 比赛）。
 *
 * 顺序即优先级：先认「网络预选」（ICPC/CCPC 网络赛历来自成一体），再认总决赛，
 * 最后才是泛化的「省/市/自治区 + 程序设计大赛(竞赛)」——站点上的省份赛事名字写法很杂
 * （「重庆市第十四届大学生程序设计大赛」「“绿盟杯”内蒙古自治区第十九届大学生程序设计竞赛」），
 * 故两类关键词都要认。
 */
export function classifyPtaContest(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('网络预选') || n.includes('网络赛')) return '网络预选赛';
  if (n.includes('总决赛') || n.includes('全国')) return '总决赛';
  if (
    n.includes('省赛') || n.includes('自治区') || n.includes('市赛') ||
    n.includes('大学生程序设计竞赛') || n.includes('大学生程序设计大赛')
  ) {
    return '省赛';
  }
  if (n.includes('邀请赛') || n.includes('校赛')) return '邀请赛';
  return '比赛';
}

/** competition → ContestInfo；起止时间任一缺失/非法即返回 null（不参与日程排序） */
export function toPtaContest(c: PtaCompetition): ContestInfo | null {
  const id = String(c.id ?? '').trim();
  if (!id) return null;
  const begin = c.startAt ? Date.parse(c.startAt) : NaN;
  const end = c.endAt ? Date.parse(c.endAt) : NaN;
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) return null;
  const name = (c.name ?? '').trim();
  return {
    id: `pta-${id}`,
    platform: 'pta' as PlatformId,
    name: name || `PTA 比赛 ${id}`,
    category: classifyPtaContest(name),
    startTimeIso: new Date(begin).toISOString(),
    durationMinutes: Math.round((end - begin) / 60_000),
    phase: 'UNKNOWN', // 阶段由聚合器按开始时间 + 时长统一推导（见 contestPhase）
    url: `https://pintia.cn/competitions/${id}`,
  };
}

let cache: { at: number; contests: ContestInfo[] } | null = null;
const CACHE_MS = 60 * 60 * 1000;
/** 站点单页实测最多返回 46 条；取 100 留出余量，超过则按下一页继续翻 */
const PAGE_LIMIT = 100;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function fetchPtaContests(fetchFn: typeof fetch = fetch, force = false): Promise<ContestInfo[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.contests;
  const contests: ContestInfo[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 3; page += 1) {
    const res = await fetchFn(
      `https://pintia.cn/api/competitions/public?page=${page}&limit=${PAGE_LIMIT}`,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json;charset=UTF-8',
          Referer: 'https://pintia.cn/',
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`PTA 赛事接口 HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { competitions?: PtaCompetition[]; total?: number } | null;
    if (body === null) throw new Error('PTA 赛事接口返回非 JSON（接口变化）');
    const list = Array.isArray(body.competitions) ? body.competitions : [];
    if (list.length === 0) break;
    for (const raw of list) {
      const c = toPtaContest(raw);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      contests.push(c);
    }
    if (typeof body.total === 'number' && contests.length >= body.total) break;
    if (list.length < PAGE_LIMIT) break;
  }
  cache = { at: Date.now(), contests };
  return contests;
}
