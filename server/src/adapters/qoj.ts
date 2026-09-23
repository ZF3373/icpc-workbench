import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields } from '../../../shared/src/difficulty.ts';
import { ManualImportRequiredError } from './types.ts';
import type { FetchOptions, PlatformAdapter } from './types.ts';
import { pagedFetch } from './pagination.ts';
import { asHttpClient, type HttpInit } from './http.ts';

/**
 * QOJ（qoj.ac）适配器。
 *
 * QOJ 是基于 UOJ 的评测系统，Universal Cup / ICPC 系列赛大量使用它作为官方 OJ。
 * 与洛谷/牛客/代码源相同的处境：**平台无公开提交 API**
 * （`/api/*` 全部返回 `{"code":401,"message":"Authentication required."}`），
 * 唯一可行的数据源是服务端渲染的提交列表分页 HTML。
 *
 * - 提交记录：`GET /submissions?submitter={用户名}&page={n}`，每页 **10 条**（固定），
 *   按时间新→旧。表格列序（2026-09 对真实页面实测确认）：
 *   `#提交号 / 题目 / 提交者 / 结果 / 运行时间 / 内存 / 语言 / 代码长度 / 提交时间`
 *   —— 解析先按「列内链接」锚定提交号/题目/提交者三列，再按顺序取其余列，
 *   **不依赖固定下标**（早期版本按第三方文档假设「结果在提交者之前」，导致
 *   把提交者名当成结果文本，整页判为未知状态而静默返回 0 条）。
 * - **HTTP/1.1 强制**：Cloudflare 对 HTTP/2 请求恒定下发托管挑战（403 +
 *   `cf-mitigated: challenge`），同一份 Cookie/UA 换成 HTTP/1.1 即放行。
 *   Node 内置 fetch（undici）默认协商到 h2，故本适配器默认走 http1.ts 的传输层。
 * - **凭据**：`UOJSESSID` 为登录会话；`cf_clearance` 为 Cloudflare 通行凭据
 *   （浏览器签发、约 30 分钟有效，需与 `ua.<platform>` 保存的浏览器 UA 一致）。
 *   凭据失效时服务端返回 302 跳登录页，据此给出明确中文提示。
 * - **时区**：QOJ 表格时间是服务器本地时间且不带时区后缀；页面底部有
 *   `Server Time: YYYY-MM-DD HH:MM:SS`，用它换算出 UTC 偏移后按真实 UTC 入库。
 * - **评测制式**：QOJ 大量比赛采用子任务部分分，结果列可能是纯数字得分
 *   （满分时带 ✓）。列表页无法区分「部分分」背后的原因（WA/RE/TL），
 *   因此非满分的数字得分统一保守归为 WA。
 * - 增量：列表按时间倒序，靠同步层注入的 knownExternalIds 整页已知即早停；
 *   分批上限与补全游标由 pagedFetch 统一处理（页间限速 1s 防触发风控）。
 * - 题目难度：QOJ 无难度字段（UOJ 系数据模型），difficulty 不下发；标度记为 none，
 *   统一难度模块据此在 UI 显示「平台不提供难度」。
 *
 * 参考实现（GitHub 实测规格，非直接依赖）：
 * - Inkyo-007/xcpc-helper `docs/design/activity/qoj.md`（verdict / 子任务评分映射）
 * - Whalica/OJ_Insight `src-tauri/src/sync/qoj.rs`（UOJSESSID Cookie 语义）
 * - avighnac/oi-checklist `src/backend/python/qoj/fetchProblemScores.py`（表格选择器与时区换算）
 */

const BASE = 'https://qoj.ac';
/** UOJ 提交列表固定每页 10 条 */
const PAGE_SIZE = 10;
/**
 * 每次同步的保守页数上限：120 页 × 1s ≈ 2 分钟。
 * QOJ 无需登录即可翻页但前置 Cloudflare，请求密度越低越安全；
 * 默认 maxSubmissions=500 时实际拉 50 页（页数预算 = ceil(500/10)×2 = 100）即触及条目上限停止。
 */
