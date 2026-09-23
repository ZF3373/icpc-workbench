import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields, toCfRating } from '../../../shared/src/difficulty.ts';
import { ManualImportRequiredError } from './types.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { asHttpClient, sleep, type HttpInit } from './http.ts';

/**
 * 计蒜客（www.jisuanke.com，原 nanti.jisuanke.com 竞赛 OJ）适配器。
 *
 * 平台无公开提交 API，且提交记录不像洛谷/牛客有统一的「记录」页——
 * 它按「参加过的比赛」组织，前端（Vue SPA）的取数路径是：
 *
 * 1. GET /api/contests?page={n}&hasParticipated=true   → 我参加过的比赛列表（未登录返回空数组）
 * 2. GET /api/contest/problems?contestId={id}          → 该赛题目（identifier → problemId，拼题目链接用）
 * 3. GET /api/contest/submissions?contestId={id}       → 我在该赛的提交数组（未登录 302 跳登录）
 *
 * 提交行字段（chunk ContestSubmissions 的表格绑定）：hashId / identifier / title /
 * time（unix 秒）/ status / usedTime / usedMemory / language。
 * status 是 ojStatus 字符串枚举（app.js 内置 i18n 字典）：
 *   AC=通过 PE=格式错误 WA=答案错误 TL=超时 ML=内存超限 OL=输出超限
 *   RE 系=运行错误 CE/CTL=编译错误；WT0/WT1/CI/RI/CO/TF/JE/UE 为评测中/系统态，不落库。
 * 训练赛（二元结果制）会返回数字 status：0=未通过 1=通过；挑战题（challenge）则返回
 * ojStatus 字典序号（4=AC 6=WA 7=TL 8=ML 10=RE 11=CE）。两类都做了映射。
 *
 * 鉴权：纯 Cookie 鉴权（无 Authorization 头），登录态在 s 与 JSKUSS 两项（实测站点
 * 共 4 项 Cookie：acw_tc 为 CDN 项、XSRF-TOKEN 供 POST 使用，均不需要）。注意
 * 站点给未登录访客也发匿名 `s` 会话（2h 有效），因此必须复制「已登录」浏览器发出的
 * Cookie——推荐从 F12 → Network 的真实 /api 请求 Request Headers 整段复制。
 * handle 仅作账号备注（平台无公开用户名），同步完全依赖 Cookie。
 *
 * 分批模型：与页码型平台不同，本适配器的「页」=「一场比赛」（比赛内提交数少，
 * 无内部分页）。增量模式遇「整场提交全部已知」即早停；补全模式（backfill）以
 * backfillReachedPage（比赛序号）为游标跳过已知场次继续向更早补全。
 *
 * 练习（题库）提交（默认开启，settings['jisuanke.practiceSync']=false 可关）：
 * 1. 预筛 GET /api/problems?page=N&status=passed|attempted（**服务端按登录用户过滤**，
 *    实测 statuses[] / status=accepted 均不过滤，只有这两值有效；每页 20 条）；
 * 2. 逐题 GET /api/problem/submissions?problemId=X&page=N → {submissions, total}
 *    （该接口**不需要 studentUuid**，省掉一次 /api/user/info 查询）。
 * 练习行的 problemKey 用 problemIdentifier（如 T1001），与题库入库键一致，
 * 故提交与题库行自动合并、难度与标签直接复用；externalId = hashId；
 * verdict 复用 mapJisuankeVerdict；time 是 "YYYY-MM-DD HH:MM:SS" 北京时间字符串。
 *
 * 续拉游标（platform_accounts.backfill_page，单一整数字段）承载两个序号空间：
 * **负数 = 练习题目序号（取绝对值）；正数 = 比赛序号**；0/缺省 = 从头开始。
 * 练习段先于比赛段执行，任一来源截断都不会覆盖另一个的游标。
 */

