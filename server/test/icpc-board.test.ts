/**
 * ICPC/CCPC 公开榜单难度（QOJ 题集的难度来源）。
 *
 * fixture 取自 2026-09-27/28 实测的真实数据（网络抓取后裁剪，形状与字段名保持原样）：
 * - xcpcrating `problem-catalog.json`：`icpc/icpc2026/icpc2026preliminary-1:A` ↔ `qoj:20016`
 * - xcpcrating `problem-types/*.json`：键同样是 `赛场键:题号字母`，且实测比评分目录**多覆盖**
 *   一批题（1100 vs 987 条 qoj 题号）；库内实测缺难度的 `2513-14301/2/3` 只在这一份里
 *   （`icpc/icpc2025/icpc2025preliminary-1:A/B/C`）—— 旧实现只读它的 detailTags、把键丢掉，
 *   于是这批题「有标签、没难度」。
 * - RankLand 赛场索引：`uk = icpc2026preliminary-1`（兄弟场 `-2` 词元完全相同，只能靠全等 uk 区分）
 * - RankLand 榜单 srk：`problems[].alias` + `statistics.accepted`，`rows` 行数 = 队伍总数
 * - QOJ 比赛页：`server/test/fixtures/qoj-contest-2513.html`（2026-09-28 实测页面的题目表格裁剪）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDb, type Db } from '../src/db/index.ts';
import {
  matchBoardByFacets,
  matchRanklandBoard,
  parseRanklandIndex,
  parseRanklandSrk,
  parseXcpcCatalog,
  parseXcpcTags,
  parseXcpcTypes,
  qojProblemIdFromKey,
  ranklandTier,
} from '../src/analysis/icpcBoard.ts';
import { contestFacets, contestRound, extractYear, classifyStage, classifySite } from '../src/analysis/xcpcFacets.ts';
import { parseQojContestPage, qojProblemRefFromKey } from '../src/analysis/qojContest.ts';
import { backfillDifficulties } from '../src/analysis/difficultyBackfill.ts';

// ---------- 纯解析与判定 ----------

test('ranklandTier: 与参考项目同口径的过题占比档位（≤10% 金 / ≤30% 银 / ≤60% 铜 / 其余铁）', () => {
  assert.equal(ranklandTier(0, 100), 'gold');
  assert.equal(ranklandTier(10, 100), 'gold'); // 边界含等号
  assert.equal(ranklandTier(11, 100), 'silver');
  assert.equal(ranklandTier(30, 100), 'silver');
  assert.equal(ranklandTier(31, 100), 'bronze');
  assert.equal(ranklandTier(60, 100), 'bronze');
  assert.equal(ranklandTier(61, 100), 'iron');
  assert.equal(ranklandTier(100, 100), 'iron');
  // 实测：2026 ICPC EC 网络预选赛第一场 2535 队，A 题 1019 队过 → 铜
  assert.equal(ranklandTier(1019, 2535), 'bronze');
  assert.equal(ranklandTier(704, 2535), 'silver');
  assert.equal(ranklandTier(2419, 2535), 'iron');
});

test('parseRanklandIndex / parseRanklandSrk: 结构异常一律降级为空（不猜）', () => {
  const index = parseRanklandIndex({
    data: {
      contests: [
        { uk: 'icpc2026preliminary-1', name: '2026 ICPC Asia EC网络预选赛 - 第一场', srkFileID: '94656957302009856' },
        { uk: 'icpc2026preliminary-2', name: '第二场', srkFileID: '95451702349623296' },
        { uk: '', name: '缺 uk', srkFileID: 'x' },
      ],
    },
  });
  assert.deepEqual(index.map((b) => b.uk), ['icpc2026preliminary-1', 'icpc2026preliminary-2']);
  assert.deepEqual(parseRanklandIndex({ data: { contests: 'nope' } }), []);
  assert.deepEqual(parseRanklandIndex(null), []);

  const stats = parseRanklandSrk({
    rows: new Array(2535).fill({}),
    problems: [
      { alias: 'A', statistics: { accepted: 1019, submitted: 8342 } },
      { alias: 'd', statistics: { accepted: 704, submitted: 4575 } }, // 小写别名归一化为大写
      { alias: 'X', statistics: { accepted: 99999 } }, // 越界（>总队伍数）→ 丢弃
      { alias: 'Y' }, // 无统计 → 丢弃
      { statistics: { accepted: 10 } }, // 无别名 → 丢弃
    ],
  });
  assert.equal(stats.size, 2);
  assert.deepEqual(stats.get('A'), { accepted: 1019, total: 2535, tier: 'bronze' });
  assert.equal(stats.get('D')!.tier, 'silver');
  assert.equal(parseRanklandSrk({ rows: [], problems: [] }).size, 0);
  assert.equal(parseRanklandSrk(null).size, 0);
});

test('parseXcpcCatalog / parseXcpcTags: 只认 qoj 题号，其余平台条目忽略', () => {
  const catalog = parseXcpcCatalog({
    problems: {
      'icpc/icpc2026/icpc2026preliminary-1:A': {
        title: 'Recall',
        canonicalId: 'qoj:20016',
        problemUrl: 'https://qoj.ac/problem/20016',
      },
      'ccpc/ccpc2021/ccpc2021final:M': { title: 'Check In', canonicalId: 'qoj:20028' },
      'icpc/icpc2025/x:B': { title: '别站题', canonicalId: 'codeforces:1234B' },
    },
  });
  assert.equal(catalog.size, 2);
  assert.deepEqual(catalog.get('20016'), {
    contestKey: 'icpc/icpc2026/icpc2026preliminary-1',
    alias: 'A',
    title: 'Recall',
  });
  assert.equal(catalog.get('20028')!.contestKey, 'ccpc/ccpc2021/ccpc2021final');
  assert.equal(parseXcpcCatalog(null).size, 0);

  const tags = parseXcpcTags({
    problems: {
      a: { canonicalId: 'qoj:20016', detailTags: ['栈', '模拟', '模拟'] },
      b: { canonicalId: 'qoj:20019', detailTags: [] },
      c: { canonicalId: 'atcoder:abc001_a', detailTags: ['x'] },
    },
  });
  assert.deepEqual(tags.get('20016'), ['栈', '模拟']); // 去重
  assert.equal(tags.has('20019'), false); // 空标签不入表
  assert.equal(tags.size, 1);
});

test('matchRanklandBoard: 兄弟场词元完全相同 → 必须靠全等 uk 区分，含糊时不猜', () => {
  const boards = [
    { uk: 'icpc2026preliminary-2', name: '2026 ICPC Asia EC网络预选赛 - 第二场', fileId: '2' },
    { uk: 'icpc2026preliminary-1', name: '2026 ICPC Asia EC网络预选赛 - 第一场', fileId: '1' },
  ];
  // 若只按词元打分，1 与 2 完全并列，实测中会错误选中第二场（该场题号字母不同 → 匹配失败）
  assert.equal(matchRanklandBoard('icpc/icpc2026/icpc2026preliminary-1', boards)!.uk, 'icpc2026preliminary-1');
  assert.equal(matchRanklandBoard('icpc/icpc2026/icpc2026preliminary-2', boards)!.uk, 'icpc2026preliminary-2');
  // 分隔符风格不同（社区键 vs RankLand uk）不应影响匹配：归一化切开字母/数字边界后二者相同
  assert.equal(
    matchRanklandBoard('icpc/icpc2026/icpc2026preliminary-1', [
      { uk: 'icpc-2026-preliminary-1', name: '2026 ICPC Asia EC网络预选赛 - 第一场', fileId: 'x' },
    ])!.uk,
    'icpc-2026-preliminary-1',
  );
  // 词元打分退路：uk 词序不同但年份与词元都对得上 → 匹配
  assert.equal(
    matchRanklandBoard('ccpc/ccpc2025/ccpc2025final', [
      { uk: 'ccpc-final-2025', name: '2025 CCPC 总决赛', fileId: 'y' },
    ])!.uk,
    'ccpc-final-2025',
  );
  // 名称与 uk 都对不上 → null（不猜）
  assert.equal(
    matchRanklandBoard('icpc/icpc2026/icpc2026preliminary-1', [
      { uk: 'unknown-key', name: '2026 ICPC Asia EC网络预选赛', fileId: '9' },
    ]),
    null,
  );
  // 年份不符 → null
  assert.equal(
    matchRanklandBoard('icpc/icpc2019/icpc2019preliminary-1', [
      { uk: 'some-key', name: '2019 ICPC Asia EC网络预选赛 - 第一场', fileId: 'z' },
    ]),
    null,
  );
});

test('qojProblemIdFromKey: 比赛题键取题号段，纯题号原样，非法返回 null', () => {
  assert.equal(qojProblemIdFromKey('4071-20016'), '20016');
  assert.equal(qojProblemIdFromKey('20016'), '20016');
  assert.equal(qojProblemIdFromKey('Q1'), null);
  assert.equal(qojProblemIdFromKey(''), null);
});

test('qojProblemRefFromKey: 比赛题键同时给出比赛号（读 QOJ 比赛页的唯一线索）', () => {
  assert.deepEqual(qojProblemRefFromKey('2513-14301'), { contestId: '2513', problemId: '14301' });
  assert.deepEqual(qojProblemRefFromKey('14002'), { contestId: null, problemId: '14002' });
  assert.equal(qojProblemRefFromKey('Q1'), null);
});

// ---------- 题号映射的第二来源：题型数据集的键 ----------

test('parseXcpcTypes: 键里的「赛场键:题号字母」也是映射（旧实现把它丢掉了）', () => {
  const parsed = parseXcpcTypes({
    problems: {
      'icpc/icpc2025/icpc2025preliminary-1:A': {
        canonicalId: 'qoj:14301',
        alias: 'A',
        detailTags: ['模拟'],
      },
      'icpc/icpc2025/icpc2025preliminary-1:C': {
        canonicalId: 'qoj:14303',
        alias: 'C',
        detailTags: ['贪心', '堆'],
      },
      'ccpc/ccpc2021/ccpc2021final:M': { canonicalId: 'qoj:20028', detailTags: [] }, // 无 alias → 用键尾
      'atcoder/abc001:A': { canonicalId: 'atcoder:abc001_a', detailTags: ['x'] }, // 非 qoj → 忽略
    },
  });
  assert.deepEqual(parsed.tags.get('14301'), ['模拟']);
  assert.equal(parsed.tags.has('20028'), false, '空标签不入标签表');
  assert.deepEqual(parsed.catalog.get('14301'), {
    contestKey: 'icpc/icpc2025/icpc2025preliminary-1',
    alias: 'A',
    title: null,
  });
  assert.equal(parsed.catalog.get('20028')!.alias, 'M', '缺 alias 字段时回退键尾');
  assert.equal(parsed.catalog.size, 3);
  assert.equal(parsed.catalog.has('abc001_a'), false);
  // 兼容包装：parseXcpcTags 仍只返回标签表
  assert.deepEqual(parseXcpcTags({ problems: { a: { canonicalId: 'qoj:1', detailTags: ['x'] } } }).get('1'), ['x']);
});

// ---------- QOJ 比赛页解析（真实页面 fixture） ----------

const QOJ_2513_HTML = fs.readFileSync(new URL('./fixtures/qoj-contest-2513.html', import.meta.url), 'utf8');

test('parseQojContestPage: 从真实比赛页拿到比赛名与「题号字母 ↔ 题目 id」全表', () => {
  const page = parseQojContestPage(QOJ_2513_HTML);
  assert.equal(page.name, 'The 2025 ICPC Asia East Continent Online Contest (I)');
  assert.equal(page.problems.length, 13);
  assert.deepEqual(page.problems[0], { problemId: '14301', index: 'A', title: 'Who Can Win' });
  assert.deepEqual(page.problems[2], { problemId: '14303', index: 'C', title: 'Canvas Painting' });
  assert.deepEqual(page.problems[12], { problemId: '14313', index: 'M', title: 'Teleporter' });
  // 表头行没有题目链接 → 不会被当成题目
  assert.equal(page.problems.some((p) => p.problemId === ''), false);
  // 结构异常时不猜
  assert.deepEqual(parseQojContestPage('<html><title>Just a moment...</title></html>'), {
    name: 'Just a moment...',
    problems: [],
  });
});

test('parseQojContestPage: 题号字母单元格缺失时按行序回退 A/B/C…', () => {
  const html = `<title>某场比赛 - Dashboard - Contest - QOJ.ac</title>
    <table><tbody>
      <tr><td><a href="/contest/1/problem/10">甲</a></td></tr>
      <tr><td><a href="/contest/1/problem/11">乙</a></td></tr>
    </tbody></table>`;
  const page = parseQojContestPage(html);
  assert.deepEqual(page.problems.map((p) => p.index), ['A', 'B']);
  assert.equal(page.name, '某场比赛');
});

// ---------- 比赛名称属性识别与榜单匹配 ----------

test('contestFacets: 从比赛名识别年份/系列/赛段/赛站，网络赛场次可辨', () => {
  assert.equal(extractYear('The 2025 ICPC Asia East Continent Online Contest (I)'), '2025');
  assert.equal(extractYear('第十一届中国大学生程序设计竞赛网络预选赛'), '未知');
  assert.equal(contestRound('The 2025 ICPC Asia East Continent Online Contest (II)'), 2);
  assert.equal(contestRound('2026 ICPC Asia EC网络预选赛 - 第一场'), 1);
  assert.equal(contestRound('2026 ICPC Asia EC网络预选赛'), null);
  assert.equal(contestRound('Online Contest (2026)'), null, '括号里是年份不算场次');
  assert.equal(classifyStage('The 2025 ICPC Asia Nanjing Regional Contest'), '区域赛');
  assert.equal(classifyStage('2026 ICPC Asia EC网络预选赛 - 第一场'), '网络赛');
  assert.equal(classifySite('The 2025 ICPC Asia Nanjing Regional Contest'), '南京');
  assert.equal(classifySite('The 2025 ICPC Asia Xiangtan Regional Contest'), '全国', 'Xiangtan 不该被 Xian 命中');
  const f = contestFacets('The 2025 ICPC Asia East Continent Online Contest (I)');
  assert.deepEqual(f, { year: '2025', series: ['ICPC'], stage: '网络赛', site: '全国' });
  assert.deepEqual(contestFacets('第十一届中国大学生程序设计竞赛网络预选赛').series, ['CCPC']);
});

test('matchBoardByFacets: 目录里没有的题也能靠比赛名匹配榜单（兄弟场靠场次区分）', () => {
  const boards = parseRanklandIndex({
    data: {
      contests: [
        { uk: 'icpc2025preliminary-2', name: '2025 ICPC Asia EC网络预选赛 - 第二场', srkFileID: 'B2' },
        { uk: 'icpc2025preliminary-1', name: '2025 ICPC Asia EC网络预选赛 - 第一场', srkFileID: 'B1' },
        { uk: 'icpc2025nanjing', name: '「华为杯」第 50 届 ICPC 国际大学生程序设计竞赛区域赛南京站', srkFileID: 'NJ' },
        { uk: 'icpc2024nanjing', name: '第 49 届 ICPC 国际大学生程序设计竞赛区域赛南京站', srkFileID: 'NJ24' },
        { uk: 'ccpc2025preliminary', name: '第十一届 CCPC 网络预选赛', srkFileID: 'C25' },
      ],
    },
  });
  const pick = (name: string): string | null => matchBoardByFacets(name, boards)?.uk ?? null;
  // 实测：库内 2513-14301/2/3 所在比赛
  assert.equal(pick('The 2025 ICPC Asia East Continent Online Contest (I)'), 'icpc2025preliminary-1');
  assert.equal(pick('The 2025 ICPC Asia East Continent Online Contest (II)'), 'icpc2025preliminary-2');
  assert.equal(pick('The 2025 ICPC Asia Nanjing Regional Contest'), 'icpc2025nanjing');
  assert.equal(pick('The 2024 ICPC Asia Nanjing Regional Contest'), 'icpc2024nanjing');
  // 年份对不上的比赛 → 不猜
  assert.equal(pick('The 2023 ICPC Asia East Continent Online Contest (I)'), null);
  // 赛站对不上的区域赛 → 不猜
  assert.equal(pick('The 2025 ICPC Asia Shanghai Regional Contest'), null);
});

// ---------- 回填集成（QOJ 全链路，mock 上游） ----------

const CATALOG = {
  version: 'problem-catalog-audited-v3',
  problems: {
    'icpc/icpc2026/icpc2026preliminary-1:A': { title: 'Recall', canonicalId: 'qoj:20016', problemUrl: 'https://qoj.ac/problem/20016' },
    'icpc/icpc2026/icpc2026preliminary-1:D': { title: 'Sequence', canonicalId: 'qoj:20019' },
  },
};
const TYPES = {
  version: 'problem-types-audited-v4',
  problems: {
    'icpc/icpc2026/icpc2026preliminary-1:A': { canonicalId: 'qoj:20016', detailTags: ['栈', '模拟', '离散化'] },
  },
};
const INDEX = {
  data: {
    contests: [
      { uk: 'icpc2026preliminary-2', name: '2026 ICPC Asia EC网络预选赛 - 第二场', srkFileID: 'F2' },
      { uk: 'icpc2026preliminary-1', name: '2026 ICPC Asia EC网络预选赛 - 第一场', srkFileID: 'F1' },
    ],
  },
};
const SRK = {
  rows: new Array(2535).fill({}),
  problems: [
    { alias: 'A', statistics: { accepted: 1019, submitted: 8342 } },
    { alias: 'D', statistics: { accepted: 704, submitted: 4575 } },
  ],
};

interface RouterOptions {
  catalog?: unknown;
  /** 题型数据集（键里带赛场键 + 题号字母，顺带给出映射）；null = 拿不到 */
  types?: unknown;
  index?: unknown;
  srk?: unknown;
}

