import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields } from '../../../shared/src/difficulty.ts';
import { SyncError, type FetchOptions, type PlatformAdapter } from './types.ts';
import { markTruncated, pageBudget, recordWait } from './pagination.ts';
import { asHttpClient, sleep, type HttpClient, type HttpInit } from './http.ts';

/**
 * PTA（拼题 A / pintia.cn）适配器。
 *
 * 站点由浙江大学运维，承载 PAT 甲/乙/顶级、团体程序设计天梯赛、浙大版教材题目集、
 * ZOJ 题库，以及大量高校课程作业与内部赛。**没有公开的 API 文档**，但 Web 端调用的
 * 一套 REST 接口对游客基本开放（2026-11 对线上实测确认），本适配器全部基于它实现：
 *
 * | 用途 | 接口 | 匿名 |
 * | --- | --- | --- |
 * | 公开题集清单 | `GET /api/problem-sets/always-available` | ✅ 23 套 |
 * | 我加入的题集 | `GET /api/problem-sets?filter={...}` | ❌ 需 PTASession |
 * | 题集题目表 | `GET /api/problem-sets/{ps}/exam-problem-list?problem_type=PROGRAMMING&page=&limit=` | ✅ |
 * | 某用户提交 | `GET /api/problem-sets/{ps}/users/{uid}/submissions?limit=&before=` | ✅ |
 * | 当前登录用户 | `GET https://passport.pintia.cn/api/u/current` | ❌ |
 *
 * 几个只有实测才知道的关键事实（写死在这里的业务知识，改动前先用真实账号复核）：
 *
 * 1. **提交列表只能按题集查**。站点没有「我的全部提交」接口，`/api/submissions` 不带题集
 *    路径时一律 406。因此一次同步 = 「枚举题集 × 逐集翻页」。这与计蒜客「按参加过的比赛
 *    组织」同构，但 PTA 的题集清单**匿名可得**，所以不强制 Cookie。
 * 2. **匿名可查任意用户的提交**（`/users/{uid}/submissions` 实测 200）。这让「不配 Cookie
 *    也能同步公开题集的刷题记录」成立；但「我加入的题集」（课程作业、内部赛）只能登录后
 *    枚举，故 `PLATFORMS` 把 sync 记为 cookie、Cookie 视为**覆盖度增强**而非必需品。
 * 3. **handle 必须是数字 userId**。同一个接口换昵称直接 400——用户从个人主页地址栏
 *    `pintia.cn/user/{数字}` 复制即可；填昵称时这里抛出 invalid_account 而不是当作
 *    「页面结构变化」，让用户能自己修好。
 * 4. **分页是 cursor 而非页码**：`before={上一页最后一条的提交 id}`，`hasBefore` 表示还有更旧。
 *    `page`/`offset` 参数会被忽略（实测翻页参数换了十几种写法返回的都是第一页），
 *    照页码翻会让同一页被无限重扫。
 * 5. **题集内的提交行不带题目标题**（`problemSetProblemById[].title` 实测恒为空串），
 *    标题只能从题集的题目表 `exam-problem-list` 拿。故只对「本集确实拉到了新提交」的
 *    题集补拉一次题目表，避免为 23 套题集无脑多打 23 次请求。
 * 6. **平台没有难度字段**：`exam-problem-list` 的 `difficulty` 恒为 0（23 套题集实测全 0）。
 *    按项目规则「未知一律 null，不猜」，`difficulty` 不下发、标度记 none。
 *
 * 身份口径：题目的 `problemKey` 取 `{problemSetId}-{problemSetProblemId}`（与计蒜客的
 * `{contestId}-{problemId}` 同构）。`problemSetProblemId` 在全站范围内看似唯一，但把它们
 * 按题集分段不会丢失任何信息，且能防住「某天两套题集复用同一个 id」时两道题被合并成一道。
 * 不采用题目详情里的全局 `problemId`：同一道题（如「一元多项式求导」）在 PAT 乙级与
 * 数据结构题目集里的 `problemId` 分别是 10069 与 603，站点把它们当两道题，键也就该分开。
 */