const BASE = 'https://www.jisuanke.com';
const PAGE_DELAY_MS = 400; // 请求间限速，降低对站点的压力
const MAX_CONTEST_LIST_PAGES = 50; // 参赛列表分页保护上限
// 每次同步最多处理的比赛数（每场至多 2 个请求：题目表 + 提交表）：
// 30 场 × 2 请求 × 400ms ≈ 24 秒，与代码源的保守页数预算同级
const PER_SYNC_MAX_CONTESTS = 30;
// 题库列表每页条数（实测 /api/problems 分页固定 20 条）
const PAGE_SIZE_PROBLEMS = 20;
// 练习预筛翻页保护上限（实际页数 ≈ 做题数 / 20，此处只防接口异常时无限翻页）
const MAX_PRACTICE_SCAN_PAGES = 60;
// 每次同步最多处理的练习题目数（每题至少 1 个请求）：
// 40 题 × 400ms ≈ 16 秒，与比赛段的请求预算同级；超出部分由 backfill_page 游标续拉
const PER_SYNC_MAX_PRACTICE_PROBLEMS = 40;
// 单题提交翻页保护上限（防 total 异常导致无限翻页）
const MAX_PRACTICE_SUBMISSION_PAGES = 20;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * ojStatus 字符串枚举 → 统一 Verdict。
 * 评测中（WT0/WT1/CI/RI）、编译成功（CO）、测试完成（TF）、判题错误（JE）、
 * 未知错误（UE）不在表中 → null，不落库。
 */
const STATUS_TO_VERDICT: Record<string, Verdict> = {
  AC: 'AC',
  PE: 'WA', // 格式错误
  WA: 'WA',
  TL: 'TLE',
  ML: 'MLE',
  OL: 'RE', // 输出超限（与代码源 OLE→RE 同口径）
  RE: 'RE',
  RE_SEGV: 'RE',
  RE_FPE: 'RE',
  RE_BUS: 'RE',
  RE_ABRT: 'RE',
  RE_SYS: 'RE',
  CE: 'CE',
  CTL: 'CE', // 编译超时
};

/**
 * 数字 status → 统一 Verdict（兼容两种数字域）：
 * - 二元结果制训练赛：0=未通过 1=通过；
 * - 挑战题（challenge）ojStatus 字典序号：
 *   0=WT0 1=WT1 2=CI 3=RI 4=AC 5=PE 6=WA 7=TL 8=ML 9=OL 10=RE 11=CE …
 * 两域在 0/1 上冲突（WT0/WT1 vs WA/AC）：等待态只是瞬态，下次同步会以终态重新
 * 出现（hashId 相同、库中已有则跳过），按 0=WA 1=AC 取训练赛口径。
 */
const NUMERIC_STATUS_TO_VERDICT: Record<number, Verdict> = {
  0: 'WA',
  1: 'AC',
  4: 'AC',
  5: 'WA',
  6: 'WA',
  7: 'TLE',
  8: 'MLE',
  9: 'RE',
  10: 'RE',
  11: 'CE',
};

/** status（字符串或数字）→ Verdict；无法识别/评测中返回 null 跳过 */
export function mapJisuankeVerdict(status: unknown): Verdict | null {
  if (typeof status === 'number' && Number.isFinite(status)) {
    return NUMERIC_STATUS_TO_VERDICT[status] ?? null;
  }
  if (typeof status === 'string') {
    if (/^\d+$/.test(status)) return NUMERIC_STATUS_TO_VERDICT[Number(status)] ?? null;
    return STATUS_TO_VERDICT[status] ?? null;
  }
  return null;
}

/**
 * 题库 difficultyType（level1…levelN，接口亦可能给整数档）→ CF rating 近似值，供统一难度标尺。
 * 表与档位名位于 shared/src/difficulty.ts（档位总数按公开题库分布校准为 8 档）。
 * 兼容别名：既有调用点（problemBank 题库拉取）与测试依赖此名。
 */
export const jisuankeDifficultyToRating = (d: unknown): number | null => toCfRating('jisuanke', d);

/**
 * 计蒜客题目标签（`problemTags`）双类型解析：
 * - `type === 'difficulty'` 的标签是难度档位名（如「入门」），
 * - 其余（`knowledge` 等）是算法/知识点标签。
 * 两类的展示位不同（难度走 difficultyType 字段），故分开返回；非数组/空值 → 空结果。
 * 题库拉取（problemBank）与练习同步（适配器）共用这一处解析。
 */
