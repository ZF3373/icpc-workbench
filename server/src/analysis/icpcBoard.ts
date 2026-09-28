/**
 * ICPC / CCPC 公开榜单难度（QOJ 题集的难度来源）。
 *
 * 背景：QOJ 是 UOJ 系数据模型，**平台本身没有难度字段**（见 shared/src/difficulty.ts 的 qoj 分支）。
 * 本项目原先因此把 QOJ 题目难度恒记为未知。参考项目 OJ_Insight 的做法给出了可行路径：
 * 用公开榜单的**过题队伍占比**推导档位（金/银/铜/铁），并用社区维护的 QOJ 题号 ↔ 赛题映射
 * 找到题目在榜单中的位置。本模块按同一口径实现，链路三段：
 *
 * 1. **题号 → 赛场 + 题号字母**（两条来源，缺一不可）：
 *    ① `xcpcrating` 数据集（Hei-MaoM/xcpcrating）的 `data/problem-catalog.json` 以
 *       `canonicalId: "qoj:<problemId>"` 标注每题，键形如 `icpc/icpc2026/icpc2026preliminary-1:A`
 *       （赛场键 + 题号字母）。它是**评分数据集**，只覆盖其处理过的题（实测 1800 条 / qoj 题号 987 条）。
 *    ② **QOJ 比赛页**（2026-09-28 新增，见 analysis/qojContest.ts）：库内题号形如 `2513-14301`，
 *       其中的 `2513` 就是 QOJ 比赛号 —— 直接读 `https://qoj.ac/contest/2513` 即可拿到比赛名称与
 *       「题号字母 ↔ 题目 id」全表。这条来源不依赖任何第三方目录，把「目录没收录 → 永远没有难度」
 *       这一类（实测 `2513-14301` 等 3 道）补上。QOJ 前置 Cloudflare：请求需 HTTP/1.1 +
 *       已配置的 `cookie.qoj`/`ua.qoj`（与提交同步同一份凭据），拿不到就如实降级为未知。
 *    同一个数据集的 `data/problem-types/2023-present-all-qoj-v2.json` 还给出逐题知识点标签。
 *    两处数据集都托管在 GitHub：本模块**优先走 jsDelivr CDN 镜像**（GitHub 直连在部分网络下被屏蔽），
 *    ghproxy 兜底；任一源成功即写本地缓存（默认 7 天）。QOJ 比赛页另按比赛号写本地缓存。
 * 2. **赛场 → 公开榜单**：RankLand 公开 API `GET /api/v2/public/contests` 给出赛场索引
 *    （`uk` / 名称 / `srkFileID`），`GET /api/v2/public/files/{id}` 给出榜单文件地址，
 *    榜单 JSON 的 `problems[].alias` + `statistics.accepted` + `rows` 行数即可算出占比。
 *    匹配分两条路：社区目录条目用它自带的赛场键（`matchRanklandBoard`，全等优先 + 词元打分）；
 *    QOJ 比赛页条目用**比赛名称属性**（年份/系列/赛段/赛站/场次，`matchBoardByFacets`，
 *    见 analysis/xcpcFacets.ts）—— 名称是 QOJ 给的权威信息，与榜单库的命名风格无关。
 * 3. **占比 → 档位**：与 OJ_Insight 同口径的 `rating_tier`
 *    （≤10% gold、≤30% silver、≤60% bronze、其余 iron）。
 *
 * 失败即降级：任一环不可用 → 该题难度保持未知（标度 none），并在回填结果里如实计入失败/未匹配，
 * 绝不臆造难度。原生档位与原始占比一并回传（`gold:704/2535`），榜单口径变化时可重算而无需重新抓取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ICPC_TIERS, type IcpcTier } from '../../../shared/src/difficulty.ts';
import { asHttpClient } from '../adapters/http.ts';
import { isCloudflareChallenge } from '../adapters/qoj.ts';
import { effectiveDataDir } from '../knowledge/store.ts';
import { normalizeMatchText } from './xcpcText.ts';
import { contestFacets, facetMatchScore } from './xcpcFacets.ts';
import { parseQojContestPage, qojProblemRefFromKey, type QojContestPage } from './qojContest.ts';

const RANKLAND_INDEX = 'https://rl.algoux.cn/api/v2/public/contests';
const RANKLAND_FILE_META = 'https://rl.algoux.cn/api/v2/public/files';

/** 赛事映射与标签数据源（按顺序尝试；jsDelivr 在国内通常可达，ghproxy 兜底） */
const CATALOG_URLS = [
  'https://cdn.jsdelivr.net/gh/Hei-MaoM/xcpcrating@main/data/problem-catalog.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/Hei-MaoM/xcpcrating/main/data/problem-catalog.json',
];
const TYPES_URLS = [
  'https://cdn.jsdelivr.net/gh/Hei-MaoM/xcpcrating@main/data/problem-types/2023-present-all-qoj-v2.json',
  'https://ghproxy.net/https://raw.githubusercontent.com/Hei-MaoM/xcpcrating/main/data/problem-types/2023-present-all-qoj-v2.json',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
/** 赛事映射缓存 7 天（社区数据集更新频率低）；RankLand 赛场索引 24 小时 */
const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000;
const INDEX_TTL_MS = 24 * 3600 * 1000;
/** 单次运行最多拉取的榜单文件数（每个约 2–3 MB，防止一次点击拉上百个） */
export const MAX_BOARDS_PER_RUN = 8;
/** QOJ 比赛页缓存 7 天（比赛页的题目集合基本不变；题号字母更是确定值） */
const QOJ_CONTEST_TTL_MS = 7 * 24 * 3600 * 1000;
/**
 * 单次运行最多拉取的 QOJ 比赛页数。每个约 17 KB，但 qoj.ac 前置 Cloudflare 且按域名限速 2.5s，
 * 因此上限同样收紧；超出部分本轮保持未知，下次运行继续。
 */
export const MAX_QOJ_PAGES_PER_RUN = 6;
/** QOJ 请求头（`cf_clearance` 与签发它的浏览器 UA 绑定，必须与提交同步用同一份凭据） */
const QOJ_UA_FALLBACK =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** QOJ 比赛页地址 */
function qojContestUrl(contestId: string): string {
  return `https://qoj.ac/contest/${contestId}`;
}

function qojHeaders(cookie: string, ua: string): Record<string, string> {
  const agent = ua.trim() === '' ? QOJ_UA_FALLBACK : ua.trim();
  return {
    'User-Agent': agent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://qoj.ac/',
    ...(cookie.trim() === '' ? {} : { Cookie: cookie.trim() }),
  };
}

export interface IcpcCatalogEntry {
  /** 赛场键，如 `icpc/icpc2026/icpc2026preliminary-1` */
  contestKey: string;
  /** 场次内题号字母，如 `A` */
  alias: string;
  title: string | null;
}

export interface RanklandBoardMeta {
  uk: string;
  name: string;
  fileId: string;
  /**
   * 匹配用文本 = `uk` + 名称 + `title` 各语种（RankLand 的 `title` 里常有更完整的正式名，
   * OJ_Insight 同款做法：`labels = [uk, name, ...title.values()]`）。
   * 属性匹配（年份/系列/赛站/赛段）看的是它，而不是单纯的 `uk`。
   * 可缺省（手写的榜单条目没有该字段）：缺省时按 `uk + name` 兜底。
   */
  text?: string;
  /** 开赛日期 YYYY-MM-DD（拿不到为空串；可缺省） */
  date?: string;
}

/** 榜单匹配文本：优先用索引给出的 `text`，缺省回退 `uk + name` */
export function boardText(b: RanklandBoardMeta): string {
  return b.text ?? `${b.uk} ${b.name}`;
}

export interface IcpcBoardProblem {
  accepted: number;
  /** 榜单总行数（含一题未过的队伍） */
  total: number;
  tier: IcpcTier;
}

/** 单题推导结果：原生难度原文（档位 + 占比）、映射后的档位、上游标签 */
export interface IcpcProblemInfo {
  /** 原生原文 `gold:704/2535`；空串 = 只拿到了标签、没有榜单难度 */
  native: string;
  tier: IcpcTier | null;
  tags: string[] | null;
}

// ---------- 纯解析（可单测，无网络） ----------

/**
 * 档位判定（与 OJ_Insight `xcpc/rating.rs:rating_tier` 同口径）：
 * accepted/total ≤ 10% → gold，≤ 30% → silver，≤ 60% → bronze，其余 iron。
 * 用整数交叉相乘避免浮点误差（`accepted * 100 <= total * 10`）。
 */
export function ranklandTier(accepted: number, total: number): IcpcTier {
  const a = Math.max(0, accepted);
  const t = Math.max(0, total);
  if (a * 100 <= t * 10) return 'gold';
  if (a * 100 <= t * 30) return 'silver';
  if (a * 100 <= t * 60) return 'bronze';
  return 'iron';
}

/**
 * 匹配用文本归一化（实现在 `analysis/xcpcText.ts`，与 `xcpcFacets` 共用一份）。
 * 此处保留导出：既有调用方与单测按 `icpcBoard.normalizeMatchText` 引用。
 */
export { normalizeMatchText } from './xcpcText.ts';

/** RankLand 赛场索引 → 赛场元数据（结构异常时返回空数组，由调用方降级） */
export function parseRanklandIndex(json: unknown): RanklandBoardMeta[] {
  const list = (json as { data?: { contests?: unknown } } | null)?.data?.contests;
  if (!Array.isArray(list)) return [];
  const out: RanklandBoardMeta[] = [];
  for (const item of list) {
    const c = item as { uk?: unknown; name?: unknown; srkFileID?: unknown; title?: unknown; startAt?: unknown };
    const uk = typeof c?.uk === 'string' ? c.uk.trim() : '';
    const fileId = typeof c?.srkFileID === 'string' ? c.srkFileID.trim() : '';
    if (uk === '' || fileId === '') continue;
    const name = typeof c?.name === 'string' ? c.name : uk;
    // title 是多语言对象（zh-CN / fallback…）：各语种都并入匹配文本
    const titles =
      c?.title !== null && typeof c?.title === 'object'
        ? Object.values(c.title as Record<string, unknown>).filter((v): v is string => typeof v === 'string')
        : [];
    const startAt = typeof c?.startAt === 'string' ? c.startAt : '';
    out.push({
      uk,
      name,
      fileId,
      text: [uk, name, ...titles].filter((v) => v.trim() !== '').join(' '),
      date: /^\d{4}-\d{2}-\d{2}/.test(startAt) ? startAt.slice(0, 10) : '',
    });
  }
  return out;
}

/**
 * 榜单 JSON → 每道赛题的过题数/总队伍数与档位。
 * 只认 `problems[].alias` + `statistics.accepted`；`rows` 为空或结构不符 → 无数据（不猜）。
 */
export function parseRanklandSrk(json: unknown): Map<string, IcpcBoardProblem> {
  const out = new Map<string, IcpcBoardProblem>();
  const src = json as { rows?: unknown; problems?: unknown } | null;
  const total = Array.isArray(src?.rows) ? src.rows.length : 0;
  if (total <= 0 || !Array.isArray(src?.problems)) return out;
  for (const raw of src.problems) {
    const p = raw as { alias?: unknown; statistics?: { accepted?: unknown } };
    const alias = typeof p?.alias === 'string' ? p.alias.trim().toUpperCase() : '';
    const accepted = p?.statistics?.accepted;
    if (alias === '' || typeof accepted !== 'number' || !Number.isFinite(accepted)) continue;
    if (accepted < 0 || accepted > total) continue; // 越界值视为榜单异常
    out.set(alias, { accepted, total, tier: ranklandTier(accepted, total) });
  }
  return out;
}

/** `xcpcrating` 赛事目录 → `qoj 题号 → { 赛场键, 题号字母, 标题 }` */
export function parseXcpcCatalog(json: unknown): Map<string, IcpcCatalogEntry> {
  const out = new Map<string, IcpcCatalogEntry>();
  const problems = (json as { problems?: unknown } | null)?.problems;
  if (problems === null || typeof problems !== 'object') return out;
  for (const [key, raw] of Object.entries(problems as Record<string, unknown>)) {
    const canonical = (raw as { canonicalId?: unknown })?.canonicalId;
    if (typeof canonical !== 'string' || !canonical.startsWith('qoj:')) continue;
    const problemId = canonical.slice(4).trim();
    const colon = key.lastIndexOf(':');
    if (problemId === '' || colon <= 0) continue;
    const title = (raw as { title?: unknown })?.title;
    out.set(problemId, {
      contestKey: key.slice(0, colon),
      alias: key.slice(colon + 1).trim().toUpperCase(),
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null,
    });
  }
  return out;
}

/**
 * `xcpcrating` 题型数据 → `qoj 题号 → 知识点标签`（detailTags）。
 *
 * 注意它只取标签：**同一个文件的键还带着赛场键 + 题号字母**（如
 * `icpc/icpc2025/icpc2025preliminary-1:A`），那正是 `parseXcpcTypes` 顺带产出的映射 ——
 * 原先只读标签、把键丢掉，等于白扔了一份 1100 条 qoj 题号的映射（见 parseXcpcTypes 注释）。
 */
export function parseXcpcTags(json: unknown): Map<string, string[]> {
  return parseXcpcTypes(json).tags;
}

/**
 * `xcpcrating` 题型数据 → { 逐题标签, 题号映射 }。
 *
 * 为什么映射要从这里也取一份：该数据集的键形如 `icpc/icpc2025/icpc2025preliminary-1:A`
 * （赛场键 + 题号字母），实测覆盖 **1100** 道 qoj 题，而 `problem-catalog.json`
 * （评分数据集）只覆盖 987 道 —— 库内实测缺失的 `2513-14301/2/3`（2025 ICPC EC 网络赛第一场
 * A/B/C）恰好只在前者里。原先解析只读 `canonicalId` 与 `detailTags`、把键丢掉，
 * 于是这一批题明明有映射却仍被判「不在目录里」（附带的标签倒是补上了，症状是「有标签没难度」）。
 */
export function parseXcpcTypes(json: unknown): {
  tags: Map<string, string[]>;
  catalog: Map<string, IcpcCatalogEntry>;
} {
  const tags = new Map<string, string[]>();
  const catalog = new Map<string, IcpcCatalogEntry>();
  const problems = (json as { problems?: unknown } | null)?.problems;
  if (problems === null || typeof problems !== 'object') return { tags, catalog };
  for (const [key, raw] of Object.entries(problems as Record<string, unknown>)) {
    const canonical = (raw as { canonicalId?: unknown })?.canonicalId;
    if (typeof canonical !== 'string' || !canonical.startsWith('qoj:')) continue;
    const problemId = canonical.slice(4).trim();
    if (problemId === '') continue;
    const detail = (raw as { detailTags?: unknown })?.detailTags;
    if (Array.isArray(detail)) {
      const clean = detail.map((t) => String(t).trim()).filter(Boolean);
      if (clean.length > 0) tags.set(problemId, [...new Set(clean)]);
    }
    const colon = key.lastIndexOf(':');
    if (colon <= 0) continue;
    const alias = (raw as { alias?: unknown })?.alias;
    const title = (raw as { title?: unknown })?.title;
    catalog.set(problemId, {
      contestKey: key.slice(0, colon),
      alias: (typeof alias === 'string' && alias.trim() !== '' ? alias : key.slice(colon + 1)).trim().toUpperCase(),
      title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null,
    });
  }
  return { tags, catalog };
}

/**
 * 赛场键 → RankLand 榜单：先按末段（`icpc2026preliminary-1`）与 `uk` 归一化全等匹配；
 * 失败再退回词元打分 —— 要求年份一致、词元命中率 ≥ 0.8、且最优分唯一（避免把
 * 「第一场」匹配到「第二场」：这两者词元完全相同，只能靠全等 uk 区分，故打分匹配必须唯一）。
 */
export function matchRanklandBoard(
  contestKey: string,
  boards: readonly RanklandBoardMeta[],
): RanklandBoardMeta | null {
  const tail = contestKey.split('/').pop() ?? contestKey;
  const nTail = normalizeMatchText(tail);
  const exact = boards.find((b) => normalizeMatchText(b.uk) === nTail || normalizeMatchText(b.fileId) === nTail);
  if (exact) return exact;

  const year = /(19|20)\d{2}/.exec(tail)?.[0] ?? '';
  const tokens = nTail.split(' ').filter((t) => t.length > 2);
  if (tokens.length === 0) return null;
  const scored: Array<{ score: number; board: RanklandBoardMeta }> = [];
  for (const board of boards) {
    const text = normalizeMatchText(`${board.uk} ${board.name}`);
    if (year !== '' && !text.includes(year)) continue;
    let hit = 0;
    for (const t of tokens) if (text.includes(t)) hit += 1;
    const ratio = hit / tokens.length;
    if (ratio < 0.8) continue;
    scored.push({ score: ratio * 100 + hit, board });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  if (scored.length > 1 && scored[0].score === scored[1].score) return null; // 并列 → 不猜
  return scored[0].board;
}

/**
 * **按比赛名称属性**匹配榜单（QOJ 比赛页路径专用，见 analysis/xcpcFacets.ts）。
 *
 * 与 `matchRanklandBoard` 的分工：后者按**社区数据集的赛场键**匹配（键本身就带年份与场次，
 * 例如 `icpc/icpc2026/icpc2026preliminary-1`）；本函数用于**目录里没有的题** ——
 * 此时我们手里只有 QOJ 给的比赛名（如 `The 2025 ICPC Asia East Continent Online Contest (I)`），
 * 于是从名称识别年份/系列/赛段/赛站/场次再打分。
 *
 * 判据与 OJ_Insight 同构：最优分 ≥ 10 且唯一（并列一律不猜）。典型得分：
 * 全国网络赛第一场 = 5(年) + 8(场次) + 4(ICPC) + 4(网络) = 21；区域赛（有赛站）= 5+4+6 = 15；
 * 无赛站的全国性区域赛 = 5+4+3(名称词元重合) = 12。
 */
export function matchBoardByFacets(
  qojContestName: string,
  boards: readonly RanklandBoardMeta[],
): RanklandBoardMeta | null {
  const facets = contestFacets(qojContestName);
  const scored: Array<{ score: number; board: RanklandBoardMeta }> = [];
  for (const board of boards) {
    const score = facetMatchScore(facets, boardText(board), qojContestName);
    if (score !== null) scored.push({ score, board });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  if (best.score < 10) return null;
  if (scored.length > 1 && scored[1]!.score === best.score) return null; // 并列 → 不猜
  return best.board;
}

// ---------- 网络与缓存 ----------

export interface IcpcRuntime {
  fetchFn: typeof fetch;
  /** 题号 → 赛场键 + 题号字母（两个社区数据集的并集，见 loadMapping） */
  mapping: Map<string, IcpcCatalogEntry> | null;
  catalog: Map<string, IcpcCatalogEntry> | null;
  /** 题型数据集里的题号映射（与 catalog 合并进 mapping；覆盖面对照见 loadMapping） */
  typesCatalog: Map<string, IcpcCatalogEntry> | null;
  tags: Map<string, string[]> | null;
  boards: RanklandBoardMeta[] | null;
  /** 赛场键 → 该榜单词典（同一运行内不重复下载） */
  boardCache: Map<string, Map<string, IcpcBoardProblem>>;
  /** 本轮已下载的榜单数（受 MAX_BOARDS_PER_RUN 约束） */
  boardsFetched: number;
  /**
   * QOJ 比赛页读取通道（HTTP/1.1 + 按域名节流；见 net/qojTransport.ts 与 adapters/http1.ts）。
   * 缺省时退回 `fetchFn`（单测注入的 mock 就走这里）。
   */
  qojTransport: typeof fetch;
  /** QOJ 凭据（settings 表的 cookie.qoj / ua.qoj）——比赛页与提交页受同一套 Cloudflare 校验 */
  qojCredentials: { cookie: string; ua: string } | null;
  /** 比赛号 → 比赛页解析结果（null = 本轮已试过且失败，不再重试） */
  qojContestCache: Map<string, QojContestPage | null>;
  /** 本轮已尝试读取的比赛页数（受 MAX_QOJ_PAGES_PER_RUN 约束） */
  qojPagesFetched: number;
}

async function fetchJsonVia(fetchFn: typeof fetch, urls: readonly string[]): Promise<unknown> {
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const res = await asHttpClient(fetchFn).fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      }, { timeoutMs: 40000 });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return (await res.json()) as unknown;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('全部镜像源均不可用');
}

/** 带磁盘缓存的 JSON 读取（缓存目录与 kenkoooo 资源缓存同一 data 目录） */
function cachePathFor(key: string): string {
  const dataDir = effectiveDataDir();
  return dataDir ? path.join(dataDir, `${key}.json`) : '';
}

function readCache(key: string, ttlMs: number): unknown | null {
  const p = cachePathFor(key);
  if (!p || !fs.existsSync(p)) return null;
  try {
    if (Date.now() - fs.statSync(p).mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
  } catch {
    return null; // 缓存损坏 → 视为无缓存（不阻断）
  }
}

function writeCache(key: string, data: unknown): void {
  const p = cachePathFor(key);
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  } catch {
    // 缓存写失败不影响本次结果
  }
}

async function loadCatalog(runtime: IcpcRuntime): Promise<Map<string, IcpcCatalogEntry> | null> {
  if (runtime.catalog) return runtime.catalog;
  const cached = readCache('icpc-xcpc-problem-catalog', CATALOG_TTL_MS);
  if (cached) {
    runtime.catalog = parseXcpcCatalog(cached);
    if (runtime.catalog.size > 0) return runtime.catalog;
  }
  try {
    const data = await fetchJsonVia(runtime.fetchFn, CATALOG_URLS);
    const parsed = parseXcpcCatalog(data);
    if (parsed.size > 0) {
      writeCache('icpc-xcpc-problem-catalog', data);
      runtime.catalog = parsed;
      return parsed;
    }
  } catch {
    // 落入 unknown：题号无法映射到赛题
  }
  runtime.catalog = runtime.catalog ?? new Map();
  return runtime.catalog.size > 0 ? runtime.catalog : null;
}

/**
 * 题型数据集（顺带产出题号映射 + 逐题标签）。两者来自同一份文件，故一次加载、一起缓存。
 */
async function loadTypes(runtime: IcpcRuntime): Promise<{ tags: Map<string, string[]>; catalog: Map<string, IcpcCatalogEntry> } | null> {
  if (runtime.tags !== null) return { tags: runtime.tags, catalog: runtime.typesCatalog ?? new Map() };
  const cached = readCache('icpc-xcpc-problem-types', CATALOG_TTL_MS);
  if (cached) {
    const parsed = parseXcpcTypes(cached);
    if (parsed.tags.size > 0 || parsed.catalog.size > 0) {
      runtime.tags = parsed.tags;
      runtime.typesCatalog = parsed.catalog;
      return parsed;
    }
  }
  try {
    const data = await fetchJsonVia(runtime.fetchFn, TYPES_URLS);
    const parsed = parseXcpcTypes(data);
    if (parsed.tags.size > 0 || parsed.catalog.size > 0) {
      writeCache('icpc-xcpc-problem-types', data);
      runtime.tags = parsed.tags;
      runtime.typesCatalog = parsed.catalog;
      return parsed;
    }
  } catch {
    // 标签与这份映射都是附带收益：拿不到不影响「评分目录 + 比赛页」两条主路
  }
  runtime.tags = runtime.tags ?? new Map();
  runtime.typesCatalog = runtime.typesCatalog ?? new Map();
  return null;
}

/**
 * 「题号 → 赛场键 + 题号字母」的**并集**：评分目录（987 道）∪ 题型数据集的键（1100 道）。
 *
 * 为什么要并集：两份社区数据的覆盖面并不相同 —— 评分目录按「够不够数据量做评分」收录，
 * 题型数据按「有没有人标注知识点」收录。库内实测缺失的 `2513-14301/2/3` 只在前者之外、
 * 后者之内，只读其中一份就会漏。冲突时以**评分目录**为准（它的赛场键经过评分审计）。
 */
async function loadMapping(runtime: IcpcRuntime): Promise<Map<string, IcpcCatalogEntry>> {
  if (runtime.mapping !== null) return runtime.mapping;
  const merged = new Map<string, IcpcCatalogEntry>();
  const types = await loadTypes(runtime);
  for (const [id, entry] of types?.catalog ?? []) merged.set(id, entry);
  const catalog = await loadCatalog(runtime);
  for (const [id, entry] of catalog ?? []) merged.set(id, entry); // 评分目录覆盖同题号的题型条目
  runtime.mapping = merged;
  return merged;
}

/** 逐题知识点标签（题型数据集；拿不到返回 null，由调用方按「无标签来源」处理） */
async function loadTags(runtime: IcpcRuntime): Promise<Map<string, string[]> | null> {
  await loadTypes(runtime);
  return (runtime.tags?.size ?? 0) > 0 ? runtime.tags : null;
}

async function loadBoardIndex(runtime: IcpcRuntime): Promise<RanklandBoardMeta[] | null> {
  if (runtime.boards) return runtime.boards;
  const cached = readCache('icpc-rankland-index', INDEX_TTL_MS);
  if (cached) {
    const parsed = parseRanklandIndex(cached);
    if (parsed.length > 0) {
      runtime.boards = parsed;
      return parsed;
    }
  }
  try {
    const data = await fetchJsonVia(runtime.fetchFn, [RANKLAND_INDEX]);
    const parsed = parseRanklandIndex(data);
    if (parsed.length > 0) {
      writeCache('icpc-rankland-index', data);
      runtime.boards = parsed;
      return parsed;
    }
  } catch {
    // 公开榜单不可用 → 该题难度未知
  }
  return null;
}

async function loadBoard(
  runtime: IcpcRuntime,
  meta: RanklandBoardMeta,
): Promise<Map<string, IcpcBoardProblem> | null> {
  const cached = runtime.boardCache.get(meta.uk);
  if (cached) return cached;
  if (runtime.boardsFetched >= MAX_BOARDS_PER_RUN) return null;
  runtime.boardsFetched += 1;
  try {
    const metaJson = await fetchJsonVia(runtime.fetchFn, [`${RANKLAND_FILE_META}/${meta.fileId}`]);
    const url = (metaJson as { data?: { url?: unknown } } | null)?.data?.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
    const srk = await fetchJsonVia(runtime.fetchFn, [url]);
    const stats = parseRanklandSrk(srk);
    if (stats.size === 0) return null;
    runtime.boardCache.set(meta.uk, stats);
    return stats;
  } catch {
    runtime.boardCache.set(meta.uk, new Map());
    return null;
  }
}

/** 运行上下文（一次回填内复用：目录/索引只拉一次，榜单按赛场去重，比赛页按比赛号去重） */
export function createIcpcRuntime(
  fetchFn: typeof fetch,
  opts: {
    /** QOJ 凭据（缺省＝匿名；匿名在多数网络下会被 Cloudflare 挑战，如实降级为未知） */
    qojCredentials?: { cookie: string; ua: string } | null;
    /** QOJ 传输层（生产传 HTTP/1.1+节流；单测不传则复用 fetchFn，便于注入 mock） */
    qojTransport?: typeof fetch;
  } = {},
): IcpcRuntime {
  return {
    fetchFn,
    mapping: null,
    catalog: null,
    typesCatalog: null,
    tags: null,
    boards: null,
    boardCache: new Map(),
    boardsFetched: 0,
    qojTransport: opts.qojTransport ?? fetchFn,
    qojCredentials: opts.qojCredentials ?? null,
    qojContestCache: new Map(),
    qojPagesFetched: 0,
  };
}

/**
 * 读 QOJ 比赛页（带本地缓存）：返回比赛名称与「题号字母 ↔ 题目 id」全表；失败返回 null。
 *
 * 拿不到就返回 null 并**在本次运行内记住这个失败**（同一比赛号不再重试）：
 * Cloudflare 挑战、Cookie 过期、比赛页改版都属这一档 —— 该题保持未知，绝不臆造难度。
 * 成功的页面写本地缓存（7 天）：比赛页的题目集合与题号字母是确定值，没必要每轮重打上游。
 */
async function loadQojContestPage(runtime: IcpcRuntime, contestId: string): Promise<QojContestPage | null> {
  const cached = runtime.qojContestCache.get(contestId);
  if (cached !== undefined) return cached;

  const cacheKey = `icpc-qoj-contest-${contestId}`;
  const fromDisk = readCache(cacheKey, QOJ_CONTEST_TTL_MS) as { html?: unknown } | null;
  if (fromDisk && typeof fromDisk.html === 'string') {
    const parsed = parseQojContestPage(fromDisk.html);
    if (parsed.problems.length > 0) {
      runtime.qojContestCache.set(contestId, parsed);
      return parsed;
    }
  }

  if (runtime.qojPagesFetched >= MAX_QOJ_PAGES_PER_RUN) {
    runtime.qojContestCache.set(contestId, null);
    return null;
  }
  runtime.qojPagesFetched += 1;
  const creds = runtime.qojCredentials;
  try {
    const res = await runtime.qojTransport(qojContestUrl(contestId), {
      headers: qojHeaders(creds?.cookie ?? '', creds?.ua ?? ''),
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    const html = await res.text();
    if (!res.ok || isCloudflareChallenge(html, res.status, res.headers.get('cf-mitigated'))) {
      runtime.qojContestCache.set(contestId, null);
      return null;
    }
    const parsed = parseQojContestPage(html);
    if (parsed.problems.length === 0) {
      runtime.qojContestCache.set(contestId, null);
      return null;
    }
    writeCache(cacheKey, { html });
    runtime.qojContestCache.set(contestId, parsed);
    return parsed;
  } catch {
    runtime.qojContestCache.set(contestId, null);
    return null;
  }
}

/** QOJ 题号提取：题目键为 `contestId-problemId`（比赛题）或纯 `problemId` */
export function qojProblemIdFromKey(problemKey: string): string | null {
  return qojProblemRefFromKey(problemKey)?.problemId ?? null;
}

/**
 * 批量推导 QOJ 题目的难度（挂到给定运行上下文上，重复调用复用缓存）。
 *
 * @param problemKeys 库内 QOJ 题号（`contestId-problemId` 或纯 `problemId`）。
 *   传**键**而不是题号：比赛题键里带着 QOJ 比赛号，正是「目录没收录时」读比赛页的唯一线索。
 * @returns `题号 → 推导结果`；未匹配到公开榜单的题不出现在结果里（保持未知）。
 *
 * 三条路径（按顺序，前者成功即不再走后者）：
 * ① 社区数据命中（评分目录 ∪ 题型数据集的键）→ 赛场键文本匹配榜单 → 题号字母查占比；
 * ② 两条数据集都没收录、但题号带比赛号 → 读 QOJ 比赛页拿比赛名与题号字母 → 按名称属性匹配榜单 → 查占比；
 * ③ 只拿得到知识点标签的题也照常返回（`native` 为空串、`tier` 为 null）——
 *    难度推不出来时标签仍是净收益。
 */
export async function resolveIcpcDifficulty(
  runtime: IcpcRuntime,
  problemKeys: readonly string[],
): Promise<Map<string, IcpcProblemInfo>> {
  const out = new Map<string, IcpcProblemInfo>();
  /** 题号 → 键上的比赛号（纯题号为 null） */
  const refs = new Map<string, { contestId: string | null; problemId: string }>();
  for (const key of problemKeys) {
    const ref = qojProblemRefFromKey(key);
    if (ref !== null && !refs.has(ref.problemId)) refs.set(ref.problemId, ref);
  }
  if (refs.size === 0) return out;

  const mapping = await loadMapping(runtime);
  const tags = await loadTags(runtime);
  const index = await loadBoardIndex(runtime);

  const record = (problemId: string, stat: IcpcBoardProblem): void => {
    out.set(problemId, {
      native: `${stat.tier}:${stat.accepted}/${stat.total}`,
      tier: stat.tier,
      tags: tags?.get(problemId) ?? null,
    });
  };

  // ① 社区数据路径（原行为 + 题型数据集的键）：题号能查到赛场键与题号字母 → 赛场键匹配榜单
  if (index !== null) {
    for (const problemId of refs.keys()) {
      const entry = mapping.get(problemId);
      if (!entry) continue;
      const meta = matchRanklandBoard(entry.contestKey, index);
      if (!meta) continue;
      const board = await loadBoard(runtime, meta);
      const stat = board?.get(entry.alias);
      if (stat) record(problemId, stat);
    }
  }

  // ② QOJ 比赛页路径（2026-09-28 新增）：目录没收录的题靠比赛页补齐
  //    （实测 `2513-14301` 等就是这一类：目录只有 987 道 qoj 题，覆盖不到 2025 年网络赛）
  const unresolved = [...refs.values()].filter((ref) => !out.has(ref.problemId) && ref.contestId !== null);
  if (unresolved.length > 0 && index !== null) {
    const byContest = new Map<string, string[]>();
    for (const ref of unresolved) {
      const list = byContest.get(ref.contestId!) ?? [];
      list.push(ref.problemId);
      byContest.set(ref.contestId!, list);
    }
    for (const [contestId, problemIds] of byContest) {
      const page = await loadQojContestPage(runtime, contestId);
      if (page === null || page.name === null) continue; // 比赛页拿不到 → 该场题保持未知
      const meta = matchBoardByFacets(page.name, index);
      if (!meta) continue;
      const board = await loadBoard(runtime, meta);
      if (!board) continue;
      const indexByProblemId = new Map(page.problems.map((p) => [p.problemId, p.index]));
      for (const problemId of problemIds) {
        const alias = indexByProblemId.get(problemId);
        if (alias === undefined) continue; // 库内题号不在该场比赛页里（页面不完整/题号已变）→ 不猜
        const stat = board.get(alias.toUpperCase());
        if (stat) record(problemId, stat);
      }
    }
  }

  // ③ 标签兜底：难度推不出来的题也把知识点标签带上（数据集按题号索引，不需要目录/榜单）
  for (const problemId of refs.keys()) {
    if (out.has(problemId)) continue;
    const t = tags?.get(problemId);
    if (t) out.set(problemId, { native: '', tier: null, tags: t });
  }
  return out;
}

/** 档位顺序（供调用方做展示/排序，避免各处再写一份） */
export const ICPC_TIER_ORDER: readonly IcpcTier[] = ICPC_TIERS;
