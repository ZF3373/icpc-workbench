import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';

/**
 * 牛客赛事数据源：ac.nowcoder.com 比赛列表页（匿名可访问，无需登录）。
 * 页面为服务端渲染，每场比赛的完整信息在条目节点的 data-json 属性里
 * （HTML 双重转义：&amp;quot; → &quot; → "），解析后含
 * contestId / contestName / contestStartTime / contestEndTime（epoch 毫秒）。
 * 页面固定返回即将开始 + 近期结束约十几场，进程内缓存 30 分钟；
 * 页面结构变化时由聚合器降级跳过，不影响其他平台。
 */

interface NcContestItem {
  contestId: number;
  contestName: string;
  contestStartTime: number;
  contestEndTime: number;
  settingInfo?: { organizerName?: string };
}

/** 按赛事名归类（周赛 / 小白月赛 / 挑战赛 / 练习赛 / 月赛 / ICPC / 校赛 …） */
export function classifyNowcoderContest(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('小白月赛')) return '小白月赛';
  if (n.includes('周赛')) return '周赛';
  if (n.includes('挑战赛')) return '挑战赛';
  if (n.includes('练习赛')) return '练习赛';
  if (n.includes('月赛')) return '月赛';
  if (n.includes('icpc') || n.includes('ccpc')) return 'ICPC';
  if (n.includes('校赛') || n.includes('校赛重现')) return '校赛';
  if (n.includes('训练') || n.includes('模拟')) return '训练';
  return '比赛';
}

/** data-json 为双重 HTML 转义（&amp;quot;），两轮实体解码后 JSON.parse */
export function parseContestListHtml(html: string): NcContestItem[] {
  const out: NcContestItem[] = [];
  for (const m of html.matchAll(/data-json="([^"]*)"/g)) {
    let raw = m[1];
    for (let i = 0; i < 2; i += 1) {
      raw = raw
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    }
    try {
      const item = JSON.parse(raw) as NcContestItem;
      if (item && typeof item.contestId === 'number' && typeof item.contestName === 'string') {
        out.push(item);
      }
    } catch {
      // 单条解析失败跳过，不影响其余条目
    }
  }
  return out;
}

export function toNowcoderContest(c: NcContestItem): ContestInfo {
  return {
    id: `nc-${c.contestId}`,
    platform: 'nowcoder' as PlatformId,
    name: c.contestName,
    category: classifyNowcoderContest(c.contestName),
    startTimeIso: c.contestStartTime > 0 ? new Date(c.contestStartTime).toISOString() : null,
    durationMinutes: Math.max(0, Math.round((c.contestEndTime - c.contestStartTime) / 60_000)),
    phase: 'UNKNOWN',
    url: `https://ac.nowcoder.com/acm/contest/${c.contestId}`,
  };
}

let cache: { at: number; contests: ContestInfo[] } | null = null;
const CACHE_MS = 30 * 60 * 1000;

export async function fetchNowcoderContests(fetchFn: typeof fetch = fetch): Promise<ContestInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.contests;
  const res = await fetchFn('https://ac.nowcoder.com/acm/contest/vip-index', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://ac.nowcoder.com/acm/home',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`牛客赛事页面 HTTP ${res.status}`);
  const items = parseContestListHtml(await res.text());
  // 一条都解析不到：页面结构变化/触发风控 → 明确失败而非"成功 0 条"假成功
  if (items.length === 0) {
    throw new Error('牛客赛事页面未解析到比赛条目（可能页面结构变化或触发风控）');
  }
  const seen = new Set<number>();
  const contests: ContestInfo[] = [];
  for (const item of items) {
    if (seen.has(item.contestId)) continue;
    seen.add(item.contestId);
    contests.push(toNowcoderContest(item));
  }
  cache = { at: Date.now(), contests };
  return contests;
}