function qojRouter(opts: RouterOptions = {}): typeof fetch {
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (input: string | URL | Request) => {
    const u = String(input);
    if (u.includes('problem-catalog.json')) {
      if (opts.catalog === null) return new Response('nope', { status: 404 });
      return json(opts.catalog ?? CATALOG);
    }
    if (u.includes('problem-types')) {
      if (opts.types === null) return new Response('nope', { status: 404 });
      return json(opts.types ?? TYPES);
    }
    if (u.includes('/api/v2/public/contests')) {
      if (opts.index === null) return new Response('nope', { status: 503 });
      return json(opts.index ?? INDEX);
    }
    if (u.includes('/api/v2/public/files/')) return json({ data: { url: 'https://cdn.algoux.cn/rankland/file/F1/board.srk.json' } });
    if (u.includes('cdn.algoux.cn')) return json(opts.srk ?? SRK);
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

/** 只服务 QOJ 比赛页的 mock 传输层（生产用 HTTP/1.1 + 节流单例，单测必须注入以避免真打上游） */
function qojPageTransport(
  handler: (url: string) => Response | undefined,
): { transport: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const transport: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return handler(url) ?? new Response('', { status: 404 });
  };
  return { transport, calls };
}

/** Cloudflare 挑战页（真实形状：403 + `just a moment`） */
function challengeResponse(): Response {
  return new Response('<!DOCTYPE html><title>Just a moment...</title>', {
    status: 403,
    headers: { 'cf-mitigated': 'challenge' },
  });
}

function insertQoj(db: Db, key: string): void {
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, url, tags, difficulty_source)
     VALUES ('qoj', ?, ?, NULL, ?, '[]', 'sync')`,
  ).run(key, key, `https://qoj.ac/contest/${key.replace('-', '/problem/')}`);
}

