import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { ManualImportRequiredError } from './types.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { pagedFetch } from './pagination.ts';

/**
 * 代码源（bs.daimayuan.top，基于 Hydro OJ 搭建）适配器。
 *
 * - 评测记录页：GET /record?uidOrName={用户名或uid}&page={n}（每页 100 条，按记录 id 新→旧）
 *   Hydro 源码约定：仅「查自己的记录」免 PERM_VIEW_RECORD，游客一律 302 → /login，
 *   因此服务端同步需要登录态——浏览器里能直接看是因为已登录，Cookie 只需复制会话 `sid` 一项。
 * - 列表默认过滤 { contest: null }：与站点「评测记录」页一致，仅含非比赛（练习/作业）提交。
 * - 结果单元格：`{score} {STATUS_TEXT}`（如 100 Accepted / 0 Compile Error），
 *   状态文本来自 Hydro STATUS_TEXTS（英文，不随站点语言变化）。
 * - 递交时间：`<span data-timestamp="{epoch 秒}">`（datetimeSpan，ObjectId 时间戳），精确无需时区换算。
 * - 题目链接 /p/{pid} 公开可访问；难度/标签 Hydro 无统一标尺，暂不下发。
 */

const BASE = 'https://bs.daimayuan.top';
const PAGE_SIZE = 100; // Hydro pagination.record 默认值
// 每次同步的保守页数上限：120 页 × 400ms = 48 秒
// 默认 maxSubmissions=500 时实际拉 5 页（2 秒）即触及条目上限停止
const PER_SYNC_MAX_PAGES = 120;
const PAGE_DELAY_MS = 400; // 页间限速，降低对站点的压力

/** Hydro STATUS_TEXTS → 统一 Verdict；Waiting/Running 等评测中状态与 Hack/Cancelled 落到 null 跳过 */
const STATUS_MAP: Record<string, Verdict> = {
  Accepted: 'AC',
  'Wrong Answer': 'WA',
  'Time Exceeded': 'TLE',
  'Memory Exceeded': 'MLE',
  'Output Exceeded': 'RE',
  'Runtime Error': 'RE',
  'Compile Error': 'CE',
  'Format Error': 'WA',
};

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

interface HydroRow {
  recordId: string;
  pid: string;
  title: string;
  statusText: string;
  language?: string;
  /** data-timestamp（epoch 秒，来自记录 ObjectId） */
  timeSec: number;
}

/** 解析 Hydro /record 列表行（record_main_tr.html：7 列，tr 带 data-rid） */
export function parseDaimayuanRows(html: string): HydroRow[] {
  const rows: HydroRow[] = [];
  const trRe = /<tr\s+data-rid="([^"]+)">([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const recordId = m[1];
    const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length !== 7) continue; // 结构异常行跳过
    const problemMatch = tds[1].match(/href="\/p\/([^"'?]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!problemMatch) continue; // 题目已被隐藏/失效（渲染为 *）等
    const pid = problemMatch[1];
    const title = strip(problemMatch[2])
      .replace(new RegExp(`^${pid}\\s+`), ''); // 渲染为 "<b>pid</b>&nbsp;&nbsp;标题"
    const statusText = strip(tds[0]).replace(/^-?\d+\s+/, ''); // 去掉前导分数（100 Accepted）
    const timeMatch = tds[6].match(/data-timestamp="(\d+)"/);
    if (!statusText || !timeMatch) continue;
    rows.push({
      recordId,
      pid,
      title,
      statusText,
      language: strip(tds[5]) || undefined,
      timeSec: Number(timeMatch[1]),
    });
  }
  return rows;
}

