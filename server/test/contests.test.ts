import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ContestInfo } from '../../shared/src/index.ts';
import {
  classifyContest,
} from '../src/contests/cfContests.ts';
import {
  classifyAtcoderContest,
  parseUpcomingHtml,
  toAtcoderContest,
} from '../src/contests/atcoderContests.ts';
import { classifyLuoguContest, toLuoguContest } from '../src/contests/luoguContests.ts';
import {
  classifyNowcoderContest,
  parseContestListHtml,
  toNowcoderContest,
} from '../src/contests/nowcoderContests.ts';
import { contestPhase, selectContests } from '../src/contests/index.ts';

test('classifyContest recognises common CF series', () => {
  assert.equal(classifyContest('Codeforces Round 918 (Div. 1)'), 'Div. 1');
  assert.equal(classifyContest('Codeforces Round 918 (Div. 2)'), 'Div. 2');
  assert.equal(classifyContest('Codeforces Round (Div. 3)'), 'Div. 3');
  assert.equal(classifyContest('Codeforces Round (Div. 4)'), 'Div. 4');
  assert.equal(classifyContest('Educational Codeforces Round 158'), 'Educational');
  assert.equal(classifyContest('Codeforces Global Round 27'), 'Global');
  assert.equal(classifyContest('2023-2024 ICPC, NERC (Mirrored)'), 'ICPC');
  assert.equal(classifyContest('TheForces Round #24'), '其他');
});

test('classifyAtcoderContest maps id prefixes', () => {
  assert.equal(classifyAtcoderContest('abc380'), 'ABC');
  assert.equal(classifyAtcoderContest('arc180'), 'ARC');
  assert.equal(classifyAtcoderContest('agc070'), 'AGC');
  assert.equal(classifyAtcoderContest('ahc044'), 'AHC');
  assert.equal(classifyAtcoderContest('DEGwer2023'), '其他');
});

test('toAtcoderContest: prefix id, epoch seconds, url', () => {
  const info = toAtcoderContest('abc380', 'ABC380', 1730200800, 6000);
  assert.equal(info.id, 'at-abc380');
  assert.equal(info.platform, 'atcoder');
  assert.equal(info.category, 'ABC');
  assert.equal(info.startTimeIso, new Date(1730200800 * 1000).toISOString());
  assert.equal(info.durationMinutes, 100);
  assert.equal(info.url, 'https://atcoder.jp/contests/abc380');
});

test('toAtcoderContest: epoch 0 (常驻练习) keeps null start', () => {
  const info = toAtcoderContest('APG4b', 'APG4b', 0, 3153600000);
  assert.equal(info.startTimeIso, null);
});

test('parseUpcomingHtml extracts rows from official contests page', () => {
  const html = `<div id="contest-table-upcoming"><table><tbody>
    <tr>
      <td class="text-center"><time class='fixtime fixtime-full'>2026-08-30 21:00:00+0900</time></td>
      <td><a href="/contests/arc228">AtCoder Regular Contest 228</a></td>
      <td class="text-center">02:30</td>
      <td class="text-center">1600 - 2999</td>
    </tr>
    <tr>
      <td class="text-center"><time class='fixtime fixtime-full'>2026-09-06 13:10:00+0900</time></td>
      <td><a href="/contests/abc474">AtCoder Beginner Contest 474</a></td>
      <td class="text-center">01:40</td>
      <td class="text-center"> - 1999</td>
    </tr>
  </tbody></table></div>`;
  const rows = parseUpcomingHtml(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'at-arc228');
  assert.equal(rows[0].category, 'ARC');
  assert.equal(rows[0].durationMinutes, 150);
  assert.equal(new Date(rows[0].startTimeIso!).getUTCHours(), 12); // 21:00+0900 → 12:00 UTC
  assert.equal(rows[1].id, 'at-abc474');
  assert.equal(rows[1].durationMinutes, 100);
});

test('classifyLuoguContest branches', () => {
  assert.equal(classifyLuoguContest('【LGR】洛谷 9 月月赛 & LittleStars'), '月赛');
  assert.equal(classifyLuoguContest('洛谷入门赛'), '入门赛');
  assert.equal(classifyLuoguContest('[ICPC2018 Jiaozuo R] 区域赛重现赛'), '重现赛');
  assert.equal(classifyLuoguContest('某团队对抗赛', 1), 'Rated');
  assert.equal(classifyLuoguContest('某团队对抗赛'), '比赛');
});

test('toLuoguContest: lg- prefix, duration from start/end', () => {
  const info = toLuoguContest({
    id: 353129,
    startTime: 1789621200,
    endTime: 1789639200,
    name: '[ICPC2018 Jiaozuo R] ICPC 2018 区域赛焦作站重现赛',
    rated: 1,
  });
  assert.equal(info.id, 'lg-353129');
  assert.equal(info.platform, 'luogu');
  assert.equal(info.category, '重现赛');
  assert.equal(info.durationMinutes, 300); // (1789639200 - 1789621200) / 60
  assert.equal(info.url, 'https://www.luogu.com.cn/contest/353129');
});

