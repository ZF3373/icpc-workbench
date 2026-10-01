import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';
import { parseJisuankeTime } from '../adapters/jisuanke.ts';

/**
 * 计蒜客赛事数据源：公开 /api/contests 接口（匿名可访问）。
 * 仅取前两页（未来排期 + 近期结束），进程内缓存 60 分钟。
 * 接口结构可能随平台变更；失败时由聚合器降级跳过，不影响其他平台。
 */

const BASE = 'https://www.jisuanke.com';
const PAGES = 2;
const PAGE_DELAY_MS = 300;

interface JisuankeContestItem {
  contestId?: number;
  title?: string;
  /** 实测为 "2026-09-05 10:00:00"（北京时间）字符串；防御性兼容 unix 秒 */
  startTime?: string | number;
  /** 实测单位为秒（前端按 /3600 展示小时）；防御性兼容毫秒 */
  duration?: number;
  /** 赛制（IOI / ICPC …） */
  rule?: string;
  /** 赛事类型标签（如「计蒜客新手赛」） */
  type?: string;
}

/** 按赛事名/类型归类，作展示分类 */
export function classifyJisuankeContest(title: string, type?: string, rule?: string): string {
  if (type && type.trim()) return type.trim();
  const n = title.toLowerCase();
  if (n.includes('新手')) return '新手赛';
  if (n.includes('模拟') || n.includes('训练')) return '训练赛';
  if (n.includes('icpc') || n.includes('acm')) return 'ICPC';
  return rule?.trim() || '比赛';
}

/** 单条赛事 → 统一结构（导出供单测） */
export function toJisuankeContest(c: JisuankeContestItem): ContestInfo | null {
  if (typeof c.contestId !== 'number' || !Number.isFinite(c.contestId)) return null;
  // startTime：字符串按北京时间解析；数字按 unix 秒（>1e12 视为毫秒）
  let startMs = 0;
  if (typeof c.startTime === 'number') {
    startMs = c.startTime > 1e12 ? c.startTime : c.startTime * 1000;
  } else {
    startMs = parseJisuankeTime(c.startTime);
  }
  // duration 实测为秒；>1e7 才可能是毫秒（秒制下 1e7 = 115 天，真实赛事不可能这么长；
  // 旧阈值 1e5 只有 27.8 小时，多日训练赛的合法秒值 172800 会被错除以 1000 缩成 3 分钟）
  let durationSeconds = typeof c.duration === 'number' ? c.duration : 0;
  if (durationSeconds > 1e7) durationSeconds = Math.round(durationSeconds / 1000);
  return {
    id: `jsk-${c.contestId}`,
    platform: 'jisuanke' as PlatformId,
    name: c.title?.trim() || `计蒜客比赛 #${c.contestId}`,
    category: classifyJisuankeContest(c.title ?? '', c.type, c.rule),
    startTimeIso: startMs > 0 ? new Date(startMs).toISOString() : null,
    durationMinutes: Math.max(0, Math.round(durationSeconds / 60)),
    phase: 'UNKNOWN',
    url: `${BASE}/contest/${c.contestId}`,
  };
}

let cache: { at: number; contests: ContestInfo[] } | null = null;
const CACHE_MS = 60 * 60 * 1000;

export async function fetchJisuankeContests(fetchFn: typeof fetch = fetch): Promise<ContestInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.contests;
  const pages: JisuankeContestItem[][] = [];
  for (let page = 1; page <= PAGES; page += 1) {
    const res = await fetchFn(`${BASE}/api/contests?page=${page}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: `${BASE}/contests`,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`计蒜客赛事接口 HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as unknown;
    if (body === null) throw new Error('计蒜客赛事接口返回非 JSON（接口变化）');
    // 防御性解包：数组 / { contests } / { data: { contests } } / { past: { contests } }
    const o = body as { contests?: unknown; data?: { contests?: unknown }; past?: { contests?: unknown } };
    const rows =
      (Array.isArray(body) ? body : null) ??
      (Array.isArray(o.contests) ? o.contests : null) ??
      (Array.isArray(o.data?.contests) ? o.data?.contests : null) ??
      (Array.isArray(o.past?.contests) ? o.past?.contests : null) ??
      [];
    pages.push(rows as JisuankeContestItem[]);
    if (page < PAGES) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }
  const seen = new Set<number>();
  const contests: ContestInfo[] = [];
  for (const page of pages) {
    for (const item of page) {
      if (typeof item?.contestId === 'number' && seen.has(item.contestId)) continue;
      if (typeof item?.contestId === 'number') seen.add(item.contestId);
      const c = toJisuankeContest(item);
      if (c) contests.push(c);
    }
  }
  cache = { at: Date.now(), contests };
  return contests;
}
