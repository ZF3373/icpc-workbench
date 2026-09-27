import type { PlatformId } from '../../../shared/src/index.ts';
import { difficultyFields, parseNowcoderScore, toCfRating, type DifficultyScale } from '../../../shared/src/difficulty.ts';
import { fetchWithChallenge } from './luogu.ts';
import { parseJisuankeProblemTags } from './jisuanke.ts';
import { asHttpClient, sleep, type HttpInit } from './http.ts';

export { parseJisuankeProblemTags };

/** 洛谷题库类型：P 常规题 / B 入门与面试 / CF、AT 为镜像题 / SP、UVA 为外站题 */
export type LuoguProblemType = 'P' | 'B' | 'CF' | 'AT' | 'SP' | 'UVA';

/** 题库题目（无提交记录，仅供扩充待选池） */
export interface BankProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  /** CF rating 统一标尺（未知一律 null，不产出猜测值） */
  difficulty: number | null;
  /** 平台原生难度原文（未知为 null；平台改档后可据此按新标度重算） */
  nativeDifficulty: string | null;
  /** 原生难度所属标度（见 shared/src/difficulty.ts 的 DifficultyScale） */
  difficultyScale: DifficultyScale | null;
  url: string;
  tags: string[];
}

/**
 * `difficultyFields` 的题库包装：题库行的三个难度字段都是必填（未知 = null）。
 * 映射表只此一份（shared/src/difficulty.ts），这里不做任何本地换算。
 */
function bankDifficulty(
  platform: PlatformId,
  raw: unknown,
): { difficulty: number | null; nativeDifficulty: string | null; difficultyScale: DifficultyScale } {
  const f = difficultyFields(platform, raw);
  return {
    difficulty: f.difficulty ?? null,
    nativeDifficulty: f.nativeDifficulty ?? null,
    difficultyScale: f.difficultyScale,
  };
}

export interface BankFetchOptions {
  /** 洛谷难度下限（1-8 官方分级；默认 3=普及/提高-，过滤纯水题） */
  luoguMinDifficulty?: number;
  /** 洛谷题库类型（默认 `['P']`；镜像题用 'CF' / 'AT'） */
  luoguTypes?: LuoguProblemType[];
  /** 每平台最大拉取题数（默认 2000；洛谷约 40 页、牛客约 40 页） */
  max?: number;
  /**
   * 用洛谷 AT 镜像题补 AtCoder 算法标签（默认 false）。
   * 洛谷 AT 镜像题号只有一部分能对应 kenkoooo 题号（`AT_abc300_a` → `abc300_a`；
   * `AT1202Contest_a` 这类洛谷自定义比赛号无对应），故默认关闭并在结果里如实上报命中计数。
   */
  atcoderTagsFromLuogu?: boolean;
  /**
   * 目标题号集合：**全部命中后立即停止翻页**（回填场景用 —— 只为库里几百道缺难度的题扫完整表
   * 是纯浪费；实测牛客全表 200 页/2 分钟，而目标往往在前几页就齐了）。
   * 不传 = 保持原有行为（按 `max` / 页数上限拉完）。
   */
  wantKeys?: ReadonlySet<string>;
  /** 进度回调（每完成一页触发） */
  onProgress?: (fetched: { platform: PlatformId; count: number; total: number | null }) => void;
}

/**
 * `wantKeys` 早停判定器：每命中一个目标题号即从待命中移除，全部命中后返回 true。
 * 不传 `wantKeys`（或为空集）时恒返回 false —— 不改变「按 max/页数上限拉完」的既有语义。
 */
function makeWantedTracker(wantKeys?: ReadonlySet<string>): (key: string) => boolean {
  if (!wantKeys || wantKeys.size === 0) return () => false;
  const remaining = new Set(wantKeys);
  return (key: string) => remaining.delete(key) && remaining.size === 0;
}

export interface BankFetchResult {
  platform: PlatformId;
  problems: BankProblem[];
  /** 服务端报告的题目总数（洛谷 count / 牛客「共 N 条」；解析失败为 null） */
  total: number | null;
  /** AtCoder 标签桥统计（仅在 atcoderTagsFromLuogu 开启时给出） */
  tagScanned?: number;
  tagMatched?: number;
  tagWithTags?: number;
  tagSkipped?: number;
}

