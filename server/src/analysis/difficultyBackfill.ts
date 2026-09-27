import fs from 'node:fs';
import path from 'node:path';
import type { PlatformId } from '../../../shared/src/index.ts';
import { CF_RATING_MAX, CF_RATING_MIN, difficultyFields, type DifficultyScale } from '../../../shared/src/difficulty.ts';
import type { Db } from '../db/index.ts';
import { fetchWithChallenge } from '../adapters/luogu.ts';
import { parseJisuankeProblemTags } from '../adapters/jisuanke.ts';
import {
  fetchDaimayuanBank,
  fetchNowcoderBank,
  LEETCODE_BANK_PAGE,
  LEETCODE_BANK_QUERY,
  parseNcRowCells,
  type BankFetchResult,
} from '../adapters/problemBank.ts';
import { asHttpClient, sleep } from '../adapters/http.ts';
import { HOST_MIN_INTERVAL_MS } from '../net/hostThrottle.ts';
import { purifyTags } from '../import/problemWritePolicy.ts';
import { effectiveDataDir } from '../knowledge/store.ts';
import {
  createIcpcRuntime,
  MAX_BOARDS_PER_RUN,
  qojProblemIdFromKey,
  resolveIcpcDifficulty,
  type IcpcProblemInfo,
  type IcpcRuntime,
} from './icpcBoard.ts';

/** 单题回填查得的信息（洛谷/牛客逐题查询的返回结构） */
export interface BackfillInfo {
  problemKey: string;
  difficulty: number | null;
  /** 平台原生难度原文（未知为 null；写入 native_difficulty） */
  nativeDifficulty?: string | null;
  /** 原生难度所属标度（见 shared/src/difficulty.ts） */
  difficultyScale?: DifficultyScale | null;
  title: string | null;
  tags: string[] | null;
}

/** 缺口类型（决定回填优先级：真缺难度 > 缺标签 > 只缺原生值） */
export type BackfillGap = 'difficulty' | 'tags' | 'native';

/**
 * 负缓存的维度：上游被查过、且**确认这一项它给不出**。
 * - `difficulty` 同时覆盖「原生原文」（上游没有评级时，原生值与映射值必然同时无解）
 * - `tags` 表示该平台/该题没有标签来源（如 kenkoooo 只有难度）
 */
export type GapDimension = 'difficulty' | 'tags';

/** 维度全集（也是 `gap_state` 里的固定书写顺序） */
const GAP_DIMENSIONS: readonly GapDimension[] = ['difficulty', 'tags'];

/**
 * 负缓存有效期（天）。取 30 天的理由：这类缺口的性质变化很慢（CF 事后评级、牛客题目转私密、
 * 平台后来给题加标签），但也不是永不变；到期后重新查证一次，代价是一行/月。
 */
export const GAP_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * 「整表未收录」可以当作定论的来源：单次响应就是该平台的**完整**公开题库，
 * 键查不到 = 它确实不在这个接口里（CF 的 gym、AtCoder 已下线题）。
 * 分页扫描型（牛客/代码源/力扣/计蒜客）**不算**：单次回填只翻到页数上限为止，
 * 「本次没翻到」不等于「上游没有」，缓存它会把还在表里的题误关 30 天。
 */
const ABSENCE_IS_DEFINITIVE: ReadonlySet<PlatformId> = new Set<PlatformId>(['codeforces', 'atcoder']);

/**
 * 完全不写负缓存的平台：QOJ 的难度来自「xcpcrating 目录 + RankLand 榜单」两跳推导，
 * 返回 null 既可能是「目录里没有这道题」也可能是「榜单源不可用 / 本轮榜单配额已用满」——
 * 后者是临时故障，缓存它会让题目 30 天不再被尝试。整表一跳只需约 18 秒，不值得冒这个风险。
 */
const NO_GAP_CACHE: ReadonlySet<PlatformId> = new Set<PlatformId>(['qoj']);

/** `gap_state` 列（CSV）→ 维度集合；脏值（未知维度、空串）逐项忽略，不让它影响回填 */
export function parseGapState(raw: string | null | undefined): Set<GapDimension> {
  const set = new Set<GapDimension>();
  if (!raw) return set;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if ((GAP_DIMENSIONS as readonly string[]).includes(trimmed)) set.add(trimmed as GapDimension);
  }
  return set;
}

/** 维度集合 → `gap_state` 列值；空集落 NULL（没有「已确认无」的东西就不该留记录） */
function formatGapState(set: ReadonlySet<GapDimension>): string | null {
  const parts = GAP_DIMENSIONS.filter((d) => set.has(d));
  return parts.length === 0 ? null : parts.join(',');
}

/** 需要回填元数据的题（难度/原生难度/标签三者缺一即入选） */
export interface BackfillTarget {
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  nativeDifficulty: string | null;
  tags: string[];
  /** 该题最大的缺口（见 BackfillGap）；回填按此排序，真缺口先做 */
  gap: BackfillGap;
}

/** 单题元数据：fetcher 的统一返回结构（未知一律 null，不猜） */
export interface ProblemMeta {
  difficulty: number | null;
  nativeDifficulty: string | null;
  difficultyScale: DifficultyScale | null;
  /** 上游给出的标签；null = 上游无标签来源（不覆盖库内已有标签） */
  tags: string[] | null;
  title: string | null;
}

/** 单平台回填结果 */
export interface PlatformBackfillResult {
  platform: string;
  /** 参与回填的题数（该平台需补难度/原生难度/标签的题；已扣除 capped、deferred 与命中负缓存的部分） */
  scanned: number;
  /** 难度被补上的题数 */
  filled: number;
  /** 原生难度（native_difficulty）由 NULL 被补上的题数（与 filled 相互独立） */
  nativeFilled: number;
  /** 标题/标签/过时难度值被修正的题数（改自旧映射、旧钳位留下的过时值） */
  repaired: number;
  /** 上游仍无难度数据的题数（官方未评级等） */
  missing: number;
  /** 拉取失败（风控/网络/上游无此题）的题数 */
  failed: number;
  /** 本次因「单平台单次运行上限」未处理的题数（0 = 该平台目标已全部处理；>0 时再点一次继续） */
  capped: number;
  /**
   * 因「仅缺原生难度、且该平台逐题查询代价高」被本轮跳过的题数（不打扰上游、也不占用并发额度）。
   * 见 PER_PROBLEM_NATIVE_DEFERRED：这些题的 CF 难度**已经有了**，缺的只是原生原文，
   * 由 `includeNativeOnly` 显式开启后才逐题重查（默认跳过，避免每次点击打数百个无效请求）。
   */
  deferred: number;
  /**
   * 命中负缓存（上一轮已问过上游、上游明确给不出）而在 TTL 内**不再查询**的题数。
   * 与 `deferred` 的区别：deferred 是「难度已经有了、只缺原生原文，不值得逐题打上游」；
   * cached 是「这项上游真的没有，问过就行，别每月问第二次」。明细不在 details 里
   * （没有本轮请求，也就没有本轮结果），但计入 `unknownLeft` 等库内统计与前端文案。
   */
  cached: number;
  /** 每题明细（problemKey → 说明） */
  details: Array<{ problemKey: string; action: 'filled' | 'repaired' | 'missing' | 'failed' | 'skipped'; note?: string }>;
}

const NOWCODER_API = 'https://ac.nowcoder.com';
const LUOGU_API = 'https://www.luogu.com.cn';
const CODEFORCES_API = 'https://codeforces.com/api';
const KENKOOOO_API = 'https://kenkoooo.com/atcoder';
const LEETCODE_GRAPHQL = 'https://leetcode.cn/graphql';
const JISUANKE_BASE = 'https://www.jisuanke.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/** kenkoooo 资源缓存 24h（文件与 TTL 与 adapters/atcoder.ts 一致：两处共用同一份缓存文件） */
const RESOURCES_TTL_MS = 24 * 3600 * 1000;
/** 计蒜客题库列表每页条数（实测 20；页大小由服务端固定，不随参数变化） */
const JISUANKE_BANK_PAGE = 20;