test('classifyNowcoderContest branches（小白月赛优先于月赛）', () => {
  assert.equal(classifyNowcoderContest('牛客周赛 Round 160'), '周赛');
  assert.equal(classifyNowcoderContest('牛客小白月赛137'), '小白月赛');
  assert.equal(classifyNowcoderContest('牛客月赛 9 月场'), '月赛');
  assert.equal(classifyNowcoderContest('牛客挑战赛91'), '挑战赛');
  assert.equal(classifyNowcoderContest('牛客练习赛156'), '练习赛');
  assert.equal(classifyNowcoderContest('第49届 ICPC 区域赛（牛客）'), 'ICPC');
  assert.equal(classifyNowcoderContest('XX大学第10届校赛'), '校赛');
  assert.equal(classifyNowcoderContest('牛客2026年七夕节比赛'), '比赛');
});

test('parseContestListHtml: 双重转义 data-json 解码后解析，坏条目跳过', () => {
  const html = `<div class="platform-item js-item" data-id="139989" data-json="{&amp;quot;isSignUp&amp;quot;:false,&amp;quot;contestId&amp;quot;:139989,&amp;quot;contestName&amp;quot;:&amp;quot;牛客周赛 Round 160&amp;quot;,&amp;quot;contestStartTime&amp;quot;:1788692400000,&amp;quot;contestEndTime&amp;quot;:1788699600000}">
    <a href="/acm/contest/139989">牛客周赛 Round 160</a></div>
    <div data-json="{&amp;quot;contestId&amp;quot;:139935,&amp;quot;contestName&amp;quot;:&amp;quot;L &amp;amp; R 挑战赛91&amp;quot;,&amp;quot;contestStartTime&amp;quot;:1788596400000,&amp;quot;contestEndTime&amp;quot;:1788607200000}"></div>
    <div data-json="{&amp;quot;contestId&amp;quot;:oops"></div>`;
  const items = parseContestListHtml(html);
  assert.equal(items.length, 2);
  assert.equal(items[0].contestId, 139989);
  assert.equal(items[0].contestName, '牛客周赛 Round 160');
  assert.equal(items[1].contestName, 'L & R 挑战赛91');
});

test('toNowcoderContest: nc- 前缀、毫秒时间戳、时长与链接', () => {
  const info = toNowcoderContest({
    contestId: 139989,
    contestName: '牛客周赛 Round 160',
    contestStartTime: 1788692400000,
    contestEndTime: 1788699600000,
  });
  assert.equal(info.id, 'nc-139989');
  assert.equal(info.platform, 'nowcoder');
  assert.equal(info.category, '周赛');
  assert.equal(info.startTimeIso, new Date(1788692400000).toISOString());
  assert.equal(info.durationMinutes, 120);
  assert.equal(info.url, 'https://ac.nowcoder.com/acm/contest/139989');
});

test('toNowcoderContest: 开始时间缺失（0）保留 null start', () => {
  const info = toNowcoderContest({
    contestId: 1,
    contestName: '时间待定赛',
    contestStartTime: 0,
    contestEndTime: 0,
  });
  assert.equal(info.startTimeIso, null);
});

function contest(id: string, platform: ContestInfo['platform'], startIso: string | null, minutes = 120): ContestInfo {
  return {
    id,
    platform,
    name: `Contest ${id}`,
    category: '其他',
    startTimeIso: startIso,
    durationMinutes: minutes,
    phase: 'UNKNOWN',
    url: `https://example.com/${id}`,
  };
}

test('contestPhase derives from start + duration', () => {
  const now = Date.now();
  assert.equal(contestPhase(contest('a', 'codeforces', new Date(now + 3600e3).toISOString())), 'upcoming');
  assert.equal(contestPhase(contest('b', 'codeforces', new Date(now - 600e3).toISOString(), 120)), 'running');
  assert.equal(contestPhase(contest('c', 'codeforces', new Date(now - 7200e3).toISOString(), 120)), 'finished');
  assert.equal(contestPhase(contest('d', 'codeforces', null)), null);
});

test('selectContests: filter by phase/platform, sort upcoming asc & finished by end desc', () => {
  const now = Date.now();
  const all = [
    contest('up-late', 'codeforces', new Date(now + 7200e3).toISOString()),
    contest('up-soon', 'atcoder', new Date(now + 3600e3).toISOString()),
    contest('up-luogu', 'luogu', new Date(now + 10800e3).toISOString()),
    contest('old', 'codeforces', new Date(now - 10 * 3600e3).toISOString()),
    contest('recent', 'atcoder', new Date(now - 2 * 3600e3).toISOString()),
  ];
  const up = selectContests(all, { type: 'upcoming' });
  assert.deepEqual(up.map((c) => c.id), ['up-soon', 'up-late', 'up-luogu']);
  const upAt = selectContests(all, { type: 'upcoming', platform: 'atcoder' });
  assert.deepEqual(upAt.map((c) => c.id), ['up-soon']);
  const fin = selectContests(all, { type: 'finished' });
  assert.deepEqual(fin.map((c) => c.id), ['recent', 'old']);
});
