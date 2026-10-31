import type {
  NormalizedSubmission,
  Verdict,
} from '../../../shared/src/index.ts';
import { difficultyFields } from '../../../shared/src/difficulty.ts';
import { SyncError, type PlatformAdapter } from './types.ts';
import { numericUid, recordsJson, recordTime } from './remoteRecords.ts';
import { pagedFetch } from './pagination.ts';
import { asHttpClient, type HttpInit } from './http.ts';

const API = 'https://ac.nowcoder.com';
const PAGE_SIZE = 10;
// 每轮对各来源同页扫描，受新增条数、页数与**整轮请求总量**三重限制。
const PER_SYNC_MAX_PAGES = 90;
const PAGE_DELAY_MS = 500; // 牛客反爬较强：页间限速

/**
 * 竞赛段独占的请求额度。
 * 竞赛段是次要来源，只在这份额度内扇出，且每页固定排在练习/社区之后 ——
 * 预算紧张时先牺牲竞赛段，主站数据不受影响。
 */
const CONTEST_REQUEST_BUDGET = 60;
/** 每页的固定来源数：练习页 + 在线编程接口（竞赛段另计）。 */
const PAGE_SOURCE_COUNT = 2;
/**
 * 单次同步的**请求总量**总闸（含参赛列表扫描与页内各来源扇出）。
 *
 * 只封页数是不够的：页内会对每场参赛各发一次 status-list，实际请求量
 * = 页数 × 参赛场次（实测 50 场 × 3 页 = 156 次，50 场 × 90 页 = 4592 次）。
 * 生产装配统一走 throttledFetch，ac.nowcoder.com 的全局下限是 2000ms，
 * 4592 次 ≈ 2.5 小时串行等待 —— 对自述「反爬强」的站点是封号风险量级的变化。
 *
 * 上界 = 页数上限 × 每页固定来源数 + 竞赛额度：
 * 基线部分保证不带竞赛时行为与旧实现完全一致，超出部分才是竞赛段的扇出空间。
 */
const REQUEST_BUDGET = PER_SYNC_MAX_PAGES * PAGE_SOURCE_COUNT + CONTEST_REQUEST_BUDGET;
/**
 * 单页最多轮询的参赛场次。
 * joined-history 按参赛时间倒序返回，取最近若干场：竞赛行与练习行共享题号空间，
 * 但历史越久的竞赛收益越低，而每场每页都要占一次请求额度。
 */
const MAX_CONTESTS = 20;
/** 参赛列表扫描页上限（每页 10 场）。 */
const CONTEST_SCAN_MAX_PAGES = 20;

// 牛客提交结果（HTML 中文状态文本）→ 统一 Verdict；未知值落到 SKIPPED。
// 瞬态/未终态结果不进表：按 pagination 契约由 normalize 返回 null（不计已知不计新增），
// 终态（答案正确/答案错误…）出现后由后续同步正常导入——若按 SKIPPED 带真实提交号入库，
// 该行下次同步即被判「已知」，终局判定永远补不回来（永久丢数据）。洛谷对 status 0/1/-1 同口径。
const RESULT_MAP: Record<string, Verdict> = {
  答案正确: 'AC',
  答案错误: 'WA',
  格式错误: 'WA',
  运行超时: 'TLE',
  编译错误: 'CE',
  运行错误: 'RE',
  段错误: 'RE',
  内存超限: 'MLE',
  输出超限: 'RE',
};

/** 瞬态/未终态结果：评测未完成或评测机异常（通常会重判出终态），不落库 */
const PENDING_RESULTS = new Set(['等待评测', '运行中', '系统错误', '未知错误', '评测中', '正在评测', '排队中']);

interface NcRow {
  submissionId: string;
  pid: string;
  title: string;
  result: string;
  language?: string;
  timeText: string;
}

