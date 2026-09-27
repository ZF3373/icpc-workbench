/**
 * ICPC/CCPC 公开榜单难度（QOJ 题集的难度来源）。
 *
 * fixture 取自 2026-09-27 实测的真实数据（网络抓取后裁剪，形状与字段名保持原样）：
 * - xcpcrating `problem-catalog.json`：`icpc/icpc2026/icpc2026preliminary-1:A` ↔ `qoj:20016`
 * - RankLand 赛场索引：`uk = icpc2026preliminary-1`（兄弟场 `-2` 词元完全相同，只能靠全等 uk 区分）
 * - RankLand 榜单 srk：`problems[].alias` + `statistics.accepted`，`rows` 行数 = 队伍总数
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import {
  matchRanklandBoard,
  parseRanklandIndex,
  parseRanklandSrk,
  parseXcpcCatalog,
  parseXcpcTags,
  qojProblemIdFromKey,
  ranklandTier,
} from '../src/analysis/icpcBoard.ts';
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
    if (u.includes('problem-types')) return json(TYPES);
    if (u.includes('/api/v2/public/contests')) {
      if (opts.index === null) return new Response('nope', { status: 503 });
      return json(opts.index ?? INDEX);
    }
    if (u.includes('/api/v2/public/files/')) return json({ data: { url: 'https://cdn.algoux.cn/rankland/file/F1/board.srk.json' } });
    if (u.includes('cdn.algoux.cn')) return json(opts.srk ?? SRK);
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
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

test('回填：QOJ 题不在赛事目录里 → 保持未知并如实说明（绝不臆造难度）', async () => {
  const db = createDb(':memory:');
  insertQoj(db, '2513-14301'); // 实测：该题号不在 xcpcrating 目录（2021–2026 审核子集）内
  const results = await backfillDifficulties(db, qojRouter());
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

test('回填：公开数据源全部不可用 → QOJ 记失败但不影响其他平台、不写脏数据', async () => {
  const db = createDb(':memory:');
  insertQoj(db, '4071-20016');
  db.prepare(
    `INSERT INTO problems (platform, problem_key, title, difficulty, url, tags, difficulty_source)
     VALUES ('codeforces', '1001A', 'A', NULL, NULL, '[]', 'sync')`,
  ).run();
  const base = qojRouter({ catalog: null, index: null });
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
  const results = await backfillDifficulties(db, fetchFn);
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
