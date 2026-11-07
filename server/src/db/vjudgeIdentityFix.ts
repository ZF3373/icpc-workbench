import type { Db } from './index.ts';
import { splitVjudgeProblemSlug, vjudgeIdentity } from '../adapters/vjudgeIdentity.ts';
import { normalizedKey } from '../import/tombstones.ts';

/**
 * v0.13 数据修复：把历史 `platform = 'vjudge'` 的题目行改写成**规范身份**。
 *
 * 为什么需要：VJudge 接入最初把记录落成 `vjudge/{OJ}-{题号}`，而「通过链接添加」走
 * `parseProblemList` 落成原 OJ 身份（`luogu/P1001`）—— 同一道题在库里是两行，
 * 同步来的 AC 在复习条目上永远不显示，统计里也各算一次（2026-10-30 review P1-4）。
 * 适配器已改为直接写原 OJ 身份，但**已落库的旧行不会自己变**，这里补一次迁移。
 *
 * 幂等：处理完就没有需要改的 vjudge 行了，下次启动是空操作。
 * 必须可重入：中途失败回滚，下次重跑结果一致。
 *
 * 三种情形（口径统一交给 adapters/vjudgeIdentity.ts 的 vjudgeIdentity）：
 * - 本应用**有**该 OJ 且目标键不存在 → 原地改名成原 OJ 身份（连同 url/标题与按题号存串的表）
 * - 本应用**有**该 OJ 且目标键已存在（用户先手动加过同一道题）→ 跨平台合并：引用迁到保留行
 * - 本应用**没有**该 OJ → 规范字面量（`HYSBZ-1000` / `黑暗爆炸-1000` → `BZOJ-1000`）并
 *   对齐 VJudge 链接；**不删行**（VJudge 是这些题唯一的数据源）。旧实现对这些行原样不动，
 *   于是同一个 OJ 的不同写法会长期各占一行。
 *
 * 解析不出 OJ 的行（题号里没有 `-`，历史上不该存在）保持原样，只计入 skipped。
 */
export interface VjudgeIdentityFixResult {
  /** 原地改名的行数（目标键不存在） */
  renamed: number;
  /** 并入已存在原 OJ 行的行数 */
  merged: number;
  /** 解析不出 OJ、或规范身份与现状一致（无需改动）的行数 */
  skipped: number;
}