const LUOGU_API = 'https://www.luogu.com.cn';
const NOWCODER_API = 'https://ac.nowcoder.com';
const CODEFORCES_API = 'https://codeforces.com/api';
const KENKOOOO_API = 'https://kenkoooo.com/atcoder';
const DAIMAYUAN_BASE = 'https://bs.daimayuan.top';
const LUOGU_PER_PAGE = 50;
const NOWCODER_PER_PAGE = 50;
const DAIMAYUAN_PER_PAGE = 100;

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
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const minDiff = clamp(opts.luoguMinDifficulty ?? 3, 1, 8);
  const types = opts.luoguTypes && opts.luoguTypes.length > 0 ? opts.luoguTypes : (['P'] as LuoguProblemType[]);
  const problems: BankProblem[] = [];
  const tagDict = await fetchLuoguTagDict(fetchFn);
  let total: number | null = null;

  // 多类型：逐类型翻到空页/难度越界为止（每类型各自按难度升序返回）
  outer: for (const type of types) {
    for (let page = 1; page <= 200; page += 1) {
      const url = `${LUOGU_API}/problem/list?page=${page}&type=${type}&difficulty=${minDiff}`;
      const res = await fetchWithChallenge(asHttpClient(fetchFn), url, '', undefined, {
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
      // 多类型时 total 为各类型服务端总数之和（单类型即该类型的 count）
      if (typeof list.count === 'number' && page === 1) total = (total ?? 0) + list.count;
      if (list.result.length === 0) break;

      for (const p of list.result) {
        if (typeof p.pid !== 'string' || !p.pid) continue;
        problems.push({
          platform: 'luogu',
          problemKey: p.pid,
          title: p.name ?? p.pid,
          // difficulty=0 = 洛谷「暂无评定」（注意与列表接口 difficulty 参数的「最小难度」语义不同，
          // 后者由 luoguMinDifficulty 表达）→ 未知难度一律 null，不产出 difficulty 键
          ...bankDifficulty('luogu', p.difficulty),
          url: `https://www.luogu.com.cn/problem/${p.pid}`,
          tags: (p.tags ?? [])
            .map((id) => tagDict.get(id))
            .filter((t): t is string => typeof t === 'string'),
        });
      }
      opts.onProgress?.({ platform: 'luogu', count: problems.length, total });
      if (problems.length >= max) break outer;
      if (list.result.length < (list.perPage ?? LUOGU_PER_PAGE)) break;
      await sleep(400); // 洛谷限速：页间间隔
    }
  }
  return { platform: 'luogu', problems: problems.slice(0, max), total };
}

/** 洛谷 tag id → 名称字典（/_lfe/tags，匿名可访问；失败降级为空字典，仅丢失标签） */
async function fetchLuoguTagDict(fetchFn: HttpInit): Promise<Map<number, string>> {
  const dict = new Map<number, string>();
  try {
    const res = await fetchWithChallenge(asHttpClient(fetchFn), `${LUOGU_API}/_lfe/tags`, '', undefined, {
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
  /** CF rating 统一标尺（由原生难度分映射而来；未知为 null） */
  difficulty: number | null;
  /** 站点难度分原文（映射前；未知为 null） */
  nativeScore: number | null;
  tags: string[];
}

/**
 * 牛客公开题库页（无需登录）：GET /acm/problem/list?page={n}
 * 表格行 <tr data-problemId="...">：列依次为 NC 题号 / 标题（+算法标签）/ 难度分 / 通过数 / 收藏。
 * 难度分为 CF 风格分值（如 700 / 1100 / 1500），经统一标尺映射（[800,3500] 钳位）。
 * 页面无服务端难度筛选（前端 JS 过滤），按 orderById 顺序翻页。
 */
export async function fetchNowcoderBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  const seen = new Set<string>();
  const hitWanted = makeWantedTracker(opts.wantKeys);
  let total: number | null = null;
  let wantedDone = false;

  for (let page = 1; page <= 200; page += 1) {
    const url = `${NOWCODER_API}/acm/problem/list?queryType=all&orderById=true&page=${page}`;
    const res = await asHttpClient(fetchFn).fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: `${NOWCODER_API}/acm/problem/list`,
      },
    });
    if (!res.ok) {
      throw new Error(`牛客题库页 HTTP ${res.status}，请稍后重试`);
    }
    const html = await res.text();
    if (total === null) {
      const m = html.match(/共\s*(\d+)\s*条/);
      if (m) total = Number(m[1]);
    }
    const rows = parseNcBankRows(html);
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
        // 原生分落原文（而不是映射后的 CF 值）：分数低于 CF 下限时钳位会丢掉站点原值
        nativeDifficulty: row.nativeScore === null ? null : String(row.nativeScore),
        difficultyScale: 'nowcoder-score',
        url: `https://ac.nowcoder.com/acm/problem/${key}`,
        tags: row.tags,
      });
      if (hitWanted(key)) {
        wantedDone = true;
        break;
      }
    }
    opts.onProgress?.({ platform: 'nowcoder', count: problems.length, total });
    if (wantedDone) break;
    if (problems.length >= max) break;
    if (rows.length < NOWCODER_PER_PAGE) break;
    await sleep(500); // 牛客反爬较强：页间限速
  }
  return { platform: 'nowcoder', problems: problems.slice(0, max), total };
}

