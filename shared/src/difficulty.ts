// 平台难度 → Codeforces rating 统一标尺的**唯一真源**。
// 每张表都在注释里标注实测依据与样本量（详见 docs/superpowers/specs/2026-09-15-...-design.md §2）。
// 平台改档（如洛谷 2026-06 难度体系调整）时只改本文件。
import type { PlatformId } from './index.ts';

/** CF rating 取值域：CF 题库实际范围（800–3500，步长 100） */
export const CF_RATING_MIN = 800;
export const CF_RATING_MAX = 3500;

export type DifficultyScale =
  | 'cf-rating'
  | 'luogu-2026-06'
  | 'atcoder-kenkoooo-irt'
  | 'nowcoder-score'
  | 'leetcode-tier'
  | 'jisuanke-level-8'
  | 'hydro-1-10'
  | 'icpc-tier'
  | 'none';

export interface DifficultyParse {
  rating: number | null;
  label: string | null;
  scale: DifficultyScale;
  /** 平台原生难度原文（去空白）；未知为 null */
  native: string | null;
}

function clampRating(n: number): number {
  return Math.min(CF_RATING_MAX, Math.max(CF_RATING_MIN, Math.round(n)));
}

/** 洛谷官方难度枚举（`/_lfe/config` → `ProblemDifficulty`，2026-06 版）：0=暂无评定，1..8 有名 */
export const LUOGU_LEVEL_NAMES: Readonly<Record<number, string>> = {
  1: '入门', 2: '普及−', 3: '普及', 4: '普及+/提高−',
  5: '提高', 6: '提高+/省选−', 7: '省选/NOI−', 8: 'NOI/NOI+/CTS',
};

/**
 * 洛谷档位 → CF rating。
 * 实测：洛谷 `problem/list?type=CF`（10984 道 CF 镜像题）× CF API `problemset.problems`，737 对配对，
 * 各档中位数 = 800/1000/1500/1800/2200/2400/2600/3400；与官方公布区间自洽
 * （青 提高 ≈ CF2000-2400、蓝 ≈ 2300-2700、紫 ≈ 2700-3100）。
 * 注意：洛谷官方称其难度定义为「临时」，且黑题拆分已在计划中 → 不得把 8 写死为档数上限以外的假设。
 */
export const LUOGU_LEVEL_TO_RATING: Readonly<Record<number, number>> = {
  1: 800, 2: 1000, 3: 1500, 4: 1800, 5: 2200, 6: 2400, 7: 2600, 8: 3400,
};

/** 计蒜客 8 档（app.js i18n `difficultyType`；档位名与洛谷同源，英文为 CF 称号） */
export const JISUANKE_LEVEL_NAMES: Readonly<Record<number, string>> = {
  1: '入门', 2: '普及−', 3: '普及', 4: '普及+/提高−',
  5: '提高', 6: '提高+', 7: '省选', 8: '国赛',
};
/** 计蒜客档位名与洛谷一一对应，故直接复用同一实测表（通过率交叉校验一致，见 spec §2.4） */
export const JISUANKE_LEVEL_TO_RATING: Readonly<Record<number, number>> = LUOGU_LEVEL_TO_RATING;

/**
 * AtCoder：社区模型 kenkoooo `problem-models.json` 的 IRT difficulty → CF rating。
 * 实测桥（349 对）：洛谷 `type=AT` 镜像题（8098 题）× kenkoooo，各洛谷档的 kenkoooo 中位数与其
 * CF 中位数对齐 → 锚点表。**不是加常数**：低段差约 +550、中段约 +100、高段趋于相等。
 */
export const ATCODER_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [-386, 800], [451, 1000], [973, 1500], [1545, 1800],
  [2107, 2200], [2325, 2400], [2653, 2600], [3392, 3400],
];

