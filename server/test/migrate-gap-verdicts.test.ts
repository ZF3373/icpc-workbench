import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';

/**
 * v0.10 数据修复：作废「题号形态不可信」的难度定论。
 *
 * 事故（2026-09-28 取证）：AtCoder 库内题号是展示形态 `abc300a`，kenkoooo 整表是 `abc300_a`
 * → 整表查不到；AtCoder 属于「单次响应即完整题库」，这个 miss 被当成定论写下 30 天负缓存，
 * 于是这些行被挡在回填目标之外，永远补不上 `native_difficulty`。查询侧的归一/形态校验只对
 * **新写下**的定论生效，所以已存在的旧定论必须由迁移作废一次，否则用户得知道去点「强制重查」。
 *
 * migrate() 只在 createDb 时触发，故用临时文件库「写旧数据 → 重开」来驱动。
 */

const OLD = '2026-09-27T11:37:44.016Z'; // 修复前（< GAP_VERDICT_CUTOFF）
const NEW = '2026-09-29T00:00:00.000Z'; // 修复后（新代码写下的定论时刻）

test('migrate: 作废形态不可信的难度定论，保留合法定论，且重复打开不再变化', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-migrate-gap-'));
  const file = path.join(dir, 'icpc.db');
  try {
    const db1 = createDb(file);
    const ins = db1.prepare(
      `INSERT INTO problems (platform, problem_key, title, difficulty, gap_state, gap_checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // ① 作废：AtCoder 展示形态（无下划线）—— 补一个下划线就可能命中整表
    ins.run('atcoder', 'abc300a', 'A - N-choice question', 2200, 'difficulty', OLD);
    // ② 作废：原生无下划线的 joi 题号（候选表有两种形态，迁移里无法区分，一并重查一次；
    //    整表平台查表不逐题发请求，代价可忽略）
    ins.run('atcoder', 'joi2011ho1', 'JOI 2011 本選 1', 1200, 'difficulty', OLD);
    // ③ 保留：规范题号（表里就是这个形态）
    ins.run('atcoder', 'abc308_a', 'A', 1000, 'difficulty', OLD);
    // ④ 保留：修复后重新写下的定论（带新时刻 → 不被二次清掉，迁移因此幂等）
    ins.run('atcoder', 'abc309b', 'B', 1100, 'difficulty', NEW);
    // ⑤ 保留：CF 不在此列（查表前就有大写归一，题号形态不会造成 miss；
    //    且实测存在 `92101` 这类纯数字合法表键，静态规则分不清它与手滑写短的键）
    ins.run('codeforces', '1234', '短题号', null, 'difficulty', OLD);
    ins.run('codeforces', '100153A', 'gym 题', null, 'difficulty', OLD);
    ins.run('codeforces', '92101', 'ICPC 风格题号', 3200, 'tags', OLD);
    // ⑦ 逐题型平台的定论一条都不动（重查它们要逐题打上游，不能顺手清）
    ins.run('luogu', 'P2001', '洛谷题', null, 'difficulty,tags', OLD);
    db1.close();

    const db2 = createDb(file); // 第二次打开触发 migrate
    const gap = (platform: string, key: string): string | null => {
      const row = db2
        .prepare('SELECT gap_state, gap_checked_at FROM problems WHERE platform = ? AND problem_key = ?')
        .get(platform, key) as { gap_state: string | null; gap_checked_at: string | null };
      return row.gap_state;
    };
    assert.equal(gap('atcoder', 'abc300a'), null, '展示形态题号的定论必须作废（否则永远解不开）');
    assert.equal(gap('atcoder', 'joi2011ho1'), null, '无法在迁移里区分原生无下划线形态 → 保守清掉重查');
    assert.equal(gap('atcoder', 'abc308_a'), 'difficulty', '规范题号照旧保留');
    assert.equal(gap('atcoder', 'abc309b'), 'difficulty', '修复后写下的定论（新时刻）不再被清');
    assert.equal(gap('codeforces', '1234'), 'difficulty', 'CF 不在修复范围内（形态不会造成 miss）');
    assert.equal(gap('codeforces', '100153A'), 'difficulty', 'gym 键形态合法 → 保留');
    assert.equal(gap('codeforces', '92101'), 'tags', '纯数字题号（比赛 921 + 题号 01）合法 → 保留');
    assert.equal(gap('luogu', 'P2001'), 'difficulty,tags', '逐题型平台的定论不动（重查要逐题打上游）');

    // 被作废的行重新进入回填目标（该行仍有缺口）；保留的行不在其中
    const targets = (db2
      .prepare(
        `SELECT problem_key FROM problems
          WHERE (difficulty IS NULL OR native_difficulty IS NULL OR tags = '[]') AND gap_state IS NULL`,
      )
      .all() as Array<{ problem_key: string }>).map((r) => r.problem_key);
    assert.deepEqual(targets.sort(), ['abc300a', 'joi2011ho1']);

    // 幂等：第三次打开不再产生变化（被清的行没有被重新清的理由，保留的行也没动）
    db2.close();
    const db3 = createDb(file);
    const rows = db3
      .prepare('SELECT platform, problem_key, gap_state FROM problems ORDER BY platform, problem_key')
      .all() as Array<{ platform: string; problem_key: string; gap_state: string | null }>;
    assert.deepEqual(
      rows.map((r) => `${r.platform}/${r.problem_key}=${r.gap_state ?? '-'}`),
      [
        'atcoder/abc300a=-',
        'atcoder/abc308_a=difficulty',
        'atcoder/abc309b=difficulty',
        'atcoder/joi2011ho1=-',
        'codeforces/100153A=difficulty',
        'codeforces/1234=difficulty',
        'codeforces/92101=tags',
        'luogu/P2001=difficulty,tags',
      ],
    );
    db3.close();
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows 下 WAL 句柄释放可能滞后，删不掉就留给系统临时目录清理
    }
  }
});
