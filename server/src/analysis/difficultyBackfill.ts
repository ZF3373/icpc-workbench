import type { Db } from '../db/index.ts';
import { fetchWithChallenge, luoguDifficultyToRating } from '../adapters/luogu.ts';

/** 单题回填查得的信息 */
export interface BackfillInfo {
  problemKey: string;
  difficulty: number | null;
  title: string | null;
  tags: string[] | null;
}

/** 单平台回填结果 */
export interface PlatformBackfillResult {
  platform: string;
  /** 参与回填的题数（该平台需补难度的题） */
  scanned: number;
  /** 难度被补上的题数 */
  filled: number;
  /** 标题/标签被修正的题数 */
  repaired: number;
  /** 上游仍无难度数据的题数（官方未评级等） */
  missing: number;
  /** 拉取失败（风控/网络）的题数 */
  failed: number;
  /** 每题明细（problemKey → 说明） */
  details: Array<{ problemKey: string; action: 'filled' | 'repaired' | 'missing' | 'failed'; note?: string }>;
}

const NOWCODER_API = 'https://ac.nowcoder.com';
const LUOGU_API = 'https://www.luogu.com.cn';
const NC_DELAY_MS = 450; // 牛客反爬较强：逐题搜索限速
const LG_DELAY_MS = 300;
const NC_FAIL_LIMIT = 8; // 连续失败阈值：超过视为触发风控，中止平台回填
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- 牛客：题库列表页 keyword=题号 精确搜索 ----------

/**
 * 解析牛客搜索结果行，分离标题与标签（.title 链接为标题，.tag-label 为算法标签）。
 * 返回 null 表示未命中该题号。
 */
