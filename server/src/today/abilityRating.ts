import type { PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';

/**
 * 赛事中心的 rating 记录 → 能力值的外部锚点。
 *
 * 为什么要有它：主模型只看「本地提交里 AC 了什么难度的题」，于是补题、看题解、
 * 小样本、偶然做出一道超纲题都能把估算带偏；而平台结算出来的 rated 比赛成绩是
 * 抗刷量的实力信号（用户没法靠多交 200 发 WA 把 CF rating 刷上去）。
 *
 * **各平台分别算锚点，取换算后最高的那个**（2026-10 用户决定）：备赛的人通常不会
 * 每个平台都持续参赛——CF 号三年没动、最近一直在打 AtCoder/牛客 是常态，
 * 而过期的那个平台分会把锚点往旧水平拖。所以：
 * - 每个平台各自算「近若干场的时效加权均值」，换算到能力值所在的 CF 难度分标尺；
 * - 只有**够新够场**（时效加权有效场数 ≥ RATING_ANCHOR_MIN_EFFECTIVE_RECORDS）的平台才有资格参选；
 * - 参选者里取最高，混合权重按胜出平台自己的有效场数给（单场只有 15%，不会一票独裁）。
 *
 * 取最高会专门挑走被高估的那一侧，所以换算不确定的平台要打折（`haircut`）：
 * CF 原生同标尺、零折扣；其余平台的换算必须带实测依据，且按实测误差留出保守余量。
 * 拿不到依据的平台**不进锚点**，只通过 `rating_change` 提供方向修正——分差在任何
 * Elo 体系里都表示「这场打过了/没打过平台对你的预期」，是跨标尺可用的信号。
 * 洛谷、计蒜客的参赛记录本来就没有 rating（恒为 NULL，见 participationSources.ts）。
 */

const DAY_MS = 86_400_000;

/**
 * 平台参赛者 rating → 能力值（CF 难度分）标尺的换算表。
 * 表里没有的平台 = 没有可信换算依据，只做分差趋势；新增平台时把实测依据和样本量写进 basis。
 */
interface RatingScale {
  toCf: (native: number) => number;
  /** 换算误差的保守折扣（分）：防止「换算后刚好高一点点」的外平台分劫走锚点 */
  haircut: number;
  /** 依据（进 AI 证据与 UI 说明，便于用户核对口径） */
  basis: string;
}

/** AtCoder 换算结果两端钳位（= 实测样本覆盖到的 CF 跨度，不外推） */
export const ATCODER_CF_FLOOR = 1400;
export const ATCODER_CF_CEIL = 2200;
/**
 * AtCoder 参赛者 rating → CF 标尺。实测于 2026-10-08：
 * 取 CF 近 4 场 Div.2 榜单参赛者（`contest.standings` + `user.info` 拿 CF rating 与国家），
 * 筛 AtCoder 用户密集的国家，逐个查 `atcoder.jp/users/{h}/history/json` 的最近 rated 场次新分；
 * 只保留「两边都还在打」的账号（AtCoder rated ≥ 10 场且近一年 ≥ 3 场）——单面退役账号
 * （CF 在涨、AT 分停在三四年前后）是这类配对最大的噪声源，也是本仓库真正要防的偏差。
 * n=26、Pearson r=0.807，线性拟合 **CF ≈ 0.5×AT + 1050**；偏移(CF−AT)中位 +406、四分位 +147..+525。
 * 两端钳到样本实测跨度：AT < 1000 多半是「不怎么打 AtCoder」的地板值（实测 AT<1000 的三人
 * CF 中位恰好 1400），AT 2200 以上则没有观测支撑。
 * haircut 取四分位距的一半（±190 的个人误差）：「取最高」这条规则只会反复挑走被高估的那一侧。
 */
const atcoderToCf = (native: number): number =>
  Math.min(ATCODER_CF_CEIL, Math.max(ATCODER_CF_FLOOR, Math.round(native * 0.5 + 1050)));

export const RATING_SCALES: Readonly<Partial<Record<PlatformId, RatingScale>>> = {
  codeforces: {
    toCf: (r) => r,
    haircut: 0,
    basis: '与能力值同标尺（CF rating 即统一难度分），零换算',
  },
  atcoder: {
    toCf: atcoderToCf,
    haircut: 150,
    basis: '实测换算（2026-10-08，n=26 两边都活跃的同名账号）：CF≈0.5×AT+1050，两端钳到实测跨度，个人误差 ±190 已在取最高前打折 150',
  },
  // 牛客不做绝对锚点：没有可批量配对的公开 rating 对照来源（参赛记录见
  // fetchNowcoderJoinedContests，且仅 ratingStatus=FINISHED 才给分），未实测就不换算；
  // 它的 rating_change 仍进分差趋势。洛谷、计蒜客的参赛记录本身没有 rating。
};

/** 每个平台锚点的取样场次上限：更旧的场次本就按时效衰减，截断只为防极端长历史拖住均值 */
export const RATING_ANCHOR_MAX_RECORDS = 12;
/**
 * rating 证据的时效半衰期（天）。一个旋钮同时管两件事：
 * - 均值里各场次的权重（越近的场次越能代表现在）
 * - 有效场数（衰减后还剩几场）→ 参选资格与混合权重
 */
export const RATING_HALF_LIFE_DAYS = 180;
/** 参选「取最高」所需的最低有效场数：约等于「至少有一场还在半衰期内的比赛」 */
export const RATING_ANCHOR_MIN_EFFECTIVE_RECORDS = 1;
/** 满置信所需的有效场数（3 场新赛 = 满权重） */
export const RATING_FULL_CONFIDENCE_RECORDS = 3;
/**
 * 锚点在目标值里的最大混合权重：rating 再漂亮也只占 target 的 45%，
 * 主体仍是解题证据——避免「很久没训练但 rating 高」压掉当前真实状态。
 */
export const RATING_ANCHOR_MAX_WEIGHT = 0.45;
/** 分差趋势：每个未胜出平台各取最近 N 场的 rating_change */
export const RATING_TREND_MAX_RECORDS = 8;
/** 少于这么多场分差样本就不做趋势修正（单场涨落是噪声） */
export const RATING_TREND_MIN_RECORDS = 3;
/** 平均分会差 → 修正的增益：每场平均涨 25 分 ≈ +75，掉 25 分 ≈ −75 */
export const RATING_TREND_GAIN = 3;
/** 趋势修正上下限（绝对值） */
export const RATING_TREND_CAP = 80;

const PLATFORM_LABEL: Readonly<Partial<Record<PlatformId, string>>> = {
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  nowcoder: '牛客',
};

/** 一条平台侧 rated 参赛记录（participated_contests 的投影） */
export interface RatedContestRecord {
  platform: PlatformId;
  /** 记录属于哪个账号：同平台多账号要分开参选，否则强号会被弱号平均掉 */
  account: string;
  contestId: string;
  name: string;
  /** 结算时间（end_ms，缺失回退 start_ms）；null = 无法定时效，不进锚点/趋势 */
  atMs: number | null;
  rank: number | null;
  rating: number;
  ratingChange: number | null;
}

/** 单个平台的锚点结论 */
export interface PlatformAnchor {
  platform: PlatformId;
  label: string;
  /** 该平台带结算时间的 rated 场次数 */
  samples: number;
  /** 时效加权后的有效场数（决定参选资格与权重） */
  effective: number;
  /** 平台原分（时效加权均值） */
  raw: number;
  /** 换算到 CF 标尺后的分值 */
  converted: number;
  /** converted − haircut，真正参与「取最高」的值 */
  adjusted: number;
  /** 该平台单独作为锚点时的混合权重 */
  weight: number;
  /** 换算依据 */
  basis: string;
}

/** rating 证据的模型结论 */
export interface RatingEvidence {
  /** 有资格参选的平台锚点，按 adjusted 降序（第 0 个即胜出的最高分） */
  anchors: PlatformAnchor[];
  /** 胜出的锚点分值（已打折）；无合格锚点 = null */
  anchor: number | null;
  /** 胜出平台标签；无合格锚点 = null */
  anchorPlatform: string | null;
  /** 胜出平台的原分（换算前），UI 用来显示「AtCoder 2000 → 1980」 */
  anchorRaw: number | null;
  /** 胜出平台的 rated 场次数 */
  anchorSamples: number;
  /** 胜出锚点的混合权重 0–RATING_ANCHOR_MAX_WEIGHT */
  anchorWeight: number;
  /** 未胜出平台近若干场分差的方向性修正（已含时效淡出，±RATING_TREND_CAP 内） */
  trendAdj: number;
  /** 参与趋势估算的场次数 */
  trendSamples: number;
  /** 库内带 rating 的参赛记录总数（缓慢校准的新证据水位线） */
  ratedRecords: number;
}

/** 时效权重：半衰期指数衰减（与 ability.ts 的 recencyWeight 同式，此处独立实现避免相互 import 成环） */
function ratingDecay(ageMs: number): number {
  return Math.pow(0.5, Math.max(0, ageMs) / (RATING_HALF_LIFE_DAYS * DAY_MS));
}

/**
 * 库内全部带 rating 的参赛记录（**只读库，不打网络**），按结算时间新→旧。
 * 同平台多账号会并入同一份历史：这是「你这个人」打过并结算的所有场次，
 * 与能力值不按账号作用域的既有决定同源（见 ability.ts 的 computeAbilityDetail 注释）。
 */
export function collectRatedContests(db: Db, userId: number): RatedContestRecord[] {
  const rows = db
    .prepare(
      `SELECT platform, account, contest_id, name, start_ms, end_ms, contest_rank, rating, rating_change
         FROM participated_contests
        WHERE user_id = ? AND rating IS NOT NULL AND rating > 0`,
    )
    .all(userId) as Array<{
    platform: string;
    account: string;
    contest_id: string;
    name: string | null;
    start_ms: number | null;
    end_ms: number | null;
    contest_rank: number | null;
    rating: number;
    rating_change: number | null;
  }>;
  return rows
    .map((r) => ({
      platform: r.platform as PlatformId,
      account: r.account,
      contestId: r.contest_id,
      name: r.name ?? `${r.platform} ${r.contest_id}`,
      atMs: r.end_ms ?? r.start_ms,
      rank: r.contest_rank,
      rating: r.rating,
      ratingChange: r.rating_change,
    }))
    .sort((a, b) => (b.atMs ?? -1) - (a.atMs ?? -1));
}

/** 带 rating 的参赛记录数（新证据水位线用，比整份投影便宜） */
export function countRatedContests(db: Db, userId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM participated_contests WHERE user_id = ? AND rating IS NOT NULL AND rating > 0')
    .get(userId) as { c: number };
  return row.c;
}

/** 一个「平台 × 账号」的历史分组（同平台多账号各算各的锚点，见 RatedContestRecord.account） */
interface RatingGroup {
  key: string;
  platform: PlatformId;
  account: string;
  label: string;
  records: RatedContestRecord[];
}

function groupByAccount(records: ReadonlyArray<RatedContestRecord>): RatingGroup[] {
  const map = new Map<string, RatingGroup>();
  for (const r of records) {
    const key = `${r.platform}\u0000${r.account}`;
    const g = map.get(key);
    if (g) g.records.push(r);
    else map.set(key, { key, platform: r.platform, account: r.account, label: '', records: [r] });
  }
  const groups = [...map.values()];
  // 同平台有多个账号时才在标签里带上账号，单账号用户不加噪声
  const perPlatform = new Map<PlatformId, number>();
  for (const g of groups) perPlatform.set(g.platform, (perPlatform.get(g.platform) ?? 0) + 1);
  for (const g of groups) {
    const base = PLATFORM_LABEL[g.platform] ?? g.platform;
    g.label = (perPlatform.get(g.platform) ?? 0) > 1 && g.account ? `${base}（${g.account}）` : base;
  }
  return groups;
}

/** 单组锚点：近若干场的时效加权均值 → 换算 → 打折 */
function groupAnchor(
  group: RatingGroup,
  scale: RatingScale,
  nowMs: number,
): PlatformAnchor | null {
  const eligible = group.records.filter((r) => r.atMs !== null);
  if (eligible.length === 0) return null;
  let sumW = 0;
  let sumWR = 0;
  for (const r of eligible.slice(0, RATING_ANCHOR_MAX_RECORDS)) {
    const w = ratingDecay(nowMs - (r.atMs as number));
    sumW += w;
    sumWR += w * r.rating;
  }
  // 全是远古场次时权重会下溢到 0：宁可不锚，也不用一堆衰减到零的权重除以零
  if (sumW <= 1e-9) return null;
  const raw = sumWR / sumW;
  const converted = scale.toCf(raw);
  return {
    platform: group.platform,
    label: group.label,
    samples: eligible.length,
    effective: sumW,
    raw,
    converted,
    adjusted: converted - scale.haircut,
    weight: RATING_ANCHOR_MAX_WEIGHT * Math.min(1, sumW / RATING_FULL_CONFIDENCE_RECORDS),
    basis: scale.basis,
  };
}

/**
 * 分差趋势：未胜出分组最近若干场的分会差（胜者的水平已经进了锚点，不再重复计方向）。
 * 先按分组各自取样本再对分组求均值——否则场次多的那个账号会挤掉另一个，
 * 而各平台的分差尺度并不相同。
 */
function trendEvidence(
  groups: ReadonlyArray<RatingGroup>,
  excludeKey: string | null,
  nowMs: number,
): Pick<RatingEvidence, 'trendAdj' | 'trendSamples'> {
  const means: number[] = [];
  let latestMs: number | null = null;
  let used = 0;
  for (const group of groups) {
    if (group.key === excludeKey) continue;
    const changes: number[] = [];
    for (const r of group.records) {
      if (changes.length >= RATING_TREND_MAX_RECORDS) break;
      if (r.ratingChange === null || r.atMs === null) continue;
      changes.push(r.ratingChange);
      if (latestMs === null || r.atMs > latestMs) latestMs = r.atMs;
    }
    if (changes.length === 0) continue;
    means.push(changes.reduce((a, b) => a + b, 0) / changes.length);
    used += changes.length;
  }
  if (used < RATING_TREND_MIN_RECORDS || latestMs === null) return { trendAdj: 0, trendSamples: used };
  const meanChange = means.reduce((a, b) => a + b, 0) / means.length;
  const capped = Math.max(-RATING_TREND_CAP, Math.min(RATING_TREND_CAP, Math.round(meanChange * RATING_TREND_GAIN)));
  // 很久没打比赛 → 趋势也是旧的，同样淡出
  return { trendAdj: Math.round(capped * ratingDecay(nowMs - latestMs)), trendSamples: used };
}

export function ratingEvidence(
  records: ReadonlyArray<RatedContestRecord>,
  now: Date = new Date(),
): RatingEvidence {
  if (records.length === 0) {
    return {
      anchors: [],
      anchor: null,
      anchorPlatform: null,
      anchorRaw: null,
      anchorSamples: 0,
      anchorWeight: 0,
      trendAdj: 0,
      trendSamples: 0,
      ratedRecords: 0,
    };
  }
  const nowMs = now.getTime();
  const groups = groupByAccount(records);
  const qualified: Array<{ key: string; anchor: PlatformAnchor }> = [];
  for (const group of groups) {
    const scale = RATING_SCALES[group.platform];
    if (!scale) continue;
    const a = groupAnchor(group, scale, nowMs);
    if (a !== null && a.effective >= RATING_ANCHOR_MIN_EFFECTIVE_RECORDS) qualified.push({ key: group.key, anchor: a });
  }
  // 换算后取最高：谁最近打得最好、且样本够新，就用谁
  qualified.sort((x, y) => y.anchor.adjusted - x.anchor.adjusted);
  const winner = qualified[0] ?? null;
  const trend = trendEvidence(groups, winner?.key ?? null, nowMs);
  const w = winner?.anchor ?? null;
  return {
    anchors: qualified.map((q) => q.anchor),
    anchor: w?.adjusted ?? null,
    anchorPlatform: w?.label ?? null,
    anchorRaw: w === null ? null : Math.round(w.raw),
    anchorSamples: w?.samples ?? 0,
    anchorWeight: w?.weight ?? 0,
    ...trend,
    ratedRecords: records.length,
  };
}

const ymd = (ms: number | null): string => (ms === null ? '?' : new Date(ms).toISOString().slice(0, 10));
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n}`;

/** rating 证据段（注入 AI 助手）：逐平台锚点 + 取最高的那个 + 趋势 + 逐场明细 */
export function renderRatingEvidence(
  records: ReadonlyArray<RatedContestRecord>,
  ev: RatingEvidence,
): string[] {
  const L: string[] = ['### 赛事中心 rating 记录'];
  if (records.length === 0) {
    L.push(
      '- 库内暂无带 rating 的参赛记录（同步「赛事中心 → 我参加的」后进入模型：CF user.rating / AtCoder history / 牛客参赛历史有 rating，洛谷、计蒜客没有）',
    );
    return L;
  }
  if (ev.anchors.length === 0) {
    L.push('- rating 锚点：没有够新够场的可换算平台记录（只有换算有实测依据的平台才做绝对锚点，且需时效加权有效场数 ≥ 1）');
  } else {
    L.push(
      `- rating 锚点（各平台分别算近期时效加权均值、换算到 CF 标尺后**取最高**）：${ev.anchors
        .map((a, i) => {
          const conv = Math.round(a.adjusted) === Math.round(a.raw) ? '' : `原分 ${Math.round(a.raw)}→`;
          return `${i === 0 ? '★' : ''}${a.label} ${conv}${Math.round(a.adjusted)}（${a.samples} 场、有效 ${a.effective.toFixed(
            1,
          )} 场、权重 ${Math.round(a.weight * 100)}%）`;
        })
        .join('；')}，★ 为胜出项`,
    );
    L.push(`- 胜出锚点的换算依据：${ev.anchors[0].basis}；打折（haircut）是为抵消「取最高」只会挑高估一侧的偏差`);
  }
  L.push(
    ev.trendSamples === 0
      ? '- 分差趋势：其余平台样本不足（少于 3 场带分差的 rated 场次），不修正'
      : `- 分差趋势：未胜出平台近 ${ev.trendSamples} 场给出 ${signed(ev.trendAdj)}（平均分会差 ×${RATING_TREND_GAIN}，±${RATING_TREND_CAP} 封顶，再按时效淡出）`,
  );
  L.push(
    `- 最近 rated 场次（新→旧）：${records
      .slice(0, 8)
      .map((r) => {
        const change = r.ratingChange === null ? '' : `(${signed(r.ratingChange)})`;
        const rank = r.rank === null ? '' : ` 第${r.rank}名`;
        return `${PLATFORM_LABEL[r.platform] ?? r.platform} ${ymd(r.atMs)} ${r.rating}${change}${rank}`;
      })
      .join('　')}`,
  );
  return L;
}