/**
 * 回填自带的**兜底间隔** ＝ 全局按域名限速的安全下限（`net/hostThrottle.ts` 的 HOST_MIN_INTERVAL_MS）。
 *
 * 为什么必须与下限取同一个值：
 * - 线上「节流间隔是下限而非叠加」（两者取较大者），所以把适配器自带的 sleep 抬到同值
 *   **不会让线上额外变慢**；全局节流表仍可经设置页倍率（1×–5×）调慢。
 * - 但适配器原来的自带值（洛谷 0.3s/题、牛客 0.5s/页、代码源 0.4s/页…）远快于安全下限，
 *   一旦某条路径没挂全局节流层（本地脚本、单测、未来重构遗漏），它就成了**实际节奏**
 *   —— 那正是会触发平台风控的频率（2026-09-27 实测：不走节流层时牛客 200 页按 0.5s/页 连发）。
 *   因此这里把兜底钉到下限：任何路径下都不会比安全下限更快。
 * - 引用常量而不是写死数字：改下限时这里自动跟随，不会两边漂移。
 */
const FLOOR_MS = {
  luogu: HOST_MIN_INTERVAL_MS['www.luogu.com.cn'],
  nowcoder: HOST_MIN_INTERVAL_MS['ac.nowcoder.com'],
  daimayuan: HOST_MIN_INTERVAL_MS['bs.daimayuan.top'],
  leetcode: HOST_MIN_INTERVAL_MS['leetcode.cn'],
  jisuanke: HOST_MIN_INTERVAL_MS['www.jisuanke.com'],
  atcoder: HOST_MIN_INTERVAL_MS['kenkoooo.com'],
} as const;

/**
 * 平台限速与失败保护：
 * - `delayMs`：**逐题**请求之间的间隔（只有逐题型平台 luogu 会逐题请求上游；
 *   整表型平台（CF/AtCoder/力扣/计蒜客/**牛客/代码源**）的元数据来自整表/缓存，
 *   逐题循环不再发请求 → 间隔为 0，页间限速见 SCAN_DELAY_MS 与各题库拉取器内部限速）。
 * - `failLimit`：连续失败阈值，超过即视为触发风控并中止该平台（下次运行继续补）。
 *   洛谷开启（实测匿名逐题查询连续失败后会被限流，继续打会加重风控）；
 *   它是「逐题发请求」的平台，一次点击可能发出几百个请求，故必须有熔断。
 *   整表型平台不逐题发请求 → 无单题失败可数，取 null。
 * - `maxPerRun`：**单次运行**最多处理的题数（一次点击的耗时上限 =
 *   maxPerRun × delayMs）。没有它时，一个「全库原生难度为空」的旧库点一次回填会串行跑十几分钟
 *   才发现没补上几题；超出部分留在库里（状态即游标），下次点击继续。
 *   整表型平台不发逐题请求，上限只限制本次写库量；牛客/代码源一轮的目标数约 1.0k/0.5k，
 *   故取 20000 让它们在**一轮**内全部收敛（整表已拉、分批只会让下一轮重下整表）。
 */
const PLATFORM_LIMITS: Record<PlatformId, { delayMs: number; failLimit: number | null; maxPerRun: number }> = {
  // 牛客：整表分页扫描（见 fetchNowcoderTable）→ 不再逐题请求；页间节奏见 FLOOR_MS.nowcoder
  nowcoder: { delayMs: 0, failLimit: null, maxPerRun: 20000 },
  // 洛谷：唯一的逐题平台。delayMs 取主机安全下限（4s/题）—— 线上与全局节流取较大者，不额外变慢，
  // 但保证不走节流层时也不会用 0.3s/题 的频率连发（那正是会招风控的节奏）。
  // 一轮最坏耗时 = maxPerRun × delayMs ≈ 400 × 4s ≈ 27 分钟（可用设置页倍率整体调慢）。
  luogu: { delayMs: FLOOR_MS.luogu, failLimit: 8, maxPerRun: 400 },
  // 代码源：整表 JSON 分页扫描（见 fetchDaimayuanTable）→ 不再逐题请求
  daimayuan: { delayMs: 0, failLimit: null, maxPerRun: 20000 },
  // 整表平台：一次请求就拿到全库元数据，逐题循环只是查内存 → 上限只限制「本次写库量」，
  // 放宽到 20000 让「仅缺原生值」的历史行在一轮内收敛（此前 2000 要连点数次，每点一次都重下整表）
  leetcode: { delayMs: 0, failLimit: null, maxPerRun: 20000 },
  jisuanke: { delayMs: 0, failLimit: null, maxPerRun: 20000 },
  atcoder: { delayMs: 0, failLimit: null, maxPerRun: 20000 },
  codeforces: { delayMs: 0, failLimit: null, maxPerRun: 20000 },
  // QOJ 不逐题发请求：目录/索引/榜单各拉一次（榜单下载量另受 MAX_BOARDS_PER_RUN 约束）
  qoj: { delayMs: 0, failLimit: null, maxPerRun: 2000 },
};

/**
 * 「仅缺原生难度」在**逐题查询**平台上默认跳过（计入 deferred），因为这类题的 CF 难度已经有了，
 * 只是缺原生原文；而逐题平台每补一行要单独打一次上游（洛谷 ≥4s/题），一个老库动辄几千行
 * —— 每次点击都在为「不影响展示的原生列」发几百个请求，既慢又招风控。
 * 需要补齐原生列时显式开 `includeNativeOnly`（代价是这一轮的耗时）。
 *
 * 2026-09-27 起**只剩洛谷**在这里：牛客与代码源虽然也是逐题来源，但两者都有**公开题库整表接口**
 * （见 fetchNowcoderTable / fetchDaimayuanTable），改用整表扫描后一轮就能把「仅缺原生值」的历史行
 * 全部补齐（实测牛客 1055/1082、代码源 459/459），代价是几十~两百次分页请求而不是上千次逐题请求；
 * 更要紧的是，**保留 defer 会让旧映射留下的过时难度值永远得不到修正**
 * （实测代码源 459 行里 411 行、牛客 1033 行里 280 行的难度值与上游不一致）。
 * 洛谷实测整表接口对本库的行覆盖率只有 63/2418（本库的洛谷题多来自提交记录，不在题库列表前若干页），
 * 且要扫 77 页/140s —— 收益不足以抵消成本，故仍保持逐题 + 默认跳过。
 */
const PER_PROBLEM_NATIVE_DEFERRED: ReadonlySet<PlatformId> = new Set<PlatformId>(['luogu']);

/** 未登记平台的兜底限额：不发逐题请求、不熔断、本次不设额外上限（见 backfillPlatform） */
const DEFAULT_PLATFORM_LIMITS = { delayMs: 0, failLimit: null, maxPerRun: 0 } as const;

/**
 * 整表扫描的页间/请求间间隔：同样取各主机的**安全下限**（见 FLOOR_MS）。
 * 这些值原先是按平台自己声明的「最低要求」定的（力扣 400ms / 计蒜客 300ms / AtCoder ≥1s），
 * 安全下限普遍更严（1.5s–2.5s）；线上与全局节流取较大者 → 不额外变慢，
 * 但不走节流层时也不会用「作品站最低要求」的频率连发。
 */
const SCAN_DELAY_MS = {
  leetcode: FLOOR_MS.leetcode,
  jisuanke: FLOOR_MS.jisuanke,
  atcoder: FLOOR_MS.atcoder,
} as const;

/** 一次回填运行的上下文：整表平台只拉一次，逐题平台用共享的 tag 字典 */
interface BackfillCtx {
  fetchFn: typeof fetch;
  /** 整表型平台：键 → 元数据（同一运行内复用；拉取失败则 promise 拒绝，不重复打上游） */
  tables: Map<PlatformId, Promise<Map<string, ProblemMeta>>>;
  /** 本次需要回填的题号（整表平台据此在扫描中提前结束） */
  wanted: Map<PlatformId, Set<string>>;
  /** 洛谷 tag id → 名称字典（懒加载，供逐题详情复用） */
  luoguTagDict?: Promise<Map<number, string>>;
  /** ICPC/CCPC 公开榜单运行时（QOJ 难度来源；目录/索引只拉一次、榜单按赛场去重） */
  icpc: IcpcRuntime;
  /** 本次运行内 QOJ 题的推导结果（懒加载一次；结果用题目 id 索引） */
  icpcInfo?: Promise<Map<string, IcpcProblemInfo>>;
  /** 本次运行的统一时刻：写 `gap_checked_at` 用同一个值，避免同一轮里 TTL 起点漂移 */
  gapCheckedAt: string;
}

// ---------- 回填目标选择 ----------

