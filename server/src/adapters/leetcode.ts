import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { ManualImportRequiredError } from './types.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { pagedFetch } from './pagination.ts';

/**
 * 力扣（leetcode.cn）适配器（GraphQL，无官方公开 API）。
 * schema 与国际版 leetcode.com 不同（且屏蔽 introspection），以下均为对
 * leetcode.cn 实测确认的查询；国际版未接入。
 *
 * - 提交记录：POST /graphql `submissionList(offset, limit, lastKey, questionSlug)`
 *   需登录态——Cookie 需含 `LEETCODE_SESSION` 与 `csrftoken` 两项（带登录态的
 *   POST 请求必须携带 `x-csrftoken` 头，直接从 Cookie 字符串提取，用户无需单独填）。
 *   每页 40 条按提交时间新→旧，knownIdsFilter 支持整页已知提前终止增量。
 *   cn 的提交节点没有 question 子对象：题目标识从 url 的 `/problems/{slug}` 提取
 *   （problemKey = slug 小写）；难度/标签不在提交接口里，由「拉取题库」补全。
 * - 题库：`problemsetQuestionList(limit, skip)` 匿名可访问（约 3300+ 题，含
 *   题号 / 中英文标题 / 难度 / 算法标签），见 problemBank.ts 的 fetchLeetcodeBank。
 * - 检测 Cookie：`userStatus { username isSignedIn }`（匿名恒为 isSignedIn=false）。
 * - handle 仅作展示用途：接口以 session Cookie 识别用户，绑定用户名需与其一致以便核对。
 */

const BASE = 'https://leetcode.cn';
const PAGE_SIZE = 40; // 官网提交列表的分页大小
// 每次同步的保守页数上限：150 页 × 300ms = 45 秒
// 默认 maxSubmissions=500 时实际拉 13 页（4 秒）即触及条目上限停止
const PER_SYNC_MAX_PAGES = 150;
const PAGE_DELAY_MS = 300; // 页间限速，降低风控压力

/** statusDisplay → 统一 Verdict；评测中 / TLE 之外的黑盒状态落 null 跳过 */
const STATUS_MAP: Record<string, Verdict> = {
  Accepted: 'AC',
  'Wrong Answer': 'WA',
  'Time Limit Exceeded': 'TLE',
  'Memory Limit Exceeded': 'MLE',
  'Runtime Error': 'RE',
  'Output Limit Exceeded': 'RE',
  'Compile Error': 'CE',
  // 部分接口可能返回中文状态，兜底映射
  通过: 'AC',
  解答错误: 'WA',
  超出时间限制: 'TLE',
  超过内存限制: 'MLE',
  内存超限: 'MLE',
  运行时错误: 'RE',
  编译错误: 'CE',
};

/** 力扣三级难度 → CF rating 统一标尺（取各档社区公认的近似中位分） */
export const LEETCODE_DIFFICULTY_TO_RATING: Record<string, number> = {
  easy: 1200,
  medium: 1600,
  hard: 2100,
};

/** 力扣难度（EASY/MEDIUM/HARD，大小写不敏感）→ CF rating 近似值 */
export function leetcodeDifficultyToRating(d?: string | null): number | null {
  if (!d) return null;
  return LEETCODE_DIFFICULTY_TO_RATING[d.trim().toLowerCase()] ?? null;
}