const PER_SYNC_MAX_PAGES = 120;
/** 页间限速：UOJ 无严格限流，但 Cloudflare 会对密集请求升级为挑战 */
const PAGE_DELAY_MS = 1000;
/** QOJ 服务器时区回退值（站点主要面向中国大陆用户；仅当页面取不到 Server Time 时使用） */
const FALLBACK_OFFSET_MINUTES = 8 * 60;

/** 浏览器标识：Cloudflare 对默认 fetch UA 直接下挑战 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 明确的状态文本 → 统一 Verdict。
 * 键为**归一化后**的结果文本（去空格、大写、去 ✓ 与尾部标点）：
 * UOJ 系的 AC 常常显示为「AC ✓」，TL/ML/OLE/UKE 为 UOJ 的短写。
 */
const PLAIN_VERDICT_MAP: Record<string, Verdict> = {
  AC: 'AC',
  ACCEPTED: 'AC',
  WA: 'WA',
  WRONGANSWER: 'WA',
  PE: 'WA', // 格式错误（按 OJ 惯例与牛客/计蒜客同口径归 WA）
  PRESENTATIONERROR: 'WA',
  'FORMATERROR': 'WA',
  TL: 'TLE',
  TLE: 'TLE',
  TIMELIMITEXCEEDED: 'TLE',
  ML: 'MLE',
  MLE: 'MLE',
  MEMORYLIMITEXCEEDED: 'MLE',
  OLE: 'RE', // 输出超限（与代码源 / 计蒜客同口径归 RE）
  OUTPUTLIMITEXCEEDED: 'RE',
  RE: 'RE',
  RUNTIMEERROR: 'RE',
  CE: 'CE',
  COMPILEERROR: 'CE',
  // UKE（未知错误）/ JG（评测中）等不可靠终态不落库 → 由 mapVerdict 返回 null
};

/** 归一化结果文本：去 HTML 残留、空白与装饰字符，统一大写 */
export function normalizeResultText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[✓✔√×✗]/g, '')
    .replace(/[.,;:]+$/, '')
    .toUpperCase();
}

/** 结果文本是否表示"满分通过"（UOJ 满分时常带 ✓ 或显示 AC） */
function looksFullScore(raw: string): boolean {
  return /[✓✔√]/.test(raw);
}

/**
 * 结果文本 → 统一 Verdict；无法判定（评测中 / 未知状态）返回 null（不落库）。
 *
 * 处理三类真实文本（xcpc-helper 对 544 条真实提交扫描得出）：
 * 1. 状态词：`AC ✓` `WA` `RE` `TL` `ML` `CE` `OLE` `UKE`
 * 2. 子任务得分：纯数字（满分常带 ✓）——满分 → AC，非满分 → WA（列表页无法区分原因）
 * 3. 组合文本：`AC, WA`（通过后被 Hack）→ 非 AC
 */
export function mapQojVerdict(raw: string): Verdict | null {
  const text = normalizeResultText(raw);
  if (text === '') return null;
  // 瞬态/不可靠终态：不落库，下次同步会以终态重新出现（UOJ：JG=评测中、UKE=未知错误）
  if (text === 'JG' || text === 'JUDGING' || text === 'UKE' || text === 'UNKNOWNERROR') return null;

  const full = looksFullScore(raw);
  // 组合文本（多状态用 , + / 分隔）：全部为 AC 才算通过，含任何非 AC 状态即未通过
  const tokens = text.split(/[,+/]+/).filter((t) => t !== '');
  if (tokens.length > 1) {
    const mapped = tokens.map((t) => PLAIN_VERDICT_MAP[t] ?? null);
    if (mapped.every((v) => v === 'AC')) return 'AC';
    return mapped.find((v) => v !== null && v !== 'AC') ?? 'WA';
  }

  const plain = PLAIN_VERDICT_MAP[text];
  if (plain) return plain;

  // 子任务得分：纯数字（可带小数点）。满分（列表页显示为满分或带 ✓）→ AC，否则保守归 WA：
  // 部分分背后的原因（WA/RE/TL）在列表页不可见，无法进一步区分。
  if (/^\d+(?:\.\d+)?$/.test(text)) return full ? 'AC' : 'WA';

  // 状态词带额外装饰（如 `AC*`）：取首个已知状态词
  for (const [key, verdict] of Object.entries(PLAIN_VERDICT_MAP)) {
    if (text.startsWith(key)) return verdict;
  }
  return null;
}