/**
 * 牛客行内单元格文本净化：去标签、`&nbsp;` 归一、空白压缩。
 */
export function stripNcCell(raw: string): string {
  return raw.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 牛客表格行的单元格解析结果（标题 / 算法标签 / 难度分） */
export interface NcRowCells {
  /** 标题单元格文本（行内无 `class="title"` 锚点时为 ''） */
  title: string;
  tags: string[];
  /** 难度分（由共享校验器 parseNowcoderScore 裁决；未知为 null） */
  nativeScore: number | null;
}

/**
 * **唯一的**牛客行解析（题库列表页与标题搜索页两处读取方共用这一份，不得各写一套）。
 *
 * 四个必须遵守的坑：
 * 1. **先收标签、再取标题**：标签是 `class="tag-label"` 的 `<a>`，标题是 `class="title"` 的 `<a>`；
 *    若把整行文本抠一遍再 trim，标签文本会并进标题（本项目已踩过一次）。
 * 2. **难度只认「标题单元格的下一个单元格」**：标题单元格带 `colspan="2"`，行内单元格数量不固定，
 *    但难度列恒紧跟在标题单元格之后。没有标题单元格 → 难度未知（不得从 `tds[0]` 之类的位置顺延）；
 *    绝**不**向后继续扫描找数字——否则难度为空的行会取到通过数（伪造成难度）。
 *    历史缺陷：回填路径曾直接取 `tds[2]`，与题库路径的「标题锚点 + 后一格」规则不一致，
 *    行内列数一变就会把通过数当难度写库，而 backfill(3) 的优先级高于 bank(1)/sync(2)。
 * 3. **取值规则由 `parseNowcoderScore` 统一裁决**（200..4000 的纯数字整数；详见 shared/src/difficulty.ts）。
 * 4. **结构校验代替数值校验**（2026-09-27 起）：牛客真实难度分**不保证是 100 的倍数**
 *    （老题实测 1049 / 623 / 726 / 876 / 972），所以不能再靠「整百」当防串列的护栏。
 *    改为校验**列结构**：难度单元格之外必须同时存在通过人数单元格与操作锚点
 *    （`class="js-collect-question"`，恒为最后一格），且难度文本 ≠ 通过人数文本。
 *    列结构一旦变化（例如难度列被移除、整行错位）→ 难度记 unknown，宁可未知、不可臆造。
 *    注入样式与真实行的取证见 shared/src/difficulty.ts 的 `parseNowcoderScore` 注释。
 */
export function parseNcRowCells(cell: string): NcRowCells {
  const tds = [...cell.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
  const tags = [...cell.matchAll(/class="tag-label[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((t) => stripNcCell(t[1]))
    .filter(Boolean);
  const title = stripNcCell(/class="title"[^>]*>([\s\S]*?)<\/a>/.exec(cell)?.[1] ?? '');
  const titleIdx = tds.findIndex((t) => /class="title"/.test(t));
  // 结构校验（见 doc 第 4 条）：五列行 = 题号 / 标题+知识点 / 难度 / 通过人数 / 操作。
  // 操作锚点恒在最后一格；标题之后至少还要有难度、通过人数、操作三格。
  const opIdx = tds.findIndex((t) => /class="js-collect-question/.test(t));
  const structureOk =
    titleIdx >= 0 && opIdx === tds.length - 1 && tds.length >= 5 && titleIdx + 3 < tds.length;
  const diffText = structureOk ? stripNcCell(tds[titleIdx + 1] ?? '') : '';
  const passText = structureOk ? stripNcCell(tds[titleIdx + 2] ?? '') : '';
  const nativeScore =
    structureOk && diffText !== '' && diffText !== passText ? parseNowcoderScore(diffText) : null;
  return { title, tags, nativeScore };
}

/**
 * 解析牛客题库页表格行（`parseNcRowCells` 的行级包装）。
 * 题号行里标题与标签都为空时跳过（分页尾部可能夹带空行/模板行）。
 */
export function parseNcBankRows(html: string): NcBankRow[] {
  const rows: NcBankRow[] = [];
  const trRe = /<tr[^>]*data-problemId="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const problemId = m[1];
    const { title, tags, nativeScore } = parseNcRowCells(m[2]);
    if (title === '' && tags.length === 0) continue;
    rows.push({
      problemId,
      title,
      difficulty: nativeScore === null ? null : toCfRating('nowcoder', nativeScore),
      nativeScore,
      tags,
    });
  }
  return rows;
}

// ---------- Codeforces ----------

interface CfProblemsetProblem {
  contestId?: number;
  index?: string;
  name?: string;
  rating?: number;
  tags?: string[];
}

/**
 * Codeforces 官方公开接口 problemset.problems（匿名）：单次调用返回全量题库
 * （约 1 万题，自带 CF rating 与算法标签），无翻页、无限速压力。
 * 无 contestId 的条目（acmsguru 等）不在 /contest/{id}/problem/ 链接体系内，跳过。
 */
export async function fetchCodeforcesBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 20000;
  const res = await asHttpClient(fetchFn).fetch(`${CODEFORCES_API}/problemset.problems`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  }, { timeoutMs: 30000 }); // 单次返回约 1 万题的全量题库，放宽超时
  if (!res.ok) {
    throw new Error(`Codeforces 题库接口 HTTP ${res.status}，请稍后重试`);
  }
  const data = JSON.parse(await res.text()) as {
    status?: string;
    comment?: string;
    result?: { problems?: CfProblemsetProblem[] };
  };
  const list = data.result?.problems;
  if (data.status !== 'OK' || !Array.isArray(list)) {
    throw new Error(`Codeforces 题库接口响应异常${data.comment ? `：${data.comment}` : ''}`);
  }
  const problems: BankProblem[] = [];
  for (const p of list) {
    if (typeof p.contestId !== 'number' || typeof p.index !== 'string' || !p.index) continue;
    problems.push({
      platform: 'codeforces',
      problemKey: `${p.contestId}${p.index}`.toUpperCase(),
      title: p.name ?? `${p.contestId}${p.index}`,
      // CF rating 本身就是统一标尺：原生原文 = rating 原文，标度 cf-rating（钳位由 shared 负责）
      ...bankDifficulty('codeforces', p.rating ?? null),
      url: `https://codeforces.com/contest/${p.contestId}/problem/${p.index}`,
      tags: Array.isArray(p.tags) ? p.tags : [],
    });
    if (problems.length >= max) break;
  }
  return { platform: 'codeforces', problems, total: list.length };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

// ---------- 力扣（leetcode.cn） ----------

interface LcBankQuestion {
  frontendQuestionId?: string;
  title?: string;
  titleCn?: string;
  titleSlug?: string;
  difficulty?: string;
  paidOnly?: boolean;
  topicTags?: Array<{ name?: string; nameTranslated?: string }>;
}

const LEETCODE_GRAPHQL = 'https://leetcode.cn/graphql';
export const LEETCODE_BANK_PAGE = 100;

/**
 * 力扣题库列表查询（`problemsetQuestionList`）。
 * 该节点支持 `titleCn` 与 `topicTags.nameTranslated`（中文标签）；
 * 逐题的 `question(titleSlug)` 节点**不支持**这两个字段（实测 GraphQL 400 Cannot query field），
 * 因此题库拉取与元数据回填都走本查询分页扫描（全库约 45 次请求）。
 */
export const LEETCODE_BANK_QUERY = `query problemsetQuestionList($limit: Int, $skip: Int) {
  problemsetQuestionList(limit: $limit, skip: $skip) {
    total
    questions { frontendQuestionId title titleCn titleSlug difficulty paidOnly topicTags { name nameTranslated } }
  }
}`;

/**
 * 力扣公开题库（匿名可访问）：POST /graphql problemsetQuestionList 分页翻取
 * （约 3300+ 题，每页 100）。题目标识用 slug（与提交同步的 problemKey 一致），
 * 中文标题优先，三级难度映射为 CF rating 标尺，算法标签英文转小写
 * （TAG_ALIAS_TO_CANONICAL 负责归并到中文知识点）。付费题（paidOnly）跳过。
 */
export async function fetchLeetcodeBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  let total: number | null = null;

  for (let skip = 0; skip < 10000; skip += LEETCODE_BANK_PAGE) {
    const res = await asHttpClient(fetchFn).fetch(LEETCODE_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://leetcode.cn/problemset/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      body: JSON.stringify({
        query: LEETCODE_BANK_QUERY,
        variables: { limit: LEETCODE_BANK_PAGE, skip },
      }),
    }, { timeoutMs: 30000 });
    if (!res.ok) {
      throw new Error(`力扣题库接口 HTTP ${res.status}，请稍后重试`);
    }
    const body = (await res.json()) as {
      data?: { problemsetQuestionList?: { total?: number; questions?: LcBankQuestion[] } };
      errors?: Array<{ message?: string }>;
    };
    const list = body.data?.problemsetQuestionList;
    if (body.errors?.length || !Array.isArray(list?.questions)) {
      throw new Error(`力扣题库接口响应异常${body.errors?.[0]?.message ? `：${body.errors[0].message}` : ''}，请稍后重试`);
    }
    if (typeof list?.total === 'number') total = list.total;
    if (list.questions.length === 0) break;

    for (const q of list.questions) {
      if (!q.titleSlug || q.paidOnly) continue;
      problems.push({
        platform: 'leetcode',
        problemKey: q.titleSlug.toLowerCase(),
        title: q.titleCn || q.title || q.titleSlug,
        ...bankDifficulty('leetcode', q.difficulty),
        url: `https://leetcode.cn/problems/${q.titleSlug.toLowerCase()}/`,
        // 中文标签优先（直接命中知识体系）；英文名转小写以便同义词归并（binary search → 二分查找）
        tags: (q.topicTags ?? [])
          .map((t) => (t.nameTranslated || t.name || '').trim().toLowerCase())
          .filter(Boolean),
      });
    }
    opts.onProgress?.({ platform: 'leetcode', count: problems.length, total });
    if (problems.length >= max) break;
    if (list.questions.length < LEETCODE_BANK_PAGE) break;
    await sleep(400); // 页间限速
  }
  return { platform: 'leetcode', problems: problems.slice(0, max), total };
}

