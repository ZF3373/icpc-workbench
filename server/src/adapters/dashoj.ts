import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields } from '../../../shared/src/difficulty.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { pagedFetch } from './pagination.ts';
import { asHttpClient, type HttpInit } from './http.ts';

/**
 * DashOJ（dashoj.com，基于 Hydro OJ 搭建）适配器。
 *
 * 与代码源（bs.daimayuan.top）同为 Hydro 系，数据通道完全一致，只有一处关键差异：
 * **DashOJ 的评测记录对游客开放**——GET /record?uidOrName={用户名或uid}&page={n} 加
 * `Accept: application/json` 匿名即可按账号过滤（2026-10-22 实测：用中文用户名与 uid 均可，
 * 无 Cookie、无 302 跳登录）。因此本平台是 `sync: 'auto'`，不需要登录态，也不做 checkAuth。
 *
 * - 评测记录：`/record` 走 Hydro 原生 JSON 内容协商，直接拿 rdocs 数组（不解析 HTML 模板，
 *   Hydro 升级改前端不破坏适配器）。列表默认仅含非比赛提交（练习/作业），与站点一致。
 * - rdoc.status 是 Hydro STATUS 数字枚举（@hydrooj/common/status.ts），直接按数字映射统一 Verdict；
 *   Waiting/Judging/Compiling 等评测中状态与 Hack/Cancelled 落 null 跳过。
 * - 提交时间：DashOJ 的 rdoc **直接带 `judgeAt`（ISO8601 UTC）**，优先采用；缺失/畸形时回退到
 *   MongoDB ObjectId 前 4 字节（前 8 位十六进制 = epoch 秒，与代码源同款推导）。
 * - 题目链接 /p/{pid} 公开可访问；难度由题库/回填路径按 Hydro 算法补齐（提交载荷不含难度，
 *   标度记为 hydro-1-10）。
 * - 增量：列表按时间倒序，靠同步层注入的 knownExternalIds 整页已知即早停；分页与补全游标
 *   由 pagedFetch 统一处理。
 *
 * 若站点日后收紧为「仅本人可查记录」，/record 会以 200 + {url:"/login?..."} 或 302 返回，
 * 这里保留 isLoginRedirect 判定并抛出可读错误（届时再按需接入 Cookie）。
 */

const BASE = 'https://dashoj.com';
const PAGE_SIZE = 100; // Hydro pagination.record 默认值
// 每次同步的保守页数上限：120 页 × 400ms ≈ 48 秒；默认 maxSubmissions 下通常几页即触及条目上限停止
const PER_SYNC_MAX_PAGES = 120;
const PAGE_DELAY_MS = 400; // 页间限速，降低对站点的压力

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * Hydro STATUS 数字枚举 → 统一 Verdict（与代码源同表）。
 * 评测中（Waiting/Judging/Compiling/Fetched）与 Cancelled/Hacked/Ignored 等落 null 跳过。
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
  5: 'RE', // STATUS_OUTPUT_LIMIT_EXCEEDED（与代码源同口径归 RE）
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
  /** DashOJ 直接下发的评测时间（ISO8601 UTC） */
  judgeAt?: string;
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
  judgeAt?: string;
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
export function parseDashojJson(body: HydroRecordResponse): HydroRow[] {
  const pdict = body.pdict ?? {};
  return (body.rdocs ?? []).map((rdoc) => ({
    _id: rdoc._id,
    pid: rdoc.pid,
    status: rdoc.status,
    lang: rdoc.lang,
    title: pdict[String(rdoc.pid)]?.title ?? String(rdoc.pid),
    ...(typeof rdoc.judgeAt === 'string' ? { judgeAt: rdoc.judgeAt } : {}),
  }));
}

/**
 * 提交时间归一：优先 rdoc.judgeAt（DashOJ 直接下发的 ISO8601 UTC），
 * 缺失/非法时回退 ObjectId 前缀（epoch 秒）。返回合法 ISO8601，无法解析返回 null。
 */
export function submissionTimeIso(row: { _id: string; judgeAt?: string }): string | null {
  if (row.judgeAt) {
    const t = Date.parse(row.judgeAt);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  if (!/^[0-9a-fA-F]{8}/.test(row._id)) return null;
  const ts = objectIdToTimestamp(row._id);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date(ts * 1000).toISOString();
}

export function createDashojAdapter(fetchFn: HttpInit = fetch): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  return {
    platform: 'dashoj',
    knownIdsFilter: true,

    async fetchUserSubmissions(
      handle,
      opts,
    ): Promise<NormalizedSubmission[]> {
      const user = handle.trim();
      if (!user) {
        throw new Error('DashOJ 账号名为空：请在设置页填写 dashoj.com 用户名（区分大小写）');
      }
      // DashOJ 记录页对游客开放，无需 Cookie；若配置了 Cookie 也一并发送（无害，兼容日后收紧）。
      const cookie = opts?.cookie?.trim();
      const headers: Record<string, string> = {
        'User-Agent': UA,
        Accept: 'application/json', // 走 Hydro 原生 JSON 内容协商，绕过 HTML 模板解析
      };
      if (cookie) headers.Cookie = cookie;

      return pagedFetch<HydroRow>({
        since: opts?.windowSince,
        pageSize: PAGE_SIZE,
        perSyncMax: PER_SYNC_MAX_PAGES,
        fetchPage: async (page) => {
          const url = `${BASE}/record?uidOrName=${encodeURIComponent(user)}&page=${page}`;
          const res = await http.fetch(url, {
            headers,
            redirect: 'manual', // 登录失效时仍可能有 302，不跟随
          }, { timeoutMs: 20000 });
          if (res.status === 302 || res.status === 403) {
            throw new Error('DashOJ 评测记录页跳转登录（站点可能已收紧为仅本人可查），请稍后重试或反馈');
          }
          if (!res.ok) {
            throw new Error(`DashOJ 返回 HTTP ${res.status}，请稍后重试`);
          }
          const body = await res.json().catch(() => null);
          if (body === null) {
            throw new Error('DashOJ 返回非 JSON 响应（可能页面结构变化），请反馈或使用手动导入');
          }
          if (isLoginRedirect(body)) {
            throw new Error('DashOJ 评测记录页跳转登录（站点可能已收紧为仅本人可查），请稍后重试或反馈');
          }
          return parseDashojJson(body as HydroRecordResponse);
        },
        externalIdOf: (row) => row._id,
        normalize: (row) => {
          const verdict = STATUS_TO_VERDICT[row.status] ?? null;
          if (verdict === null) return null; // 评测中/Hack/取消等不落库
          const submittedAt = submissionTimeIso(row);
          if (submittedAt === null) return null; // 时间无法解析的坏行按跳过处理，保住其余行
          const pid = String(row.pid);
          return {
            problem: {
              platform: 'dashoj' as PlatformId,
              problemKey: pid,
              title: row.title || pid,
              ...difficultyFields('dashoj', null), // 提交载荷不含难度：由题库/回填路径按 Hydro 算法补齐
              url: `${BASE}/p/${pid}`,
              tags: [],
            },
            verdict,
            ...(row.lang ? { language: row.lang } : {}),
            submittedAt,
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
  };
}
