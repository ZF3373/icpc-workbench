import type { PracticeEvidence } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { problemIdentity } from '../problems/identity.ts';
import { intentFactor } from '../today/ability.ts';
import { round2 } from './stats.ts';

/** SQLite datetime 默认是 UTC；避免把没有时区的卡点时间误读成本地时间。 */
function utcTime(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
}

/** 批量读取用户证据，按调用方已过滤账号的题目集合汇总，不逐题查库。 */
export function loadPracticeEvidence(db: Db, userId: number): (attempted: ReadonlySet<string>, solved: ReadonlySet<string>, code?: string) => PracticeEvidence {
  const intents = new Map<string, Array<{ code: string | null; factor: number; at: number }>>();
  const rows = db.prepare(`SELECT p.platform, p.problem_key, i.code, i.outcome, i.created_at
    FROM submission_intents i JOIN problems p ON p.id = i.problem_id WHERE i.user_id = ?`)
    .all(userId) as Array<{ platform: string; problem_key: string; code: string | null; outcome: string; created_at: string }>;
  for (const row of rows) {
    const identity = problemIdentity({ platform: row.platform, problemKey: row.problem_key });
    const list = intents.get(identity) ?? [];
    list.push({ code: row.code, factor: intentFactor(row.outcome), at: utcTime(row.created_at) });
    intents.set(identity, list);
  }
  const reviews = new Map<string, { at: number; id: number; hard: boolean; successfulAt: number }>();
  const events = db.prepare(`SELECT p.platform, p.problem_key, re.id, re.reviewed_at, re.feedback
    FROM review_events re JOIN problems p ON p.id = re.problem_id WHERE re.user_id = ?`)
    .all(userId) as Array<{ platform: string; problem_key: string; id: number; reviewed_at: string; feedback: string }>;
  for (const row of events) {
    const identity = problemIdentity({ platform: row.platform, problemKey: row.problem_key });
    const at = utcTime(row.reviewed_at);
    if (!Number.isFinite(at)) continue;
    const previous = reviews.get(identity);
    const successfulAt = Math.max(previous?.successfulAt ?? -Infinity, row.feedback === 'hard' ? -Infinity : at);
    if (!previous || at > previous.at || (at === previous.at && row.id > previous.id)) {
      reviews.set(identity, { at, id: row.id, hard: row.feedback === 'hard', successfulAt });
    } else previous.successfulAt = successfulAt;
  }
  return (attempted, solved, code) => {
    let creditedSolved = 0;
    let assistedSolved = 0;
    let fragileSolved = 0;
    let stuckProblems = 0;
    let missingCredit = 0;
    for (const identity of attempted) {
      const review = reviews.get(identity);
      let factor = 1;
      for (const intent of intents.get(identity) ?? []) {
        // 明确指向某知识点的卡点不降低同题其它知识点；成功复习可修复早期证据。
        if (intent.code !== null && intent.code !== code) continue;
        if (Number.isFinite(intent.at) && intent.at <= (review?.successfulAt ?? -Infinity)) continue;
        factor = Math.min(factor, intent.factor);
      }
      const assisted = factor < 1;
      if (review?.hard) factor = Math.min(factor, 0.5);
      missingCredit += 1 - factor;
      if (solved.has(identity)) {
        if (assisted) assistedSolved++;
        if (review?.hard) fragileSolved++;
        creditedSolved += factor;
      } else if (factor < 1) stuckProblems++;
    }
    return {
      sampleSize: attempted.size, solved: solved.size, creditedSolved: round2(creditedSolved),
      assistedSolved, fragileSolved, stuckProblems,
      supportGap: attempted.size > 0 ? round2(missingCredit / attempted.size * 100) : 0,
    };
  };
}