// ---------- AtCoder（kenkoooo 社区 API） ----------

interface KenkoooProblem {
  id: string;
  contest_id: string;
  problem_index?: string;
  name?: string;
  title?: string;
}

interface KenkoooModel {
  difficulty?: number | null;
  is_experimental?: boolean;
}

/**
 * AtCoder 公开题库：使用社区维护的 kenkoooo/AtCoderProblems 资源接口（匿名可访问）。
 * - GET /resources/problems.json：全量题目列表（约 4000+ 题，含 id / contest_id / title）
 * - GET /resources/problem-models.json：题目难度模型（difficulty 为 AtCoder 预估难度 θ，约 -1000~4000+）
 * 两次单次调用即可拿全量，无翻页；kenkoooo 要求请求间隔 >= 1s，两次调用间 sleep。
 * difficulty 走 shared 的 θ→CF 分段锚点映射（与同步路径同源：此前题库路径自行把 θ<800 钳到 800，
 * 同一道 abc-A 在题库得到 800、在同步得到 922，两处不一致）。
 */
export async function fetchAtcoderBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 5000;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',
  };

  // kenkoooo 要求请求间隔 >= 1s：顺序请求 + sleep，不并发（原 Promise.all 违反间隔要求）
  // 两份资源都是全量快照（problems 数千条 / models 上万条），放宽超时到 30s
  const probRes = await asHttpClient(fetchFn).fetch(`${KENKOOOO_API}/resources/problems.json`, {
    headers,
  }, { timeoutMs: 30000 });
  await sleep(1000);
  const modelRes = await asHttpClient(fetchFn).fetch(`${KENKOOOO_API}/resources/problem-models.json`, {
    headers,
  }, { timeoutMs: 30000 });
  if (!probRes.ok) {
    throw new Error(`AtCoder 题库接口 HTTP ${probRes.status}，请稍后重试`);
  }
  if (!modelRes.ok) {
    throw new Error(`AtCoder 难度模型接口 HTTP ${modelRes.status}，请稍后重试`);
  }
  const probList = (await probRes.json()) as KenkoooProblem[];
  const modelMap = (await modelRes.json()) as Record<string, KenkoooModel>;
  if (!Array.isArray(probList)) {
    throw new Error('AtCoder 题库接口响应结构异常，请稍后重试');
  }

  // 标签桥（可选）：先按 kenkoooo 题号集合建洛谷 AT 镜像标签映射，再逐题取标签
  let tagMap = new Map<string, string[]>();
  let tagStats: { scanned: number; matched: number; withTags: number; skipped: number } | null = null;
  if (opts.atcoderTagsFromLuogu === true) {
    const knownIds = new Set(
      probList
        .filter((p) => typeof p.id === 'string' && p.id !== '')
        .map((p) => p.id),
    );
    const bridge = await luoguAtcoderTagMap(fetchFn, { knownIds, onProgress: opts.onProgress });
    tagMap = bridge.map;
    tagStats = {
      scanned: bridge.scanned,
      matched: bridge.matched,
      withTags: bridge.withTags,
      skipped: bridge.skipped,
    };
  }

  const problems: BankProblem[] = [];
  for (const p of probList) {
    if (typeof p.id !== 'string' || !p.id || typeof p.contest_id !== 'string' || !p.contest_id) continue;
    const model = modelMap[p.id];
    // θ 原文透传给 shared（nativeDifficulty 保留原文，平台改档后可按标度重算）
    const rawTheta =
      model && typeof model.difficulty === 'number' && Number.isFinite(model.difficulty)
        ? model.difficulty
        : null;
    problems.push({
      platform: 'atcoder',
      problemKey: p.id,
      title: p.title || p.name || p.id,
      ...bankDifficulty('atcoder', rawTheta),
      url: `https://atcoder.jp/contests/${p.contest_id}/tasks/${p.id}`,
      tags: tagMap.get(p.id) ?? [],
    });
    if (problems.length >= max) break;
  }
  return {
    platform: 'atcoder',
    problems,
    total: probList.length,
    ...(tagStats
      ? {
          tagScanned: tagStats.scanned,
          tagMatched: tagStats.matched,
          tagWithTags: tagStats.withTags,
          tagSkipped: tagStats.skipped,
        }
      : {}),
  };
}

