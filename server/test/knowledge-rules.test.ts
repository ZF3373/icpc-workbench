import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalTag,
  codeOfTag,
  expandTag,
  TAG_SYNONYM_GROUPS,
} from '../../shared/src/index.ts';
import { CURRICULUM } from '../src/templates/curriculum.ts';
import { loadTaxonomy, allPoints, isValidCode, nameOfCode, templateIdsOfCode } from '../src/knowledge/taxonomy.ts';
import { classifyTitle, loadRules } from '../src/knowledge/ruleEngine.ts';

test('taxonomy: code 全局唯一、非空且锚定 curriculum 10 大类', () => {
  const taxonomy = loadTaxonomy();
  assert.equal(taxonomy.categories.length, 10);
  const codes = allPoints().map((p) => p.code);
  // code 数量下界：粗粒度层落地时应只增不减；显式断言可避免标题里的数字随时间失真
  assert.ok(codes.length >= 134, `taxonomy code 数应 >= 134，实得 ${codes.length}`);
  assert.equal(new Set(codes).size, codes.length);
  // 每个 code 的命名空间前缀必须是所属大类 key
  for (const cat of taxonomy.categories) {
    for (const p of cat.points) {
      assert.ok(p.code.startsWith(`${cat.key}.`), `${p.code} 前缀与大类 ${cat.key} 不符`);
    }
  }
});

test('taxonomy: templateIds 全部存在于 curriculum（掌握度地图看课入口不失效）', () => {
  const templateIds = new Set(CURRICULUM.flatMap((c) => c.templates.map((t) => t.id)));
  for (const p of allPoints()) {
    for (const id of p.templateIds ?? []) {
      assert.ok(templateIds.has(id), `${p.code} 挂了不存在的模板 ${id}`);
    }
  }
  // 全部课程应基本一一对应（2026-10 tricks 补课后 130 讲）：挂课程的 code 数 = 模板总数
  const linked = allPoints().filter((p) => (p.templateIds ?? []).length > 0).length;
  assert.equal(linked, CURRICULUM.reduce((n, c) => n + c.templates.length, 0));
});

test('rules: 所有规则 code 必须存在于 taxonomy（加载即校验）', () => {
  const rules = loadRules();
  assert.ok(rules.length >= 80, `规则数 ${rules.length} 低于种子规模 80`);
  for (const r of rules) assert.ok(isValidCode(r.code));
});

test('rule engine: 中文高信号词命中正确 code', () => {
  const cases: Array<[string, string]> = [
    ['【模板】线段树 1', 'ds.segtree'],
    ['【模板】树状数组 1', 'ds.bit'],
    ['【模板】并查集', 'ds.dsu'],
    ['【模板】KMP', 'string.kmp'],
    ['【模板】AC 自动机', 'string.ac-automaton'],
    ['【模板】单调栈', 'ds.mono-stack'],
    ['【模板】二维凸包', 'geo.convex-hull'],
    ['【模板】2-SAT', 'graph.2sat'],
    ['【模板】重链剖分 / 树链剖分', 'tree.hld'],
    ['【模板】最小生成树', 'graph.kruskal'],
    ['【模板】快速幂', 'math.quick-pow'],
    ['【模板】线性筛素数', 'math.sieve'],
    ['[NOIP 2015 提高组] 跳石头 二分答案', 'basic.binary-answer'],
    ['【模板】舞蹈链（DLX）', 'search.dlx'],
    ['【模板】后缀自动机（SAM）', 'string.sam'],
  ];
  for (const [title, code] of cases) {
    const codes = classifyTitle(title).map((m) => m.code);
    assert.ok(codes.includes(code), `「${title}」应命中 ${code}，实际: ${codes.join(',') || '(无)'}`);
  }
});