const BASE = 'https://pintia.cn';
/** 当前登录用户信息在 passport 子域，不在主站 */
const PASSPORT_BASE = 'https://passport.pintia.cn';

/** 提交列表服务端默认每页 20；实测 `limit` 上限 200（再大按 200 处理） */
const PAGE_SIZE = 200;
/** 单个题集每次同步最多翻几页（200×4 = 800 条/集，足够覆盖绝大多数账号） */
const PER_SET_MAX_PAGES = 4;
/**
 * 每次同步的全局页数上限。
 *
 * PTA 的提交列表**只能按题集查**，所以一次同步天然要打「题集数」次请求（公开题集 23 套）。
 * 因此预算不能直接套 pagedFetch 的 pageBudget（那是给单一列表用的：默认上限 300 条 →
 * 4 页，连第一轮题集都扫不完），而是取 max(题集数, pageBudget)：**保证每套题集至少被
 * 看一眼**（增量的「整页已知即跳过」正是靠这一次请求判定的），再按单次新增上限追加页数。
 */
const PER_SYNC_MAX_PAGES = 60;
/** 页间限速（与全局按域名节流取较大者，缺省 1200ms 见 hostThrottle） */
const PAGE_DELAY_MS = 1200;
/** 题集题目表每次最多翻几页（limit=200 → 1200 题）：只用于把标题补全，不值得为 ZOJ 的 3179 题翻 16 页 */
const TITLE_LIST_MAX_PAGES = 5;
/** `exam-problem-list` 单页上限 */
const TITLE_PAGE_SIZE = 200;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * PTA 提交状态 → 统一 Verdict（枚举取自站点前端 SubmissionStatus 字典，2026-11 实测）。
 * 返回 null 的行**不落库**：评测中（WAITING/JUDGING/REJUDGING）与不可靠终态
 * （NO_ANSWER/OVERRIDDEN/NEUTRAL）都不是「这次提交的结果」。
 *
 * 归并有据的两处：
 * - OUTPUT_LIMIT_EXCEEDED 归 RE —— 与代码源 / 计蒜客 / QOJ 同口径（输出超限是运行时行为）。
 * - PARTIAL_ACCEPTED 归 WA —— 平台明确给了「部分正确」这个终态，按「没有全部通过」计入未通过；
 *   AC 率与弱项分析只关心是否通过，不臆造第五种判定。
 * - MULTIPLE_ERROR / INTERNAL_ERROR / CHECKER_ERROR / INTERACTOR_ERROR / SAMPLE_ERROR
 *   归 RE：平台只给出「多种错误 / 判题侧异常」，列表页无法拆分具体原因，按最常见的运行期
 *   失败归类，不猜成 TLE/MLE。
 */
const STATUS_TO_VERDICT: Record<string, Verdict> = {
  ACCEPTED: 'AC',
  PARTIAL_ACCEPTED: 'WA',
  WRONG_ANSWER: 'WA',
  PRESENTATION_ERROR: 'WA',
  TIME_LIMIT_EXCEEDED: 'TLE',
  TOTAL_TIME_LIMIT_EXCEEDED: 'TLE',
  MEMORY_LIMIT_EXCEEDED: 'MLE',
  OUTPUT_LIMIT_EXCEEDED: 'RE',
  RUNTIME_ERROR: 'RE',
  SEGMENTATION_FAULT: 'RE',
  FLOAT_POINT_EXCEPTION: 'RE',
  NON_ZERO_EXIT_CODE: 'RE',
  MULTIPLE_ERROR: 'RE',
  INTERNAL_ERROR: 'RE',
  CHECKER_ERROR: 'RE',
  INTERACTOR_ERROR: 'RE',
  SAMPLE_ERROR: 'RE',
  COMPILE_ERROR: 'CE',
  // WAITING / JUDGING / REJUDGING / NO_ANSWER / OVERRIDDEN / NEUTRAL / SKIPPED 不在表中 → null
};

/** 题集条目（`always-available` 或「我加入的题集」共用结构） */
export interface PtaProblemSet {
  id: string;
  name: string;
  /** BOOK / EXERCISE / EXAM …（仅用于诊断展示） */
  type?: string;
}