export function parseNcSearchRow(html: string, problemKey: string): BackfillInfo | null {
  const trRe = new RegExp(`<tr[^>]*data-problemId="${problemKey}"[^>]*>([\\s\\S]*?)</tr>`);
  const m = trRe.exec(html);
  if (!m) return null;
  const titleMatch = /class="title"[^>]*>([\s\S]*?)<\/a>/.exec(m[1]);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    : null;
  const tags = [...m[1].matchAll(/class="tag-label[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((t) => t[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim())
    .filter(Boolean);
  const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
  const diffText = (tds[2] ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  const difficulty = /^\d+$/.test(diffText) ? Number(diffText) : null;
  return { problemKey, difficulty, title, tags: tags.length > 0 ? tags : null };
}

/** 牛客单题回填：keyword=题号 搜索（匿名可访问），未命中/风控返回 null */
export async function fetchNcProblemInfo(
  fetchFn: typeof fetch,
  problemKey: string,
): Promise<BackfillInfo | null> {
  const url = `${NOWCODER_API}/acm/problem/list?keyword=${encodeURIComponent(problemKey)}`;
  const res = await fetchFn(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${NOWCODER_API}/acm/problem/list`,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null; // 调用方按连续失败计数中止
  const html = await res.text();
  return parseNcSearchRow(html, problemKey);
}

// ---------- 洛谷：单题详情（匿名 + C3VK 挑战） ----------

/** 洛谷单题回填：GET /problem/{pid}（content-only），难度分级映射 CF rating，tag id 经字典转名称 */
export async function fetchLgProblemInfo(
  fetchFn: typeof fetch,
  problemKey: string,
  tagDict?: Map<number, string>,
): Promise<BackfillInfo | null> {
  const res = await fetchWithChallenge(fetchFn, `${LUOGU_API}/problem/${problemKey}`, '', undefined, {
    'x-lentille-request': 'content-only',
    Accept: 'application/json',
    Referer: `${LUOGU_API}/problem/${problemKey}`,
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (!text.trim().startsWith('{')) return null;
  const data = JSON.parse(text) as {
    currentData?: { problem?: LgProblemPayload };
    data?: { problem?: LgProblemPayload };
    problem?: LgProblemPayload;
  };
  const p = data.currentData?.problem ?? data.data?.problem ?? data.problem;
  if (!p) return null;
  const difficulty =
    typeof p.difficulty === 'number' && p.difficulty > 0 ? luoguDifficultyToRating(p.difficulty) : null;
  // 标题字段为 name（旧结构 title）；tags 新结构为 id 数组（需字典），旧结构为 {name} 对象数组
  const title = typeof p.name === 'string' ? p.name : typeof p.title === 'string' ? p.title : null;
  const rawTags = Array.isArray(p.tags) ? p.tags : [];
  const tags = rawTags
    .map((t) => {
      if (typeof t === 'number') return tagDict?.get(t) ?? '';
      if (t && typeof t === 'object' && typeof t.name === 'string') return t.name;
      return '';
    })
    .filter(Boolean);
  return {
    problemKey,
    difficulty,
    title,
    tags: tags.length > 0 ? tags : null,
  };
}

interface LgProblemPayload {
  name?: string;
  title?: string;
  difficulty?: number;
  tags?: Array<{ name?: string } | number>;
}

/** 洛谷 tag id → 名称字典（/_lfe/tags 匿名可访问；失败降级空字典，仅丢失标签） */
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
    // 字典失败不阻断回填（难度照常补全）
  }
  return dict;
}

// ---------- 回填服务 ----------

function ncTitlePolluted(title: string): boolean {
  // 历史问题：parseNcRows 曾把标签 a 链接连着换行一起剥进标题
  return /\n/.test(title) || /\s{4,}\S/.test(title.trim());
}

/** 清洗被污染的牛客标题：仅保留第一段非空文本 */
export function cleanNcTitle(title: string): string {
  const first = title.split('\n').map((s) => s.trim()).find((s) => s.length > 0);
  return first ?? title.trim();
}

/**
 * 未知难度回填：对库内 difficulty IS NULL 的洛谷/牛客题逐题查询公开接口。
 * - 牛客：题库搜索接口可返回难度分 + 分离的标题/标签（顺带修复标题污染/空标签）
 * - 洛谷：单题详情接口返回难度分级 → 映射 CF rating
 * - 已有难度但标题/标签异常的牛客题也参与修复（仅更新元信息，不动难度）
 * - 连续失败超过阈值判定风控中止，剩余题留待下次
 */
export async function backfillDifficulties(
  db: Db,
  fetchFn: typeof fetch = fetch,
): Promise<PlatformBackfillResult[]> {
  const results: PlatformBackfillResult[] = [];

  // 牛客：未知难度 ∪ 标题污染/无标签的已知题
  const ncRows = db
    .prepare(
      "SELECT problem_key, title, difficulty, tags FROM problems WHERE platform = 'nowcoder' ORDER BY problem_key",
    )
    .all() as Array<{ problem_key: string; title: string; difficulty: number | null; tags: string }>;
  const ncTargets = ncRows.filter(
    (r) =>
      r.difficulty === null ||
      ncTitlePolluted(r.title) ||
      JSON.parse(r.tags).length === 0,
  );

  if (ncTargets.length > 0) {
    const r: PlatformBackfillResult = { platform: 'nowcoder', scanned: ncTargets.length, filled: 0, repaired: 0, missing: 0, failed: 0, details: [] };
    let consecutiveFails = 0;
    const getDiff = db.prepare(
      'SELECT difficulty FROM problems WHERE platform = ? AND problem_key = ?',
    );
    const update = db.prepare(
      'UPDATE problems SET difficulty = COALESCE(difficulty, ?), title = ?, tags = ? WHERE platform = ? AND problem_key = ?',
    );
    for (const row of ncTargets) {
      if (consecutiveFails >= NC_FAIL_LIMIT) {
        r.failed += 1;
        r.details.push({ problemKey: row.problem_key, action: 'failed', note: '疑似触发风控，中止后续查询（可稍后重试）' });
        continue;
      }
      let info: BackfillInfo | null = null;
      let failed = false;
      try {
        info = await fetchNcProblemInfo(fetchFn, row.problem_key);
      } catch {
        failed = true;
      }
      if (failed || info === null) {
        // 未命中也可能是题号已废弃（如转私密），按单题缺失计，连续缺失也计入风控判定
        r.failed += 1;
        r.details.push({ problemKey: row.problem_key, action: 'failed', note: failed ? '请求失败' : '搜索未命中' });
        consecutiveFails += 1;
        await sleep(NC_DELAY_MS);
        continue;
      }
      consecutiveFails = 0;
      const newTitle = info.title ?? (ncTitlePolluted(row.title) ? cleanNcTitle(row.title) : row.title);
      const newTags = info.tags ?? JSON.parse(row.tags);
      const before = getDiff.get('nowcoder', row.problem_key) as { difficulty: number | null };
      update.run(info.difficulty, newTitle, JSON.stringify(newTags), 'nowcoder', row.problem_key);
      if (before.difficulty === null && info.difficulty !== null) {
        r.filled += 1;
        r.details.push({ problemKey: row.problem_key, action: 'filled', note: `难度 ${info.difficulty}` });
      } else if (info.difficulty === null) {
        r.missing += 1;
        r.details.push({ problemKey: row.problem_key, action: 'missing', note: '官方无难度分' });
      } else if (newTitle !== row.title || JSON.stringify(newTags) !== row.tags) {
        r.repaired += 1;
        r.details.push({ problemKey: row.problem_key, action: 'repaired', note: '修正标题/标签' });
      }
      await sleep(NC_DELAY_MS);
    }
    results.push(r);
  }

  // 洛谷：仅未知难度题（洛谷入库时标题/标签已可靠）
  const lgKeys = db
    .prepare("SELECT problem_key FROM problems WHERE platform = 'luogu' AND difficulty IS NULL")
    .all() as Array<{ problem_key: string }>;
  if (lgKeys.length > 0) {
    const r: PlatformBackfillResult = { platform: 'luogu', scanned: lgKeys.length, filled: 0, repaired: 0, missing: 0, failed: 0, details: [] };
    // tag 字典（/_lfe/tags 匿名可访问）：失败降级为空字典，仅丢失标签不影响难度
    const tagDict = await fetchLuoguTagDict(fetchFn);
    const update = db.prepare(
      "UPDATE problems SET difficulty = ? WHERE platform = 'luogu' AND problem_key = ?",
    );
    for (const { problem_key: key } of lgKeys) {
      let info: BackfillInfo | null = null;
      try {
        info = await fetchLgProblemInfo(fetchFn, key, tagDict);
      } catch {
        info = null;
      }
      if (info === null) {
        r.failed += 1;
        r.details.push({ problemKey: key, action: 'failed', note: '查询失败' });
      } else if (info.difficulty !== null) {
        update.run(info.difficulty, key);
        r.filled += 1;
        r.details.push({ problemKey: key, action: 'filled', note: `难度 ${info.difficulty}` });
      } else {
        r.missing += 1;
        r.details.push({ problemKey: key, action: 'missing', note: '洛谷难度为「暂无评定」' });
      }
      await sleep(LG_DELAY_MS);
    }
    results.push(r);
  }

  return results;
}