export function atcoderThetaToRating(theta: number): number {
  if (!Number.isFinite(theta)) return CF_RATING_MIN;
  const first = ATCODER_ANCHORS[0];
  const last = ATCODER_ANCHORS[ATCODER_ANCHORS.length - 1];
  if (theta <= first[0]) return clampRating(first[1]);
  // 超出最后一个锚点：沿最后一段斜率外推后再钳到 CF 上限（spec §2.3「超出两端钳到 800/3500」）。
  // 不能直接返回 last[1]（=3400）——那样 θ>3392 的题会全停在 3400，永远取不到 CF 上限档。
  if (theta >= last[0]) {
    const [x0, y0] = ATCODER_ANCHORS[ATCODER_ANCHORS.length - 2];
    const t = (theta - x0) / (last[0] - x0);
    return clampRating(y0 + t * (last[1] - y0));
  }
  for (let i = 1; i < ATCODER_ANCHORS.length; i += 1) {
    const [x0, y0] = ATCODER_ANCHORS[i - 1];
    const [x1, y1] = ATCODER_ANCHORS[i];
    if (theta <= x1) {
      const t = (theta - x0) / (x1 - x0);
      return clampRating(y0 + t * (y1 - y0));
    }
  }
  return clampRating(last[1]);
}

/** 力扣三级难度 → CF rating（面试导向，启发式；无官方对照表） */
export const LEETCODE_TIER_TO_RATING: Readonly<Record<string, number>> = {
  easy: 1000, medium: 1500, hard: 2100,
};

/**
 * ICPC/CCPC 公开榜单档位（QOJ 等 ICPC 题集**平台本身没有难度字段**时的推导来源）。
 *
 * 档位由公开榜单的**过题队伍占比**判定（与 OJ_Insight 同口径；参考项目
 * src-tauri/src/xcpc/rating.rs 的 rating_tier：≤10% gold、≤30% silver、≤60% bronze、其余 iron）：
 * 记为 `accepted / totalTeams`，totalTeams 取榜单总行数（含一题未过的队伍）。
 *
 * 注意这是**粗粒度**信号：档位只有 4 档，且网络赛队伍基数大、题目数多，占比会被压缩。
 * 因此档位 → CF rating 只是**近似换算（±300–400）**，用于训练推荐与弱项分档，不作为精确评级；
 * 原生档位与原始占比一并落库（`gold:704/2535`），公开榜单口径变化时可重算，不需要重新抓取。
 */
export const ICPC_TIERS = ['iron', 'bronze', 'silver', 'gold'] as const;
export type IcpcTier = (typeof ICPC_TIERS)[number];

/** 档位 → CF rating 近似值（粗粒度启发式，见上；iron 对齐 CF 入门段，gold 对齐区域赛难题段） */
export const ICPC_TIER_TO_RATING: Readonly<Record<IcpcTier, number>> = {
  iron: 1000, bronze: 1500, silver: 2000, gold: 2600,
};

/** 档位中文名（展示用；括号内为直觉含义，避免与奖牌混淆） */
export const ICPC_TIER_LABELS: Readonly<Record<IcpcTier, string>> = {
  iron: '铁（易）', bronze: '铜', silver: '银', gold: '金（难）',
};

/**
 * 解析 ICPC 档位原文：接受 `gold` 与带占比的 `gold:704/2535`（原生落库用后者，便于重算）。
 * 未知/非法 → null（不猜）。
 */
export function parseIcpcTier(raw: unknown): IcpcTier | null {
  if (typeof raw !== 'string') return null;
  const head = raw.trim().toLowerCase().split(':')[0]?.trim() ?? '';
  return (ICPC_TIERS as readonly string[]).includes(head) ? (head as IcpcTier) : null;
}

/** 代码源（Hydro）1-10 难度 → CF rating：站内相对难度（AC 率 × 提交量），启发式 ±200 */
export const HYDRO_LEVEL_TO_RATING: Readonly<Record<number, number>> = {
  1: 800, 2: 900, 3: 1000, 4: 1200, 5: 1400,
  6: 1600, 7: 1800, 8: 2000, 9: 2200, 10: 2400,
};

