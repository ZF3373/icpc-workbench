import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import { annotateTitle, rebuildTopicAnnotations } from '../src/topics/pipeline.ts';

test('topic pipeline derives topics from title without source tags', () => {
  assert.deepEqual(annotateTitle('Binary Search on a Tree').map((x) => x.topicId), ['二分', '树上算法']);
  assert.deepEqual(annotateTitle('完全背包问题').map((x) => x.topicId), []);
});

test('topic rebuild persists structured, auditable annotations', () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', '1A', 'Dijkstra shortest path', '[\"greedy\"]')").run();
    assert.deepEqual(rebuildTopicAnnotations(db), { scanned: 1, annotated: 1 });
    const row = db.prepare('SELECT topic_id, confidence, method, evidence, pipeline_version FROM problem_topics').get() as {
      topic_id: string; confidence: number; method: string; evidence: string; pipeline_version: string;
    };
    assert.equal(row.topic_id, '最短路');
    assert.equal(row.confidence, 0.8);
    assert.equal(row.method, 'title-rule');
    assert.equal(row.pipeline_version, 'title-rules-v1');
    assert.match(row.evidence, /dijkstra/);
  } finally {
    db.close();
  }
});
