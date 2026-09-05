/**
 * 完整个人练习数据汇总：把散落在各模块的数据（总体统计 / 弱项 / 掌握度 / 趋势 /
 * 近期 AC / 卡壳题 / 复习库 / 模板课程进度 / 打卡）汇成一份结构化画像。
 * 三种消费形态：
 * 1. buildPracticeSummary → JSON（GET /api/stats/summary）
 * 2. renderSummaryMarkdown → 完整 Markdown（GET /api/export/summary.md，可下载喂给任意 AI）
 * 3. renderSummaryForPrompt → 精简版（注入 AI 训练计划提示词的 {summary} 段）
 */
import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS, platformMeta } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { bucketForDifficulty, fetchRows, rate, safeTags } from './stats.ts';
import { filterNoiseTags } from './tags.ts';
import { computeWeakness, type WeaknessItem } from './weakness.ts';
import { computeMastery } from './mastery.ts';
import { computeTrend } from './trend.ts';
import { computeStreak } from '../routes/checkins.ts';
import { CURRICULUM } from '../templates/curriculum.ts';
import { computeUserLevel, type UserLevel } from '../plans/planService.ts';

export interface PlatformSummary {
  platform: PlatformId;
  platformName: string;
  submissions: number;
  /** AC 的题数（去重） */
  solved: number;
  /** 提交覆盖的题数（去重） */
  problems: number;
  /** 按题口径的通过率：AC 题数 / 提交覆盖题数 */
  solveRate: number;
  /** 最近一次提交时间（ISO），null = 该平台无提交 */
  lastActiveAt: string | null;
}

export interface DifficultySummary {
  bucket: string;
  attempts: number;
  ac: number;
  acRate: number;
}

export interface TagSummary {
  tag: string;
  solved: number;
  attempts: number;
  acRate: number;
}

export interface RecentAcProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string[];
  solvedAt: string;
}

export interface StuckProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  /** 未 AC 期间的尝试次数 */
  attempts: number;
  lastAttemptAt: string;
}

export interface TemplateCategoryProgress {
  key: string;
  name: string;
  total: number;
  mastered: number;
  learning: number;
}

export interface PracticeSummary {
  generatedAt: string;
  /** 训练时间跨度与活跃度 */
  range: {
    firstSubmissionAt: string | null;
    lastSubmissionAt: string | null;
    /** 有提交的自然日数 */
    activeDays: number;
  };
  overall: {
    submissions: number;
    /** 涉及题目数（去重） */
    problems: number;
    solved: number;
    acRate: number;
  };
  byPlatform: PlatformSummary[];
  byDifficulty: DifficultySummary[];
  /** 练习量最大的知识点（按通过题数降序，前 15） */
  topTags: TagSummary[];
  /** 弱项画像（相对自身平均 AC 率的 gap，与弱项分析页同口径） */
  weakTags: WeaknessItem[];
  /** 知识点掌握度摘要（关联模板课程） */
  mastery: {
    /** 练过但掌握薄弱（level<=2）的知识点，含「尝试多次仍未通过」的（solved=0），按档位升序、尝试量降序 */
    weak: Array<{ tag: string; level: number; solved: number; attempts: number; acRate: number }>;
    /** 课程大纲涉及但从未练过（0 提交）的知识点（学习盲区） */
    untouchedCourseTags: string[];
    /** 掌握及以上（level>=3）的知识点数 */
    masteredCount: number;
  };
  trend: Array<{ week: string; attempts: number; ac: number; solved: number }>;
  recentAc: RecentAcProblem[];
  stuckProblems: StuckProblem[];
  reviewQueue: { total: number; dueCount: number };
  templates: {
    total: number;
    mastered: number;
    learning: number;
    byCategory: TemplateCategoryProgress[];
  };
  checkins: { currentStreak: number; longestStreak: number; totalDays: number };
  level: UserLevel;
}

const todayStr = (): string => new Date().toISOString().slice(0, 10);

