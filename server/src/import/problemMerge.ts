import type { Db } from '../db/index.ts';

/**
 * 题目行合并：把「同一道题的旧行」并入「保留行」，随后删除旧行。
 *
 * 为什么需要：平台可能给同一条提交记录换题号。洛谷比赛题在赛中以临时 T 号出现
 * （/problem/T… 赛后失效、标题退化为题号），赛后官方转正为题库 P 号后，record/list
 * 对同一批提交号改发 P 号。写入层以 (platform, problem_key) 为题目唯一键、提交以
 * (user, platform, account, external_id) 去重，键一变旧行就成了孤儿：提交永远指向
 * 失效的旧题行，再同步也修不回来。insertNormalized 检测到「同提交号、题号变了」时
 * 调用本函数把旧题行并入新题行，提交与用户数据跟着走。
 *
 * 引用迁移口径与 routes/problems.ts 的 clean-tags 去重合并一致（submissions /
 * submission_intents / plan_tasks 直改；review_items、today_recommendations 撞
 * UNIQUE 时丢弃旧行侧，review_events 反馈历史随条目——搬移的对齐保留行、丢弃的删除；
 * problem_list_items 改键并把题面链接/标题对齐保留行；
 * problem_keypoints / knowledge_queue / problem_statements 按旧键删除——知识点
 * 标注由管线对保留行重新生成）。差异点：clean-tags 面对的是「题库会再次下发的
 * 脏键」，必须记 JSONL 标注墓碑防复活；这里合并掉的是平台不再下发的临时键
 * （转正后 record/list 只发 P 号），DB 墓碑（deleted_problems）即可——它挡住
 * 迟到的 T 号提交把旧行连回库里、把已重定向的提交再次拽回死链。
 *
 * 必须在调用方的事务内执行（insertNormalized 的 BEGIN/COMMIT）。
 */
export interface MergeProblemOpts {
  platform: string;
  /** 被并掉的旧行（如洛谷比赛 T 号行） */
  fromId: number;
  fromKey: string;
  /** 保留行（如赛后正式 P 号行），须已存在 */
  toId: number;
  /** 保留行的题号 */
  toKey: string;
}

export function mergeProblemRow(db: Db, opts: MergeProblemOpts): void {
  const { platform, fromId, fromKey, toId, toKey } = opts;
  if (fromId === toId || fromKey === toKey) return;
  const fromRow = db
    .prepare(
      `SELECT platform, problem_key, title, difficulty, url, tags,
              difficulty_source, native_difficulty, difficulty_scale
         FROM problems WHERE id = ?`,
    )
    .get(fromId) as
    | {
        platform: string;
        problem_key: string;
        title: string;
        difficulty: number | null;
        url: string | null;
        tags: string;
        difficulty_source: string | null;
        native_difficulty: string | null;
        difficulty_scale: string | null;
      }
    | undefined;
  // 旧行已不存在（同批内已被并掉）：引用迁移随之成为空操作，直接返回
  if (!fromRow) return;

  // 提交与用户信号：无条件跟随保留行（它们本来就是同一道题的同一批提交）
  db.prepare('UPDATE submissions SET problem_id = ? WHERE problem_id = ?').run(toId, fromId);
  db.prepare('UPDATE submission_intents SET problem_id = ? WHERE problem_id = ?').run(toId, fromId);
  db.prepare('UPDATE plan_tasks SET problem_id = ? WHERE problem_id = ?').run(toId, fromId);
  // 复习条目 (user_id, problem_id) 唯一：保留行已有同一用户的复习条目时丢弃旧行侧
  db.prepare(
    `UPDATE review_items SET problem_id = ? WHERE problem_id = ?
       AND NOT EXISTS (SELECT 1 FROM review_items r WHERE r.user_id = review_items.user_id AND r.problem_id = ?)`,
  ).run(toId, fromId, toId);
  // 复习反馈历史（review_events）两个外键都无级联：被搬移条目的历史跟随条目对齐保留行，
  // 被丢弃条目的历史随条目一起删。漏了它们，下面 DELETE review_items / DELETE problems
  // 会抛 FOREIGN KEY constraint failed —— 整个同步事务回滚，旧键提交每次同步重新下发，
  // 同步从此每次失败（洛谷 T 号转正 + 已复习题的路径）
  db.prepare(
    `UPDATE review_events SET problem_id = ?
      WHERE problem_id = ?
        AND review_item_id IN (SELECT id FROM review_items WHERE problem_id = ?)`,
  ).run(toId, fromId, toId);
  db.prepare('DELETE FROM review_events WHERE problem_id = ?').run(fromId);
  db.prepare('DELETE FROM review_items WHERE problem_id = ?').run(fromId);
  // 今日推荐 PK (user_id, problem_id)：与复习条目同一处理
  db.prepare(
    `UPDATE today_recommendations SET problem_id = ? WHERE problem_id = ?
       AND NOT EXISTS (SELECT 1 FROM today_recommendations t WHERE t.user_id = today_recommendations.user_id AND t.problem_id = ?)`,
  ).run(toId, fromId, toId);
  db.prepare('DELETE FROM today_recommendations WHERE problem_id = ?').run(fromId);

  // 题单条目按 (platform, problem_key) 存串：改键并对齐保留行的链接/标题；
  // 同一题单里已有保留行条目时丢弃旧行侧（UNIQUE (list_id, platform, problem_key)）
  const keep = db.prepare('SELECT title, url FROM problems WHERE id = ?').get(toId) as
    | { title: string; url: string | null }
    | undefined;
  if (keep) {
    db.prepare(
      `UPDATE problem_list_items SET problem_key = ?, title = ?, url = ?
        WHERE platform = ? AND problem_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM problem_list_items i
             WHERE i.list_id = problem_list_items.list_id
               AND i.platform = problem_list_items.platform
               AND i.problem_key = ?)`,
    ).run(toKey, keep.title, keep.url, platform, fromKey, toKey);
  }
  db.prepare('DELETE FROM problem_list_items WHERE platform = ? AND problem_key = ?').run(platform, fromKey);

  // 旧键的结构化标注 / 知识队列 / 题面缓存：保留行由知识点管线重新标注，旧键清理
  db.prepare('DELETE FROM problem_keypoints WHERE platform = ? AND problem_key = ?').run(platform, fromKey);
  db.prepare('DELETE FROM knowledge_queue WHERE platform = ? AND problem_key = ?').run(platform, fromKey);
  db.prepare('DELETE FROM problem_statements WHERE platform = ? AND problem_key = ?').run(platform, fromKey);

  // 记墓碑（带快照，回收站可找回）再删旧行：挡住平台迟到的旧键提交复活旧行
  db.prepare(
    `INSERT OR REPLACE INTO deleted_problems
       (platform, problem_key, normalized_key, title, difficulty, url, tags,
        difficulty_source, native_difficulty, difficulty_scale)
     VALUES (?, ?, LOWER(REPLACE(?, ' ', '')), ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fromRow.platform,
    fromRow.problem_key,
    fromRow.problem_key,
    fromRow.title,
    fromRow.difficulty,
    fromRow.url,
    fromRow.tags,
    fromRow.difficulty_source,
    fromRow.native_difficulty,
    fromRow.difficulty_scale,
  );
  db.prepare('DELETE FROM problems WHERE id = ?').run(fromId);
}
