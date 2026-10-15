import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { calendarIndex, deriveParticipatedContests, renderContestContext, resolveContestGroup } from '../src/contests/participated.ts';
import { fetchCodeforcesParticipation, fetchAtcoderParticipation, loadParticipationSources, readParticipationSnapshot, type AuthoritativeContest } from '../src/contests/participationSources.ts';
import type { ContestInfo } from '../../shared/src/index.ts';

const start = Date.parse('2026-09-20T12:00:00Z');
const end = start + 100 * 60_000;

test('日历索引兼容平台冒号与短横线前缀，避免有官方赛程却回退提交时间', () => {
  const row: ContestInfo = { id: 'codeforces:2001', platform: 'codeforces', name: 'Round', url: '', category: '', startTimeIso: new Date(start).toISOString(), durationMinutes: 100, phase: 'FINISHED' };
  assert.equal(calendarIndex([row]).get('codeforces:2001'), row);
});
function source(platform: AuthoritativeContest['platform'], over: Partial<AuthoritativeContest> = {}): AuthoritativeContest {
  return { platform, account: 'main', contestId: '2001', name: '比赛', url: '', startTimeMs: start, endTimeMs: end,
    rank: 100, rating: null, ratingChange: null, problemCount: 3, acceptedCount: null, ...over };
}
function submit(db: Db, platform: string, key: string, account = 'main', context: string | null = null, at = start + 600_000, verdict = 'AC'): void {
  db.prepare('INSERT OR IGNORE INTO problems(platform, problem_key, title, url) VALUES(?,?,?,?)').run(platform, key, key, platform === 'atcoder' ? `https://atcoder.jp/contests/abc200/tasks/${key}` : '');
  const p = db.prepare('SELECT id FROM problems WHERE platform=? AND problem_key=?').get(platform, key) as { id: number };
  db.prepare('INSERT INTO submissions(user_id,platform,account,problem_id,external_id,submitted_at,verdict,context) VALUES(1,?,?,?,?,?,?,?)')
    .run(platform, account, p.id, `${account}-${key}-${at}-${verdict}`, new Date(at).toISOString(), verdict, context);
}

test('牛客题目集未知或确认为空时不把赛时日常练习归入比赛', () => {
  const db = createDb(':memory:');
  try {
    submit(db, 'nowcoder', '999');
    for (const problems of [null, []]) {
      const [c] = deriveParticipatedContests(db, { sources: { nowcoder: [source('nowcoder', { problems, acceptedCount: 1 })] } });
      assert.equal(c.submissionCount, 0);
      assert.equal(c.acProblemCount, 1, '仍保留平台参赛成绩');
      assert.equal(resolveContestGroup(db, c.key, { sources: { nowcoder: [source('nowcoder', { problems })] } })?.submissions.length, 0);
    }
  } finally { db.close(); }
});

test('题目集已知时即使缺比赛时间也能匹配牛客补题，不能归入开赛前练习', () => {
  const db = createDb(':memory:');
  try {
    submit(db, 'nowcoder', '101', 'main', null, end + 86400_000);
    submit(db, 'nowcoder', '102', 'main', null, start - 86400_000);
    const src = source('nowcoder', { problems: [{ id: '101' }, { id: '102' }] });
    const [known] = deriveParticipatedContests(db, { sources: { nowcoder: [src] } });
    assert.equal(known.submissionCount, 1, '同题重用时，赛前提交不冒充本场提交');
    const [unknown] = deriveParticipatedContests(db, { sources: { nowcoder: [{ ...src, startTimeMs: null, endTimeMs: null }] } });
    assert.equal(unknown.submissionCount, 2, '缺时间仍保留有题号依据的明细，但无法划分赛中');
    assert.equal(unknown.inContestAcProblemCount, null);
  } finally { db.close(); }
});

test('CF 正式赛成绩不叠加之后的虚拟赛 AC', () => {
  const db = createDb(':memory:');
  try {
    submit(db, 'codeforces', '2001A', 'main', 'contest');
    submit(db, 'codeforces', '2001B', 'main', 'virtual', end + 86400_000);
    const [c] = deriveParticipatedContests(db);
    assert.equal(c.inContestAcProblemCount, 1);
    assert.equal(c.acProblemCount, 2);
  } finally { db.close(); }
});

