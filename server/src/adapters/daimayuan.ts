import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { ManualImportRequiredError } from './types.ts';
import type { PlatformAdapter } from './types.ts';

/**
 * 代码源（Daimayuan Online Judge，oj.daimayuan.top）适配器。
 *
 * 平台基于 UOJ-System 搭建（页面页脚链接 UniversalOJ/UOJ-System），无公开 API：
 * - 提交列表：GET /submissions?submitter={用户名}&page={n}，服务端渲染 HTML 表格，
 *   每页 10 条、order by id desc（新→旧），匿名访问 403 → 需登录 Cookie。
 * - 登录凭据：UOJ remember-me 双 Cookie `uoj_username` + `uoj_remember_token`（浏览器 F12 复制）。
 * - 结果展示：已评测且有分 → 仅显示分数（class="uoj-score"），score=100 视为 AC；
 *   已评测无分 → result_error 文本（Compile Error 等）；未评测 → Waiting/Judging，跳过。
 * - 证书注意：该站 HTTPS 配置异常（自签名默认证书），因此走 HTTP 明文（仅拉公开做题数据）。
 * - 难度/标签：题目页同样需要登录且 UOJ 无统一难度标尺，暂不下发（difficulty 空）。
 */

const BASE = 'http://oj.daimayuan.top';
const PAGE_SIZE = 10; // UOJ Paginator 默认 page_len
const MAX_PAGES = 300;

