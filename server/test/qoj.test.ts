import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createQojAdapter,
  parseQojRows,
  parseQojProblemHref,
  parseQojTime,
  parseServerOffsetMinutes,
  mapQojVerdict,
  normalizeResultText,
  isCloudflareChallenge,
  looksLikeLoginPage,
} from '../src/adapters/qoj.ts';
import { ManualImportRequiredError, type FetchOptions } from '../src/adapters/types.ts';
import { getAdapter, initAdapters } from '../src/adapters/index.ts';

/**
 * QOJ（qoj.ac，UOJ 系）适配器测试。
 *
 * 数据源：GET /submissions?submitter={用户名}&page={n} 的服务端渲染 HTML。
 * 列序按 **2026-09 对真实页面实测确认** 的顺序：
 *   #提交号 | 题目 | 提交者 | 结果 | 运行时间 | 内存 | 语言 | 代码长度 | 提交时间
 * （提交者在结果之前——早期测试夹具按第三方文档写成「结果在前」，掩盖了
 *  把提交者名当结果文本的错位 bug，因此夹具必须与真实页面列序一致）
 */

const COOKIE = 'UOJSESSID=sess-token; cf_clearance=cf-token';

/** 页面底部 Server Time（用于换算 UTC 偏移） */
function serverTimeLine(epochMs: number, offsetHours: number): string {
  const d = new Date(epochMs + offsetHours * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  const text = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return `<p class="text-center text-muted">Server Time: ${text}</p>`;
}

function localTimeText(epochMs: number, offsetHours: number): string {
  const d = new Date(epochMs + offsetHours * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

interface RowSpec {
  id: number;
  /** 题目 href，缺省 /problem/{pid} */
  href?: string;
  /** 题目列文本（含题号前缀） */
  problemText?: string;
  result: string;
  /** 结果列的原始 HTML；缺省用纯文本包裹 */
  resultHtml?: string;
  language?: string;
  /** 提交者链接（/user/profile/{who}） */
  who?: string;
  /** 提交时间（epoch 毫秒） */
  ts: number;
}

const DEFAULT_TS = Date.UTC(2026, 0, 2, 3, 4, 5);
const OFFSET_HOURS = 8;

/** 构造一页 QOJ 提交列表 HTML（服务端渲染结构） */
function page(rows: RowSpec[], opts: { serverTimeMs?: number; withTable?: boolean } = {}): string {
  const body = rows
    .map((r) => {
      const href = r.href ?? `/problem/${1000 + r.id}`;
      const problemText = r.problemText ?? `A. Problem ${r.id}`;
      const resultCell = r.resultHtml ?? r.result;
      return `<tr>
        <td><a href="/submission/${r.id}">#${r.id}</a></td>
        <td><a href="${href}">${problemText}</a></td>
        <td><a href="/user/profile/${r.who ?? 'someone'}">${r.who ?? 'someone'}</a></td>
        <td>${resultCell}</td>
        <td>12ms</td>
        <td>256M</td>
        <td>${r.language ?? 'C++17'}</td>
        <td>1024B</td>
        <td><small>${localTimeText(r.ts, OFFSET_HOURS)}</small></td>
      </tr>`;
    })
    .join('\n');
  const table = opts.withTable === false
    ? '<p>No submissions found.</p>'
    : `<table class="table"><thead><tr>
        <th>#</th><th>Problem</th><th>Submitter</th><th>Result</th><th>Time</th><th>Memory</th><th>Language</th><th>Length</th><th>Submit Time</th>
      </tr></thead><tbody>${body}</tbody></table>`;
  return `<!DOCTYPE html><html><body><div class="container">${table}</div>${serverTimeLine(opts.serverTimeMs ?? Date.now(), OFFSET_HOURS)}</body></html>`;
}

/** 请求路由器：按 page 参数返回对应页 HTML */
function router(
  pages: Record<number, string>,
  opts: { status?: number; headers?: Record<string, string>; body?: string; seenUrls?: string[]; seenHeaders?: Array<Record<string, string>> } = {},
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    opts.seenUrls?.push(u);
    if (opts.seenHeaders) opts.seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
    if (opts.status !== undefined) {
      return new Response(opts.body ?? '', { status: opts.status, headers: opts.headers ?? {} });
    }
    const m = /[?&]page=(\d+)/.exec(u);
    const pageNo = m ? Number(m[1]) : 1;
    const html = pages[pageNo] ?? page([], { withTable: false });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
}

/** 构造 n 行（跨页自增 id，时间递减） */
function rowsFrom(startId: number, count: number, baseTs: number): RowSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: startId - i,
    result: 'AC ✓',
    ts: baseTs - i * 60_000,
  }));
}