/** 单行原始字段（HTML 层解析结果） */
export interface QojRow {
  submissionId: string;
  problemKey: string;
  problemUrl: string;
  title: string;
  result: string;
  language?: string;
  /** 页面上的服务器本地时间文本（形如 2026-01-02 03:04:05） */
  timeText: string;
  /** 已按页面 Server Time 偏移换算的 ISO8601 UTC（fetchPage 阶段填充；解析失败为空串） */
  submittedAtUtc?: string;
}

const stripTags = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();

/** 从页面读取 `Server Time: YYYY-MM-DD HH:MM:SS` → 相对 UTC 的偏移分钟数 */
export function parseServerOffsetMinutes(html: string): number {
  const m = /Server\s*Time\s*:?\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/i.exec(
    stripTags(html),
  );
  if (!m) return FALLBACK_OFFSET_MINUTES;
  // 页面上除 Server Time 外的时间戳都带秒；DTO 反推：以服务器时间与当前 UTC 的差取整到分钟
  const server = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  );
  if (!Number.isFinite(server)) return FALLBACK_OFFSET_MINUTES;
  const diffMinutes = Math.round((server - Date.now()) / 60_000);
  // 合理区间 [-12h, +14h]；超出视为解析异常（如把提交时间误当服务器时间）
  if (diffMinutes < -12 * 60 || diffMinutes > 14 * 60) return FALLBACK_OFFSET_MINUTES;
  return diffMinutes;
}

/** 服务器本地时间文本 + 偏移 → ISO8601 UTC；无法解析返回 null */
export function parseQojTime(timeText: string, offsetMinutes: number): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})[\sT]+(\d{2}):(\d{2}):(\d{2})/.exec(timeText);
  if (!m) return null;
  const utcMs = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  ) - offsetMinutes * 60_000;
  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

/** 从题目链接 href 解析题目键与规范链接：contest/3588/problem/17753 → 3588-17753 */
export function parseQojProblemHref(href: string): { problemKey: string; url: string } | null {
  const contest = /\/contest\/(\d+)\/problem\/([A-Za-z0-9_]+)/.exec(href);
  if (contest) {
    return { problemKey: `${contest[1]}-${contest[2]}`, url: `${BASE}/contest/${contest[1]}/problem/${contest[2]}` };
  }
  const plain = /\/problem\/([A-Za-z0-9_]+)/.exec(href);
  if (plain) return { problemKey: plain[1], url: `${BASE}/problem/${plain[1]}` };
  return null;
}

/** 判定页面是否为 Cloudflare 托管挑战（而非平台业务响应） */
export function isCloudflareChallenge(html: string, status: number, mitigated: string | null): boolean {
  if (mitigated?.toLowerCase() === 'challenge') return true;
  if (status !== 403 && status !== 503) return false;
  const low = html.toLowerCase();
  return (
    low.includes('just a moment') ||
    low.includes('cf-chl') ||
    low.includes('challenges.cloudflare.com') ||
    low.includes('enable javascript and cookies to continue')
  );
}

