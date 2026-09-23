import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';
import { upsertBankProblems } from '../src/import/bankService.ts';
import { insertNormalized } from '../src/import/importService.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';

let db: Db | undefined;
afterEach(() => { db?.close(); db = undefined; });

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const d = createDb(':memory:');
  db = d;
  d.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  d.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('luogu','洛谷',1)").run();
  // 真重复：平台 + 标题 + 归一化题号（去空格、忽略大小写）完全相同 —— '1a' 与 ' 1A' 归一化后同为 '1a'
  d.prepare(
    "INSERT INTO problems (id,platform,problem_key,title,tags) VALUES (1,'codeforces','1a','Two Sum','[]')",
  ).run();
  // 保留行候选：题号带空格但归一化相同，且有提交记录 → 优先保留
  d.prepare(
    "INSERT INTO problems (id,platform,problem_key,title,tags) VALUES (2,'codeforces',' 1A','Two Sum','[]')",
  ).run();
  // 同标题但题号不同（归一化后也不同）：CF 题库跨轮次撞名的不同题，不得判为重复
  d.prepare(
    "INSERT INTO problems (id,platform,problem_key,title,tags) VALUES (3,'codeforces','P1A','Two Sum','[]')",
  ).run();
  // 跨平台同标题：不在去重范围
  d.prepare(
    "INSERT INTO problems (id,platform,problem_key,title,tags) VALUES (4,'luogu','P1001','Two Sum','[]')",
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

test('GET duplicates: 平台+标题+归一化题号都相同才成组，优先保留有提交记录的行', async () => {
  await withServer(async (base) => {
    const d = db!;
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',2,'AC','2024-01-01T00:00:00.000Z','s1')",
    ).run();

    const res = await fetch(`${base}/duplicates`);
    assert.equal(res.status, 200);
    const groups = (await res.json()) as Array<{
      platform: string;
      title: string;
      keep: { id: number; problemKey: string; attempts: number };
      remove: Array<{ id: number; problemKey: string; attempts: number }>;
    }>;
    assert.equal(groups.length, 1, '同标题不同题号 / 跨平台同标题都不算重复');
    assert.equal(groups[0].platform, 'codeforces');
    assert.equal(groups[0].keep.problemKey, ' 1A', '优先保留有提交记录的行');
    assert.equal(groups[0].keep.attempts, 1);
    assert.deepEqual(groups[0].remove.map((r) => r.problemKey), ['1a']);
  });
});

test('clean-tags: 删除重复题并把提交/计划任务并入保留行，复习条目冲突时丢弃重复行的', async () => {
  await withServer(async (base) => {
    const d = db!;
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',2,'AC','2024-01-01T00:00:00.000Z','s1')",
    ).run();
    d.prepare(
      "INSERT INTO plans (id,user_id,title,goal,start_date,end_date,source) VALUES (1,1,'p','g','2024-01-01','2024-01-31','manual')",
    ).run();
    d.prepare(
      "INSERT INTO plan_tasks (id,plan_id,task_date,title,kind,problem_id) VALUES (1,1,'2024-01-05','练 Two Sum','practice',1)",
    ).run();
    d.prepare(
      "INSERT INTO review_items (user_id,problem_id,next_due_on,note) VALUES (1,1,'2024-01-10','重复行的笔记')",
    ).run();
    d.prepare(
      "INSERT INTO review_items (user_id,problem_id,next_due_on,note) VALUES (1,2,'2024-01-11','保留行的笔记')",
    ).run();

    const res = await fetch(`${base}/clean-tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; duplicatesRemoved: number };
    assert.equal(body.duplicatesRemoved, 1);

    // 只删真重复：'1a' 被删，' 1A'（保留行）与撞名的 'P1A' 都还在
    const left = d.prepare("SELECT problem_key FROM problems WHERE platform = 'codeforces' AND title = 'Two Sum' ORDER BY id").all() as Array<{ problem_key: string }>;
    assert.deepEqual(left.map((r) => r.problem_key), [' 1A', 'P1A']);
    // 提交仍挂在保留行上（并入而非删除）
    assert.equal(
      (d.prepare('SELECT COUNT(*) c FROM submissions WHERE problem_id = 2').get() as { c: number }).c,
      1,
    );
    // 计划任务改指向保留行
    assert.equal(
      (d.prepare('SELECT problem_id FROM plan_tasks WHERE id = 1').get() as { problem_id: number | null }).problem_id,
      2,
    );
    // 复习条目冲突（保留行已有同一用户的）：丢弃重复行的，保留行的原样保留
    const reviews = d.prepare('SELECT problem_id, note FROM review_items ORDER BY id').all() as Array<{ problem_id: number; note: string }>;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].problem_id, 2);
    assert.equal(reviews[0].note, '保留行的笔记');

    // 被删的重复题号记入 deleted_problems，题库重拉不得复活（保留行不动）
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM deleted_problems WHERE platform = 'codeforces' AND problem_key = '1a'").get() as { c: number }).c,
      1,
    );
    upsertBankProblems(d, [
      {
        platform: 'codeforces',
        problemKey: '1a',
        title: 'Two Sum',
        difficulty: null,
        nativeDifficulty: null,
        difficultyScale: null,
        url: null,
        tags: [],
      },
      // 归一化等价类的规范键变体：题库版本更新后下发 '1A'/' 1A' 同样不得绕过墓碑（PR 审查反馈）
      {
        platform: 'codeforces',
        problemKey: '1A',
        title: 'Two Sum',
        difficulty: null,
        nativeDifficulty: null,
        difficultyScale: null,
        url: null,
        tags: [],
      },
    ]);
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM problems WHERE problem_key IN ('1a', '1A')").get() as { c: number }).c,
      0,
      '墓碑按归一化题号匹配，任何原始键变体都不应被题库重建',
    );
  });
});

test('clean-tags: 保留行没有复习条目时，重复行的复习条目并入保留行', async () => {
  await withServer(async (base) => {
    const d = db!;
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',2,'AC','2024-01-01T00:00:00.000Z','s1')",
    ).run();
    d.prepare(
      "INSERT INTO review_items (user_id,problem_id,next_due_on,note) VALUES (1,1,'2024-01-10','要搬走的笔记')",
    ).run();

    const res = await fetch(`${base}/clean-tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    const review = d.prepare('SELECT problem_id, note FROM review_items').get() as { problem_id: number; note: string };
    assert.equal(review.problem_id, 2, '复习条目并入保留行');
    assert.equal(review.note, '要搬走的笔记');
  });
});