export function buildPracticeSummary(db: Db, userId: number): PracticeSummary {
  const rows = fetchRows(db, userId);
  const totalAc = rows.filter((r) => r.verdict === 'AC').length;
  const solvedKeys = new Set<string>();
  const byPlatform = new Map<PlatformId, { submissions: number; solved: Set<string>; touched: Set<string>; lastAt: string | null }>();
  for (const p of PLATFORMS) {
    byPlatform.set(p.id, { submissions: 0, solved: new Set(), touched: new Set(), lastAt: null });
  }
  const byDifficulty = new Map<string, { attempts: number; ac: number }>();
  const byTag = new Map<string, { solved: Set<string>; attempts: number; ac: number }>();
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  const activeDays = new Set<string>();

  for (const r of rows) {
    const isAc = r.verdict === 'AC';
    const key = `${r.platform}:${r.problem_key}`;
    if (isAc) solvedKeys.add(key);
    const plat = byPlatform.get(r.platform);
    if (plat) {
      plat.submissions += 1;
      plat.touched.add(r.problem_key);
      if (isAc) plat.solved.add(r.problem_key);
      if (!plat.lastAt || r.submitted_at > plat.lastAt) plat.lastAt = r.submitted_at;
    }
    const bucket = bucketForDifficulty(r.difficulty);
    const d = byDifficulty.get(bucket) ?? { attempts: 0, ac: 0 };
    d.attempts += 1;
    if (isAc) d.ac += 1;
    byDifficulty.set(bucket, d);
    for (const tag of filterNoiseTags(safeTags(r.tags))) {
      const t = byTag.get(tag) ?? { solved: new Set<string>(), attempts: 0, ac: 0 };
      t.attempts += 1;
      if (isAc) {
        t.ac += 1;
        t.solved.add(key);
      }
      byTag.set(tag, t);
    }
    if (!firstAt || r.submitted_at < firstAt) firstAt = r.submitted_at;
    if (!lastAt || r.submitted_at > lastAt) lastAt = r.submitted_at;
    activeDays.add(r.submitted_at.slice(0, 10));
  }

  const byPlatformList: PlatformSummary[] = PLATFORMS.map((p) => {
    const s = byPlatform.get(p.id)!;
    return {
      platform: p.id,
      platformName: platformMeta(p.id).name,
      submissions: s.submissions,
      solved: s.solved.size,
      problems: s.touched.size,
      solveRate: s.touched.size > 0 ? Math.round((s.solved.size / s.touched.size) * 1000) / 10 : 0,
      lastActiveAt: s.lastAt,
    };
  });

  const topTags: TagSummary[] = [...byTag.entries()]
    .map(([tag, s]) => ({
      tag,
      solved: s.solved.size,
      attempts: s.attempts,
      acRate: rate(s.attempts, s.ac),
    }))
    .sort((a, b) => b.solved - a.solved || b.attempts - a.attempts)
    .slice(0, 15);

  return {
    generatedAt: new Date().toISOString(),
    range: { firstSubmissionAt: firstAt, lastSubmissionAt: lastAt, activeDays: activeDays.size },
    overall: {
      submissions: rows.length,
      problems: new Set(rows.map((r) => `${r.platform}:${r.problem_key}`)).size,
      solved: solvedKeys.size,
      acRate: rate(rows.length, totalAc),
    },
    byPlatform: byPlatformList,
    byDifficulty: [...byDifficulty.entries()].map(([bucket, s]) => ({
      bucket,
      attempts: s.attempts,
      ac: s.ac,
      acRate: rate(s.attempts, s.ac),
    })),
    topTags,
    weakTags: computeWeakness(db, userId, { minAttempts: 5, topN: 10 }).items,
    mastery: masteryDigest(db, userId),
    trend: computeTrend(db, userId, 12).map((t) => ({
      week: t.week,
      attempts: t.attempts,
      ac: t.ac,
      solved: t.solved,
    })),
    recentAc: loadRecentAc(db, userId),
    stuckProblems: loadStuckProblems(db, userId),
    reviewQueue: {
      total: (
        db.prepare('SELECT COUNT(*) AS n FROM review_items WHERE user_id = ?').get(userId) as { n: number }
      ).n,
      dueCount: (
        db
          .prepare('SELECT COUNT(*) AS n FROM review_items WHERE user_id = ? AND next_due_on <= ?')
          .get(userId, todayStr()) as { n: number }
      ).n,
    },
    templates: loadTemplateProgress(db, userId),
    checkins: loadCheckins(db, userId),
    level: computeUserLevel(db, userId),
  };
}

/**
 * 掌握度摘要。
 * 注意 level 0 有两种含义，必须按 attempts 区分：
 * - attempts > 0：练过但从未通过 —— 最需要补强的信号，归入 weak
 * - attempts = 0：从未练过的课程知识点 —— 归入 untouchedCourseTags（学习盲区）
 */
