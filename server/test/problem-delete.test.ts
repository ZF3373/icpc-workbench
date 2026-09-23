import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { upsertBankProblems } from '../src/import/bankService.ts';
import {
  initKnowledgeStore,
  loadAnnotationsIntoDb,
  setManualKeypoints,
} from '../src/knowledge/store.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';

let db: Db | undefined;
afterEach(() => { db?.close(); db = undefined; });

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const d = createDb(':memory:');
  db = d;
  d.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  d.prepare(
    "INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (1,'codeforces','1A','T',1500,'[]')",
  ).run();
  // 重复/镜像题（issue #27 的删除对象）：同题不同 id 无法在同库出现（UNIQUE 约束），
  // 用户实际遇到的重复是跨平台镜像或误导入行 —— 这里用第二行模拟「想清掉的行」
  d.prepare(
    "INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (2,'atcoder','abc001_a','T',1000,'[]')",
  ).run();
  const app = express();
  app.use(express.json());
  app.use('/api/problems', problemsRoutes(d));
  const srv = app.listen(0);
  await new Promise<void>((r) => srv.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/problems`);
  } finally {
    srv.close();
  }
}

test('DELETE: 连带清理提交/复习/卡点/知识点，训练计划任务仅解除引用', async () => {
  await withServer(async (base) => {
    const d = db!;
    // 从属数据：2 条提交、1 条复习、1 条卡点、1 条知识点标注、1 个引用该题的计划任务
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',1,'AC','2024-01-01T00:00:00.000Z','s1')",
    ).run();
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',1,'WA','2024-01-02T00:00:00.000Z','s2')",
    ).run();
    d.prepare(
      "INSERT INTO review_items (user_id,problem_id,next_due_on,note) VALUES (1,1,'2024-01-10','笔记')",
    ).run();
    d.prepare(
      "INSERT INTO submission_intents (user_id,problem_id,outcome) VALUES (1,1,'implementation')",
    ).run();
    d.prepare(
      "INSERT INTO problem_keypoints (platform,problem_key,code,confidence,source,method,taxonomy_version,pipeline_version,annotated_at) VALUES ('codeforces','1A','basic.dp',0.9,'rule','rule#r001',1,1,'2024-01-01T00:00:00.000Z')",
    ).run();
    d.prepare(
      "INSERT INTO plans (id,user_id,title,goal,start_date,end_date,source) VALUES (1,1,'p','g','2024-01-01','2024-01-31','manual')",
    ).run();
    d.prepare(
      "INSERT INTO plan_tasks (id,plan_id,task_date,title,kind,problem_id) VALUES (1,1,'2024-01-05','练 1A','practice',1)",
    ).run();

    const res = await fetch(`${base}/1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; deletedSubmissions: number; deletedReviewItems: number };
    assert.equal(body.ok, true);
    assert.equal(body.deletedSubmissions, 2);
    assert.equal(body.deletedReviewItems, 1);

    assert.equal((d.prepare('SELECT COUNT(*) c FROM problems WHERE id = 1').get() as { c: number }).c, 0);
    assert.equal((d.prepare('SELECT COUNT(*) c FROM submissions').get() as { c: number }).c, 0);
    assert.equal((d.prepare('SELECT COUNT(*) c FROM review_items').get() as { c: number }).c, 0);
    assert.equal((d.prepare('SELECT COUNT(*) c FROM submission_intents').get() as { c: number }).c, 0);
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM problem_keypoints WHERE platform = 'codeforces' AND problem_key = '1A'").get() as { c: number }).c,
      0,
    );
    // 任务保留，仅解除题目引用
    const task = d.prepare('SELECT title, problem_id FROM plan_tasks WHERE id = 1').get() as {
      title: string;
      problem_id: number | null;
    };
    assert.equal(task.title, '练 1A');
    assert.equal(task.problem_id, null);

    // 无关题目不受影响
    assert.equal((d.prepare('SELECT COUNT(*) c FROM problems WHERE id = 2').get() as { c: number }).c, 1);
  });
});

