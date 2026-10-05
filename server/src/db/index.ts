import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, type PlatformId } from '../../../shared/src/index.ts';
import { problemSetMatchesContest } from '../contests/problemSetShape.ts';
import { atcoderProblemIdCandidates } from '../adapters/problemKey.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** SEA 单文件分发时 schema 由入口（sea.ts）内嵌注入，不再读磁盘 */
let schemaOverride: string | null = null;

export function setSchemaSql(sql: string): void {
  schemaOverride = sql;
}

export type Db = DatabaseSync;

/**
 * 打开（或创建）SQLite 数据库并执行 schema 与种子数据。
 * 使用 Node 内置 node:sqlite（DatabaseSync），零原生依赖。
 */
export function createDb(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schemaOverride ?? fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  seed(db);
  return db;
}

/**
 * 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给老库补新列，
 * 这里按 PRAGMA table_info 检查缺列后 ALTER TABLE 补齐；
 * 数据修复类迁移必须幂等（重复打开同一库不再产生变化）。
 */
function migrate(db: Db): void {
  const columnsOf = (table: string): Set<string> => {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(info.map((c) => c.name));
  };
  // v0.3: template_progress 增加用户写入的模板内容列
  const progressCols = columnsOf('template_progress');
  for (const col of ['code', 'idea', 'complexity', 'url']) {
    if (!progressCols.has(col)) db.exec(`ALTER TABLE template_progress ADD COLUMN ${col} TEXT`);
  }
  // v0.5: problem_lists 增加 AI 建议缓存列（避免每次点击都重新调 AI）
  const listCols = columnsOf('problem_lists');
  if (!listCols.has('ai_suggestion')) db.exec('ALTER TABLE problem_lists ADD COLUMN ai_suggestion TEXT');
  if (!listCols.has('ai_suggestion_at')) db.exec('ALTER TABLE problem_lists ADD COLUMN ai_suggestion_at TEXT');
  // v0.6: platform_accounts 增加分批同步标记（提交过多时分批拉取防封号；1=仍有更早历史待补全）
  const accountCols = columnsOf('platform_accounts');
  if (!accountCols.has('sync_truncated')) db.exec('ALTER TABLE platform_accounts ADD COLUMN sync_truncated INTEGER NOT NULL DEFAULT 0');
  if (!accountCols.has('backfill_page')) db.exec('ALTER TABLE platform_accounts ADD COLUMN backfill_page INTEGER');
  // v0.5.2: 知识点标注记录「标注当时的标题」，标题被修复后可触发重跑（差量重跑依据之一）
  const keypointCols = columnsOf('problem_keypoints');
  if (!keypointCols.has('annotated_title')) db.exec('ALTER TABLE problem_keypoints ADD COLUMN annotated_title TEXT');
  // v0.5.2: 难度来源标记，消除「题库 upsert 保留旧值 / 同步 upsert 采用新值」的相反优先级
  const problemCols = columnsOf('problems');
  if (!problemCols.has('difficulty_source')) {
    db.exec('ALTER TABLE problems ADD COLUMN difficulty_source TEXT');
    // 历史行来源未知：按 'sync' 视之（优先级 2），保持既有行为不变
    db.exec("UPDATE problems SET difficulty_source = 'sync' WHERE difficulty IS NOT NULL");
  }
  // v0.6: 难度双标度——保留平台原生难度原文与所属标度（便于平台改档后重算 + UI 展示）
  if (!problemCols.has('native_difficulty')) db.exec('ALTER TABLE problems ADD COLUMN native_difficulty TEXT');
  if (!problemCols.has('difficulty_scale')) db.exec('ALTER TABLE problems ADD COLUMN difficulty_scale TEXT');
  // v0.6.1: 「上游确认没有」的负缓存列（回填不再每轮重查同一批无解的行）
  if (!problemCols.has('gap_state')) db.exec('ALTER TABLE problems ADD COLUMN gap_state TEXT');
  if (!problemCols.has('gap_checked_at')) db.exec('ALTER TABLE problems ADD COLUMN gap_checked_at TEXT');
  // 题目删除墓碑的题目快照列（回收站恢复依据）；无表则 schema.sql 已建全列，这里只补老表
  const tombstoneCols = columnsOf('deleted_problems');
  for (const col of ['title', 'url', 'tags', 'difficulty_source', 'native_difficulty', 'difficulty_scale']) {
    if (tombstoneCols.size > 0 && !tombstoneCols.has(col)) db.exec(`ALTER TABLE deleted_problems ADD COLUMN ${col} TEXT`);
  }
  if (tombstoneCols.size > 0 && !tombstoneCols.has('difficulty')) db.exec('ALTER TABLE deleted_problems ADD COLUMN difficulty INTEGER');
  // 墓碑归一化键（与 clean-tags NORMALIZED_KEY_SQL 同口径）：老行回填一次即可
  if (tombstoneCols.size > 0 && !tombstoneCols.has('normalized_key')) {
    db.exec('ALTER TABLE deleted_problems ADD COLUMN normalized_key TEXT');
    db.exec("UPDATE deleted_problems SET normalized_key = LOWER(REPLACE(problem_key, ' ', '')) WHERE normalized_key IS NULL");
  }
  // 赛后复盘·参赛记录的题目集列（JSON 数组）：归因排歧——窗口内的非本场题目（日常练习）不归因
  const participatedCols = columnsOf('participated_contests');
  if (participatedCols.size > 0 && !participatedCols.has('problem_ids')) {
    db.exec('ALTER TABLE participated_contests ADD COLUMN problem_ids TEXT');
  }
  // v0.9: 题目集三态——区分「已拉取确认无题」与「未拉取」，避免空题目集场次被无限重复拉取
  if (participatedCols.size > 0 && !participatedCols.has('problem_set_state')) {
    db.exec('ALTER TABLE participated_contests ADD COLUMN problem_set_state TEXT');
  }
  // v0.9.1 数据修复：参赛记录题目集「串台」清理（见下）
  clearForeignProblemSets(db);
    // v0.7: submissions 增加提交语境列（contest/virtual/practice，目前仅 Codeforces 下发）：
  // 能力值算法据此区分赛场 AC 与赛后补题，补题/练习题降权
  const submissionCols = columnsOf('submissions');
  if (!submissionCols.has('context')) db.exec('ALTER TABLE submissions ADD COLUMN context TEXT');
  // v0.8: 多账号支持——submissions 增加 account 列且唯一键扩为 (user_id, platform, account, external_id)；
  // platform_accounts 唯一键从 (user_id, platform) 扩为 (user_id, platform, handle)。
  // SQLite 无法修改约束，两表都需要重建（先补 context 列再重建，保证老库两步迁移一步到位）。
  if (!submissionCols.has('account')) rebuildSubmissionsForMultiAccount(db);
  rebuildAccountsForMultiAccount(db);
  // 按账号增量过滤的索引：新库（schema 已有 account）与迁移后的老库都在这里补齐
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_user_account ON submissions(user_id, platform, account)');
  // 清理旧版冗余索引：idx_submissions_user_platform(user_id, platform) 是上面复合索引的严格前缀，
  // 每条提交 INSERT 都要多维护一个索引；SQLite 用复合索引前缀即可服务 (user_id, platform) 过滤。
  db.exec('DROP INDEX IF EXISTS idx_submissions_user_platform');
  db.exec('CREATE INDEX IF NOT EXISTS idx_deleted_problems_norm ON deleted_problems(platform, normalized_key)');
  mergeSlashedCfKeys(db);
  // v0.4.5 数据修复：洛谷秒级时间戳曾被按毫秒解析（见 fixLuoguTimestamps）
  fixLuoguTimestamps(db);
  // v0.6.1 数据修复：洛谷 language 是数字 langId，曾被绑成 REAL 存成 "34.0"（见 fixLuoguLanguageIds）
  fixLuoguLanguageIds(db);
  // v0.6.2 数据修复：去重合并（mergeSlashedCfKeys / clean-tags 重复清理）把复习条目重指到保留行时，
  // 老库残留过同一 (user_id, problem_id) 的多行。schema 的 UNIQUE 保证新库不会产生重复，但已存在的
  // 重复不会被自动清除，而「是否在复习队列」的标量子查询只取第一行，会让另一条永久无法移出。这里补齐唯一性。
  dedupeReviewItems(db);
  // v0.10 数据修复：作废「题号形态不可信」的难度定论（见下）
  invalidateUnreliableGapVerdicts(db);
}

