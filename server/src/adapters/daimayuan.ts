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
 * - 评测记录：GET /record?uidOrName={用户名或uid}&page={n}，加 `Accept: application/json`
 *   请求头走 Hydro 原生 JSON 输出（framework/base.ts 内容协商），直接拿 rdocs 数组，
 *   不再依赖 HTML 模板解析，Hydro 升级改前端模板不会破坏适配器。
 * - Hydro 源码约定：仅「查自己的记录」免 PERM_VIEW_RECORD，游客一律跳转 /login，
 *   因此服务端同步需要登录态——浏览器里能直接看是因为已登录，Cookie 只需复制会话 `sid` 一项。
 * - 列表默认过滤 { contest: null }：与站点「评测记录」页一致，仅含非比赛（练习/作业）提交。
 * - rdoc.status 是 Hydro STATUS 数字枚举（见 @hydrooj/common/status.ts），
 *   直接按数字映射到统一 Verdict；Waiting/Running/Judging 等评测中状态与 Hack/Cancelled 落到 null 跳过。
 * - rdoc._id 是 MongoDB ObjectId，前 4 字节（前 8 位十六进制）即提交时间戳（epoch 秒）。
 * - 题目链接 /p/{pid} 公开可访问；难度/标签 Hydro 无统一标尺，暂不下发。
 */

const BASE = 'https://bs.daimayuan.top';
const PAGE_SIZE = 100; // Hydro pagination.record 默认值
// 每次同步的保守页数上限：120 页 × 400ms = 48 秒
// 默认 maxSubmissions=500 时实际拉 5 页（2 秒）即触及条目上限停止
const PER_SYNC_MAX_PAGES = 120;
const PAGE_DELAY_MS = 400; // 页间限速，降低对站点的压力

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * Hydro STATUS 数字枚举 → 统一 Verdict。
 * 评测中（Waiting/Judging/Compiling/Fetched）与 Cancelled/Hacked/Ignored 等落 null 跳过。
 * 枚举值来自 @hydrooj/common/status.ts：
 *   0=Waiting 1=Accepted 2=Wrong Answer 3=Time Exceeded 4=Memory Exceeded
 *   5=Output Exceeded 6=Runtime Error 7=Compile Error 8=System Error 9=Cancelled
 *   10=Unknown 11=Hacked 20=Judging 21=Compiling 22=Fetched 30=Ignored
 *   31=Format Error 32=Hack Successful 33=Hack Unsuccessful
 */
const STATUS_TO_VERDICT: Record<number, Verdict> = {
  1: 'AC', // STATUS_ACCEPTED
  2: 'WA', // STATUS_WRONG_ANSWER
  3: 'TLE', // STATUS_TIME_LIMIT_EXCEEDED
  4: 'MLE', // STATUS_MEMORY_LIMIT_EXCEEDED
  5: 'RE', // STATUS_OUTPUT_LIMIT_EXCEEDED
  6: 'RE', // STATUS_RUNTIME_ERROR
  7: 'CE', // STATUS_COMPILE_ERROR
  31: 'WA', // STATUS_FORMAT_ERROR
  // 其余状态（0/8/9/10/11/20/21/22/30/32/33）不在表中 → null，评测中/取消/Hack 等不落库
};

/** Hydro rdoc（PROJECTION_LIST 投影后的字段） */
interface HydroRdoc {
  _id: string; // ObjectId 十六进制字符串
  pid: number; // 题目 docId
  status: number; // STATUS 枚举
  lang: string;
  score?: number;
}

/** Hydro /record JSON 响应体 */
interface HydroRecordResponse {
  page: number;
  rdocs: HydroRdoc[];
  /** pid → 题目信息（含 title）；键可能是数字或字符串，统一按 String(pid) 取 */
  pdict?: Record<string, { pid: number; title: string }>;
  /** 登录失效时 Hydro 返回跳转地址而非 rdocs */
  url?: string;
}

/** fetchPage 返回的富行：rdoc 关联上题目标题（pdict 在 fetchPage 内可得，normalize 不可） */
interface HydroRow {
  _id: string;
  pid: number;
  status: number;
  lang: string;
  title: string;
}

/** MongoDB ObjectId 前 4 字节（前 8 位十六进制）= 提交时间戳（epoch 秒） */
export function objectIdToTimestamp(objectId: string): number {
  return Number.parseInt(objectId.slice(0, 8), 16);
}