export function parseJisuankeProblemTags(v: unknown): { difficulty: string | null; knowledge: string[] } {
  if (!Array.isArray(v)) return { difficulty: null, knowledge: [] };
  const knowledge: string[] = [];
  let difficulty: string | null = null;
  for (const t of v) {
    const name = String((t as { tagName?: string })?.tagName ?? '').trim();
    if (name === '') continue;
    if ((t as { type?: string })?.type === 'difficulty') difficulty = name;
    else knowledge.push(name);
  }
  return { difficulty, knowledge };
}

/** /api/contest/submissions 的单行（前端 ContestSubmissions 表格绑定的字段） */
export interface JisuankeSubmissionRow {
  hashId?: string;
  identifier?: string;
  title?: string;
  /** unix 秒 */
  time?: number;
  status?: string | number;
  usedTime?: number;
  usedMemory?: number;
  language?: string;
  problemId?: number;
}

/** /api/contest/problems 的单行 */
export interface JisuankeProblemRow {
  problemId?: number;
  identifier?: string;
  title?: string;
}

/** /api/contests?hasParticipated=true 的单行 */
export interface JisuankeContestRow {
  contestId: number;
  title?: string;
  /** "2026-09-05 10:00:00"（北京时间，无时区后缀） */
  startTime?: string;
}

/** /api/problems?status=passed|attempted 的单行（练习预筛用；字段实测结构） */
export interface JisuankeListProblemRow {
  problemId?: number;
  problemIdentifier?: string;
  title?: string;
  /** 难度档位（level1…levelN），未知时不产出 difficulty */
  difficultyType?: string | null;
  /** [{ tagName, type }]：type=difficulty 为难度档位名，其余为知识点标签 */
  problemTags?: unknown;
  passingRate?: number;
  /** 登录用户在该题的状态（服务端按 status 过滤时返回） */
  status?: string;
}

/** 练习题目（预筛结果，供逐题拉提交用） */
export interface JisuankePracticeProblem {
  problemId: number;
  problemIdentifier: string;
  title: string;
  difficultyType: string | null;
  /** 知识点标签（type !== 'difficulty'） */
  tags: string[];
}

/** /api/problem/submissions 的单行（字段实测结构） */
export interface JisuankePracticeSubmissionRow {
  hashId?: string;
  status?: string | number;
  /** "2026-09-13 12:37:47"（北京时间字符串，与比赛路径的 unix 秒不同） */
  time?: string;
  language?: string;
  usedTime?: number;
  usedMemory?: number;
  passedCases?: number;
  totalCases?: number;
}

/** "2026-09-05 10:00:00"（北京时间）→ epoch 毫秒；解析失败返回 0 排到最后 */
export function parseJisuankeTime(s: string | undefined): number {
  if (!s) return 0;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - 8 * 3600 * 1000;
}

/**
 * 提交时间兜底：平台偶尔缺 time 或换了格式时不能退化成 epoch 0，
 * 否则这条提交会落在 1970-01-01，把趋势图/能力值窗口/按日视图全部拉歪（牛客同款兜底）。
 */
function submittedAtFrom(ms: number): string {
  return new Date(ms > 0 ? ms : Date.now()).toISOString();
}

/** 计蒜客 problemKey（`{contestId}-{problemId|identifier}`）→ 题目页链接 */
export function jisuankeProblemUrl(problemKey: string): string {
  const m = problemKey.match(/^(\d+)-(.+)$/);
  if (m) return `${BASE}/contest/${m[1]}/problem/${m[2]}`;
  return `${BASE}/contests`;
}

interface FetchJsonOk {
  ok: true;
  body: unknown;
}
interface FetchJsonSkip {
  ok: false;
  /** true = 未登录（302 跳登录），需中断同步；false = 单场无权限等，可跳过 */
  unauthorized: boolean;
}

