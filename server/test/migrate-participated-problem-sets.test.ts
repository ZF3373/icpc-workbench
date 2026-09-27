import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';

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
