import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { checkinsRoutes, computeStreak } from '../src/routes/checkins.ts';

test('computeStreak handles empty, consecutive and gaps', () => {
  assert.deepEqual(computeStreak([], '2026-08-14'), { current: 0, longest: 0, totalDays: 0 });

  // 今天已打卡，连着前 3 天
  const a = computeStreak(['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'], '2026-08-14');
  assert.deepEqual(a, { current: 4, longest: 4, totalDays: 4 });

  // 今天未打卡但昨天打了 → 连续不断，以昨天为终点
  const b = computeStreak(['2026-08-12', '2026-08-13'], '2026-08-14');
  assert.deepEqual(b, { current: 2, longest: 2, totalDays: 2 });

  // 前天之后断了 → current 0
  const c = computeStreak(['2026-08-12'], '2026-08-14');
  assert.deepEqual(c, { current: 0, longest: 1, totalDays: 1 });

  // 历史最长 > 当前连续
  const d = computeStreak(
    ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-13', '2026-08-14'],
    '2026-08-14',
  );
  assert.deepEqual(d, { current: 2, longest: 5, totalDays: 7 });

  // 无序输入 + 重复日期
  const e = computeStreak(['2026-08-14', '2026-08-13', '2026-08-13'], '2026-08-14');
  assert.deepEqual(e, { current: 2, longest: 2, totalDays: 2 });
});

async function withServer(fn: (db: Db, base: string) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/checkins', checkinsRoutes(db));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/checkins`;
  try {
    await fn(db, base);
  } finally {
    srv.close();
    db.close();
  }
}

test('GET /api/checkins/streak aggregates distinct checkin dates', async () => {
  await withServer(async (db, base) => {
    const day = (offset: number): string => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + offset);
      return d.toISOString().slice(0, 10);
    };
    db.prepare(
      `INSERT INTO plans (user_id, title, goal, start_date, end_date, source)
       VALUES (1, 'p', '', '${day(-1)}', '${day(0)}', 'template')`,
    ).run();
    const insTask = db.prepare(
      "INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (1, ?, ?, 'practice')",
    );
    const insCheckin = db.prepare(
      'INSERT OR IGNORE INTO checkins (user_id, task_id, task_date) VALUES (1, ?, ?)',
    );
    // 昨天两个任务都打卡 + 今天一个任务打卡 → 连续 2 天（不依赖测试运行的日期）
    insTask.run(day(-1), 'a1');
    insTask.run(day(-1), 'a2');
    insTask.run(day(0), 'b1');
    for (const id of [1, 2]) insCheckin.run(id, day(-1));
    insCheckin.run(3, day(0));

    const res = await fetch(`${base}/streak`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { current: number; longest: number; totalDays: number };
    assert.equal(body.current, 2);
    assert.equal(body.longest, 2);
    assert.equal(body.totalDays, 2); // 按天去重
  });
});
