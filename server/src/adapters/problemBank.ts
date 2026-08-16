import type { PlatformId } from '../../../shared/src/index.ts';
import { fetchWithChallenge, luoguDifficultyToRating } from './luogu.ts';

/** 题库题目（无提交记录，仅供扩充待选池） */
export interface BankProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  /** CF rating 统一标尺 */
  difficulty: number | null;
  url: string;
  tags: string[];
}

export interface BankFetchOptions {
  /** 洛谷难度下限（1-8 官方分级；默认 3=普及/提高-，过滤纯水题） */
  luoguMinDifficulty?: number;
  /** 每平台最大拉取题数（默认 2000；洛谷约 40 页、牛客约 40 页） */
  max?: number;
  /** 进度回调（每完成一页触发） */
  onProgress?: (fetched: { platform: PlatformId; count: number; total: number | null }) => void;
}

export interface BankFetchResult {
  platform: PlatformId;
  problems: BankProblem[];
  /** 服务端报告的题目总数（洛谷 count / 牛客「共 N 条」；解析失败为 null） */
  total: number | null;
}

const LUOGU_API = 'https://www.luogu.com.cn';
const NOWCODER_API = 'https://ac.nowcoder.com';
const LUOGU_PER_PAGE = 50;
const NOWCODER_PER_PAGE = 50;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- 洛谷 ----------

interface LuoguListProblem {
  pid?: string;
  name?: string;
  difficulty?: number;
  /** Lentille 接口返回 tag id 数组，需经 /_lfe/tags 字典转名称 */
  tags?: number[];
}

/**
 * 洛谷公开题库（无需登录）：
 * GET /problem/list?page={n}&type=P&difficulty={d}
 * 请求头 x-lentille-request: content-only；C3VK 挑战由 fetchWithChallenge 自动处理。
 * difficulty 参数支持「最小难度」语义（如 difficulty=4 → 普及+/提高 及以上），
 * 服务端按难度升序返回，翻页至难度超限或页空终止。
 */
export async function fetchLuoguBank(
  fetchFn: typeof fetch,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const minDiff = clamp(opts.luoguMinDifficulty ?? 3, 1, 8);
  const problems: BankProblem[] = [];
  const tagDict = await fetchLuoguTagDict(fetchFn);
  let total: number | null = null;

  for (let page = 1; page <= 200; page += 1) {
    const url = `${LUOGU_API}/problem/list?page=${page}&type=P&difficulty=${minDiff}`;
    const res = await fetchWithChallenge(fetchFn, url, '', undefined, {
      'x-lentille-request': 'content-only',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${LUOGU_API}/problem/list`,
    });
    if (!res.ok) {
      throw new Error(`洛谷题库接口 HTTP ${res.status}，请稍后重试`);
    }
    const text = await res.text();
    if (!text.trim().startsWith('{')) {
      throw new Error('洛谷题库接口返回非 JSON（触发风控或接口变化），请稍后重试');
    }
    const data = JSON.parse(text) as {
      status?: number;
      data?: {
        problems?: {
          count?: number;
          perPage?: number;
          result?: LuoguListProblem[];
        };
      };
    };
    const list = data.data?.problems;
    if (!list || !Array.isArray(list.result)) {
      throw new Error('洛谷题库接口响应结构异常，请稍后重试');
    }
    if (typeof list.count === 'number') total = list.count;
    if (list.result.length === 0) break;

    for (const p of list.result) {
      if (typeof p.pid !== 'string' || !p.pid) continue;
      const rating =
        typeof p.difficulty === 'number' ? luoguDifficultyToRating(p.difficulty) : null;
      problems.push({
        platform: 'luogu',
        problemKey: p.pid,
        title: p.name ?? p.pid,
        difficulty: rating,
        url: `https://www.luogu.com.cn/problem/${p.pid}`,
        tags: (p.tags ?? [])
          .map((id) => tagDict.get(id))
          .filter((t): t is string => typeof t === 'string'),
      });
    }
    opts.onProgress?.({ platform: 'luogu', count: problems.length, total });
    if (problems.length >= max) break;
    if (list.result.length < (list.perPage ?? LUOGU_PER_PAGE)) break;
    await sleep(400); // 洛谷限速：页间间隔
  }
  return { platform: 'luogu', problems: problems.slice(0, max), total };
}

/** 洛谷 tag id → 名称字典（/_lfe/tags，匿名可访问；失败降级为空字典，仅丢失标签） */
async function fetchLuoguTagDict(fetchFn: typeof fetch): Promise<Map<number, string>> {
  const dict = new Map<number, string>();
  try {
    const res = await fetchWithChallenge(fetchFn, `${LUOGU_API}/_lfe/tags`, '', undefined, {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${LUOGU_API}/`,
    });
    if (res.ok) {
      const d = (await res.json()) as { tags?: Array<{ id: number; name: string }> };
      for (const t of d.tags ?? []) dict.set(t.id, t.name);
    }
  } catch {
    // 字典拉取失败不阻断题库同步（题目照常入库，仅无标签）
  }
  return dict;
}

// ---------- 牛客 ----------

interface NcBankRow {
  problemId: string;
  title: string;
  difficulty: number | null;
}

/**
 * 牛客公开题库页（无需登录）：GET /acm/problem/list?page={n}
 * 表格行 <tr data-problemId="...">：列依次为 NC 题号 / 标题 / 难度分 / 通过数 / 收藏。
 * 难度分为 CF 风格分值（如 700 / 1100 / 1500），直接作为统一难度标尺。
 * 页面无服务端难度筛选（前端 JS 过滤），按 orderById 顺序翻页。
 */
export async function fetchNowcoderBank(
  fetchFn: typeof fetch,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  const seen = new Set<string>();
  let total: number | null = null;

  for (let page = 1; page <= 200; page += 1) {
    const url = `${NOWCODER_API}/acm/problem/list?queryType=all&orderById=true&page=${page}`;
    const res = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: `${NOWCODER_API}/acm/problem/list`,
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`牛客题库页 HTTP ${res.status}，请稍后重试`);
    }
    const html = await res.text();
    if (total === null) {
      const m = html.match(/共\s*(\d+)\s*条/);
      if (m) total = Number(m[1]);
    }
    const rows = parseNcRows(html);
    if (rows.length === 0) break;

    for (const row of rows) {
      const key = row.problemId;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({
        platform: 'nowcoder',
        problemKey: key,
        title: row.title || `NC${key}`,
        difficulty: row.difficulty,
        url: `https://ac.nowcoder.com/acm/problem/${key}`,
        tags: [],
      });
    }
    opts.onProgress?.({ platform: 'nowcoder', count: problems.length, total });
    if (problems.length >= max) break;
    if (rows.length < NOWCODER_PER_PAGE) break;
    await sleep(500); // 牛客反爬较强：页间限速
  }
  return { platform: 'nowcoder', problems: problems.slice(0, max), total };
}

/** 解析牛客题库页表格行（data-problemId 行；列：NC 题号 / 标题 / 难度 / 通过数 / 收藏） */
function parseNcRows(html: string): NcBankRow[] {
  const rows: NcBankRow[] = [];
  const trRe = /<tr[^>]*data-problemId="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const problemId = m[1];
    const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) =>
      x[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(),
    );
    if (tds.length < 3) continue; // 异常行跳过
    const diffText = tds[2];
    const difficulty = /^\d+$/.test(diffText) ? Number(diffText) : null;
    rows.push({ problemId, title: tds[1], difficulty });
  }
  return rows;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
