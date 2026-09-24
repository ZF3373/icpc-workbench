import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { localToday } from '../dates.ts';
import { safeTags } from '../analysis/stats.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { knowledgeTagsSql } from '../knowledge/store.ts';
import {
  SUPPRESSION_TIERS,
  bandRanges,
  pickBand,
  suppressedProblemIds,
  type BandRange,
  type CandidateProblem,
} from '../today/select.ts';
import { computeAbilityDetail, getAbilityOverride } from '../today/ability.ts';
import type { TodayBandKey, TodayProblem } from '../../../shared/src/index.ts';

/** 每档默认题量：巩固 2 / 同段 3 / 挑战 1（cf-compass 同段承担主训练量） */
const DEFAULT_COUNTS: Record<TodayBandKey, number> = {
  consolidation: 2,
  core: 3,
  challenge: 1,
};

const BAND_KEYS: TodayBandKey[] = ['consolidation', 'core', 'challenge'];

/** 最严档（默认冷却窗口）天数，写进响应供前端说明「近 N 天不重复推荐」 */
const BASE_COOLDOWN_DAYS = SUPPRESSION_TIERS[0].cooldownDays;

/**
 * 放宽说明：index 0（最严档）返回 null 表示按标准规则出题。
 * 最松档同时放开了冷却与复习排除，要说清到底是哪一条起了作用。
 */
function relaxNote(index: number, bandHasReviewCandidate: boolean): string | null {
  if (index === 0) return null;
  const tier = SUPPRESSION_TIERS[index];
  if (!tier.excludeReview) {
    return bandHasReviewCandidate
      ? '该难度段候选题太少，复习队列中的题也重新参与推荐'
      : '该难度段候选题太少，取消冷却限制以凑齐题量';
  }
  return tier.cooldownDays > 0
    ? `近 ${tier.cooldownDays} 天内推荐过的题不足，冷却窗口放宽`
    : '该难度段的题近 14 天都推荐过，本批允许重复';
}

