import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { localDayOf, localToday } from '../src/dates.ts';
import { checkinsRoutes } from '../src/routes/checkins.ts';

/**
 * 「本地日界」统一口径测试。
 *
 * 背景：服务端多处曾用 toISOString().slice(0,10) 取「今天」（UTC 日界），
 * 而计划/打卡/日历的 task_date 与客户端月视图是本地日——UTC+8 的 00:00–07:59 之间
 * 连续打卡少一天、复习「今日到期」错位、凌晨生成的计划起始日是昨天。
 * 统一入口是 src/dates.ts 的 localDayOf / localToday（进程本地时区）。
 */

test('localDayOf: 与 Intl 本地日格式一致（锚点，机器时区无关）', () => {
  // en-CA 默认输出本地时区 YYYY-MM-DD，作为独立基准互相印证
  const fmt = new Intl.DateTimeFormat('en-CA');
  for (const iso of [
    '2026-09-22T17:00:00.000Z', // UTC+8 已是次日 01:00
    '2026-09-22T16:00:00.000Z',
    '2026-06-30T20:30:00.000Z',
    '2026-01-01T00:30:00.000Z',
  ]) {
    const d = new Date(iso);
    assert.equal(localDayOf(d), fmt.format(d), iso);
  }
});

test('localToday: 格式合法且与 localDayOf(now) 一致', () => {
  assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localToday(), localDayOf(new Date()));
});

test('checkins streak: 本机时区能区分 UTC 日界时，凌晨打卡按本地日记连续', async (t) => {
  // 选一个「本地日 ≠ UTC 日」的时刻；UTC 时区机器上两者恒等，无法区分口径 → 跳过
  //（口径正确性由上面的锚点单测保证，这里验证路由接线）
  const fmt = new Intl.DateTimeFormat('en-CA');
  const candidates = ['2026-09-22T17:00:00.000Z', '2026-06-15T20:00:00.000Z', '2026-01-01T02:00:00.000Z'];
  const probe = candidates.find((iso) => {
    const d = new Date(iso);
    return fmt.format(d) !== d.toISOString().slice(0, 10);
  });
  if (!probe) return t.skip('本机时区与 UTC 同日界，无法区分口径');
  t.mock.timers.enable({ now: new Date(probe), apis: ['Date'] });

  const db: Db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/checkins', checkinsRoutes(db));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/checkins`;
  try {
    // 本地「今天」与「昨天」各打卡一题：本地口径下 current = 2；
    // 若实现用 UTC 日界（凌晨场景 = 本地昨天），current 只会数到 1
    const todayLocal = fmt.format(new Date());
    const yesterdayLocal = localDayOf(new Date(Date.now() - 86_400_000));
    for (const d of [todayLocal, yesterdayLocal]) {
      db.prepare(
        "INSERT INTO plans (user_id, title, goal, start_date, end_date, source) VALUES (1, 'p', '', ?, ?, 'template')",
      ).run(d, d);
      const planId = (db.prepare('SELECT id FROM plans ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
      db.prepare("INSERT INTO plan_tasks (plan_id, task_date, title, kind) VALUES (?, ?, 't', 'practice')").run(planId, d);
      const taskId = (db.prepare('SELECT id FROM plan_tasks ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
      const r = await fetch(`${base}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId }) });
      assert.equal(r.status, 200);
    }
    const res = await fetch(`${base}/streak`);
    const streak = (await res.json()) as { current: number };
    assert.equal(streak.current, 2, '凌晨打卡必须按本地日界计入连续');
  } finally {
    srv.close();
    db.close();
  }
});
