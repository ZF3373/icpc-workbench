/**
 * ICPC / CCPC 公开榜单难度（QOJ 题集的难度来源）。
 *
 * 背景：QOJ 是 UOJ 系数据模型，**平台本身没有难度字段**（见 shared/src/difficulty.ts 的 qoj 分支）。
 * 本项目原先因此把 QOJ 题目难度恒记为未知。参考项目 OJ_Insight 的做法给出了可行路径：
 * 用公开榜单的**过题队伍占比**推导档位（金/银/铜/铁），并用社区维护的 QOJ 题号 ↔ 赛题映射
 * 找到题目在榜单中的位置。本模块按同一口径实现，链路三段：
 *
 * 1. **题号 → 赛场 + 题号字母**：`xcpcrating` 数据集（Hei-MaoM/xcpcrating）的
 *    `data/problem-catalog.json` 以 `canonicalId: "qoj:<problemId>"` 标注每题，
 *    键形如 `icpc/icpc2026/icpc2026preliminary-1:A`（赛场键 + 题号字母）。
 *    同一个数据集的 `data/problem-types/2023-present-all-qoj-v2.json` 还给出逐题知识点标签。
 *    两者都托管在 GitHub：本模块**优先走 jsDelivr CDN 镜像**（GitHub 直连在部分网络下被屏蔽），
 *    ghproxy 兜底；任一源成功即写本地缓存（默认 7 天）。
 * 2. **赛场 → 公开榜单**：RankLand 公开 API `GET /api/v2/public/contests` 给出赛场索引
 *    （`uk` / 名称 / `srkFileID`），`GET /api/v2/public/files/{id}` 给出榜单文件地址，
 *    榜单 JSON 的 `problems[].alias` + `statistics.accepted` + `rows` 行数即可算出占比。
 *    赛场键与 RankLand `uk` 先按归一化全等匹配，失败再退回词元打分（要求年份一致、命中率高且最优唯一）。
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
import { effectiveDataDir } from '../knowledge/store.ts';

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
 * 匹配用文本归一化：小写、字母与数字边界切分、非字母数字（保留中文）折叠为空格。
 * 切分边界让 `icpc2026preliminary-1` 与 `icpc-2026-preliminary-1` 归一化后完全相同 ——
 * 社区数据集的赛场键与 RankLand 的 `uk` 只差分隔符风格，不该因此匹配失败。
 */