const strip = (s: string): string =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** 解析 practice-coding 页的提交表格（表头为 <th> 会被跳过） */
function parseRows(html: string): NcRow[] {
  const rows: NcRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (tds.length < 9) continue; // 表头为 <th> 不匹配；列数不足 9 视为异常行跳过
    const submissionId = (tds[0].match(/submissionId=(\d+)/) ?? [])[1] ?? strip(tds[0]);
    const pid = (tds[1].match(/\/acm\/problem\/(\d+)/) ?? [])[1];
    if (!submissionId || !pid) continue; // 异常行/页脚，跳过
    rows.push({
      submissionId,
      pid,
      title: strip(tds[1]),
      result: strip(tds[2]),
      language: strip(tds[7]) || undefined,
      timeText: strip(tds[8]),
    });
  }
  return rows;
}

/** 牛客页面时间为中国时区（无时区后缀）→ 按 UTC+8 解析 */
function parseTime(t: string): number {
  if (!t) return 0;
  const iso = `${t.replace(' ', 'T')}+08:00`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}


interface CommunityRow {
  problem: { questionUuid: string; questionNum?: string; title: string };
  submission: { id: number; createdDate: number }; language?: string; status: { desc: string };
}
interface ContestRow {
  submissionId: number; userId: number; problemId: number; index: string;
  statusMessage: string; submitTime: number; language?: string; problemName?: string;
}
interface Envelope<T> { code: number; data: T; msg?: string }

/** Advance all histories together so one completed source cannot end another's pagination.
 * Capped pages are revisited using exact submission IDs. Community IDs have their own namespace.
 */