/**
 * 本次修复（AtCoder 题号归一 + 定论形态校验）的生效时刻。
 * 早于它的定论按**旧判据**写下，作废一次；修复后重新写下的定论带新时刻，不再被清 → 迁移幂等。
 */
const GAP_VERDICT_CUTOFF = '2026-09-28T00:00:00.000Z';

/**
 * v0.10 数据修复：作废「形态不可信」的 `problems.gap_state` 定论（2026-09-28）。
 *
 * 事故：AtCoder 库内题号是**展示形态** `abc300a`，kenkoooo 整表是 `abc300_a` → 整表查不到；
 * 而 AtCoder 属于「单次响应即完整题库」（`ABSENCE_IS_DEFINITIVE`），这个 miss 被当成定论写下
 * 30 天负缓存 —— 本机 demo 库 90 行 AtCoder 缺口全部由此被锁（其中 64 行的题号只差一个下划线），
 * 且 `difficulty` 维度要求「难度 + 原生原文」都有值，所以这些行会在「每 30 天重查一次、又必查不到」
 * 的循环里永远补不上 `native_difficulty`。
 *
 * 查询侧现在已加题号归一（`adapters/problemKey.ts` 的 `atcoderProblemIdCandidates`）与定论形态校验
 * （`analysis/difficultyBackfill.ts` 的 `absenceIsDefinitive`），但**已经写下的定论会把行挡在回填目标
 * 之外** —— 不点一次「强制重查」就永远解不开。所以这里把旧判据写下的定论一次性作废，
 * 下一次回填自然就会重查：AtCoder 是整表型（一次请求拿全库、逐题只查内存），重查的代价是多一次
 * 整表请求，不会逐题打上游，也不会波及逐题型平台（洛谷/牛客的定论一条都不动）。
 *
 * 判据（保守：宁可多查一次，不可继续误锁）：
 * - atcoder：库内题号**还有别的合法形态**（无下划线 → 补下划线后可能就是整表里的题号）。
 *   代价是 `joi2011ho1` 这类**原生**无下划线的题号也会被作废一次（候选表有两种形态，迁移里
 *   无法区分），下次回填重查一次即回到原结论 —— 整表平台重查不额外发逐题请求，可以接受。
 * - codeforces 不在此列：查表前本就有大写归一，题号形态不会造成 miss（CF 的 `92101` 这类
 *   纯数字键还可能是合法表键），没有需要作废的误判。
 * 幂等：清掉的行若下次仍查不到，会带**新时刻**重新写下定论（> 本次修复时刻），不会再被清。
 */