/**
 * 用洛谷 AT 镜像题补 AtCoder 算法标签（默认关闭，见 BankFetchOptions.atcoderTagsFromLuogu）。
 * 洛谷 pid `AT_abc300_a` → kenkoooo 题号 `abc300_a`；洛谷自定义比赛号（如 `AT1202Contest_a`）
 * 无对应题号 → 计入 skipped。**覆盖率有限**：实测 250 行样本中 139 行命中 kenkoooo，
 * 其中仅 68 行真的带洛谷标签 —— 调用方据此如实展示，不得宣称「全覆盖」。
 */
async function luoguAtcoderTagMap(
  fetchFn: HttpInit,
  opts: {
    /** kenkoooo 题号集合（判定镜像题号是否真的有对应题） */
    knownIds: ReadonlySet<string>;
    maxPages?: number;
    onProgress?: BankFetchOptions['onProgress'];
  },
): Promise<{
  map: Map<string, string[]>;
  scanned: number;
  matched: number;
  withTags: number;
  skipped: number;
}> {
  const map = new Map<string, string[]>();
  const tagDict = await fetchLuoguTagDict(fetchFn);
  const maxPages = opts.maxPages ?? 60;
  let scanned = 0;
  let matched = 0;
  let withTags = 0;
  let skipped = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetchWithChallenge(asHttpClient(fetchFn), `${LUOGU_API}/problem/list?page=${page}&type=AT`, '', undefined, {
      'x-lentille-request': 'content-only',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: `${LUOGU_API}/problem/list`,
    });
    if (!res.ok) break;
    const text = await res.text();
    if (!text.trim().startsWith('{')) break;
    const list =
      (JSON.parse(text) as { data?: { problems?: { result?: LuoguListProblem[] } } }).data?.problems?.result ?? [];
    if (list.length === 0) break;
    for (const p of list) {
      scanned += 1;
      const pid = typeof p.pid === 'string' ? p.pid : '';
      if (!pid.startsWith('AT_')) {
        skipped += 1; // 洛谷自定义比赛号：无法映射为 AtCoder 题号
        continue;
      }
      const atcoderId = pid.slice(3).toLowerCase();
      if (!opts.knownIds.has(atcoderId)) {
        skipped += 1; // 有题号但 kenkoooo 里没有该题
        continue;
      }
      matched += 1;
      const tags = (p.tags ?? []).map((id) => tagDict.get(id)).filter((t): t is string => typeof t === 'string');
      if (tags.length > 0) {
        withTags += 1;
        map.set(atcoderId, tags);
      }
    }
    opts.onProgress?.({ platform: 'atcoder', count: map.size, total: null });
    await sleep(700);
  }
  return { map, scanned, matched, withTags, skipped };
}