test('回填：QOJ 难度由公开榜单推导（题号→赛场+字母→过题占比→档位），并顺带补知识点标签', async () => {
  const db = createDb(':memory:');
  insertQoj(db, '4071-20016');
  const results = await backfillDifficulties(db, qojRouter());
  const qoj = results.find((r) => r.platform === 'qoj')!;
  assert.equal(qoj.scanned, 1);
  assert.equal(qoj.filled, 1);
  const row = db.prepare(
    "SELECT difficulty, native_difficulty, difficulty_scale, difficulty_source, tags FROM problems WHERE platform='qoj' AND problem_key='4071-20016'",
  ).get() as any;
  assert.equal(row.difficulty, 1500); // bronze → CF 1500（ICPC_TIER_TO_RATING）
  assert.equal(row.native_difficulty, 'bronze:1019/2535'); // 原生档位 + 原始占比（可重算）
  assert.equal(row.difficulty_scale, 'icpc-tier');
  assert.equal(row.difficulty_source, 'backfill');
  assert.ok(JSON.parse(row.tags).includes('模拟'), 'detailTags 应写入题库标签');
  db.close();
});

// ---------- 目录没收录的题：两条新路径（2026-09-28） ----------

/** 题型数据集里带 `icpc/icpc2025/icpc2025preliminary-1:A/B/C`（实测覆盖 2513-14301/2/3） */
const TYPES_2025 = {
  version: 'problem-types-audited-v4',
  problems: {
    'icpc/icpc2025/icpc2025preliminary-1:A': { canonicalId: 'qoj:14301', alias: 'A', detailTags: ['模拟'] },
    'icpc/icpc2025/icpc2025preliminary-1:B': { canonicalId: 'qoj:14302', alias: 'B', detailTags: ['构造'] },
    'icpc/icpc2025/icpc2025preliminary-1:C': { canonicalId: 'qoj:14303', alias: 'C', detailTags: ['贪心'] },
  },
};
/** RankLand 索引：2025/2026 各两场网络赛（第一/第二场词元完全相同，只能靠场次区分） */
const INDEX_2025 = {
  data: {
    contests: [
      { uk: 'icpc2025preliminary-2', name: '2025 ICPC Asia EC网络预选赛 - 第二场', srkFileID: 'F52' },
      { uk: 'icpc2025preliminary-1', name: '2025 ICPC Asia EC网络预选赛 - 第一场', srkFileID: 'F51' },
      { uk: 'icpc2026preliminary-1', name: '2026 ICPC Asia EC网络预选赛 - 第一场', srkFileID: 'F61' },
    ],
  },
};
/** 2025 第一场榜单：实测 A=1594/2279(iron)、C=356/2279(silver) */
const SRK_2025 = {
  rows: new Array(2279).fill({}),
  problems: [
    { alias: 'A', statistics: { accepted: 1594, submitted: 9999 } },
    { alias: 'C', statistics: { accepted: 356, submitted: 4321 } },
  ],
};