/** 牛客难度分（平台自评、与 CF 同量纲；实测 200–3700，新题可能为空） */
export function nowcoderScoreToRating(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return clampRating(raw);
}

/** 牛客难度分取值域：实测 200..3400（题库列表页 300 行样本），保留到 4000 以容纳站内更高分 */
export const NOWCODER_SCORE_MIN = 200;
export const NOWCODER_SCORE_MAX = 4000;

/**
 * 牛客难度分**原文校验**（题库列表页与搜索结果页是同一列，两个读取方必须共用这一条规则，
 * 否则同一行会对一方「未知」、对另一方「有效」）。
 * 只接受 200..4000 内的纯数字整数；空值、非数字、越界值一律 → null（未知一律 null，不猜）。
 *
 * 历史缺陷（2026-09-27 实测纠正）：本函数曾额外要求「100 的倍数」，依据是题库列表页
 * `?queryType=all&orderById=true` 前 300 行（最新题）恒为整百分值。但该顺序只覆盖新题；
 * 逐题实测**搜索结果页**（老题）会给出非整百分值，且这些值确实位于难度列：
 * NC16640《[NOIP2007]纪念品分组》= 1049、NC22014 = 623、NC22158 = 726、NC22231 = 876、
 * NC24739 = 972（同行通过人数列分别是 5593 / 24207 / 23365 / 7486 / 1597，均不等于该值）。
 * 库内也留有 9 行历史非整百分值（旧版本接受过），说明「恒为 100 的倍数」是被证伪的断言，
 * 而它把真值判成未知 —— 这正是「牛客约 20% 题目无难度」中属于我们自己丢的那一部分。
 * 因此改为只做**值域**校验；「防止读到通过数列」改由解析层的**结构校验**负责
 * （见 adapters/problemBank.ts 的 parseNcRowCells：题目锚点 + 难度单元格 + 操作锚点）。
 */