// ---------- 代码源（bs.daimayuan.top，Hydro OJ） ----------

/** 代码源（Hydro）1-10 难度 → CF rating：映射表位于 shared/src/difficulty.ts。
 *  兼容别名：内部题库解析与既有测试依赖此名 */
export const daimayuanDifficultyToRating = (d: number): number | null => toCfRating('daimayuan', d);

// Hydro `packages/hydrooj/src/lib/difficulty.ts` 的 difficultyAlgorithm 逐字实现：
//   s = ∫_0^{nSubmit} 2·exp(−2·ln²x)/(x·√π) dx（步长 0.1，采样密度 2）
//   difficulty = max(1, round(10 − 13·s·acRate))
// 缓存在模块级：积分是单调累加的，一次进程内只需向前推进（与上游同构）。
const HYDRO_CACHE = { s: 0, y: 0, values: [0] as number[] };

function hydroLogp(x: number): number {
  return (2 * Math.exp(-2 * (Math.log(x) ** 2))) / x / 2.506628274631;
}

function hydroIntegrate(y: number): number {
  let lastY = HYDRO_CACHE.y;
  if (y <= lastY) return HYDRO_CACHE.values[y] ?? 0;
  let s = HYDRO_CACHE.s;
  let x0 = (lastY / 2) * 0.1;
  while (y > lastY) {
    x0 += 0.1;
    s += hydroLogp(x0) * 0.1;
    for (let i = 1; i <= 2; i += 1) HYDRO_CACHE.values.push(s);
    lastY += 2;
  }
  HYDRO_CACHE.y = lastY;
  HYDRO_CACHE.s = s;
  return HYDRO_CACHE.values[y] ?? s;
}

