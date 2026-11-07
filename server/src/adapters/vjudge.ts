import type { Verdict } from '../../../shared/src/index.ts';
import { asHttpClient, type HttpInit } from './http.ts';
import { pagedFetch } from './pagination.ts';
import { recordsJson, recordTime } from './remoteRecords.ts';
import { SyncError, type PlatformAdapter } from './types.ts';
import { vjudgeIdentity, vjudgeProblemUrl } from './vjudgeIdentity.ts';

interface Row {
  runId: number; time: number; oj: string; probNum: string; status: string;
  processing: boolean; userName: string; language?: string; contestId?: number;
}
const VERDICTS: Record<string, Verdict> = {
  Accepted: 'AC', 'Wrong Answer': 'WA', 'Time Limit Exceeded': 'TLE',
  'Memory Limit Exceeded': 'MLE', 'Runtime Error': 'RE', 'Compilation Error': 'CE',
  'Compile Error': 'CE', 'Presentation Error': 'WA', 'Output Limit Exceeded': 'RE',
};

function verdictOf(status: string): Verdict | undefined {
  if (VERDICTS[status]) return VERDICTS[status];
  // Several remote judges append "on test N" and use different capitalization.
  const lower = status?.toLowerCase();
  return Object.entries(VERDICTS).find(([name]) => lower === name.toLowerCase() || lower?.startsWith(`${name.toLowerCase()} on `))?.[1];
}

export function vjudgeHandle(handle: string): string {
  const value = handle.trim();
  if (/^[\w-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    const match = /^\/user\/([\w-]+)\/?$/.exec(url.pathname);
    if (url.protocol === 'https:' && url.hostname === 'vjudge.net' && match) return match[1];
  } catch { /* Invalid profile. */ }
  throw new SyncError('schema_changed', 'VJudge 需要用户名或个人主页链接');
}

/**
 * 记录接口抓取通道。生产环境注入 WebView 同源代理（qojAgent.ts）：vjudge.net 前置的
 * Cloudflare 按 TLS 指纹拦截非浏览器客户端——Node（OpenSSL）直连即便带浏览器 UA / 完整
 * 头部 / 强制 HTTP/1.1 也恒定 403 挑战（2026-11 实测，curl 的 Schannel 指纹可过），
 * 故记录接口一律经壳内 WebView 同源抓取。缺省（测试 / 无壳环境）走 legacy http 路径。
 */
export interface VjudgePageTransport {
  fetchPage(url: string, timeoutMs: number): Promise<{ status: number; body: string; finalUrl?: string }>;
}

/** Cloudflare 托管挑战页特征（助手窗口内偶发交互式质询时返回） */
function isChallengeBody(body: string): boolean {
  return /just a moment|challenge-platform|cf-chl-|turnstile/i.test(body);
}

/** 取一页记录 JSON：agent 路径与 legacy 路径共用后续解析 */
async function fetchRecords(
  http: ReturnType<typeof asHttpClient>,
  url: string,
  handle: string,
  pageTransport?: VjudgePageTransport,
): Promise<{ data: Row[] }> {
  if (pageTransport) {
    const r = await pageTransport.fetchPage(url, 25000);
    if (isChallengeBody(r.body)) {
      throw new SyncError(
        'auth_expired',
        'VJudge 助手窗口被 Cloudflare 拦截：请在设置页点「刷新 VJudge 助手窗口」完成一次人机验证后重试同步。',
      );
    }
    if (r.status !== 200) {
      const code = r.status === 401 || r.status === 403 ? 'auth_expired'
        : r.status === 429 || r.status === 503 ? 'rate_limited' : 'network';
      throw new SyncError(code, `记录接口 HTTP ${r.status}（经助手窗口），请稍后重试`);
    }
    try { return JSON.parse(r.body) as { data: Row[] }; }
    catch { throw new SyncError('schema_changed', '记录接口未返回 JSON，可能需要完成网站验证'); }
  }
  return recordsJson<{ data: Row[] }>(http, url, { headers: { Referer: `https://vjudge.net/user/${encodeURIComponent(handle)}` } });
}

export function createVjudgeAdapter(fetchFn: HttpInit = fetch, pageTransport?: VjudgePageTransport): PlatformAdapter {
  const http = asHttpClient(fetchFn);
  return {
    platform: 'vjudge', knownIdsFilter: true,
    async fetchUserSubmissions(rawHandle, opts) {
      const handle = vjudgeHandle(rawHandle);
      return pagedFetch<Row>({
        pageSize: 20, perSyncMax: 60, since: opts?.windowSince,
        knownExternalIds: opts?.knownExternalIds, maxSubmissions: opts?.maxSubmissions,
        backfill: opts?.backfill, backfillFromPage: opts?.backfillFromPage, opts,
        pageDelayMs: opts?.pageDelayMs ?? 1000,
        async fetchPage(page) {
          const params = new URLSearchParams({ draw: String(page), start: String((page - 1) * 20), length: '20', un: handle, res: '0' });
          const data = await fetchRecords(http, `https://vjudge.net/status/data?${params}`, handle, pageTransport);
          if (!Array.isArray(data.data)) throw new SyncError('schema_changed', 'VJudge 提交记录结构发生变化');
          // VJudge totals are placeholders (9999999); rely on actual rows.
          const rows = data.data.filter(r => r.userName?.toLowerCase() === handle.toLowerCase());
          if (data.data.length && !rows.length) throw new SyncError('schema_changed', 'VJudge 未返回目标账号的记录，请检查用户名或稍后重试');
          return { rows, rawCount: data.data.length };
        },
        externalIdOf: row => String(row.runId),
        normalize(row) {
          const submittedAt = recordTime(row.time);
          const verdict = verdictOf(row.status);
          if (row.processing || !verdict || !submittedAt || !row.runId) return null;
          // 题目身份：本应用**有**的 OJ 映射回原 OJ（保留 vjudge 身份会让同一道题
          // 在库里变成两行：同步落 vjudge/洛谷-P1001、URL 导入落 luogu/P1001，同步来的 AC
          // 在复习条目上永远不显示、统计里各算一次）；本应用**没有**的 OJ（SPOJ / HDU /
          // Toph / CSES …）落 vjudge 身份并用 VJudge 的链接与题号 —— VJudge 是这些 OJ
          // 唯一可用的数据源，丢掉不等于没有，旧实现直接丢弃，用户的 AC 永远进不了库。
          // 只有 oj / 题号本身缺失才跳过（那是真的没有身份，不是没有平台）。
          const identity = vjudgeIdentity(row.oj, row.probNum);
          if (!identity) return null;
          return { externalId: String(row.runId), submittedAt, verdict, language: row.language,
            problem: { platform: identity.platform, problemKey: identity.problemKey,
              title: identity.problemKey, url: identity.url, tags: [] } };
        },
      });
    },
    // 只在**缺 url** 时兜底（调用方一般直接用行上存的 url）。落到这里的键可能是
    // vjudge 身份（本应用没有该 OJ，题号形如 `SPOJ-INOUTEST`）也可能是原 OJ 题号
    // （历史调用点），统一按 VJudge 转发链接拼——编码口径与 vjudgeIdentity 同一份。
    problemUrl: ({ problemKey }) => vjudgeProblemUrl(String(problemKey)),
  };
}
