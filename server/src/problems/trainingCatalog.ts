import { expandTag, type PlatformId } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { safeTags } from '../analysis/stats.ts';
import { problemKeypointsCte, knowledgeTagsJoinSql, knowledgeTagsExpr } from '../knowledge/store.ts';
import { problemIdentity as identityOf, problemIdentitySql as identitySql } from './identity.ts';

export interface ProblemIdentity { platform: string; problemKey: string }

function catalogCte(db: Db): string {
  return `WITH solved AS (
    SELECT ${identitySql('sp')} AS identity FROM submissions s
    JOIN problems sp ON sp.id = s.problem_id WHERE s.user_id = ? AND s.verdict = 'AC' GROUP BY identity
  ), ${problemKeypointsCte(db)}, catalog AS (
    SELECT p.platform, p.problem_key, p.title, p.difficulty, p.url,
      ${knowledgeTagsExpr()} AS tags, ${identitySql('p')} AS identity,
      solved.identity IS NOT NULL AS solved
    FROM problems p ${knowledgeTagsJoinSql()}
    LEFT JOIN solved ON solved.identity = ${identitySql('p')}
  )`;
}

/** 完整同步历史的状态查询，无日期窗口、数量截断或账号限制。库外题明确标为未收录。 */
export function problemStatuses(db: Db, userId: number, problems: ProblemIdentity[]): string[] {
  if (!problems.length) return [];
  const rows = db.prepare(`${catalogCte(db)}
    SELECT identity, MAX(solved) AS solved FROM catalog
    WHERE identity IN (SELECT value FROM json_each(?)) GROUP BY identity`)
    .all(userId, JSON.stringify(problems.map(identityOf))) as Array<{ identity: string; solved: number }>;
  const known = new Map(rows.map(p => [p.identity, p.solved]));
  return problems.map(p => {
    const solved = known.get(identityOf(p));
    return solved === undefined ? '未收录，未查到 AC 记录' : solved ? '已 AC' : '未 AC（同步记录）';
  });
}

export interface CatalogProblem {
  platform: PlatformId;
  problemKey: string;
  title: string;
  difficulty: number | null;
  url: string | null;
  tags: string[];
  solved: boolean;
}

/** SQL 过滤后分页，避免固定截取题库前几百题而漏掉难度/标签匹配的候选。 */
export function searchProblems(
  db: Db, userId: number, args: Record<string, unknown>,
  preference: { level?: number; weakTags?: string[] } = {},
): { total: number; problems: CatalogProblem[]; nextOffset: number | null } {
  const where: string[] = [];
  const params: Array<string | number> = [userId];
  const status = args.status ?? 'unsolved';
  if (!['unsolved', 'ac', 'all'].includes(String(status))) throw new Error('status 需为 unsolved / ac / all');
  if (status !== 'all') { where.push('solved = ?'); params.push(status === 'ac' ? 1 : 0); }
  if (typeof args.platform === 'string' && args.platform.trim()) { where.push('platform = ?'); params.push(args.platform.trim()); }
  for (const [name, op] of [['difficultyMin', '>='], ['difficultyMax', '<=']] as const) {
    if (args[name] !== undefined) {
      if (typeof args[name] !== 'number' || !Number.isFinite(args[name])) throw new Error(`${name} 需为有限数值`);
      where.push(`difficulty ${op} ?`); params.push(args[name]);
    }
  }
  if (typeof args.tag === 'string' && args.tag.trim()) {
    where.push('EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE \'[]\' END) WHERE lower(value) IN (SELECT value FROM json_each(?)))');
    params.push(JSON.stringify(expandTag(args.tag.trim()).map(t => t.toLowerCase())));
  }
  if (typeof args.query === 'string' && args.query.trim()) {
    where.push('(instr(lower(title), ?) > 0 OR instr(lower(problem_key), ?) > 0)');
    params.push(args.query.trim().toLowerCase(), args.query.trim().toLowerCase());
  }
  const boundedInt = (name: string, fallback: number, min: number, max: number) => {
    const value = args[name] ?? fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 需为 ${min}-${max} 的整数`);
    return value;
  };
  const limit = boundedInt('limit', 50, 1, 100);
  const offset = boundedInt('offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const filtered = `${catalogCte(db)} SELECT platform, problem_key, title, difficulty, url, tags, solved
    FROM catalog${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${filtered})`).get(...params) as { n: number }).n;
  const weakAliases = (preference.weakTags ?? []).flatMap(t => expandTag(t).map(t => t.toLowerCase()));
  const level = preference.level ?? 1200;
  const rows = db.prepare(`${filtered}
    ORDER BY EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags) THEN tags ELSE '[]' END)
      WHERE lower(value) IN (SELECT value FROM json_each(?))) DESC,
      difficulty IS NULL, abs(difficulty - ?), platform, problem_key
    LIMIT ? OFFSET ?`).all(...params, JSON.stringify(weakAliases), level, limit, offset) as Array<{
      platform: PlatformId; problem_key: string; title: string; difficulty: number | null; url: string | null; tags: string; solved: number;
    }>;
  return {
    total,
    problems: rows.map(({ problem_key, tags, solved, ...p }) => ({ ...p, problemKey: problem_key, tags: safeTags(tags), solved: Boolean(solved) })),
    nextOffset: offset + rows.length < total ? offset + rows.length : null,
  };
}