function masteryDigest(db: Db, userId: number): PracticeSummary['mastery'] {
  const report = computeMastery(db, userId);
  const weak = report.points
    .filter((p) => p.attempts > 0 && p.level <= 2)
    .sort((a, b) => a.level - b.level || b.attempts - a.attempts)
    .slice(0, 12)
    .map((p) => ({ tag: p.tag, level: p.level, solved: p.solved, attempts: p.attempts, acRate: p.acRate }));
  const untouchedCourseTags = report.points.filter((p) => p.attempts === 0).map((p) => p.tag);
  const masteredCount = report.points.filter((p) => p.level >= 3).length;
  return { weak, untouchedCourseTags, masteredCount };
}

/** 最近通过的题（按最后 AC 时间倒序，前 15） */
function loadRecentAc(db: Db, userId: number): RecentAcProblem[] {
  const rows = db
    .prepare(
      `SELECT p.platform, p.problem_key, p.title, p.difficulty, p.url, p.tags, MAX(s.submitted_at) AS solved_at
       FROM submissions s JOIN problems p ON s.problem_id = p.id
       WHERE s.user_id = ? AND s.verdict = 'AC'
       GROUP BY p.id ORDER BY solved_at DESC LIMIT 15`,
    )
    .all(userId) as unknown as Array<{
    platform: PlatformId;
    problem_key: string;
    title: string;
    difficulty: number | null;
    url: string | null;
    tags: string;
    solved_at: string;
  }>;
  return rows.map((r) => ({
    platform: r.platform,
    problemKey: r.problem_key,
    title: r.title,
    difficulty: r.difficulty,
    url: r.url,
    tags: filterNoiseTags(safeTags(r.tags)),
    solvedAt: r.solved_at,
  }));
}

/** 卡壳题：≥3 次非 AC 提交且从未通过（补题/专项突破的最佳素材），前 10 */
function loadStuckProblems(db: Db, userId: number): StuckProblem[] {
  const rows = db
    .prepare(
      `SELECT p.platform, p.problem_key, p.title, p.difficulty, p.url,
              COUNT(*) AS attempts, MAX(s.submitted_at) AS last_at
       FROM submissions s JOIN problems p ON s.problem_id = p.id
       WHERE s.user_id = ? AND s.verdict NOT IN ('AC', 'SKIPPED')
         AND NOT EXISTS (
           SELECT 1 FROM submissions s2
            WHERE s2.problem_id = s.problem_id AND s2.user_id = s.user_id AND s2.verdict = 'AC'
         )
       GROUP BY p.id
       HAVING attempts >= 3
       ORDER BY attempts DESC, last_at DESC
       LIMIT 10`,
    )
    .all(userId) as unknown as Array<{
    platform: PlatformId;
    problem_key: string;
    title: string;
    difficulty: number | null;
    url: string | null;
    attempts: number;
    last_at: string;
  }>;
  return rows.map((r) => ({
    platform: r.platform,
    problemKey: r.problem_key,
    title: r.title,
    difficulty: r.difficulty,
    url: r.url,
    attempts: r.attempts,
    lastAttemptAt: r.last_at,
  }));
}

/** 模板课程学习进度（内置课程按分类统计） */
function loadTemplateProgress(db: Db, userId: number): PracticeSummary['templates'] {
  const rows = db
    .prepare('SELECT template_id, status FROM template_progress WHERE user_id = ?')
    .all(userId) as unknown as Array<{ template_id: string; status: string }>;
  const statusOf = new Map<string, string>();
  for (const r of rows) statusOf.set(r.template_id, r.status);

  const byCategory: TemplateCategoryProgress[] = CURRICULUM.map((cat) => {
    let mastered = 0;
    let learning = 0;
    for (const t of cat.templates) {
      const s = statusOf.get(t.id);
      if (s === 'mastered') mastered += 1;
      else if (s === 'learning') learning += 1;
    }
    return { key: cat.key, name: cat.name, total: cat.templates.length, mastered, learning };
  });
  const total = CURRICULUM.reduce((n, c) => n + c.templates.length, 0);
  return {
    total,
    mastered: byCategory.reduce((n, c) => n + c.mastered, 0),
    learning: byCategory.reduce((n, c) => n + c.learning, 0),
    byCategory,
  };
}

/** 打卡统计（复用日历页同口径） */
function loadCheckins(db: Db, userId: number): PracticeSummary['checkins'] {
  const rows = db
    .prepare('SELECT DISTINCT task_date FROM checkins WHERE user_id = ?')
    .all(userId) as unknown as Array<{ task_date: string }>;
  const streak = computeStreak(rows.map((r) => r.task_date), todayStr());
  return { currentStreak: streak.current, longestStreak: streak.longest, totalDays: streak.totalDays };
}

// ---------- Markdown 渲染 ----------

