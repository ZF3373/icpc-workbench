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
  assert.equal(sub.externalId, 'manual:luogu:P1001:AC'); // 稳定组合，便于去重
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

test('parseManualRow: JSON 里 language 传数字（平台 langId）不抛错，交由写入层归一', () => {
  // 手动导入支持粘贴 JSON 数组，用户完全可能把洛谷的数字 langId 原样贴进来；
  // row.language?.trim() 对 number 会抛 TypeError，整行被报成难懂的「导入失败」
  const row = parseManualRow('luogu', { problemKey: 'P1001', verdict: 'AC', language: 34 } as never, 0);
  assert.equal(String(row.language), '34');
});

test('insertNormalized: 纯数字 language 收成整数字符串，真实语言名不受影响', () => {
  // 洛谷接口下发数字 langId、CSV/Excel 单元格带 ".0" 尾巴：原样绑进 TEXT 列会被
  // SQLite 渲染成 "34.0"，界面把它当语言名展示（issue #19 复查发现的第二条写入路径）
  const mkLang = (key: string, language: string) =>
    parseManualRow('luogu', { problemKey: key, title: `T ${key}`, verdict: 'AC', language, externalId: `x-${key}` }, 0);
  insertNormalized(db, 1, [
    mkLang('P9001', '34.0'),
    mkLang('P9002', '2'),
    mkLang('P9003', 'C++23 (GCC 15.2.0)'),
    mkLang('P9004', '  '),
  ]);
  const values = db
    .prepare("SELECT language FROM submissions WHERE platform = 'luogu' ORDER BY id")
    .all() as Array<{ language: string | null }>;
  assert.deepEqual(
    values.map((r) => r.language),
    ['34', '2', 'C++23 (GCC 15.2.0)', null], // 空白语言归 null，带点号的真实语言名原样保留
  );
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

test('manual rows without externalId dedupe on re-import', () => {
  const mk = () => parseManualRow('luogu', { problemKey: 'P1', verdict: 'AC' }, 0);
  assert.deepEqual(insertNormalized(db, 1, [mk()]), { imported: 1, skipped: 0 });
  // 同平台同题同结果再次导入 → 稳定 externalId 触发去重（防止统计膨胀）
  assert.deepEqual(insertNormalized(db, 1, [mk()]), { imported: 0, skipped: 1 });
  // 不同结果保留多条
  const wa = parseManualRow('luogu', { problemKey: 'P1', verdict: 'WA' }, 0);
  assert.deepEqual(insertNormalized(db, 1, [wa]), { imported: 1, skipped: 0 });
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

test('manual import coordinates with synced data (same problem+verdict skipped)', () => {
  // 先模拟平台同步数据（externalId 为平台提交号）
  const synced = (key: string, verdict: string, externalId: string) =>
    parseManualRow('codeforces', { problemKey: key, verdict, externalId }, 0);
  assert.deepEqual(insertNormalized(db, 1, [synced('1919A', 'AC', '370117070')]), {
    imported: 1,
    skipped: 0,
  });
  // 手动导入同题同结果（无 externalId）→ 协调去重，不再重复计数
  const manual = () => parseManualRow('codeforces', { problemKey: '1919A', verdict: 'AC' }, 0);
  assert.deepEqual(insertNormalized(db, 1, [manual()]), { imported: 0, skipped: 1 });
  // 同题不同结果（WA）→ 仍保留
  const wa = () => parseManualRow('codeforces', { problemKey: '1919A', verdict: 'WA' }, 0);
  assert.deepEqual(insertNormalized(db, 1, [wa()]), { imported: 1, skipped: 0 });
  // 不同题 → 正常导入
  assert.deepEqual(
    insertNormalized(db, 1, [parseManualRow('codeforces', { problemKey: '1919B', verdict: 'AC' }, 0)]),
    { imported: 1, skipped: 0 },
  );
  const subs = db.prepare('SELECT COUNT(*) AS c FROM submissions').get() as { c: number };
  assert.equal(subs.c, 3); // 370117070-AC / 1919A-WA / 1919B-AC
});

test('insertNormalized: 同提交号平台侧改判 → 刷新既有行 verdict（计为有效写入）', () => {
  // 场景：计蒜客挑战题 WT0 曾按二元域落库为 WA，平台侧终态 AC 到达后，
  // 同 externalId 再次同步必须刷新 verdict，而不是被 INSERT OR IGNORE 永久丢弃。
  const db = createDb(':memory:');
  const mk = (verdict: 'WA' | 'AC') => [
    {
      problem: { platform: 'codeforces' as const, problemKey: '1A', title: 'T', tags: [] as string[] },
      verdict,
      submittedAt: '2026-01-01T00:00:00.000Z',
      externalId: 'rev-1',
    },
  ];
  insertNormalized(db, 1, mk('WA'));
  const r2 = insertNormalized(db, 1, mk('AC'));
  assert.equal(r2.imported, 1, '改判刷新算一次有效写入');
  const v = db.prepare("SELECT verdict FROM submissions WHERE external_id = 'rev-1'").get() as { verdict: string };
  assert.equal(v.verdict, 'AC');
  // verdict 相同的重复行不产生写入
  const r3 = insertNormalized(db, 1, mk('AC'));
  assert.equal(r3.imported, 0);
  assert.equal(r3.skipped, 1);
});

test('parseCsv: 剥离 UTF-8 BOM（Excel「CSV UTF-8」导出必带）', () => {
  // Excel 的「CSV UTF-8」会在文件头写 \uFEFF：不剥离则表头首列变成 \uFEFFproblemKey，
  // 整份文件被拒（「CSV 缺少列: problemKey」）——手动导入最常见的输入格式
  const rows = parseCsv('\uFEFFproblemKey,verdict\n1A,AC\n');
  assert.deepEqual(rows, [['problemKey', 'verdict'], ['1A', 'AC']]);
});

test('insertNormalized: 同步侧只带来题号当标题（拉取失败兜底）不覆盖已有人工/题库标题', () => {
  const db = createDb(':memory:');
  const mk = (title: string, verdict: 'AC' | 'WA') => [
    {
      problem: { platform: 'codeforces' as const, problemKey: '1900C', title, tags: [] as string[] },
      verdict,
      submittedAt: '2026-01-02T00:00:00.000Z',
      externalId: `t-${verdict}-v2`,
    },
  ];
  // 第一轮：题库/详情正常，带来真实标题
  insertNormalized(db, 1, mk('Who Ntired the Editor', 'AC'));
  // 第二轮：详情拉取失败（如洛谷风控），标题退化为题号本身
  insertNormalized(db, 1, mk('1900C', 'WA'));
  const t = db.prepare("SELECT title FROM problems WHERE problem_key = '1900C'").get() as { title: string };
  assert.equal(t.title, 'Who Ntired the Editor', 'title === problemKey 视作未知，不得覆盖好标题');
});
