import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';

const API = 'https://ac.nowcoder.com';
const MAX_PAGES = 100; // 每页 10 条，最多 1000 条
const PAGE_SIZE = 10;

// 牛客提交结果（HTML 中文状态文本）→ 统一 Verdict；未知值落到 SKIPPED
const RESULT_MAP: Record<string, Verdict> = {
  答案正确: 'AC',
  答案错误: 'WA',
  格式错误: 'WA',
  运行超时: 'TLE',
  编译错误: 'CE',
  运行错误: 'RE',
  段错误: 'RE',
  内存超限: 'MLE',
  输出超限: 'RE',
  系统错误: 'SKIPPED',
  等待评测: 'SKIPPED',
  运行中: 'SKIPPED',
  未知错误: 'SKIPPED',
};

interface NcRow {
  submissionId: string;
  pid: string;
  title: string;
  result: string;
  language?: string;
  timeText: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const strip = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** 解析 practice-coding 页的提交表格（表头为 <th> 会被跳过） */
function parseRows(html: string): NcRow[] {
  const rows: NcRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length < 9) continue; // 表头为 <th> 不匹配；列数不足 9 视为异常行跳过
    const submissionId = (tds[0].match(/submissionId=(\d+)/) ?? [])[1] ?? strip(tds[0]);
    const pid = (tds[1].match(/\/acm\/problem\/(\d+)/) ?? [])[1];
    if (!submissionId || !pid) continue; // 异常行/页脚，跳过
    rows.push({
      submissionId,
      pid,
      title: strip(tds[1]),
      result: strip(tds[2]),
      language: strip(tds[7]) || undefined,
      timeText: strip(tds[8]),
    });
  }
  return rows;
}

/** 牛客页面时间为中国时区（无时区后缀）→ 按 UTC+8 解析 */
function parseTime(t: string): number {
  if (!t) return 0;
  const iso = `${t.replace(' ', 'T')}+08:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * 牛客适配器（公开 HTML 表格解析，无需登录）：
 * - 提交列表：GET /acm/contest/profile/{uid}/practice-coding?pageSize=10&page={n}
 *   （牛客已下线 JSON API；该页面匿名可访问，含运行ID/题目/结果/语言/提交时间）
 * - 表格按提交时间倒序 → 增量同步可在遇到旧条目时提前停止
 * - 限速 500ms/页防反爬
 */
export function createNowcoderAdapter(fetchFn: typeof fetch = fetch): PlatformAdapter {
  return {
    platform: 'nowcoder',

    async fetchUserSubmissions(
      handle: string,
      opts?: { since?: string; cookie?: string; csrf?: string },
    ): Promise<NormalizedSubmission[]> {
      const sinceMs = opts?.since ? Date.parse(opts.since) : 0;
      const out: NormalizedSubmission[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${API}/acm/contest/profile/${encodeURIComponent(handle)}/practice-coding?pageSize=${PAGE_SIZE}&search=&statusTypeFilter=-1&languageCategoryFilter=-1&orderType=DESC&page=${page}`;
        const res = await fetchFn(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Referer: `${API}/acm/home/${encodeURIComponent(handle)}`,
          },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
          throw new Error(`牛客页面 HTTP ${res.status}（可能触发风控，请稍后重试）`);
        }
        const html = await res.text();
        const rows = parseRows(html);
        // 首页解析不到任何行：页面结构变化/验证码/登录墙 → 明确失败而非"同步成功 0 条"假成功
        if (rows.length === 0) {
          if (page === 1) {
            throw new Error('牛客页面未解析到提交记录（可能页面结构变化或触发风控），请稍后重试或使用手动导入');
          }
          break; // 后续页为空 = 正常翻页结束
        }

        // 表格按提交时间 DESC：首条已旧于增量起点 → 后续页更旧，提前停止
        // （首条时间解析失败时保守处理：继续翻页而非误停）
        const firstTime = parseTime(rows[0].timeText);
        if (sinceMs > 0 && firstTime > 0 && firstTime <= sinceMs) break;

        let added = 0;
        for (const row of rows) {
          const timeMs = parseTime(row.timeText);
          if (sinceMs > 0 && timeMs > 0 && timeMs <= sinceMs) continue;
          const verdict = RESULT_MAP[row.result] ?? 'SKIPPED';
          out.push({
            problem: {
              platform: 'nowcoder' as PlatformId,
              problemKey: row.pid,
              title: row.title || row.pid,
              url: `https://ac.nowcoder.com/acm/problem/${row.pid}`,
              tags: [],
            },
            verdict,
            ...(row.language ? { language: row.language } : {}),
            submittedAt:
              timeMs > 0 ? new Date(timeMs).toISOString() : new Date().toISOString(),
            externalId: row.submissionId,
          });
          added += 1;
        }
        if (added === 0) break; // 本页全为旧条目
        if (rows.length < PAGE_SIZE) break; // 最后一页
        await sleep(500); // 牛客反爬较强：页间限速
      }
      return out;
    },

    problemUrl({ problemKey }) {
      return `https://ac.nowcoder.com/acm/problem/${String(problemKey)}`;
    },
  };
}