/** 题集题目表里的一行（只取需要的字段） */
export interface PtaProblemListItem {
  id: string;
  label?: string;
  title?: string;
  type?: string;
}

/** `/users/{uid}/submissions` 的一行（PROJECTION 实测字段） */
export interface PtaSubmissionRow {
  id: string;
  userId?: string;
  problemSetProblemId?: string;
  submitAt?: string;
  status?: string;
  score?: number;
  compiler?: string;
  previewSubmission?: boolean;
}

/** 提交列表响应体 */
export interface PtaSubmissionPage {
  submissions?: PtaSubmissionRow[];
  /** 更旧的一页是否还存在（cursor 分页的终止判据） */
  hasBefore?: boolean;
  /** 请求页之后是否还有更新的提交（按 before 翻页时恒 false，保留字段用于诊断） */
  hasAfter?: boolean;
  problemSetProblemById?: Record<string, PtaProblemListItem>;
}

/** PTA 的 `error.code`（登录失效 / 参数不合法等都在这里） */
export function ptaErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * 题目的稳定键：`{problemSetId}-{problemSetProblemId}`。
 * 两个 id 都是纯数字串；任一侧不是数字形态时返回 null（畸形行按跳过处理）。
 */
export function ptaProblemKey(problemSetId: string, problemSetProblemId: string): string | null {
  const ps = String(problemSetId ?? '').trim();
  const psp = String(problemSetProblemId ?? '').trim();
  if (!/^\d+$/.test(ps) || !/^\d+$/.test(psp)) return null;
  return `${ps}-${psp}`;
}

/** 题目页地址：`/problem-sets/{ps}/problems/{psp}`（实测 200，游客可读） */
export function ptaProblemUrl(problemKey: string): string {
  const key = String(problemKey ?? '').trim();
  const m = /^(\d+)-(\d+)$/.exec(key);
  // 裸数字（手动导入/历史行）：站点有 /problems/{problemId} 这个别名页，至少能跳过去
  if (!m) return /^\d+$/.test(key) ? `${BASE}/problems/${key}` : BASE;
  return `${BASE}/problem-sets/${m[1]}/problems/${m[2]}`;
}

/** 账号 handle → 数字 userId；不合法返回 null（站点按路径参数取用户，昵称一律 400） */
export function parsePtaUserId(handle: string): string | null {
  const h = String(handle ?? '').trim();
  return /^\d+$/.test(h) ? h : null;
}