// ---------- 纯函数：结果映射 ----------

test('qoj: normalizeResultText strips decoration and whitespace', () => {
  assert.equal(normalizeResultText('AC ✓'), 'AC');
  assert.equal(normalizeResultText('<span>WA</span>'), 'WA');
  assert.equal(normalizeResultText(' 100  ✓ '), '100');
  assert.equal(normalizeResultText(''), '');
});

test('qoj: mapQojVerdict maps UOJ status words (含 AC ✓ / 短写 TL ML OLE)', () => {
  assert.equal(mapQojVerdict('AC ✓'), 'AC');
  assert.equal(mapQojVerdict('AC'), 'AC');
  assert.equal(mapQojVerdict('WA'), 'WA');
  assert.equal(mapQojVerdict('RE'), 'RE');
  assert.equal(mapQojVerdict('TL'), 'TLE');
  assert.equal(mapQojVerdict('ML'), 'MLE');
  assert.equal(mapQojVerdict('CE'), 'CE');
  assert.equal(mapQojVerdict('OLE'), 'RE'); // 输出超限 → RE（与代码源/计蒜客同口径）
  assert.equal(mapQojVerdict('UKE'), null); // 未知错误：不落库
  assert.equal(mapQojVerdict('JG'), null); // 评测中：不落库
  assert.equal(mapQojVerdict(''), null);
});

test('qoj: mapQojVerdict 处理子任务得分与组合状态', () => {
  // 子任务部分分：列表页显示实际得分，非满分无法区分原因 → 保守归 WA
  assert.equal(mapQojVerdict('67'), 'WA');
  assert.equal(mapQojVerdict('0'), 'WA');
  assert.equal(mapQojVerdict('42'), 'WA');
  // 满分：带 ✓ 视为通过
  assert.equal(mapQojVerdict('100 ✓'), 'AC');
  assert.equal(mapQojVerdict('110 ✓'), 'AC');
  // 通过后被 Hack：组合文本 → 未通过
  assert.equal(mapQojVerdict('AC, WA'), 'WA');
  assert.equal(mapQojVerdict('AC'), 'AC');
});

// ---------- 纯函数：时间与题目链接 ----------

test('qoj: parseQojTime 按服务器偏移换算 UTC（默认站点为 UTC+8）', () => {
  // 服务器本地 2026-01-02 11:04:05（UTC+8）→ UTC 2026-01-02T03:04:05Z
  assert.equal(
    parseQojTime('2026-01-02 11:04:05', 8 * 60),
    '2026-01-02T03:04:05.000Z',
  );
  assert.equal(parseQojTime('2026-01-02T11:04:05', 0), '2026-01-02T11:04:05.000Z');
  assert.equal(parseQojTime('不是时间', 0), null);
});

test('qoj: parseServerOffsetMinutes 读页面 Server Time，异常回退 UTC+8', () => {
  const now = Date.now();
  const offset = parseServerOffsetMinutes(page([], { serverTimeMs: now }));
  // 页面 Server Time 为服务器本地时间（UTC+8）→ 偏移约 +480 分钟
  assert.ok(Math.abs(offset - 8 * 60) <= 1, `偏移应约为 480 分钟，实际 ${offset}`);

  // 页面无 Server Time → 回退 UTC+8
  assert.equal(parseServerOffsetMinutes('<html><body>no time here</body></html>'), 8 * 60);
  // 明显过期的服务器时间（超出 ±12h~+14h 合理区间）→ 回退
  assert.equal(parseServerOffsetMinutes('<p>Server Time: 2000-01-01 00:00:00</p>'), 8 * 60);
});