/**
 * 需要回填的题：无 CF 难度 / 无原生难度 / 无标签，且**未被负缓存覆盖**。
 *
 * 排序即优先级（2026-09-27 起）：`difficulty IS NULL` 最前，其次 `tags = '[]'`，
 * 最后才是「难度已有、只缺原生原文」。原因：老库（`native_difficulty` 列是后加的）
 * 里绝大多数行只是原生值为空，而每平台的单次上限是按这个顺序截断的 —— 不排序时，
 * 一次点击发出的数百个逐题请求几乎全打给「难度早就有了」的题，真缺难度的题排在
 * 字母序末尾、要点好几次才轮到（实测牛客 41 道缺难度题里有 7 道从未被轮到）。
 *
 * QOJ 也纳入目标（原先被排除）：其难度由 `analysis/icpcBoard.ts` 从 ICPC/CCPC
 * 公开榜单推导；推导不到时仍如实记 missing，不猜。
 *
 * 负缓存（`problems.gap_state` + `gap_checked_at`）：上一轮已经问过上游、且上游明确
 * 给不出的维度，在 TTL 内不再进目标 —— 否则这些行会**永远**留在目标集合里，
 * 连带让整表扫描的 wantKeys 早停无法触发（本机实测牛客因此每次都要翻满 200 页）。
 * `ignoreGapCache` 是运维强查口子（路由上复用 `includeNativeOnly`）。
 */
export function pickBackfillTargets(
  db: Db,
  opts: { ignoreGapCache?: boolean } = {},
): BackfillTarget[] {
  return selectGapRows(db)
    .filter((r) => opts.ignoreGapCache === true || !isGapCached(r))
    .map(toBackfillTarget);
}

/** `problems` 里仍有缺口的原始行（含负缓存两列，供选择与统计共用一条 SQL） */
interface GapRow {
  platform: PlatformId;
  problem_key: string;
  title: string;
  difficulty: number | null;
  native_difficulty: string | null;
  tags: string;
  gap_state: string | null;
  gap_checked_at: string | null;
}

/** 逐题循环里按 (platform, key) 回读的行形状（比 GapRow 少排序列，多一个 title 供标题判定） */
interface GapColumns {
  title: string;
  difficulty: number | null;
  native_difficulty: string | null;
  tags: string;
  gap_state: string | null;
  gap_checked_at: string | null;
}

function selectGapRows(db: Db): GapRow[] {
  return db
    .prepare(
      `SELECT platform, problem_key, title, difficulty, native_difficulty, tags, gap_state, gap_checked_at
         FROM problems
        WHERE difficulty IS NULL OR native_difficulty IS NULL OR tags = '[]'
        ORDER BY platform,
                 CASE
                   WHEN difficulty IS NULL THEN 0
                   WHEN tags = '[]' THEN 1
                   ELSE 2
                 END,
                 problem_key`,
    )
    .all() as unknown as GapRow[];
}

function toBackfillTarget(r: GapRow): BackfillTarget {
  const tags = JSON.parse(r.tags) as string[];
  const gap: BackfillGap = r.difficulty === null ? 'difficulty' : tags.length === 0 ? 'tags' : 'native';
  return {
    platform: r.platform,
    problemKey: r.problem_key,
    title: r.title,
    difficulty: r.difficulty,
    nativeDifficulty: r.native_difficulty,
    tags,
    gap,
  };
}

/**
 * 该行**仍未被满足**的缺口维度。
 * `difficulty` 维度同时要求难度与原生原文都有值：上游给出评级时两者同源同写，
 * 只有旧库（`native_difficulty` 列后加）才会出现「有难度、无原文」，那一类由整表扫描补齐。
 */
function openDimensions(r: Pick<GapRow, 'difficulty' | 'native_difficulty' | 'tags'>): GapDimension[] {
  const dims: GapDimension[] = [];
  if (r.difficulty === null || r.native_difficulty === null) dims.push('difficulty');
  const rowTags = JSON.parse(r.tags) as string[];
  if (rowTags.length === 0) dims.push('tags');
  return dims;
}

/** 负缓存是否已覆盖该行**全部**缺口：命中即本轮不必再打上游 */
export function isGapCached(r: GapRow, now: number = Date.now()): boolean {
  const state = parseGapState(r.gap_state);
  if (state.size === 0) return false;
  const checkedAt = r.gap_checked_at === null ? NaN : Date.parse(r.gap_checked_at);
  if (!Number.isFinite(checkedAt) || now - checkedAt > GAP_TTL_MS) return false;
  const open = openDimensions(r);
  return open.length > 0 && open.every((d) => state.has(d));
}

// ---------- 本地补齐：原生难度 = 映射后难度（零请求） ----------

/**
 * 对**难度与原生值同值**且**逐题查询**的标度，直接用已落库的 CF 难度回填 `native_difficulty`：
 * - nowcoder：原生难度分与 CF 难度分同量纲，但映射带钳位（`nowcoderScoreToRating` 把低于 800
 *   的值钳到 800、高于 3500 的钳到 3500）→ 只有严格落在开区间内才与原值相等；边界值
 *   （800 / 3500）无法区分原值到底是它本身还是被钳上来的，一律不推导、留给上游。
 * - codeforces：原生值同样是 rating 本身，**但故意不本地推导** —— CF 的难度来自
 *   `problemset.problems` 整表（一次请求拿全库），同一轮就能用上游权威值修正历史遗留的
 *   过时难度；本地推导反而会把这些行移出目标集，让「过时值永远不会被纠正」。
 *   表驱动平台（CF/AtCoder/力扣/计蒜客）同理：拉表不逐题，保留为回填目标。
 *
 * 为什么值得做：nowcoder 一个老库动辄上千行「难度已有、只缺原生值」，逐题重查要发上千个请求，
 * 而这一步零请求、且与原始映射严格同源（同一张表、同一个值）。
 */
export function identityNative(platform: PlatformId, difficulty: number | null): string | null {
  if (difficulty === null) return null;
  if (platform === 'nowcoder') {
    return difficulty > CF_RATING_MIN && difficulty < CF_RATING_MAX ? String(difficulty) : null;
  }
  return null;
}

/** 可本地推导原生值的平台（见 identityNative 注释：只限 identity 标度 + 逐题查询） */
const IDENTITY_DERIVE_PLATFORMS: ReadonlyArray<[PlatformId, DifficultyScale]> = [['nowcoder', 'nowcoder-score']];

