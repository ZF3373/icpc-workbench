import type { NormalizedSubmission, PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { annotateProblemsL1 } from '../knowledge/pipeline.ts';
import { problemUpsertSql, purifyTags } from './problemWritePolicy.ts';
import { mergeProblemRow } from './problemMerge.ts';
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
 * - submissions 按 (user_id, platform, account, external_id) INSERT OR IGNORE 去重；
 *   去重命中时检测平台侧改题号（洛谷比赛 T 号 → 赛后 P 号），变了则把旧题行并入新键行
 *   并重定向既有提交（见 import/problemMerge.ts），与改判刷新同属「既有行不冻结」口径
 * - opts.account：归属账号 handle（多账号隔离）；省略 = 手动导入等无账号来源（account NULL）
 * - opts.clearPlatform：先删除该平台旧提交再插入（保留给显式重置场景；多账号同步不再清库）
 * 供平台同步与手动导入共用。
 *
 * 删除墓碑（deleted_problems，见 schema.sql）：同步来源命中墓碑 → 题目与提交一起跳过，
 * 被用户删掉的题不会被下次同步原样复活；手动导入（externalId manual:）视为显式找回，
 * 清墓碑后照常入库；clearPlatform 重置连同该平台墓碑一起清空。
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
  opts: { account?: string | null; clearPlatform?: PlatformId } = {},
): InsertResult {
  const upsertSync = db.prepare(problemUpsertSql('sync'));
  const upsertManual = db.prepare(problemUpsertSql('manual'));
  // 空串 = 无账号来源（手动导入/本地）；不用 NULL——UNIQUE 约束视 NULL 互异，会破坏按键去重
  const account = opts.account ?? '';
  const insertSub = db.prepare(
    `INSERT OR IGNORE INTO submissions
       (user_id, platform, account, problem_id, verdict, language, submitted_at, external_id, context)
     VALUES (?, ?, ?, (SELECT id FROM problems WHERE platform = ? AND problem_key = ?), ?, ?, ?, ?, ?)`,
  );
  // 老行回填语境：INSERT OR IGNORE 会跳过已存在的同账号提交号，而 context 列是后加的
  //（历史行全为 NULL）。同步数据天然重复出现，跳过插入时顺手把语境补上，下次同步即完成回填。
  const backfillContext = db.prepare(
    `UPDATE submissions SET context = ?
       WHERE user_id = ? AND platform = ? AND account = ? AND external_id = ? AND context IS NULL`,
  );
  // 平台侧改判刷新：同账号同提交号再次同步时 verdict 若有变化（评测中→终态、平台重判等），
  // 更新既有行——verdict 以平台数据为准。没有这条路径，「评测中曾被落库为 WA/SKIPPED」的提交
  // 会被 INSERT OR IGNORE 永久冻结在旧判定上（该行的真实结果永远进不了库）。
  const refreshVerdict = db.prepare(
    `UPDATE submissions SET verdict = ?
       WHERE user_id = ? AND platform = ? AND account = ? AND external_id = ? AND verdict IS NOT ?`,
  );
  const findProblem = db.prepare('SELECT id, title, tags FROM problems WHERE platform = ? AND problem_key = ?');
  // 平台侧改题号检测：同提交号既有行当前指向的题目键（洛谷比赛 T 号 → 赛后正式 P 号等）
  const findSubmittedProblem = db.prepare(
    `SELECT p.id, p.problem_key AS problemKey
       FROM submissions s JOIN problems p ON p.id = s.problem_id
      WHERE s.user_id = ? AND s.platform = ? AND s.account = ? AND s.external_id = ?`,
  );
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
      // 全平台重置：旧数据留下的删除墓碑一并清空，否则后续提交会被静默丢弃
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
        account,
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
        // 已存在的同账号提交号：本行先按「跳过」记账，下面两条修复路径任一命中就改判为
        // 「一次有效写入」。用 effective 累积、在末尾**统一结账** —— 原实现在两处各自
        // `skipped -= 1`，一行同时命中「平台改题号」与「平台改判定」时 skipped 被扣两次，
        // 实测返回 {"imported":2,"skipped":-1}（一次逻辑提交被算成两条新增、跳过数为负）。
        let effective = false;
        // 补语境列（见 backfillContext 注释）
        if (s.context) backfillContext.run(s.context, userId, s.problem.platform, account, s.externalId);
        // 平台侧改题号（洛谷比赛题赛后 T 号转正式 P 号等）：既有行被 INSERT OR IGNORE
        // 冻结在失效的旧题行上（链接打不开、标题退化为题号），把旧题行并入新键行、
        // 提交重定向过去——旧键行从此不再下发，记墓碑防止迟到的旧键提交拽回死链
        const submitted = findSubmittedProblem.get(
          userId,
          s.problem.platform,
          account,
          s.externalId,
        ) as { id: number; problemKey: string } | undefined;
        if (submitted && submitted.problemKey !== s.problem.problemKey) {
          mergeProblemRow(db, {
            platform: s.problem.platform,
            fromId: submitted.id,
            fromKey: submitted.problemKey,
            toId: problem.id,
            toKey: s.problem.problemKey,
          });
          // 合并写入了新墓碑：失效该平台的墓碑缓存，让本批后续行看到一致状态
          tombstones.forget(s.problem.platform);
          effective = true;
        }
        // verdict 实际变化（评测中→终态、平台重判）同样是有效写入
        if (
          refreshVerdict
            .run(s.verdict, userId, s.problem.platform, account, s.externalId, s.verdict)
            .changes > 0
        ) {
          effective = true;
        }
        if (effective) imported += 1;
        else skipped += 1;
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