test('qoj: parseQojProblemHref 解析题库题与比赛题（含比赛前缀键）', () => {
  assert.deepEqual(parseQojProblemHref('/problem/9242'), {
    problemKey: '9242',
    url: 'https://qoj.ac/problem/9242',
  });
  assert.deepEqual(parseQojProblemHref('/contest/3588/problem/17753'), {
    problemKey: '3588-17753',
    url: 'https://qoj.ac/contest/3588/problem/17753',
  });
  assert.equal(parseQojProblemHref('/submission/123'), null);
});

test('qoj: isCloudflareChallenge / looksLikeLoginPage 判定', () => {
  const cfBody = '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';
  assert.equal(isCloudflareChallenge(cfBody, 403, 'challenge'), true);
  assert.equal(isCloudflareChallenge(cfBody, 403, null), true);
  assert.equal(isCloudflareChallenge('<html><body>正常页面</body></html>', 403, null), false);
  assert.equal(isCloudflareChallenge('<html><body>正常页面</body></html>', 200, null), false);

  assert.equal(looksLikeLoginPage('<form><input name="password"><button>Login</button></form>'), true);
  assert.equal(looksLikeLoginPage('<html><body>提交列表</body></html>'), false);
});

// ---------- 行解析 ----------

test('qoj: parseQojRows 提取提交号 / 题目 / 结果 / 语言 / 时间', () => {
  const html = page([
    { id: 9001, result: 'AC ✓', href: '/contest/3588/problem/17753', problemText: 'A. Trick Question', ts: DEFAULT_TS },
    { id: 9002, result: '67', href: '/problem/9242', problemText: 'Problem Two', language: 'Python 3', ts: DEFAULT_TS - 60_000 },
  ]);
  const rows = parseQojRows(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.submissionId, '9001');
  assert.equal(rows[0]!.problemKey, '3588-17753');
  assert.equal(rows[0]!.problemUrl, 'https://qoj.ac/contest/3588/problem/17753');
  assert.equal(rows[0]!.title, 'Trick Question');
  assert.equal(rows[0]!.result, 'AC ✓');
  assert.equal(rows[0]!.language, 'C++17');
  assert.equal(rows[0]!.timeText, localTimeText(DEFAULT_TS, OFFSET_HOURS));

  assert.equal(rows[1]!.problemKey, '9242');
  assert.equal(rows[1]!.language, 'Python 3');
  assert.equal(rows[1]!.result, '67');
});

test('qoj: parseQojRows 跳过表头与非提交行', () => {
  const html = page([{ id: 9001, result: 'AC ✓', ts: DEFAULT_TS }]);
  assert.equal(parseQojRows(html).length, 1);
  // 无数据行（表头只有 <th>）→ 空数组
  assert.equal(parseQojRows(page([], { withTable: true })).length, 0);
  // 无表格 → 空数组
  assert.equal(parseQojRows('<html><body><p>hello</p></body></html>').length, 0);
});

test('qoj: parseQojRows 传入用户名时过滤掉表格中他人的提交', () => {
  const html = page([
    { id: 9001, result: 'AC ✓', ts: DEFAULT_TS, who: 'Qingyu' },
    { id: 9002, result: 'WA', ts: DEFAULT_TS - 1000, who: 'someone_else' },
  ]);
  assert.equal(parseQojRows(html, 'Qingyu').length, 1);
  assert.equal(parseQojRows(html, 'qingyu').length, 1, '用户名比对不区分大小写');
  assert.equal(parseQojRows(html, 'nobody').length, 0);
  assert.equal(parseQojRows(html).length, 2, '不传用户名时不过滤');
});