test('多账号成绩优先取正式参赛账号，赛中 AC 不混入小号，当前 AC 明确为合并', () => {
  const db = createDb(':memory:');
  try {
    submit(db, 'codeforces', '2001A', 'main', 'contest');
    submit(db, 'codeforces', '2001B', 'alt', 'practice', end + 86400_000);
    submit(db, 'codeforces', '2001C', 'alt', 'practice', end + 86400_000);
    const [c] = deriveParticipatedContests(db, { sources: { codeforces: [source('codeforces'), source('codeforces', { account: 'alt', rank: 9000 })] } });
    assert.equal(c.source?.rank, 100, '补题多的小号不覆盖正式参赛成绩');
    assert.equal(c.source?.account, 'main');
    assert.equal(c.inContestAcProblemCount, 1);
    assert.equal(c.acProblemCount, 3, '当前 AC 继续反映所有账号的已知进度');
  } finally { db.close(); }
});

test('当前合并 AC 不得低于任一账号的平台已知 AC，缺本地明细不冒充赛中零 AC', () => {
  const db = createDb(':memory:');
  try {
    const [merged] = deriveParticipatedContests(db, { sources: { nowcoder: [source('nowcoder', { acceptedCount: 1 }), source('nowcoder', { account: 'alt', acceptedCount: 3 })] } });
    assert.equal(merged.acProblemCount, 3);
    assert.equal(merged.acCountIsLowerBound, true);
    assert.equal(merged.inContestAcProblemCount, 1, '排名和赛中成绩仍来自 main');
    const [unknown] = deriveParticipatedContests(db, { sources: { codeforces: [source('codeforces')] } });
    assert.equal(unknown.inContestAcProblemCount, null);
    submit(db, 'codeforces', '2001A', 'main', 'virtual', end + 86400_000);
    const [virtualOnly] = deriveParticipatedContests(db, { sources: { codeforces: [source('codeforces')] } });
    assert.equal(virtualOnly.inContestAcProblemCount, null, '只有虚拟赛明细不能证明正式赛是零 AC');
  } finally { db.close(); }
});

test('旧记录的推算窗口失效后，无提交场次仍可从官方日历恢复赛程', () => {
  const db = createDb(':memory:');
  try {
    const calendar: ContestInfo[] = [{ id: 'cf-2001', platform: 'codeforces', name: 'Round', url: '', category: '', startTimeIso: new Date(start).toISOString(), durationMinutes: 100, phase: 'FINISHED' }];
    const [c] = deriveParticipatedContests(db, { calendar, sources: { codeforces: [source('codeforces', { startTimeMs: null, endTimeMs: null })] } });
    assert.equal(c.startTimeIso, new Date(start).toISOString());
    assert.equal(c.endTimeIso, new Date(end).toISOString());
  } finally { db.close(); }
});

test('缺逐条赛时 AC 身份时当前 AC 是下限，AI 复盘不宣称知道精确补题数', () => {
  const db = createDb(':memory:');
  try {
    submit(db, 'nowcoder', '101', 'main', null, end + 86400_000);
    const src = source('nowcoder', { problemCount: 6, acceptedCount: 4, problems: [{ id: '101' }, { id: '102' }, { id: '103' }, { id: '104' }, { id: '105' }, { id: '106' }] });
    const review = resolveContestGroup(db, 'nowcoder:2001', { sources: { nowcoder: [src] } })!;
    assert.equal(review.contest.acProblemCount, 4);
    assert.equal(review.contest.acCountIsLowerBound, true);
    assert.match(renderContestContext(review), /至少.*4/);
    assert.doesNotMatch(renderContestContext(review), /赛后补题 0|赛时已全部开过题/);
  } finally { db.close(); }
});

test('本地补题数等于平台赛中 AC 时，也不能假定它们恰好是同一批题', () => {
  const db = createDb(':memory:');
  try {
    submit(db, 'nowcoder', '101', 'main', null, end + 86400_000);
    const src = source('nowcoder', { acceptedCount: 1, problems: [{ id: '101' }] });
    const [c] = deriveParticipatedContests(db, { sources: { nowcoder: [src] } });
    assert.equal(c.acCountIsLowerBound, true);
  } finally { db.close(); }
});