test('rule engine: negative 规则消除误配（不多标、不错标）', () => {
  // 差分约束 ≠ 前缀和与差分
  assert.deepEqual(classifyTitle('【模板】差分约束').map((m) => m.code), ['graph.diff-constraint']);
  // 最小费用最大流 → 费用流，不再多标最大流
  assert.deepEqual(classifyTitle('【模板】最小费用最大流').map((m) => m.code), ['graph.mcmf']);
  // 可持久化线段树 → 主席树，不多标线段树
  assert.deepEqual(classifyTitle('【模板】可持久化线段树 2（静态区间第 k 小）').map((m) => m.code), ['ds.chairman-tree']);
  // 扩展 KMP → Z 函数，不多标 KMP
  assert.deepEqual(classifyTitle('【模板】扩展 KMP / exKMP（Z 函数）').map((m) => m.code), ['string.z-function']);
  // 单调队列优化 DP → DP 优化技巧，不多标单调队列数据结构
  const monoOpt = classifyTitle('单调队列优化DP 入门').map((m) => m.code);
  assert.ok(monoOpt.includes('dp.mono-queue-opt'));
  assert.ok(!monoOpt.includes('ds.mono-deque'));
  // CF 人名 Sam 不触发后缀自动机
  assert.deepEqual(classifyTitle('Sam and String').map((m) => m.code), []);
  // 二叉搜索树是数据结构不是「二分查找 / 搜索」（LeetCode 中文标题实测误配回归）
  assert.deepEqual(classifyTitle('前序遍历构造二叉搜索树').map((m) => m.code), []);
  assert.deepEqual(classifyTitle('Construct Binary Search Tree from Preorder Traversal').map((m) => m.code), []);
});

