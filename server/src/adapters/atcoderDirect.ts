/**
 * AtCoder 直连补充同步：用账号自己的登录 Cookie 抓 atcoder.jp 的「我的提交」页
 * （`/contests/{id}/submissions/me`），补上社区镜像（kenkoooo）迟迟未收录的提交。
 *
 * 为什么需要它（2026-10-06 排查）：AtCoder 已把**所有**提交列表页加上登录墙（匿名访问
 * 一律 302 跳登录页），kenkoooo 对赛后补题/练习提交的收录延迟变得不可控——实测 abc478
 * 的补题提交 3 天未收录，而同期其他比赛的提交是分钟级进库的（说明它的爬虫在按比赛轮转，
 * 单个比赛的 re-crawl 周期可长达数天）。工作台的增量游标（见 sync.ts 的数据锚定）保证
 * 「收录后必能拉到」，但收录本身等不得。
 *
 * 数据兼容性：页面里的提交号就是 AtCoder 全局提交号，与 kenkoooo `id` 字段**同一命名空间**，
 * 行按 id 去重合并后与镜像数据无缝衔接；`problem_id` 取 tasks 链接段（与 kenkoooo 同构），
 * `result` 透传原始判定串，由 atcoder.ts 的 RESULT_MAP 统一映射。
 *
 * 请求代价与风控：每个候选比赛第 1 页 1 次请求，仅当整页都是新行才继续翻页（封顶
 * maxPagesPerContest），页间与比赛间 sleep ≥1s（走 hostThrottle 按 atcoder.jp 域名节流）。
 * 候选比赛只取「库中已有提交的比赛」（补题只会发生在提交过的比赛里），通常 ≤8 次请求。
 */
import type { HttpClient } from './http.ts';
import { sleep } from './http.ts';

/** 与 kenkoooo `/user/submissions` 相同的行结构（atcoder.ts 据此 normalize） */
export interface KenkoooSubmission {
  id: number;
  epoch_second: number;
  problem_id: string;
  contest_id: string;
  user_id: string;
  language: string;
  result: string;
}

/** 单场比赛 own-submissions 的翻页上限：页面每页约 20 行，5 页 ≈ 100 行/比赛，日常补题绰绰有余 */
const MAX_PAGES_PER_CONTEST = 5;
/** 请求间隔下限：AtCoder 官方对爬取礼仪的要求是 ≥1s */
const REQUEST_DELAY_MS = 1100;

/**
 * 该响应是否实际落在了 AtCoder 登录页。
 * Cookie 失效时站点 302 → /login（fetch 默认跟随重定向，res.url 为最终地址）；
 * 测试环境的 mock Response 没有 url 字段，用登录页 HTML 特征兜底判定。
 */
export function isAtcoderLoginPage(res: { url?: string }, html: string): boolean {
  if (res.url && /\/login(?:\?|$)/.test(res.url)) return true;
  return html.includes('Sign In - AtCoder');
}

/** 构造带登录态的请求头（Cookie 必带；UA 按账号设置注入，缺省用浏览器指纹降低拦截概率） */
function authHeaders(cookie: string, ua?: string): Record<string, string> {
  return {
    cookie,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'ja,en;q=0.8',
    ...(ua ? { 'user-agent': ua } : { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' }),
  };
}

/** HTML 实体反解码（提交页的语言/判定文本可能含 &amp; 等） */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/>/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 去标签取文本并压缩空白（单元格内可能有嵌套 span / 换行） */
function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 解析 `<time title="…">` 的时刻为 epoch 秒。
 * AtCoder 的 title 形如 `2026-10-06T11:44:02+0900`（冒号时区）或文本 `2026-10-06 11:44:02+0900`；
 * 两者 Date.parse 都可能挑剔（无冒号时区、空格分隔），统一归一成 `T` 分隔 + 冒号时区再解析。
 */
function parseEpochSecond(raw: string): number | null {
  const m = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})([+-]\d{2}):?(\d{2})?/.exec(raw);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}${m[3]}:${m[4] ?? '00'}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * 解析单页 own-submissions HTML 为提交行（新→旧的页面顺序原样保留，调用方统一排序）。
 * 只收「带 Detail 链接」的行——提交表格外的任何表格（得分表等）天然不含该链接形态。
 */
