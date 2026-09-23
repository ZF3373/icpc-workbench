import type { Db } from '../db/index.ts';
import { estimateLevel } from './select.ts';
import type { AbilityLevelDetail } from '../../../shared/src/index.ts';
import type { PracticeSummary } from '../analysis/summary.ts';

/** AI 能力值调整的持久化结构（settings 表 key = ability.override） */
export interface AbilityOverride {
  level: number;
  reason?: string;
  updatedAt: string;
  /** 调整依据概述（AI 给出的理由，供用户复核） */
  basis?: string;
}

export const ABILITY_OVERRIDE_KEY = 'ability.override';

/** 缓慢校准状态（settings 表 key = ability.state）。level 为未取整浮点，发布时才 round 到百 */
export interface AbilityState {
  level: number;
  /** 上次校准时的全历史提交总数（排除 SKIPPED，含失败）：任何新练习都允许重新校准 */
  totalAttempts: number;
  updatedAt: string;
}

export const ABILITY_STATE_KEY = 'ability.state';

/** 读取 AI 调整的能力值（无 / 解析失败返回 null，不影响计算值） */
export function getAbilityOverride(db: Db): AbilityOverride | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ABILITY_OVERRIDE_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as AbilityOverride;
    return Number.isFinite(v?.level) && v.level > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 保存 / 清除（level 传 null 时清除）AI 能力值调整 */
export function setAbilityOverride(db: Db, override: AbilityOverride | null): void {
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (override) up.run(ABILITY_OVERRIDE_KEY, JSON.stringify(override));
  else del.run(ABILITY_OVERRIDE_KEY);
}

/** 读取缓慢校准状态（无 / 解析失败返回 null，触发升级引导路径） */
export function getAbilityState(db: Db): AbilityState | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ABILITY_STATE_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as AbilityState;
    return Number.isFinite(v?.level) && v.level > 0 && Number.isInteger(v?.totalAttempts) ? v : null;
  } catch {
    return null;
  }
}

export function saveAbilityState(db: Db, state: AbilityState): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(ABILITY_STATE_KEY, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// 加权解题证据模型
//
// 能力值不再是「近 60 天 AC 难度中位数」，而是：
//   1. 窗口内每道 AC 的题产生一条「解题证据」，按证据强度加权：
//      时效（半衰期平滑淡出）× 独立完成度（尝试次数 / 解题跨度 / 提交语境 / 卡点记录）
//      —— 赛后补题、拖了很多天的长磨题、看题解/视频讲解后才做出的题自动降权
//   2. 证据难度做加权中位数（高出未加权中位数 400+ 的离群样本再打五折）→ 难度基数
//   3. 同段难度（基数 ±200）的提交通过率做校准修正：高难度一发 AC 拉得上限，
//      低难度 AC 但失败成堆（通过率低）往下修
//   4. 有状态的缓慢校准：无新练习提交不动；有新证据时向目标值走夹紧的小步
//      （升 +80 / 降 −150 封顶，升慢、回调略快），训练后的能力值渐进爬升
// 全部权重集中在下方常量区，调整只改这里。
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** 时效半衰期占窗口的比例：60 天窗口 → 45 天半衰期，旧证据平滑淡出而非到期跳变 */
export const HALF_LIFE_RATIO = 0.75;
/** 尝试因子：每多 1 次尝试衰减 0.08，0.5 封底（一发入榜是满权重证据） */
export const ATTEMPT_DECAY = 0.08;
export const ATTEMPT_FLOOR = 0.5;
/** 解题跨度分档（首提交 → 首 AC）：同场（≤3h）满权重；拖天数的补题/长磨题逐档降权 */
export const SPAN_TIERS: ReadonlyArray<{ limitMs: number; factor: number }> = [
  { limitMs: 3 * HOUR_MS, factor: 1.0 },
  { limitMs: 1 * DAY_MS, factor: 0.85 },
  { limitMs: 3 * DAY_MS, factor: 0.7 },
  { limitMs: 14 * DAY_MS, factor: 0.55 },
  { limitMs: Number.POSITIVE_INFINITY, factor: 0.45 },
];
/** 语境因子：practice（赛后补题/题单练习）降权；contest/virtual 是当场发挥，满权重 */
export const CONTEXT_FACTORS: Readonly<Record<string, number>> = {
  contest: 1.0,
  virtual: 1.0,
  practice: 0.85,
};
/** 卡点因子：看题解/视频讲解后才做出来（cant_start/editorial）证据强度打折最狠 */
export const INTENT_FACTORS: Readonly<Record<string, number>> = {
  cant_start: 0.45,
  editorial: 0.45,
  wrong_approach: 0.7,
  implementation: 0.85,
  slight_bug: 0.95,
};
/** 单题质量权重下限 */
export const WEIGHT_FLOOR = 0.25;
/** 离群保护：难度高出未加权中位数 400 以上的样本，权重再减半（偶然题不抬基数） */
export const OUTLIER_MARGIN = 400;
export const OUTLIER_FACTOR = 0.5;
/** 窗口内样本下限：不足则回退全历史中位数 */
export const MIN_SAMPLES = 5;
/** 通过率校准：同段难度（基数 ±200）尝试 ≥8 次才生效；(r−0.5)×600，±150 封顶 */
export const ADJ_BAND = 200;
export const ADJ_MIN_ATTEMPTS = 8;
export const ADJ_SCALE = 600;
export const ADJ_CAP = 150;
/** 平滑校准：新证据越多单步越接近目标值；步长升 +80 / 降 −150 夹紧 */
export const STEP_EVIDENCE_DIVISOR = 6;
export const STEP_UP_CAP = 80;
export const STEP_DOWN_CAP = -150;
export const LEVEL_FLOOR = 800;
export const LEVEL_CEIL = 3500;

const clampLevel = (v: number): number => Math.min(LEVEL_CEIL, Math.max(LEVEL_FLOOR, v));
const round100 = (v: number): number => Math.round(v / 100) * 100;

/** 窗口内一道 AC 的题 = 一条解题证据（按题去重，取首次 AC） */
export interface SolveEvidence {
  problemId: number;
  difficulty: number;
  /** 全部提交次数（含 AC，排除 SKIPPED） */
  attempts: number;
  /** 首提交 → 首 AC 的毫秒跨度（同场解题接近 0；补题/长磨题以天计） */
  spanMs: number;
  /** 首 AC 距 now 的毫秒（时效衰减依据） */
  ageMs: number;
  /** 首 AC 提交的语境（contest/virtual/practice；平台不下发为 null） */
  context: string | null;
  /** 该题记录过的卡点中证据折损最重的一个 outcome（无记录为 null） */
  intent: string | null;
}

/** 时效权重：半衰期指数衰减（题龄 0 满权重，一个半衰期减半） */
export function recencyWeight(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / Math.max(1, halfLifeMs));
}

