import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { localToday } from '../dates.ts';
import { safeTags } from '../analysis/stats.ts';
import { computeWeakness } from '../analysis/weakness.ts';
import { knowledgeTagsCoalesceSql, knowledgeTagsJoinSql, problemKeypointsCte } from '../knowledge/store.ts';
import {
  SUPPRESSION_TIERS,
  bandRanges,
  pickBand,
  suppressedProblemIds,
  type BandRange,
  type CandidateProblem,
} from '../today/select.ts';
import { computeAbilityDetail, getAbilityOverride } from '../today/ability.ts';
import { listDueReviewItems } from '../reviews/query.ts';
import { listTodayTasks } from '../plans/todayTasks.ts';
import { IDENTITY_COLUMN_SQL, problemIdentity } from '../problems/identity.ts';
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
    : `该难度段的题近 ${BASE_COOLDOWN_DAYS} 天都推荐过，本批允许重复`;
}

export function todayRoutes(db: Db): Router {
  const r = Router();

  // GET /api/today?consolidation=&core=&challenge=&rotate=&windowDays=
  // 三档题单：题库未 AC 题 → 按能力值分档 → 弱项标签优先 → 排除近期已推荐与复习队列中的题
  // 本接口有写入副作用：返回的题记入 today_recommendations，次日选题据此冷却。
  r.get('/', (req, res) => {
    const todayStr = localToday();
    const planTasks = listTodayTasks(db, DEFAULT_USER_ID, todayStr);

    // 1) 能力值：加权解题证据模型（难度基数 × 独立完成度降权 × 通过率校准 → 缓慢校准）；
    //    AI 助手调整过的能力值（settings.ability.override）优先于计算值
    const windowDays = Math.min(365, Math.max(7, Number(req.query.windowDays) || 60));
    const ability = computeAbilityDetail(db, DEFAULT_USER_ID, windowDays);
    const override = getAbilityOverride(db);
    const level = override?.level ?? ability.level;

    // 2) 候选题：题库中有难度、未 AC 的题（提交记录里 AC 过的排除），
    //    并带出「上次推荐日期」与「是否已在复习队列」，供选题时的冷却判断使用。
    //    身份一律读 problems.identity 生成列（见 db/index.ts）：原实现每行要算 4 次
    //    CASE 表达式，三张派生小表也只能靠 SQLite 的 AUTOMATIC 临时索引连接。
    const candidates = db
      .prepare(
        `WITH ${problemKeypointsCte(db)}, solved AS (
           SELECT sp.identity AS identity
           FROM submissions s JOIN problems sp ON sp.id = s.problem_id
           WHERE s.user_id = ? AND s.verdict = 'AC' GROUP BY identity
         ), queued AS (
           SELECT rp.identity AS identity, MIN(ri.id) AS review_item_id
           FROM review_items ri JOIN problems rp ON rp.id = ri.problem_id
           WHERE ri.user_id = ? GROUP BY identity
         ), recommended AS (
           SELECT tp.identity AS identity, MAX(tr.recommended_on) AS recommended_on
           FROM today_recommendations tr JOIN problems tp ON tp.id = tr.problem_id
           WHERE tr.user_id = ? GROUP BY identity
         ), merged AS (
           -- 三张派生表按 identity 合并成一张：候选行只做一次 LEFT JOIN、也只建一次临时索引
           SELECT identity, 1 AS solved, NULL AS review_item_id, NULL AS recommended_on FROM solved
           UNION ALL SELECT identity, 0, review_item_id, NULL FROM queued
           UNION ALL SELECT identity, 0, NULL, recommended_on FROM recommended
         ), agg AS (
           SELECT identity, MAX(solved) AS solved,
                  MIN(review_item_id) AS review_item_id, MAX(recommended_on) AS recommended_on
             FROM merged GROUP BY identity
         )
         SELECT p.id, p.platform, p.problem_key, p.title, p.difficulty, p.url,
                ${knowledgeTagsCoalesceSql()},
                agg.review_item_id, agg.recommended_on,
                agg.review_item_id IS NOT NULL AS in_review
           FROM problems p ${knowledgeTagsJoinSql()}
           LEFT JOIN agg ON agg.identity = ${IDENTITY_COLUMN_SQL}
          WHERE p.difficulty IS NOT NULL
            AND (agg.solved IS NULL OR agg.solved = 0)
          ORDER BY p.id`,
      )
      .all(DEFAULT_USER_ID, DEFAULT_USER_ID, DEFAULT_USER_ID) as unknown as Array<
        Omit<CandidateProblem, 'tags' | 'recommendedOn' | 'inReview'> & {
          tags: string;
          review_item_id: number | null;
          recommended_on: string | null;
          in_review: number;
        }
      >;
    const plannedKeys = new Set(planTasks.filter((t) => t.platform && t.problem_key).map((t) => problemIdentity({ platform: t.platform!, problemKey: t.problem_key! })));
    // 同题只保留一个入口，优先原生平台；镜像也共用冷却、复习与计划排除。
    const unique = new Map<string, typeof candidates[number]>();
    for (const c of candidates) {
      const identity = problemIdentity({ platform: c.platform, problemKey: c.problem_key });
      if (plannedKeys.has(identity)) continue;
      const previous = unique.get(identity);
      if (!previous || (c.platform === identity.split(':')[0] && previous.platform !== c.platform)) unique.set(identity, c);
    }
    const pool: CandidateProblem[] = [...unique.values()].map(
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
    const weakTags = weakness.items.filter((i) => (i.evidenceGap ?? i.gap) > 0).map((i) => i.tag);

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
      // 空串不算显式 0：?core= 是「没给值」（取默认档量），Number('') === 0 会把该档悄悄清空
      const raw = req.query[key];
      const q = raw === undefined || raw === '' ? NaN : Number(raw);
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

    // 6) 到期复习条目 + 今日计划进度
    //    条目本身要带出来（不只是计数）：三档题单刻意排除了复习队列中的题，
    //    若只回数字，用户知道「有 3 道该复习」却不知道是哪几道，还得自己跑去复习库翻。
    const dueReviewItems = listDueReviewItems(db, DEFAULT_USER_ID, todayStr);
    const planProgressRow = { total: planTasks.length, checked: planTasks.filter((t) => t.checked).length };

    res.json({
      date: todayStr,
      level,
      levelComputed: ability.level,
      levelDetail: ability.detail,
      levelOverride: override,
      cooldownDays: BASE_COOLDOWN_DAYS,
      bands,
      dueReviews: dueReviewItems.length,
      dueReviewItems,
      planTasks,
      planProgress: planProgressRow.total > 0 ? { total: planProgressRow.total, checked: planProgressRow.checked } : null,
    });
  });

  return r;
}

/** 供测试与后续挂件复用的类型收窄（不参与运行时） */
export type { TodayProblem };
