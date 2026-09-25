import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../../../shared/src/index.ts';

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
  const dropProblem = db.prepare('DELETE FROM problems WHERE id = ?');

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
      dropReviews.run(row.id);
      // 被合并键的知识点标注行随之失效（无外键约束，留着即孤儿行）；JSONL 源真相不变
      db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ?').run(
        'codeforces',
        row.problem_key,
      );
      db.prepare('DELETE FROM knowledge_queue WHERE platform = ? AND problem_key = ?').run(
        'codeforces',
        row.problem_key,
      );
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
  const ins = db.prepare(
    `INSERT INTO submissions_new
       (id, user_id, platform, account, problem_id, verdict, language, submitted_at, external_id, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('DROP TABLE submissions');
  db.exec('ALTER TABLE submissions_new RENAME TO submissions');
  // 索引随旧表一起被 DROP，按新口径重建（与 schema.sql 保持一致）
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_user_platform ON submissions(user_id, platform)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_user_time ON submissions(user_id, submitted_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_submissions_user_account ON submissions(user_id, platform, account)');
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
  db.exec('BEGIN');
  try {
    for (const row of dupes) drop.run(row.id);
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