test('rule engine: 一题多知识点多命中 + 同 code 合并取最高置信度', () => {
  const hits = classifyTitle('【模板】单调队列 / 滑动窗口');
  const codes = hits.map((m) => m.code);
  assert.ok(codes.includes('ds.mono-deque') && codes.includes('basic.two-pointers'));
  // 置信度降序、method 可溯源
  assert.ok(hits[0].confidence >= hits[hits.length - 1].confidence);
  assert.match(hits[0].method, /^rule#r\d+$/);
  // 展示名可解析（消费端直接可用）
  assert.equal(nameOfCode('ds.segtree'), '线段树');
  assert.deepEqual(templateIdsOfCode('ds.segtree'), ['ds-segtree']);
});

test('rule engine: 无信息标题不硬贴知识点（留给 L2 / uncertain）', () => {
  assert.deepEqual(classifyTitle('A. Array'), []);
  assert.deepEqual(classifyTitle('B. 神奇的题'), []);
});

// ---------- 标签同义词体系不变量（shared/src/tags.ts 头部声明的 5 条） ----------
// 这些断言是改动同义词表时的护栏：历史上 'binary search' 曾被归并到「二分」，
// 而 taxonomy 里叫「二分查找」，导致同一知识点在掌握度地图里裂成两个点。

/**
 * 题单专用粗粒度分类：curriculum 不教、taxonomy 也没有 code，只服务于题单分组。
 * 清洗重构 Task 1 之后「模拟 / 构造 / 交互」都补上了 code（misc.simulation /
 * misc.construction / misc.interactive），本表白名单因此不再被命中 —— 保留它是为了
 * 万一将来再出现无 code 的粗粒度组时，护栏仍能区分「题单专用」与「死点」。
 */
const LIST_ONLY_COARSE = ['模拟', '构造', '交互'];

test('tags 不变量 1：带 code 的组名必须与 taxonomy 的 name 完全一致', () => {
  const nameByCode = new Map(allPoints().map((p) => [p.code, p.name]));
  for (const g of TAG_SYNONYM_GROUPS) {
    if (g.code === undefined) continue;
    assert.equal(
      nameByCode.get(g.code),
      g.name,
      `${g.code} 的组名「${g.name}」与 taxonomy 的「${nameByCode.get(g.code) ?? '(不存在)'}」不一致`,
    );
  }
});

test('tags 不变量 2+3：粗粒度组不遮蔽 taxonomy 名；组内自洽且 canonicalTag 幂等', () => {
  const taxNames = new Set(allPoints().map((p) => p.name));
  const seen = new Map<string, string>();
  for (const g of TAG_SYNONYM_GROUPS) {
    if (g.code === undefined) {
      assert.ok(!taxNames.has(g.name), `粗粒度组「${g.name}」与 taxonomy 重名，会遮蔽真实知识点`);
    }
    assert.ok(g.tags.includes(g.name), `组「${g.name}」的 tags 未包含自身 name`);
    for (const t of g.tags) {
      const prev = seen.get(t);
      assert.equal(prev, undefined, `tag「${t}」同时出现在「${prev}」与「${g.name}」两个组（后者会静默覆盖前者）`);
      seen.set(t, g.name);
    }
  }
  // canonicalTag 幂等：反复归并结果稳定
  for (const g of TAG_SYNONYM_GROUPS) {
    assert.equal(canonicalTag(g.name), g.name);
    assert.equal(canonicalTag(canonicalTag(g.name)), canonicalTag(g.name));
    for (const t of g.tags) {
      assert.equal(canonicalTag(canonicalTag(t)), canonicalTag(t), `canonicalTag 对「${t}」不幂等`);
    }
  }
});

test('tags 不变量 5：规范名必须可达（taxonomy 名或课程 tag），不得出现死点', () => {
  const taxNames = new Set(allPoints().map((p) => p.name));
  const courseTags = new Set(CURRICULUM.flatMap((c) => c.templates.flatMap((t) => t.tags)));
  for (const g of TAG_SYNONYM_GROUPS) {
    if (g.code !== undefined) {
      assert.ok(taxNames.has(g.name), `带 code 的组「${g.name}」不在 taxonomy 名集合里`);
      continue;
    }
    // 回归：'flows' / 'matrix' 曾各自成组（英文名，两边都不在），产生的知识点谁也挂不上
    assert.ok(
      courseTags.has(g.name) || LIST_ONLY_COARSE.includes(g.name),
      `粗粒度组「${g.name}」既不是课程 tag、也不在题单专用分类里 → 该组产生的知识点是死点`,
    );
  }
});

test('tags 回归：旧别名表的每条英文标签仍归并到「可被统计消费」的活目标', () => {
  const taxNames = new Set(allPoints().map((p) => p.name));
  const courseTags = new Set(CURRICULUM.flatMap((c) => c.templates.flatMap((t) => t.tags)));
  // 迁移前 shared/src/index.ts 的 TAG_ALIAS_TO_CANONICAL 全部键
  const legacyAliases = [
    'binary search', 'two pointers', 'dp', 'greedy', 'math', 'data structures', 'graphs', 'trees',
    'strings', 'sortings', 'number theory', 'combinatorics', 'bitmasks', 'dsu', 'shortest paths',
    'divide and conquer', 'probabilities', 'hashing', 'games', 'matrices', 'geometry', 'flows', 'fft',
    '2-sat', 'meet-in-the-middle', 'dfs and similar', 'graph matchings', 'dynamic programming',
    'hash table', 'depth-first search', 'graph', 'tree', 'string', 'bit manipulation', 'bitmask',
    'union find', 'shortest path', 'probability and statistics', 'game theory', 'matrix',
  ];
  for (const alias of legacyAliases) {
    const canonical = canonicalTag(alias);
    assert.notEqual(canonical, alias, `别名「${alias}」不再被归并（相对迁移前是回归）`);
    assert.ok(
      taxNames.has(canonical) || courseTags.has(canonical),
      `别名「${alias}」归并到「${canonical}」，但它既不是 taxonomy 名也不是课程 tag（死点）`,
    );
  }
});

test('tags：课程用短名（二分 / DFS / 网络流）时仍能通过同义组连上规范名', () => {
  // 掌握度地图「看课」入口按 expandTag 整组命中课程 tag，规范名与课程短名不一致也能连上
  const cases: Array<[string, string]> = [
    ['二分查找', '二分'],
    ['DFS 与回溯', 'DFS'],
    ['Dinic 最大流', '网络流'],
    ['矩阵快速幂', '矩阵'],
    ['字符串哈希', '哈希'],
    ['位运算技巧', '位运算'],
    ['期望 DP', '概率期望'],
    ['匈牙利算法', '二分图'],
  ];
  for (const [canonical, courseTag] of cases) {
    assert.ok(expandTag(canonical).includes(courseTag), `expandTag(「${canonical}」) 应包含课程短名「${courseTag}」`);
  }
  // 反向：课程短名也能展开到规范名（题目筛选双向可用）
  assert.ok(expandTag('二分').includes('二分查找'));
});

test('tags：暴力 / brute force 不归并进「搜索」通用桶，而是落在自己的点 basic.brute-force', () => {
  for (const t of ['暴力', '暴力枚举', 'brute force', 'brute-force']) {
    // 归并到专门的粗粒度点，而不是 search.general 通用桶（后者会撑大兜底、掩盖真实弱项）
    assert.equal(codeOfTag(t), 'basic.brute-force', `「${t}」应归入 basic.brute-force`);
    assert.notEqual(canonicalTag(t), '搜索', `「${t}」不应被归并到 search.general`);
    assert.equal(expandTag('搜索').includes(t), false);
  }
});