/** 本地补齐可推导的原生难度/标度，返回补齐行数（纯 SQL，无网络） */
export function deriveIdentityNative(db: Db): number {
  let total = 0;
  for (const [platform, scale] of IDENTITY_DERIVE_PLATFORMS) {
    const rows = db
      .prepare(
        `SELECT problem_key, difficulty FROM problems
          WHERE platform = ? AND difficulty IS NOT NULL AND native_difficulty IS NULL
            AND COALESCE(difficulty_source, 'sync') != 'manual'`,
      )
      .all(platform) as Array<{ problem_key: string; difficulty: number }>;
    if (rows.length === 0) continue;
    const update = db.prepare(
      `UPDATE problems SET native_difficulty = ?, difficulty_scale = COALESCE(difficulty_scale, ?)
        WHERE platform = ? AND problem_key = ?`,
    );
    // node:sqlite 无 better-sqlite3 的 transaction() 包装：显式 BEGIN/COMMIT（与 db/index.ts 同风格）
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const native = identityNative(platform, r.difficulty);
        if (native === null) continue;
        update.run(native, scale, platform, r.problem_key);
        total += 1;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return total;
}

// ---------- 逐题来源：牛客 ----------

/**
 * 解析牛客搜索结果行，分离标题与标签（.title 链接为标题，.tag-label 为算法标签）。
 * 返回 null 表示未命中该题号。
 *
 * 单元格定位与取值**共用题库路径的同一份解析器**（`parseNcRowCells`：标题锚点 + 后一格 + 共享校验器）。
 * 历史缺陷：本读取方直接取 `tds[2]`，与题库路径的「紧随标题单元格」规则不一致 ——
 * 行内列数一变（多一列勾选框/少一列难度）就会把通过数当成难度写库，
 * 而回填的 backfill(3) 优先级高于 bank(1)/sync(2)，会覆盖掉原本正确的难度。
 */
export function parseNcSearchRow(html: string, problemKey: string): BackfillInfo | null {
  const trRe = new RegExp(`<tr[^>]*data-problemId="${problemKey}"[^>]*>([\\s\\S]*?)</tr>`);
  const m = trRe.exec(html);
  if (!m) return null;
  const { title, tags, nativeScore } = parseNcRowCells(m[1]);
  const mapped = difficultyFields('nowcoder', nativeScore);
  return {
    problemKey,
    difficulty: mapped.difficulty ?? null,
    nativeDifficulty: mapped.nativeDifficulty ?? null,
    difficultyScale: mapped.difficultyScale,
    title: title === '' ? null : title,
    tags: tags.length > 0 ? tags : null,
  };
}

/**
 * 牛客单题回填：keyword=题号 搜索（匿名可访问），未命中/风控返回 null。
 *
 * 注意：**批量回填已不再走这里**（改用题库整表扫描，见 fetchNowcoderTable）—— 逐题搜索会为
 * 「难度/原生值早就有了」的历史行发出上千次请求，而整表扫描一次就能覆盖并顺带修正过时难度值。
 * 本函数保留为单题排查入口，两个读取方的单元格定位规则仍共用一份（parseNcRowCells）。
 */
export async function fetchNcProblemInfo(
  fetchFn: typeof fetch,
  problemKey: string,
): Promise<BackfillInfo | null> {
  const url = `${NOWCODER_API}/acm/problem/list?keyword=${encodeURIComponent(problemKey)}`;
  const res = await fetchFn(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${NOWCODER_API}/acm/problem/list`,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null; // 调用方按连续失败计数中止
  const html = await res.text();
  return parseNcSearchRow(html, problemKey);
}

// ---------- 逐题来源：洛谷 ----------

interface LgProblemPayload {
  name?: string;
  title?: string;
  difficulty?: number;
  tags?: Array<{ name?: string } | number>;
}

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
  // difficulty=0 = 洛谷「暂无评定」：难度未知（null），但原生原文 '0' 照落库 ——
  // 原生原文落库是为了**如实记录上游状态**（避免显示与上游不一致），并让「难度与原生值同源」
  // 这一不变量成立。注意：它**不会**让该题退出回填目标（pickBackfillTargets 还看 difficulty IS NULL），
  // 所以永久未评级的题每次回填都会被重新查一次（本次运行上限 capped 之前，这是已知代价）。
  const mapped = difficultyFields('luogu', typeof p.difficulty === 'number' ? p.difficulty : null);
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
    difficulty: mapped.difficulty ?? null,
    nativeDifficulty: mapped.nativeDifficulty ?? null,
    difficultyScale: mapped.difficultyScale,
    title,
    tags: tags.length > 0 ? tags : null,
  };
}

/** 洛谷 tag id → 名称字典（/_lfe/tags 匿名可访问；失败降级空字典，仅丢失标签） */
async function fetchLuoguTagDict(fetchFn: typeof fetch): Promise<Map<number, string>> {
  const dict = new Map<number, string>();
  try {
    const res = await fetchWithChallenge(fetchFn, `${LUOGU_API}/_lfe/tags`, '', undefined, {
      Accept: 'application/json',
      'User-Agent': UA,
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

// ---------- 整表来源：Codeforces / AtCoder / 力扣 / 计蒜客 / 牛客 / 代码源 ----------

function metaFromFields(
  platform: PlatformId,
  raw: unknown,
  extra: { tags: string[] | null; title: string | null },
): ProblemMeta {
  const mapped = difficultyFields(platform, raw);
  return {
    difficulty: mapped.difficulty ?? null,
    nativeDifficulty: mapped.nativeDifficulty ?? null,
    difficultyScale: mapped.difficultyScale,
    tags: extra.tags,
    title: extra.title,
  };
}

/** Codeforces：`problemset.problems` 单次返回全量题库（约 1 万题，自带 rating 与标签） */
async function fetchCodeforcesTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const res = await asHttpClient(ctx.fetchFn).fetch(`${CODEFORCES_API}/problemset.problems`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  }, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`Codeforces 题库接口 HTTP ${res.status}`);
  const data = (await res.json()) as {
    status?: string;
    result?: {
      problems?: Array<{ contestId?: number; index?: string; name?: string; rating?: number; tags?: string[] }>;
    };
  };
  const list = data.result?.problems;
  if (data.status !== 'OK' || !Array.isArray(list)) throw new Error('Codeforces 题库接口响应异常');
  const table = new Map<string, ProblemMeta>();
  for (const p of list) {
    if (typeof p.contestId !== 'number' || typeof p.index !== 'string' || !p.index) continue;
    table.set(
      `${p.contestId}${p.index}`.toUpperCase(),
      metaFromFields('codeforces', typeof p.rating === 'number' ? p.rating : null, {
        tags: Array.isArray(p.tags) && p.tags.length > 0 ? p.tags : null,
        title: p.name ?? null,
      }),
    );
  }
  return table;
}

/**
 * AtCoder：kenkoooo 两份资源整表（problems.json / problem-models.json，24h 磁盘缓存，
 * 与 adapters/atcoder.ts 共用同一份缓存文件）。θ 走 shared 的分段锚点映射。
 * 注：AtCoder 无标签来源 → tags 恒为 null（标签缺失的题会持续成为候选，但元数据取自缓存，代价极低）。
 */
async function fetchAtcoderTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const probData = await loadCachedJson(ctx.fetchFn, `${KENKOOOO_API}/resources/problems.json`, 'atcoder-problems');
  await sleep(SCAN_DELAY_MS.atcoder); // kenkoooo 要求请求间隔 >= 1s
  const modelData = await loadCachedJson(ctx.fetchFn, `${KENKOOOO_API}/resources/problem-models.json`, 'atcoder-problem-models');
  const problems = probData as Array<{ id?: string; title?: string; name?: string }>;
  const models = modelData as Record<string, { difficulty?: number | null }>;
  if (!Array.isArray(problems)) throw new Error('AtCoder 题库资源结构异常');
  const table = new Map<string, ProblemMeta>();
  for (const p of problems) {
    if (typeof p.id !== 'string' || !p.id) continue;
    const theta = models[p.id]?.difficulty;
    table.set(
      p.id,
      metaFromFields('atcoder', typeof theta === 'number' && Number.isFinite(theta) ? theta : null, {
        tags: null,
        title: p.title ?? p.name ?? null,
      }),
    );
  }
  return table;
}

/** kenkoooo 资源缓存读写（文件名与 TTL 与 adapters/atcoder.ts 一致） */
async function loadCachedJson(fetchFn: typeof fetch, url: string, cacheKey: string): Promise<unknown> {
  const dataDir = effectiveDataDir();
  const cachePath = dataDir ? path.join(dataDir, `${cacheKey}.json`) : '';
  if (cachePath && fs.existsSync(cachePath)) {
    const age = Date.now() - fs.statSync(cachePath).mtimeMs;
    if (age < RESOURCES_TTL_MS) return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as unknown;
  }
  const res = await asHttpClient(fetchFn).fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  }, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`AtCoder 资源接口 HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (cachePath) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data));
  }
  return data;
}

interface LcQuestion {
  title?: string;
  titleCn?: string;
  titleSlug?: string;
  difficulty?: string;
  paidOnly?: boolean;
  topicTags?: Array<{ name?: string; nameTranslated?: string }>;
}

/**
 * 力扣：`problemsetQuestionList` 分页扫描（全库约 45 次请求，每页 100）。
 * 该节点支持 `titleCn` 与 `topicTags.nameTranslated`；逐题的 `question(titleSlug)`
 * **不支持**这两个字段（实测 GraphQL 400 Cannot query field），故不采用逐题查询。
 */
