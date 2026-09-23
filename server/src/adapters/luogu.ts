import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields, toCfRating } from '../../../shared/src/difficulty.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { ManualImportRequiredError } from './types.ts';
import { sleep, type HttpInit, asHttpClient } from './http.ts';
import { BACKFILL_KNOWN_PAGE_LIMIT } from './pagination.ts';

const API = 'https://www.luogu.com.cn';
// 每页约 20 条。每次同步的保守页数上限：150 页 × 300ms = 45 秒
// 默认 maxSubmissions=500 时实际只拉 25 页（7.5 秒）即触及条目上限停止
const PER_SYNC_MAX_PAGES = 150;
const PAGE_DELAY_MS = 300;
const PROBLEM_FETCH_CONCURRENCY = 3; // 题目信息抓取并发：保守取 3（原 6 过激进，易触发风控）
const PROBLEM_FETCH_BATCH_DELAY_MS = 200; // 题目信息批次间限速：降低短时间请求密度
// 每次同步题目信息抓取总数上限：与提交列表分页独立，防止短时间大量逐题请求触发风控
const PROBLEM_FETCH_MAX_PER_SYNC = 100;

// 洛谷提交状态数字枚举 → 统一 Verdict（官方 /_lfe/config 现行枚举，2026 验证）
// 12=AC，13/14=Unaccepted（未通过/部分正确），2=CE，3=OLE，4=MLE，5=TLE，6=WA，7=RE，11=UKE
// 注意：这是 2019 改版后的枚举（旧版 2=AC/3=WA/4=TLE/5=MLE/6=RE/7=CE 已废弃）
const STATUS_MAP: Record<number, Verdict> = {
  2: 'CE',
  3: 'RE', // OLE → 按 OJ 惯例归为 RE（与 AtCoder 适配器一致）
  4: 'MLE',
  5: 'TLE',
  6: 'WA',
  7: 'RE',
  11: 'RE', // UKE 未知错误 → RE
  12: 'AC',
  13: 'WA', // Unaccepted
  14: 'WA', // Unaccepted（含部分正确）
};

/** 洛谷难度分级（0-8）→ CF rating 近似值（实测中位数表，位于 shared/src/difficulty.ts）。
 *  兼容别名：调用点（analysis/difficultyBackfill、problemBank）与既有测试依赖此名与签名 */
export const luoguDifficultyToRating = (d: number): number | null => toCfRating('luogu', d);

interface LuoguProblem {
  pid?: string;
  /** 洛谷新版 Lentille 接口的标题字段为 name（旧结构为 title） */
  name?: string;
  title?: string;
  difficulty?: number;
  /** 新版 Lentille 接口返回 tag id 数组；旧结构为对象数组 */
  tags?: Array<{ name?: string } | number>;
}

/** 解析题目标签：tag id 数组经字典转名称；对象数组直接取 name；兼容两种结构 */
function resolveTags(
  tags: Array<{ name?: string } | number> | undefined,
  dict: Map<number, string>,
): string[] {
  if (!Array.isArray(tags)) return [];
  const names: string[] = [];
  for (const t of tags) {
    if (typeof t === 'number') {
      const name = dict.get(t);
      if (name) names.push(name);
    } else if (t && typeof t.name === 'string') {
      names.push(t.name);
    }
  }
  return names;
}

interface LuoguRecord {
  id: number;
  status: number;
  submitTime: number;
  /** 平台内部 langId（JSON number，如 34），不是语言名——实测列表/题目页/记录详情三处均无 ID→名称字典 */
  language?: string | number;
  problem?: LuoguProblem;
}

/** 洛谷提交列表响应（Lentille 管线，需 x-lentille-request: content-only 请求头）。
 *  新结构：data.data.records.result；旧结构（已下线）：data.currentData.records.result */
interface LuoguListResp {
  code?: number;
  status?: number;
  currentData?: {
    records?: { result?: LuoguRecord[] };
  };
  data?: {
    records?: { result?: LuoguRecord[] };
  };
}

/**
 * 洛谷 submitTime 为秒级 Unix 时间戳（10 位）；历史版本曾按毫秒解析导致全部落回 1970。
 * 兼容容错：< 1e12 视为秒 ×1000，≥ 1e12 视为毫秒；缺失/非法时回退当前时间。
 */
