import type {
  NormalizedSubmission,
  PlatformId,
  Verdict,
} from '../../../shared/src/index.ts';
import type { PlatformAdapter } from './types.ts';
import { ManualImportRequiredError } from './types.ts';

const API = 'https://ac.nowcoder.com';
const MAX_PAGES = 100;

// 牛客提交结果（字符串形式）→ 统一 Verdict；未知值落到 SKIPPED
const RESULT_MAP: Record<string, Verdict> = {
  Accepted: 'AC',
  AC: 'AC',
  'Wrong Answer': 'WA',
  WA: 'WA',
  'Time Limit Exceeded': 'TLE',
  TLE: 'TLE',
  'Memory Limit Exceeded': 'MLE',
  MLE: 'MLE',
  'Runtime Error': 'RE',
  RE: 'RE',
  'Compile Error': 'CE',
  CE: 'CE',
};

interface NcSubmission {
  id?: number | string;
  problemId?: number | string;
  result?: number | string;
  submitTime?: number | string;
  language?: string;
}

interface NcListResp {
  code?: number;
  data?: { list?: NcSubmission[] };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function requestHeaders(handle: string, cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Referer: `${API}/acm/home/${encodeURIComponent(handle)}`,
  };
}

/**
 * 牛客适配器（需登录 Cookie）：
 * - 提交列表：GET /api/v1/user/submission/list?uid={uid}&page={n}（分页 + 限速防反爬）
 * - 响应字段：data.list[{ id, problemId, result, submitTime, language }]
 * - 未配置 Cookie 时抛 ManualImportRequiredError 引导配置/手动导入
 * 注意：牛客无官方文档，接口结构基于社区实现，若失效请提交 issue 调整。
 */
export function createNowcoderAdapter(fetchFn: typeof fetch = fetch): PlatformAdapter {
  return {
    platform: 'nowcoder',

    async fetchUserSubmissions(
      handle: string,
      opts?: { since?: string; cookie?: string; csrf?: string },
    ): Promise<NormalizedSubmission[]> {
      const cookie = opts?.cookie;
      if (!cookie) {
        throw new ManualImportRequiredError(
          'nowcoder',
          '未配置登录 Cookie：请在设置中填写牛客 Cookie 后重试，或使用手动导入',
        );
      }
      const out: NormalizedSubmission[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${API}/api/v1/user/submission/list?uid=${encodeURIComponent(handle)}&page=${page}`;
        const res = await fetchFn(url, {
          headers: requestHeaders(handle, cookie),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
          throw new Error(`牛客 API HTTP ${res.status}（Cookie 可能已过期或触发风控）`);
        }
        const data = (await res.json()) as NcListResp;
        const list = data?.data?.list;
        if (!Array.isArray(list) || list.length === 0) break;
        for (const s of list) {
          const key = String(s.problemId ?? '');
          if (!key) continue;
          const resultStr =
            typeof s.result === 'number' ? String(s.result) : String(s.result ?? '');
          const verdict = RESULT_MAP[resultStr] ?? 'SKIPPED';
          const timeMs =
            typeof s.submitTime === 'number'
              ? s.submitTime
              : Date.parse(String(s.submitTime ?? ''));
          const timeIso =
            Number.isFinite(timeMs) && timeMs > 0
              ? new Date(timeMs).toISOString()
              : new Date().toISOString();
          // 牛客接口无提交 id 时用稳定组合去重
          const externalId =
            s.id !== undefined ? String(s.id) : `nc:${key}:${verdict}:${timeIso}`;
          out.push({
            problem: {
              platform: 'nowcoder' as PlatformId,
              problemKey: key,
              title: key,
              url: `https://ac.nowcoder.com/acm/problem/${key}`,
              tags: [],
            },
            verdict,
            ...(s.language ? { language: s.language } : {}),
            submittedAt: timeIso,
            externalId,
          });
        }
        await sleep(500); // 牛客反爬较强：页间限速
      }
      return out;
    },

    problemUrl({ problemKey }) {
      return `https://ac.nowcoder.com/acm/problem/${String(problemKey)}`;
    },
  };
}
