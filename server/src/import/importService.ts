import type { NormalizedSubmission, PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { annotateProblemsL1 } from '../knowledge/pipeline.ts';
import { problemUpsertSql, purifyTags } from './problemWritePolicy.ts';
import { createTombstoneMatcher } from './tombstones.ts';

export interface InsertResult {
  imported: number;
  skipped: number;
}

/**
 * language 列兜底守卫（同步与导入共用此写入路径）：
 * 平台把语言下发成数字（洛谷的 langId）或 CSV/Excel 单元格带 ".0" 尾巴时，原样绑进
 * TEXT 列会被 SQLite 按 REAL 渲染成 "34.0"——既不是语言名，又会被界面当成名字展示。
 * 纯数字统一收成整数字符串；真实语言名（含 "C++23 (GCC 15.2.0)" 这类带点号的）原样保留。
 * 注：非整数数字（如 "34.5"）按截断取整——平台 langId 恒为整数，此处不为不可能的形态加分支。
 */
export function normalizeLanguageCell(v: string | number | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return /^\d+(\.\d+)?$/.test(s) ? String(Math.trunc(Number(s))) : s;
}

/**
 * 将统一 Submission 结构写入数据库（单事务）：
 * - problems 按 (platform, problem_key) upsert（标题/难度/链接/tags 更新）
 * - submissions 按 (user_id, platform, external_id) INSERT OR IGNORE 去重
 * - opts.clearPlatform：先删除该平台旧提交再插入（换账号场景，保证原子性）
 * 供平台同步与手动导入共用。
 *
 * 删除墓碑（deleted_problems，见 schema.sql）：同步来源命中墓碑 → 题目与提交一起跳过，
 * 被用户删掉的题不会被下次同步原样复活；手动导入（externalId manual:）视为显式找回，
 * 清墓碑后照常入库；clearPlatform 换账号重置连同该平台墓碑一起清空。
 * 「命中」的口径（精确同键 / 等价类是否还剩活行）见 tombstones.ts，与题库入库共用一份。
 *
 * 难度与标签的统一策略见 problemWritePolicy.ts：
 * - 难度按来源优先级（manual > backfill > sync > bank）覆盖，手动导入(manual:)标记为 manual 来源
 * - 标签**写入即净化**（噪声过滤 + 同义词归并），non-empty 覆盖空值；适配器拿不到标签时保留库内已有
 */
export function insertNormalized(
  db: Db,
  userId: number,
  subs: NormalizedSubmission[],
  opts: { clearPlatform?: PlatformId } = {},
): InsertResult {
  const upsertSync = db.prepare(problemUpsertSql('sync'));
  const upsertManual = db.prepare(problemUpsertSql('manual'));
  const insertSub = db.prepare(
    `INSERT OR IGNORE INTO submissions
       (user_id, platform, problem_id, verdict, language, submitted_at, external_id, context)
     VALUES (?, ?, (SELECT id FROM problems WHERE platform = ? AND problem_key = ?), ?, ?, ?, ?, ?)`,
  );
  // 老行回填语境：INSERT OR IGNORE 会跳过已存在的外部提交号，而 context 列是后加的
  //（历史行全为 NULL）。同步数据天然重复出现，跳过插入时顺手把语境补上，下次同步即完成回填。
  const backfillContext = db.prepare(
    `UPDATE submissions SET context = ?
       WHERE user_id = ? AND platform = ? AND external_id = ? AND context IS NULL`,
  );
  // 平台侧改判刷新：同提交号再次同步时 verdict 若有变化（评测中→终态、平台重判等），
  // 更新既有行——verdict 以平台数据为准。没有这条路径，「评测中曾被落库为 WA/SKIPPED」的提交
  // 会被 INSERT OR IGNORE 永久冻结在旧判定上（该行的真实结果永远进不了库）。
  const refreshVerdict = db.prepare(
    `UPDATE submissions SET verdict = ?
       WHERE user_id = ? AND platform = ? AND external_id = ? AND verdict IS NOT ?`,
  );
  const findProblem = db.prepare('SELECT id, title, tags FROM problems WHERE platform = ? AND problem_key = ?');
  // 墓碑匹配口径（含「等价类还有活行时只挡精确同键」）见 tombstones.ts：与题库入库共用一份
  const tombstones = createTombstoneMatcher(db);
  const clearDeletedMark = db.prepare(
    "DELETE FROM deleted_problems WHERE platform = ? AND normalized_key = LOWER(REPLACE(?, ' ', ''))",
  );
  // 手动导入（externalId 以 manual: 开头）与平台同步数据协调：
  // 同平台同题同结果已存在（无论来源是同步还是手动）→ 跳过，避免重复计数
  const manualDup = db.prepare(
    `SELECT 1 FROM submissions s JOIN problems p ON s.problem_id = p.id
     WHERE s.user_id = ? AND s.platform = ? AND p.problem_key = ? AND s.verdict = ?
     LIMIT 1`,
  );

  let imported = 0;
  let skipped = 0;
  const newProblems: Array<{ platform: string; problemKey: string; title: string; tags: string }> = [];
  db.exec('BEGIN');
  try {
    if (opts.clearPlatform) {
      db.prepare('DELETE FROM submissions WHERE user_id = ? AND platform = ?').run(
        userId,
        opts.clearPlatform,
      );
      // 换账号是全平台重置：旧账号留下的删除墓碑一并清空，否则新账号的提交会被静默丢弃
      db.prepare('DELETE FROM deleted_problems WHERE platform = ?').run(opts.clearPlatform);
      tombstones.forget(opts.clearPlatform);
    }
    for (const s of subs) {
      const isManual = String(s.externalId).startsWith('manual:');
      if (tombstones.isDeleted(s.problem.platform, s.problem.problemKey)) {
        if (isManual) {
          // 手动导入 = 用户显式找回这道题：清掉整等价类墓碑后照常入库
          clearDeletedMark.run(s.problem.platform, s.problem.problemKey);
          tombstones.forget(s.problem.platform);
        } else {
          skipped += 1;
          continue;
        }
      }
      const source = isManual ? 'manual' : 'sync';
      (isManual ? upsertManual : upsertSync).run(
        s.problem.platform,
        s.problem.problemKey,
        s.problem.title,
        s.problem.difficulty ?? null,
        s.problem.url ?? null,
        JSON.stringify(purifyTags(s.problem.tags)),
        source,
        s.problem.nativeDifficulty ?? null,
        s.problem.difficultyScale ?? null,
      );
      const problem = findProblem.get(s.problem.platform, s.problem.problemKey) as {
        id: number;
        title: string;
        tags: string;
      };
      // tags 取**库内落定值**（写入即净化，且非空才覆盖 → 可能与本次入参不同）：
      // tag 来源标注必须按实际落库的标签做映射
      newProblems.push({
        platform: s.problem.platform,
        problemKey: s.problem.problemKey,
        title: problem.title,
        tags: problem.tags,
      });
      // 手动导入协调：同题同结果已存在 → 跳过（不再重复计入）
      if (isManual) {
        const dup = manualDup.get(
          userId,
          s.problem.platform,
          s.problem.problemKey,
          s.verdict,
        );
        if (dup) {
          skipped += 1;
          continue;
        }
      }
      const r = insertSub.run(
        userId,
        s.problem.platform,
        s.problem.platform,
        s.problem.problemKey,
        s.verdict,
        normalizeLanguageCell(s.language),
        s.submittedAt,
        s.externalId,
        s.context ?? null,
      );
      if (r.changes > 0) imported += 1;
      else {
        skipped += 1;
        // 已存在的外部提交号：补语境列（见 backfillContext 注释）并检测平台侧改判
        if (s.context) backfillContext.run(s.context, userId, s.problem.platform, s.externalId);
        if (
          refreshVerdict
            .run(s.verdict, userId, s.problem.platform, s.externalId, s.verdict)
            .changes > 0
        ) {
          // verdict 实际变化：计入 imported（一次有效写入），同步中心可见
          imported += 1;
          skipped -= 1;
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // 知识点管线增量：新题跑 L1 规则标注（未命中入 L2 队列）；标注失败不影响导入结果
  try {
    annotateProblemsL1(db, newProblems);
  } catch (e) {
    console.error(`[knowledge] 导入后 L1 标注失败（不影响导入）: ${(e as Error).message}`);
  }
  return { imported, skipped };
}