test('qoj: 真实页面列序（提交者在结果之前）必须正确解析', () => {
  // 逐字节取自 qoj.ac 真实提交列表行（仅替换提交号/时间等测试值），标记形态原样保留。
  // 两个关键陷阱：
  //  1) 「提交者」列排在「结果」列**之前**；
  //  2) 「结果」列是链接（`<a class="uoj-score">`），「语言」列**也是链接**
  //     （`<a href="/submission/N">C++23</a>`）——按「有没有链接」判定必然错位，
  //     错位后会把提交者名当结果、运行时间当语言，整页 verdict 全部无法识别 → 同步静默 0 条。
  const row = `<tr>
<td><a href="/submission/2924293" style="color: orange">#2924293</a></td>
<td><a href="/contest/4071/problem/20019">#20019. Sequence</a></td>
<td><span class="uoj-username" data-user-color="rgb(55, 205, 155)" data-rating="1800" data-nickname="hieZF123" data-rated="1">hieZF123</span> <span class="glyphicon glyphicon-lock" aria-hidden="true"></span></td>
<td><a href="/submission/2924293" class="uoj-score" data-full="100.000000" data-score="100.000000">AC ✓</a></td>
<td>17ms</td>
<td>4000kb</td>
<td><a href="/submission/2924293">C++23</a></td>
<td>769b</td>
<td><small>2026-09-10 15:50:27</small></td>
</tr>`;
  const html = `<html><body><table><thead><tr><th>ID</th><th>Problem</th><th>Submitter</th><th>Result</th><th>Time</th><th>Memory</th><th>Language</th><th>File size</th><th>Submit time</th></tr></thead><tbody>${row}</tbody></table></body></html>`;

  const rows = parseQojRows(html);
  assert.equal(rows.length, 1, '真实列序的行必须被解析出来（否则同步会静默返回 0 条）');
  const r = rows[0]!;
  assert.equal(r.submissionId, '2924293');
  assert.equal(r.problemKey, '4071-20019');
  assert.equal(r.title, 'Sequence');
  assert.equal(r.result, 'AC ✓', '结果必须取到结果列，而不是提交者名或运行时间');
  assert.equal(r.language, 'C++23', '语言必须取到语言列（该列同样带链接）');
  assert.equal(r.timeText, '2026-09-10 15:50:27');
  assert.equal(mapQojVerdict(r.result), 'AC');
  assert.equal(parseQojRows(html, 'hieZF123').length, 1, '提交者用 <span class="uoj-username"> 标注，也应能识别');
  assert.equal(parseQojRows(html, 'someone-else').length, 0);
});

test('qoj: 真实页面的子任务得分行（无 ✓）解析为 WA', () => {
  const row = `<tr>
<td><a href="/submission/2924293">#2924293</a></td>
<td><a href="/contest/4071/problem/20019">#20019. Sequence</a></td>
<td><span class="uoj-username">hieZF123</span></td>
<td><a href="/submission/2924293" class="uoj-score" data-full="100.000000" data-score="67.000000">67</a></td>
<td>17ms</td>
<td>4000kb</td>
<td><a href="/submission/2924293">C++23</a></td>
<td>769b</td>
<td><small>2026-09-10 15:50:27</small></td>
</tr>`;
  const r = parseQojRows(`<table><tbody>${row}</tbody></table>`)[0]!;
  assert.equal(r.result, '67');
  assert.equal(r.language, 'C++23');
  assert.equal(mapQojVerdict(r.result), 'WA');
});

test('qoj: 列顺序变动（结果在提交者之前）同样可解析', () => {
  // 结构容错：UOJ 升级若把结果列提前，仍应取到正确的结果与语言
  const row = `<tr>
<td><a href="/submission/1">#1</a></td>
<td><a href="/problem/9">A. X</a></td>
<td>AC ✓</td>
<td>10ms</td>
<td>1M</td>
<td>PyPy3</td>
<td>100b</td>
<td><a href="/user/profile/someone">someone</a></td>
<td><small>2026-01-01 00:00:00</small></td>
</tr>`;
  const rows = parseQojRows(`<table><tbody>${row}</tbody></table>`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.result, 'AC ✓');
  assert.equal(rows[0]!.language, 'PyPy3');
  assert.equal(rows[0]!.timeText, '2026-01-01 00:00:00');
});

// ---------- 适配器：拉取 ----------

