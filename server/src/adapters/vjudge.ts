import type { Verdict } from '../../../shared/src/index.ts';
import { asHttpClient, type HttpInit } from './http.ts';
import { pagedFetch } from './pagination.ts';
import { recordsJson, recordTime } from './remoteRecords.ts';
import { SyncError, type PlatformAdapter } from './types.ts';
import { vjudgeIdentity } from './vjudgeIdentity.ts';

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

export function createVjudgeAdapter(fetchFn: HttpInit = fetch): PlatformAdapter {
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
          const data = await recordsJson<{ data: Row[] }>(http, `https://vjudge.net/status/data?${params}`, { headers: { Referer: `https://vjudge.net/user/${encodeURIComponent(handle)}` } });
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
          // 映射回原 OJ：保留 vjudge 身份会让同一道题在库里变成两行
          // （同步落 vjudge/洛谷-P1001、URL 导入落 luogu/P1001），
          // 同步来的 AC 在复习条目上永远不显示，统计里也各算一次。
          const identity = vjudgeIdentity(row.oj, row.probNum);
          // 映射不了的原 OJ（SPOJ / POJ / SGU …）说明本应用没有对应题库：
          // 落库只会造出永远补不上难度、也没有题面来源的幽灵题目，直接跳过。
          if (!identity) return null;
          return { externalId: String(row.runId), submittedAt, verdict, language: row.language,
            problem: { platform: identity.platform, problemKey: identity.problemKey,
              title: identity.problemKey, url: identity.url, tags: [] } };
        },
      });
    },
    // 记录已映射回原 OJ，题号是**原站**题号；这里保留 VJudge 转发链接仅作兜底
    // （调用方一般直接用行上存的 url，本方法只在缺 url 时兜底）。
    problemUrl: ({ problemKey }) => `https://vjudge.net/problem/${encodeURIComponent(problemKey)}`,
  };
}