test('只缓存了部分题目时，复盘不会把部分题单称为全场题目', () => {
  const db = createDb(':memory:');
  try {
    submit(db, 'nowcoder', '101');
    const src = source('nowcoder', { problemCount: 6, problems: [{ id: '101' }, { id: '102' }] });
    const review = resolveContestGroup(db, 'nowcoder:2001', { sources: { nowcoder: [src] } })!;
    assert.equal(review.problemSetKnown, false);
    assert.doesNotMatch(renderContestContext(review), /全场 2 题/);
  } finally { db.close(); }
});

test('官方时间窗严格按开赛到结束前匹配，不以赛前或结束瞬间提交认定参赛', () => {
  const db = createDb(':memory:');
  try {
    const calendar: ContestInfo[] = [{ id: 'at-abc200', platform: 'atcoder', name: 'ABC', url: '', category: 'ABC', startTimeIso: new Date(start).toISOString(), durationMinutes: 100, phase: 'FINISHED' }];
    submit(db, 'atcoder', 'abc200_a', 'main', null, start - 60_000);
    submit(db, 'atcoder', 'abc200_b', 'main', null, end);
    assert.equal(deriveParticipatedContests(db, { calendar }).length, 0);
    submit(db, 'atcoder', 'abc200_c', 'main', null, start);
    const [c] = deriveParticipatedContests(db, { calendar });
    assert.equal(c.inContestAcProblemCount, 1);
  } finally { db.close(); }
});

test('无日历时 CF Rating 更新时间不当作赛程，AtCoder 结束时间不倒推固定两小时', async () => {
  const cfFetch = (async () => Response.json({ status: 'OK', result: [{ contestId: 2001, ratingUpdateTimeSeconds: end / 1000 + 86400, newRating: 1500, oldRating: 1400 }] })) as typeof fetch;
  const [cf] = await fetchCodeforcesParticipation('main', calendarIndex([]), cfFetch);
  assert.equal(cf.startTimeMs, null);
  assert.equal(cf.endTimeMs, null);
  const atFetch = (async () => Response.json([{ ContestScreenName: 'abc200', EndTime: new Date(end).toISOString(), IsRated: true }])) as typeof fetch;
  const [at] = await fetchAtcoderParticipation('main', calendarIndex([]), atFetch);
  assert.equal(at.startTimeMs, null);
  assert.equal(at.endTimeMs, end);
});

test('升级后旧缓存的推算时间不再作为官方窗口，新同步的官方时间可持久恢复', async () => {
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO platform_accounts(user_id,platform,handle,enabled) VALUES(1,'codeforces','main',1)").run();
    db.prepare("INSERT INTO participated_contests(user_id,platform,account,contest_id,start_ms,end_ms,fetched_at) VALUES(1,'codeforces','main','2001',?,?,?)").run(start, end, new Date().toISOString());
    const [old] = readParticipationSnapshot(db).byPlatform.codeforces!;
    assert.equal(old.startTimeMs, null);
    assert.equal(old.endTimeMs, null);
    const calendar: ContestInfo[] = [{ id: 'cf-2001', platform: 'codeforces', name: 'Round', url: '', category: 'Div. 2', startTimeIso: new Date(start).toISOString(), durationMinutes: 100, phase: 'FINISHED' }];
    const fetchFn = (async () => Response.json({ status: 'OK', result: [{ contestId: 2001, ratingUpdateTimeSeconds: end / 1000 + 86400 }] })) as typeof fetch;
    await loadParticipationSources(db, calendar, { force: true, fetchFn });
    const [fresh] = readParticipationSnapshot(db).byPlatform.codeforces!;
    assert.equal(fresh.startTimeMs, start);
    assert.equal(fresh.endTimeMs, end);
    await loadParticipationSources(db, [], { force: true, fetchFn });
    const [withoutCalendar] = readParticipationSnapshot(db).byPlatform.codeforces!;
    assert.equal(withoutCalendar.startTimeMs, start, '日历暂缺不能擦除已验证的官方窗口');
    assert.equal(withoutCalendar.endTimeMs, end);
  } finally { db.close(); }
});
