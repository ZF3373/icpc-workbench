import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTY_BUCKETS,
  UNKNOWN_DIFFICULTY_BUCKET,
  atcoderThetaToRating,
  cfRatingTitle,
  compareDifficultyBuckets,
  difficultyBucketOf,
  difficultyFields,
  nativeDifficultyLabel,
  parseIcpcTier,
  parseNativeDifficulty,
  parseNowcoderScore,
  toCfRating,
} from '../../shared/src/difficulty.ts';

// ---------- 难度分档（唯一真源，issue 37） ----------

test('difficulty buckets: 分档连续无缝、升序、最高档无上限', () => {
  assert.ok(DIFFICULTY_BUCKETS.length > 0);
  const first = DIFFICULTY_BUCKETS[0]!;
  assert.equal(first.key, '<1200');
  assert.equal(first.min, null); // 最低档无下界（difficulty 恒非负）
  assert.equal(first.max, 1199);
  for (let i = 1; i < DIFFICULTY_BUCKETS.length; i += 1) {
    const prev = DIFFICULTY_BUCKETS[i - 1]!;
    const cur = DIFFICULTY_BUCKETS[i]!;
    assert.equal(cur.min, (prev.max ?? 0) + 1, `档位必须无缝衔接：${prev.key} → ${cur.key}`);
    assert.ok(cur.max === null || cur.max > cur.min!, `档位区间必须非空：${cur.key}`);
  }
  // 用户要求：`2200+` 拆成 `2200-2599` 与 `2600+`，前者紧接 1900-2199
  const keys = DIFFICULTY_BUCKETS.map((b) => b.key);
  assert.deepEqual(keys, ['<1200', '1200-1399', '1400-1599', '1600-1899', '1900-2199', '2200-2599', '2600+']);
  assert.equal(DIFFICULTY_BUCKETS[DIFFICULTY_BUCKETS.length - 1]!.max, null);
});

test('difficultyBucketOf: 边界值落在正确的档，未知不并入最低档', () => {
  const cases: Array<[number | null | undefined, string]> = [
    [0, '<1200'], [1199, '<1200'], [1200, '1200-1399'], [1399, '1200-1399'],
    [1400, '1400-1599'], [1599, '1400-1599'], [1600, '1600-1899'], [1899, '1600-1899'],
    [1900, '1900-2199'], [2199, '1900-2199'], [2200, '2200-2599'], [2599, '2200-2599'],
    [2600, '2600+'], [3500, '2600+'],
    [null, UNKNOWN_DIFFICULTY_BUCKET], [undefined, UNKNOWN_DIFFICULTY_BUCKET], [Number.NaN, UNKNOWN_DIFFICULTY_BUCKET],
  ];
  for (const [input, expected] of cases) {
    assert.equal(difficultyBucketOf(input), expected, `difficulty=${String(input)}`);
  }
});

test('compareDifficultyBuckets: 难度升序，未知恒排最后（图表现场顺序 bug）', () => {
  // 现场（issue 37）：柱状图横轴是 1400-1599 在 1200-1399 之前、1900-2199 在 1600-1899 之前
  const unordered = ['2600+', '1400-1599', '未知', '1200-1399', '2200-2599', '1900-2199', '1600-1899', '<1200'];
  assert.deepEqual([...unordered].sort(compareDifficultyBuckets), [
    '<1200', '1200-1399', '1400-1599', '1600-1899', '1900-2199', '2200-2599', '2600+', '未知',
  ]);
  // 未登记的档名不炸，按「未知」同级的最后处理，且比较稳定
  assert.equal(compareDifficultyBuckets('未知', '不存在的档'), 0);
  assert.ok(compareDifficultyBuckets('2600+', '未知') < 0);
});

test('difficulty: 洛谷 1-8 档映射为实测中位数，0 为未知', () => {
  // 证据：洛谷 type=CF 镜像题 × CF API rating 共 737 对（见 spec §2.2）
  const expected = [800, 1000, 1500, 1800, 2200, 2400, 2600, 3400];
  expected.forEach((rating, i) => {
    assert.equal(toCfRating('luogu', i + 1), rating);
  });
  assert.equal(toCfRating('luogu', 0), null); // 暂无评定（且 difficulty=0 在列表接口是"不筛选"）
  assert.equal(toCfRating('luogu', 9), null); // 越界档位不得当 8 用
  assert.equal(nativeDifficultyLabel('luogu', 5), '提高');
  assert.equal(nativeDifficultyLabel('luogu', 8), 'NOI/NOI+/CTS');
});

test('difficulty: 计蒜客 level1-8 与洛谷同档同名（i18n 字典实测）', () => {
  assert.equal(toCfRating('jisuanke', 'level1'), 800);
  assert.equal(toCfRating('jisuanke', 'level8'), 3400);
  assert.equal(nativeDifficultyLabel('jisuanke', 'level6'), '提高+');
  assert.equal(toCfRating('jisuanke', 'level9'), null); // 实测 level9 题量 0
  assert.equal(toCfRating('jisuanke', 'others'), null);
});

test('difficulty: AtCoder kenkoooo 难度按实测锚点分段线性，两端钳位', () => {
  assert.equal(atcoderThetaToRating(-386), 800);
  assert.equal(atcoderThetaToRating(-5000), 800); // 极简题钳到 CF 下限
  assert.equal(atcoderThetaToRating(3392), 3400);
  assert.equal(atcoderThetaToRating(9000), 3500); // 超出上限钳位
  // 锚点之间线性：451→1000 / 973→1500 的中点 712 → 约 1250
  assert.equal(atcoderThetaToRating(712), 1250);
  // 单调性
  const xs = [-1000, 0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4500];
  const ys = xs.map(atcoderThetaToRating);
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] >= ys[i - 1], `${xs[i]} 应不小于 ${xs[i - 1]}`);
});