/** 带 Cookie 的 GET → JSON；302 视为未登录，403 视为无权限（跳过该比赛） */
async function fetchJson(
  fetchFn: HttpInit,
  url: string,
  cookie: string,
): Promise<FetchJsonOk | FetchJsonSkip> {
  const res = await asHttpClient(fetchFn).fetch(url, {
    headers: { Cookie: cookie, 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    redirect: 'manual', // 未登录时平台 302 跳登录页，不跟随
  }, { timeoutMs: 20000 });
  if (res.status === 302 || res.status === 401) return { ok: false, unauthorized: true };
  if (res.status === 403 || res.status === 404) return { ok: false, unauthorized: false };
  if (!res.ok) throw new Error(`计蒜客返回 HTTP ${res.status}，请稍后重试`);
  const body = (await res.json().catch(() => null)) as unknown;
  if (body === null) throw new Error('计蒜客返回非 JSON 响应（可能页面结构变化），请反馈或使用手动导入');
  return { ok: true, body };
}

/** 拉取全部参加过的比赛（按开始时间新→旧排序）。
 * 首页未登录（302）→ 抛 ManualImportRequiredError（否则过期 Cookie 会被误报成「没有比赛」）；
 * 空页 / 返回内容与之前重复（分页到头）→ 结束。 */
export async function fetchParticipatedContests(
  fetchFn: HttpInit,
  cookie: string,
  pageDelayMs: number = PAGE_DELAY_MS,
): Promise<JisuankeContestRow[]> {
  const out: JisuankeContestRow[] = [];
  const seenIds = new Set<number>();
  for (let page = 1; page <= MAX_CONTEST_LIST_PAGES; page += 1) {
    const r = await fetchJson(fetchFn, `${BASE}/api/contests?page=${page}&hasParticipated=true`, cookie);
    if (!r.ok) {
      if (r.unauthorized && page === 1) {
        throw new ManualImportRequiredError(
          'jisuanke',
          '登录态已失效（参赛列表跳转登录），请重新登录 www.jisuanke.com 并更新 Cookie',
        );
      }
      break; // 列表接口异常不阻断：已拿到的比赛继续处理
    }
    // 正常返回数组；防御对象形态 { past: { contests: [...] } } / { contests: [...] }
    const rows: JisuankeContestRow[] = Array.isArray(r.body)
      ? (r.body as JisuankeContestRow[])
      : ((r.body as { past?: { contests?: JisuankeContestRow[] } })?.past?.contests ??
        (r.body as { contests?: JisuankeContestRow[] })?.contests ??
        []);
    let fresh = 0;
    for (const c of rows) {
      if (typeof c?.contestId === 'number' && !seenIds.has(c.contestId)) {
        seenIds.add(c.contestId);
        out.push(c);
        fresh += 1;
      }
    }
    // 空页或整页重复（API 无总数字段，可能对未知参数回退第一页）→ 已到尽头
    if (rows.length === 0 || fresh === 0) break;
    if (pageDelayMs) await new Promise((res) => setTimeout(res, pageDelayMs));
  }
  out.sort((a, b) => parseJisuankeTime(b.startTime) - parseJisuankeTime(a.startTime));
  return out;
}

/**
 * 练习预筛：题库列表按登录用户的 status 服务端过滤（实测 status=passed|attempted 生效，
 * statuses/statuses[]/status=accepted 均不过滤，故只用这两值），两趟结果按 problemId 去重合并。
 * 每页 20 条（PAGE_SIZE_PROBLEMS），翻到空页 / 已覆盖 total / 触及 MAX_PRACTICE_SCAN_PAGES 为止。
 * 首页未登录（302/401）→ ManualImportRequiredError（过期 Cookie 不能被误报成「没有练习题」）。
 */
export async function fetchJisuankePracticeProblems(
  fetchFn: HttpInit,
  cookie: string,
  opts: { pageDelayMs?: number } = {},
): Promise<{ problems: JisuankePracticeProblem[]; pagesScanned: number }> {
  const out: JisuankePracticeProblem[] = [];
  const seen = new Set<number>();
  let pagesScanned = 0;
  for (const status of ['passed', 'attempted'] as const) {
    for (let page = 1; page <= MAX_PRACTICE_SCAN_PAGES; page += 1) {
      const r = await fetchJson(fetchFn, `${BASE}/api/problems?page=${page}&status=${status}`, cookie);
      if (!r.ok) {
        if (r.unauthorized) {
          throw new ManualImportRequiredError(
            'jisuanke',
            '登录态已失效（题库状态接口跳转登录），请重新登录 www.jisuanke.com 并更新 Cookie',
          );
        }
        break; // 非鉴权异常（403/404 等）不阻断：已拿到的题目继续处理
      }
      const body = r.body as { problems?: JisuankeListProblemRow[]; total?: number };
      const rows = Array.isArray(body?.problems) ? body.problems : [];
      pagesScanned += 1;
      for (const p of rows) {
        if (typeof p?.problemId !== 'number' || seen.has(p.problemId)) continue;
        const identifier = typeof p.problemIdentifier === 'string' ? p.problemIdentifier.trim() : '';
        if (!identifier) continue;
        seen.add(p.problemId);
        const { knowledge } = parseJisuankeProblemTags(p.problemTags);
        out.push({
          problemId: p.problemId,
          problemIdentifier: identifier,
          title: p.title?.trim() || identifier,
          difficultyType: typeof p.difficultyType === 'string' ? p.difficultyType : null,
          tags: knowledge,
        });
      }
      const total = typeof body?.total === 'number' ? body.total : rows.length;
      if (rows.length === 0 || page * PAGE_SIZE_PROBLEMS >= total) break;
      if (opts.pageDelayMs !== 0) await sleep(opts.pageDelayMs ?? PAGE_DELAY_MS);
    }
  }
  return { problems: out, pagesScanned };
}

/**
 * 单题提交（练习路径）：`/api/problem/submissions?problemId=X&page=N` → `{submissions, total}`。
 * 实测该接口**无需 studentUuid**（登录 Cookie 即可），故不再先查 /api/user/info。
 * 单题 401/302 → ManualImportRequiredError；403/404 → 空结果（该题不可见，跳过）。
 */
export async function fetchJisuankeProblemSubmissions(
  fetchFn: HttpInit,
  cookie: string,
  problemId: number,
  page: number,
): Promise<{ rows: JisuankePracticeSubmissionRow[]; total: number }> {
  const r = await fetchJson(fetchFn, `${BASE}/api/problem/submissions?problemId=${problemId}&page=${page}`, cookie);
  if (!r.ok) {
    if (r.unauthorized) {
      throw new ManualImportRequiredError(
        'jisuanke',
        '登录态已失效（练习提交接口跳转登录），请重新登录 www.jisuanke.com 并更新 Cookie',
      );
    }
    return { rows: [], total: 0 };
  }
  const body = r.body as { submissions?: JisuankePracticeSubmissionRow[]; total?: number };
  const rows = Array.isArray(body?.submissions) ? body.submissions : [];
  return { rows, total: typeof body?.total === 'number' ? body.total : rows.length };
}

export function createJisuankeAdapter(fetchFn: HttpInit = fetch): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  const requireCookie = (opts?: FetchOptions): string => {
      const cookie = opts?.cookie?.trim();
      if (!cookie) {
        throw new ManualImportRequiredError(
          'jisuanke',
          '计蒜客提交记录按「参加过的比赛」组织且需登录访问：请在设置页「计蒜客」分别填写 s 与 JSKUSS 两项会话 Cookie（实测站点仅这两项与登录相关）—— 确认浏览器已登录 www.jisuanke.com（右上角显示头像），F12 → Application → Cookies 按名复制值；未登录时站点也会发游客 s 会话，校验不过通常是缺 JSKUSS',
        );
      }
    return cookie;
  };

  return {
    platform: 'jisuanke',
    knownIdsFilter: true,

    async fetchUserSubmissions(
      _handle,
      opts,
    ): Promise<NormalizedSubmission[]> {
      const cookie = requireCookie(opts);
      const maxSubmissions = opts?.maxSubmissions;
      const out: NormalizedSubmission[] = [];
      let rowCapped = false; // 触及单次新增上限（练习段与比赛段共用 out 计数）
      // 限速等待累计到 opts.waitedMs（同步层写入 sync_runs.waited_ms 供同步中心展示）
      const sleepTracked = async (ms: number): Promise<void> => {
        if (ms > 0) {
          if (opts) opts.waitedMs = (opts.waitedMs ?? 0) + ms;
          await sleep(ms);
        }
      };
      // 请求间隔：pageDelayMs=0 仅测试用（跳过限速），缺省 PAGE_DELAY_MS
      const delayMs = opts?.pageDelayMs ?? PAGE_DELAY_MS;

      // 续拉游标解码：负数 = 练习题目序号，正数 = 比赛序号（见文件头「续拉游标」说明）
      const cursor = opts?.backfill && opts?.backfillFromPage ? opts.backfillFromPage : 0;
      const practiceStartIndex = cursor < 0 ? Math.max(1, -cursor) : 1;
      const contestStartIndex = cursor > 0 ? Math.max(1, cursor) : 1;

      // ---------- 练习（题库）提交：默认开启，见 settings['jisuanke.practiceSync'] ----------
      // days 窗口模式（windowSince 仅该模式注入）不跑练习段：窗口模式不注入 knownExternalIds，
      // 也没有可持久化的游标（同步层不改 platform_accounts），逐题全量翻页代价过大且会导入
      // 窗口外的历史提交；同时它是补充拉取，不应挤掉比赛段的请求预算。窗口模式维持旧行为（仅比赛段）。
      let hasPracticeSource = false;
      if (opts?.practiceSync !== false && !opts?.windowSince) {
        const scan = await fetchJisuankePracticeProblems(fetchFn, cookie, {
          pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS,
        });
        hasPracticeSource = scan.problems.length > 0;
        let processed = 0;
        let budgetExhausted = false;
        for (let i = practiceStartIndex - 1; i < scan.problems.length; i += 1) {
          if (processed >= PER_SYNC_MAX_PRACTICE_PROBLEMS) {
            budgetExhausted = true; // 题目预算耗尽：余下题目由游标续拉
            break;
          }
          const p = scan.problems[i];
          processed += 1;

          // 增量判据（每题先取第 1 页）：该页提交全部已知且 total ≤ 已返回条数 → 该题无新增，
          // 1 次请求即跳过；否则继续翻页直到 total 覆盖（全新提交的题才付多次请求的成本）
          const first = await fetchJisuankeProblemSubmissions(fetchFn, cookie, p.problemId, 1);
          const rows = [...first.rows];
          let total = first.total;
          for (let page = 2; rows.length < total && page <= MAX_PRACTICE_SUBMISSION_PAGES; page += 1) {
            const next = await fetchJisuankeProblemSubmissions(fetchFn, cookie, p.problemId, page);
            if (next.rows.length === 0) break; // 空页：total 与实际不符时不要空转
            total = Math.max(total, next.total);
            rows.push(...next.rows);
            if (rows.length < total) await sleepTracked(delayMs);
          }

          const known = opts?.knownExternalIds;
          const knownVerdicts = opts?.knownVerdicts;
          // 「无新增」判据：不仅全部已知，还要求库中存储 verdict 与平台侧当前判定一致——
          // 平台侧改判（挑战题 WT0 曾按二元域落库为 WA、平台重判等）的行要重新处理并刷新
          const allKnownUnchanged =
            rows.length > 0 &&
            rows.every((r) => {
              const id = String(r.hashId ?? '');
              if (!known?.has(id)) return false;
              const v = mapJisuankeVerdict(r.status);
              // knownVerdicts 未注入（旧调用方）→ 按「无改判」处理，维持原跳过语义
              return v !== null && (knownVerdicts?.get(id) ?? v) === v;
            });
          if (!(allKnownUnchanged && rows.length >= total)) {
            for (const row of rows) {
              const externalId = String(row.hashId ?? '');
              if (externalId === '') continue;
              const verdict = mapJisuankeVerdict(row.status);
              if (verdict === null) continue; // 评测中/系统态不落库
              if (known?.has(externalId)) {
                // 已入库：仅平台侧改判（存储 verdict ≠ 本次判定）时重发，交由写入层刷新既有行
                if ((knownVerdicts?.get(externalId) ?? verdict) === verdict) continue;
              }
              out.push({
                problem: {
                  platform: 'jisuanke' as PlatformId,
                  // 练习键用 problemIdentifier（如 T1001）：与题库入库键一致，自动合并且难度/标签复用题库行
                  problemKey: p.problemIdentifier,
                  title: p.title,
                  ...difficultyFields('jisuanke', p.difficultyType),
                  url: `${BASE}/problem/${encodeURIComponent(p.problemIdentifier)}`,
                  tags: p.tags,
                },
                verdict,
                ...(row.language ? { language: row.language } : {}),
                submittedAt: submittedAtFrom(parseJisuankeTime(row.time)),
                externalId,
              });
              if (maxSubmissions && out.length >= maxSubmissions) {
                rowCapped = true;
                break;
              }
            }
          }
          if (rowCapped) break;
          await sleepTracked(delayMs);
        }

        // 练习段被截断（题目预算耗尽 / 触及新增上限）：本轮到此为止，回写「练习题目序号」游标
        // （负数，与比赛序号区分）；比赛段留到后续轮次，避免一次同步叠加两段请求预算
        if (budgetExhausted || rowCapped) {
          if (opts) {
            opts.truncated = true;
            opts.backfillReachedPage = -(practiceStartIndex - 1 + processed);
          }
          return out;
        }
      }

      const contests = await fetchParticipatedContests(fetchFn, cookie, opts?.pageDelayMs ?? PAGE_DELAY_MS);
      if (contests.length === 0) {
        // 只有练习（从不参赛）的账号：练习段已同步完成，参赛列表为空不是错误
        if (hasPracticeSource) return out;
        throw new ManualImportRequiredError(
          'jisuanke',
          '参赛列表为空：请确认 Cookie 有效且该账号在 www.jisuanke.com 上有练习题（题库）或参加过至少一场比赛',
        );
      }

      const startIndex = contestStartIndex;
      let processed = 0;
      let caughtUp = false; // 增量模式：整场提交全部已知 → 更早的比赛都在库中
      const outBeforeContests = out.length; // 截断判定只看比赛段新增（练习段行数不算在内）

      for (let i = startIndex - 1; i < contests.length; i += 1) {
        if (processed >= PER_SYNC_MAX_CONTESTS) break;
        const contest = contests[i];
        processed += 1;

        // 提交数组（未登录 302 → 中断；单场无权限/无提交 → 跳过该场）
        const subRes = await fetchJson(
          fetchFn,
          `${BASE}/api/contest/submissions?contestId=${contest.contestId}`,
          cookie,
        );
        if (!subRes.ok) {
          if (subRes.unauthorized) {
            throw new ManualImportRequiredError(
              'jisuanke',
              '登录态已失效（提交接口跳转登录），请重新登录 www.jisuanke.com 并更新 Cookie',
            );
          }
          continue;
        }
        // HasNoSubmissions 等错误以 {error: "..."} 对象返回，同样视为空场
        const rows: JisuankeSubmissionRow[] = Array.isArray(subRes.body)
          ? (subRes.body as JisuankeSubmissionRow[])
          : [];
        if (rows.length === 0) continue;

        // 行内通常不带 problemId（路由 /contest/:id/problem/:problemId 需要它），
        // 拉题目表建 identifier → problemId 映射；失败则退化为 identifier
        const problemIds = new Map<string, number>();
        if (rows.some((r) => typeof r.problemId !== 'number')) {
          const probRes = await fetchJson(
            fetchFn,
            `${BASE}/api/contest/problems?contestId=${contest.contestId}`,
            cookie,
          );
          if (probRes.ok) {
            const probRows: JisuankeProblemRow[] = Array.isArray(probRes.body)
              ? (probRes.body as JisuankeProblemRow[])
              : ((probRes.body as { problems?: JisuankeProblemRow[] })?.problems ?? []);
            for (const p of probRows) {
              if (typeof p?.problemId === 'number' && p.identifier) {
                problemIds.set(p.identifier, p.problemId);
              }
            }
          }
        }

        rows.sort((a, b) => (b.time ?? 0) - (a.time ?? 0)); // 新→旧
        // 行落库统一入口：返回 true 表示已触及单次新增上限（调用方需 break）
        const emit = (row: JisuankeSubmissionRow, verdict: Verdict, externalId: string): boolean => {
          const pid = String(row.problemId ?? problemIds.get(row.identifier ?? '') ?? row.identifier ?? '');
          out.push({
            problem: {
              platform: 'jisuanke' as PlatformId,
              problemKey: `${contest.contestId}-${pid}`,
              title: row.title || row.identifier || String(pid),
              ...difficultyFields('jisuanke', null), // 比赛提交行不含难度档位：由题库/回填路径补齐
              url: jisuankeProblemUrl(`${contest.contestId}-${pid}`),
              tags: [],
            },
            verdict,
            ...(row.language ? { language: row.language } : {}),
            submittedAt: submittedAtFrom((row.time ?? 0) * 1000),
            externalId,
          });
          return maxSubmissions != null && out.length >= maxSubmissions;
        };
        let knownInContest = 0;
        let storedOrSkipped = 0;
        for (const row of rows) {
          const externalId = String(row.hashId ?? `${contest.contestId}-${row.identifier ?? '?'}-${row.time ?? 0}`);
          const verdict = mapJisuankeVerdict(row.status);
          if (opts?.knownExternalIds?.has(externalId)) {
            knownInContest += 1;
            storedOrSkipped += 1;
            // 已入库：仅平台侧改判（存储 verdict ≠ 本次判定）时重发刷新，其余跳过
            const stored = opts?.knownVerdicts?.get(externalId);
            if (verdict === null || (stored ?? verdict) === verdict) continue;
            if (emit(row, verdict, externalId)) {
              rowCapped = true;
              break;
            }
            continue;
          }
          if (verdict === null) continue; // 评测中/系统态不落库，也不计入已知
          storedOrSkipped += 1;
          if (emit(row, verdict, externalId)) {
            rowCapped = true;
            break;
          }
        }
        // 整场全部已知（且确有可入库的行）：增量模式早停——更早的比赛都在库中；
        // 补全模式不早停，跳过已知场继续向更早翻页（与 pagedFetch 语义一致）
        if (
          !opts?.backfill &&
          opts?.knownExternalIds &&
          storedOrSkipped > 0 &&
          knownInContest === storedOrSkipped &&
          !rowCapped
        ) {
          caughtUp = true;
          break;
        }
        if (rowCapped) break;
        await sleepTracked(delayMs);
      }

      // 截断判定：触及新增上限，或比赛数预算耗尽（未自然扫完/未增量早停）且比赛段有新增。
      // backfill 且预算耗尽、还有未扫比赛时，即使 0 新增也要如实回写截断——否则
      // sync_truncated/backfill_page 被同步层清空，第 N 场之后的比赛被永久放弃
      // （全已知比赛段 + 比赛预算 < 总场数时恰好命中此死端）。
      const exhausted = processed >= PER_SYNC_MAX_CONTESTS;
      const hasMore = startIndex - 1 + processed < contests.length;
      const truncated =
        rowCapped || (!caughtUp && exhausted && (out.length > outBeforeContests || (opts?.backfill && hasMore)));
      if (truncated && opts) {
        opts.truncated = true;
        opts.backfillReachedPage = startIndex - 1 + processed; // 本次处理到的比赛序号（正数），下次续拉
      }
      return out;
    },

    problemUrl({ problemKey }) {
      const key = String(problemKey);
      // 练习键是 problemIdentifier（T1001），比赛键是 `{contestId}-{problemId}`：前者走题库题面链接
      return /^\d+-/.test(key) ? jisuankeProblemUrl(key) : `${BASE}/problem/${encodeURIComponent(key)}`;
    },

    /** 校验登录态：/api/user/info 登录后响应含 uuid/name 等用户字段（未登录仅返回 websocket 配置）。
     *  带 X-Requested-With 让未登录返回 401 JSON 而非 302 跳转页 */
    async checkAuth({ cookie }) {
      try {
        const res = await http.fetch(`${BASE}/api/user/info`, {
          headers: { Cookie: cookie, 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          redirect: 'manual',
        }, { timeoutMs: 15000 });
        if (res.status === 302 || res.status === 401) {
          return { ok: false, message: 'Cookie 未通过登录校验：需要 s 与 JSKUSS 两项会话 Cookie，只填 s 一项不够——请在设置页「计蒜客」两个输入框分别填写（确认浏览器已登录后，从 F12 → Application → Cookies 按名复制）' };
        }
        if (!res.ok) {
          return { ok: false, message: `计蒜客返回 HTTP ${res.status}，请稍后重试` };
        }
        const body = (await res.json().catch(() => null)) as { uuid?: string; name?: string } | null;
        if (body && typeof body.uuid === 'string' && body.uuid) {
          return { ok: true, message: `Cookie 有效${body.name ? `，当前用户：${body.name}` : ''}` };
        }
        return { ok: false, message: 'Cookie 未通过登录校验：需要 s 与 JSKUSS 两项会话 Cookie，只填 s 一项不够——请在设置页「计蒜客」两个输入框分别填写（确认浏览器已登录后，从 F12 → Application → Cookies 按名复制）' };
      } catch (e) {
        return { ok: false, message: `无法连接计蒜客：${(e as Error).message}` };
      }
    },
  };
}
