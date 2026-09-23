import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields } from '../../../shared/src/difficulty.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { pagedFetch } from './pagination.ts';
import { asHttpClient, type HttpInit } from './http.ts';

const API = 'https://ac.nowcoder.com';
const PAGE_SIZE = 10;
// 每次同步的保守页数上限：90 页 × 500ms = 45 秒（牛客反爬强，严格控制单次请求量）
// 默认 maxSubmissions=500 时实际拉 50 页（25 秒）即触及条目上限停止
const PER_SYNC_MAX_PAGES = 90;
const PAGE_DELAY_MS = 500; // 牛客反爬较强：页间限速

// 牛客提交结果（HTML 中文状态文本）→ 统一 Verdict；未知值落到 SKIPPED。
// 瞬态/未终态结果不进表：按 pagination 契约由 normalize 返回 null（不计已知不计新增），
// 终态（答案正确/答案错误…）出现后由后续同步正常导入——若按 SKIPPED 带真实提交号入库，
// 该行下次同步即被判「已知」，终局判定永远补不回来（永久丢数据）。洛谷对 status 0/1/-1 同口径。
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
};

/** 瞬态/未终态结果：评测未完成或评测机异常（通常会重判出终态），不落库 */
const PENDING_RESULTS = new Set(['等待评测', '运行中', '系统错误', '未知错误']);

interface NcRow {
  submissionId: string;
  pid: string;
  title: string;
  result: string;
  language?: string;
  timeText: string;
}

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
 * - 表格按提交时间倒序 → 增量同步依赖同步层注入的 knownExternalIds（提交号精确判重），
 *   整页已知即提前停止。**不要**用 since（上次同步时刻）按提交时间截断——评测/列表
 *   数据延迟会让"提交时间早于上次同步"的新记录出现（实测踩坑），时间截断会漏掉它们。
 * - 分批防封号：单次同步受 maxSubmissions 新增上限与页数预算约束，触及即停（opts.truncated），
 *   下次同步通过 backfill 游标续拉更早历史。限速 500ms/页防反爬。
 */
export function createNowcoderAdapter(fetchFn: HttpInit = fetch): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  return {
    platform: 'nowcoder',
    // 声明支持按已知提交号早停：同步层只在 knownIdsFilter 为真时注入 knownExternalIds，
    // 缺了它，下面的 knownExternalIds 恒为 undefined → 增量同步无从判重，
    // 每次都从最新一页整段重拉、重复行还占用新增上限额度（永远报「仍有历史待补全」）
    knownIdsFilter: true,

    async fetchUserSubmissions(
      handle: string,
      opts?: FetchOptions,
    ): Promise<NormalizedSubmission[]> {
      let firstPageEmpty = false; // 首页空 = 页面结构变化/风控，须抛错而非"同步成功 0 条"
      return pagedFetch<NcRow>({
        since: opts?.windowSince,
        pageSize: PAGE_SIZE,
        perSyncMax: PER_SYNC_MAX_PAGES,
        fetchPage: async (page) => {
          const url = `${API}/acm/contest/profile/${encodeURIComponent(handle)}/practice-coding?pageSize=${PAGE_SIZE}&search=&statusTypeFilter=-1&languageCategoryFilter=-1&orderType=DESC&page=${page}`;
          const res = await http.fetch(url, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              Referer: `${API}/acm/home/${encodeURIComponent(handle)}`,
            },
          }, { timeoutMs: 20000 });
          if (!res.ok) {
            throw new Error(`牛客页面 HTTP ${res.status}（可能触发风控，请稍后重试）`);
          }
          const html = await res.text();
          const rows = parseRows(html);
          if (rows.length === 0 && page === 1) firstPageEmpty = true;
          // rawCount = 页内 <tr> 数据行数（含解析层丢弃的畸形/页脚行）：
          // 「最后一页」按原始行数判，丢行不误判到底
          const rawCount = (html.match(/<tr[\s>]/gi) ?? []).length;
          return { rows, rawCount };
        },
        externalIdOf: (row) => row.submissionId,
        normalize: (row) => {
          if (PENDING_RESULTS.has(row.result)) return null; // 瞬态：不落库不计已知
          const verdict = RESULT_MAP[row.result] ?? 'SKIPPED';
          const timeMs = parseTime(row.timeText);
          return {
            problem: {
              platform: 'nowcoder' as PlatformId,
              problemKey: row.pid,
              title: row.title || row.pid,
              ...difficultyFields('nowcoder', null), // 提交列表不含难度：由题库/回填路径按难度分补齐
              url: `https://ac.nowcoder.com/acm/problem/${row.pid}`,
              tags: [],
            },
            verdict,
            ...(row.language ? { language: row.language } : {}),
            submittedAt:
              timeMs > 0 ? new Date(timeMs).toISOString() : new Date().toISOString(),
            externalId: row.submissionId,
          };
        },
        knownExternalIds: opts?.knownExternalIds,
        maxSubmissions: opts?.maxSubmissions,
        backfill: opts?.backfill,
        backfillFromPage: opts?.backfillFromPage,
        opts,
        pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS,
      }).then((out) => {
        if (firstPageEmpty && out.length === 0) {
          throw new Error('牛客页面未解析到提交记录（可能页面结构变化或触发风控），请稍后重试或使用手动导入');
        }
        return out;
      });
    },

    problemUrl({ problemKey }) {
      return `https://ac.nowcoder.com/acm/problem/${String(problemKey)}`;
    },
  };
}