export function createNowcoderAdapter(fetchFn: HttpInit = fetch): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const body = await recordsJson<Envelope<T>>(http, url, init);
    if (body.code !== 0 || !body.data) throw new SyncError('schema_changed', '牛客记录接口异常：' + (body.msg || '无有效数据'));
    return body.data;
  }
  return {
    platform: 'nowcoder', knownIdsFilter: true,
    async fetchUserSubmissions(handle, opts) {
      const uid = numericUid(handle, 'nowcoder');
      // 整轮请求总闸：参赛列表扫描与后续分页共用同一份额度，用尽即停止发请求。
      // 只封页数不封页内扇出会让实际请求量变成「页数 × 参赛场次」（见 REQUEST_BUDGET 注释）。
      let requestBudget = REQUEST_BUDGET;
      const takeRequest = (): boolean => {
        if (requestBudget <= 0) return false;
        requestBudget -= 1;
        return true;
      };
      // 竞赛段独立额度：练习/社区用尽自己的份额后不再扇出到参赛场次，
      // 反过来竞赛段耗尽也不会拖住主站数据（主站先发、竞赛后发）。
      let contestBudget = CONTEST_REQUEST_BUDGET;
      const takeContestRequest = (): boolean => {
        if (contestBudget <= 0 || requestBudget <= 0) return false;
        contestBudget -= 1;
        requestBudget -= 1;
        return true;
      };
      const contests = new Set<string>();
      let contestsTruncated = false;
      // 参赛列表扫描本身也计入预算：它是竞赛段的前置请求，此前完全在预算之外，
      // 即使零新增，每轮也固定多出最多 20 次请求。
      for (let page = 1; page <= CONTEST_SCAN_MAX_PAGES; page++) {
        if (!takeRequest()) break;
        const data = await json<{ dataList: { contestId: number }[]; pageInfo: { pageCount: number } }>(
          API + '/acm-heavy/acm/contest/profile/contest-joined-history?uid=' + uid + '&page=' + page + '&pageSize=10&onlyJoinedFilter=true&onlyRatingFilter=false&contestEndFilter=false');
        if (!Array.isArray(data.dataList) || !data.pageInfo) throw new SyncError('schema_changed', '牛客竞赛历史结构发生变化');
        for (const c of data.dataList) if (c.contestId) contests.add(String(c.contestId));
        if (contests.size >= MAX_CONTESTS) {
          // 已收集够本轮上限：还有更多场次没扫（pageCount 未走完）→ 记下「有剩余」用于提示
          if (page < data.pageInfo.pageCount) contestsTruncated = true;
          break;
        }
        if (page >= data.pageInfo.pageCount) break;
      }
      if (requestBudget <= 0 || contestBudget <= 0) contestsTruncated = true;
      // 参赛过多不再整体失败：降级为「只扫最近若干场、其余跳过」，练习与在线编程照常同步。
      // 旧实现在第 20 页直接抛 manual_required，会把练习/社区结果一起丢掉。
      const contestList = [...contests].slice(0, MAX_CONTESTS);
      if (contestsTruncated) {
        // 通过 note 告知用户被跳过的场次，而不是让整次同步失败
        if (opts) {
          opts.directScanNote = `牛客参赛超过本次扫描上限，本次只同步最近 ${contestList.length} 场（其余场次可稍后同步或手动导入）`;
        }
      }
      const ended = new Set<string>();
      const seen = new Set<string>();
      return pagedFetch<NormalizedSubmission | null>({
        pageSize: PAGE_SIZE, perSyncMax: PER_SYNC_MAX_PAGES,
        knownExternalIds: opts?.knownExternalIds, maxSubmissions: opts?.maxSubmissions,
        backfill: opts?.backfill, backfillFromPage: opts?.backfillFromPage, opts,
        pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS,
        // 「仅同步最近 N 天」窗口起点：降序分页遇到早于该时刻的行即收尾，不再翻更旧的页。
        // 注意必须传 windowSince 而不是 since —— opts.since 是**增量**语义，
        // 而牛客存在「提交早于上次同步时刻、却晚出现在列表」的真实场景（见 types.ts），
        // 常规增量只能靠 knownExternalIds 判重，绝不做时间截断。
        since: opts?.windowSince,
        async fetchPage(page) {
          const rows: NormalizedSubmission[] = [];
          let more = false;
          // 预算耗尽 → 本来源停在此处（不 throw，其余来源各自判断）
          if (!ended.has('practice') && !takeRequest()) ended.add('practice');
          if (!ended.has('practice')) {
            const response = await http.fetch(API + '/acm/contest/profile/' + uid + '/practice-coding?pageSize=' + PAGE_SIZE + '&search=&statusTypeFilter=-1&languageCategoryFilter=-1&orderType=DESC&page=' + page,
              { headers: { 'User-Agent': 'Mozilla/5.0', Referer: API + '/acm/home/' + uid } });
            if (!response.ok) throw new SyncError(response.status === 403 ? 'auth_expired' : 'network', '牛客练习页 HTTP ' + response.status);
            const html = await response.text();
            const parsed = parseRows(html);
            if (!parsed.length && !/运行ID|提交时间|暂无.*(?:记录|数据)|没有.*记录/.test(html)) throw new SyncError('schema_changed', '牛客页面未解析到提交记录，可能页面结构变化或触发风控');
            for (const row of parsed) {
              const submittedAt = recordTime(parseTime(row.timeText));
              if (!submittedAt || PENDING_RESULTS.has(row.result)) continue;
              rows.push({ externalId: row.submissionId, submittedAt, verdict: RESULT_MAP[row.result] ?? 'SKIPPED', language: row.language,
                problem: { platform: 'nowcoder', problemKey: row.pid, title: row.title || row.pid, ...difficultyFields('nowcoder', null), url: API + '/acm/problem/' + row.pid, tags: [] } });
            }
            const rawCount = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
              .filter(m => /<td[\s>]/i.test(m[1])).length;
            if (rawCount >= PAGE_SIZE) more = true; else ended.add('practice');
          }
          if (!ended.has('community') && !takeRequest()) ended.add('community');
          if (!ended.has('community')) {
            const data = await json<{ records: CommunityRow[] }>('https://gw-c.nowcoder.com/api/sparta/user/question-training/submission-history', {
              method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://www.nowcoder.com' },
              body: JSON.stringify({ userId: Number(uid), pageNo: page, pageSize: 20 }),
            });
            if (!Array.isArray(data.records)) throw new SyncError('schema_changed', '牛客在线编程记录结构发生变化');
            for (const row of data.records) {
              const submittedAt = recordTime(row.submission?.createdDate);
              const verdict = RESULT_MAP[row.status?.desc];
              const uuid = row.problem?.questionUuid;
              if (!submittedAt || !verdict || !row.submission?.id || !/^[a-f0-9]{32}$/i.test(uuid)) continue;
              rows.push({ externalId: 'community:' + row.submission.id, submittedAt, verdict, language: row.language,
                problem: { platform: 'nowcoder', problemKey: 'practice:' + uuid, title: row.problem.title || row.problem.questionNum || uuid,
                  url: 'https://www.nowcoder.com/practice/' + uuid, tags: [] } });
            }
            if (data.records.length >= 20) more = true; else ended.add('community');
          }
          for (const contest of contestList) {
            if (ended.has(contest)) continue;
            if (!takeContestRequest()) break; // 竞赛额度耗尽：停止本页剩余场次（下轮续拉）
            const params = new URLSearchParams({ id: contest, page: String(page), pageSize: '20', searchUserName: uid, orderBy: 'submitTime', orderType: 'DESC' });
            const data = await json<{ data: ContestRow[]; basicInfo: { pageCount: number } }>(API + '/acm-heavy/acm/contest/status-list?' + params);
            if (!Array.isArray(data.data) || !data.basicInfo) throw new SyncError('schema_changed', '牛客竞赛提交记录结构发生变化');
            for (const row of data.data) {
              const submittedAt = recordTime(row.submitTime);
              const verdict = RESULT_MAP[row.statusMessage];
              if (String(row.userId) !== uid || !submittedAt || !verdict || !row.submissionId || !row.problemId) continue;
              // 标题兜底必须**等于 problem_key 本身**，不能是 `'牛客 ' + id`。
              // problemWritePolicy 的守卫是 `excluded.title != problems.problem_key`：
              // `'牛客 10'` 既不等于键 `'10'`，也不是真标题 → 它会通过守卫，
              // 把练习行先落下的好标题（如「A+B Problem」）覆盖成「牛客 10」，
              // 同时把 url 从 /acm/problem/10 换成竞赛页地址。
              // 竞赛与练习共享题号空间，这条是常态路径而非边角。
              rows.push({ externalId: String(row.submissionId), submittedAt, verdict, language: row.language,
                problem: { platform: 'nowcoder', problemKey: String(row.problemId), title: row.problemName || String(row.problemId),
                  url: API + '/acm/contest/' + contest + '/' + encodeURIComponent(row.index), tags: [] } });
            }
            if (page < data.basicInfo.pageCount) more = true; else ended.add(contest);
          }
          // Independent streams do not have globally aligned page dates, so rows are merged
          // from several sources per page and deduped here by submission id.
          // 注意：这里**不再**按 windowSince 过滤。pagedFetch 的 since 判定既要丢弃窗口外的行、
          // 又要据此提前终止分页；若在 fetchPage 里先把它们滤掉，pagedFetch 永远看不到「更旧的行」，
          // 窗口早停就失效了（7 天窗口会打满整个页预算）。
          const unique = rows.filter(r => {
            if (seen.has(r.externalId)) return false;
            seen.add(r.externalId);
            return true;
          });
          // A page of pending, duplicate or out-of-window rows must not end another source.
          // 预算耗尽时必须真正收尾：若仍返回 [null] 占位，pagedFetch 会一路翻到页预算尽头，
          // 而每一页都发不出请求（纯空转），既浪费时间又让「请求总量」失去意义。
          if (requestBudget <= 0) return { rows: unique, rawCount: 0 };
          return { rows: unique.length ? unique : more ? [null] : [], rawCount: more ? PAGE_SIZE : 0 };
        },
        externalIdOf: row => row?.externalId ?? '',
        normalize: row => row,
      });
    },
    problemUrl({ problemKey }) {
      return problemKey.startsWith('practice:') ? 'https://www.nowcoder.com/practice/' + problemKey.slice(9) : API + '/acm/problem/' + problemKey;
    },
  };
}