const fmtTime = (iso: string | null): string => (iso ? iso.slice(0, 10) : '—');
const fmtPct = (v: number): string => `${Math.round(v * 10) / 10}%`;
const LEVEL_LABELS = ['未开始', '接触', '入门', '掌握', '熟练'];

/** 完整版 Markdown：独立下载用（GET /api/export/summary.md） */
export function renderSummaryMarkdown(s: PracticeSummary): string {
  const L: string[] = [];
  L.push(`# ICPC 备赛 · 个人练习数据汇总`);
  L.push(``);
  L.push(`> 生成于 ${s.generatedAt}（ICPC Workbench）；数据涵盖本地已同步的全部平台提交记录。`);
  L.push(``);
  L.push(`## 一、总览`);
  L.push(
    `- 提交 ${s.overall.submissions} 次，涉及 ${s.overall.problems} 道题，通过 ${s.overall.solved} 题（按提交口径 AC 率 ${fmtPct(s.overall.acRate)}）`,
  );
  L.push(
    `- 训练跨度：${fmtTime(s.range.firstSubmissionAt)} ~ ${fmtTime(s.range.lastSubmissionAt)}，有提交记录 ${s.range.activeDays} 天`,
  );
  if (s.level.medianDifficulty !== null) {
    L.push(
      `- 能力评估：已 AC 题难度中位数 ${s.level.medianDifficulty}，P75 ${s.level.p75Difficulty}，建议训练区间 ${s.level.suggestedRange?.[0]}-${s.level.suggestedRange?.[1]}`,
    );
  } else {
    L.push(`- 能力评估：难度样本不足（${s.level.solvedCount} 题），暂无法估计水平分位`);
  }
  L.push(``);
  L.push(`## 二、平台分布`);
  L.push(`| 平台 | 提交 | 涉及题数 | 通过 | 按题通过率 | 最近活跃 |`);
  L.push(`|---|---|---|---|---|---|`);
  for (const p of s.byPlatform) {
    L.push(
      `| ${p.platformName} | ${p.submissions} | ${p.problems} | ${p.solved} | ${p.problems > 0 ? fmtPct(p.solveRate) : '—'} | ${fmtTime(p.lastActiveAt)} |`,
    );
  }
  L.push(``);
  L.push(`## 三、难度分布（CF rating 统一标尺）`);
  L.push(`| 难度段 | 提交 | AC | AC 率 |`);
  L.push(`|---|---|---|---|`);
  for (const d of s.byDifficulty) {
    L.push(`| ${d.bucket} | ${d.attempts} | ${d.ac} | ${fmtPct(d.acRate)} |`);
  }
  L.push(``);
  L.push(`## 四、知识点画像`);
  if (s.topTags.length > 0) {
    L.push(`### 练习量 Top（按通过题数）`);
    L.push(`| 知识点 | 通过 | 提交 | AC 率 |`);
    L.push(`|---|---|---|---|`);
    for (const t of s.topTags) L.push(`| ${t.tag} | ${t.solved} | ${t.attempts} | ${fmtPct(t.acRate)} |`);
    L.push(``);
  }
  if (s.weakTags.length > 0) {
    L.push(`### 弱项（低于自身平均 AC 率，gap 越大越弱）`);
    for (const w of s.weakTags) {
      L.push(`- ${w.tag}：提交 ${w.attempts} 次、通过 ${w.solved} 题，AC 率 ${fmtPct(w.acRate)}（自身平均 ${fmtPct(w.avgAcRate)}，gap ${w.gap}）`);
    }
    L.push(``);
  }
  if (s.mastery.weak.length > 0) {
    L.push(`### 掌握薄弱的知识点`);
    for (const m of s.mastery.weak) {
      const detail =
        m.solved > 0
          ? `${LEVEL_LABELS[m.level]}（通过 ${m.solved} 题 / 尝试 ${m.attempts} 次，AC 率 ${fmtPct(m.acRate)}）`
          : `尝试 ${m.attempts} 次仍未通过`;
      L.push(`- ${m.tag}：${detail}`);
    }
    L.push(``);
  }
  if (s.mastery.untouchedCourseTags.length > 0) {
    L.push(`### 学习盲区（课程大纲涉及但从未练过，共 ${s.mastery.untouchedCourseTags.length} 个）`);
    L.push(s.mastery.untouchedCourseTags.slice(0, 40).join('、') + (s.mastery.untouchedCourseTags.length > 40 ? ' …' : ''));
    L.push(``);
  }
  L.push(`## 五、近 12 周训练趋势`);
  L.push(`| 周 | 提交 | AC | 通过题数 |`);
  L.push(`|---|---|---|---|`);
  for (const t of s.trend) L.push(`| ${t.week} | ${t.attempts} | ${t.ac} | ${t.solved} |`);
  L.push(``);
  if (s.recentAc.length > 0) {
    L.push(`## 六、最近通过的题（近期训练方向）`);
    for (const p of s.recentAc) {
      const parts = [`- ${p.platform}/${p.problemKey}《${p.title}》`, p.difficulty !== null ? `难度${p.difficulty}` : '难度未知', `于 ${p.solvedAt.slice(0, 10)} 通过`];
      if (p.tags.length > 0) parts.push(`标签：${p.tags.join('、')}`);
      L.push(parts.join(' | '));
    }
    L.push(``);
  }
  if (s.stuckProblems.length > 0) {
    L.push(`## 七、卡壳题（多次尝试仍未通过，适合补题/复盘）`);
    for (const p of s.stuckProblems) {
      L.push(`- ${p.platform}/${p.problemKey}《${p.title}》（难度 ${p.difficulty ?? '未知'}）：尝试 ${p.attempts} 次未通过，最后尝试 ${fmtTime(p.lastAttemptAt)}${p.url ? `，${p.url}` : ''}`);
    }
    L.push(``);
  }
  L.push(`## 八、学习系统状态`);
  L.push(
    `- 复习库：在队列 ${s.reviewQueue.total} 条，今日到期 ${s.reviewQueue.dueCount} 条`,
  );
  L.push(
    `- 模板课程：共 ${s.templates.total} 讲，已掌握 ${s.templates.mastered}、学习中 ${s.templates.learning}；${s.templates.byCategory.map((c) => `${c.name} ${c.mastered}/${c.total}`).join('，')}`,
  );
  L.push(
    `- 打卡：连续 ${s.checkins.currentStreak} 天（最长 ${s.checkins.longestStreak} 天，累计 ${s.checkins.totalDays} 天）`,
  );
  L.push(``);
  return L.join('\n');
}