export function parseOwnSubmissionsHtml(html: string): KenkoooSubmission[] {
  const out: KenkoooSubmission[] = [];
  for (const trMatch of html.matchAll(/<tr\b[\s\S]*?<\/tr>/g)) {
    const tr = trMatch[0];
    // Detail 链接携带全局提交号；任务链接携带比赛与题号（按 URL 段取，与 kenkoooo 同构）
    const idMatch = /href="[^"]*\/submissions\/(\d+)"/.exec(tr);
    const taskMatch = /href="[^"]*\/contests\/([A-Za-z0-9_.-]+)\/tasks\/([A-Za-z0-9_.-]+)"/.exec(tr);
    if (!idMatch || !taskMatch) continue;
    const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 7) continue;
    const timeHtml = /<time\b[^>]*title="([^"]+)"/.exec(tr)?.[1] ?? cells[0]!;
    const epoch = parseEpochSecond(timeHtml);
    if (epoch === null) continue;
    // 用户名取 /users/<名> 链接段而非单元格文本：单元格里可能带评分徽标等附加内容
    const userMatch = /href="[^"]*\/users\/([A-Za-z0-9_.-]+)"/.exec(tr);
    out.push({
      id: Number(idMatch[1]),
      epoch_second: epoch,
      contest_id: taskMatch[1],
      problem_id: taskMatch[2],
      user_id: userMatch?.[1] ?? '',
      language: cellText(cells[3] ?? ''),
      result: cellText(cells[6] ?? ''),
    });
  }
  return out;
}

export interface DirectScanArgs {
  http: HttpClient;
  /** 账号登录 Cookie（REVEL_SESSION…，整段粘贴亦可） */
  cookie: string;
  /** 期望的账号名：own-submissions 页永远显示**登录账号**的提交，归属不符的行必须丢弃，
   *  防止「把 A 账号的 Cookie 贴进 B 账号槽位」后数据错挂到 B（按 AtCoder 显示名不区分大小写比对） */
  handle: string;
  /** 浏览器 UA（账号设置注入；缺省用内置浏览器指纹） */
  ua?: string;
  /** 候选比赛 id（调用方去重排序；单场比赛请求封顶 MAX_PAGES_PER_CONTEST） */
  contests: string[];
  /** 已入库提交号：跳过（不占新增、不重复翻页） */
  knownIds?: Set<string>;
  /** 请求间隔（毫秒）：缺省 1100；测试传 0 */
  pageDelayMs?: number;
}

export interface DirectScanResult {
  rows: KenkoooSubmission[];
  /** 实际发出的请求次数（同步中心站点请求数展示用） */
  requests: number;
  /** 因归属不符（页面用户 ≠ 期望账号）被丢弃的行数：>0 说明 Cookie 贴错了账号槽位 */
  droppedOtherUser: number;
}

/**
 * 抓取候选比赛的 own-submissions，返回**未知**的提交行（调用方再与 kenkoooo 行按 id 合并）。
 * 停止翻页的条件：页面无新行（更旧的都在库中/已扫过）、空页，或到达单赛封顶页数。
 * 单场比赛请求失败（404 等）只跳过该比赛；429/403 属风控信号，直接中止整轮直连扫描
 * （继续请求只会加重风控，镜像路径仍有数据兜底）。
 */
export async function fetchOwnContestSubmissions(args: DirectScanArgs): Promise<DirectScanResult> {
  const delay = args.pageDelayMs ?? REQUEST_DELAY_MS;
  const rows: KenkoooSubmission[] = [];
  const seen = new Set<string>();
  let requests = 0;
  let droppedOtherUser = 0;
  const wantUser = args.handle.trim().toLowerCase();

  for (const contest of args.contests) {
    for (let page = 1; page <= MAX_PAGES_PER_CONTEST; page += 1) {
      if (requests > 0) await sleep(delay);
      const url = `https://atcoder.jp/contests/${encodeURIComponent(contest)}/submissions/me?page=${page}`;
      const res = await args.http.fetch(url, { headers: authHeaders(args.cookie, args.ua), redirect: 'follow' }, { timeoutMs: 20000 });
      requests += 1;
      if (res.status === 429 || res.status === 403) {
        throw new Error(`AtCoder 直连请求被拒（HTTP ${res.status}），本轮停止直连扫描以防风控`);
      }
      if (res.status === 404) break; // 比赛 id 异形（如 JOI 前缀拆错）：跳过该比赛
      if (!res.ok) break;
      const html = await res.text();
      if (isAtcoderLoginPage(res, html)) {
        throw new Error('AtCoder Cookie 已失效（访问自己的提交页被跳转到登录页），请到设置中更新');
      }
      const pageRows = parseOwnSubmissionsHtml(html);
      if (pageRows.length === 0) break;
      let newRows = 0;
      for (const r of pageRows) {
        const id = String(r.id);
        if (seen.has(id)) continue;
        seen.add(id);
        // 归属校验：页面行是登录账号的提交，账号不符的行绝不入账（数据按 handle 隔离存储）
        if (r.user_id && r.user_id.trim().toLowerCase() !== wantUser) {
          droppedOtherUser += 1;
          continue;
        }
        if (args.knownIds?.has(id)) continue;
        rows.push(r);
        newRows += 1;
      }
      // 本页没有未知新行：更旧的行只可能更「已知」，翻页无意义
      if (newRows === 0) break;
    }
  }
  return { rows, requests, droppedOtherUser };
}