/** 判定响应是否落到登录页（凭据缺失/过期） */
export function looksLikeLoginPage(html: string): boolean {
  return (
    /name=["']password["']/i.test(html) &&
    (/(?:\/login|>login<|登录)/i.test(html) || /uoj-login/i.test(html))
  );
}

/**
 * 页面是否为「正常渲染的提交列表页」：含表头关键词（或提交号链接）。
 * 用于区分"账号确实没有提交"与"页面改版/被换成别的页面"——前者是合法空结果，
 * 后者必须明确报错，不能静默返回 0 条（牛客适配器同款防假成功策略）。
 */
function looksLikeSubmissionsPage(html: string): boolean {
  return /\/submission\/\d+/.test(html) || /(result|submit\s*time|提交时间)/i.test(html);
}

/** 页面是否真的含有提交数据行（提交号链接）——首页解析不出任何行即视为页面结构变化 */
function hasSubmissionLinks(html: string): boolean {
  return /\/submission\/\d+/.test(html);
}

/**
 * 从「页面源码」解析提交记录（离线导入与在线同步共用同一套解析）。
 *
 * 在线同步走这里拿到当页数据行后逐页换算时区；离线导入（浏览器里拷回的
 * `document.documentElement.outerHTML`）直接用它 + parseServerOffsetMinutes 归一化。
 *
 * @param html      提交记录页完整源码
 * @param submitter 期望的提交者（按绑定账号过滤表格中他人的提交）
 * @returns submitter 为页面上识别到的提交者（无提交者链接时为 null）
 */
export function parseQojPageHtml(
  html: string,
  submitter?: string,
): { rows: QojRow[]; submitter: string | null } {
  const pageSubmitter = /\/user\/profile\/([^"'/?#\s]+)/i.exec(html)?.[1];
  return {
    rows: parseQojRows(html, submitter),
    submitter: pageSubmitter ? decodeURIComponent(pageSubmitter) : null,
  };
}

/**
 * 数据行 → 统一提交结构（在线同步与离线导入共用）。
 * 返回 null 表示该行不该落库（评测中 / 未知终态）。
 */
export function normalizeQojRow(row: QojRow): NormalizedSubmission | null {
  const verdict = mapQojVerdict(row.result);
  if (verdict === null) return null;
  return {
    problem: {
      platform: 'qoj' as PlatformId,
      problemKey: row.problemKey,
      title: row.title || row.problemKey,
      ...difficultyFields('qoj', null), // 平台无难度字段：标度 none，由 UI 显示「平台不提供难度」
      url: row.problemUrl,
      tags: [], // QOJ 提交列表不含标签
    },
    verdict,
    ...(row.language ? { language: row.language } : {}),
    submittedAt: row.submittedAtUtc ?? new Date().toISOString(),
    externalId: row.submissionId,
  };
}

/**
 * 已解析页面 → 带 UTC 时间的数据行（按页面 Server Time 换算时区）。
 * 离线导入路径使用；在线同步逐页调用（每页的 Server Time 即站点当前时间）。
 */
export function withUtcTime(html: string, rows: QojRow[]): QojRow[] {
  const offset = parseServerOffsetMinutes(html);
  return rows.map((row) => ({ ...row, submittedAtUtc: parseQojTime(row.timeText, offset) ?? undefined }));
}

/**
 * 解析提交列表页的所有数据行。
 * 表头为 `<th>` 不参与匹配；每行至少要有「提交号链接 + 题目链接」才视为有效行。
 */
/** 解析提交列表页的所有数据行。
 * @param submitter 传入时按提交者链接过滤（防御表格被其它筛选覆盖而混入他人提交）
 */
export function parseQojRows(html: string, submitter?: string): QojRow[] {
  const rows: QojRow[] = [];
  const wanted = submitter?.trim().toLowerCase() ?? '';
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const rowHtml = m[1];
    let submissionId = (
      rowHtml.match(/\/submission\/(\d+)/) ?? rowHtml.match(/href="#?(\d+)"/)
    )?.[1];
    const problemHref = /href="([^"]*(?:\/problem\/)[^"]*)"/i.exec(rowHtml)?.[1];
    if (!problemHref) continue;
    const problem = parseQojProblemHref(problemHref);
    if (!problem) continue;
    // 兜底：提交号列未用链接渲染时，从首个单元格文本中取 `#123`
    if (!submissionId) {
      const firstCell = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)][0]?.[1] ?? '';
      submissionId = /#\s*(\d+)/.exec(stripTags(firstCell))?.[1];
    }
    if (!submissionId) continue;
    // 防御性过滤：页面被其它筛选（比赛号/题目）覆盖时，表格里可能混入他人的提交。
    // 提交者既可能是 `<a href="/user/profile/{name}">`，也可能是
    // `<span class="uoj-username" data-nickname="{name}">{name}</span>`，两种都取。
    if (wanted !== '') {
      const who =
        /\/user\/profile\/([^"'/?#]+)/i.exec(rowHtml)?.[1] ??
        /data-nickname="([^"]+)"/i.exec(rowHtml)?.[1] ??
        /class="[^"]*uoj-username[^"]*"[^>]*>([^<]+)</i.exec(rowHtml)?.[1];
      if (who && decodeURIComponent(who).trim().toLowerCase() !== wanted) continue;
    }

    const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (tds.length < 4) continue; // 表头为 <th>，列数不足 4 视为异常行

    // 列定位：真实页面列序为
    //   ID | Problem | Submitter | Result | Time | Memory | Language | File size | Submit time
    // 但**不能靠链接/文本形态盲取**（实测坑）：结果列是链接（`<a class="uoj-score">AC ✓`）、
    // 语言列也是链接（`<a href="/submission/N">C++23</a>`），按「有没有链接」判定会把这两列错位，
    // 进而拿到提交者名当结果、运行时间当语言（症状：整页 verdict 全部无法识别 → 同步 0 条）。
    // 定位优先级（逐级回退，任一命中即用）：
    //   ① 语义标记 `class="uoj-score"`（UOJ 计分/AC 统一标记，最可靠）
    //   ② 结构位置：运行时间列（`17ms`）的**前一列**即结果（UOJ 恒为「结果 | 时间 | 内存 | 语言」）
    //   ③ 结构位置：提交者列之后的第一个非时间/内存列
    const scoreIndex = tds.findIndex((td) => /class="[^"]*uoj-score/i.test(td));
    const submitterIndex = tds.findIndex(
      (td) => /class="[^"]*uoj-username/i.test(td) || /\/user\//.test(td),
    );
    const timeIndex = tds.findIndex((td) => /\d{4}-\d{2}-\d{2}[\sT]+\d{2}:\d{2}:\d{2}/.test(stripTags(td)));
    // 运行时间列（形如 `17ms` / `1.234s`）与内存列（`4000kb` / `15M`）：用于夹逼结果列
    const isRuntime = (t: string): boolean => /^\d+(?:\.\d+)?\s*(?:ms|s)$/i.test(t);
    const isMemory = (t: string): boolean => /^\d+(?:\.\d+)?\s*(?:kb|mb|gb|b|k|m|g)$/i.test(t);
    const runtimeIndex = tds.findIndex((td) => isRuntime(stripTags(td)));

    const resultIndex =
      scoreIndex >= 0
        ? scoreIndex
        : runtimeIndex > 0
          ? runtimeIndex - 1
          : tds.findIndex((td, i) => {
              if (submitterIndex >= 0 && i <= submitterIndex) return false;
              if (i === timeIndex) return false;
              const t = stripTags(td);
              return t !== '' && !isRuntime(t) && !isMemory(t);
            });

    const result = resultIndex >= 0 ? stripTags(tds[resultIndex] ?? '') : '';
    // 语言列：结果列之后，跳过 运行时间 / 内存 两列
    const language =
      resultIndex >= 0
        ? [resultIndex + 1, resultIndex + 2, resultIndex + 3]
            .filter((i) => i !== timeIndex)
            .map((i) => stripTags(tds[i] ?? ''))
            .find((t) => t !== '' && !isRuntime(t) && !isMemory(t)) ?? ''
        : '';
    // 提交时间：优先取识别到的时间列，其次退回行内首个时间戳（结构再变也能兜住）
    const timeText =
      (timeIndex >= 0 ? /(\d{4}-\d{2}-\d{2}[\sT]+\d{2}:\d{2}:\d{2})/.exec(stripTags(tds[timeIndex] ?? ''))?.[1] : undefined) ??
      /(\d{4}-\d{2}-\d{2}[\sT]+\d{2}:\d{2}:\d{2})/.exec(stripTags(rowHtml))?.[1] ??
      '';

    // 题目列文本（问题链接所在列）；去掉题号前缀（`#20019.` / `A.` / `A)`）
    const problemTd = tds.find((td) => /\/problem\//.test(td)) ?? '';
    const title = stripTags(problemTd).replace(/^#?\s*[A-Za-z]?\d*\s*[.)、]\s*/, '').trim();

    if (result === '') continue; // 无结果列 → 非提交数据行，跳过

    rows.push({
      submissionId,
      problemKey: problem.problemKey,
      problemUrl: problem.url,
      title: title || problem.problemKey,
      result,
      ...(language ? { language } : {}),
      timeText,
    });
  }
  return rows;
}