export function normalizeMatchText(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** RankLand 赛场索引 → 赛场元数据（结构异常时返回空数组，由调用方降级） */
export function parseRanklandIndex(json: unknown): RanklandBoardMeta[] {
  const list = (json as { data?: { contests?: unknown } } | null)?.data?.contests;
  if (!Array.isArray(list)) return [];
  const out: RanklandBoardMeta[] = [];
  for (const item of list) {
    const c = item as { uk?: unknown; name?: unknown; srkFileID?: unknown };
    const uk = typeof c?.uk === 'string' ? c.uk.trim() : '';
    const fileId = typeof c?.srkFileID === 'string' ? c.srkFileID.trim() : '';
    if (uk === '' || fileId === '') continue;
    out.push({ uk, name: typeof c?.name === 'string' ? c.name : uk, fileId });
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

/** `xcpcrating` 题型数据 → `qoj 题号 → 知识点标签`（detailTags） */
export function parseXcpcTags(json: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const problems = (json as { problems?: unknown } | null)?.problems;
  if (problems === null || typeof problems !== 'object') return out;
  for (const raw of Object.values(problems as Record<string, unknown>)) {
    const canonical = (raw as { canonicalId?: unknown })?.canonicalId;
    if (typeof canonical !== 'string' || !canonical.startsWith('qoj:')) continue;
    const tags = (raw as { detailTags?: unknown })?.detailTags;
    if (!Array.isArray(tags)) continue;
    const clean = tags.map((t) => String(t).trim()).filter(Boolean);
    if (clean.length > 0) out.set(canonical.slice(4), [...new Set(clean)]);
  }
  return out;
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

// ---------- 网络与缓存 ----------

export interface IcpcRuntime {
  fetchFn: typeof fetch;
  catalog: Map<string, IcpcCatalogEntry> | null;
  tags: Map<string, string[]> | null;
  boards: RanklandBoardMeta[] | null;
  /** 赛场键 → 该榜单词典（同一运行内不重复下载） */
  boardCache: Map<string, Map<string, IcpcBoardProblem>>;
  /** 本轮已下载的榜单数（受 MAX_BOARDS_PER_RUN 约束） */
  boardsFetched: number;
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

async function loadTags(runtime: IcpcRuntime): Promise<Map<string, string[]> | null> {
  if (runtime.tags) return runtime.tags;
  const cached = readCache('icpc-xcpc-problem-types', CATALOG_TTL_MS);
  if (cached) {
    runtime.tags = parseXcpcTags(cached);
    if (runtime.tags.size > 0) return runtime.tags;
  }
  try {
    const data = await fetchJsonVia(runtime.fetchFn, TYPES_URLS);
    const parsed = parseXcpcTags(data);
    if (parsed.size > 0) {
      writeCache('icpc-xcpc-problem-types', data);
      runtime.tags = parsed;
      return parsed;
    }
  } catch {
    // 标签是附带收益：拿不到不影响难度推导
  }
  return null;
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

/** 运行上下文（一次回填内复用：目录/索引只拉一次，榜单按赛场去重） */
export function createIcpcRuntime(fetchFn: typeof fetch): IcpcRuntime {
  return { fetchFn, catalog: null, tags: null, boards: null, boardCache: new Map(), boardsFetched: 0 };
}

/** QOJ 题号提取：题目键为 `contestId-problemId`（比赛题）或纯 `problemId` */
export function qojProblemIdFromKey(problemKey: string): string | null {
  const key = String(problemKey).trim();
  const contestScoped = /^(\d+)-(\d+)$/.exec(key);
  if (contestScoped) return contestScoped[2];
  return /^\d+$/.test(key) ? key : null;
}

/**
 * 批量推导 QOJ 题目的难度（挂到给定运行上下文上，重复调用复用缓存）。
 * 返回 `题号 → 推导结果`：未匹配到公开榜单的题不出现在结果里（保持未知）。
 */
export async function resolveIcpcDifficulty(
  runtime: IcpcRuntime,
  problemIds: readonly string[],
): Promise<Map<string, IcpcProblemInfo>> {
  const out = new Map<string, IcpcProblemInfo>();
  const wanted = [...new Set(problemIds.filter((id) => /^\d+$/.test(id)))];
  if (wanted.length === 0) return out;

  const catalog = await loadCatalog(runtime);
  if (!catalog) return out; // 题号无法映射到赛题 → 全部保持未知
  const tags = await loadTags(runtime);
  const index = await loadBoardIndex(runtime);
  if (!index) {
    // 映射有了但榜单不可用：标签仍可补（难度保持未知）
    for (const id of wanted) {
      const t = tags?.get(id);
      if (t) out.set(id, { native: '', tier: null, tags: t });
    }
    return out;
  }

  for (const id of wanted) {
    const entry = catalog.get(id);
    if (!entry) continue;
    const meta = matchRanklandBoard(entry.contestKey, index);
    if (!meta) continue;
    const board = await loadBoard(runtime, meta);
    const stat = board?.get(entry.alias);
    if (!stat) continue;
    out.set(id, {
      native: `${stat.tier}:${stat.accepted}/${stat.total}`,
      tier: stat.tier,
      tags: tags?.get(id) ?? null,
    });
  }
  return out;
}

/** 档位顺序（供调用方做展示/排序，避免各处再写一份） */
export const ICPC_TIER_ORDER: readonly IcpcTier[] = ICPC_TIERS;