function toIso(ts: number | string | undefined): string {
  let ms = typeof ts === 'number' ? ts : Date.parse(String(ts ?? ''));
  if (Number.isFinite(ms) && ms > 0 && ms < 1e12) ms *= 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
}

/**
 * 归一 language：洛谷下发的是数字 langId（如 34），把它原样绑进 TEXT 列会被 SQLite
 * 按 REAL 渲染成 "34.0"——既不是语言名又难看。这里统一收成十进制整数字符串 "34"，
 * 真正的语言名映射待平台给出字典后再补（见 db/index.ts fixLuoguLanguageIds）。
 */
function normalizeLang(v: string | number | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (s === '') return undefined;
  return /^\d+(\.\d+)?$/.test(s) ? String(Math.trunc(Number(s))) : s;
}

function requestHeaders(cookie: string, csrf?: string): Record<string, string> {
  return {
    Cookie: cookie,
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: 'https://www.luogu.com.cn/',
  };
}

/**
 * 洛谷 C3VK 反爬挑战处理：
 * 首次请求（无有效 C3VK）会被 302 重定向回自身，同时 Set-Cookie 下发新 C3VK（5 分钟有效）；
 * 带新 C3VK 重试后放行返回 200。此函数自动保存 set-cookie 中的新 C3VK 并重试（最多 2 次）。
 * 返回的 Response 状态：200=正常；302/303=未登录（无新 C3VK 下发）；504=挑战重试超限。
 * cookie 传空串即可匿名访问公开接口（题库列表 / 标签字典）。
 */
export async function fetchWithChallenge(
  fetchFn: HttpInit | typeof fetch,
  url: string,
  cookie: string,
  csrf?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const http = asHttpClient(fetchFn as HttpInit);
  let current = cookie;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    if (attempt > 0) await sleep(300); // C3VK 重试间限速，避免毫秒级连发请求触发风控
    const res = await http.fetch(url, {
      headers: { ...requestHeaders(current, csrf), ...extraHeaders },
      redirect: 'manual', // 不跟随：302 循环会耗尽 Node fetch 默认重定向次数（抛 fetch failed）
    }, { timeoutMs: 20000 });
    if (![301, 302, 303].includes(res.status)) return res;
    // 尝试从 set-cookie 提取新 C3VK 并更新后重试
    const fresh = (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0])
      .find((kv) => kv.startsWith('C3VK='));
    if (!fresh) return res; // 无新 C3VK → 真未登录
    current = current.includes('C3VK=')
      ? current.replace(/C3VK=[^;]*/, fresh)
      : `${current}; ${fresh}`;
  }
  return new Response(null, { status: 504 });
}

/**
 * 洛谷适配器（需登录 Cookie + CSRF）：
 * - 提交列表：GET /record/list?user={uid}&page={n}（需 x-lentille-request: content-only 请求头）
 * - 题目信息（难度/标签）：GET /problem/{pid}（需 x-lentille-request: content-only 请求头，进程内缓存，并发受限）
 * - 未配置 Cookie 时抛 ManualImportRequiredError 引导配置/手动导入
 */