export function todayRoutes(db: Db): Router {
  const r = Router();

  // GET /api/today?consolidation=&core=&challenge=&rotate=&windowDays=
  // 三档题单：题库未 AC 题 → 按能力值分档 → 弱项标签优先 → 排除近期已推荐与复习队列中的题
  // 本接口有写入副作用：返回的题记入 today_recommendations，次日选题据此冷却。
  r.get('/', (req, res) => {
    const todayStr = localToday();

    // 1) 能力值：加权解题证据模型（难度基数 × 独立完成度降权 × 通过率校准 → 缓慢校准）；
    //    AI 助手调整过的能力值（settings.ability.override）优先于计算值
    const windowDays = Math.min(365, Math.max(7, Number(req.query.windowDays) || 60));
    const ability = computeAbilityDetail(db, DEFAULT_USER_ID, windowDays);
    const override = getAbilityOverride(db);
    const level = override?.level ?? ability.level;

    // 2) 候选题：题库中有难度、未 AC 的题（提交记录里 AC 过的排除），
    //    并带出「上次推荐日期」与「是否已在复习队列」，供选题时的冷却判断使用
    const candidates = db
      .prepare(
        `SELECT p.id, p.platform, p.problem_key, p.title, p.difficulty, p.url,
                ${knowledgeTagsSql(db)},
                (SELECT ri.id FROM review_items ri
                  WHERE ri.problem_id = p.id AND ri.user_id = ${DEFAULT_USER_ID}) AS review_item_id,
                (SELECT tr.recommended_on FROM today_recommendations tr
                  WHERE tr.user_id = ? AND tr.problem_id = p.id) AS recommended_on,
                EXISTS (SELECT 1 FROM review_items ri
                  WHERE ri.user_id = ? AND ri.problem_id = p.id) AS in_review
           FROM problems p
          WHERE p.difficulty IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM submissions s
               WHERE s.problem_id = p.id AND s.user_id = ? AND s.verdict = 'AC'
            )`,
      )
      .all(DEFAULT_USER_ID, DEFAULT_USER_ID, DEFAULT_USER_ID) as unknown as Array<
        Omit<CandidateProblem, 'tags' | 'recommendedOn' | 'inReview'> & {
          tags: string;
          review_item_id: number | null;
          recommended_on: string | null;
          in_review: number;
        }
      >;
    const pool: CandidateProblem[] = candidates.map(
      ({ review_item_id, recommended_on, in_review, tags, ...c }) => ({
        ...c,
        tags: safeTags(tags),
        reviewItemId: review_item_id ?? null,
        recommendedOn: recommended_on,
        inReview: in_review === 1,
      }),
    );

    // 3) 弱项标签（gap > 0 才算弱）
    const weakness = computeWeakness(db, DEFAULT_USER_ID, { minAttempts: 5, topN: 15 });
    const weakTags = weakness.items.filter((i) => i.gap > 0).map((i) => i.tag);

    // 4) 逐档选题（跨档去重 + rotate 整批平移 + 从严到松取第一个够数的冷却档）
    const ranges = bandRanges(level);
    const rotate = Math.max(0, Math.min(500, Number(req.query.rotate) || 0));
    const tierSuppressed = SUPPRESSION_TIERS.map((tier) => suppressedProblemIds(pool, tier, todayStr));
    const byId = new Map(pool.map((c) => [c.id, c]));
    const inBand = (id: number, r: BandRange) => {
      const c = byId.get(id);
      return (
        !!c &&
        c.difficulty != null &&
        r.min != null &&
        r.max != null &&
        c.difficulty >= r.min &&
        c.difficulty <= r.max
      );
    };
    const reviewIds = pool.filter((c) => c.inReview).map((c) => c.id);
    const exclude = new Set<number>();
    const loosest = SUPPRESSION_TIERS.length - 1;
    const bands = BAND_KEYS.map((key) => {
      const q = Number(req.query[key]);
      const count = Number.isInteger(q) && q >= 0 && q <= 6 ? q : DEFAULT_COUNTS[key];
      const pickAt = (tierIndex: number) => {
        const excl = new Set(exclude);
        for (const id of tierSuppressed[tierIndex]) excl.add(id);
        return pickBand(pool, ranges[key], count, weakTags, excl, rotate);
      };
      let tierIndex = 0;
      let picked = pickAt(0);
      // 冷却排得太干净会出空档，宁可提前重复：逐级放宽直到够数或放到最松一档
      while (tierIndex < loosest && picked.problems.length < count) {
        tierIndex += 1;
        picked = pickAt(tierIndex);
      }
      for (const p of picked.problems) exclude.add(p.id);
      // 该档一题未出时不说放宽原因：那就是池子为空，空态提示已经说明得很清楚
      const relaxed =
        tierIndex === 0 || picked.problems.length === 0
          ? null
          : relaxNote(
              tierIndex,
              reviewIds.some((id) => inBand(id, ranges[key])),
            );
      return { key, label: ranges[key].label, description: ranges[key].description, range: [ranges[key].min, ranges[key].max] as [number | null, number | null], problems: picked.problems, pool: picked.pool, relaxed };
    });

    // 5) 记下本批实际展示的题（未采用的候选不算「推荐过」）。
    //    同日重复请求覆盖同一条 recommended_on，因此反复刷新不会额外消耗冷却队列。
    const insertReco = db.prepare(
      `INSERT INTO today_recommendations (user_id, problem_id, recommended_on, band)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, problem_id)
       DO UPDATE SET recommended_on = excluded.recommended_on, band = excluded.band`,
    );
    db.exec('BEGIN');
    try {
      for (const band of bands) {
        for (const p of band.problems) insertReco.run(DEFAULT_USER_ID, p.id, todayStr, band.key);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    // 6) 到期复习数 + 今日计划进度
    const dueReviews = (
      db
        .prepare('SELECT COUNT(*) AS c FROM review_items WHERE user_id = ? AND next_due_on <= ?')
        .get(DEFAULT_USER_ID, todayStr) as { c: number }
    ).c;
    const planProgressRow = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM((SELECT 1 FROM checkins c WHERE c.task_id = t.id)), 0) AS checked
           FROM plan_tasks t WHERE t.task_date = ?`,
      )
      .get(todayStr) as { total: number; checked: number };

    res.json({
      date: todayStr,
      level,
      levelComputed: ability.level,
      levelDetail: ability.detail,
      levelOverride: override,
      cooldownDays: BASE_COOLDOWN_DAYS,
      bands,
      dueReviews,
      planProgress: planProgressRow.total > 0 ? { total: planProgressRow.total, checked: planProgressRow.checked } : null,
    });
  });

  return r;
}

/** 供测试与后续挂件复用的类型收窄（不参与运行时） */
export type { TodayProblem };
