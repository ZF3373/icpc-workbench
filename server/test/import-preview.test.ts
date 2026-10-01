import { listenForTest } from './test-listen.ts';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createDb, type Db } from '../src/db/index.ts';
import { insertNormalized } from '../src/import/importService.ts';
import { previewImport } from '../src/import/preview.ts';
import { parseCsvRowsWithReport, parseManualRowsWithReport } from '../src/import/rows.ts';
import { importRoutes } from '../src/routes/import.ts';
import type { NormalizedSubmission } from '../../shared/src/index.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

function sub(key: string, externalId: string, verdict = 'AC'): NormalizedSubmission {
  return {
    problem: {
      platform: 'codeforces',
      problemKey: key,
      title: `T ${key}`,
      difficulty: 1500,
      tags: ['dp'],
    },
    verdict: verdict as NormalizedSubmission['verdict'],
    submittedAt: '2026-09-01T00:00:00.000Z',
    externalId,
  };
}

test('previewImport：新增 / external_id 重复 / 同题同结果协调 / 墓碑跳过 / 题目新建与更新', () => {
  insertNormalized(db, 1, [sub('1A', 'e1'), sub('1B', 'e2')]);
  // 制造墓碑：删除 1D 的题目行（模拟用户在回收站删除过这道题）
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title) VALUES ('codeforces', '1D', 'D')`,
  ).run();
  db.prepare(
    `INSERT INTO deleted_problems (platform, problem_key, normalized_key, title)
     SELECT platform, problem_key, LOWER(REPLACE(problem_key, ' ', '')), title
       FROM problems WHERE platform = 'codeforces' AND problem_key = '1D'`,
  ).run();
  db.prepare(`DELETE FROM problems WHERE platform = 'codeforces' AND problem_key = '1D'`).run();
  const preview = previewImport(db, 1, [
    sub('1A', 'e1'), // external_id 已存在 → duplicateSkips
    sub('1A', 'manual:codeforces:1A:WA', 'WA'), // 新提交（不同结果）
    sub('1A', 'manual:codeforces:1A:AC'), // 同题同结果已存在 → manualSkips
    sub('1C', 'e3'), // 新提交 + 题目新建
    sub('1D', 'e4'), // 命中墓碑的非 manual 行 → 实际导入会静默丢弃（题与提交都不入库）
  ]);
  assert.deepEqual(
    { ...preview },
    {
      newSubmissions: 2,
      duplicateSkips: 1,
      manualSkips: 1,
      tombstoneSkips: 1,
      problemCreates: 1, // 1C（1D 全行被墓碑挡下，不计新建）
      problemUpdates: 1, // 1A（1B 不在本批导入中）
    },
  );
});

test('逐行解析报告：单行非法不中断整批，带行号与原因', () => {
  const r = parseManualRowsWithReport('codeforces', [
    { problemKey: '1A' },
    { problemKey: '' }, // 缺 problemKey
    { problemKey: '1B', verdict: 'XX' }, // verdict 非法
    { problemKey: '1C' },
  ]);
  assert.equal(r.subs.length, 2);
  assert.deepEqual(r.invalid, [
    { line: 2, error: '第 2 行缺少 problemKey' },
    { line: 3, error: '第 3 行 verdict 非法: "XX"（可用 AC/WA/TLE/RE/MLE/CE/SKIPPED）' },
  ]);

  const csv = ['problemKey,title,verdict,difficulty,tags,url,submittedAt,language,externalId', '1A,T,AC,1500,dp,,,', ',,,,'].join('\n');
  const rc = parseCsvRowsWithReport('codeforces', csv);
  assert.equal(rc.subs.length, 1);
  assert.equal(rc.invalid.length, 1);
  assert.equal(rc.invalid[0].line, 3, '非法行号应为含表头的文件行号');
  assert.match(rc.invalid[0].error, /problemKey/);
});

test('POST /api/import/preview 返回分类结果，且预览不写库', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/import', importRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/import`;
  try {
    const res = await fetch(`${base}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'codeforces',
        rows: [{ problemKey: '1A', verdict: 'AC' }, { problemKey: '', verdict: 'AC' }],
      }),
    });
    const body = (await res.json()) as {
      total: number; valid: number;
      invalid: Array<{ line: number }>;
      preview: { newSubmissions: number; problemCreates: number };
    };
    assert.equal(res.status, 200);
    assert.equal(body.total, 2);
    assert.equal(body.valid, 1);
    assert.equal(body.invalid.length, 1);
    assert.equal(body.preview.newSubmissions, 1);
    assert.equal(body.preview.problemCreates, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM submissions').get()!.c, 0, '预览不得写入数据库');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM problems').get()!.c, 0, '预览不得写入题目表');

    // csv 形式 + 表头缺失 → 400
    const bad = await fetch(`${base}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'codeforces', csv: 'a,b\n1,2' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    srv.close();
  }
});

test('previewImport：去重按 account 分桶 —— 别的账号已有同一提交号，并不代表本次导入会跳过', () => {
  // 平台同步来的数据归属账号 alice；手动导入是无账号来源（account=''）。
  // submissions 的唯一键是 (user_id, platform, account, external_id)，两者并不冲突。
  insertNormalized(db, 1, [sub('1E', 'e9')], { account: 'alice' });
  const rows = [sub('1E', 'e9')];
  const preview = previewImport(db, 1, rows);
  const actual = insertNormalized(db, 1, rows);
  assert.equal(preview.duplicateSkips, 0, '别的账号的提交号不构成本次导入的去重命中');
  assert.equal(preview.newSubmissions, 1);
  assert.equal(actual.imported, preview.newSubmissions, '预览的新增数必须与真实导入数一致');
});

test('previewImport：manual 行同时命中两条跳过规则时，归因与 insertNormalized 的分支顺序一致', () => {
  insertNormalized(db, 1, [sub('1F', 'manual:codeforces:1F:AC')]);
  // 重复导入同一条 manual 记录：external_id 已存在，且「同平台同题同结果」也已存在
  const rows = [sub('1F', 'manual:codeforces:1F:AC')];
  const preview = previewImport(db, 1, rows);
  const actual = insertNormalized(db, 1, rows);
  assert.equal(preview.newSubmissions, 0);
  assert.equal(actual.imported, 0);
  // insertNormalized 先判 manualDup、再走 INSERT OR IGNORE → 归因是「同题同结果跳过」
  assert.equal(preview.manualSkips, 1);
  assert.equal(preview.duplicateSkips, 0);
});
