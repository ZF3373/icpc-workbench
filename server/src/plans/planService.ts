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
        // url 兜底：任务未带链接但题目有链接 → 用题目链接，保证可点击跳转
        if (!finalUrl && p?.url) finalUrl = p.url;
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
  const profile = computeWeakness(db, userId, { minAttempts: 2, topN: 8 });
  const trend = computeTrend(db, userId, 12);
  const problems = recommendProblems(db, profile);

  const prompt = renderTemplate(PROMPT_TEMPLATE, {
    days: String(days),
    startDate,
    weakness: JSON.stringify(profile.items),
    trend: JSON.stringify(trend),
    problems: JSON.stringify(problems.slice(0, 50)),
  });

  return {
    profile,
    trend,
    problems,
    prompt,
    meta: { startDate, days, generatedAt: new Date().toISOString() },
  };
}

/** 推荐题目：优先含弱项标签，其次有难度的题，按难度升序（由易到难）。 */
export function recommendProblems(
  db: Db,
  profile: WeaknessProfile,
  limit = 80,
): RecommendProblem[] {
  const all = db
    .prepare(
      `SELECT platform, problem_key, title, difficulty, url, tags
       FROM problems ORDER BY difficulty IS NULL, difficulty`,
    )
    .all() as Array<{
    platform: PlatformId;
    problem_key: string;
    title: string;
    difficulty: number | null;
    url: string | null;
    tags: string;
  }>;

  const weakTags = new Set(profile.items.map((i) => i.tag));
  const score = (tags: string[]): number => {
    const hit = tags.filter((t) => weakTags.has(t)).length;
    return hit;
  };
  return all
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
        tags,
        url: p.url,
        score: score(tags),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...p }) => p);
}

/** 解析 AI 输出的 JSON（容忍 ```json 围栏），校验基本结构。 */
export function parsePlanJson(raw: string, _startDate: string, _days: number): PlanInput {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const obj = JSON.parse(text) as {
    title?: unknown;
    goal?: unknown;
    tasks?: unknown;
  };
  if (typeof obj.title !== 'string' || !obj.title.trim()) throw new Error('AI 输出缺少 title');
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) throw new Error('AI 输出缺少 tasks');
  return {
    title: obj.title,
    goal: typeof obj.goal === 'string' ? obj.goal : '',
    startDate: _startDate,
    days: _days,
    tasks: obj.tasks as PlanTaskInput[],
  };
}

/** 无 AI 时的降级模板：为每日练习任务挑选具体题目（可点击跳转），定期回顾/模拟。 */
export function templatePlan(
  db: Db,
  profile: WeaknessProfile,
  startDate: string,
  days: number,
): PlanInput {
  const weakTags = profile.items.map((i) => i.tag);
  const tags = weakTags.length > 0 ? weakTags : ['综合练习'];
  const pool = practicePool(db, weakTags);
  // 每个 tag 一个候选队列：优先含弱项标签、未 AC、有链接的题目；题目用尽后该 tag 回退为抽象任务。
  // 同一道题只会被选中一次（跨 tag 全局去重，避免计划内重复刷同一题）
  const queue = new Map<string, RecommendProblem[]>();
  for (const t of tags) {
    queue.set(t, t === '综合练习' ? [...pool] : pool.filter((p) => p.tags.includes(t)));
  }
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
  const tasks: PlanTaskInput[] = [];
  for (let d = 0; d < days; d += 1) {
    const date = addDays(startDate, d);
    if (d % 7 === 6) {
      tasks.push({
        date,
        title: '模拟比赛（虚拟参赛）',
        kind: 'contest',
        note: '完整 2 小时虚拟参赛，赛后补题',
      });
    } else {
      const tag = tags[d % tags.length];
      const pb = takeNext(queue.get(tag) ?? []);
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
      tasks.push({ date, title: `回顾与错题重做（前 ${Math.min(d + 1, 7)} 天）`, kind: 'review' });
    }
  }
  const goal =
    weakTags.length > 0
      ? `针对性突破弱项：${weakTags.slice(0, 3).join('、')}，保持每日练习节奏。`
      : '保持每日练习节奏，稳步提升。';
  return { title: `模板训练计划（${days} 天）`, goal, startDate, days, tasks };
}

/** 训练候选池：未 AC 且带链接的题目，按弱项标签命中数排序（同分按难度升序）。 */
export function practicePool(db: Db, weakTags: string[]): RecommendProblem[] {
  const rows = db
    .prepare(
      `SELECT p.platform, p.problem_key, p.title, p.difficulty, p.url, p.tags
       FROM problems p
       LEFT JOIN submissions s
         ON s.problem_id = p.id AND s.user_id = ? AND s.verdict = 'AC'
       WHERE s.id IS NULL AND p.url IS NOT NULL
       ORDER BY p.difficulty IS NULL, p.difficulty
       LIMIT 500`,
    )
    .all(DEFAULT_USER_ID) as Array<{
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
        tags,
        url: p.url,
        score: tags.filter((t) => weak.has(t)).length,
      };
    })
    .sort((a, b) => b.score - a.score || (a.difficulty ?? 0) - (b.difficulty ?? 0));
}