test('qoj: 无 Cookie 抛 ManualImportRequiredError；problemUrl 两种键都正确', async () => {
  const adapter = createQojAdapter(router({}));
  await assert.rejects(() => adapter.fetchUserSubmissions('someone'), ManualImportRequiredError);
  assert.equal(adapter.platform, 'qoj');
  assert.equal(adapter.knownIdsFilter, true);
  assert.equal(adapter.problemUrl({ problemKey: '9242' }), 'https://qoj.ac/problem/9242');
  assert.equal(
    adapter.problemUrl({ problemKey: '3588-17753' }),
    'https://qoj.ac/contest/3588/problem/17753',
  );
});

test('qoj: 拉取一页并归一化（时区换算、verdict、题目键）', async () => {
  const adapter = createQojAdapter(router({
    1: page([
      { id: 500, result: 'AC ✓', ts: DEFAULT_TS },
      { id: 499, result: 'TL', ts: DEFAULT_TS - 60_000 },
      { id: 498, result: 'JG', ts: DEFAULT_TS - 120_000 }, // 评测中 → 跳过
    ]),
  }));
  const subs = await adapter.fetchUserSubmissions('someone', { cookie: COOKIE, pageDelayMs: 0 });
  assert.equal(subs.length, 2, '评测中的行不落库');
  assert.equal(subs[0]!.externalId, '500');
  assert.equal(subs[0]!.verdict, 'AC');
  assert.equal(subs[0]!.submittedAt, new Date(DEFAULT_TS).toISOString()); // 服务器本地时间已换算为 UTC
  assert.equal(subs[0]!.problem.platform, 'qoj');
  assert.equal(subs[0]!.problem.problemKey, '1500');
  assert.equal(subs[0]!.problem.url, 'https://qoj.ac/problem/1500');
  assert.equal(subs[0]!.language, 'C++17');
  assert.equal(subs[1]!.verdict, 'TLE');
});

test('qoj: 按 knownExternalIds 整页已知即早停（增量同步不重复翻页）', async () => {
  const seenUrls: string[] = [];
  const known = new Set(rowsFrom(500, 10, DEFAULT_TS).map((r) => String(r.id)));
  const adapter = createQojAdapter(router({
    1: page(rowsFrom(500, 10, DEFAULT_TS)),
    2: page(rowsFrom(490, 10, DEFAULT_TS)),
  }, { seenUrls }));
  const opts: FetchOptions = { cookie: COOKIE, knownExternalIds: known, pageDelayMs: 0 };
  const subs = await adapter.fetchUserSubmissions('someone', opts);
  assert.equal(subs.length, 0);
  assert.equal(seenUrls.length, 1, '整页已知应只请求首页');
  assert.equal(opts.truncated, undefined, '增量早停不算截断');
});

test('qoj: 触及单次新增上限即回写 truncated 与补全游标', async () => {
  // 每页 10 条：maxSubmissions=20 → 第 2 页填满上限即停，回写 backfillReachedPage=2
  const pages: Record<number, string> = {};
  for (let p = 1; p <= 5; p += 1) pages[p] = page(rowsFrom(1000 - (p - 1) * 10, 10, DEFAULT_TS - (p - 1) * 600_000));
  const adapter = createQojAdapter(router(pages));
  const opts: FetchOptions = { cookie: COOKIE, maxSubmissions: 20, pageDelayMs: 0 };
  const subs = await adapter.fetchUserSubmissions('someone', opts);
  assert.equal(subs.length, 20);
  assert.equal(opts.truncated, true);
  assert.equal(opts.backfillReachedPage, 2);
});

test('qoj: 页数预算耗尽（未触及新增上限）也标记截断', async () => {
  // 页数预算 = ceil(5/10)×2 = 2 页；5 条新增但页面始终满 10 行 → 预算耗尽 → 截断
  const pages: Record<number, string> = {};
  for (let p = 1; p <= 4; p += 1) pages[p] = page(rowsFrom(1000 - (p - 1) * 10, 10, DEFAULT_TS - (p - 1) * 600_000));
  const adapter = createQojAdapter(router(pages));
  const opts: FetchOptions = { cookie: COOKIE, maxSubmissions: 5, pageDelayMs: 0 };
  const subs = await adapter.fetchUserSubmissions('someone', opts);
  assert.equal(subs.length, 5);
  assert.equal(opts.truncated, true);
  assert.equal(opts.backfillReachedPage, 1);
});