/** 判断 JSON 响应是否为登录失效（Hydro 以 200 + {url:"/login?..."} 而非 302 表示） */
export function isLoginRedirect(body: unknown): body is { url: string } {
  return (
    typeof body === 'object' && body !== null &&
    typeof (body as { url?: unknown }).url === 'string' &&
    (body as { url: string }).url.includes('/login')
  );
}

/** 把 Hydro JSON 响应里的 rdocs + pdict 合并为带标题的行列表 */
export function parseDaimayuanJson(body: HydroRecordResponse): HydroRow[] {
  const pdict = body.pdict ?? {};
  return (body.rdocs ?? []).map((rdoc) => ({
    _id: rdoc._id,
    pid: rdoc.pid,
    status: rdoc.status,
    lang: rdoc.lang,
    title: pdict[String(rdoc.pid)]?.title ?? String(rdoc.pid),
  }));
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
      return pagedFetch<HydroRow>({
        pageSize: PAGE_SIZE,
        perSyncMax: PER_SYNC_MAX_PAGES,
        fetchPage: async (page) => {
          const url = `${BASE}/record?uidOrName=${encodeURIComponent(handle)}&page=${page}`;
          const res = await fetchFn(url, {
            headers: {
              Cookie: cookie,
              'User-Agent': UA,
              Accept: 'application/json', // 走 Hydro 原生 JSON 内容协商，绕过 HTML 模板解析
            },
            redirect: 'manual', // 登录失效时仍可能有 302，不跟随
            signal: AbortSignal.timeout(20000),
          });
          // 302/403 = 登录态失效（非 JSON 模式的兜底路径）
          if (res.status === 302 || res.status === 403) {
            throw new ManualImportRequiredError(
              'daimayuan',
              '登录态已失效（评测记录页跳转登录），请重新登录 bs.daimayuan.top 并更新 sid Cookie',
            );
          }
          if (!res.ok) {
            throw new Error(`代码源返回 HTTP ${res.status}，请稍后重试`);
          }
          const body = await res.json().catch(() => null);
          if (body === null) {
            throw new Error('代码源返回非 JSON 响应（可能页面结构变化），请反馈或使用手动导入');
          }
          // JSON 模式下登录失效：Hydro 返回 200 + {url:"/login?redirect=..."}
          if (isLoginRedirect(body)) {
            throw new ManualImportRequiredError(
              'daimayuan',
              '登录态已失效（评测记录页跳转登录），请重新登录 bs.daimayuan.top 并更新 sid Cookie',
            );
          }
          return parseDaimayuanJson(body as HydroRecordResponse);
        },
        externalIdOf: (row) => row._id,
        normalize: (row) => {
          const verdict = STATUS_TO_VERDICT[row.status] ?? null;
          if (verdict === null) return null; // 评测中/Hack/取消等不落库
          const pid = String(row.pid);
          return {
            problem: {
              platform: 'daimayuan' as PlatformId,
              problemKey: pid,
              title: row.title || pid,
              url: `${BASE}/p/${pid}`,
              tags: [],
            },
            verdict,
            ...(row.lang ? { language: row.lang } : {}),
            submittedAt: new Date(objectIdToTimestamp(row._id) * 1000).toISOString(),
            externalId: row._id,
          };
        },
        knownExternalIds: opts?.knownExternalIds,
        maxSubmissions: opts?.maxSubmissions,
        backfill: opts?.backfill,
        backfillFromPage: opts?.backfillFromPage,
        opts,
        pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS,
      });
    },

    problemUrl({ problemKey }) {
      return `${BASE}/p/${String(problemKey)}`;
    },

    /** 校验登录态：按已绑定账号请求"自己的"评测记录页（与同步同款接口，JSON 模式）。
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
            'User-Agent': UA,
            Accept: 'application/json',
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
        const body = await res.json().catch(() => null);
        if (body === null) {
          return { ok: false, message: '代码源返回非 JSON 响应，请稍后重试' };
        }
        if (isLoginRedirect(body)) {
          return { ok: false, message: 'Cookie 无效或已过期：请重新登录 bs.daimayuan.top 并复制 sid' };
        }
        return { ok: true, message: 'Cookie 有效，已通过代码源登录校验' };
      } catch (e) {
        return { ok: false, message: `无法连接代码源：${(e as Error).message}` };
      }
    },
  };
}