test('回填：评分目录没收录、但题型数据集的键有映射 → 不读 QOJ 比赛页也能补上难度', async () => {
  // 实测背景：problem-catalog.json（评分数据集）只有 987 道 qoj 题，
  // problem-types 的键覆盖 1100 道 —— 2513-14301/2/3 恰好在后者。旧实现只读 detailTags、
  // 把键（赛场键+题号字母）丢掉，于是这批题「有标签、没难度」。
  const db = createDb(':memory:');
  insertQoj(db, '2513-14301');
  insertQoj(db, '2513-14303');
  const { transport, calls } = qojPageTransport(() => challengeResponse());
  const results = await backfillDifficulties(
    db,
    qojRouter({ catalog: null, types: TYPES_2025, index: INDEX_2025, srk: SRK_2025 }),
    { qojTransport: transport },
  );
  const qoj = results.find((r) => r.platform === 'qoj')!;
  assert.equal(qoj.filled, 2);
  assert.equal(qoj.failed, 0, '映射来自社区数据集 → 不该记「公开榜单未匹配」');
  assert.deepEqual(calls, [], '数据集里有映射时不得去打 QOJ 比赛页');
  const a = db.prepare("SELECT difficulty, native_difficulty FROM problems WHERE problem_key='2513-14301'").get() as any;
  assert.equal(a.difficulty, 1000, 'A 题 1594/2279 → iron → CF 1000');
  assert.equal(a.native_difficulty, 'iron:1594/2279');
  const c = db.prepare("SELECT difficulty FROM problems WHERE problem_key='2513-14303'").get() as any;
  assert.equal(c.difficulty, 2000, 'C 题 356/2279 → silver → CF 2000');
  db.close();
});