test('qoj: 补全模式从 backfillFromPage 续拉更早历史', async () => {
  const seenUrls: string[] = [];
  const adapter = createQojAdapter(router({
    3: page(rowsFrom(700, 3, DEFAULT_TS)),
  }, { seenUrls }));
  const opts: FetchOptions = {
    cookie: COOKIE,
    backfill: true,
    backfillFromPage: 3,
    knownExternalIds: new Set(['999']),
    pageDelayMs: 0,
  };
  const subs = await adapter.fetchUserSubmissions('someone', opts);
  assert.equal(subs.length, 3);
  assert.ok(seenUrls[0]!.includes('page=3'), `应从第 3 页续拉，实际 ${seenUrls[0]}`);
});

// ---------- 适配器：错误与凭据 ----------

test('qoj: Cloudflare 挑战转成可读引导（含 cf_clearance + 浏览器 UA 说明）', async () => {
  const cfBody = '<html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>';
  const adapter = createQojAdapter(router({}, {
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
    body: cfBody,
  }));
  await assert.rejects(
    () => adapter.fetchUserSubmissions('someone', { cookie: COOKIE, pageDelayMs: 0 }),
    (e: Error) => {
      assert.ok(e instanceof ManualImportRequiredError);
      assert.match(e.message, /Cloudflare/);
      assert.match(e.message, /cf_clearance/);
      assert.match(e.message, /User-Agent/, '必须提示配 UA：cf_clearance 与签发它的浏览器 UA 绑定');
      assert.match(e.message, /navigator\.userAgent/, '给出可操作的获取步骤');
      return true;
    },
  );
});

test('qoj: opts.ua 原样作为请求头发送（复刻浏览器 UA 以通过 cf_clearance 校验）', async () => {
  const seenHeaders: Array<Record<string, string>> = [];
  const adapter = createQojAdapter(router({ 1: page(rowsFrom(500, 3, DEFAULT_TS)) }, { seenHeaders }));
  const browserUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  await adapter.fetchUserSubmissions('someone', { cookie: COOKIE, ua: browserUa, pageDelayMs: 0 });
  assert.equal(seenHeaders[0]!['User-Agent'], browserUa);

  // 未提供 ua 时回退适配器内置 UA（保证旧配置仍可用）
  const seen2: Array<Record<string, string>> = [];
  const adapter2 = createQojAdapter(router({ 1: page(rowsFrom(500, 3, DEFAULT_TS)) }, { seenHeaders: seen2 }));
  await adapter2.fetchUserSubmissions('someone', { cookie: COOKIE, pageDelayMs: 0 });
  assert.match(seen2[0]!['User-Agent'] ?? '', /^Mozilla\/5\.0/);
});

test('qoj: 302 跳登录页 → 提示凭据失效', async () => {
  const adapter = createQojAdapter(router({}, { status: 302, headers: { location: '/login' } }));
  await assert.rejects(
    () => adapter.fetchUserSubmissions('someone', { cookie: COOKIE, pageDelayMs: 0 }),
    (e: Error) => e instanceof ManualImportRequiredError && /UOJSESSID/.test(e.message),
  );
});

test('qoj: 首页有表格却解析不到数据 → 明确报错而非"成功 0 条"', async () => {
  // 表格存在但行结构不符合（无 /submission/ 链接）
  const broken = '<html><body><table><tbody><tr><td>x</td><td>y</td></tr></tbody></table></body></html>';
  const adapter = createQojAdapter(router({ 1: broken }));
  await assert.rejects(
    () => adapter.fetchUserSubmissions('someone', { cookie: COOKIE, pageDelayMs: 0 }),
    /未解析到数据|改版/,
  );
});