/**
 * 代码源题库难度（Hydro 1-10 档）：站点手工设定值优先，否则按 Hydro 算法本地复算；
 * 无提交统计（nSubmit ≤ 0）→ null（**未知就是未知**，不猜档位）。
 * 实测 7 条站点样本（nSubmit/nAccept/JSON 原值 → 页面显示值）见 test/problem-bank.test.ts。
 */
export function hydroDifficulty(nSubmit: number, nAccept: number, stored?: number | null): number | null {
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return Math.round(stored);
  if (!Number.isFinite(nSubmit) || nSubmit <= 0) return null;
  const acRate = Math.max(0, Math.min(1, nAccept / nSubmit));
  return Math.max(1, Math.round(10 - 13 * hydroIntegrate(Math.floor(nSubmit)) * acRate));
}

interface DmyPdoc {
  docId?: number;
  title?: string;
  tag?: string[];
  nSubmit?: number;
  nAccept?: number;
  difficulty?: number;
}

/**
 * 代码源公开题库（Hydro，无需登录）：GET /p?page={n} + `Accept: application/json`。
 * 响应 `{ pcount, ppcount, pdocs }`：pcount = 题目总数、ppcount = 总页数、pdocs = 本页题（实测每页 100）。
 * 难度取 `pdoc.difficulty`（站点手工值，0 = 未设定）优先，否则用 nSubmit/nAccept 按 Hydro
 * difficultyAlgorithm 本地复算（见 hydroDifficulty）；标签取 `pdoc.tag`（中文知识点）。
 * 不再解析 HTML：页面表格就是同一份 pdoc 的模板渲染，JSON 少一次抠标签的误伤风险。
 */