export function fixVjudgeProblemIdentities(db: Db): VjudgeIdentityFixResult {
  const result: VjudgeIdentityFixResult = { renamed: 0, merged: 0, skipped: 0 };
  const rows = db
    .prepare("SELECT id, problem_key, title, url FROM problems WHERE platform = 'vjudge'")
    .all() as Array<{ id: number; problem_key: string; title: string; url: string | null }>;
  if (rows.length === 0) return result;

  const findTarget = db.prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?');

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      // 历史键形如 `{OJ}-{题号}`；OJ 与题号都可能带连字符（Z-Trening-1000 /
      // Toph-make-it-big / OpenJ_NOI-CH0106-02），不能按第一个 '-' 硬切。
      const parts = splitVjudgeProblemSlug(row.problem_key);
      if (!parts) {
        result.skipped += 1;
        continue;
      }
      const identity = vjudgeIdentity(parts.oj, parts.id);
      if (!identity) {
        result.skipped += 1;
        continue;
      }
      // 已经是规范身份（别名已归并过 / 键与链接都对齐）：空操作，别每轮重写一遍
      if (
        identity.platform === 'vjudge' &&
        identity.problemKey === row.problem_key &&
        row.url === identity.url
      ) {
        result.skipped += 1;
        continue;
      }
      const target = findTarget.get(identity.platform, identity.problemKey) as { id: number } | undefined;
      if (target && target.id !== row.id) {
        mergeIntoExisting(db, {
          fromId: row.id,
          fromKey: row.problem_key,
          toId: target.id,
          toKey: identity.problemKey,
          toPlatform: identity.platform,
        });
        result.merged += 1;
      } else {
        renameInPlace(db, row, identity);
        result.renamed += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

/** 原地改名：题目行 + 所有按 (platform, problem_key) 存串的表 */
function renameInPlace(
  db: Db,
  row: { id: number; problem_key: string; title: string; url: string | null },
  identity: { platform: string; problemKey: string; url: string },
): void {
  const fromPlatform = 'vjudge';
  const fromKey = row.problem_key;
  const to = identity;
  // 标题当初就是题号（VJudge 不提供题名）。改成新题号，写入层才认得出「这不是真标题」——
  // problemWritePolicy 的守卫是 excluded.title != problems.problem_key，标题停在旧题号
  // 会让后续真实标题能覆盖它（无害），但让库内标题与题号长期不一致（有害）。
  const title = row.title === fromKey ? to.problemKey : row.title;
  // 链接对齐目标身份：本应用有该 OJ 时换成**原站**地址（转发链接在部分 OJ 上还要登录
  // VJudge 才跳得过去）；本应用没有该 OJ 时换成规范字面量的 VJudge 链接（别名行原先
  // 指向旧写法，与归并后的键不一致）。非 VJudge 链接（用户手填的）保持不动。
  const url = row.url === null || /vjudge\.net/.test(row.url) ? to.url : row.url;
  // UNIQUE(platform, problem_key) 已由调用方确认无冲突
  db.prepare('UPDATE problems SET platform = ?, problem_key = ?, title = ?, url = ? WHERE id = ?').run(
    to.platform,
    to.problemKey,
    title,
    url,
    row.id,
  );
  moveKeyedRows(db, fromPlatform, fromKey, to.platform, to.problemKey, to.url);
}

/** 目标行已存在：把引用迁过去，再删掉旧行（跨平台，不能用 mergeProblemRow 的同平台口径） */
function mergeIntoExisting(
  db: Db,
  opts: { fromId: number; fromKey: string; toId: number; toKey: string; toPlatform: string },
): void {
  const { fromId, fromKey, toId, toKey, toPlatform } = opts;
  // 无条件跟随保留行的引用
  db.prepare('UPDATE submissions SET problem_id = ? WHERE problem_id = ?').run(toId, fromId);
  db.prepare('UPDATE submission_intents SET problem_id = ? WHERE problem_id = ?').run(toId, fromId);
  db.prepare('UPDATE plan_tasks SET problem_id = ? WHERE problem_id = ?').run(toId, fromId);
  // 唯一约束 (user_id, problem_id)：保留行已有同一用户的条目时丢弃旧行侧
  db.prepare(
    `UPDATE review_items SET problem_id = ? WHERE problem_id = ?
       AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.user_id = review_items.user_id AND r.problem_id = ?)`,
  ).run(toId, fromId, toId);
  db.prepare(
    `UPDATE review_events SET problem_id = ?
      WHERE problem_id = ?
        AND review_item_id IN (SELECT id FROM review_items WHERE problem_id = ?)`,
  ).run(toId, fromId, toId);
  db.prepare('DELETE FROM review_events WHERE problem_id = ?').run(fromId);
  db.prepare('DELETE FROM review_items WHERE problem_id = ?').run(fromId);
  db.prepare(
    `UPDATE today_recommendations SET problem_id = ? WHERE problem_id = ?
       AND NOT EXISTS (SELECT 1 FROM today_recommendations t WHERE t.user_id = today_recommendations.user_id AND t.problem_id = ?)`,
  ).run(toId, fromId, toId);
  db.prepare('DELETE FROM today_recommendations WHERE problem_id = ?').run(fromId);

  // 按题号存串的表：能改键就改，撞唯一键的丢弃旧行侧（知识点管线会对保留行重新生成）
  const keep = db.prepare('SELECT title, url FROM problems WHERE id = ?').get(toId) as
    | { title: string; url: string | null }
    | undefined;
  moveKeyedRows(db, 'vjudge', fromKey, toPlatform, toKey, keep?.url ?? null, keep?.title ?? null);
  db.prepare('DELETE FROM problems WHERE id = ?').run(fromId);
}

/**
 * 按 (platform, problem_key) 存串的附属表迁移：`problem_list_items`（有 UNIQUE(list_id, platform, key)）
 * 能改就改、撞键丢弃；`problem_keypoints` / `knowledge_queue` / `problem_statements`
 * 主键即 (platform, problem_key)，同样「能改就改、撞键删除」（前者由知识点管线重建，
 * 后两者可重新抓取/入队）；`deleted_problems`（墓碑）跟着改键，否则删过的题会被当新题重建。
 */
function moveKeyedRows(
  db: Db,
  fromPlatform: string,
  fromKey: string,
  toPlatform: string,
  toKey: string,
  toUrl: string | null,
  toTitle: string | null = null,
): void {
  if (fromPlatform === toPlatform && fromKey === toKey) return;
  // 题单条目：撞 UNIQUE 的留给下一步 DELETE
  db.prepare(
    `UPDATE problem_list_items
        SET platform = ?, problem_key = ?, url = COALESCE(?, url), title = COALESCE(?, title)
      WHERE platform = ? AND problem_key = ?
        AND NOT EXISTS (
          SELECT 1 FROM problem_list_items i
           WHERE i.list_id = problem_list_items.list_id
             AND i.platform = ? AND i.problem_key = ?)`,
  ).run(toPlatform, toKey, toUrl, toTitle, fromPlatform, fromKey, toPlatform, toKey);
  db.prepare('DELETE FROM problem_list_items WHERE platform = ? AND problem_key = ?').run(fromPlatform, fromKey);

  for (const table of ['problem_keypoints', 'knowledge_queue', 'problem_statements'] as const) {
    db.prepare(
      `UPDATE ${table} SET platform = ?, problem_key = ?
        WHERE platform = ? AND problem_key = ?
          AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.platform = ? AND t.problem_key = ?)`,
    ).run(toPlatform, toKey, fromPlatform, fromKey, toPlatform, toKey);
    db.prepare(`DELETE FROM ${table} WHERE platform = ? AND problem_key = ?`).run(fromPlatform, fromKey);
  }

  // 墓碑：平台与归一化键都要跟着改，否则「删过的题」以新身份再次出现会被静默重建
  db.prepare(
    `UPDATE deleted_problems SET platform = ?, problem_key = ?, normalized_key = ?
      WHERE platform = ? AND problem_key = ?
        AND NOT EXISTS (SELECT 1 FROM deleted_problems d WHERE d.platform = ? AND d.problem_key = ?)`,
  ).run(toPlatform, toKey, normalizedKey(toKey), fromPlatform, fromKey, toPlatform, toKey);
  db.prepare('DELETE FROM deleted_problems WHERE platform = ? AND problem_key = ?').run(fromPlatform, fromKey);
}