test('qoj: checkAuth 校验账号与凭据', async () => {
  const noHandle = createQojAdapter(router({ 1: page(rowsFrom(500, 3, DEFAULT_TS)) }));
  assert.equal((await noHandle.checkAuth!({ cookie: COOKIE })).ok, false);

  const ok = createQojAdapter(router({ 1: page(rowsFrom(500, 3, DEFAULT_TS)) }));
  const r1 = await ok.checkAuth!({ cookie: COOKIE, handle: 'someone' });
  assert.equal(r1.ok, true);
  assert.match(r1.message, /3 条/);

  // 账号无提交：页面仍是提交列表页（表头存在）但无数据行 → 凭据有效
  const emptyHtml = '<html><body><table><thead><tr><th>#</th><th>Problem</th><th>Submitter</th><th>Result</th><th>Submit Time</th></tr></thead><tbody></tbody></table></body></html>';
  const empty = createQojAdapter(router({ 1: emptyHtml }));
  const r2 = await empty.checkAuth!({ cookie: COOKIE, handle: 'someone' });
  assert.equal(r2.ok, true);
  assert.match(r2.message, /没有提交记录/);

  // 页面被换成别的内容（无提交表结构）→ 明确报错而非"凭据有效 0 条"
  const offPage = createQojAdapter(router({ 1: '<html><body><p>hello</p></body></html>' }));
  const r2b = await offPage.checkAuth!({ cookie: COOKIE, handle: 'someone' });
  assert.equal(r2b.ok, false);
  assert.match(r2b.message, /改版|未解析到/);

  const noCookie = createQojAdapter(router({ 1: page([]) }));
  assert.equal((await noCookie.checkAuth!({ cookie: '', handle: 'someone' })).ok, false);

  // 缺少 cf_clearance（只填了会话项）→ 明确要求整段粘贴，且不再要求「两项都填」
  const sessionOnly = createQojAdapter(router({ 1: page(rowsFrom(500, 3, DEFAULT_TS)) }));
  const rSessionOnly = await sessionOnly.checkAuth!({ cookie: 'UOJSESSID=sess-token', handle: 'someone' });
  assert.equal(rSessionOnly.ok, false);
  assert.match(rSessionOnly.message, /cf_clearance/);

  // Cloudflare 拦截 → 提示需补 cf_clearance
  const cf = createQojAdapter(router({}, {
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
    body: '<html>Just a moment...</html>',
  }));
  const r3 = await cf.checkAuth!({ cookie: COOKIE, handle: 'someone' });
  assert.equal(r3.ok, false);
  assert.match(r3.message, /cf_clearance/);
});

test('qoj: 浏览器整段 Cookie（含 Cloudflare 设备校验项）原样透传', async () => {
  // 用户从 F12 复制的真实形态：cf_clearance + CF_VERIFIED_DEVICE_… + UOJ 展示项
  const fullCookie =
    'cf_clearance=abc.def-1757900000-1.2.1.1-XXXXXXXX; CF_VERIFIED_DEVICE_abc123=verified; ' +
    'OptanonConsent=groups=C0001%3A1; uoj_locale=zh-cn; uoj_remember_token=eyJ0b2tlbg; uoj_username=Qingyu; UOJSESSID=sess-token';
  const seenHeaders: Array<Record<string, string>> = [];
  const adapter = createQojAdapter(router({ 1: page(rowsFrom(500, 3, DEFAULT_TS)) }, { seenHeaders }));
  const r = await adapter.checkAuth!({ cookie: fullCookie, handle: 'someone' });
  assert.equal(r.ok, true);
  assert.equal(seenHeaders[0]!.Cookie, fullCookie, '整段 Cookie 必须逐字节发出，不得只摘取两项');
  assert.equal(seenHeaders[0]!['Sec-Fetch-Mode'], 'navigate');
});

// ---------- 注册 ----------

test('qoj: 生产装配已注册 qoj 适配器', () => {
  initAdapters();
  const adapter = getAdapter('qoj');
  assert.equal(adapter?.platform, 'qoj');
  assert.equal(adapter?.problemUrl({ problemKey: '1' }), 'https://qoj.ac/problem/1');
});