/** 提交时间归一：`submitAt` 是 ISO8601 UTC；非法值返回 null（坏行跳过，保住其余行） */
export function ptaSubmittedAt(row: PtaSubmissionRow): string | null {
  const raw = typeof row.submitAt === 'string' ? row.submitAt.trim() : '';
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** 状态原文 → 统一 Verdict；未知/评测中返回 null（不落库、也不计入已知） */
export function mapPtaVerdict(status: unknown): Verdict | null {
  const key = typeof status === 'string' ? status.trim().toUpperCase() : '';
  return key === '' ? null : STATUS_TO_VERDICT[key] ?? null;
}

/** 解析「公开题集清单」响应 */
export function parsePtaProblemSets(body: unknown): PtaProblemSet[] {
  const list = (body as { problemSets?: unknown })?.problemSets;
  if (!Array.isArray(list)) return [];
  const out: PtaProblemSet[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const id = String((item as { id?: unknown }).id ?? '').trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = String((item as { name?: unknown }).name ?? '').trim();
    const type = String((item as { type?: unknown }).type ?? '').trim();
    out.push({ id, name: name || `PTA 题集 ${id}`, ...(type ? { type } : {}) });
  }
  return out;
}

/** 解析「题集题目表」一页；`total` 供调用方决定还要不要继续翻页 */
export function parsePtaProblemList(body: unknown): { items: PtaProblemListItem[]; total: number | null } {
  const b = body as { problemSetProblems?: unknown; total?: unknown } | null;
  const raw = Array.isArray(b?.problemSetProblems) ? b!.problemSetProblems : [];
  const items: PtaProblemListItem[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const id = String((row as { id?: unknown }).id ?? '').trim();
    if (!/^\d+$/.test(id)) continue;
    const label = String((row as { label?: unknown }).label ?? '').trim();
    const title = String((row as { title?: unknown }).title ?? '').trim();
    const type = String((row as { type?: unknown }).type ?? '').trim();
    items.push({ id, ...(label ? { label } : {}), ...(title ? { title } : {}), ...(type ? { type } : {}) });
  }
  const total = typeof b?.total === 'number' && Number.isFinite(b.total) ? b.total : null;
  return { items, total };
}

/** 一句话说清 PTA 的 handle 要求（设置页与错误消息共用同一段文案） */
export const PTA_HANDLE_HINT =
  '账号请填写**数字 userId**（浏览器打开 pintia.cn 个人主页，地址栏 /user/ 后面那串数字），昵称不能作为查询参数';

/**
 * 从 passport `/api/u/current` 的响应体里取出登录身份。
 *
 * 两点只有实测才知道：
 * 1. **未登录也返回 200**，给的是一个「空身份」对象（各 login 标志全 false、无 id/nickname）。
 *    所以判定只能看内容，不能看状态码——与站点前端同一口径（`isGuest = !id`）。
 * 2. 未登录身份里的 `id` 是字符串 `"0"`（见站点前端模型默认值），不是缺字段。
 *    因此必须要求 id 是**正的非零数字**，否则会把匿名响应当成 userId=0 的账号。
 *
 * 响应体形状两种都见过（`{ user: {...} }` 与直接平铺），故两者都接受。
 */
export function ptaIdentity(body: unknown): { id: string; nickname?: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const wrapped = (body as { user?: unknown }).user;
  const user = (typeof wrapped === 'object' && wrapped !== null ? wrapped : body) as Record<string, unknown>;
  const id = String(user.id ?? '').trim();
  const nickname = typeof user.nickname === 'string' ? user.nickname.trim() : '';
  const hasIdentity = ['id', 'nickname', 'name', 'email', 'phone', 'realName'].some(
    (k) => user[k] !== undefined && user[k] !== null && user[k] !== '',
  );
  const loggedIn = ['emailLogin', 'phoneLogin', 'omsLogin', 'studentUserLogin'].some((k) => user[k] === true);
  if (!hasIdentity && !loggedIn) return null;
  if (!/^[1-9]\d*$/.test(id)) return null;
  return { id, ...(nickname ? { nickname } : {}) };
}

/**
 * 查 passport 的当前登录身份（checkAuth / identify 共用的一次请求）。
 * 失败一律返回可展示的中文原因，不抛异常——这两个入口都是「给用户的反馈」而非同步主体。
 */
async function callCurrentUser(
  http: HttpClient,
  cookie: string,
): Promise<{ ok: true; identity: { id: string; nickname?: string } } | { ok: false; message: string }> {
  try {
    const res = await http.fetch(
      `${PASSPORT_BASE}/api/u/current`,
      { headers: { 'User-Agent': UA, Accept: 'application/json;charset=UTF-8', Cookie: cookie } },
      { timeoutMs: 15000 },
    );
    if (!res.ok) return { ok: false, message: `PTA 返回 HTTP ${res.status}，请稍后重试` };
    const body = await res.json().catch(() => null);
    if (body === null) return { ok: false, message: 'PTA 返回非 JSON 响应，请稍后重试' };
    const identity = ptaIdentity(body);
    if (identity === null) {
      return { ok: false, message: 'PTASession 无效或已过期：请重新登录 pintia.cn 后复制 PTASession 的值' };
    }
    return { ok: true, identity };
  } catch (e) {
    return { ok: false, message: `无法连接 PTA：${(e as Error).message}` };
  }
}

export function createPtaAdapter(fetchFn: HttpInit = fetch): PlatformAdapter {
  const http = asHttpClient(fetchFn);

  const baseHeaders = (cookie?: string): Record<string, string> => ({
    'User-Agent': UA,
    Accept: 'application/json;charset=UTF-8',
    Referer: `${BASE}/`,
    ...(cookie ? { Cookie: cookie } : {}),
  });

  /**
   * 单次 JSON 请求：统一把 PTA 的三种「非预期」翻译成本项目能理解的错误。
   * - 406：站点对「参数/路径不存在的接口」返回空体 406（Spring 的内容协商异常），
   *   与 404 同义 —— 说明接口变了，属于 schema_changed。
   * - 401 + USER_NOT_LOGGED_IN：需要登录的接口（未配 Cookie 时的「我加入的题集」）。
   * - 400 + USER_NOT_FOUND：handle 不是有效 userId。
   */
  async function getJson(
    url: string,
    opts: { cookie?: string; timeoutMs?: number; label: string },
  ): Promise<{ status: number; body: unknown }> {
    const res = await http.fetch(url, { headers: baseHeaders(opts.cookie) }, { timeoutMs: opts.timeoutMs ?? 20000 });
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (res.status === 406) {
      throw new SyncError('schema_changed', `${opts.label}：PTA 接口返回 406（接口地址或参数已变化），请反馈或改用其他平台通道`);
    }
    if (res.status === 400) {
      const code = ptaErrorCode(body);
      if (code === 'USER_NOT_FOUND') {
        throw new SyncError('invalid_account', `${opts.label}：PTA 未找到该用户 —— ${PTA_HANDLE_HINT}`);
      }
      throw new SyncError('schema_changed', `${opts.label}：PTA 拒绝了请求（400 ${code ?? '未知原因'}）`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new SyncError('auth_expired', `${opts.label}：PTA 要求登录（${ptaErrorCode(body) ?? `HTTP ${res.status}`}），请更新 PTASession Cookie`);
    }
    if (res.status === 429 || res.status === 503) {
      throw new SyncError('rate_limited', `${opts.label}：PTA 限流（HTTP ${res.status}），请稍后再同步`);
    }
    if (!res.ok) {
      throw new SyncError('unknown', `${opts.label}：PTA 返回 HTTP ${res.status}`);
    }
    if (body === null) {
      throw new SyncError('schema_changed', `${opts.label}：PTA 返回非 JSON 响应（页面结构可能已变化）`);
    }
    return { status: res.status, body };
  }

  /** 公开题集清单（匿名可读） */
  async function fetchPublicProblemSets(cookie?: string): Promise<PtaProblemSet[]> {
    const { body } = await getJson(`${BASE}/api/problem-sets/always-available`, {
      ...(cookie ? { cookie } : {}),
      label: 'PTA 公开题集清单',
    });
    return parsePtaProblemSets(body);
  }

  /**
   * 「我加入的题集」：需登录。
   * 失败**不致命**——公开题集仍然能同步，只是覆盖不到课程/内部赛，
   * 因此登录失效 / 接口变化一律降级成空表；网络层异常照常抛（那是全局故障，不该被吞）。
   */
  async function fetchMyProblemSets(cookie: string): Promise<PtaProblemSet[]> {
    const now = new Date().toISOString();
    const filter = encodeURIComponent(JSON.stringify({ endAtAfter: now }));
    try {
      const { body } = await getJson(`${BASE}/api/problem-sets?filter=${filter}`, {
        cookie,
        label: 'PTA 我的题集',
        timeoutMs: 20000,
      });
      return parsePtaProblemSets(body);
    } catch (e) {
      // 登录失效 / 接口变化都不该让整次同步失败：公开题集照常同步
      if (e instanceof SyncError && (e.code === 'auth_expired' || e.code === 'schema_changed')) return [];
      throw e;
    }
  }

  /** 某题集里当前用户的提交分页（cursor：before = 上一页最后一条的 id） */
  async function fetchSubmissionPage(
    problemSetId: string,
    userId: string,
    before: string | null,
    cookie?: string,
  ): Promise<PtaSubmissionPage> {
    const url =
      `${BASE}/api/problem-sets/${problemSetId}/users/${userId}/submissions` +
      `?limit=${PAGE_SIZE}` +
      (before ? `&before=${encodeURIComponent(before)}` : '');
    const { body } = await getJson(url, {
      ...(cookie ? { cookie } : {}),
      label: `PTA 题集 ${problemSetId} 的提交记录`,
    });
    const page = body as PtaSubmissionPage;
    return {
      submissions: Array.isArray(page?.submissions) ? page.submissions : [],
      hasBefore: page?.hasBefore === true,
      hasAfter: page?.hasAfter === true,
      ...(page?.problemSetProblemById && typeof page.problemSetProblemById === 'object'
        ? { problemSetProblemById: page.problemSetProblemById }
        : {}),
    };
  }

  /**
   * 题集题目表 → `problemSetProblemId → 标题/题号`（提交行本身不带标题，见文件头第 5 条）。
   * 任何失败都回退空表：标题缺失只会让题目退化显示题号，不该让整次同步失败。
   */
  async function fetchTitleMap(problemSetId: string, cookie?: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      for (let page = 0; page < TITLE_LIST_MAX_PAGES; page += 1) {
        const { body } = await getJson(
          `${BASE}/api/problem-sets/${problemSetId}/exam-problem-list?problem_type=PROGRAMMING&page=${page}&limit=${TITLE_PAGE_SIZE}`,
          { ...(cookie ? { cookie } : {}), label: `PTA 题集 ${problemSetId} 的题目表` },
        );
        const { items, total } = parsePtaProblemList(body);
        if (items.length === 0) break;
        for (const it of items) {
          const label = it.title || it.label || '';
          if (label) map.set(it.id, label);
        }
        if (total !== null && page * TITLE_PAGE_SIZE + items.length >= total) break;
        if (items.length < TITLE_PAGE_SIZE) break;
        await sleep(PAGE_DELAY_MS);
      }
    } catch {
      // 题目表拉不到就只丢标题：不抛错（与同步主体解耦）
    }
    return map;
  }

  return {
    platform: 'pta',
    knownIdsFilter: true,

    async fetchUserSubmissions(handle, opts?: FetchOptions): Promise<NormalizedSubmission[]> {
      const userId = parsePtaUserId(handle);
      if (userId === null) {
        throw new SyncError(
          'invalid_account',
          `PTA ${PTA_HANDLE_HINT}；当前填写的是「${String(handle ?? '').trim()}」`,
        );
      }
      const cookie = opts?.cookie?.trim() || undefined;
      // 题集清单：公开的永远有；登录后再并上「我加入的」
      const publicSets = await fetchPublicProblemSets(cookie);
      const mySets = cookie ? (await fetchMyProblemSets(cookie)) ?? [] : [];
      const sets: PtaProblemSet[] = [];
      const seenSet = new Set<string>();
      for (const ps of [...mySets, ...publicSets]) {
        if (seenSet.has(ps.id)) continue;
        seenSet.add(ps.id);
        sets.push(ps);
      }
      if (sets.length === 0) {
        throw new SyncError('schema_changed', 'PTA 未返回任何题集（接口可能已变化），请反馈或稍后重试');
      }

      const maxSubmissions = opts?.maxSubmissions ?? 0;
      // 见 PER_SYNC_MAX_PAGES 注释：题集数是预算的下限，rowCap 只决定追加多少页
      const budget = Math.max(
        sets.length,
        pageBudget(maxSubmissions || undefined, PAGE_SIZE, PER_SYNC_MAX_PAGES),
      );
      const delayMs = opts?.pageDelayMs ?? PAGE_DELAY_MS;
      const known = opts?.knownExternalIds;
      const knownVerdicts = opts?.knownVerdicts;
      const windowSince = opts?.windowSince;
      const backfill = opts?.backfill === true;

      const out: NormalizedSubmission[] = [];
      const seenSubmission = new Set<string>();
      let pagesUsed = 0;
      let rowCapped = false;
      let budgetExhausted = false;
      let windowEnd = false;
      /** 本次真的产生了新行的题集：只有它们值得再花请求去补题目标题 */
      const setsWithNewRows = new Set<string>();

      const sleepTracked = async (ms: number): Promise<void> => {
        if (ms <= 0) return;
        recordWait(opts, ms);
        await sleep(ms);
      };

      /**
       * 单集：cursor 翻页直到尽头 / 预算耗尽 / 触及新增上限。
       * 返回 'done' 表示这套题集本次已处理完（增量追平 / 已到最旧一页 / 触到单集页上限），
       * 返回 'budget' 表示页预算被这套吃掉、还没处理完 —— 调用方据此登记续拉游标。
       */
      const scanSet = async (ps: PtaProblemSet): Promise<'done' | 'budget'> => {
        let before: string | null = null;
        let setPages = 0;
        let knownRun = 0;
        for (let page = 0; page < PER_SET_MAX_PAGES; page += 1) {
          if (pagesUsed >= budget) {
            budgetExhausted = true;
            return 'budget';
          }
          const res = await fetchSubmissionPage(ps.id, userId, before, cookie);
          pagesUsed += 1;
          setPages += 1;
          const rows = res.submissions ?? [];
          if (rows.length === 0) return 'done'; // 该集已到尽头
          const last = rows[rows.length - 1];
          before = String(last.id ?? '') || null;

          let knownInPage = 0;
          let emittedInPage = 0;
          for (const row of rows) {
            const externalId = String(row.id ?? '').trim();
            if (!externalId || seenSubmission.has(externalId)) continue;
            seenSubmission.add(externalId);
            const verdict = mapPtaVerdict(row.status);
            const isKnown = known?.has(externalId) === true;
            if (isKnown) {
              knownInPage += 1;
              // 已入库：仅在平台侧改判（存储 verdict ≠ 本次判定）时重发，交由写入层刷新既有行
              const stored = knownVerdicts?.get(externalId);
              if (verdict === null || stored === undefined || stored === verdict) continue;
            } else if (verdict === null) {
              continue; // 评测中 / 不可靠终态：不落库，也不计入已知
            }
            const submittedAt = ptaSubmittedAt(row);
            if (submittedAt === null) continue; // 坏时间行跳过，保住其余行
            // 窗口模式（仅「最近 N 天」）：降序列表遇到早于窗口起点即整集收工
            if (windowSince && submittedAt < windowSince) {
              windowEnd = true;
              return 'done';
            }
            const key = ptaProblemKey(ps.id, String(row.problemSetProblemId ?? ''));
            if (key === null) continue; // 题号畸形：跳过而不是落一个打不开的题
            const pspId = String(row.problemSetProblemId);
            const labelFromPage = res.problemSetProblemById?.[pspId]?.label;
            out.push({
              problem: {
                platform: 'pta' as PlatformId,
                problemKey: key,
                // 标题稍后由 fetchTitleMap 补（提交行不带标题），先退到题号；题号也没有时占位为 key，
                // 写入层有「title == problem_key 不覆盖」的守卫，不会把占位串当成真标题覆盖掉人工值
                title: (typeof labelFromPage === 'string' && labelFromPage.trim()) || key,
                ...difficultyFields('pta', null), // 平台无难度字段（见文件头第 6 条）
                url: ptaProblemUrl(key),
                tags: [],
              },
              verdict,
              ...(typeof row.compiler === 'string' && row.compiler.trim() ? { language: row.compiler.trim() } : {}),
              submittedAt,
              externalId,
            });
            emittedInPage += 1;
            if (maxSubmissions > 0 && out.length >= maxSubmissions) {
              rowCapped = true;
              return 'done';
            }
          }
          if (emittedInPage > 0) setsWithNewRows.add(ps.id);
          // 整页已知：增量模式该集已追平（更旧的都在库中），跳下一集；
          // 补全模式继续向更旧翻（最多 PER_SET_MAX_PAGES 页），由 knownRun 判「已补到尽头」
          if (known?.size && knownInPage > 0 && knownInPage === rows.length) {
            knownRun += 1;
            if (!backfill || knownRun >= 2) return 'done';
          } else {
            knownRun = 0;
          }
          if (!res.hasBefore) return 'done'; // 已到该集最旧一页
          if (page + 1 < PER_SET_MAX_PAGES) await sleepTracked(delayMs);
        }
        // 单集页预算耗尽但仍有更旧记录：这套题集本次没扫完 —— 记作截断，下次从这一页续
        if (setPages >= PER_SET_MAX_PAGES) return 'budget';
        return 'done';
      };

      // 从上次截断处续拉：backfill_page 记的是「1 基的题集序号」，缺省/0 = 从头
      const startSetIndex = backfill && opts?.backfillFromPage ? Math.max(0, opts.backfillFromPage - 1) : 0;
      /**
       * 下次该从哪套题集续（0 基）。中途被预算切断的那套**不前进**——它会从第 1 页重扫，
       * 已入库的行由 knownExternalIds 跳过，代价是 1 次请求，换来的是那套题集更旧的分页不丢。
       */
      let resumeIndex = startSetIndex;
      for (let i = startSetIndex; i < sets.length; i += 1) {
        if (rowCapped || budgetExhausted || windowEnd) break;
        const outcome = await scanSet(sets[i]!);
        resumeIndex = outcome === 'budget' ? i : i + 1;
        if (!rowCapped && !budgetExhausted && !windowEnd) await sleepTracked(delayMs);
      }
      /** 还有没被看过的题集（预算/上限把它挡在后面） */
      const setsRemain = resumeIndex < sets.length;

      // 标题回填：只对真的产出了新行的题集再多打少量请求（见文件头第 5 条）
      if (setsWithNewRows.size > 0) {
        for (const psId of setsWithNewRows) {
          if (pagesUsed >= budget + setsWithNewRows.size * TITLE_LIST_MAX_PAGES) break;
          const titleMap = await fetchTitleMap(psId, cookie);
          if (titleMap.size === 0) continue;
          const prefix = `${psId}-`;
          for (const s of out) {
            if (!s.problem.problemKey.startsWith(prefix)) continue;
            const pspId = s.problem.problemKey.slice(prefix.length);
            const title = titleMap.get(pspId);
            if (title) s.problem.title = title;
          }
        }
      }

      // 截断判定：触及单次新增上限，或页预算耗尽而仍有题集/更旧页没看 —— 两种情况都必须
      // 回写截断，否则 sync_truncated 被清空、后面的题集永远排不上（与计蒜客的比赛游标同一个坑）
      if (!windowEnd && (rowCapped || (budgetExhausted && setsRemain))) {
        markTruncated(opts);
        // backfill_page 存 1 基题集序号（0 表示从头）；resumeIndex 是 0 基，故 +1
        if (opts) opts.backfillReachedPage = resumeIndex + 1;
      }
      return out;
    },

    problemUrl({ problemKey }) {
      return ptaProblemUrl(String(problemKey));
    },

    /**
     * 校验登录态：passport 子域的 `/api/u/current`。
     * 判定逻辑见 ptaIdentity（未登录也是 200 + 空身份，只能看内容）。
     */
    async checkAuth({ cookie }) {
      const c = String(cookie ?? '').trim();
      if (!c) return { ok: false, message: '未填写 Cookie：PTA 公开题集可匿名同步，填 PTASession 才能覆盖「我加入的题集」' };
      const r = await callCurrentUser(http, c);
      if (!r.ok) return r;
      const who = r.identity;
      return {
        ok: true,
        message: `Cookie 有效，已通过 PTA 登录校验（userId ${who.id}${who.nickname ? `，${who.nickname}` : ''}）`,
      };
    },

    /**
     * 反查登录凭据对应的账号 userId。
     *
     * 这是 PTA 场景下比 checkAuth 更有用的一步：handle 是 19 位数字 userId，
     * 用户自己从个人主页地址栏抄一遍几乎必错（还容易把昵称当成账号填进来，
     * 站点对此直接 400）。登录成功后由这里反查，设置页/桌面壳就能直接填好账号名。
     */
    async identify({ cookie }) {
      const c = String(cookie ?? '').trim();
      if (!c) return { ok: false, message: '未填写 Cookie，无法识别账号' };
      const r = await callCurrentUser(http, c);
      if (!r.ok) return r;
      const who = r.identity;
      return {
        ok: true,
        handle: who.id,
        ...(who.nickname ? { nickname: who.nickname } : {}),
        message: `已识别 PTA 账号：userId ${who.id}${who.nickname ? `（${who.nickname}）` : ''}`,
      };
    },
  };
}