export async function fetchDaimayuanBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  const seen = new Set<string>();
  const hitWanted = makeWantedTracker(opts.wantKeys);
  let total: number | null = null;
  let wantedDone = false;

  for (let page = 1; page <= 50; page += 1) {
    const url = `${DAIMAYUAN_BASE}/p?page=${page}`;
    const res = await asHttpClient(fetchFn).fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: `${DAIMAYUAN_BASE}/p`,
      },
    });
    if (!res.ok) {
      throw new Error(`代码源题库接口 HTTP ${res.status}，请稍后重试`);
    }
    const body = (await res.json().catch(() => null)) as
      | { pcount?: number; ppcount?: number; pdocs?: DmyPdoc[] }
      | null;
    if (body === null) throw new Error('代码源题库接口返回非 JSON（接口变化），请稍后重试');
    const list = Array.isArray(body.pdocs) ? body.pdocs : [];
    if (total === null && typeof body.pcount === 'number') total = body.pcount;
    if (list.length === 0) break;

    for (const p of list) {
      const key = typeof p.docId === 'number' ? String(p.docId) : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const level = hydroDifficulty(p.nSubmit ?? 0, p.nAccept ?? 0, p.difficulty ?? null);
      problems.push({
        platform: 'daimayuan',
        problemKey: key,
        title: (p.title ?? '').trim() || key,
        // 1-10 档经 shared 表映射为 CF rating（未知 = null）
        ...bankDifficulty('daimayuan', level),
        url: `${DAIMAYUAN_BASE}/p/${key}`,
        tags: Array.isArray(p.tag) ? p.tag.map((t) => String(t).trim()).filter(Boolean) : [],
      });
      if (hitWanted(key)) {
        wantedDone = true;
        break;
      }
      if (problems.length >= max) break;
    }
    opts.onProgress?.({ platform: 'daimayuan', count: problems.length, total });
    if (wantedDone) break;
    if (problems.length >= max) break;
    if (typeof body.ppcount === 'number' && page >= body.ppcount) break;
    if (list.length < DAIMAYUAN_PER_PAGE) break;
    await sleep(400); // 页间限速
  }
  return { platform: 'daimayuan', problems: problems.slice(0, max), total };
}

// ---------- 计蒜客 ----------

const JISUANKE_BASE = 'https://www.jisuanke.com';

interface JisuankeListProblem {
  problemIdentifier?: string;
  title?: string;
  accept?: number;
  submit?: number;
  difficultyType?: string | number;
  passingRate?: number;
  /** 实测为标签数组（`[{ tagName, type }]`，type 为 difficulty / knowledge） */
  problemTags?: unknown;
}

/** /api/problems 单页响应体：数组或 { data / problems / result } 包裹，防御性解包 */
function unpackJisuankeProblemPage(body: unknown): JisuankeListProblem[] {
  if (Array.isArray(body)) return body as JisuankeListProblem[];
  const o = body as { data?: unknown; problems?: unknown; result?: unknown };
  for (const cand of [o.data, o.problems, o.result]) {
    if (Array.isArray(cand)) return cand as JisuankeListProblem[];
  }
  return [];
}

/**
 * 计蒜客公开题库（匿名可访问，无需 Cookie）：
 * GET /api/problems?page={n}（约 3600 题，每页 20 条；total 随首页返回）。
 * difficultyType（level1…levelN）→ 统一难度标尺；原生档位原文落 native_difficulty。
 * 题号 problemIdentifier（如 T1001）即 problemKey，题目页 /problem/{identifier}。
 * 算法标签取 `problemTags` 里的 knowledge 类（difficulty 类已由 difficultyType 表达）。
 */
export async function fetchJisuankeBank(
  fetchFn: HttpInit,
  opts: BankFetchOptions = {},
): Promise<BankFetchResult> {
  const max = opts.max ?? 2000;
  const problems: BankProblem[] = [];
  let total: number | null = null;

  for (let page = 1; page <= 200; page += 1) {
    const res = await asHttpClient(fetchFn).fetch(`${JISUANKE_BASE}/api/problems?page=${page}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: `${JISUANKE_BASE}/problems`,
      },
    });
    if (!res.ok) {
      throw new Error(`计蒜客题库接口 HTTP ${res.status}，请稍后重试`);
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (body === null) throw new Error('计蒜客题库接口返回非 JSON（接口变化），请稍后重试');
    const rows = unpackJisuankeProblemPage(body);
    // 总数：常见形态 { total } / { data: { total } }（首页即可拿到）
    if (total === null) {
      const o = body as { total?: unknown; data?: { total?: unknown } };
      const t = o.total ?? o.data?.total;
      if (typeof t === 'number') total = t;
    }
    if (rows.length === 0) break;

    for (const p of rows) {
      const key = typeof p.problemIdentifier === 'string' ? p.problemIdentifier.trim() : '';
      if (!key) continue;
      const { knowledge } = parseJisuankeProblemTags(p.problemTags);
      problems.push({
        platform: 'jisuanke',
        problemKey: key,
        title: p.title?.trim() || key,
        ...bankDifficulty('jisuanke', p.difficultyType),
        url: `${JISUANKE_BASE}/problem/${encodeURIComponent(key)}`,
        tags: knowledge,
      });
    }
    if (problems.length >= max) break;
    await sleep(300); // 页间限速
  }
  return { platform: 'jisuanke', problems: problems.slice(0, max), total };
}