async function fetchLeetcodeTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const table = new Map<string, ProblemMeta>();
  const wanted = ctx.wanted.get('leetcode');
  for (let skip = 0; skip < 20000; skip += LEETCODE_BANK_PAGE) {
    const res = await asHttpClient(ctx.fetchFn).fetch(LEETCODE_GRAPHQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://leetcode.cn/problemset/',
        'User-Agent': UA,
      },
      body: JSON.stringify({ query: LEETCODE_BANK_QUERY, variables: { limit: LEETCODE_BANK_PAGE, skip } }),
    }, { timeoutMs: 30000 });
    if (!res.ok) throw new Error(`力扣题库接口 HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { problemsetQuestionList?: { total?: number; questions?: LcQuestion[] } };
      errors?: Array<{ message?: string }>;
    };
    const list = body.data?.problemsetQuestionList;
    if (body.errors?.length || !Array.isArray(list?.questions)) {
      throw new Error(`力扣题库接口响应异常${body.errors?.[0]?.message ? `：${body.errors[0].message}` : ''}`);
    }
    if (list.questions.length === 0) break;
    for (const q of list.questions) {
      if (!q.titleSlug) continue;
      const tags = (q.topicTags ?? [])
        .map((t) => (t.nameTranslated || t.name || '').trim().toLowerCase())
        .filter(Boolean);
      table.set(
        q.titleSlug.toLowerCase(),
        metaFromFields('leetcode', q.difficulty, {
          tags: tags.length > 0 ? tags : null,
          title: q.titleCn || q.title || null,
        }),
      );
    }
    if (wanted && wanted.size > 0 && [...wanted].every((k) => table.has(k))) break; // 目标题已齐 → 提前结束
    if (list.questions.length < LEETCODE_BANK_PAGE) break;
    await sleep(SCAN_DELAY_MS.leetcode);
  }
  return table;
}

interface JisuankeBankRow {
  problemIdentifier?: string;
  title?: string;
  difficultyType?: string | number;
  problemTags?: unknown;
}

/**
 * 计蒜客：题库列表整表批量扫描（每页 20 条，~180 页）。
 * 行内 `problemTags` 同时给出难度档位类标签与知识点类标签，故一次扫描即可同时补难度与标签；
 * 题目与目标题号全部对上后提前结束。
 * （计划文本提到的 `/api/problem/tags` 字典实测匿名访问 302 跳转，不可用；行内已自带 tagName，无需字典。）
 */
async function fetchJisuankeTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const table = new Map<string, ProblemMeta>();
  const wanted = ctx.wanted.get('jisuanke');
  for (let page = 1; page <= 300; page += 1) {
    const res = await asHttpClient(ctx.fetchFn).fetch(`${JISUANKE_BASE}/api/problems?page=${page}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${JISUANKE_BASE}/problems` },
    }, { timeoutMs: 20000 });
    if (!res.ok) throw new Error(`计蒜客题库接口 HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as
      | { total?: number; problems?: JisuankeBankRow[] }
      | null;
    if (body === null) throw new Error('计蒜客题库接口返回非 JSON（接口变化）');
    const rows = Array.isArray(body.problems) ? body.problems : [];
    if (rows.length === 0) break;
    for (const p of rows) {
      const key = typeof p.problemIdentifier === 'string' ? p.problemIdentifier.trim() : '';
      if (!key) continue;
      const { knowledge } = parseJisuankeProblemTags(p.problemTags);
      table.set(
        key,
        metaFromFields('jisuanke', p.difficultyType, {
          tags: knowledge.length > 0 ? knowledge : null,
          title: typeof p.title === 'string' && p.title.trim() !== '' ? p.title.trim() : null,
        }),
      );
    }
    if (wanted && wanted.size > 0 && [...wanted].every((k) => table.has(k))) break;
    if (typeof body.total === 'number' && page * JISUANKE_BANK_PAGE >= body.total) break;
    await sleep(SCAN_DELAY_MS.jisuanke);
  }
  return table;
}

const TABLE_FETCHERS: Partial<Record<PlatformId, (ctx: BackfillCtx) => Promise<Map<string, ProblemMeta>>>> = {
  codeforces: fetchCodeforcesTable,
  atcoder: fetchAtcoderTable,
  leetcode: fetchLeetcodeTable,
  jisuanke: fetchJisuankeTable,
  nowcoder: fetchNowcoderTable,
  daimayuan: fetchDaimayuanTable,
};

/**
 * 题库拉取结果 → 回填用「键 → 元数据」表。
 *
 * 复用 `adapters/problemBank.ts` 的题库拉取器（它们已经是「分页列表一次拿全」）而不是逐题查询：
 * 这是参考项目 OJ_Insight 获取难度的方式（`src-tauri/src/sync/nowcoder.rs` 逐页翻题库列表、
 * `xcpc/rating.rs` 按公开榜单整体推导），本项目此前只在「拉题库」链路用了整表、
 * 回填链路却逐题打上游，导致缺原生值的历史行只能 defer。
 */
function bankToTable(bank: BankFetchResult): Map<string, ProblemMeta> {
  const table = new Map<string, ProblemMeta>();
  for (const p of bank.problems) {
    table.set(p.problemKey, {
      difficulty: p.difficulty,
      nativeDifficulty: p.nativeDifficulty,
      difficultyScale: p.difficultyScale,
      tags: p.tags,
      title: p.title,
    });
  }
  return table;
}

/**
 * 牛客：公开题库整表分页扫描（GET /acm/problem/list?queryType=all&orderById=true&page=N）。
 *
 * 为什么改用整表：牛客是「逐题查询」平台里历史包袱最重的一个 —— 本机 1082 行「难度已有、
 * 只缺原生值」，逐题补要发 1082 次请求（约 8 分钟），旧实现因此默认 defer 它们，
 * 于是 `native_difficulty` 常年为空、且**旧映射留下的过时难度值永远不会被修正**。
 * 实测整表扫描（200 页 / 约 120 秒）覆盖 1055/1082 行，其中 1040 行能拿到难度、
 * 并顺带修正 280 行与上游不一致的过时难度值 —— 请求数少一个量级，结果还更全。
 */
async function fetchNowcoderTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const bank = await fetchNowcoderBank(ctx.fetchFn, {
    // 库内目标通常几百行：全部命中即停，避免为几道题扫完整表（见 BankFetchOptions.wantKeys）
    wantKeys: ctx.wanted.get('nowcoder'),
    // 页间兜底间隔 = 主机安全下限（见 FLOOR_MS）：不走全局节流层时也不会 0.5s/页 连发
    pageDelayMs: FLOOR_MS.nowcoder,
    max: 20000,
  });
  return bankToTable(bank);
}

/**
 * 代码源（Hydro）：整表 JSON 分页扫描（GET /p?page=N）。
 * 本机 459 行缺原生值全部可在 5 页内覆盖（约 2 秒），并修正 411 行过时难度值
 * （旧版 hydroDifficulty/映射留下的值，例如上游 2000 而库内 2200/2500）。
 */
async function fetchDaimayuanTable(ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const bank = await fetchDaimayuanBank(ctx.fetchFn, {
    wantKeys: ctx.wanted.get('daimayuan'),
    pageDelayMs: FLOOR_MS.daimayuan,
    max: 20000,
  });
  return bankToTable(bank);
}

/** 整表平台的键 → 元数据；同一运行内只拉一次。
 *  拉取失败时把**已拒绝的 promise** 留在缓存里（不重复打上游、也不中断其他平台）：
 *  调用方（fetchProblemMeta）据此抛出 → 逐题循环把该平台的目标统一记 failed。
 *  这里刻意不再「失败也返回 null」：整表未命中是有价值的定论（可用于负缓存），
 *  而「上游没返回」什么都说明不了，两者混在一起会让风控期间的失败被当成「官方无此题」。 */
function platformTable(platform: PlatformId, ctx: BackfillCtx): Promise<Map<string, ProblemMeta>> {
  const cached = ctx.tables.get(platform);
  if (cached) return cached;
  const fetcher = TABLE_FETCHERS[platform];
  const p = fetcher
    ? fetcher(ctx)
    : Promise.reject(new Error(`平台 ${String(platform)} 无整表元数据来源`));
  ctx.tables.set(platform, p);
  return p;
}

/**
 * 单题元数据获取（回填注册表入口）。平台 → 来源：
 * - luogu：GET /problem/{pid}（**唯一**逐题查询的平台，300ms 间隔 + 连续失败 8 次中止）
 * - codeforces / atcoder / leetcode / jisuanke / nowcoder / daimayuan：整表拉取后在内存里查
 *   （tables 缓存；nowcoder 与 daimayuan 复用题库拉取器的分页扫描，见 fetchNowcoderTable）
 * - qoj：平台无难度字段 → 用 ICPC/CCPC 公开榜单推导档位（见 analysis/icpcBoard.ts）；
 *   题号无法映射或榜单不可用时返回 null（保持未知，不猜）
 */
