import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';
import { ManualImportRequiredError } from './types.ts';

const API = 'https://www.luogu.com.cn';
const MAX_PAGES = 100;
const PROBLEM_FETCH_CONCURRENCY = 6;

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

const LUOGU_DIFFICULTY_TO_RATING: Record<number, number> = {
  1: 1000, // 入门
  2: 1300, // 普及-
  3: 1500, // 普及/提高-
  4: 1700, // 普及+/提高
  5: 2000, // 提高+/省选-
  6: 2300, // 省选/NOI-
  7: 2600, // NOI/NOI+
  8: 3000, // 高级
};

/** 洛谷难度分级（0-8）→ CF rating 近似值（社区公认对照），供统一难度标尺 */
export function luoguDifficultyToRating(d: number): number | null {
  if (d <= 0 || !Number.isFinite(d)) return null;
  return LUOGU_DIFFICULTY_TO_RATING[d] ?? null;
}

interface LuoguProblem {
  pid?: string;
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
  language?: string;
  problem?: LuoguProblem;
}

interface LuoguListResp {
  code?: number;
  currentData?: {
    records?: { result?: LuoguRecord[] };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 洛谷 submitTime 为毫秒时间戳；缺失/非法时回退当前时间 */
function toIso(ts: number | string | undefined): string {
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts ?? ''));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString();
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
 */
async function fetchWithChallenge(
  fetchFn: typeof fetch,
  url: string,
  cookie: string,
  csrf?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  let current = cookie;
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    const res = await fetchFn(url, {
      headers: { ...requestHeaders(current, csrf), ...extraHeaders },
      redirect: 'manual', // 不跟随：302 循环会耗尽 Node fetch 默认重定向次数（抛 fetch failed）
      signal: AbortSignal.timeout(20000),
    });
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
 * - 提交列表：GET /record/list?user={uid}&page={n}&_contentOnly=1
 * - 题目信息（难度/标签）：GET /problem/{pid}?_contentOnly=1（进程内缓存，并发受限）
 * - 未配置 Cookie 时抛 ManualImportRequiredError 引导配置/手动导入
 */
export function createLuoguAdapter(fetchFn: typeof fetch = fetch): PlatformAdapter {
  const problemCache = new Map<string, { difficulty?: number; title?: string; tags: string[] }>();
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
        const res = await fetchWithChallenge(fetchFn, `${API}/_lfe/tags`, cookie);
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
    const empty = { tags: [] };
    try {
      // 洛谷题目页已迁移到 LentilleDataResponse 管线：需请求头 x-lentille-request: content-only
      // （_contentOnly=1 参数已失效）；响应 tags 为 tag id 数组，经 /_lfe/tags 字典转名称
      const res = await fetchWithChallenge(fetchFn, `${API}/problem/${pid}`, cookie, csrf, {
        'x-lentille-request': 'content-only',
        Accept: 'application/json',
        Referer: `${API}/problem/${pid}`,
      });
      if ([301, 302, 303, 504].includes(res.status) || !res.ok) {
        problemCache.set(pid, empty);
        return empty;
      }
      const data = (await res.json()) as {
        currentData?: { problem?: LuoguProblem };
        data?: { problem?: LuoguProblem };
        problem?: LuoguProblem;
      };
      const p = data?.currentData?.problem ?? data?.data?.problem ?? data?.problem;
      if (!p) {
        problemCache.set(pid, empty);
        return empty;
      }
      await ensureTagDict(cookie);
      const tags = resolveTags(p?.tags, tagDict);
      const info = {
        ...(typeof p?.difficulty === 'number' ? { difficulty: p.difficulty } : {}),
        ...(typeof p?.title === 'string' ? { title: p.title } : {}),
        tags,
      };
      problemCache.set(pid, info);
      return info;
    } catch {
      problemCache.set(pid, empty);
      return empty;
    }
  }

  return {
    platform: 'luogu',

    async fetchUserSubmissions(
      handle: string,
      opts?: { since?: string; cookie?: string; csrf?: string },
    ): Promise<NormalizedSubmission[]> {
      const cookie = opts?.cookie;
      if (!cookie) {
        throw new ManualImportRequiredError(
          'luogu',
          '未配置登录 Cookie：请在设置中填写洛谷 Cookie（含 CSRF 时一并填写）后重试，或使用手动导入',
        );
      }
      const raws: LuoguRecord[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${API}/record/list?user=${encodeURIComponent(handle)}&page=${page}&_contentOnly=1`;
        const res = await fetchWithChallenge(fetchFn, url, cookie, opts.csrf);
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
        if (![0, 200].includes(data.code ?? -1) || !data.currentData?.records) {
          throw new Error('洛谷 API 响应异常（Cookie 可能已过期或触发风控）');
        }
        const records = data.currentData.records.result;
        if (!Array.isArray(records) || records.length === 0) break;
        for (const rec of records) {
          // 过滤等待/评测中/隐藏的非最终状态
          if (rec.status === 0 || rec.status === 1 || rec.status === -1) continue;
          raws.push(rec);
        }
        await sleep(300);
      }

      // 按需补充题目难度/标签（并发受限，失败静默降级）；仅对合法 pid 查询
      const pids = [
        ...new Set(
          raws
            .map((r) => r.problem?.pid)
            .filter((p): p is string => typeof p === 'string' && /^[A-Za-z0-9]+$/.test(p)),
        ),
      ];
      for (let i = 0; i < pids.length; i += PROBLEM_FETCH_CONCURRENCY) {
        await Promise.allSettled(
          pids.slice(i, i + PROBLEM_FETCH_CONCURRENCY).map((pid) => fetchProblemInfo(pid, cookie, opts.csrf)),
        );
      }

      return raws.map((rec) => {
        const pid = rec.problem?.pid ?? `luogu-${rec.id}`;
        const info = problemCache.get(pid) ?? { tags: [] };
        // 洛谷难度分级（0-8，record 自带或题目信息补充）→ 映射为 CF rating 统一标尺
        const recDiff = rec.problem?.difficulty;
        const rawDifficulty =
          recDiff !== undefined && recDiff > 0 ? recDiff : info.difficulty;
        const difficulty =
          typeof rawDifficulty === 'number' && rawDifficulty > 0
            ? luoguDifficultyToRating(rawDifficulty)
            : null;
        return {
          problem: {
            platform: 'luogu' as PlatformId,
            problemKey: pid,
            title: info.title ?? rec.problem?.title ?? pid,
            ...(difficulty !== null ? { difficulty } : {}),
            url: `https://www.luogu.com.cn/problem/${pid}`,
            tags: info.tags,
          },
          verdict: STATUS_MAP[rec.status] ?? 'SKIPPED',
          ...(rec.language ? { language: rec.language } : {}),
          submittedAt: toIso(rec.submitTime),
          externalId: String(rec.id),
        };
      });
    },

    problemUrl({ problemKey }) {
      return `https://www.luogu.com.cn/problem/${String(problemKey)}`;
    },

    /** 校验 Cookie 登录态：请求 /user/info 自检接口，302/未登录结构 = Cookie 失效。 */
    async checkAuth(opts: { cookie: string; csrf?: string }): Promise<{ ok: boolean; message: string }> {
      try {
        const res = await fetchWithChallenge(fetchFn, `${API}/user/info`, opts.cookie, opts.csrf, {
          'x-lentille-request': 'content-only',
          Accept: 'application/json',
          Referer: `${API}/`,
        });
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
        return { ok: true, message: 'Cookie 有效 ✓（登录态正常）' };
      } catch (e) {
        return { ok: false, message: `检测失败（网络异常）: ${(e as Error).message}` };
      }
    },
  };
}