/** 构造带凭据的请求头。ua 传入时原样发送：cf_clearance 与签发它的浏览器 UA 绑定。 */
function requestHeaders(cookie: string, ua?: string): Record<string, string> {
  const agent = ua?.trim();
  return {
    Cookie: cookie,
    'User-Agent': agent && agent !== '' ? agent : UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    // 与真实导航请求一致的补充头：少数 WAF 规则按 Sec-Fetch-* 区分导航与脚本请求
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    Referer: `${BASE}/`,
  };
}

/** 同步/检测共用的「拿到一页 HTML」逻辑：统一处理 Cloudflare 挑战与登录页 */
async function fetchSubmissionsPage(
  http: ReturnType<typeof asHttpClient>,
  handle: string,
  page: number,
  cookie: string,
  ua?: string,
): Promise<string> {
  const url = `${BASE}/submissions?submitter=${encodeURIComponent(handle)}&page=${page}`;
  const res = await http.fetch(url, { headers: requestHeaders(cookie, ua), redirect: 'manual' }, { timeoutMs: 25000 });
  const html = await res.text();
  if (isCloudflareChallenge(html, res.status, res.headers.get('cf-mitigated'))) {
    throw new ManualImportRequiredError(
      'qoj',
      'QOJ 前置 Cloudflare 拦截了本次请求。请在浏览器登录 qoj.ac 后，从 F12 → Network 的任意请求 Request Headers 里整段复制 Cookie，' +
        '至少包含 UOJSESSID 与 cf_clearance；**并同时填写该浏览器的 User-Agent**' +
        '（在 qoj.ac 页面按 F12 → Console 输入 navigator.userAgent 回车，整行复制到「浏览器 User-Agent」框）。' +
        'cf_clearance 与浏览器 UA/IP 绑定、约 30 分钟有效，换 UA 或不填 UA 都会判为无效。',
    );
  }
  // UOJ 登录失效：302 跳 /login，或直接渲染登录页
  if (res.status === 302 || res.status === 301) {
    throw new ManualImportRequiredError(
      'qoj',
      'QOJ 登录态已失效（提交记录页跳转登录）：请在设置页重新复制 UOJSESSID（以及 cf_clearance）',
    );
  }
  if (!res.ok) {
    throw new Error(`QOJ 提交列表返回 HTTP ${res.status}，请稍后重试`);
  }
  if (looksLikeLoginPage(html)) {
    throw new ManualImportRequiredError(
      'qoj',
      'QOJ 登录态已失效（提交记录页要求登录）：请在设置页重新复制 UOJSESSID（以及 cf_clearance）',
    );
  }
  return html;
}