function invalidateUnreliableGapVerdicts(db: Db): void {
  const rows = db
    .prepare(
      `SELECT problem_key FROM problems
        WHERE platform = 'atcoder' AND gap_state IS NOT NULL
          AND (gap_checked_at IS NULL OR gap_checked_at < ?)`,
    )
    .all(GAP_VERDICT_CUTOFF) as unknown as Array<{ problem_key: string }>;
  const unreliable = rows.filter((r) => atcoderProblemIdCandidates(r.problem_key).length > 1);
  if (unreliable.length === 0) return;
  const clear = db.prepare(
    "UPDATE problems SET gap_state = NULL, gap_checked_at = NULL WHERE platform = 'atcoder' AND problem_key = ?",
  );
  db.exec('BEGIN');
  try {
    for (const r of unreliable) clear.run(r.problem_key);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(
    `[migrate] 已作废 ${unreliable.length} 条题号形态不可信的 AtCoder 难度定论（下一次回填会重新查证）`,
  );
}

/**
 * v0.9.1 数据修复：参赛记录题目集「串台」清理。
 *
 * 事故：`enrichProblems` 同步参赛记录时无条件调用**牛客**题目集接口，而它被所有平台共用，
 * 于是数字型 contestId 的 Codeforces 场次（2266/2244/2241/2231/2227/2218）把「牛客同号比赛」
 * 的题目集写了进去（CF 2241 存进 20 道牛客「小乐乐」系列题）。表现为赛事中心显示「20 题」、
 * 复盘列出并不存在于该场的未提交题，且该集合被判为"富题目集"后永不重拉。
 *
 * 这里把**明显不属于该场**的存储题目集清空（problem_ids = NULL、problem_set_state = NULL），
 * 下一次复盘就会用正确的平台接口重拉。判定只做「按 key 前缀」这一条 —— 宁可放过，不可误删；
 * 空 id / 解析失败的行保持原样（另有读取期校验兜底）。迁移幂等：清空后再跑不再产生变化。
 */
function clearForeignProblemSets(db: Db): void {
  const rows = db
    .prepare(
      `SELECT platform, contest_id, problem_ids FROM participated_contests
       WHERE problem_ids IS NOT NULL AND platform IN ('codeforces','atcoder')`,
    )
    .all() as unknown as Array<{ platform: PlatformId; contest_id: string; problem_ids: string }>;
  if (rows.length === 0) return;

  const clear = db.prepare(
    'UPDATE participated_contests SET problem_ids = NULL, problem_set_state = NULL WHERE platform = ? AND contest_id = ?',
  );
  for (const row of rows) {
    let refs: Array<{ id: string }>;
    try {
      const parsed = JSON.parse(row.problem_ids) as unknown;
      if (!Array.isArray(parsed)) continue;
      refs = parsed
        .map((v) => (typeof v === 'string' ? { id: v } : (v as { id?: unknown })))
        .filter((v): v is { id: string } => typeof v?.id === 'string');
    } catch {
      continue; // 脏 JSON 交给读取期校验处理，迁移不猜
    }
    if (refs.length === 0) continue;
    if (!problemSetMatchesContest(row.platform, row.contest_id, refs)) {
      clear.run(row.platform, row.contest_id);
    }
  }
}

/**
 * v0.4.3 数据修复：模板库 CF 例题键曾写成 279/B，与适配器规范键 279B 不一致，
 * 同一道题裂成两行（提交挂规范行、例题查斜杠行），例题 AC 追踪永远匹配不上。
 * 把带斜杠的行合并进规范键行（无规范行时原地改名），清理冗余行。
 */
function mergeSlashedCfKeys(db: Db): void {
  const slashed = db
    .prepare(
      "SELECT id, problem_key FROM problems WHERE platform = 'codeforces' AND instr(problem_key, '/') > 0",
    )
    .all() as unknown as Array<{ id: number; problem_key: string }>;
  if (slashed.length === 0) return;

  const canonicalOf = db.prepare(
    "SELECT id FROM problems WHERE platform = 'codeforces' AND problem_key = ?",
  );
  const rename = db.prepare('UPDATE problems SET problem_key = ? WHERE id = ?');
  const repointSubmissions = db.prepare(
    'UPDATE submissions SET problem_id = ? WHERE problem_id = ?',
  );
  const repointPlanTasks = db.prepare('UPDATE plan_tasks SET problem_id = ? WHERE problem_id = ?');
  // 卡点同样要并入保留行：submission_intents.problem_id 是 NOT NULL 外键且无 ON DELETE，
  // 漏掉它会让这次合并的 DELETE 直接报外键错 —— 迁移回滚、createDb 抛错，应用再也起不来
  const repointIntents = db.prepare('UPDATE submission_intents SET problem_id = ? WHERE problem_id = ?');
  // 复习条目同一题只留一条：规范行已有则丢弃斜杠行的
  const repointReviews = db.prepare(
    `UPDATE review_items SET problem_id = ? WHERE problem_id = ?
       AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.user_id = review_items.user_id AND r.problem_id = ?)`,
  );
  const dropReviews = db.prepare('DELETE FROM review_items WHERE problem_id = ?');
  // review_events 两个外键都无级联：搬移条目的反馈历史对齐保留行、丢弃条目的反馈历史随之
  // 删除（与 problemMerge.ts 同款）。漏掉它们，DELETE review_items / DELETE problems 会抛
  // FOREIGN KEY constraint failed —— 迁移回滚、createDb 抛错，应用再也起不来
  const repointReviewEvents = db.prepare(
    `UPDATE review_events SET problem_id = ?
      WHERE problem_id = ?
        AND review_item_id IN (SELECT id FROM review_items WHERE problem_id = ?)`,
  );
  const dropReviewEvents = db.prepare('DELETE FROM review_events WHERE problem_id = ?');
  // 今日训练推荐 (user_id, problem_id) 是主键、外键无 ON DELETE：与复习条目同款处理，
  // 保留行已有同一用户的推荐时丢弃被合并行的，再清掉剩下的。漏掉它，下面的
  // DELETE FROM problems 同样会抛 FOREIGN KEY constraint failed —— 迁移回滚、createDb 抛错，
  // 应用再也打不开（与 repointIntents 注释里那条失效模式完全一致）
  const repointRecos = db.prepare(
    `UPDATE today_recommendations SET problem_id = ? WHERE problem_id = ?
       AND NOT EXISTS (SELECT 1 FROM today_recommendations t WHERE t.user_id = today_recommendations.user_id AND t.problem_id = ?)`,
  );
  const dropRecos = db.prepare('DELETE FROM today_recommendations WHERE problem_id = ?');
  // 题单条目按 (platform, problem_key) 存**串**，不是行 id：改键并对齐保留行的链接/标题
  //（与 problemMerge.ts 同款）。漏掉它，题单里该条目会永久指向已被删掉的斜杠题号，
  // 而题单页的难度/标签/已 AC 全靠 LEFT JOIN problems ON key 匹配 —— 同一道题也永远显示「未做」
  const repointListItems = db.prepare(
    `UPDATE problem_list_items SET problem_key = ?, title = ?, url = ?
      WHERE platform = ? AND problem_key = ?
        AND NOT EXISTS (
          SELECT 1 FROM problem_list_items i
           WHERE i.list_id = problem_list_items.list_id
             AND i.platform = problem_list_items.platform
             AND i.problem_key = ?)`,
  );
  const dropListItems = db.prepare('DELETE FROM problem_list_items WHERE platform = ? AND problem_key = ?');
  const keepMeta = db.prepare('SELECT title, url FROM problems WHERE id = ?');
  const dropProblem = db.prepare('DELETE FROM problems WHERE id = ?');
  const dropKeypoints = db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ?');
  const dropKnowledgeQueue = db.prepare('DELETE FROM knowledge_queue WHERE platform = ? AND problem_key = ?');

  db.exec('BEGIN');
  try {
    for (const row of slashed) {
      const canonicalKey = row.problem_key.replaceAll('/', '');
      const keep = canonicalOf.get(canonicalKey) as { id: number } | undefined;
      if (!keep) {
        rename.run(canonicalKey, row.id);
        continue;
      }
      repointSubmissions.run(keep.id, row.id);
      repointPlanTasks.run(keep.id, row.id);
      repointIntents.run(keep.id, row.id);
      repointReviews.run(keep.id, row.id, keep.id);
      repointReviewEvents.run(keep.id, row.id, keep.id);
      dropReviewEvents.run(row.id);
      dropReviews.run(row.id);
      repointRecos.run(keep.id, row.id, keep.id);
      dropRecos.run(row.id);
      // 键型引用（题单条目）同样要改键，否则条目永久指向已删除的斜杠题号
      const keepMetaRow = keepMeta.get(keep.id) as { title: string; url: string | null } | undefined;
      if (keepMetaRow) {
        repointListItems.run(
          canonicalKey,
          keepMetaRow.title,
          keepMetaRow.url,
          'codeforces',
          row.problem_key,
          canonicalKey,
        );
      }
      dropListItems.run('codeforces', row.problem_key);
      // 被合并键的知识点标注行随之失效（无外键约束，留着即孤儿行）；JSONL 源真相不变
      dropKeypoints.run('codeforces', row.problem_key);
      dropKnowledgeQueue.run('codeforces', row.problem_key);
      dropProblem.run(row.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * v0.4.5 数据修复：洛谷 submitTime 是秒级时间戳，曾被按毫秒解析，
 * 全部洛谷提交的 submitted_at 落在 1970 年（连带能力值近 60 天窗口、趋势图看不到洛谷）。
 * 把 1970 年的洛谷行按「现值当作秒」×1000 换算回真实时间；幂等：修复后即不再命中 1990 前。
 */
function fixLuoguTimestamps(db: Db): void {
  const broken = db
    .prepare(
      "SELECT id, submitted_at FROM submissions WHERE platform = 'luogu' AND submitted_at < '1990-01-01'",
    )
    .all() as Array<{ id: number; submitted_at: string }>;
  if (broken.length === 0) return;
  const update = db.prepare('UPDATE submissions SET submitted_at = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of broken) {
      const seconds = Date.parse(row.submitted_at); // 存储值本是被当毫秒解析的秒数
      if (!Number.isFinite(seconds) || seconds <= 0) continue;
      update.run(new Date(seconds * 1000).toISOString(), row.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * v0.6.1 数据修复：洛谷接口下发的 language 是数字 langId（如 34），适配器原样传下时
 * JS number 被 SQLite 按 REAL 写进 TEXT 列，落成 "34.0" 这种既非语言名又难看的值。
 * 统一收成十进制整数字符串 "34"。幂等：已是 "34" 的行换算后不变，不写库。
 * 语言名映射暂无公开来源（列表/题目页/记录详情实测均无字典），留待后续。
 */
function fixLuoguLanguageIds(db: Db): void {
  const rows = db
    .prepare("SELECT id, language FROM submissions WHERE platform = 'luogu' AND language IS NOT NULL")
    .all() as Array<{ id: number; language: string }>;
  const update = db.prepare('UPDATE submissions SET language = ? WHERE id = ?');
  let fixed = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (!/^\d+(\.\d+)?$/.test(row.language)) continue;
      const clean = String(Math.trunc(Number(row.language)));
      if (clean === row.language) continue;
      update.run(clean, row.id);
      fixed += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (fixed > 0) console.log(`[migrate] 已归一 ${fixed} 条洛谷 language（数字 langId 去掉 ".0" 尾巴）`);
}

/**
 * v0.8 多账号迁移（一）：submissions 增加 account 列并把唯一键扩为
 * (user_id, platform, account, external_id)——不同账号的平台侧提交号互不冲突，
 * 各账号数据按账号隔离共存；老库的存量提交归属当时唯一绑定的账号（无绑定为 NULL）。
 * SQLite 无法修改约束，按「建新表 → 迁数据 → 换名」重建；索引随旧表删除后重建。
 */
function rebuildSubmissionsForMultiAccount(db: Db): void {
  // 残留的 submissions_new 只可能来自「上一次重建中途被杀」：此刻 submissions 仍是未被动过的
  // 源表（DROP 在拷贝之后），残留的只是一份不完整拷贝 —— 丢掉重做即可。没有这一句，
  // 下次启动的 CREATE TABLE 会以 "table submissions_new already exists" 让应用**再也起不来**。
  db.exec('DROP TABLE IF EXISTS submissions_new');
  // 老数据的归属：该平台当前唯一绑定的 handle（多账号上线前每平台至多一个账号，
  // 库中提交即它的数据）；平台从未绑定过账号（仅手动导入）则为空串 ''（无账号来源）。
  const handleByPlatform = new Map<string, string>(
    (
      db.prepare('SELECT platform, handle FROM platform_accounts').all() as Array<{
        platform: string;
        handle: string;
      }>
    ).map((r) => [r.platform, r.handle]),
  );
  const rows = db
    .prepare(
      'SELECT id, user_id, platform, problem_id, verdict, language, submitted_at, external_id, context FROM submissions',
    )
    .all() as Array<{
    id: number;
    user_id: number;
    platform: string;
    problem_id: number;
    verdict: string;
    language: string | null;
    submitted_at: string;
    external_id: string | null;
    context: string | null;
  }>;
  // 建表 → 拷数据 → 换名 → 重建索引，整段收进**同一个事务**。SQLite 的 DDL 本身是事务性的，
  // 而原实现把 CREATE TABLE 放在 BEGIN 之前、把 DROP/RENAME 放在 COMMIT 之后，于是：
  //  - 拷贝期被杀：被隐式提交的 submissions_new 回滚不掉，下次启动 "already exists"，应用再也打不开；
  //  - DROP 与 RENAME 之间被杀：submissions 消失，schema.sql 会重建出一张**空**表，而重建守卫
  //    （缺 account 列）此时为假、不再重建 —— 用户全部提交记录静默留在孤儿表里，界面显示 0 条。
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE submissions_new (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id),
        platform     TEXT NOT NULL REFERENCES platforms(id),
        account      TEXT NOT NULL DEFAULT '',
        problem_id   INTEGER NOT NULL REFERENCES problems(id),
        verdict      TEXT NOT NULL,
        language     TEXT,
        submitted_at TEXT NOT NULL,
        external_id  TEXT,
        context      TEXT,
        UNIQUE (user_id, platform, account, external_id)
      )`);
    const ins = db.prepare(
      `INSERT INTO submissions_new
         (id, user_id, platform, account, problem_id, verdict, language, submitted_at, external_id, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(
        r.id,
        r.user_id,
        r.platform,
        handleByPlatform.get(r.platform) ?? '',
        r.problem_id,
        r.verdict,
        r.language,
        r.submitted_at,
        r.external_id,
        r.context,
      );
    }
    db.exec('DROP TABLE submissions');
    db.exec('ALTER TABLE submissions_new RENAME TO submissions');
    // 索引随旧表一起被 DROP，按新口径重建（与 schema.sql 保持一致）
    db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_user_platform ON submissions(user_id, platform)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_user_time ON submissions(user_id, submitted_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_user_account ON submissions(user_id, platform, account)');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * v0.8 多账号迁移（二）：platform_accounts 唯一键从 (user_id, platform) 扩为
 * (user_id, platform, handle)，同一平台可绑定多个账号。小表，直接整表重建。
 */
function rebuildAccountsForMultiAccount(db: Db): void {
  // 仅老库需要重建：检查唯一索引的列组合（新库 schema.sql 已是新约束）
  const indexes = db.prepare("PRAGMA index_list('platform_accounts')").all() as Array<{
    name: string;
    unique: number;
    origin: string;
  }>;
  const isOldUnique = indexes.some((idx) => {
    if (idx.unique !== 1 || idx.origin !== 'u') return false;
    const cols = (
      db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    return cols.length === 2 && cols.includes('user_id') && cols.includes('platform');
  });
  if (!isOldUnique) return;
  // 与 submissions 重建同款：残留的 _new 表会让应用再也起不来；整段重建必须原子 ——
  // 否则 DROP 与 RENAME 之间被杀会让 schema.sql 重建出一张空的 platform_accounts，
  // 用户所有账号绑定静默消失（而 isOldUnique 随之变假，再也无人纠正）
  db.exec('DROP TABLE IF EXISTS platform_accounts_new');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE platform_accounts_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id),
        platform        TEXT NOT NULL REFERENCES platforms(id),
        handle          TEXT NOT NULL,
        last_sync_at    TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        sync_truncated  INTEGER NOT NULL DEFAULT 0,
        backfill_page   INTEGER,
        UNIQUE (user_id, platform, handle)
      )`);
    db.exec(`
      INSERT INTO platform_accounts_new
        (id, user_id, platform, handle, last_sync_at, enabled, sync_truncated, backfill_page)
      SELECT id, user_id, platform, handle, last_sync_at, enabled, sync_truncated, backfill_page
        FROM platform_accounts`);
    db.exec('DROP TABLE platform_accounts');
    db.exec('ALTER TABLE platform_accounts_new RENAME TO platform_accounts');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * v0.6.2 数据修复：复习条目同一 (user_id, problem_id) 只保留最早的一条。
 *
 * 背景：schema.sql 的 review_items 带 UNIQUE (user_id, problem_id)，新库不会产生重复；但历史库
 * 可能在去重合并（mergeSlashedCfKeys / clean-tags 的重复清理）把 review_items 重指到保留行时
 * 残留过重复行。重复不会报错，却会让各处「是否已在复习队列」的标量子查询
 * （today/problems/history 的 `SELECT ri.id ... WHERE ri.problem_id = p.id`）只取第一行：
 * 前端据此渲染单一的「移出」按钮并只删那一条，另一条永远删不掉、题目一直显示「已加入」。
 *
 * 按 id 升序保留最早一条（与用户最初加入的时间/进度一致），其余删除。幂等：无重复时不写库。
 */
function dedupeReviewItems(db: Db): void {
  const dupes = db
    .prepare(
      `SELECT id FROM review_items
        WHERE id NOT IN (SELECT MIN(id) FROM review_items GROUP BY user_id, problem_id)`,
    )
    .all() as Array<{ id: number }>;
  if (dupes.length === 0) return;
  const drop = db.prepare('DELETE FROM review_items WHERE id = ?');
  // 被删条目的反馈历史先清掉：review_events.review_item_id 外键无级联，留着历史会让
  // DELETE 抛 FOREIGN KEY constraint failed —— 迁移回滚、createDb 抛错，应用打不开
  const dropEvents = db.prepare('DELETE FROM review_events WHERE review_item_id = ?');
  db.exec('BEGIN');
  try {
    for (const row of dupes) {
      dropEvents.run(row.id);
      drop.run(row.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[migrate] 已清理 ${dupes.length} 条重复复习条目（同一题只留最早一条）`);
}

function seed(db: Db): void {
  const upsertPlatform = db.prepare(
    'INSERT OR IGNORE INTO platforms (id, name, has_official_api) VALUES (?, ?, ?)',
  );
  for (const p of PLATFORMS) {
    upsertPlatform.run(p.id, p.name, p.hasOfficialApi ? 1 : 0);
  }
  db.prepare('INSERT OR IGNORE INTO users (id, username) VALUES (1, ?)').run('me');
}
