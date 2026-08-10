import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ManualSubmissionRow } from '../../shared/src/index.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { parseCsv } from '../src/import/csv.ts';
import { parseCsvRows, parseManualRow } from '../src/import/rows.ts';
import { insertNormalized } from '../src/import/importService.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  db.close();
});

test('parseManualRow: basic conversion with defaults', () => {
  const sub = parseManualRow(
    'luogu',
    { problemKey: 'P1001', verdict: 'AC', tags: ['入门', '模拟'] },
    0,
  );
  assert.equal(sub.problem.platform, 'luogu');
  assert.equal(sub.problem.problemKey, 'P1001');
  assert.equal(sub.problem.title, 'P1001'); // 无 title 用 key
  assert.equal(sub.verdict, 'AC');
  assert.deepEqual(sub.problem.tags, ['入门', '模拟']);
  assert.ok(sub.externalId.startsWith('manual:luogu:P1001:AC:'));
  assert.ok(!Number.isNaN(Date.parse(sub.submittedAt)));
});

test('parseManualRow: rejects missing key and bad verdict', () => {
  assert.throws(() => parseManualRow('luogu', {} as ManualSubmissionRow, 0), /problemKey/);
  assert.throws(
    () => parseManualRow('luogu', { problemKey: 'P1', verdict: 'Accepted' }, 0),
    /verdict/,
  );
});

test('parseManualRow: tags string split by |', () => {
  const sub = parseManualRow('luogu', { problemKey: 'P2', tags: '图论|最短路' }, 0);
  assert.deepEqual(sub.problem.tags, ['图论', '最短路']);
});

test('parseCsv: quotes, commas, escaped quotes, CRLF', () => {
  const rows = parseCsv('a,b\r\n"x,y","say ""hi"""\r\nz,w\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,y', 'say "hi"'],
    ['z', 'w'],
  ]);
});

test('parseCsvRows: header + data rows', () => {
  const csv = [
    'problemKey,title,verdict,difficulty,tags,url,submittedAt,language,externalId',
    'P1001,A+B Problem,AC,1,入门|模拟,https://www.luogu.com.cn/problem/P1001,2024-01-01T00:00:00Z,C++11,m1',
    'P1002,Number Game,WA,3,,,2024-01-02T00:00:00Z,Python,m2',
  ].join('\n');
  const subs = parseCsvRows('luogu', csv);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].problem.title, 'A+B Problem');
  assert.equal(subs[0].problem.difficulty, 1);
  assert.deepEqual(subs[0].problem.tags, ['入门', '模拟']);
  assert.equal(subs[0].externalId, 'm1');
  assert.equal(subs[1].verdict, 'WA');
  assert.equal('difficulty' in subs[1].problem, true); // 空列跳过，difficulty=NaN 不写入
  assert.equal(subs[1].problem.tags.length, 0);
});

test('parseCsvRows: missing column throws', () => {
  assert.throws(() => parseCsvRows('luogu', 'problemKey,title\nP1,T\n'), /缺少列/);
});

test('insertNormalized: inserts problems+submissions, dedupes on rerun', () => {
  const mk = (key: string, externalId: string) =>
    parseManualRow(
      'codeforces',
      { problemKey: key, title: `T ${key}`, verdict: 'AC', tags: ['dp'], externalId },
      0,
    );
  const first = insertNormalized(db, 1, [mk('1919A', 'e1'), mk('1919B', 'e2')]);
  assert.deepEqual(first, { imported: 2, skipped: 0 });
  // 相同 externalId 再次导入 → skipped
  const second = insertNormalized(db, 1, [mk('1919A', 'e1'), mk('1919C', 'e3')]);
  assert.deepEqual(second, { imported: 1, skipped: 1 });
  const subs = db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number };
  assert.equal(subs.c, 3);
  const problems = db.prepare('SELECT COUNT(*) AS c FROM problems').get() as { c: number };
  assert.equal(problems.c, 3);
});

test('insertNormalized: upsert updates problem title/tags', () => {
  insertNormalized(db, 1, [
    parseManualRow('atcoder', { problemKey: 'abc001_a', title: 'Old', verdict: 'AC', tags: ['a'] }, 0),
  ]);
  insertNormalized(db, 1, [
    parseManualRow('atcoder', { problemKey: 'abc001_a', title: 'New Title', verdict: 'WA', tags: ['a', 'b'] }, 0),
  ]);
  const p = db
    .prepare("SELECT title, tags FROM problems WHERE platform='atcoder' AND problem_key='abc001_a'")
    .get() as { title: string; tags: string };
  assert.equal(p.title, 'New Title');
  assert.deepEqual(JSON.parse(p.tags), ['a', 'b']);
});