export function createQojAdapter(fetchFn: HttpInit): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  return {
    platform: 'qoj',
    knownIdsFilter: true,

    async fetchUserSubmissions(
      handle: string,
      opts?: FetchOptions,
    ): Promise<NormalizedSubmission[]> {
      const cookie = opts?.cookie?.trim();
      if (!cookie) {
        throw new ManualImportRequiredError(
          'qoj',
          'QOJ 提交记录需登录后访问：请在设置页填写两项——' +
            '「qoj.ac 完整 Cookie」（F12 → Network → 任意 qoj.ac 请求的 Cookie 整段值）' +
            '与「浏览器 User-Agent」（Console 执行 navigator.userAgent）。两者缺一不可。',
        );
      }
      const user = handle.trim();
      if (!user) {
        throw new ManualImportRequiredError('qoj', 'QOJ 账号名为空：请在设置页填写 qoj.ac 用户名（区分大小写）');
      }
      const ua = opts?.ua;

      // 首页结构异常信号：首页有表格但解析不出任何数据行 → 明确失败，而非"同步成功 0 条"
      let firstPageHtml = '';

      const out = await pagedFetch<QojRow>({
        since: opts?.windowSince,
        pageSize: PAGE_SIZE,
        perSyncMax: PER_SYNC_MAX_PAGES,
        fetchPage: async (page) => {
          const html = await fetchSubmissionsPage(http, user, page, cookie, ua);
          if (page === 1) firstPageHtml = html;
          // 时区偏移逐页解析后即换算为 UTC（页面 Server Time 即站点当前时间）
          return withUtcTime(html, parseQojRows(html, user));
        },
        externalIdOf: (row) => row.submissionId,
        normalize: normalizeQojRow,
        // 补全模式同样注入 knownExternalIds：已知行跳过、连续 2 个整页已知即判定补到尽头
        //（与 CF/牛客/洛谷同口径）。传 undefined 会让每轮把已入库的行重新当「新增」吃满预算。
        knownExternalIds: opts?.knownExternalIds,
        maxSubmissions: opts?.maxSubmissions,
        backfill: opts?.backfill,
        backfillFromPage: opts?.backfillFromPage,
        opts,
        pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS,
      });

      if (out.length === 0 && firstPageHtml && !hasSubmissionLinks(firstPageHtml)) {
        throw new Error(
          'QOJ 提交列表未解析到数据（页面可能已改版）：请反馈页面结构变化或改用「手动导入」',
        );
      }
      return out;
    },

    problemUrl({ problemKey }) {
      const key = String(problemKey);
      // 比赛题键为 contestId-problemId（与解析/同步同键），拼回比赛内题目链接
      const contest = /^(\d+)-(\d+)$/.exec(key);
      if (contest) return `${BASE}/contest/${contest[1]}/problem/${contest[2]}`;
      return `${BASE}/problem/${key}`;
    },

    /**
     * 校验凭据：按已绑定账号拉自己的提交列表第 1 页。
     * 只要页面正常返回（含"没有提交"的空列表）即视为凭据可用；
     * Cloudflare 挑战与登录页由 fetchSubmissionsPage 抛出并转成可读提示。
     */
    async checkAuth({ cookie, handle, ua }) {
      if (!cookie?.trim()) {
        return { ok: false, message: '尚未填写 Cookie：请粘贴 UOJSESSID（必要时附 cf_clearance 与浏览器 UA）' };
      }
      if (!handle?.trim()) {
        return { ok: false, message: '请先填写 QOJ 用户名并保存，再检测凭据（检测需按账号访问提交记录页）' };
      }
      try {
        // 前置检查两项**都必需**（2026-09 逐项实测）：缺 cf_clearance 会被 Cloudflare 挑战，
        // 缺 UOJSESSID 会 302 跳登录页。其它展示类 cookie（uoj_locale / OptanonConsent 等）实测无影响。
        const missing: string[] = [];
        if (!/cf_clearance=/i.test(cookie)) missing.push('cf_clearance');
        if (!/UOJSESSID=/i.test(cookie)) missing.push('UOJSESSID');
        if (missing.length > 0) {
          return {
            ok: false,
            message:
              `Cookie 里缺少 ${missing.join(' 与 ')}：请在浏览器 F12 → Network 选任意 qoj.ac 请求，` +
              '把 Request Headers 里 Cookie 的**整段值**复制过来（它同时包含 cf_clearance 与 UOJSESSID）',
          };
        }
        const html = await fetchSubmissionsPage(http, handle.trim(), 1, cookie.trim(), ua);
        const rows = parseQojRows(html, handle.trim());
        if (rows.length === 0 && looksLikeSubmissionsPage(html)) {
          // 空列表是合法状态：登录态有效但该账号暂无提交
          return { ok: true, message: '凭据有效，已通过 QOJ 校验（当前账号在本页没有提交记录）' };
        }
        if (rows.length === 0) {
          return { ok: false, message: 'QOJ 页面已返回但未解析到提交表结构（可能站点改版），请反馈或改用「手动导入」' };
        }
        return { ok: true, message: `凭据有效，已通过 QOJ 校验（读到 ${rows.length} 条提交记录）` };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
  };
}
