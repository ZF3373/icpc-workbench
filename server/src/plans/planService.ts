import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PlatformId } from '../../../shared/src/index.ts';
import type { AiConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { AiProvider } from '../ai/provider.ts';
import { computeTrend } from '../analysis/trend.ts';
import { computeWeakness, type WeaknessProfile } from '../analysis/weakness.ts';
import { filterNoiseTags } from '../analysis/tags.ts';
import { getAdapter } from '../adapters/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'ai', 'plan-prompt.md'),
  'utf8',
);

export const TASK_KINDS = ['practice', 'review', 'topic', 'contest'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface PlanTaskInput {
  date: string;
  title: string;
  kind?: string;
  platform?: PlatformId;
  problemKey?: string;
  url?: string;
  note?: string;
}

export interface PlanInput {
  title: string;
  goal: string;
  startDate: string;
  days: number;
  tasks: PlanTaskInput[];
}

export interface RecommendProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  tags: string[];
  url: string | null;
}

export interface PlanPackage {
  profile: WeaknessProfile;
  trend: ReturnType<typeof computeTrend>;
  problems: RecommendProblem[];
  level: UserLevel;
  prompt: string;
  meta: { startDate: string; days: number; generatedAt: string };
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

/** 校验并持久化一份计划（plans + plan_tasks 事务），返回 planId。 */
export function savePlan(
  db: Db,
  userId: number,
  input: PlanInput,
  source: 'ai' | 'template' | 'manual',
  rawPrompt?: string,
): number {
  if (!input.title.trim()) throw new Error('计划标题不能为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new Error('startDate 格式非法');
  if (!Number.isInteger(input.days) || input.days <= 0 || input.days > 90) {
    throw new Error('days 非法（1-90）');
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new Error('计划至少需要 1 个任务');
  }
  const tasks = input.tasks.map((t, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) throw new Error(`任务 ${i + 1} 日期格式非法`);
    const kind = t.kind ?? 'practice';
    if (!(TASK_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`任务 ${i + 1} kind 非法: ${kind}`);
    }
    if (!t.title.trim()) throw new Error(`任务 ${i + 1} 缺少标题`);
    return {
      date: t.date,
      title: t.title.trim(),
      kind,
      platform: t.platform,
      problemKey: t.problemKey?.trim(),
      url: t.url?.trim() || undefined,
      note: t.note,
    };
  });

  const endDate = addDays(input.startDate, input.days - 1);
  db.exec('BEGIN');
  try {
    const r = db
      .prepare(
        `INSERT INTO plans (user_id, title, goal, start_date, end_date, source, raw_prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        input.title.trim(),
        input.goal ?? '',
        input.startDate,
        endDate,
        source,
        rawPrompt ?? null,
      );
    const planId = Number(r.lastInsertRowid);
    const insTask = db.prepare(
      `INSERT INTO plan_tasks (plan_id, task_date, title, kind, problem_id, url, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of tasks) {
      let problemId: number | null = null;
      let finalUrl = t.url ?? null;
      if (t.platform && t.problemKey) {
        const p = db
          .prepare('SELECT id, url FROM problems WHERE platform = ? AND problem_key = ?')
          .get(t.platform, t.problemKey) as { id: number; url: string | null } | undefined;
        problemId = p?.id ?? null;
        // url 兜底 1：任务未带链接但题目有链接 → 用题目链接，保证可点击跳转
        if (!finalUrl && p?.url) finalUrl = p.url;
      }
      // url 兜底 2：platform/problemKey 没匹配上（AI 编造 key 或只给标题）→
      // 反向模糊匹配：题名出现在任务标题里（instr(taskTitle, title)）即视为同一题；
      // 仍找不到再用平台适配器按 key 构造链接（用户要求任务可点击跳转）
      if (!finalUrl && t.platform) {
        const p = db
          .prepare(
            `SELECT id, url FROM problems
              WHERE platform = ?
                AND url IS NOT NULL
                AND (problem_key = ? COLLATE NOCASE
                     OR (length(title) >= 3 AND instr(?, title) > 0))
              LIMIT 1`,
          )
          .get(t.platform, t.problemKey ?? '', t.title) as
          | { id: number; url: string }
          | undefined;
        if (p) {
          problemId = p.id;
          finalUrl = p.url;
        }
      }
      if (!finalUrl && t.platform) {
        finalUrl = getAdapter(t.platform)?.problemUrl({ problemKey: t.problemKey ?? '' }) ?? null;
      }
      insTask.run(planId, t.date, t.title, t.kind, problemId, finalUrl, t.note ?? null);
    }
    db.exec('COMMIT');
    return planId;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * 生成训练计划：优先调用 AI（OpenAI 兼容），失败或未配置时降级为模板计划。
 */
export async function generatePlan(
  db: Db,
  aiConfig: AiConfig,
  opts: { days?: number; startDate?: string; provider?: AiProvider } = {},
): Promise<{ planId: number; source: 'ai' | 'template'; title: string }> {
  const userId = DEFAULT_USER_ID;
  const days = opts.days ?? 14;
  const startDate = opts.startDate ?? today();
  const pkg = buildPlanPackage(db, userId, { days, startDate });
  const provider = opts.provider ?? new AiProvider(aiConfig);

  if (provider.enabled) {
    try {
      const raw = await provider.chat([
        { role: 'system', content: '你是 ICPC 备赛教练，只输出严格 JSON，不加任何解释。' },
        { role: 'user', content: pkg.prompt },
      ]);
      const parsed = parsePlanJson(raw, startDate, days);
      const planId = savePlan(db, userId, parsed, 'ai', raw);
      return { planId, source: 'ai', title: parsed.title };
    } catch (e) {
      console.warn(`[plans] AI 生成失败，降级为模板计划: ${(e as Error).message}`);
    }
  }
  const tpl = templatePlan(db, pkg.profile, startDate, days);
  const planId = savePlan(db, userId, tpl, 'template');
  return { planId, source: 'template', title: tpl.title };
}

/** 构建供 AI 使用的数据包（含渲染后的提示词）。 */
export function buildPlanPackage(
  db: Db,
  userId: number,
  opts: { days?: number; startDate?: string } = {},
): PlanPackage {
  const days = opts.days ?? 14;
  const startDate = opts.startDate ?? today();
  // minAttempts=5：过小的样本（如 3 次提交 0AC）不足以支撑"弱项"结论
  const profile = computeWeakness(db, userId, { minAttempts: 5, topN: 8 });
  const trend = computeTrend(db, userId, 12);
  const level = computeUserLevel(db, userId);
  const problems = recommendProblems(db, profile, { level });

  const prompt = renderTemplate(PROMPT_TEMPLATE, {
    days: String(days),
    startDate,
    level: JSON.stringify(level),
    weakness: JSON.stringify(profile.items),
    trend: JSON.stringify(trend),
    problems: JSON.stringify(problems.slice(0, 50)),
  });

  return {
    profile,
    trend,
    problems,
    level,
    prompt,
    meta: { startDate, days, generatedAt: new Date().toISOString() },
  };
}

/** 用户当前水平画像（供 AI 锚定训练难度）：已 AC 题难度分位。 */
export interface UserLevel {
  /** 已 AC 且有难度的题数 */
  solvedCount: number;
  /** AC 难度中位数（P50） */
  medianDifficulty: number | null;
  /** AC 难度 P75 */
  p75Difficulty: number | null;
  /** 建议训练区间 [下限, 上限]（中位数 ~ P75+200，向上适度挑战） */
  suggestedRange: [number, number] | null;
}

/** 计算用户 AC 难度分位（CF rating 统一标尺）；样本不足时返回 null。 */
export function computeUserLevel(db: Db, userId: number, minSample = 10): UserLevel {
  // 注意按"题"去重而非难度值去重：同一难度下多道 AC 题各计一次
  const diffs = (
    db
      .prepare(
        `SELECT p.difficulty AS difficulty
           FROM problems p
          WHERE p.difficulty IS NOT NULL
            AND EXISTS (SELECT 1 FROM submissions s
                         WHERE s.problem_id = p.id AND s.user_id = ? AND s.verdict = 'AC')`,
      )
      .all(userId) as Array<{ difficulty: number }>
  )
    .map((r) => r.difficulty)
    .sort((a, b) => a - b);
  if (diffs.length < minSample) {
    return { solvedCount: diffs.length, medianDifficulty: null, p75Difficulty: null, suggestedRange: null };
  }
  const q = (p: number): number => {
    const idx = Math.min(diffs.length - 1, Math.floor(p * (diffs.length - 1)));
    return diffs[idx];
  };
  const median = q(0.5);
  const p75 = q(0.75);
  return {
    solvedCount: diffs.length,
    medianDifficulty: median,
    p75Difficulty: p75,
    suggestedRange: [Math.max(800, median - 100), p75 + 200],
  };
}

/** 推荐题目：未 AC 优先，命中弱项标签加权；难度限制在用户水平附近（可挑战，不推水题/远超水平的题）。 */
export function recommendProblems(
  db: Db,
  profile: WeaknessProfile,
  opts: { limit?: number; level?: UserLevel | null } = {},
): RecommendProblem[] {
  const limit = opts.limit ?? 80;
  const level = opts.level === undefined ? computeUserLevel(db, DEFAULT_USER_ID) : opts.level;

  const all = db
    .prepare(
      `SELECT p.platform, p.problem_key, p.title, p.difficulty, p.url, p.tags,
              EXISTS (SELECT 1 FROM submissions s
                       WHERE s.problem_id = p.id AND s.user_id = ? AND s.verdict = 'AC') AS aced
       FROM problems p`,
    )
    .all(DEFAULT_USER_ID) as Array<{
    platform: PlatformId;
    problem_key: string;
    title: string;
    difficulty: number | null;
    url: string | null;
    tags: string;
    aced: number;
  }>;

  const weakTags = new Set(profile.items.map((i) => i.tag));
  const inRange = (d: number | null): boolean => {
    if (!level?.suggestedRange) return true; // 样本不足：不过滤难度
    const [lo, hi] = level.suggestedRange;
    return d !== null && d >= lo && d <= hi;
  };
  return all
    .filter((p) => !p.aced)
    .filter((p) => p.url !== null)
    .filter((p) => inRange(p.difficulty))
    .map((p) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(p.tags) as string[];
      } catch {
        tags = [];
      }
      return {
        platform: p.platform,
        problemKey: p.problem_key,
        title: p.title,
        difficulty: p.difficulty,
        tags: filterNoiseTags(tags),
        url: p.url,
        score: tags.filter((t) => weakTags.has(t)).length,
      };
    })
    .sort((a, b) => b.score - a.score || (a.difficulty ?? 9999) - (b.difficulty ?? 9999))
    .slice(0, limit)
    .map(({ score: _score, ...p }) => p);
}

/** 解析 AI 输出的 JSON，校验基本结构。容错：围栏、前后解释性文字、尾逗号、畸形任务条目。 */
export function parsePlanJson(raw: string, _startDate: string, _days: number): PlanInput {
  let text = raw.trim();
  // 去掉任意位置的 ``` / ```json 围栏（模型偶尔在围栏外补一句说明）
  if (text.includes('```')) {
    text = text.replace(/```[a-zA-Z]*\s*/g, '').trim();
  }
  // 截取首个 { 到最后一个 }（容忍 JSON 前后的自然语言包装）
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  let obj: { title?: unknown; goal?: unknown; tasks?: unknown };
  try {
    obj = JSON.parse(text) as typeof obj;
  } catch (e) {
    // 二次容错：模型常见错误——对象/数组末尾多余逗号
    try {
      obj = JSON.parse(text.replace(/,\s*([}\]])/g, '$1')) as typeof obj;
    } catch {
      throw new Error(`AI 输出不是合法 JSON: ${(e as Error).message}`);
    }
  }
  if (typeof obj.title !== 'string' || !obj.title.trim()) throw new Error('AI 输出缺少 title');
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) throw new Error('AI 输出缺少 tasks');
  // 计划期边界（闭区间）：AI 输出的日期必须落在期内，否则丢弃该条目
  const startMs = Date.parse(`${_startDate}T00:00:00Z`);
  const endMs = startMs + (_days - 1) * 86_400_000;
  const inRange = (d: string): boolean => {
    const ms = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(ms) && ms >= startMs && ms <= endMs;
  };
  // 逐条清洗：丢弃缺 title/date 或日期在计划期外的条目，未知 kind 回退为 practice
  const tasks = (obj.tasks as unknown[])
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .filter((t) => typeof t.title === 'string' && t.title.trim() && typeof t.date === 'string')
    .filter((t) => inRange(t.date as string))
    .map((t) => ({
      date: t.date as string,
      title: t.title as string,
      kind: TASK_KINDS.includes(t.kind as TaskKind) ? (t.kind as string) : 'practice',
      platform: t.platform as PlatformId | undefined,
      problemKey: t.problemKey as string | undefined,
      url: t.url as string | undefined,
      note: t.note as string | undefined,
    }));
  if (tasks.length === 0) throw new Error('AI 输出 tasks 中没有有效任务');
  return {
    title: obj.title,
    goal: typeof obj.goal === 'string' ? obj.goal : '',
    startDate: _startDate,
    days: _days,
    tasks,
  };
}

/** 无 AI 时的降级模板：每日练习任务均挑选具体题目（可点击跳转），定期回顾/模拟。 */
export function templatePlan(
  db: Db,
  profile: WeaknessProfile,
  startDate: string,
  days: number,
): PlanInput {
  const weakTags = profile.items.map((i) => i.tag);
  const tags = weakTags.length > 0 ? weakTags : ['综合练习'];
  const pool = practicePool(db, weakTags);
  // 每个 tag 一个候选队列：优先含弱项标签、未 AC、有链接的题目。
  // 同一道题只会被选中一次（跨 tag 全局去重，避免计划内重复刷同一题）；
  // tag 队列耗尽后回退到全库剩余候选（fallbackPool）——每日练习尽量落到具体题目，
  // 只有全库候选都用尽时才生成抽象任务（此时库里确实无题可选，链接无从谈起）。
  const queue = new Map<string, RecommendProblem[]>();
  for (const t of tags) {
    queue.set(t, t === '综合练习' ? [...pool] : pool.filter((p) => p.tags.includes(t)));
  }
  const fallbackPool = [...pool];
  const used = new Set<string>();
  const takeNext = (q: RecommendProblem[]): RecommendProblem | undefined => {
    while (q.length > 0) {
      const pb = q.shift();
      if (!pb) return undefined;
      const key = `${pb.platform}:${pb.problemKey}`;
      if (used.has(key)) continue;
      used.add(key);
      return pb;
    }
    return undefined;
  };
  const takeAny = (): RecommendProblem | undefined => takeNext(fallbackPool);
  // 模拟赛链接：CF 主题题库页（难度分级），挑战性接近实战
  const CONTEST_URL = 'https://codeforces.com/problemset?order=BY_SOLVED_DESC';
  const REVIEW_URL = 'https://codeforces.com/submissions/me';
  const tasks: PlanTaskInput[] = [];
  for (let d = 0; d < days; d += 1) {
    const date = addDays(startDate, d);
    if (d % 7 === 6) {
      tasks.push({
        date,
        title: '模拟比赛（虚拟参赛）',
        kind: 'contest',
        url: CONTEST_URL,
        note: '完整 2 小时虚拟参赛，赛后补题',
      });
    } else {
      const tag = tags[d % tags.length];
      const pb = takeNext(queue.get(tag) ?? []) ?? takeAny();
      tasks.push(
        pb
          ? {
              date,
              title: pb.title,
              kind: 'practice',
              platform: pb.platform,
              problemKey: pb.problemKey,
              url: pb.url ?? undefined,
              note: `重点突破弱项：${tag}`,
            }
          : {
              date,
              title: `练习：${tag}`,
              kind: 'practice',
              note: `重点突破弱项：${tag}`,
            },
      );
    }
    if ((d + 1) % 4 === 0) {
      tasks.push({
        date,
        title: `回顾与错题重做（前 ${Math.min(d + 1, 7)} 天）`,
        kind: 'review',
        url: REVIEW_URL,
      });
    }
  }
  const goal =
    weakTags.length > 0
      ? `针对性突破弱项：${weakTags.slice(0, 3).join('、')}，保持每日练习节奏。`
      : '保持每日练习节奏，稳步提升。';
  return { title: `模板训练计划（${days} 天）`, goal, startDate, days, tasks };
}

/** 训练候选池：未 AC 且带链接的题目，按弱项标签命中数排序（同分按难度升序）。
 * 用户水平样本充足时仅保留建议区间内的题（题库拉取入库后候选量大，
 * 不过滤会全是远低于水平的入门题）。 */
export function practicePool(db: Db, weakTags: string[]): RecommendProblem[] {
  const level = computeUserLevel(db, DEFAULT_USER_ID);
  const [lo, hi] = level.suggestedRange ?? [null, null];
  const rows = db
    .prepare(
      `SELECT p.platform, p.problem_key, p.title, p.difficulty, p.url, p.tags
       FROM problems p
       LEFT JOIN submissions s
         ON s.problem_id = p.id AND s.user_id = ? AND s.verdict = 'AC'
       WHERE s.id IS NULL AND p.url IS NOT NULL
         AND (? IS NULL OR p.difficulty >= ?)
         AND (? IS NULL OR p.difficulty <= ?)
       ORDER BY p.difficulty IS NULL, p.difficulty
       LIMIT 500`,
    )
    .all(DEFAULT_USER_ID, lo, lo, hi, hi) as Array<{
    platform: PlatformId;
    problem_key: string;
    title: string;
    difficulty: number | null;
    url: string | null;
    tags: string;
  }>;
  const weak = new Set(weakTags);
  return rows
    .map((p) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(p.tags) as string[];
      } catch {
        tags = [];
      }
      return {
        platform: p.platform,
        problemKey: p.problem_key,
        title: p.title,
        difficulty: p.difficulty,
        tags: filterNoiseTags(tags),
        url: p.url,
        score: tags.filter((t) => weak.has(t)).length,
      };
    })
    .sort((a, b) => b.score - a.score || (a.difficulty ?? 0) - (b.difficulty ?? 0));
}
