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
// 每轮对各来源同页扫描，受新增条数和页数双重限制；实际请求由全局节流器错开。
const PER_SYNC_MAX_PAGES = 90;
const PAGE_DELAY_MS = 500; // 牛客反爬较强：页间限速

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
      const contests = new Set<string>();
      for (let page = 1; page <= 20; page++) {
        const data = await json<{ dataList: { contestId: number }[]; pageInfo: { pageCount: number } }>(
          API + '/acm-heavy/acm/contest/profile/contest-joined-history?uid=' + uid + '&page=' + page + '&pageSize=10&onlyJoinedFilter=true&onlyRatingFilter=false&contestEndFilter=false');
        if (!Array.isArray(data.dataList) || !data.pageInfo) throw new SyncError('schema_changed', '牛客竞赛历史结构发生变化');
        for (const c of data.dataList) if (c.contestId) contests.add(String(c.contestId));
        if (page >= data.pageInfo.pageCount) break;
        if (page === 20) throw new SyncError('manual_required', '牛客参赛列表超过本次扫描上限，请使用手动导入补充');
      }
      const ended = new Set<string>();
      const seen = new Set<string>();
      return pagedFetch<NormalizedSubmission | null>({
        pageSize: PAGE_SIZE, perSyncMax: PER_SYNC_MAX_PAGES,
        knownExternalIds: opts?.knownExternalIds, maxSubmissions: opts?.maxSubmissions,
        backfill: opts?.backfill, backfillFromPage: opts?.backfillFromPage, opts,
        pageDelayMs: opts?.pageDelayMs ?? PAGE_DELAY_MS,
        async fetchPage(page) {
          const rows: NormalizedSubmission[] = [];
          let more = false;
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
          for (const contest of contests) {
            if (ended.has(contest)) continue;
            const params = new URLSearchParams({ id: contest, page: String(page), pageSize: '20', searchUserName: uid, orderBy: 'submitTime', orderType: 'DESC' });
            const data = await json<{ data: ContestRow[]; basicInfo: { pageCount: number } }>(API + '/acm-heavy/acm/contest/status-list?' + params);
            if (!Array.isArray(data.data) || !data.basicInfo) throw new SyncError('schema_changed', '牛客竞赛提交记录结构发生变化');
            for (const row of data.data) {
              const submittedAt = recordTime(row.submitTime);
              const verdict = RESULT_MAP[row.statusMessage];
              if (String(row.userId) !== uid || !submittedAt || !verdict || !row.submissionId || !row.problemId) continue;
              rows.push({ externalId: String(row.submissionId), submittedAt, verdict, language: row.language,
                problem: { platform: 'nowcoder', problemKey: String(row.problemId), title: row.problemName || '牛客 ' + row.problemId,
                  url: API + '/acm/contest/' + contest + '/' + encodeURIComponent(row.index), tags: [] } });
            }
            if (page < data.basicInfo.pageCount) more = true; else ended.add(contest);
          }
          // Independent streams do not have globally aligned page dates: filter each row.
          const unique = rows.filter(r => {
            if (seen.has(r.externalId)) return false;
            seen.add(r.externalId);
            return !opts?.windowSince || r.submittedAt >= opts.windowSince;
          });
          // A page of pending, duplicate or out-of-window rows must not end another source.
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