export async function fetchProblemMeta(
  platform: PlatformId,
  problemKey: string,
  ctx: BackfillCtx,
): Promise<ProblemMeta | null> {
  switch (platform) {
    case 'luogu': {
      ctx.luoguTagDict ??= fetchLuoguTagDict(ctx.fetchFn);
      const info = await fetchLgProblemInfo(ctx.fetchFn, problemKey, await ctx.luoguTagDict);
      return info === null ? null : toMeta(info);
    }
    case 'codeforces':
      return (await platformTable('codeforces', ctx)).get(problemKey.toUpperCase()) ?? null;
    case 'atcoder':
      return (await platformTable('atcoder', ctx)).get(problemKey) ?? null;
    case 'leetcode':
      return (await platformTable('leetcode', ctx)).get(problemKey.toLowerCase()) ?? null;
    case 'jisuanke':
      return (await platformTable('jisuanke', ctx)).get(problemKey) ?? null;
    case 'nowcoder':
      return (await platformTable('nowcoder', ctx)).get(problemKey) ?? null;
    case 'daimayuan':
      return (await platformTable('daimayuan', ctx)).get(problemKey) ?? null;
    case 'qoj': {
      const problemId = qojProblemIdFromKey(problemKey);
      if (problemId === null) return null;
      ctx.icpcInfo ??= resolveIcpcDifficulty(
        ctx.icpc,
        [...(ctx.wanted.get('qoj') ?? [])].map((k) => qojProblemIdFromKey(k)).filter((v): v is string => v !== null),
      );
      const info = (await ctx.icpcInfo).get(problemId);
      if (!info) return null;
      const mapped = info.native === '' ? null : difficultyFields('qoj', info.native);
      return {
        difficulty: mapped?.difficulty ?? null,
        nativeDifficulty: mapped?.nativeDifficulty ?? null,
        // 拿不到榜单（只有标签）时标度记 none：与适配器的「平台不提供难度」语义一致
        difficultyScale: mapped?.difficultyScale ?? 'none',
        tags: info.tags,
        title: null,
      };
    }
    default:
      return null;
  }
}

