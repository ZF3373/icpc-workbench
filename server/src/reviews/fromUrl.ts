import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { parseProblemListText } from '../problems/parseProblemList.ts';
import { normalizedKey } from '../import/tombstones.ts';
import { queueStateOf } from './queue.ts';
import { dateAfterDays, firstReviewDelayDays } from './schedule.ts';
import { localToday } from '../dates.ts';

const HOSTS = new Set(['luogu.com.cn', 'www.luogu.com.cn', 'codeforces.com', 'www.codeforces.com',
  'atcoder.jp', 'www.atcoder.jp', 'bs.daimayuan.top', 'oj.daimayuan.top', 'ac.nowcoder.com',
  'jisuanke.com', 'www.jisuanke.com', 'leetcode.cn', 'www.leetcode.cn', 'leetcode.com',
  'www.leetcode.com', 'www.nowcoder.com', 'qoj.ac', 'www.qoj.ac', 'vjudge.net', 'www.vjudge.net',
  'pintia.cn', 'www.pintia.cn']);

/** Only parse a supported URL; never fetch arbitrary user-supplied addresses. */
export function addReviewFromUrl(db: Db, raw: unknown, title?: unknown) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('请填写有效的题目链接');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error('请填写完整的 http 或 https 题目链接'); }
  if (!['http:', 'https:'].includes(url.protocol) || !HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error('暂不支持这个网址，请使用支持平台的题目链接');
  }
  if (title !== undefined && (typeof title !== 'string' || title.trim().length > 300)) throw new Error('标题最多 300 字');
  // Decode VJudge Chinese platform names; exclude query strings from identity detection.
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new Error('链接编码无效'); }
  const parsed = parseProblemListText(`${url.origin}${pathname}`)[0];
  if (!parsed?.url) throw new Error('未识别到题目，请使用具体题目页面的链接');
  db.exec('BEGIN');
  try {
    let problem = db.prepare('SELECT id, title FROM problems WHERE platform = ? AND problem_key = ?')
      .get(parsed.platform, parsed.problemKey) as { id: number; title: string } | undefined;
    const created = !problem;
    if (!problem) {
      const name = typeof title === 'string' && title.trim() ? title.trim() : parsed.problemKey;
      const result = db.prepare('INSERT INTO problems (platform, problem_key, title, url) VALUES (?, ?, ?, ?)')
        .run(parsed.platform, parsed.problemKey, name, url.href);
      problem = { id: Number(result.lastInsertRowid), title: name };
      // 与 SQL 侧 `LOWER(REPLACE(x, ' ', ''))` 同一口径：SQLite 的 LOWER 只折叠 ASCII，
      // 而 JS 的 toLowerCase() 会连非 ASCII 一起折（如土耳其语 İ、全角字母），
      // 两侧算出不同键时墓碑清不掉 —— 用户「删过的题」加回来会被静默挡住。
      // 复用 tombstones.ts 的 normalizedKey 保证唯一真源。
      db.prepare('DELETE FROM deleted_problems WHERE platform = ? AND normalized_key = ?')
        .run(parsed.platform, normalizedKey(parsed.problemKey));
    }
    // 复习条目按**题目身份**去重（不是按题目行）：同一道题可能有多行
    //（codeforces/1000A 与洛谷镜像 luogu/CF1000A 共享 identity），按行查会各加一条，
    // 今日训练里同一道题就出现两次、两条各自独立排期。口径见 reviews/queue.ts。
    // 命中就复用那条的排期（本题行自己的条目优先，其次是同身份另一行的）——不新建，
    // 否则同一道题会被排进队列两次，用户要复习两遍。
    const queued = queueStateOf(db, DEFAULT_USER_ID, problem.id);
    const itemId = queued.ownRowItemId ?? queued.itemId;
    const existing = itemId === null
      ? undefined
      : db.prepare('SELECT next_due_on FROM review_items WHERE id = ?')
        .get(itemId) as { next_due_on: string } | undefined;
    const nextDueOn = existing?.next_due_on
      ?? dateAfterDays(localToday(), firstReviewDelayDays(problem.id));
    if (!existing) db.prepare('INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (?, ?, ?)')
      .run(DEFAULT_USER_ID, problem.id, nextDueOn);
    db.exec('COMMIT');
    return { ok: true, created, alreadyInQueue: Boolean(existing), nextDueOn,
      platform: parsed.platform, problemKey: parsed.problemKey, title: problem.title };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