/**
 * 去重墓碑与保留行同属一个归一化等价类（判重键就是 platform + 标题 + 归一化题号）。
 * 只看等价类会把保留行此后所有的同步提交与题库更新一起永久挡掉：
 * 表现为「这道题同步多少次提交数都不涨」，且毫无报错。放行条件 = 写入题号库里已有同键行
 * （那是更新保留行，既不复活被删的那一行，也不新增等价类的第二行）。
 */
const subFor = (problemKey: string, externalId: string): NormalizedSubmission => ({
  problem: { platform: 'codeforces', problemKey, title: 'Two Sum', difficulty: 1500, tags: [] },
  verdict: 'AC',
  submittedAt: '2024-02-01T00:00:00.000Z',
  externalId,
});

test('clean-tags: 去重墓碑不得把保留题号后续的同步与题库更新一起永久挡掉', async () => {
  await withServer(async (base) => {
    const d = db!;
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',2,'AC','2024-01-01T00:00:00.000Z','s1')",
    ).run();
    const res = await fetch(`${base}/clean-tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    // 前置：'1a' 被删并记墓碑，保留行是 ' 1A'（等价类的另一个变体）
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM deleted_problems WHERE problem_key = '1a'").get() as { c: number }).c,
      1,
    );

    // 保留行自己的题号：必须照常收新提交（修复前 skipped=1，这道题从此同步不进来）
    const sync = insertNormalized(d, 1, [subFor(' 1A', 's2')]);
    assert.equal(sync.imported, 1, '保留题号的新提交应入库');
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM problems WHERE platform = 'codeforces' AND title = 'Two Sum'").get() as { c: number })
        .c,
      2,
      '只更新保留行，不得新增等价类的第二行（保留行 + 撞名的 P1A）',
    );

    // 题库更新同样要落到保留行上（标题/难度修正不再被墓碑吞掉）
    upsertBankProblems(d, [
      {
        platform: 'codeforces',
        problemKey: ' 1A',
        title: 'Two Sum（题库修正名）',
        difficulty: 1500,
        nativeDifficulty: null,
        difficultyScale: null,
        url: null,
        tags: [],
      },
    ]);
    assert.equal(
      (d.prepare("SELECT title FROM problems WHERE id = 2").get() as { title: string }).title,
      'Two Sum（题库修正名）',
    );

    // 等价类的其它变体键仍然挡住：既非保留行的同键，就会重建重复行
    const variant = insertNormalized(d, 1, [subFor('1A', 's3')]);
    assert.equal(variant.imported, 0, '变体键不得借道墓碑重建第二行');
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM problems WHERE problem_key = '1A'").get() as { c: number }).c,
      0,
    );
  });
});