export function parseNowcoderScore(raw: unknown): number | null {
  const text =
    typeof raw === 'number' && Number.isFinite(raw)
      ? String(raw)
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (n < NOWCODER_SCORE_MIN || n > NOWCODER_SCORE_MAX) return null;
  return n;
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseNativeDifficulty(platform: PlatformId, raw: unknown): DifficultyParse {
  const nativeText =
    raw === null || raw === undefined || raw === '' ? null : String(raw).trim() === '' ? null : String(raw).trim();
  const none: DifficultyParse = { rating: null, label: null, scale: 'none', native: nativeText };

  switch (platform) {
    case 'codeforces': {
      const n = toNumber(raw);
      return { rating: n === null ? null : clampRating(n), label: n === null ? null : String(n), scale: 'cf-rating', native: nativeText };
    }
    case 'luogu': {
      const n = toNumber(raw);
      if (n === null || n <= 0) return { rating: null, label: null, scale: 'luogu-2026-06', native: nativeText };
      const rating = LUOGU_LEVEL_TO_RATING[n] ?? null;
      return { rating, label: LUOGU_LEVEL_NAMES[n] ?? null, scale: 'luogu-2026-06', native: nativeText };
    }
    case 'jisuanke': {
      // 题库接口返回 `levelN` 字符串；整数档位一并接受（渠道差异与旧调用点兼容，属健壮性兜底）
      const s = typeof raw === 'number' ? '' : String(raw ?? '').trim();
      const level =
        typeof raw === 'number' && Number.isInteger(raw) ? raw : Number(/^level(\d+)$/i.exec(s)?.[1] ?? NaN);
      const rating = Number.isInteger(level) ? JISUANKE_LEVEL_TO_RATING[level] ?? null : null;
      return {
        rating,
        label: Number.isInteger(level) ? JISUANKE_LEVEL_NAMES[level] ?? null : null,
        scale: 'jisuanke-level-8',
        native: nativeText,
      };
    }
    case 'atcoder': {
      const n = toNumber(raw);
      return {
        rating: n === null ? null : atcoderThetaToRating(n),
        label: n === null ? null : String(Math.round(n)),
        scale: 'atcoder-kenkoooo-irt',
        native: nativeText,
      };
    }
    case 'nowcoder': {
      const n = toNumber(raw);
      const rating = n === null ? null : nowcoderScoreToRating(n);
      return { rating, label: n === null ? null : String(n), scale: 'nowcoder-score', native: nativeText };
    }
    case 'leetcode': {
      const key = String(raw ?? '').trim().toLowerCase();
      const rating = LEETCODE_TIER_TO_RATING[key] ?? null;
      const zh = key === 'easy' ? '简单' : key === 'medium' ? '中等' : key === 'hard' ? '困难' : null;
      return { rating, label: zh, scale: 'leetcode-tier', native: nativeText };
    }
    case 'daimayuan': {
      const n = toNumber(raw);
      // Hydro 难度域就是 1-10（站点 slider 上限 10）：越界值（>10，含 10.5 这类小数）
      // 不钳到第 10 档，按项目规则「未知一律 null，不猜」处理。
      if (n === null || n <= 0 || n > 10) return { rating: null, label: null, scale: 'hydro-1-10', native: nativeText };
      const level = Math.round(n);
      return {
        rating: HYDRO_LEVEL_TO_RATING[level] ?? null,
        label: `${level}/10`,
        scale: 'hydro-1-10',
        native: nativeText,
      };
    }
    case 'qoj': {
      // QOJ（UOJ 系数据模型）**自身不提供难度字段**；这里只接受由公开榜单推导出的
      // ICPC/CCPC 档位原文（`gold` / `gold:704/2535`，见 ICPC_TIERS 注释）。
      // 没有公开榜单数据时保持「未知」——难度恒为 null、标度 none，绝不臆造。
      const tier = parseIcpcTier(raw);
      if (tier === null) return none;
      return {
        rating: ICPC_TIER_TO_RATING[tier],
        label: ICPC_TIER_LABELS[tier],
        scale: 'icpc-tier',
        native: nativeText,
      };
    }
    default:
      return none;
  }
}

export function toCfRating(platform: PlatformId, raw: unknown): number | null {
  return parseNativeDifficulty(platform, raw).rating;
}

export function nativeDifficultyLabel(platform: PlatformId, raw: unknown): string | null {
  return parseNativeDifficulty(platform, raw).label;
}

/**
 * 适配器统一入口：一次给出「映射后的 CF rating + 原生原文 + 标度」。
 * 未知难度**不产出** `difficulty` 键（保持既有 semantics：缺失 = 未知，写库时落 NULL 且不覆盖旧值）。
 */
export function difficultyFields(
  platform: PlatformId,
  raw: unknown,
): { difficulty?: number; nativeDifficulty?: string; difficultyScale: DifficultyScale } {
  const parsed = parseNativeDifficulty(platform, raw);
  return {
    ...(parsed.rating !== null ? { difficulty: parsed.rating } : {}),
    ...(parsed.native !== null ? { nativeDifficulty: parsed.native } : {}),
    difficultyScale: parsed.scale,
  };
}

/** CF 称号（展示用；与 rating 分段一致） */
export function cfRatingTitle(rating: number): { en: string; zh: string } {
  const r = clampRating(rating);
  if (r < 1200) return { en: 'Newbie', zh: '新手' };
  if (r < 1400) return { en: 'Pupil', zh: '入门' };
  if (r < 1600) return { en: 'Specialist', zh: '熟练' };
  if (r < 1900) return { en: 'Expert', zh: '专家' };
  if (r < 2100) return { en: 'Candidate Master', zh: '候选大师' };
  if (r < 2300) return { en: 'Master', zh: '大师' };
  if (r < 2400) return { en: 'International Master', zh: '国际大师' };
  if (r < 2600) return { en: 'Grandmaster', zh: '宗师' };
  if (r < 3000) return { en: 'International Grandmaster', zh: '国际宗师' };
  return { en: 'Legendary Grandmaster', zh: '传奇宗师' };
}
