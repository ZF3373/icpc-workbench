import type { Db } from '../db/index.ts';

/** 自建知识点词表。规则仅使用题名，不读取题源 tags；低置信度结果不写入。 */
const RULES: Array<{ id: string; patterns: RegExp[] }> = [
  { id: '二分', patterns: [/binary search/i, /二分/] },
  { id: '动态规划', patterns: [/dynamic programming/i, /\bdp\b/i, /动态规划/] },
  { id: '图论', patterns: [/graph/i, /图论|图上/] },
  { id: '最短路', patterns: [/dijkstra|shortest path/i, /最短路/] },
  { id: '树上算法', patterns: [/\btree\b/i, /树链|树上/] },
  { id: '字符串', patterns: [/string|kmp|z-function|suffix/i, /字符串|字典树/] },
  { id: '数据结构', patterns: [/segment tree|fenwick|bit\b|heap/i, /线段树|树状数组|堆/] },
  { id: '并查集', patterns: [/union find|disjoint set|\bdsu\b/i, /并查集/] },
  { id: '贪心', patterns: [/greedy/i, /贪心/] },
  { id: '数论', patterns: [/prime|gcd|modulo|number theory/i, /质数|素数|最大公约数|数论/] },
  { id: '组合计数', patterns: [/combinatorics|permutation|combination/i, /组合|排列/] },
  { id: '计算几何', patterns: [/geometry|convex hull/i, /几何|凸包/] },
];

export const TOPIC_PIPELINE_VERSION = 'title-rules-v1';

export interface TopicAnnotation {
  topicId: string;
  confidence: number;
  method: 'title-rule';
  evidence: string[];
}

export function annotateTitle(title: string): TopicAnnotation[] {
  return RULES.flatMap((rule) => {
    const evidence = rule.patterns.filter((p) => p.test(title)).map((p) => p.source);
    return evidence.length ? [{ topicId: rule.id, confidence: 0.8, method: 'title-rule' as const, evidence }] : [];
  });
}

export function refreshProblemTopics(db: Db, problemId: number, title: string): number {
  const remove = db.prepare('DELETE FROM problem_topics WHERE problem_id = ? AND method = ?');
  const insert = db.prepare(
    `INSERT INTO problem_topics (problem_id, topic_id, confidence, method, evidence, pipeline_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  remove.run(problemId, 'title-rule');
  const annotations = annotateTitle(title);
  for (const item of annotations) {
    insert.run(problemId, item.topicId, item.confidence, item.method, JSON.stringify(item.evidence), TOPIC_PIPELINE_VERSION);
  }
  return annotations.length;
}

/** 对已拉取题库进行批处理，原子替换当前管线版本的结果。 */
export function rebuildTopicAnnotations(db: Db, limit = 5000): { scanned: number; annotated: number } {
  const rows = db.prepare('SELECT id, title FROM problems ORDER BY id LIMIT ?').all(limit) as Array<{ id: number; title: string }>;
  let annotated = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      annotated += refreshProblemTopics(db, row.id, row.title);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { scanned: rows.length, annotated };
}