/** 精简版：注入 AI 训练计划提示词（控制体积，只保留影响计划编排的信息） */
export function renderSummaryForPrompt(s: PracticeSummary): string {
  const L: string[] = [];
  L.push(
    `- 总量：提交 ${s.overall.submissions} 次 / ${s.overall.problems} 题 / 通过 ${s.overall.solved} 题；训练 ${s.range.activeDays} 天`,
  );
  if (s.level.medianDifficulty !== null) {
    L.push(
      `- 能力：AC 难度中位数 ${s.level.medianDifficulty}，建议训练区间 ${s.level.suggestedRange?.[0]}-${s.level.suggestedRange?.[1]}`,
    );
  }
  if (s.mastery.weak.length > 0) {
    L.push(
      `- 掌握薄弱：${s.mastery.weak
        .map((m) => (m.solved > 0 ? `${m.tag}(${LEVEL_LABELS[m.level]},${m.solved}题)` : `${m.tag}(尝试${m.attempts}次未通过)`))
        .join('、')}`,
    );
  }
  if (s.mastery.untouchedCourseTags.length > 0) {
    // 课程标签与平台标签词表不完全对齐，盲区列表可能很长——提示词里截断控制体积
    const tags = s.mastery.untouchedCourseTags;
    const shown = tags.slice(0, 25).join('、');
    const suffix = tags.length > 25 ? ` 等（共 ${tags.length} 个，此处仅列 25 个）` : '';
    L.push(`- 课程盲区（模板课程涉及但从未练过的知识点，可安排少量 topic 任务补齐）：${shown}${suffix}`);
  }
  if (s.recentAc.length > 0) {
    L.push(
      `- 近期在练：${s.recentAc.slice(0, 8).map((p) => `${p.problemKey}${p.difficulty !== null ? `(${p.difficulty})` : ''}`).join('、')}`,
    );
  }
  if (s.stuckProblems.length > 0) {
    L.push(`- 卡壳题（可安排重做/同类突破）：${s.stuckProblems.slice(0, 5).map((p) => `${p.platform}/${p.problemKey}×${p.attempts}`).join('、')}`);
  }
  if (s.reviewQueue.total > 0 || s.reviewQueue.dueCount > 0) {
    L.push(`- 复习库：在队列 ${s.reviewQueue.total} 条，到期 ${s.reviewQueue.dueCount} 条`);
  }
  L.push(
    `- 模板课程：已掌握 ${s.templates.mastered}/${s.templates.total}，学习中 ${s.templates.learning}`,
  );
  L.push(`- 打卡：连续 ${s.checkins.currentStreak} 天，累计 ${s.checkins.totalDays} 天`);
  return L.join('\n');
}