/** UOJ 结果单元格文本 → 统一 Verdict；分数制平台无法区分 WA/TLE/RE，低于满分一律 WA */
const RESULT_ERROR_MAP: Record<string, Verdict> = {
  'Compile Error': 'CE',
  'Judgement Failed': 'RE',
  'Extra Test Failed': 'SKIPPED',
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const strip = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

interface UojRow {
  submissionId: string;
  pid: string;
  title: string;
  /** 已评测有分：分数；已评测无分：result_error 文本；未评测：状态文本 */
  result: { kind: 'score'; score: number } | { kind: 'text'; text: string };
  language?: string;
  timeText: string;
}

/** 解析 UOJ /submissions 表格行（与 echoSubmission 输出的列顺序一致，共 10 列） */
export function parseUojSubmissionRows(html: string): UojRow[] {
  const rows: UojRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length !== 10) continue; // 登录后本人未评测行附带 status_details 展开行（colspan）/表头 → 列数不符跳过
    const submissionId = (tds[0].match(/href="\/submission\/(\d+)"/) ?? [])[1];
    const problemMatch = tds[1].match(/href="\/(?:contest\/\d+\/)?problem\/(\d+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!submissionId || !problemMatch) continue; // 异常行/分页脚，跳过
    const title = strip(problemMatch[2]).replace(/^#\d+\.\s*/, '');
    // 结果列：uoj-score 链接 = 已评测有分；否则纯文本（result_error 或评测中状态）
    const scoreMatch = tds[3].match(/class="uoj-score"[^>]*>\s*(-?\d+)\s*</);
    const result = scoreMatch
      ? ({ kind: 'score', score: Number(scoreMatch[1]) } as const)
      : ({ kind: 'text', text: strip(tds[3]) } as const);
    rows.push({
      submissionId,
      pid: problemMatch[1],
      title,
      result,
      language: strip(tds[6]) || undefined,
      timeText: strip(tds[8]),
    });
  }
  return rows;
}

/** UOJ submit_time 为服务器本地时间（无时区后缀）；代码源面向国内用户，按 UTC+8 解析 */
function parseTime(t: string): number {
  if (!t) return 0;
  const ms = Date.parse(`${t.replace(' ', 'T')}+08:00`);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function toVerdict(row: UojRow): Verdict | null {
  if (row.result.kind === 'score') {
    return row.result.score === 100 ? 'AC' : 'WA'; // 满分 AC，未满分（含部分分）WA
  }
  if (!row.result.text) return null; // 空结果 = 评测中，跳过
  return RESULT_ERROR_MAP[row.result.text] ?? null; // Waiting/Judging/未知状态 → 跳过
}

export function createDaimayuanAdapter(fetchFn: typeof fetch = fetch): PlatformAdapter {
  return {
    platform: 'daimayuan',
    knownIdsFilter: true,

    async fetchUserSubmissions(
      handle,
      opts,
    ): Promise<NormalizedSubmission[]> {
      const cookie = opts?.cookie?.trim();
      if (!cookie) {
        throw new ManualImportRequiredError(
          'daimayuan',
          '代码源提交列表需登录后访问：请在设置页填写 uoj_username / uoj_remember_token 两项 Cookie（浏览器登录代码源后 F12 → Application → Cookies 复制）',
        );
      }
      const out: NormalizedSubmission[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${BASE}/submissions?submitter=${encodeURIComponent(handle)}&page=${page}`;
        const res = await fetchFn(url, {
          headers: {
            Cookie: cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Referer: `${BASE}/submissions`,
          },
          redirect: 'manual', // 登录失效时 UOJ 不一定 403，避免跟随重定向拿到登录页当成功
          signal: AbortSignal.timeout(20000),
        });
        const html = await res.text();
        if (res.status === 403 || /href="\/login"/.test(html)) {
          throw new ManualImportRequiredError(
            'daimayuan',
            '登录态已失效（页面跳转登录/403），请重新复制 uoj_username / uoj_remember_token Cookie',
          );
        }
        if (!res.ok) {
          throw new Error(`代码源页面 HTTP ${res.status}，请稍后重试`);
        }
        const rows = parseUojSubmissionRows(html);
        if (rows.length === 0) {
          if (page === 1) {
            // 首页无行：账号确实无提交（正常空态）或页面结构变化。用"提交人筛选条件是否存在"区分：
            // UOJ 空表会渲染 "无" 占位行；连表格都没有则视为结构异常
            if (!/<table[\s\S]*?<tbody>[\s\S]*?<td colspan="233">/.test(html)) {
              throw new Error('代码源页面未解析到提交记录（可能页面结构变化），请反馈或使用手动导入');
            }
            break;
          }
          break; // 后续页为空 = 正常翻页结束
        }

        // 已知 externalId 全命中 → 更旧的都在库中，提前终止增量
        const known = opts?.knownExternalIds;
        if (known && rows.every((r) => known.has(r.submissionId))) break;

        let added = 0;
        for (const row of rows) {
          if (known?.has(row.submissionId)) continue;
          const verdict = toVerdict(row);
          if (verdict === null) continue; // 评测中/未知状态不落库
          const timeMs = parseTime(row.timeText);
          out.push({
            problem: {
              platform: 'daimayuan' as PlatformId,
              problemKey: row.pid,
              title: row.title || row.pid,
              url: `${BASE}/problem/${row.pid}`,
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
        if (added === 0 && !known) break; // 全量模式下整页无有效条目 → 结束
        if (rows.length < PAGE_SIZE) break; // 最后一页
        await sleep(opts?.pageDelayMs ?? 400); // 页间限速，降低对站点的压力
      }
      return out;
    },

    problemUrl({ problemKey }) {
      return `${BASE}/problem/${String(problemKey)}`;
    },

    async checkAuth({ cookie }) {
      try {
        const res = await fetchFn(`${BASE}/submissions`, {
          headers: {
            Cookie: cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        });
        const html = await res.text();
        if (res.status === 403 || /href="\/login"/.test(html)) {
          return { ok: false, message: 'Cookie 无效或已过期：请重新登录代码源并复制 uoj_username / uoj_remember_token' };
        }
        if (!res.ok) {
          return { ok: false, message: `代码源返回 HTTP ${res.status}，请稍后重试` };
        }
        return { ok: true, message: 'Cookie 有效，已通过代码源登录校验' };
      } catch (e) {
        return { ok: false, message: `无法连接代码源：${(e as Error).message}` };
      }
    },
  };
}
