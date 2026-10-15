import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';
import { readContestProblemSet, storeContestProblemSet } from '../src/contests/problemSetCache.ts';

/**
 * v0.9.1 数据修复：参赛记录题目集串台清理。
 * 用文件库验证「打开时自动清理」——内存库无法在迁移已跑过之后回填脏数据。
 */

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const dbPath = path.join(os.tmpdir(), `icpc-migrate-ps-${Date.now()}-${Math.random()}.db`);
  try {
    return fn(dbPath);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

test('迁移：旧库新增官方窗口标记，不改写原始时间、成绩或提交，反复打开保持幂等', () => {
  withTempDb(dbPath => {
    const db = createDb(dbPath);
    db.prepare("INSERT INTO participated_contests(user_id,platform,account,contest_id,start_ms,end_ms,rating,fetched_at) VALUES(1,'codeforces','main','2001',123000,456000,1500,?)").run(new Date().toISOString());
    db.exec('ALTER TABLE participated_contests DROP COLUMN official_window');
    db.close();
    for (let round = 0; round < 2; round++) {
      const reopened = createDb(dbPath);
      try {
        assert.deepEqual({ ...reopened.prepare('SELECT start_ms,end_ms,rating,official_window FROM participated_contests').get() }, {
          start_ms: 123000, end_ms: 456000, rating: 1500, official_window: 0,
        });
      } finally { reopened.close(); }
    }
  });
});

test('迁移：旧库自动建立独立题单缓存，重新打开仍保留且不生成参赛成绩', () => {
  withTempDb(dbPath => {
    const old = createDb(dbPath);
    old.exec('DROP TABLE contest_problem_sets');
    old.close();
    const upgraded = createDb(dbPath);
    storeContestProblemSet(upgraded, 'atcoder', 'abc400', [{ id: 'abc400_a', contestId: 'abc400' }, { id: 'abc400_b', contestId: 'abc400' }]);
    upgraded.close();
    const reopened = createDb(dbPath);
    try {
      assert.equal(readContestProblemSet(reopened, 'atcoder', 'abc400')?.length, 2);
      assert.equal((reopened.prepare('SELECT count(*) AS n FROM participated_contests').get() as { n: number }).n, 0);
    } finally { reopened.close(); }
  });
});

test('迁移：CF/AtCoder 场次里不属于本场的题目集被清空，正确的保留', () => {
  withTempDb((dbPath) => {
    // 1) 先建库并写入脏数据 + 干净数据 + 无前缀约定的平台
    {
      const db = createDb(dbPath);
      const insert = db.prepare(
        `INSERT INTO participated_contests (user_id, platform, account, contest_id, name, problem_ids, problem_set_state, fetched_at)
         VALUES (1, ?, ?, ?, ?, ?, 'ok', ?)`,
      );
      const now = new Date().toISOString();
      // 真实事故：CF 2241（Div.3）存了 20 道牛客「小乐乐」题
      insert.run(
        'codeforces',
        'hie',
        '2241',
        'Codeforces Round 1107 (Div. 3)',
        JSON.stringify([
          { id: '54536', index: 'A', title: '小乐乐学编程' },
          { id: '54537', index: 'B', title: '小乐乐算平均分' },
        ]),
        now,
      );
      // 正确的 CF 题目集：应保留
      insert.run(
        'codeforces',
        'hie',
        '2266',
        'Codeforces Round 1122 (Div. 3)',
        JSON.stringify([{ id: '2266A', index: 'A' }, { id: '2266B', index: 'B' }]),
        now,
      );
      // AtCoder 被串台：应清空
      insert.run('atcoder', 'hie', 'abc454', 'ABC454', JSON.stringify([{ id: '54536', index: 'A' }]), now);
      // 牛客（无前缀约定）：即使 id 是数字也保留
      insert.run(
        'nowcoder',
        'hie',
        '140489',
        '牛客周赛 Round 162',
        JSON.stringify([{ id: '323650', index: 'A' }]),
        now,
      );
      db.close();
    }

    // 2) 重新打开：迁移应清理脏数据（且幂等）
    for (const round of [1, 2]) {
      const db = createDb(dbPath);
      try {
        const read = (platform: string, contestId: string): { problem_ids: string | null; problem_set_state: string | null } =>
          db
            .prepare(
              'SELECT problem_ids, problem_set_state FROM participated_contests WHERE platform = ? AND contest_id = ?',
            )
            .get(platform, contestId) as { problem_ids: string | null; problem_set_state: string | null };

        assert.equal(read('codeforces', '2241').problem_ids, null, `第 ${round} 轮：串台题目集应被清空`);
        assert.equal(read('codeforces', '2241').problem_set_state, null, '状态一并清空 → 下次复盘会重拉正确题目集');
        assert.equal(read('atcoder', 'abc454').problem_ids, null, 'AtCoder 串台同样清理');

        assert.ok(read('codeforces', '2266').problem_ids, '本场题目集必须保留');
        assert.equal(read('codeforces', '2266').problem_set_state, 'ok', '保留的状态不被改动');
        assert.ok(read('nowcoder', '140489').problem_ids, '无前缀约定的平台不动');
      } finally {
        db.close();
      }
    }
  });
});