export function createLuoguAdapter(fetchFn: HttpInit = fetch): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  const problemCache = new Map<string, { difficulty?: number; title?: string; tags: string[] }>();
  // 题目详情失败退避（pid → 失败时刻，5 分钟内不重试，同 tagDictFailedAt 做法）：
  // 风控 302/单题 404 都可能只是瞬时的——失败绝不能写进 problemCache（内容负缓存），
  // 那会让这道题在整个进程生命周期内拿不回难度/标题
  const problemFetchFailedAt = new Map<string, number>();
  const PROBLEM_FETCH_BACKOFF_MS = 5 * 60 * 1000;
  // tag id → 名称字典（/_lfe/tags，无需登录；进程内缓存，失败 5 分钟退避）
  const tagDict = new Map<number, string>();
  let tagDictPromise: Promise<void> | null = null;
  let tagDictFailedAt = 0;

  async function ensureTagDict(cookie: string): Promise<void> {
    if (tagDict.size > 0) return;
    if (tagDictPromise) {
      await tagDictPromise;
      return;
    }
    // 上次拉取失败后 5 分钟内不重试（避免每道题都触发一次字典请求）
    if (Date.now() - tagDictFailedAt < 5 * 60 * 1000) return;
    tagDictPromise = (async () => {
      try {
        const res = await fetchWithChallenge(http, `${API}/_lfe/tags`, cookie);
        if (res.ok) {
          const d = (await res.json()) as { tags?: Array<{ id: number; name: string }> };
          for (const t of d.tags ?? []) tagDict.set(t.id, t.name);
        }
      } catch {
        tagDictFailedAt = Date.now(); // 失败：退避重试
      } finally {
        tagDictPromise = null;
      }
    })();
    await tagDictPromise;
  }

  async function fetchProblemInfo(
    pid: string,
    cookie: string,
    csrf?: string,
  ): Promise<{ difficulty?: number; title?: string; tags: string[] }> {
    const hit = problemCache.get(pid);
    if (hit) return hit;
    // 退避期内不重试（该题上次拉取刚失败）
    if (Date.now() - (problemFetchFailedAt.get(pid) ?? 0) < PROBLEM_FETCH_BACKOFF_MS) {
      return { tags: [] };
    }
    const fail = (): { difficulty?: number; title?: string; tags: string[] } => {
      problemFetchFailedAt.set(pid, Date.now()); // 只记退避时刻，不污染内容缓存
      return { tags: [] };
    };
    try {
      // 洛谷题目页已迁移到 LentilleDataResponse 管线：需请求头 x-lentille-request: content-only
      // （_contentOnly=1 参数已失效）；响应 tags 为 tag id 数组，经 /_lfe/tags 字典转名称
      const res = await fetchWithChallenge(http, `${API}/problem/${pid}`, cookie, csrf, {
        'x-lentille-request': 'content-only',
        Accept: 'application/json',
        Referer: `${API}/problem/${pid}`,
      });
      if ([301, 302, 303, 504].includes(res.status) || !res.ok) {
        return fail();
      }
      const data = (await res.json()) as {
        currentData?: { problem?: LuoguProblem };
        data?: { problem?: LuoguProblem };
        problem?: LuoguProblem;
      };
      const p = data?.currentData?.problem ?? data?.data?.problem ?? data?.problem;
      if (!p) {
        return fail();
      }
      await ensureTagDict(cookie);
      const tags = resolveTags(p?.tags, tagDict);
      const info = {
        ...(typeof p?.difficulty === 'number' ? { difficulty: p.difficulty } : {}),
        // 洛谷新版接口标题字段为 name，旧结构为 title（回填路径 difficultyBackfill 同款兼容）
        ...(typeof p?.name === 'string'
          ? { title: p.name }
          : typeof p?.title === 'string'
            ? { title: p.title }
            : {}),
        tags,
      };
      problemCache.set(pid, info);
      return info;
    } catch {
      return fail();
    }
  }

  return {
    platform: 'luogu',
    knownIdsFilter: true,

    async fetchUserSubmissions(
      handle: string,
      opts?: FetchOptions,
    ): Promise<NormalizedSubmission[]> {
      const cookie = opts?.cookie;
      const known = opts?.knownExternalIds;
      const maxSubmissions = opts?.maxSubmissions;
      const backfill = opts?.backfill;
      const since = opts?.windowSince;
      // 限速等待累计到 opts.waitedMs（同步层写入 sync_runs.waited_ms 供同步中心展示）
      const sleepTracked = async (ms: number): Promise<void> => {
        if (ms > 0) {
          if (opts) opts.waitedMs = (opts.waitedMs ?? 0) + ms;
          await sleep(ms);
        }
      };
      // 页数预算：新增上限推算的新页 ×2（兼顾补全续拉起点的重叠页），上限 PER_SYNC_MAX_PAGES
      const budget =
        maxSubmissions && maxSubmissions > 0
          ? Math.min(Math.ceil(maxSubmissions / 20) * 2, PER_SYNC_MAX_PAGES)
          : PER_SYNC_MAX_PAGES;
      const startPage = backfill && opts?.backfillFromPage ? opts.backfillFromPage : 1;
      if (!cookie) {
        throw new ManualImportRequiredError(
          'luogu',
          '未配置登录 Cookie：请在设置中填写洛谷 Cookie（含 CSRF 时一并填写）后重试，或使用手动导入',
        );
      }
      const raws: LuoguRecord[] = [];
      let reachedPage = startPage;
      let naturalEnd = false; // 空页
      let caughtUp = false; // 增量模式整页已知早停 / 补全模式连续已知页到尽头
      let rowCapped = false; // 触及新增上限
      let windowEnd = false; // 早于 since 窗口起点（仅同步最近 N 天）
      let knownRun = 0; // 连续「整页已知」页数（补全模式收尾判据，见 pagination.ts 同名常量）
      for (let page = startPage, n = 0; n < budget; page += 1, n += 1) {
        reachedPage = page;
        const url = `${API}/record/list?user=${encodeURIComponent(handle)}&page=${page}`;
        const res = await fetchWithChallenge(http, url, cookie, opts?.csrf, {
          'x-lentille-request': 'content-only',
          Accept: 'application/json',
        });
        // 302 且无新 C3VK = 未登录 / Cookie 无效（洛谷重定向到登录页）
        if ([301, 302, 303].includes(res.status)) {
          throw new Error('洛谷返回登录跳转：Cookie 无效或已过期，请在设置中重新填写（需登录洛谷后复制最新 Cookie）');
        }
        if (!res.ok) {
          throw new Error(`洛谷 API HTTP ${res.status}（Cookie 可能已过期或触发风控）`);
        }
        const text = await res.text();
        if (!text.trim().startsWith('{')) {
          // 防御：异常时返回登录页 HTML
          throw new Error('洛谷返回未登录页面：Cookie 无效或已过期，请在设置中重新填写（需登录洛谷后复制最新 Cookie）');
        }
        let data: LuoguListResp;
        try {
          data = JSON.parse(text) as LuoguListResp;
        } catch {
          throw new Error('洛谷 API 响应解析失败（页面异常或结构变化）');
        }
        // 兼容新旧结构：新 Lentille data.data.records；旧 data.currentData.records
        const records = data.data?.records?.result ?? data.currentData?.records?.result;
        if (![0, 200].includes(data.code ?? data.status ?? -1) || !records) {
          throw new Error('洛谷 API 响应异常（Cookie 可能已过期或触发风控）');
        }
        if (!Array.isArray(records) || records.length === 0) {
          naturalEnd = true;
          break;
        }
        // 已知记录直接跳过（省去后续逐题抓难度/标签）；统计整页已知用于早停/补全跳页
        let knownInPage = 0;
        for (const rec of records) {
          if (known?.has(String(rec.id))) {
            knownInPage += 1;
            continue;
          }
          // 过滤等待/评测中/隐藏的非最终状态
          if (rec.status === 0 || rec.status === 1 || rec.status === -1) continue;
          // 降序分页遇到早于窗口起点的记录：后续都更旧，终止（不计截断）
          if (since && rec.submitTime * 1000 < Date.parse(since)) {
            windowEnd = true;
            break;
          }
          raws.push(rec);
          if (maxSubmissions && raws.length >= maxSubmissions) {
            rowCapped = true;
            break;
          }
        }
        if (rowCapped || windowEnd) break;
        // 整页已知：补全跳过该页继续向更旧，增量模式则终止（更旧都在库）
        if (known && knownInPage > 0 && knownInPage === records.length) {
          if (backfill) {
            knownRun += 1;
            // 连续多个整页已知 → 视为已补到尽头（与 pagination.ts 同一判据，避免空扫满预算）
            if (knownRun >= BACKFILL_KNOWN_PAGE_LIMIT) {
              caughtUp = true;
              break;
            }
            await sleepTracked(opts?.pageDelayMs ?? PAGE_DELAY_MS);
            continue;
          }
          caughtUp = true;
          break;
        }
        knownRun = 0; // 本页出现了新行 → 仍在有效补全区段
        await sleepTracked(opts?.pageDelayMs ?? PAGE_DELAY_MS);
      }

      // 截断：触及上限，或页数预算耗尽（未自然结束/未增量早停/未到窗口起点）且有新增
      const truncated = rowCapped || (!naturalEnd && !caughtUp && !windowEnd && raws.length > 0);
      if (truncated && opts) {
        opts.truncated = true;
        opts.backfillReachedPage = reachedPage;
      }

      // 按需补充题目难度/标签（并发受限 + 批次间限速 + 总数上限，防触发风控）；
      // 仅对合法 pid 查询，已缓存的跳过。超出上限的题目留待下次同步补全（降级为无难度/标签）
      const pids = [
        ...new Set(
          raws
            .map((r) => r.problem?.pid)
            .filter((p): p is string => typeof p === 'string' && /^[A-Za-z0-9]+$/.test(p)),
        ),
      ].filter((pid) => !problemCache.has(pid)); // 跳过已缓存，减少请求量
      const pidsToFetch = pids.slice(0, PROBLEM_FETCH_MAX_PER_SYNC);
      for (let i = 0; i < pidsToFetch.length; i += PROBLEM_FETCH_CONCURRENCY) {
        await Promise.allSettled(
          pidsToFetch.slice(i, i + PROBLEM_FETCH_CONCURRENCY).map((pid) => fetchProblemInfo(pid, cookie, opts?.csrf)),
        );
        if (i + PROBLEM_FETCH_CONCURRENCY < pidsToFetch.length) {
          await sleepTracked(PROBLEM_FETCH_BATCH_DELAY_MS); // 批次间限速
        }
      }

      return raws.map((rec) => {
        const pid = rec.problem?.pid ?? `luogu-${rec.id}`;
        const info = problemCache.get(pid) ?? { tags: [] };
        // 洛谷难度分级（0-8，record 自带或题目信息补充）→ 统一标尺；
        // 0 = 暂无评定 → 不下发 difficulty 键，nativeDifficulty 亦不写（未知不给原生值）
        const recDiff = rec.problem?.difficulty;
        const rawDifficulty =
          recDiff !== undefined && recDiff > 0 ? recDiff : info.difficulty;
        const language = normalizeLang(rec.language);
        return {
          problem: {
            platform: 'luogu' as PlatformId,
            problemKey: pid,
            title: info.title ?? rec.problem?.title ?? pid,
            ...difficultyFields(
              'luogu',
              typeof rawDifficulty === 'number' && rawDifficulty > 0 ? rawDifficulty : null,
            ),
            url: `https://www.luogu.com.cn/problem/${pid}`,
            tags: info.tags,
          },
          verdict: STATUS_MAP[rec.status] ?? 'SKIPPED',
          ...(language ? { language } : {}),
          submittedAt: toIso(rec.submitTime),
          externalId: String(rec.id),
        };
      });
    },

    problemUrl({ problemKey }) {
      return `https://www.luogu.com.cn/problem/${String(problemKey)}`;
    },

    /** 校验 Cookie 登录态：从 Cookie 提取 _uid，请求同步同款 record/list 自检接口（旧 /user/info 已 404 下线）。
     * 302（无新 C3VK 下发）/ 非 JSON / 响应结构异常 = Cookie 失效。 */
    async checkAuth(opts: { cookie: string; csrf?: string }): Promise<{ ok: boolean; message: string }> {
      try {
        const uid = opts.cookie.match(/(?:^|;)\s*_uid=([^;\s]+)/)?.[1];
        if (!uid) {
          return { ok: false, message: 'Cookie 中缺少 _uid：请重新复制包含 _uid 与 __client_id 的完整 Cookie' };
        }
        const res = await fetchWithChallenge(
          http,
          `${API}/record/list?user=${encodeURIComponent(uid)}&page=1`,
          opts.cookie,
          opts.csrf,
          { 'x-lentille-request': 'content-only', Accept: 'application/json' },
        );
        if (res.status === 504) {
          return { ok: false, message: '洛谷挑战重试超限（可能触发风控），请稍后重试' };
        }
        if ([301, 302, 303].includes(res.status)) {
          return { ok: false, message: 'Cookie 无效或已过期（洛谷返回登录跳转），请重新登录洛谷后复制最新 Cookie' };
        }
        if (!res.ok) {
          return { ok: false, message: `洛谷 HTTP ${res.status}（可能触发风控），请稍后重试` };
        }
        const text = await res.text();
        if (!text.trim().startsWith('{')) {
          return { ok: false, message: '返回非 JSON（Cookie 无效或已过期），请重新登录洛谷后复制最新 Cookie' };
        }
        const data = JSON.parse(text) as LuoguListResp;
        // 兼容新旧结构：新 Lentille data.data.records；旧 data.currentData.records
        const records = data.data?.records?.result ?? data.currentData?.records?.result;
        if (![0, 200].includes(data.code ?? data.status ?? -1) || !records) {
          return { ok: false, message: '响应结构异常（Cookie 可能已过期或触发风控），请重新复制 Cookie' };
        }
        return { ok: true, message: 'Cookie 有效 ✓（登录态正常）' };
      } catch (e) {
        return { ok: false, message: `检测失败（网络异常）: ${(e as Error).message}` };
      }
    },
  };
}