test('qoj: 走完整同步管道（Cookie 注入 → 拉取 → 入库 → sync_runs）', async () => {
  const { createDb } = await import('../src/db/index.ts');
  const { syncPlatform } = await import('../src/adapters/sync.ts');
  const { register } = await import('../src/adapters/registry.ts');
  const db = createDb(':memory:');
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('cookie.qoj', COOKIE);
    const seenHeaders: Array<Record<string, string>> = [];
    // 提交者必须与绑定的 handle 一致：适配器会过滤表格中他人的提交
    const fixtureHtml = page([
      { id: 700, result: 'AC ✓', ts: DEFAULT_TS, href: '/contest/3588/problem/17753', problemText: 'A. Trick Question', who: 'Qingyu' },
      { id: 699, result: 'WA', ts: DEFAULT_TS - 60_000, who: 'Qingyu' },
    ], { withTable: true });
    register(createQojAdapter(router({ 1: fixtureHtml }, { seenHeaders })));
    const r = await syncPlatform(db, 'qoj', 'Qingyu', { triggeredBy: 'manual' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.imported, 2);
    // 同步层从 settings 注入的 Cookie 已带到请求头
    assert.match(seenHeaders[0]!.Cookie ?? '', /UOJSESSID=/);

    const problem = db
      .prepare("SELECT problem_key, title, url, difficulty, platform FROM problems WHERE platform='qoj' AND problem_key='3588-17753'")
      .get() as { problem_key: string; title: string; url: string; difficulty: number | null; platform: string };
    assert.equal(problem.platform, 'qoj');
    assert.equal(problem.problem_key, '3588-17753');
    assert.equal(problem.title, 'Trick Question');
    assert.equal(problem.url, 'https://qoj.ac/contest/3588/problem/17753');
    assert.equal(problem.difficulty, null, 'QOJ 无难度字段');

    const sub = db
      .prepare("SELECT verdict, submitted_at, external_id FROM submissions WHERE platform='qoj' ORDER BY external_id DESC")
      .get() as { verdict: string; submitted_at: string; external_id: string };
    assert.equal(sub.verdict, 'AC');
    assert.equal(sub.submitted_at, new Date(DEFAULT_TS).toISOString());
    assert.equal(sub.external_id, '700');

    const run = db
      .prepare("SELECT status, imported, mode, error_code FROM sync_runs WHERE platform='qoj'")
      .get() as { status: string; imported: number; mode: string; error_code: string | null };
    assert.equal(run.status, 'ok');
    assert.equal(run.imported, 2);
    assert.equal(run.error_code, null);
  } finally {
    db.close();
  }
});

test('qoj: 补全模式同样按 knownExternalIds 跳过已知行（不白吃新增预算）', async () => {
  // 与 CF/牛客/洛谷同口径：backfill 注入 knownExternalIds，已知行跳过、
  // 连续 2 个整页已知即判定补到尽头。旧实现 backfill 传 undefined，
  // 每轮把已入库的行重新当作「新增」吃满 maxSubmissions 预算，游标推进极慢。
  const seenUrls: string[] = [];
  // 两页提交都已入库（known 覆盖两页全部提交号）→ 连续 2 个整页已知 → 判定补到尽头
  const known = new Set(
    [...rowsFrom(500, 10, DEFAULT_TS), ...rowsFrom(490, 10, DEFAULT_TS)].map((r) => String(r.id)),
  );
  const adapter = createQojAdapter(router({
    1: page(rowsFrom(500, 10, DEFAULT_TS)),
    2: page(rowsFrom(490, 10, DEFAULT_TS)),
  }, { seenUrls }));
  const opts: FetchOptions = { cookie: COOKIE, backfill: true, knownExternalIds: known, pageDelayMs: 0 };
  const subs = await adapter.fetchUserSubmissions('someone', opts);
  assert.equal(subs.length, 0, '已知行不重复产出');
  assert.equal(seenUrls.length, 2, '连续 2 个整页已知 → 判定已补到尽头');
  assert.equal(opts.truncated, undefined);
});
