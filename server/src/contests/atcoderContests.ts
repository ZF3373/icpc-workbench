import type { ContestInfo, PlatformId } from '../../../shared/src/index.ts';

/**
 * AtCoder 赛事数据源（双路合并）：
 * - 未来排期：AtCoder 官方 contests 页 HTML 解析（无官方 JSON，页面表格结构稳定）
 * - 历史场次：kenkoooo 社区静态资源 contests.json（与本项目的 AtCoder 提交同步同源）
 * 两源公开无需登录；进程内缓存 30 分钟。
 */

interface KenkooooContest {
  id: string;
  start_epoch_second: number;
  duration_second: number;
  title: string;
  rate_change: string;
}

/** 按赛事 id 前缀归类：abc380 → ABC */
export function classifyAtcoderContest(id: string): string {
  const p = id.toLowerCase();
  if (p.startsWith('agc')) return 'AGC';
  if (p.startsWith('arc')) return 'ARC';
  if (p.startsWith('abc')) return 'ABC';
  if (p.startsWith('ahc')) return 'AHC';
  return '其他';
}

export function toAtcoderContest(id: string, title: string, startEpochSecond: number, durationSeconds: number): ContestInfo {
  return {
    id: `at-${id}`,
    platform: 'atcoder' as PlatformId,
    name: title,
    category: classifyAtcoderContest(id),
    startTimeIso: startEpochSecond > 0 ? new Date(startEpochSecond * 1000).toISOString() : null,
    durationMinutes: Math.round(durationSeconds / 60),
    phase: 'UNKNOWN',
    url: `https://atcoder.jp/contests/${id}`,
  };
}

async function fetchKenkooooHistory(fetchFn: typeof fetch): Promise<ContestInfo[]> {
  const res = await fetchFn('https://kenkoooo.com/atcoder/resources/contests.json', {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`kenkoooo API HTTP ${res.status}`);
  const body = (await res.json()) as KenkooooContest[];
  if (!Array.isArray(body)) throw new Error('kenkoooo 返回异常');
  // 剔除常驻练习（start_epoch_second=0）等无开始时间的条目
  return body
    .filter((c) => c.start_epoch_second > 0)
    .map((c) => toAtcoderContest(c.id, c.title, c.start_epoch_second, c.duration_second));
}

/**
 * 解析 AtCoder 官方 contests 页的 Upcoming Contests 表格。
 * 每行含 fixtime-full 开始时间（+0900 定区格式）、/contests/{id} 链接与 HH:MM 时长。
 */
export function parseUpcomingHtml(html: string): ContestInfo[] {
  const tableStart = html.indexOf('contest-table-upcoming');
  if (tableStart === -1) return [];
  const tableEnd = html.indexOf('</table>', tableStart);
  const table = html.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
  const rows = table.split('<tr').slice(1);
  const out: ContestInfo[] = [];
  for (const row of rows) {
    const timeMatch = row.match(/fixtime-full'>([^<]+)<\/time>/);
    const linkMatch = row.match(/href="\/contests\/([A-Za-z0-9_]+)">([^<]+)<\/a>/);
    if (!timeMatch || !linkMatch) continue;
    // "2026-08-30 21:00:00+0900" → 合法 ISO8601（空格换 T）
    const startIso = new Date(timeMatch[1].replace(' ', 'T')).toISOString();
    const durationMatch = row.match(/>(\d{1,4}):(\d{2})</);
    const durationMinutes = durationMatch ? Number(durationMatch[1]) * 60 + Number(durationMatch[2]) : 100;
    out.push(toAtcoderContest(linkMatch[1], linkMatch[2].trim(), Math.floor(new Date(startIso).getTime() / 1000), durationMinutes * 60));
  }
  return out;
}

async function fetchOfficialUpcoming(fetchFn: typeof fetch): Promise<ContestInfo[]> {
  const res = await fetchFn('https://atcoder.jp/contests/', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`AtCoder 官网 HTTP ${res.status}`);
  return parseUpcomingHtml(await res.text());
}

let cache: { at: number; contests: ContestInfo[] } | null = null;
const CACHE_MS = 30 * 60 * 1000;

export async function fetchAtcoderContests(fetchFn: typeof fetch = fetch): Promise<ContestInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.contests;
  const [history, upcoming] = await Promise.allSettled([
    fetchKenkooooHistory(fetchFn),
    fetchOfficialUpcoming(fetchFn),
  ]);
  const parts = results(upcoming, history);
  if (parts.length === 0) {
    throw new Error(
      [history, upcoming]
        .filter((r) => r.status === 'rejected')
        .map((r) => (r.reason as Error)?.message ?? String(r.reason))
        .join('；'),
    );
  }
  const seen = new Set<string>();
  const contests: ContestInfo[] = [];
  for (const c of parts.flat()) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    contests.push(c);
  }
  cache = { at: Date.now(), contests };
  return contests;
}

function results(
  ...settled: Array<PromiseSettledResult<ContestInfo[]>>
): ContestInfo[][] {
  return settled.filter((r): r is PromiseFulfilledResult<ContestInfo[]> => r.status === 'fulfilled').map((r) => r.value);
}