function toVerdict(statusText: string): Verdict | null {
  return STATUS_MAP[statusText] ?? null;
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
          '代码源评测记录页需登录后访问：请在设置页填写 sid 会话 Cookie（浏览器登录 bs.daimayuan.top 后 F12 → Application → Cookies 复制 sid 一项）',
        );
      }
      // 首页空页时需区分「无提交」与「页面结构变化/登录墙」：记录首页 html 与解析行数
      let firstPageHtml = '';
      let firstPageRowsCount = -1;
      const out = await pagedFetch<HydroRow>({
        pageSize: PAGE_SIZE,
        perSyncMax: PER_SYNC_MAX_PAGES,
        fetchPage: async (page) => {
          const url = `${BASE}/record?uidOrName=${encodeURIComponent(handle)}&page=${page}`;
          const res = await fetchFn(url, {
            headers: {
              Cookie: cookie,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
            redirect: 'manual', // 登录失效时 Hydro 302 → /login，避免跟随重定向拿到登录页当成功
            signal: AbortSignal.timeout(20000),
          });
          const html = await res.text();
          if (res.status === 302 || res.status === 403 || /href="\/login"/.test(html)) {
            throw new ManualImportRequiredError(
              'daimayuan',
              '登录态已失效（评测记录页跳转登录），请重新登录 bs.daimayuan.top 并更新 sid Cookie',
            );
          }
          if (!res.ok) {
            throw new Error(`代码源页面 HTTP ${res.status}，请稍后重试`);
          }
          const rows = parseDaimayuanRows(html);
          if (page === 1) {
            firstPageHtml = html;
            firstPageRowsCount = rows.length;
          }
          return rows;
        },
        externalIdOf: (row) => row.recordId,
        normalize: (row) => {
          const verdict = toVerdict(row.statusText);
          if (verdict === null) return null; // 评测中/Hack/取消等不落库
          return {
            problem: {
              platform: 'daimayuan' as PlatformId,
              problemKey: row.pid,
              title: row.title || row.pid,
              url: `${BASE}/p/${row.pid}`,
              tags: [],
            },
            verdict,
            ...(row.language ? { language: row.language } : {}),
            submittedAt: new Date(row.timeSec * 1000).toISOString(),
            externalId: row.recordId,
          };
        },
        knownExternalIds: opts?.knownExternalIds,
        maxSubmissions: opts?.maxSubmissions,
        backfill: opts?.backfill,
        backfillFromPage: opts?.backfillFromPage,
        opts,
        pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS,
      });
      // 首页解析不到任何行（非因整页已知早停）且无提交表格标记：页面结构变化（而非该账号暂无提交）
      if (firstPageRowsCount === 0 && !/name="uidOrName"/.test(firstPageHtml)) {
        throw new Error('代码源页面未解析到提交记录（可能页面结构变化），请反馈或使用手动导入');
      }
      return out;
    },

    problemUrl({ problemKey }) {
      return `${BASE}/p/${String(problemKey)}`;
    },

    /** 校验登录态：按已绑定账号请求"自己的"评测记录页（与同步同款接口）。
     * Hydro 仅"查自己的记录"免权限校验——不带 handle 的 /record 对普通登录用户也会 403，
     * 因此 handle 缺省时提示先绑定账号而非盲判 Cookie 失效。 */
    async checkAuth({ cookie, handle }) {
      if (!handle) {
        return { ok: false, message: '请先在上方填写用户名并保存，再检测 Cookie（检测需按账号访问评测记录页）' };
      }
      try {
        const res = await fetchFn(`${BASE}/record?uidOrName=${encodeURIComponent(handle)}`, {
          headers: {
            Cookie: cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
        });
        if (res.status === 302 || res.status === 403) {
          return { ok: false, message: 'Cookie 无效或已过期：请重新登录 bs.daimayuan.top 并复制 sid' };
        }
        if (!res.ok) {
          return { ok: false, message: `代码源返回 HTTP ${res.status}，请稍后重试` };
        }
        const html = await res.text();
        if (/href="\/login"/.test(html)) {
          return { ok: false, message: 'Cookie 无效或已过期：请重新登录 bs.daimayuan.top 并复制 sid' };
        }
        return { ok: true, message: 'Cookie 有效，已通过代码源登录校验' };
      } catch (e) {
        return { ok: false, message: `无法连接代码源：${(e as Error).message}` };
      }
    },
  };
}
