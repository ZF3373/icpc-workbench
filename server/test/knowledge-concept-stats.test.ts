import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import {
  informativeness,
  INFORMATIVENESS_FLOOR,
  recomputeConceptStats,
  conceptStatsFor,
  informativenessFor,
} from '../src/knowledge/conceptStats.ts';

test('informativeness: 1 - 二元熵 —— 越常见越无区分度，p=0.5 信息量最低', () => {
  // 退化边界：全有或全无 → 无区分度
  assert.equal(informativeness(1), 0);
  assert.equal(informativeness(0), 0);
  // p=0.5 时熵最大，取补集后信息量最低（为 0）
  assert.equal(informativeness(0.5), 0);
  // 24.8%（数学粗类实测占比）应接近 0
  const math = informativeness(0.248);
  assert.ok(math > 0 && math < 0.2, `数学粗类信息量应接近 0，实得 ${math}`);
  // 5.9%（数论）明显高于粗类
  assert.ok(informativeness(0.059) > math, '细粒度概念信息量应高于粗类');
  // 下限夹取：由调用方在消费时执行，这里验证 Math.max(FLOOR, 极小原始值)
  const saturated = Math.max(INFORMATIVENESS_FLOOR, informativeness(0.45));
  assert.equal(saturated, INFORMATIVENESS_FLOOR);
});

test('recomputeConceptStats: 按难度桶物化占比与信息量', () => {
  const db = createDb(':memory:');
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  const insP = db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces',?,'T',1500,'[]')");
  for (let i = 0; i < 20; i += 1) insP.run(`P${i}`);
  const insK = db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,?,'n',1,'tag','tag',1,1,'2026-01-01')`);
  // 贪心覆盖 5/20 = 0.25（低信息量，原始值低于 FLOOR）
  for (let i = 0; i < 5; i += 1) insK.run(`P${i}`, 'basic.greedy');
  // 排序覆盖 1/20 = 0.05（高信息量）
  insK.run('P5', 'misc.sorting');

  const written = recomputeConceptStats(db);
  assert.ok(written >= 2);
  const stats = conceptStatsFor(db, '1400-1599');
  assert.ok((stats.get('basic.greedy') ?? 1) < (stats.get('misc.sorting') ?? 0),
    '覆盖 25% 的贪心原始信息量应低于覆盖 5% 的排序');
  assert.equal(informativenessFor(db, '1400-1599', 'basic.greedy'), Math.max(INFORMATIVENESS_FLOOR, stats.get('basic.greedy')!));
  // 未知 code 缺省权重 1（不过度惩罚未统计到的概念）
  assert.equal(informativenessFor(db, '1400-1599', '不存在的code'), 1);
  db.close();
});

test('recomputeConceptStats: 按难度桶分层 —— 同一 code 在不同桶得到不同信息量', () => {
  // spec §2.3：膨胀是难度相关的。同一「贪心」在低难度桶占比高（低信息量）、
  // 在高难度桶占比低（较高信息量），两个桶必须分别统计，不可混算。
  // 注：2400 落在分档后的 2200-2599 桶（issue 37 把原 `2200+` 拆成两档）。
  const db = createDb(':memory:');
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  const insP = db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces',?,'T',?,'[]')");
  const insK = db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,'basic.greedy','贪心',1,'tag','tag',1,1,'2026-01-01')`);
  // <1200 桶：20 题里 5 题标贪心（占比 0.25 → 低信息量）
  for (let i = 0; i < 20; i += 1) {
    insP.run(`L${i}`, 900);
    if (i < 5) insK.run(`L${i}`);
  }
  // 2200-2599 桶：20 题里 1 题标贪心（占比 0.05 → 较高信息量）
  for (let i = 0; i < 20; i += 1) {
    insP.run(`H${i}`, 2400);
    if (i === 0) insK.run(`H${i}`);
  }
  recomputeConceptStats(db);

  const low = conceptStatsFor(db, '<1200').get('basic.greedy');
  const high = conceptStatsFor(db, '2200-2599').get('basic.greedy');
  assert.ok(low !== undefined && high !== undefined, '两个桶都应有贪心的统计');
  assert.ok(low! < high!, `低难度桶信息量(${low}) 应低于高难度桶(${high})`);
  // 分层验证：两桶的 share 分别按各自桶内总题数计算（都是 20 题）
  const rows = db.prepare(
    "SELECT bucket, problem_count, share FROM knowledge_concept_stats WHERE code='basic.greedy' ORDER BY bucket",
  ).all() as Array<{ bucket: string; problem_count: number; share: number }>;
  assert.equal(rows.length, 2, '应只有两个桶有统计，不能混算成一个');
  assert.ok(rows.every((r) => r.share === 0.25 || r.share === 0.05));
  db.close();
});

test('recomputeConceptStats: 重复执行幂等（同结果不重复膨胀）', () => {
  const db = createDb(':memory:');
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','P0','T',1500,'[]')").run();
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','P0','misc.sorting','n',1,'tag','tag',1,1,'2026-01-01')`).run();
  recomputeConceptStats(db);
  const a = db.prepare(
    'SELECT code, bucket, problem_count, share, informativeness FROM knowledge_concept_stats ORDER BY bucket, code'
  ).all();
  recomputeConceptStats(db);
  const b = db.prepare(
    'SELECT code, bucket, problem_count, share, informativeness FROM knowledge_concept_stats ORDER BY bucket, code'
  ).all();
  assert.deepEqual(a, b);
  db.close();
});