test('difficulty: 牛客难度分同量纲直用并钳位，空值/0 为未知', () => {
  assert.equal(toCfRating('nowcoder', 1500), 1500);
  assert.equal(toCfRating('nowcoder', 200), 800); // 低于 CF 下限 → 钳到 800
  assert.equal(toCfRating('nowcoder', 3700), 3500);
  assert.equal(toCfRating('nowcoder', 0), null);
  assert.equal(toCfRating('nowcoder', ''), null);
  assert.equal(toCfRating('nowcoder', null), null);
});

test('difficulty: 力扣三档、代码源 1-10、CF 原值、QOJ 恒空', () => {
  assert.equal(toCfRating('leetcode', 'EASY'), 1000);
  assert.equal(toCfRating('leetcode', 'hard'), 2100);
  assert.equal(nativeDifficultyLabel('leetcode', 'MEDIUM'), '中等');
  assert.equal(toCfRating('daimayuan', 10), 2400);
  assert.equal(toCfRating('daimayuan', 0), null); // Hydro 未设定且无提交统计
  assert.equal(toCfRating('daimayuan', 11), null); // 越界档（>10）：未知就是未知，不钳到第 10 档
  assert.equal(toCfRating('codeforces', 1900), 1900);
  assert.equal(toCfRating('codeforces', undefined), null);
  assert.equal(toCfRating('qoj', 1234), null);
  assert.equal(parseNativeDifficulty('qoj', 1234).scale, 'none');
});

test('difficulty: difficultyFields 同时产出映射值与原生原文', () => {
  assert.deepEqual(difficultyFields('luogu', 4), {
    difficulty: 1800,
    nativeDifficulty: '4',
    difficultyScale: 'luogu-2026-06',
  });
  // 未知难度：只有标度，没有值（保持既有"缺 difficulty 键"的语义）
  assert.deepEqual(difficultyFields('atcoder', null), { difficultyScale: 'atcoder-kenkoooo-irt' });
  assert.equal('difficulty' in difficultyFields('atcoder', null), false);
});

test('difficulty: 牛客难度分原文校验（两个读取方共用的唯一规则）', () => {
  assert.equal(parseNowcoderScore('1500'), 1500);
  assert.equal(parseNowcoderScore(700), 700);
  assert.equal(parseNowcoderScore(' 1200 '), 1200);
  // 老题真实难度存在非整百分值（2026-09-27 逐题实测）：NC16640=1049、NC22014=623、
  // NC22158=726、NC24739=972。旧规则的「100 的倍数」把这些真值判成未知 → 已改为只做值域校验，
  // 防串列交给解析层的列结构校验（见 adapters/problemBank.ts 的 parseNcRowCells）。
  assert.equal(parseNowcoderScore('1049'), 1049);
  assert.equal(parseNowcoderScore('623'), 623);
  assert.equal(parseNowcoderScore('972'), 972);
  assert.equal(parseNowcoderScore('100'), null); // 低于域下界（通过数 100）
  assert.equal(parseNowcoderScore('5000'), null); // 越界
  assert.equal(parseNowcoderScore(''), null);
  assert.equal(parseNowcoderScore('abc'), null);
  assert.equal(parseNowcoderScore(null), null);
});

test('difficulty: ICPC/CCPC 公开榜单档位（QOJ 难度来源）解析与映射', () => {
  // 档位原文：`gold` 或带占比的 `gold:704/2535`（原生落库用后者，便于口径变化时重算）
  assert.equal(parseIcpcTier('gold'), 'gold');
  assert.equal(parseIcpcTier('BRONZE:120/2535'), 'bronze');
  assert.equal(parseIcpcTier('  silver '), 'silver');
  assert.equal(parseIcpcTier('platinum'), null); // 未知档位不猜
  assert.equal(parseIcpcTier(null), null);

  const gold = parseNativeDifficulty('qoj', 'gold:704/2535');
  assert.equal(gold.rating, 2600);
  assert.equal(gold.scale, 'icpc-tier');
  assert.equal(gold.native, 'gold:704/2535'); // 原生原文（含占比）如实保留
  assert.equal(gold.label, '金（难）');
  assert.deepEqual(difficultyFields('qoj', 'iron:2419/2535'), {
    difficulty: 1000,
    nativeDifficulty: 'iron:2419/2535',
    difficultyScale: 'icpc-tier',
  });
  // 没有公开榜单数据时保持「平台不提供难度」的既有语义
  assert.equal(parseNativeDifficulty('qoj', null).rating, null);
  assert.equal(parseNativeDifficulty('qoj', null).scale, 'none');
  assert.equal('difficulty' in difficultyFields('qoj', null), false);
});

test('difficulty: cfRatingTitle 边界', () => {
  assert.equal(cfRatingTitle(800).en, 'Newbie');
  assert.equal(cfRatingTitle(1200).en, 'Pupil');
  assert.equal(cfRatingTitle(1600).en, 'Expert');
  assert.equal(cfRatingTitle(1900).en, 'Candidate Master');
  assert.equal(cfRatingTitle(2400).en, 'Grandmaster');
  assert.equal(cfRatingTitle(3500).en, 'Legendary Grandmaster');
  assert.equal(cfRatingTitle(800).zh, '新手');
});