/** 从提交 url 提取题目 slug（cn 提交节点唯一可用的题目标识来源） */
export function extractSlugFromUrl(url?: string | null): string | null {
  const m = /problems\/([a-z0-9_-]+)/i.exec(url ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** 从 Cookie 字符串提取单项值（用户可能整段粘贴，与前端拼装格式兼容） */
export function extractCookieValue(cookie: string, name: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;\\s]+)`).exec(cookie);
  return m ? m[1] : null;
}

const UA_HEADERS = {
  'Content-Type': 'application/json',
  Referer: `${BASE}/`,
  Origin: BASE,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

/** 力扣 GraphQL POST：带 Cookie 时自动附加 x-csrftoken；GraphQL errors 转为显式错误 */
async function gql(
  fetchFn: typeof fetch,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { cookie?: string } = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { ...UA_HEADERS };
  const cookie = opts.cookie?.trim();
  if (cookie) {
    headers.Cookie = cookie;
    const csrf = extractCookieValue(cookie, 'csrftoken');
    if (csrf) headers['x-csrftoken'] = csrf;
  }
  const res = await fetchFn(`${BASE}/graphql`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new ManualImportRequiredError(
      'leetcode',
      '力扣接口拒绝访问（登录态失效或触发风控）：请重新登录 leetcode.cn，更新 LEETCODE_SESSION / csrftoken Cookie',
    );
  }
  if (!res.ok) {
    throw new Error(`力扣接口 HTTP ${res.status}，请稍后重试`);
  }
  const body = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    throw new Error(`力扣接口返回错误：${body.errors[0]?.message ?? '未知错误'}`);
  }
  return body.data ?? {};
}

const SUBMISSION_LIST_QUERY = `query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $questionSlug: String) {
  submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, questionSlug: $questionSlug) {
    lastKey
    hasNext
    submissions { id title statusDisplay lang timestamp url }
  }
}`;

interface LcSubmission {
  id?: string;
  title?: string;
  statusDisplay?: string;
  lang?: string;
  timestamp?: number | string;
  url?: string;
}

export function createLeetcodeAdapter(fetchFn: typeof fetch = fetch): PlatformAdapter {
  return {
    platform: 'leetcode',
    knownIdsFilter: true,

    async fetchUserSubmissions(
      _handle,
      opts,
    ): Promise<NormalizedSubmission[]> {
      const cookie = opts?.cookie?.trim();
      if (!cookie || !extractCookieValue(cookie, 'LEETCODE_SESSION')) {
        throw new ManualImportRequiredError(
          'leetcode',
          '力扣提交记录需登录后访问：请在设置页填写 LEETCODE_SESSION 与 csrftoken 两项 Cookie（浏览器登录 leetcode.cn 后 F12 → Application → Cookies 复制，支持整段粘贴）',
        );
      }
      const known = opts?.knownExternalIds;
      // 首页结构异常信号：fetchPage 记录首页行数与可提取 slug 数，全完成后判定
      // （首页有行但无 slug = 接口结构变化，明确失败而非"同步成功 0 条"）
      let firstPageRows = -1;
      let firstPageSlugged = -1;
      const out = await pagedFetch<LcSubmission>({
        pageSize: PAGE_SIZE,
        perSyncMax: PER_SYNC_MAX_PAGES,
        fetchPage: async (page) => {
          const offset = (page - 1) * PAGE_SIZE;
          const data = await gql(fetchFn, SUBMISSION_LIST_QUERY, {
            offset,
            limit: PAGE_SIZE,
            lastKey: null,
            questionSlug: null,
          }, { cookie });
          const list = data.submissionList as
            | { submissions?: LcSubmission[]; hasNext?: boolean }
            | undefined;
          const rows = list?.submissions ?? [];
          if (page === 1) {
            firstPageRows = rows.length;
            firstPageSlugged = rows.filter((r) => !!extractSlugFromUrl(r.url)).length;
          }
          // hasNext===false：最后一页，返回数据但 pagedFetch 会因下一页空自然终止
          return rows;
        },
        externalIdOf: (row) => String(row.id ?? ''),
        normalize: (row) => {
          if (row.id === undefined) return null;
          const slug = extractSlugFromUrl(row.url);
          if (!slug) return null; // 无 slug 的行无法定位题目（如专属题/结构异常），跳过
          const verdict = row.statusDisplay ? STATUS_MAP[row.statusDisplay] ?? null : null;
          if (verdict === null) return null; // 评测中 / 未知状态不落库
          // cn 返回秒级时间戳（历史踩坑：<1e12 视为秒，防毫秒/秒混用）
          const ts = Number(row.timestamp ?? 0);
          if (!Number.isFinite(ts) || ts <= 0) return null;
          const submittedAtIso = ts < 1e12 ? new Date(ts * 1000).toISOString() : new Date(ts).toISOString();
          const url = row.url?.startsWith('http') ? row.url : `${BASE}${row.url ?? ''}`;
          return {
            problem: {
              platform: 'leetcode' as PlatformId,
              problemKey: slug,
              title: row.title || slug,
              url,
              tags: [], // 提交接口不含标签：由「拉取题库」补全（入库保留已有标签）
            },
            verdict,
            ...(row.lang ? { language: row.lang } : {}),
            submittedAt: submittedAtIso,
            externalId: String(row.id),
          };
        },
        // 力扣用整页已知早停（knownIdsFilter）；补全模式由 backfill 跳页处理
        knownExternalIds: opts?.backfill ? undefined : known,
        maxSubmissions: opts?.maxSubmissions,
        backfill: opts?.backfill,
        backfillFromPage: opts?.backfillFromPage,
        opts,
        pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS,
      });
      // 首页有记录但一条 slug 都提取不到：接口结构变化，明确失败而非"同步成功 0 条"
      if (firstPageRows > 0 && firstPageSlugged === 0) {
        throw new Error('力扣提交列表未解析到题目标识（可能接口结构变化），请反馈或使用手动导入');
      }
      return out;
    },

    problemUrl({ problemKey }) {
      return `${BASE}/problems/${String(problemKey)}/`;
    },

    /** 校验登录态：userStatus 匿名恒为 isSignedIn=false，带 Cookie 可校验有效性 */
    async checkAuth({ cookie }) {
      if (!extractCookieValue(cookie, 'LEETCODE_SESSION')) {
        return { ok: false, message: 'Cookie 中缺少 LEETCODE_SESSION：请从浏览器登录 leetcode.cn 后复制该 Cookie' };
      }
      try {
        const data = await gql(
          fetchFn,
          'query { userStatus { username isSignedIn } }',
          {},
          { cookie },
        );
        const st = data.userStatus as { username?: string; isSignedIn?: boolean } | undefined;
        if (!st?.isSignedIn) {
          return { ok: false, message: 'Cookie 无效或已过期：请重新登录 leetcode.cn 并更新 LEETCODE_SESSION / csrftoken' };
        }
        return { ok: true, message: `Cookie 有效，已登录力扣${st.username ? `（${st.username}）` : ''}` };
      } catch (e) {
        return { ok: false, message: `无法校验力扣登录态：${(e as Error).message}` };
      }
    },
  };
}
