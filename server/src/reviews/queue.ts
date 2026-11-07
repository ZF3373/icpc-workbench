import type { Db } from '../db/index.ts';

/**
 * 复习队列的**按题身份去重**：一道题只能有一条复习条目，哪怕它在库里有多行。
 *
 * 为什么需要：`review_items` 的唯一键是 `(user_id, problem_id)` —— 按**题目行**而不是
 * **题目身份**。而 problems 表里同一道题可以有多行（`codeforces/1000A` 与洛谷镜像
 * `luogu/CF1000A` 共享 identity `codeforces:1000a`，VJudge 转发来的也会落到前者）。
 * 于是「同一道题加两次复习」会真的落下两条条目：今日训练里出现两次、复习日历算两次、
 * 两条各自独立排期（一条练到 60 天档、另一条还在 3 天档），用户要复习同一道题两遍。
 *
 * 实测（2026-11-07）：`codeforces/1000A` + `luogu/CF1000A` 两次 `POST /api/reviews/from-url`
 * → problems 两行、review_items 两条，identity 都是 `codeforces:1000a`。
 *
 * 口径与 `routes/today.ts` 的 `queued` CTE 一致（那里早就按 identity 聚合），
 * 身份唯一真源是 `problems/identity.ts`。
 */
export interface QueuedByProblem {
  /** 该题目行所属身份下是否已有复习条目 */
  inQueue: boolean;
  /** 该身份的复习条目 id（多条里取最早的一条，与 dedupeReviewItems 的保留口径一致） */
  itemId: number | null;
  /** 该身份下**是否已有一条指向本题行**的条目（决定复用还是新建） */
  ownRowItemId: number | null;
}

/**
 * 按题目身份查复习条目。
 *
 * `problemRowId` 用于区分「本题行自己已有条目」与「同身份的另一行有条目」：
 * 前者应当复用（不新建），后者说明这道题已经练过了（也应复用，避免重复练习）。
 */
export function queueStateOf(db: Db, userId: number, problemRowId: number): QueuedByProblem {
  const row = db
    .prepare(
      `SELECT MIN(ri.id) AS item_id,
              MIN(CASE WHEN ri.problem_id = ? THEN ri.id END) AS own_item_id
         FROM review_items ri
         JOIN problems p ON p.id = ri.problem_id
        WHERE ri.user_id = ?
          AND p.identity = (SELECT identity FROM problems WHERE id = ?)`,
    )
    .get(problemRowId, userId, problemRowId) as
    | { item_id: number | null; own_item_id: number | null }
    | undefined;
  const itemId = row?.item_id ?? null;
  return {
    inQueue: itemId !== null,
    itemId,
    // 用 MIN(CASE ...) 而不是「own 计数 > 0 时复用 MIN(id)」：历史库里同一道题可能两行**各**有
    // 一条条目，此时 MIN(id) 可能是另一行的条目 —— 拿它当「本题行自己的条目」会去读错误的排期
    ownRowItemId: row?.own_item_id ?? null,
  };
}