function toMeta(info: BackfillInfo): ProblemMeta {
  return {
    difficulty: info.difficulty,
    nativeDifficulty: info.nativeDifficulty ?? null,
    difficultyScale: info.difficultyScale ?? null,
    tags: info.tags,
    title: info.title,
  };
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
 * 未知难度/原生难度/标签的全平台回填：
 * - 目标选择见 pickBackfillTargets（含 QOJ；按缺口优先级排序，真缺难度先做）
 * - **先做一次零请求的本地补齐**（deriveIdentityNative）：把「难度已有、只缺原生值」的可推导行
 *   就地补齐，目标集合从「全库上万人行」收敛到真正缺东西的几百行
 * - **按平台取数方式分两类**（2026-09-27 起）：
 *   ① 整表类：CF / AtCoder / 力扣 / 计蒜客 / **牛客 / 代码源** —— 一次分页扫描拿全，逐题循环只查内存；
 *   ② 逐题类：仅剩洛谷（`GET /problem/{pid}`，300ms/题、连续失败 8 次熔断）。
 *   牛客与代码源原先也逐题查，导致「仅缺原生值」的历史行只能默认 defer、过时难度值永远得不到修正；
 *   改用各自的公开题库整表接口后（参考项目 OJ_Insight 的做法：分页列表一次拿全），一轮即可补齐
 *   并顺带修正过时值（本机实测：牛客覆盖 1055/1082 缺原生值的行、修正 280 行过时难度；
 *   代码源覆盖 459/459、修正 411 行）。洛谷整表对本库覆盖率仅 63/2418，故仍保持逐题 + 默认跳过。
 * - 每平台单次运行题数上限见 PLATFORM_LIMITS.maxPerRun：未处理的题数随结果回传（capped），
 *   下次点击从剩余目标继续
 * - **负缓存**（gap_state / gap_checked_at，TTL 见 GAP_TTL_MS）：上游明确给不出的维度在 TTL 内
 *   不再进目标，题数计入 cached。`includeNativeOnly: true` 一并绕过它（运维强查口子）
 * - **平台按实测成本升序处理**（见 PLATFORM_ORDER）：qoj/atcoder 等几秒完成，牛客整表扫描垫底；
 *   这样中途被放弃或进程被杀时，先跑完的平台成果已经落库，而不会「等都等了、qoj 一行都没写」
 * - 写库统一走 difficulty_source='backfill'（优先级 3）：难度、原生难度、标度、标题、标签
 *   都只在「库内为空 / 上游有值」时补齐，绝不覆盖已有手动值（manual）
 */
export async function backfillDifficulties(
  db: Db,
  fetchFn: typeof fetch = fetch,
  opts: {
    /** 覆盖「单平台单次运行上限」（默认取 PLATFORM_LIMITS[platform].maxPerRun）；仅供测试与运维调低 */
    maxTargetsPerPlatform?: number;
    /**
     * 逐题平台是否也补「仅缺原生难度」的行（默认 false；开启后单轮耗时会显著变长）。
     * 同时兼作**忽略负缓存**的运维强查口子：置 true 时连「上游已确认给不出」的维度也重新问一遍。
     */
    includeNativeOnly?: boolean;
  } = {},
): Promise<PlatformBackfillResult[]> {
  // 零请求收敛：可推导的原生值就地补齐（详见 deriveIdentityNative 注释）。
  // includeNativeOnly 时不做本地推导，保证「显式要求逐题重查上游」这一运维口子真的会打上游
  if (opts.includeNativeOnly !== true) deriveIdentityNative(db);

  const ignoreGapCache = opts.includeNativeOnly === true;
  const gapRows = selectGapRows(db);
  const cachedByPlatform = new Map<PlatformId, number>();
  const targets: BackfillTarget[] = [];
  for (const r of gapRows) {
    // 负缓存命中（本轮全部缺口都在 TTL 内被确认「上游给不出」）→ 不发请求、不占额度
    if (!ignoreGapCache && isGapCached(r)) {
      cachedByPlatform.set(r.platform, (cachedByPlatform.get(r.platform) ?? 0) + 1);
      continue;
    }
    targets.push(toBackfillTarget(r));
  }
  // 一行都不必查时也要把 cached 报出去：否则前端显示「没有待补的题」，
  // 而实际情况是「有 N 题上游确实没有，一个月内不再重复问」
  if (targets.length === 0 && cachedByPlatform.size === 0) return [];

  const byPlatform = new Map<PlatformId, BackfillTarget[]>();
  const deferredByPlatform = new Map<PlatformId, number>();
  for (const t of targets) {
    // 逐题平台的「仅缺原生难度」：默认跳过（不打扰上游、不占并发额度）
    if (t.gap === 'native' && PER_PROBLEM_NATIVE_DEFERRED.has(t.platform) && opts.includeNativeOnly !== true) {
      deferredByPlatform.set(t.platform, (deferredByPlatform.get(t.platform) ?? 0) + 1);
      continue;
    }
    const list = byPlatform.get(t.platform);
    if (list) list.push(t);
    else byPlatform.set(t.platform, [t]);
  }
  // 单平台单次运行上限：逐题平台把它折算成「一次点击最多几分钟」，整表平台只限制本次写库量。
  // 超出部分不丢弃（DB 状态就是游标，目标选择每次都从库里重新挑），只如实计入 capped。
  const cappedByPlatform = new Map<PlatformId, number>();
  for (const [platform, list] of byPlatform) {
    const limit = opts.maxTargetsPerPlatform ?? platformLimits(platform).maxPerRun;
    if (limit > 0 && list.length > limit) {
      cappedByPlatform.set(platform, list.length - limit);
      byPlatform.set(platform, list.slice(0, limit));
    }
  }
  const ctx: BackfillCtx = {
    fetchFn,
    tables: new Map(),
    wanted: new Map([...byPlatform].map(([p, list]) => [p, new Set(list.map((t) => t.problemKey))])),
    icpc: createIcpcRuntime(fetchFn),
    gapCheckedAt: new Date().toISOString(),
  };

  const results: PlatformBackfillResult[] = [];
  // 只被 deferred / 只命中负缓存的平台也要出结果：否则「本平台全部是仅缺原生值的行」时
  // 整条信息被吞掉，前端会误显示成「没有待补的题」
  for (const platform of orderedPlatforms([
    ...byPlatform.keys(),
    ...deferredByPlatform.keys(),
    ...cachedByPlatform.keys(),
  ])) {
    const list = byPlatform.get(platform) ?? [];
    const r =
      list.length > 0
        ? await backfillPlatform(db, platform, list, ctx)
        : {
            platform: String(platform),
            scanned: 0,
            filled: 0,
            nativeFilled: 0,
            repaired: 0,
            missing: 0,
            failed: 0,
            capped: 0,
            deferred: 0,
            cached: 0,
            details: [],
          };
    r.capped = cappedByPlatform.get(platform) ?? 0;
    r.deferred = deferredByPlatform.get(platform) ?? 0;
    r.cached = cachedByPlatform.get(platform) ?? 0;
    results.push(r);
  }
  return results;
}

/**
 * 平台处理顺序：**实测成本升序**（便宜、高价值的先做，长扫描放最后）。
 *
 * 为什么不能沿用默认顺序（`pickBackfillTargets` 的 `ORDER BY platform` = 字母序）：
 * 回填是一串**同步**的上游访问，总耗时由最慢的平台决定，而各平台成本差了两个数量级
 * （2026-09-27 实测：QOJ 目录+榜单 ≈18s、AtCoder 整表 ≈3s、代码源 5 页 ≈8s、
 * 力扣 ~35 页 ≈53s、计蒜客最多 184 页 ≈276s、洛谷逐题 ≥4s/题 × 数百题 ≈十几分钟、
 * 牛客整表最多 200 页 ≈400s）。字母序把 qoj 排在第 8（最后）→ 用户要等十几分钟才轮到它；
 * 更糟的是**中途放弃或进程被杀（开发期 `tsx watch` 因文件变更重启）时，先跑完的成果留下、
 * 排在后面的平台一行都没写** —— 实测一次被打断的回填只写完 atcoder + CF，qoj 全空，
 * 用户看到的就是「跑完回填，QOJ 还是没难度标签」。
 * 按成本升序后，即使被打断，用户也已经拿到绝大多数平台的标签；qoj 在头几秒就完成。
 */
const PLATFORM_ORDER: readonly PlatformId[] = [
  'qoj', // ≈18s：目录 + 榜单；一次点击内就能出结果
  'atcoder', // ≈3s：kenkoooo 两份整表
  'daimayuan', // ≈8s：Hydro 5 页
  'codeforces', // ≈10s：problemset.problems 一次拉表（写库量大，但一次请求）
  'leetcode', // ≈53s：problemsetQuestionList 分页
  'jisuanke', // ≈276s：题库分页最多 184 页（目标题常年不在题库里 → 常扫满）
  'luogu', // 逐题 ≥4s/题 × 数百题
  'nowcoder', // 整表最多 200 页 ≈400s
];

/** 按 PLATFORM_ORDER 排序；未登记的 platform（配置异常）排在最后，且保持稳定顺序 */
function orderedPlatforms(platforms: PlatformId[]): PlatformId[] {
  const rank = (p: PlatformId): number => {
    const i = PLATFORM_ORDER.indexOf(p);
    return i === -1 ? PLATFORM_ORDER.length : i;
  };
  return [...new Set(platforms)].sort((a, b) => rank(a) - rank(b));
}

/**
 * 取平台限额；未登记的平台串（配置/调用方传入的意外值）回落到保守默认值 ——
 * 不能因为查不到限额就让整轮回填抛错（其他平台的回填结果会一起丢掉）。
 */
function platformLimits(platform: PlatformId): { delayMs: number; failLimit: number | null; maxPerRun: number } {
  return PLATFORM_LIMITS[platform] ?? DEFAULT_PLATFORM_LIMITS;
}

async function backfillPlatform(
  db: Db,
  platform: PlatformId,
  targets: BackfillTarget[],
  ctx: BackfillCtx,
): Promise<PlatformBackfillResult> {
  const limits = platformLimits(platform);
  const r: PlatformBackfillResult = {
    platform,
    scanned: targets.length,
    filled: 0,
    nativeFilled: 0,
    repaired: 0,
    missing: 0,
    failed: 0,
    capped: 0,
    deferred: 0,
    cached: 0,
    details: [],
  };
  const before = db.prepare(
    'SELECT title, difficulty, native_difficulty, tags, gap_state, gap_checked_at FROM problems WHERE platform = ? AND problem_key = ?',
  );
  /** 负缓存两列的独立写入语句（未命中定论时只动这两列，不碰题面数据） */
  const writeGap = db.prepare(
    'UPDATE problems SET gap_state = ?, gap_checked_at = ? WHERE platform = ? AND problem_key = ?',
  );
  /**
   * 写库语义（与 import/problemWritePolicy.ts 的来源优先级一致：manual(4) > backfill(3) > sync(2) > bank(1)）：
   * - 已有难度且来源为 manual → 难度三元组（difficulty/native_difficulty/difficulty_scale）整体不动
   *   （用户手动标定最高优先；只补标题/标签，避免写出「手动难度 + 上游原生值」这种不同源组合）。
   * - 其余（难度为空 / 来源为 sync、bank 等）→ 补上游值：回填高于 sync/bank，可修正旧映射留下的过时值。
   * - difficulty_source：只有真的采纳了新难度（且不是 manual）才标 'backfill'。
   * - 标题：上游有值才覆盖；标签：上游给了非空标签才覆盖。
   * 注：SQLite 的 SET 右值全部读旧行，故各分支里的 `difficulty IS NOT NULL` 判的是更新前的值。
   */
  const update = db.prepare(
    `UPDATE problems
        SET difficulty = CASE
              WHEN difficulty IS NOT NULL AND COALESCE(difficulty_source, 'sync') = 'manual' THEN difficulty
              ELSE COALESCE(?, difficulty)
            END,
            native_difficulty = CASE
              WHEN difficulty IS NOT NULL AND COALESCE(difficulty_source, 'sync') = 'manual' THEN native_difficulty
              ELSE COALESCE(?, native_difficulty)
            END,
            difficulty_scale = CASE
              WHEN difficulty IS NOT NULL AND COALESCE(difficulty_source, 'sync') = 'manual' THEN difficulty_scale
              ELSE COALESCE(?, difficulty_scale)
            END,
            difficulty_source = CASE
              WHEN difficulty IS NOT NULL AND COALESCE(difficulty_source, 'sync') = 'manual' THEN difficulty_source
              WHEN ? IS NOT NULL THEN 'backfill'
              ELSE difficulty_source
            END,
            title = COALESCE(?, title),
            tags = CASE WHEN ? != '[]' THEN ? ELSE tags END
      WHERE platform = ? AND problem_key = ?`,
  );

  let consecutiveFails = 0;
  /**
   * 写库分批提交。
   *
   * 为什么需要：node:sqlite 默认自动提交 —— 每条 UPDATE 各自一个事务、各自 fsync。
   * 整表类平台一轮要写上万行（实测 CF 1.1 万 + 力扣 3.5k），逐行提交会把一次回填拖到近十分钟
   * （实测 1.9 万目标 ≈ 579s，其中写库占大头），而它本可以是几秒。
   * 分批（而不是整平台一个事务）是有意的：逐题平台（洛谷）在循环里发真实网络请求，
   * 一个长事务横跨 290 次网络往返会长时间占住写锁、并让 WAL 膨胀；分批同时把
   * 「中途异常回滚」的粒度限制在一批之内（保住已提交的进度）。
   */
  const WRITE_BATCH = 100;
  let inTx = false;
  let batchedWrites = 0;
  const openTx = (): void => {
    if (!inTx) {
      db.exec('BEGIN');
      inTx = true;
    }
  };
  const flushTx = (): void => {
    if (inTx) {
      db.exec('COMMIT');
      inTx = false;
      batchedWrites = 0;
    }
  };
  const abortTx = (): void => {
    if (inTx) {
      db.exec('ROLLBACK');
      inTx = false;
      batchedWrites = 0;
    }
  };

  try {
    for (const t of targets) {
      if (limits.failLimit !== null && consecutiveFails >= limits.failLimit) {
        r.failed += 1;
        r.details.push({ problemKey: t.problemKey, action: 'failed', note: '疑似触发风控，中止后续查询（可稍后重试）' });
        continue;
      }
      let meta: ProblemMeta | null = null;
      let failed = false;
      try {
        meta = await fetchProblemMeta(platform, t.problemKey, ctx);
      } catch {
        failed = true;
      }
      if (failed || meta === null) {
        // 未命中也可能是题号已废弃（如转私密），按单题缺失计，连续缺失也计入风控判定
        r.failed += 1;
        r.details.push({
          problemKey: t.problemKey,
          action: 'failed',
          note: failed
            ? '请求失败'
            : platform === 'qoj'
              ? `公开榜单未匹配到该题（题号映射缺失 / 榜单源不可用 / 本轮榜单拉取已达上限 ${MAX_BOARDS_PER_RUN}）`
              : '上游未命中',
        });
        consecutiveFails += 1;
        if (limits.delayMs > 0) await sleep(limits.delayMs);
        // 「上游未命中」只有在**单次响应即完整题库**的平台上才是定论（CF 的 problemset 不含 gym、
        // AtCoder 已下线题）；分页扫描型本次没翻到 ≠ 上游没有，故不写缓存。
        // 请求失败（failed）同样不写：风控期间的 404 会把题目锁住 30 天。
        if (!failed && meta === null && ABSENCE_IS_DEFINITIVE.has(platform)) {
          const miss = before.get(platform, t.problemKey) as GapColumns | undefined;
          if (miss) {
            const g = nextGapState({
              platform,
              oldState: miss.gap_state,
              oldCheckedAt: miss.gap_checked_at,
              meta: null,
              tagsFromUpstream: null,
              definitiveAbsence: true,
              checkedAt: ctx.gapCheckedAt,
              after: miss,
            });
            if (g.changed) writeGap.run(g.state, g.checkedAt, platform, t.problemKey);
          }
        }
        continue;
      }
      consecutiveFails = 0;

      const row = before.get(platform, t.problemKey) as GapColumns | undefined;
      if (!row) {
        // 题目在回填途中被删（用户并发删除回收站等）：记为跳过。此处再往下会让
        // row.title 抛 TypeError → 整个 backfillDifficulties reject → 路由 502、其余平台结果全丢
        r.details.push({ problemKey: t.problemKey, action: 'skipped', note: '题目已被删除' });
        continue;
      }
      const tags = meta.tags === null ? null : purifyTags(meta.tags);
      const tagsJson = tags === null || tags.length === 0 ? null : JSON.stringify(tags);
      // 牛客历史缺陷：标题曾被标签污染；上游未给标题时用本地清洗兜底
      const title =
        meta.title !== null && meta.title !== ''
          ? meta.title
          : platform === 'nowcoder' && ncTitlePolluted(row.title)
            ? cleanNcTitle(row.title)
            : null;

      openTx();
      update.run(
        meta.difficulty,
        meta.nativeDifficulty,
        meta.difficultyScale,
        meta.difficulty,
        title,
        tagsJson,
        tagsJson,
        platform,
        t.problemKey,
      );
      batchedWrites += 1;
      if (batchedWrites >= WRITE_BATCH) flushTx();

      // 计数按**实际落库结果**判定（而不是按 SQL 分支二次推断）：manual 行不写原生值时不会被误计
      const after = before.get(platform, t.problemKey) as GapColumns | undefined;
      if (!after) {
        // UPDATE 已因行消失而空转（0 行受影响）：同样记跳过，防 TypeError 打穿整轮
        r.details.push({ problemKey: t.problemKey, action: 'skipped', note: '题目已被删除' });
        continue;
      }
      const filledByWrite = row.difficulty === null && after.difficulty !== null;
      const filledNative = row.native_difficulty === null && after.native_difficulty !== null;
      /**
       * 过时难度值修正：难度本来有值、但与上游当前值不一致（旧映射/旧钳位留下的）。
       * 这类行不计入 filled（难度并非从无到有），但必须与「只补了原生值」区分开 ——
       * 整表扫描一轮能修正几百行（本机实测代码源 411、牛客 280），是改用整表的主要收益之一。
       */
      const difficultyCorrected =
        row.difficulty !== null && after.difficulty !== null && row.difficulty !== after.difficulty;
      const titleChanged = after.title !== row.title;
      const tagsChanged = after.tags !== row.tags;
      if (filledByWrite) r.filled += 1;
      if (filledNative) r.nativeFilled += 1;
      if (filledByWrite) {
        r.details.push({ problemKey: t.problemKey, action: 'filled', note: `难度 ${meta.difficulty}` });
      } else if (meta.difficulty === null) {
        r.missing += 1;
        r.details.push({ problemKey: t.problemKey, action: 'missing', note: '上游无难度数据（未评级/未设定）' });
      } else if (difficultyCorrected || titleChanged || tagsChanged || filledNative) {
        r.repaired += 1;
        r.details.push({
          problemKey: t.problemKey,
          action: 'repaired',
          note: difficultyCorrected
            ? `修正难度 ${row.difficulty}→${after.difficulty}`
            : titleChanged
              ? '修正标题'
              : tagsChanged
                ? '补标签'
                : '补原生难度',
        });
      }
      // 负缓存：本轮既然已经付过一次上游请求，就把「它给不出什么」一并记下（见 nextGapState）
      const g = nextGapState({
        platform,
        oldState: row.gap_state,
        oldCheckedAt: row.gap_checked_at,
        meta,
        tagsFromUpstream: tags,
        definitiveAbsence: false,
        checkedAt: ctx.gapCheckedAt,
        after,
      });
      if (g.changed) {
        openTx();
        writeGap.run(g.state, g.checkedAt, platform, t.problemKey);
        batchedWrites += 1;
        if (batchedWrites >= WRITE_BATCH) flushTx();
      }
      if (limits.delayMs > 0) await sleep(limits.delayMs);
    }
    flushTx();
  } catch (e) {
    abortTx();
    throw e;
  }
  return r;
}

/** 回填一行前后的负缓存判定输入 */
interface GapInput {
  platform: PlatformId;
  /** 行上已有的 `gap_state` / `gap_checked_at` */
  oldState: string | null;
  oldCheckedAt: string | null;
  /** 本轮拿到的上游元数据；null = 未命中（是否算定论由 definitiveAbsence 决定） */
  meta: ProblemMeta | null;
  /** 上游标签经净化后的结果（null / 空数组 = 上游这道题没有可用标签） */
  tagsFromUpstream: string[] | null;
  /** meta 为 null 时可否当定论（单次响应即完整公开题库的平台，见 ABSENCE_IS_DEFINITIVE） */
  definitiveAbsence: boolean;
  /** 本轮统一时刻（ISO） */
  checkedAt: string;
  /** 写库之后的行：用来判断哪些维度已经补齐（manual 保护的行不会误判成「已补齐」） */
  after: Pick<GapRow, 'difficulty' | 'native_difficulty' | 'tags'>;
}

/**
 * 本轮之后该行的负缓存应该长什么样。
 *
 * 三条规则：
 * 1. **只记查过且给不出的**：meta 有值但难度/标签为空 → 记；未命中且来源不是完整题库 → 不记；
 *    请求失败 → 调用方根本不会走到这里。宁可下轮多问一次，也不把「暂时没翻到」锁 30 天。
 * 2. **补齐即退出**：这次上游给了难度（或加了标签），该维度立刻从集合里删掉 ——
 *    CF 赛后补评级、平台后来给题加标签都靠这条生效，不必等 TTL。
 * 3. **TTL 只随新判定顺延**：本轮没有新增判定时保留旧时刻，避免一个维度靠另一个维度的
 *    活动无限续命（那样「过期重查」永远不会发生）。
 */
export function nextGapState(i: GapInput): {
  state: string | null;
  checkedAt: string | null;
  changed: boolean;
} {
  if (NO_GAP_CACHE.has(i.platform)) {
    return { state: i.oldState, checkedAt: i.oldCheckedAt, changed: false };
  }
  const before = parseGapState(i.oldState);
  const set = new Set(before);
  if (i.meta !== null) {
    // 难度与原生原文一起记：上游给不出评级时两者必然同时无解（同一个 raw 值映射出来的）
    if (i.meta.difficulty === null && i.meta.nativeDifficulty === null) set.add('difficulty');
    if (i.tagsFromUpstream === null || i.tagsFromUpstream.length === 0) set.add('tags');
  } else if (i.definitiveAbsence) {
    set.add('difficulty');
  }
  if (i.after.difficulty !== null && i.after.native_difficulty !== null) set.delete('difficulty');
  if (i.after.tags !== '[]') set.delete('tags');

  const state = formatGapState(set);
  const added = [...set].some((d) => !before.has(d));
  const checkedAt = state === null ? null : added ? i.checkedAt : i.oldCheckedAt;
  return { state, checkedAt, changed: state !== i.oldState || checkedAt !== i.oldCheckedAt };
}