test('回填：社区数据集都没有该题号 → 读 QOJ 比赛页拿题号字母，再按比赛名匹配榜单', async () => {
  const db = createDb(':memory:');
  insertQoj(db, '2513-14301');
  const { transport, calls } = qojPageTransport((url) =>
    url === 'https://qoj.ac/contest/2513'
      ? new Response(QOJ_2513_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      : undefined,
  );
  const results = await backfillDifficulties(
    db,
    qojRouter({ catalog: null, types: null, index: INDEX_2025, srk: SRK_2025 }),
    { qojTransport: transport },
  );
  const qoj = results.find((r) => r.platform === 'qoj')!;
  assert.equal(qoj.filled, 1, '比赛页给了 A 题 → 2025 第一场 A = 1594/2279 → iron');
  assert.deepEqual(calls, ['https://qoj.ac/contest/2513'], '按比赛号读一次比赛页，不逐题打上游');
  const row = db.prepare(
    "SELECT difficulty, native_difficulty, difficulty_scale FROM problems WHERE problem_key='2513-14301'",
  ).get() as any;
  assert.equal(row.difficulty, 1000);
  assert.equal(row.native_difficulty, 'iron:1594/2279');
  assert.equal(row.difficulty_scale, 'icpc-tier');
  db.close();
});

test('回填：QOJ 比赛页被 Cloudflare 挑战 → 该题保持未知（不写脏数据、如实记失败）', async () => {
  const db = createDb(':memory:');
  insertQoj(db, '2513-14301');
  const { transport } = qojPageTransport(() => challengeResponse());
  const results = await backfillDifficulties(
    db,
    qojRouter({ catalog: null, types: null, index: INDEX_2025 }),
    { qojTransport: transport },
  );
  const qoj = results.find((r) => r.platform === 'qoj')!;
  assert.equal(qoj.filled, 0);
  assert.equal(qoj.failed, 1);
  assert.ok(qoj.details.some((d) => d.note?.includes('公开榜单未匹配')));
  const row = db.prepare(
    "SELECT difficulty, difficulty_scale FROM problems WHERE platform='qoj' AND problem_key='2513-14301'",
  ).get() as any;
  assert.equal(row.difficulty, null);
  db.close();
});

test('回填：榜单索引拿不到、但题型数据可用 → 只补知识点标签，难度保持未知', async () => {
  // 难度两条路都断了（评分目录没有该题、榜单索引 503），但逐题标签是独立收益：
  // 写标签、不写难度，也不谎报成功
  const db = createDb(':memory:');
  insertQoj(db, '2513-14301');
  const { transport, calls } = qojPageTransport(() => challengeResponse());
  const results = await backfillDifficulties(
    db,
    qojRouter({ catalog: null, types: TYPES_2025, index: null }),
    { qojTransport: transport },
  );
  const qoj = results.find((r) => r.platform === 'qoj')!;
  assert.equal(qoj.filled, 0);
  const row = db.prepare("SELECT difficulty, tags FROM problems WHERE problem_key='2513-14301'").get() as any;
  assert.equal(row.difficulty, null, '难度推不出来 → 保持 null（不猜）');
  assert.deepEqual(JSON.parse(row.tags), ['模拟'], '标签照常补上');
  assert.deepEqual(calls, [], '榜单索引不可用时不必再读比赛页（读到了也配不上档位）');
  db.close();
});

test('回填：公开数据源全部不可用 → QOJ 记失败但不影响其他平台、不写脏数据', async () => {
  const db = createDb(':memory:');
  insertQoj(db, '4071-20016');
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, url, tags, difficulty_source)
     VALUES ('codeforces', '1001A', 'A', NULL, NULL, '[]', 'sync')`,
  ).run();
  const base = qojRouter({ catalog: null, types: null, index: null });
  const fetchFn: typeof fetch = async (input, init) => {
    const u = String(input);
    if (u.includes('problemset.problems')) {
      return new Response(
        JSON.stringify({ status: 'OK', result: { problems: [{ contestId: 1001, index: 'A', name: 'A', rating: 1000, tags: ['math'] }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return base(input, init);
  };
  const { transport } = qojPageTransport(() => challengeResponse());
  const results = await backfillDifficulties(db, fetchFn, { qojTransport: transport });
  const qoj = results.find((r) => r.platform === 'qoj')!;
  const cf = results.find((r) => r.platform === 'codeforces')!;
  assert.equal(qoj.failed, 1);
  assert.equal(cf.filled, 1, '公开榜单不可用不得影响其他平台');
  const qojRow = db.prepare("SELECT difficulty FROM problems WHERE platform='qoj'").get() as any;
  assert.equal(qojRow.difficulty, null);
  const cfRow = db.prepare("SELECT difficulty FROM problems WHERE platform='codeforces'").get() as any;
  assert.equal(cfRow.difficulty, 1000);
  db.close();
});