export function attemptFactor(attempts: number): number {
  return Math.max(ATTEMPT_FLOOR, 1 - ATTEMPT_DECAY * (Math.max(1, attempts) - 1));
}

export function spanFactor(spanMs: number): number {
  for (const tier of SPAN_TIERS) {
    if (spanMs <= tier.limitMs) return tier.factor;
  }
  return SPAN_TIERS[SPAN_TIERS.length - 1].factor;
}

export function contextFactor(context: string | null): number {
  if (context == null) return 1.0;
  return CONTEXT_FACTORS[context] ?? 1.0;
}

export function intentFactor(outcome: string | null): number {
  if (outcome == null) return 1.0;
  return INTENT_FACTORS[outcome] ?? 1.0;
}

/** 单条证据的质量权重 = 时效 × 尝试 × 跨度 × 语境 × 卡点，WEIGHT_FLOOR 封底 */
export function qualityWeight(ev: SolveEvidence, halfLifeMs: number): number {
  const w =
    recencyWeight(ev.ageMs, halfLifeMs) *
    attemptFactor(ev.attempts) *
    spanFactor(ev.spanMs) *
    contextFactor(ev.context) *
    intentFactor(ev.intent);
  return Math.max(WEIGHT_FLOOR, w);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 加权中位数：按难度升序累计权重，取权重过半处（空表 / 总权重 ≤0 返回 null） */
export function weightedMedian(items: ReadonlyArray<{ difficulty: number; weight: number }>): number | null {
  const sorted = [...items].sort((a, b) => a.difficulty - b.difficulty);
  const total = sorted.reduce((sum, x) => sum + x.weight, 0);
  if (sorted.length === 0 || total <= 0) return null;
  let acc = 0;
  for (const x of sorted) {
    acc += x.weight;
    if (acc >= total / 2) return x.difficulty;
  }
  return sorted[sorted.length - 1].difficulty;
}

/**
 * 难度基数：证据难度的加权中位数，含离群保护——
 * 先取未加权中位数 M0，难度 > M0 + OUTLIER_MARGIN 的样本权重再乘 OUTLIER_FACTOR，
 * 「偶然做出一道远超水平的题」无法把基数带偏（需求：偶然题权重不能太高）。
 */
export function weightedBase(evidences: ReadonlyArray<SolveEvidence>, halfLifeMs: number): number | null {
  if (evidences.length === 0) return null;
  const m0 = median(evidences.map((e) => e.difficulty));
  const items = evidences.map((e) => ({
    difficulty: e.difficulty,
    weight:
      qualityWeight(e, halfLifeMs) *
      (m0 !== null && e.difficulty > m0 + OUTLIER_MARGIN ? OUTLIER_FACTOR : 1),
  }));
  return weightedMedian(items);
}

/**
 * 通过率校准：同段难度提交通过率 r 的修正项。
 * attempts < ADJ_MIN_ATTEMPTS 时不校准（样本不足）；否则 (r − 0.5) × ADJ_SCALE，±ADJ_CAP 封顶。
 * 一发 AC 堆出来的高通过率上修；低难度 AC 但失败成堆（r 低）下修。
 */
export function performanceAdjustment(attempts: number, ac: number): number {
  if (attempts < ADJ_MIN_ATTEMPTS) return 0;
  const r = ac / attempts;
  return Math.max(-ADJ_CAP, Math.min(ADJ_CAP, Math.round((r - 0.5) * ADJ_SCALE)));
}

/**
 * 单步缓慢校准：prev → target。newEvidence（新练习提交数）≤0 时原地不动；
 * 否则步长 = (target − prev) × min(1, n / STEP_EVIDENCE_DIVISOR)，再夹到 [STEP_DOWN_CAP, STEP_UP_CAP]。
 * 升向慢（训练见效是渐进的）、降向略快（表现下滑要尽快校准回来）。
 */
export function calibrateStep(prev: number, target: number, newEvidence: number): number {
  if (newEvidence <= 0) return clampLevel(prev);
  const factor = Math.min(1, newEvidence / STEP_EVIDENCE_DIVISOR);
  const step = Math.max(STEP_DOWN_CAP, Math.min(STEP_UP_CAP, (target - prev) * factor));
  return clampLevel(prev + step);
}

/** 窗口内 AC（首次 AC 落在窗口内）且有难度的题 → 解题证据列表；windowDays 传 null = 全历史 */
export function collectSolveEvidence(
  db: Db,
  userId: number,
  windowDays: number | null,
  now: Date = new Date(),
): SolveEvidence[] {
  const since = windowDays == null ? null : new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT p.id AS problem_id, p.difficulty AS difficulty,
              fa.ac_at AS ac_at, MIN(s.submitted_at) AS first_at, COUNT(*) AS attempts,
              (SELECT s2.context FROM submissions s2
                WHERE s2.problem_id = p.id AND s2.user_id = ? AND s2.verdict = 'AC'
                ORDER BY s2.submitted_at ASC, s2.id ASC LIMIT 1) AS ac_context
         FROM submissions s
         JOIN problems p ON p.id = s.problem_id
         JOIN (SELECT problem_id, MIN(submitted_at) AS ac_at
                 FROM submissions
                WHERE user_id = ? AND verdict = 'AC'
                GROUP BY problem_id
               HAVING MIN(submitted_at) >= COALESCE(?, '0000-01-01')) fa
           ON fa.problem_id = p.id
        WHERE s.user_id = ? AND s.verdict != 'SKIPPED' AND p.difficulty IS NOT NULL
        GROUP BY p.id`,
    )
    .all(userId, userId, since, userId) as Array<{
    problem_id: number;
    difficulty: number;
    ac_at: string;
    first_at: string;
    attempts: number;
    ac_context: string | null;
  }>;
  const intents = worstIntentByProblem(db, userId);
  const nowMs = now.getTime();
  return rows
    .map((r) => ({
      problemId: r.problem_id,
      difficulty: r.difficulty,
      attempts: r.attempts,
      spanMs: Math.max(0, Date.parse(r.ac_at) - Date.parse(r.first_at)),
      ageMs: Math.max(0, nowMs - Date.parse(r.ac_at)),
      context: r.ac_context ?? null,
      intent: intents.get(r.problem_id) ?? null,
    }))
    .filter((e) => Number.isFinite(e.difficulty) && e.difficulty > 0);
}

/** 一题多卡点时取证据折损最重的那个（与 INTENT_FACTORS 同源，避免 SQL 里再写一份映射） */
function worstIntentByProblem(db: Db, userId: number): Map<number, string> {
  const rows = db
    .prepare('SELECT problem_id, outcome FROM submission_intents WHERE user_id = ?')
    .all(userId) as Array<{ problem_id: number; outcome: string }>;
  const map = new Map<number, string>();
  for (const r of rows) {
    const cur = map.get(r.problem_id);
    if (cur === undefined || intentFactor(r.outcome) < intentFactor(cur)) map.set(r.problem_id, r.outcome);
  }
  return map;
}

/** 只读估算（不触碰校准状态）：基数 / 通过率校准 / 目标值 */
export interface AbilityBreakdown {
  /** 难度基数（round 到百展示；样本不足回退时与 target 相同） */
  base: number | null;
  performanceAdj: number;
  target: number;
  samples: number;
}

export function estimateBreakdown(db: Db, userId: number, windowDays: number, now: Date = new Date()): AbilityBreakdown {
  const evidences = collectSolveEvidence(db, userId, windowDays, now);
  if (evidences.length < MIN_SAMPLES) {
    // 回退：全历史去重中位数（沿用 estimateLevel 口径），不做通过率校准
    const allTime = collectSolveEvidence(db, userId, null, now);
    const target = estimateLevel(allTime.map((e) => e.difficulty));
    return { base: allTime.length > 0 ? target : null, performanceAdj: 0, target, samples: allTime.length };
  }
  const halfLifeMs = Math.max(1, windowDays * HALF_LIFE_RATIO) * DAY_MS;
  const base = weightedBase(evidences, halfLifeMs) ?? 1200;
  // 同段难度通过率：以基数为锚取 ±ADJ_BAND 的窗口内提交（含失败）
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const band = db
    .prepare(
      `SELECT COUNT(*) AS attempts,
              COALESCE(SUM(CASE WHEN s.verdict = 'AC' THEN 1 ELSE 0 END), 0) AS ac
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = ? AND s.verdict != 'SKIPPED' AND s.submitted_at >= ?
          AND p.difficulty IS NOT NULL AND p.difficulty BETWEEN ? AND ?`,
    )
    .get(userId, since, base - ADJ_BAND, base + ADJ_BAND) as { attempts: number; ac: number };
  const performanceAdj = performanceAdjustment(band.attempts, band.ac);
  return {
    base: round100(base),
    performanceAdj,
    target: clampLevel(round100(base + performanceAdj)),
    samples: evidences.length,
  };
}

function countPracticeAttempts(db: Db, userId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM submissions WHERE user_id = ? AND verdict != 'SKIPPED'")
    .get(userId) as { c: number };
  return row.c;
}

export interface AbilityComputation {
  /** 发布值：校准状态 round 到百 */
  level: number;
  detail: AbilityLevelDetail;
}

/**
 * 完整能力值计算（含缓慢校准状态）：
 * - 首次无状态（老用户升级 / 空库）：从旧口径（全历史中位数）出发走一步夹紧步长，避免首见跳变
 * - 无新练习提交（含失败）：发布值保持不动（刷新页面不漂移），detail 里仍透出当前目标值
 * - 有新练习：状态向目标值走一小步并落库（失败堆出来的低通过率同样触发向下校准）
 */
export function computeAbilityDetail(db: Db, userId: number, windowDays = 60, now: Date = new Date()): AbilityComputation {
  const breakdown = estimateBreakdown(db, userId, windowDays, now);
  const totalAttempts = countPracticeAttempts(db, userId);
  const state = getAbilityState(db);

  if (!state) {
    const start = bootstrapStart(db, userId, now);
    // 全部练习都算新证据（空库时 start=target=1200 原地落定）
    const level = calibrateStep(start, breakdown.target, Math.max(1, totalAttempts));
    saveAbilityState(db, { level, totalAttempts, updatedAt: now.toISOString() });
    return {
      level: round100(level),
      detail: { ...breakdown, newEvidence: totalAttempts },
    };
  }

  const newEvidence = Math.max(0, totalAttempts - state.totalAttempts);
  if (newEvidence <= 0) {
    return { level: round100(state.level), detail: { ...breakdown, newEvidence: 0 } };
  }
  const level = calibrateStep(state.level, breakdown.target, newEvidence);
  saveAbilityState(db, { level, totalAttempts, updatedAt: now.toISOString() });
  return { level: round100(level), detail: { ...breakdown, newEvidence } };
}

/** 升级引导起点：旧口径的全历史去重中位数（无数据回退 1200） */
function bootstrapStart(db: Db, userId: number, now: Date): number {
  const allTime = collectSolveEvidence(db, userId, null, now);
  return estimateLevel(allTime.map((e) => e.difficulty));
}

/** 估算能力值（兼容旧签名：三档分档等调用方拿发布值即可） */
export function computeAbility(db: Db, userId: number, windowDays = 60): number {
  return computeAbilityDetail(db, userId, windowDays).level;
}

/** 生效能力值：AI 调整优先于计算值 */
export function effectiveAbility(db: Db, userId: number, windowDays = 60): { computed: number; override: AbilityOverride | null; effective: number } {
  const computed = computeAbility(db, userId, windowDays);
  const override = getAbilityOverride(db);
  return { computed, override, effective: override?.level ?? computed };
}

const percentile = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)));
  return sorted[idx];
};

/**
 * 能力评估数据（注入 AI 助手，Markdown）：模型明细（基数/通过率校准/目标/独立完成度）、
 * 近 60 天逐次 AC 难度的分位数/分布直方图/明细、全历史最高、12 周趋势、卡壳题——
 * 让 AI 能基于完整刷题情况独立判断真实水平，而不是默认信任计算基线。
 */
export function renderAbilityEvidence(db: Db, userId: number, summary: PracticeSummary, windowDays = 60): string {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const recent = db
    .prepare(
      `SELECT p.difficulty, MAX(s.submitted_at) AS solved_at
        FROM submissions s JOIN problems p ON s.problem_id = p.id
        WHERE s.user_id = ? AND s.verdict = 'AC' AND p.difficulty IS NOT NULL AND s.submitted_at >= ?
        GROUP BY p.id ORDER BY solved_at DESC`,
    )
    .all(userId, since) as Array<{ difficulty: number; solved_at: string }>;
  const maxAll = db
    .prepare(
      `SELECT MAX(p.difficulty) AS d FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = ? AND s.verdict = 'AC' AND p.difficulty IS NOT NULL`,
    )
    .get(userId) as { d: number | null };

  const L: string[] = [`### 近 ${windowDays} 天 AC 证据`];
  const diffs = recent.map((r) => r.difficulty).sort((a, b) => a - b);
  if (diffs.length === 0) {
    L.push(`- 近 ${windowDays} 天无带难度的 AC 记录，证据不足：不要建议调整能力值，先引导用户同步刷题数据`);
    return L.join('\n');
  }
  // 模型明细：让 AI 知道计算基线怎么来的、哪些证据被降权了
  const breakdown = estimateBreakdown(db, userId, windowDays);
  const evidences = collectSolveEvidence(db, userId, windowDays);
  const upsolved = evidences.filter((e) => e.spanMs > DAY_MS).length;
  const helped = evidences.filter((e) => e.intent != null && intentFactor(e.intent) <= 0.7).length;
  L.push(
    `- 模型估算：难度基数 ${breakdown.base ?? '—'}，通过率校准 ${breakdown.performanceAdj >= 0 ? '+' : ''}${breakdown.performanceAdj}，目标 ${breakdown.target}（证据 ${breakdown.samples} 题）`,
    `- 独立完成度：其中跨天解决（补题/长磨）${upsolved} 题、看题解或卡点后做出 ${helped} 题，这些在模型中已降权，不要因它们拉高基线`,
  );
  L.push(
    `- 近 ${windowDays} 天 AC ${diffs.length} 题：难度分位 P25=${percentile(diffs, 25)} / P50=${percentile(diffs, 50)} / P75=${percentile(diffs, 75)}；区间最高 ${diffs[diffs.length - 1]}；全历史最高 ${maxAll.d ?? '未知'}`,
  );
  // 直方图（200 分一档）
  const buckets = new Map<number, number>();
  for (const d of diffs) {
    const lo = Math.floor(d / 200) * 200;
    buckets.set(lo, (buckets.get(lo) ?? 0) + 1);
  }
  L.push(
    `- 难度分布（200 分一档）：${[...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([lo, n]) => `${lo}-${lo + 200}:${n}`).join(' ')}`,
  );
  // 最近 AC 明细（难度(日期)，新→旧，至多 25 条）
  L.push(
    `- 最近 AC（新→旧）：${recent.slice(0, 25).map((r) => `${r.difficulty}(${r.solved_at.slice(5, 10)})`).join(' ')}`,
  );
  // 12 周趋势
  if (summary.trend.length > 0) {
    L.push(`- 近 12 周趋势（周｜提交/AC/过题）：${summary.trend.map((t) => `${t.week.slice(5)}｜${t.attempts}/${t.ac}/${t.solved}`).join(' ')}`);
  }
  // 卡壳题（尝试 ≥3 未过，带难度的前 8 道）
  const stuck = summary.stuckProblems.filter((p) => p.attempts >= 3).slice(0, 8);
  if (stuck.length > 0) {
    L.push(`- 卡壳题（尝试≥3 次未通过）：${stuck.map((p) => `${p.platform}/${p.problemKey}（难度${p.difficulty ?? '未知'}）×${p.attempts}`).join(' ')}`);
  }
  return L.join('\n');
}
