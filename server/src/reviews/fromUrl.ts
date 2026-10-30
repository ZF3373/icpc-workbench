import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { parseProblemListText } from '../problems/parseProblemList.ts';
import { dateAfterDays, firstReviewDelayDays } from './schedule.ts';
import { localToday } from '../dates.ts';

const HOSTS = new Set(['luogu.com.cn', 'www.luogu.com.cn', 'codeforces.com', 'www.codeforces.com',
  'atcoder.jp', 'www.atcoder.jp', 'bs.daimayuan.top', 'oj.daimayuan.top', 'ac.nowcoder.com',
  'jisuanke.com', 'www.jisuanke.com', 'leetcode.cn', 'www.leetcode.cn', 'leetcode.com',
  'www.leetcode.com', 'www.nowcoder.com', 'qoj.ac', 'www.qoj.ac', 'vjudge.net', 'www.vjudge.net']);

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
      db.prepare('DELETE FROM deleted_problems WHERE platform = ? AND normalized_key = ?')
        .run(parsed.platform, parsed.problemKey.replace(/\s/g, '').toLowerCase());
    }
    const existing = db.prepare('SELECT next_due_on FROM review_items WHERE user_id = ? AND problem_id = ?')
      .get(DEFAULT_USER_ID, problem.id) as { next_due_on: string } | undefined;
    const nextDueOn = existing?.next_due_on ?? dateAfterDays(localToday(), firstReviewDelayDays(problem.id));
    if (!existing) db.prepare('INSERT INTO review_items (user_id, problem_id, next_due_on) VALUES (?, ?, ?)')
      .run(DEFAULT_USER_ID, problem.id, nextDueOn);
    db.exec('COMMIT');
    return { ok: true, created, alreadyInQueue: !!existing, nextDueOn,
      platform: parsed.platform, problemKey: parsed.problemKey, title: problem.title };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