test('DELETE: 不存在的 id 返回 404，非法 id 返回 400', async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/999`, { method: 'DELETE' });
    assert.equal(missing.status, 404);

    const invalid = await fetch(`${base}/abc`, { method: 'DELETE' });
    assert.equal(invalid.status, 400);
  });
});

const sub1A = (externalId: string): NormalizedSubmission => ({
  problem: { platform: 'codeforces', problemKey: '1A', title: 'T', difficulty: 1500, tags: [] },
  verdict: 'AC',
  submittedAt: '2024-01-03T00:00:00.000Z',
  externalId,
});

const countOf = (d: Db, sql: string, ...params: Array<string | number>): number =>
  (d.prepare(sql).get(...params) as { c: number }).c;

test('DELETE: 题号记入墓碑后，同步与题库拉取不再重建；手动导入视为找回', async () => {
  await withServer(async (base) => {
    const d = db!;
    // 先留一条提交，验证删除后同步不会把它连题目一起复活
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',1,'AC','2024-01-01T00:00:00.000Z','s0')",
    ).run();
    assert.equal((await fetch(`${base}/1`, { method: 'DELETE' })).status, 200);

    // 同步来源：题目与提交一起跳过
    const sync = insertNormalized(d, 1, [sub1A('s1')]);
    assert.equal(sync.imported, 0);
    assert.equal(sync.skipped, 1);
    assert.equal(countOf(d, "SELECT COUNT(*) c FROM problems WHERE platform = 'codeforces' AND problem_key = '1A'"), 0);
    assert.equal(countOf(d, 'SELECT COUNT(*) c FROM submissions'), 0);

    // 题库拉取（含启动时的内置题库播种，同走 upsertBankProblems）：同样被墓碑挡住
    upsertBankProblems(d, [
      {
        platform: 'codeforces',
        problemKey: '1A',
        title: 'T',
        difficulty: 1500,
        nativeDifficulty: null,
        difficultyScale: null,
        url: null,
        tags: [],
      },
    ]);
    assert.equal(countOf(d, "SELECT COUNT(*) c FROM problems WHERE platform = 'codeforces' AND problem_key = '1A'"), 0);

    // 归一化等价类的变体键同样被挡：同步下发 ' 1A' 也不得重建（PR 审查反馈）
    const variant = insertNormalized(d, 1, [
      { ...sub1A('s1b'), problem: { ...sub1A('s1b').problem, problemKey: ' 1A' } },
    ]);
    assert.equal(variant.imported, 0);
    assert.equal(countOf(d, "SELECT COUNT(*) c FROM problems WHERE platform = 'codeforces' AND problem_key = ' 1A'"), 0);

    // 手动导入 = 用户显式找回：清墓碑、重建题目、提交入库
    const manual = insertNormalized(d, 1, [sub1A('manual:1')]);
    assert.equal(manual.imported, 1);
    assert.equal(
      countOf(d, "SELECT COUNT(*) c FROM problems WHERE platform = 'codeforces' AND problem_key = '1A'"),
      1,
    );
    assert.equal(countOf(d, 'SELECT COUNT(*) c FROM deleted_problems'), 0, '手动导入后墓碑应清除');
  });
});

test('DELETE: 账号换绑全量重置（clearPlatform）连同该平台墓碑一起清空，新账号提交不丢', async () => {
  await withServer(async (base) => {
    const d = db!;
    assert.equal((await fetch(`${base}/1`, { method: 'DELETE' })).status, 200);
    const r = insertNormalized(d, 1, [sub1A('s2'), sub1A('s3')], { clearPlatform: 'codeforces' });
    assert.equal(r.imported, 2, '换账号同步必须完整拉回，不被旧账号的墓碑卡住');
    assert.equal(countOf(d, 'SELECT COUNT(*) c FROM deleted_problems'), 0);
  });
});

test('DELETE: JSONL 四来源墓碑阻止标注重放复活', async () => {  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prob-del-'));
  initKnowledgeStore(dir);
  let db2: Db | undefined;
  try {
    await withServer(async (base) => {
      const d = db!;
      // 两道 manual 校正各写一条 JSONL 快照；abc001_a 是「对照组」，重放后必须还在
      setManualKeypoints(d, 'codeforces', '1A', ['dp.general']);
      setManualKeypoints(d, 'atcoder', 'abc001_a', ['basic.greedy']);
      assert.equal((await fetch(`${base}/1`, { method: 'DELETE' })).status, 200);
      assert.equal(fs.existsSync(path.join(dir, 'knowledge', 'annotations.jsonl')), true, '路由应写 JSONL 墓碑');
    });

    db2 = createDb(':memory:');
    const loaded = loadAnnotationsIntoDb(db2, dir);
    assert.equal(
      countOf(db2, "SELECT COUNT(*) c FROM problem_keypoints WHERE platform = 'codeforces' AND problem_key = '1A'"),
      0,
      '被删题的标注不得经重放复活',
    );
    assert.equal(
      countOf(db2, "SELECT COUNT(*) c FROM problem_keypoints WHERE platform = 'atcoder' AND problem_key = 'abc001_a'"),
      1,
      '对照题的 manual 标注应正常重放（防空洞式通过）',
    );
    assert.ok(loaded.inserted >= 1);
  } finally {
    db2?.close();
    initKnowledgeStore(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('回收站：删除带快照入列表，恢复原样重建题目并清墓碑、同步恢复放行', async () => {
  await withServer(async (base) => {
    const d = db!;
    d.prepare(
      "UPDATE problems SET url='https://codeforces.com/problemset/problem/1/A', tags='[\"贪心\"]', difficulty_source='sync' WHERE id = 1",
    ).run();
    assert.equal((await fetch(`${base}/1`, { method: 'DELETE' })).status, 200);

    const list = (await (await fetch(`${base}/deleted`)).json()) as Array<{
      platform: string;
      problem_key: string;
      title: string | null;
      difficulty: number | null;
      deleted_at: string;
    }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].problem_key, '1A');
    assert.equal(list[0].title, 'T');

    const r = await fetch(`${base}/deleted/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', problemKey: '1A' }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, recreated: true });

    const row = d
      .prepare("SELECT id, title, difficulty, url, tags, difficulty_source FROM problems WHERE platform = 'codeforces' AND problem_key = '1A'")
      .get() as { id: number; title: string; difficulty: number; url: string | null; tags: string; difficulty_source: string | null };
    assert.equal(row.title, 'T', '快照字段应原样恢复');
    assert.equal(row.difficulty, 1500);
    assert.equal(row.url, 'https://codeforces.com/problemset/problem/1/A');
    assert.equal(row.tags, '["贪心"]');
    assert.equal(row.difficulty_source, 'sync');
    assert.equal(countOf(d, 'SELECT COUNT(*) c FROM deleted_problems'), 0);

    // 二次恢复：墓碑已清 → 404
    const again = await fetch(`${base}/deleted/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', problemKey: '1A' }),
    });
    assert.equal(again.status, 404);

    // 墓碑已清：同步来源重新放行
    const sync = insertNormalized(d, 1, [sub1A('s9')]);
    assert.equal(sync.imported, 1);
  });
});

test('回收站：旧墓碑无快照按题号兜底重建；题目已存在时只清墓碑不覆盖', async () => {
  await withServer(async (base) => {
    const d = db!;
    // 模拟补快照列之前写入的裸墓碑（normalized_key 由 migrate 回填，这里直接给出）
    d.prepare("INSERT INTO deleted_problems (platform, problem_key, normalized_key) VALUES ('codeforces', 'ZZ9', 'zz9')").run();
    const r = await fetch(`${base}/deleted/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', problemKey: 'ZZ9' }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, recreated: true });
    const row = d.prepare("SELECT title FROM problems WHERE problem_key = 'ZZ9'").get() as { title: string };
    assert.equal(row.title, 'ZZ9', '无快照时退化为「题号即标题」');

    // 墓碑与现存题目并存（如手动导入未清墓碑的历史态）：只清墓碑，现有行原样保留
    d.prepare("INSERT INTO deleted_problems (platform, problem_key, normalized_key, title) VALUES ('codeforces', '1A', '1a', '陈旧快照')").run();
    const keep = d.prepare("SELECT id FROM problems WHERE problem_key = '1A'").get() as { id: number };
    const r2 = await fetch(`${base}/deleted/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', problemKey: '1A' }),
    });
    assert.deepEqual(await r2.json(), { ok: true, recreated: false });
    const now = d.prepare('SELECT id, title FROM problems WHERE problem_key = ?').get('1A') as { id: number; title: string };
    assert.equal(now.id, keep.id, '现有行不应被动');
    assert.notEqual(now.title, '陈旧快照');
    assert.equal(countOf(d, "SELECT COUNT(*) c FROM deleted_problems WHERE problem_key = '1A'"), 0);
  });
});

test('RESTORE: 恢复去重墓碑时若等价类仍有活行 → 只清墓碑，不重建重复题', async () => {
  await withServer(async (base) => {
    const d = db!;
    // 活行是规范键 '1A'；回收站里的墓碑是去重时记下的变体键 '1a'（同归一化等价类）
    d.prepare(
      "INSERT INTO deleted_problems (platform, problem_key, normalized_key, title, difficulty, tags) VALUES ('codeforces', '1a', '1a', 'T', 1500, '[]')",
    ).run();
    const res = await fetch(`${base}/deleted/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', problemKey: '1a' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; recreated: boolean };
    assert.equal(body.recreated, false, '等价类有活行时不得重建（否则恢复→重复→再清理死循环）');
    // 墓碑被清掉，回收站不再显示
    const trash = await fetch(`${base}/deleted`);
    const items = (await trash.json()) as Array<{ problem_key: string }>;
    assert.equal(items.length, 0);
    // 活行未被复制：等价类内仍只有 1 行
    const rows = d
      .prepare("SELECT problem_key FROM problems WHERE platform='codeforces' AND LOWER(REPLACE(problem_key,' ','')) = '1a'")
      .all() as Array<{ problem_key: string }>;
    assert.deepEqual(rows.map((r) => r.problem_key), ['1A']);
  });
});
