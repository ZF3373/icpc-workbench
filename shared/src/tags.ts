/**
 * 标签同义词体系：平台标签 / 课程 tag / 常见别名 → 统一规范名（可选 → taxonomy code）。
 *
 * 设计不变量（由 server/test/knowledge-rules.test.ts 断言）：
 * 1. 带 code 的组，其 name 必须与 taxonomy.json 中该 code 的 name 完全一致 ——
 *    否则掌握度地图的 name → code 精确匹配会失配，同一知识点裂成两个点。
 *    历史缺陷：'binary search' 曾归并为「二分」，而体系里叫「二分查找」；
 *    9/18 条映射存在这类失配（数据结构 / DFS / 二分图 / 哈希 / 位运算 / 概率期望 / 博弈论 …）。
 * 2. 不带 code 的组只是标签桶展示，不参与知识点统计；其 name 不得与任何 taxonomy name 同名。
 *    本表当前没有这类组 —— 粗粒度层（数据结构 / 图论 / 树上算法 / 数学 / 模拟 / 构造 / 交互 …）
 *    在清洗重构 §2.1 里补了 taxonomy code，因为高频题源标签（数学 4757 题 / 模拟 3810 题 …）
 *    此前完全无法映射到任何知识点。
 * 3. canonicalTag 幂等：canonicalTag(canonicalTag(x)) === canonicalTag(x)。
 * 4. 每个组的 tags 必须包含自身 name；同一 tag 不得出现在两个组（防静默覆盖）。
 * 5. **带 code 的组**，其 name 必须落在 taxonomy 名集合内；**不带 code 的粗粒度组**，
 *    其 name 必须落在 curriculum.ts 的 tag 集合内（否则该组产生的知识点既不对应任何 code、
 *    也挂不上任何课程，成为永远没人用的「死点」）。
 *    例：'flows' 若自成一个无名组就是死点，必须并入「Dinic 最大流」组。
 */
export interface TagSynonymGroup {
  /** 规范名：带 code 时必须等于 taxonomy 的 name（短名，如「二分查找」） */
  name: string;
  /** taxonomy code；省略表示粗粒度归类（无对应知识点） */
  code?: string;
  /** 该组的全部同义写法 */
  tags: string[];
}

export const TAG_SYNONYM_GROUPS: TagSynonymGroup[] = [
  // ---------- 基础算法 ----------
  { name: '二分查找', code: 'basic.binary-search', tags: ['二分查找', '二分', '二分搜索', '折半查找', 'binary search', 'binary_search', 'binarysearch'] },
  { name: '双指针', code: 'basic.two-pointers', tags: ['双指针', 'two pointers', 'two pointer', 'two-pointers', '滑动窗口', 'sliding window', '尺取法'] },
  { name: '前缀和与差分', code: 'basic.prefix-sum', tags: ['前缀和与差分', '前缀和', '差分', '前缀和/差分', 'prefix sum', 'prefix sums', 'prefix-sum', 'difference array'] },
  { name: '离散化', code: 'basic.discretization', tags: ['离散化', '坐标压缩', 'discretization', 'coordinate compression'] },
  { name: '贪心', code: 'basic.greedy', tags: ['贪心', '贪心算法', '贪心构造', 'greedy', 'greedy algorithm'] },
  { name: '反悔贪心', code: 'basic.regret-greedy', tags: ['反悔贪心', '反悔堆', 'regret greedy'] },
  { name: '二分答案', code: 'basic.binary-answer', tags: ['二分答案', '二分判定', 'binary search on answer', 'answer binary search'] },
  { name: '倍增', code: 'basic.doubling', tags: ['倍增', '倍增法', 'doubling', 'binary lifting'] },
  { name: '分治', code: 'basic.divide-conquer', tags: ['分治', '分治法', 'divide and conquer', 'divide-and-conquer'] },

  // ---------- 搜索 ----------
  { name: 'DFS 与回溯', code: 'search.dfs-backtrack', tags: ['DFS 与回溯', 'DFS', 'dfs', '深度优先', '深度优先搜索', '深搜', '回溯', 'backtracking', 'dfs and similar', 'depth-first search'] },
  { name: 'BFS 最短路模型', code: 'search.bfs-grid', tags: ['BFS 最短路模型', 'BFS', 'bfs', '广度优先', '广度优先搜索', '广搜', 'breadth-first search', 'bfs and similar'] },
  { name: '连通块 Flood Fill', code: 'search.floodfill', tags: ['连通块 Flood Fill', '连通块', '连通性', '连通分量', 'flood fill', 'floodfill', '泛洪'] },
  { name: '记忆化搜索', code: 'search.memo', tags: ['记忆化搜索', '记忆化', 'memoization', 'memoized search'] },
  { name: '双向 BFS', code: 'search.bidirectional-bfs', tags: ['双向 BFS', '双向BFS', '双向搜索', '双向广搜', 'bidirectional bfs', 'bidirectional search'] },
  { name: 'A* 与 IDA*', code: 'search.astar', tags: ['A* 与 IDA*', 'A*', 'A-star', 'IDA*', '启发式搜索', '启发式', 'heuristic search'] },
  { name: '折半搜索', code: 'search.meet-in-middle', tags: ['折半搜索', '折半枚举', 'meet in the middle', 'meet-in-the-middle', 'meet-in-middle'] },
  { name: '模拟退火', code: 'search.annealing', tags: ['模拟退火', '随机化', '随机化搜索', '退火', 'simulated annealing', 'annealing'] },
  { name: '舞蹈链 DLX', code: 'search.dlx', tags: ['舞蹈链 DLX', '舞蹈链', '精确覆盖', 'DLX', 'dancing links', 'exact cover'] },
  // 粗粒度兜底：只收「搜索」语义本身。刻意不收「暴力 / 暴力枚举 / brute force」——
  // 它们与「搜索」是两种不同的解题策略，塞进 search.general 会把通用桶撑大、掩盖真实弱项；
  // 它们有自己的落点 basic.brute-force（见文件末尾粗粒度层）。
  // 同理不收 'enumeration' —— 枚举有专门的点 basic.enumeration，同一 tag 只能有一个归属组。
  { name: '搜索', code: 'search.general', tags: ['搜索', '搜索与枚举', 'search'] },

  // ---------- 数据结构 ----------
  { name: '并查集', code: 'ds.dsu', tags: ['并查集', 'union find', 'union-find', 'disjoint set', 'disjoint set union', 'dsu'] },
  { name: '带权 / 扩展域并查集', code: 'ds.weighted-dsu', tags: ['带权 / 扩展域并查集', '带权并查集', '扩展域并查集', '种类并查集'] },
  { name: '树状数组', code: 'ds.bit', tags: ['树状数组', 'fenwick', 'fenwick tree', 'binary indexed tree', 'BIT'] },
  { name: '线段树', code: 'ds.segtree', tags: ['线段树', '区间树', 'segment tree', 'segment trees', 'segtree'] },
  { name: '李超线段树', code: 'ds.li-chao', tags: ['李超线段树', '李超树', 'Li Chao tree', 'LiChao'] },
  { name: '笛卡尔树', code: 'ds.cartesian-tree', tags: ['笛卡尔树', 'cartesian tree'] },
  { name: 'ST 表', code: 'ds.sparse-table', tags: ['ST 表', 'ST表', 'st表', '稀疏表', 'RMQ', 'sparse table'] },
  { name: '单调栈', code: 'ds.mono-stack', tags: ['单调栈', 'monotonic stack', 'monotone stack'] },
  { name: '单调队列', code: 'ds.mono-deque', tags: ['单调队列', 'monotonic queue', 'monotonic deque'] },
  { name: '堆', code: 'ds.heap', tags: ['堆', '二叉堆', '优先队列', '对顶堆', 'heap', 'priority queue', 'priority_queue'] },
  { name: '摩尔投票与绝对众数', code: 'ds.majority-vote', tags: ['摩尔投票与绝对众数', '摩尔投票', '摩尔投票法', '绝对众数', 'majority vote', 'boyer-moore voting'] },
  { name: '主席树', code: 'ds.chairman-tree', tags: ['主席树', '可持久化', '可持久化线段树', 'chairman tree', 'persistent segment tree'] },
  { name: '平衡树', code: 'ds.fhq-treap', tags: ['平衡树', 'treap', 'splay', 'fhq treap', 'fhq-treap'] },
  { name: '分块', code: 'ds.sqrt-decomposition', tags: ['分块', '块状', 'sqrt decomposition', 'sqrt-decomposition'] },
  { name: '根号分治', code: 'ds.sqrt-split', tags: ['根号分治', '根号平衡', '阈值分治', 'sqrt trick'] },
  { name: '莫队', code: 'ds.mo-algorithm', tags: ['莫队', '带修莫队', '回滚莫队', "mo's algorithm", 'mo algorithm'] },
  { name: '线段树分治', code: 'ds.segtree-divide', tags: ['线段树分治', '时间线段树', 'offline dynamic connectivity'] },
  { name: 'K-D 树', code: 'ds.kd-tree', tags: ['K-D 树', 'KD树', 'KD 树', 'kd-tree', 'kdtree', 'kd tree'] },
  { name: '树套树', code: 'ds.tree-in-tree', tags: ['树套树', 'tree in tree', 'tree-in-tree'] },
  { name: '划分树', code: 'ds.partition-tree', tags: ['划分树', 'partition tree'] },

  // ---------- 树论 ----------
  { name: '树的直径', code: 'tree.diameter', tags: ['树的直径', '直径', 'tree diameter'] },
  { name: '树的重心', code: 'tree.centroid', tags: ['树的重心', '重心', 'tree centroid'] },
  { name: '最近公共祖先', code: 'tree.lca', tags: ['最近公共祖先', 'LCA', 'lca', 'lowest common ancestor'] },
  { name: 'DFS 序与子树统计', code: 'tree.dfs-order', tags: ['DFS 序与子树统计', 'DFS序', 'dfs序', '欧拉序', 'dfn序', 'dfs order', 'euler tour'] },
  { name: '树链剖分', code: 'tree.hld', tags: ['树链剖分', '重链剖分', '树剖', 'heavy-light decomposition', 'heavy light decomposition', 'hld'] },
  { name: '点分治', code: 'tree.centroid-decomp', tags: ['点分治', '树分治', 'centroid decomposition'] },
  { name: '树上启发式合并', code: 'tree.dsu-on-tree', tags: ['树上启发式合并', 'dsu on tree', '启发式合并'] },
  { name: '基环树', code: 'tree.pseudo', tags: ['基环树', '环套树', 'pseudo forest'] },
  { name: '虚树', code: 'tree.virtual', tags: ['虚树', 'virtual tree', 'auxiliary tree'] },
  { name: 'Link-Cut-Tree', code: 'tree.lct', tags: ['Link-Cut-Tree', 'LCT', 'lct', 'link cut tree', '动态树'] },
  { name: '仙人掌', code: 'tree.cactus', tags: ['仙人掌', '圆方树', 'cactus', 'block-cut tree'] },

  // ---------- 动态规划 ----------
  { name: '背包 DP', code: 'dp.knapsack', tags: ['背包 DP', '背包', '01背包', '完全背包', 'knapsack'] },
  { name: '最长上升子序列', code: 'dp.lis', tags: ['最长上升子序列', '最长递增子序列', '最长不下降子序列', 'LIS', 'longest increasing subsequence'] },
  { name: '区间 DP', code: 'dp.interval', tags: ['区间 DP', '区间DP', '区间动态规划', 'interval dp'] },
  { name: '树形 DP', code: 'dp.tree', tags: ['树形 DP', '树形DP', '树形动态规划', '树上DP', 'tree dp'] },
  { name: '状压 DP', code: 'dp.bitmask', tags: ['状压 DP', '状压DP', '状态压缩', '状态压缩DP', '子集DP', 'bitmask dp'] },
  { name: '高维前缀和（子集和变换）', code: 'dp.sos', tags: ['高维前缀和（子集和变换）', '高维前缀和', '子集和变换', 'SOS DP', 'SOS', 'sum over subsets'] },
  { name: '数位 DP', code: 'dp.digit', tags: ['数位 DP', '数位DP', '数位动态规划', 'digit dp'] },
  { name: '期望 DP', code: 'dp.probability', tags: ['期望 DP', '期望DP', '概率DP', '概率期望', '期望', '概率', 'probability', 'probabilities', 'probability and statistics'] },
  { name: '单调队列优化 DP', code: 'dp.mono-queue-opt', tags: ['单调队列优化 DP', '单调队列优化', '单调队列优化DP'] },
  { name: '斜率优化', code: 'dp.slope-opt', tags: ['斜率优化', '斜率优化DP', '凸壳', '凸壳优化', 'convex hull trick'] },
  { name: 'WQS 二分', code: 'dp.wqs', tags: ['WQS 二分', 'WQS二分', 'wqs binary search', '带权二分', '凸优化'] },
  { name: '决策单调性优化 DP', code: 'dp.decision-mono', tags: ['决策单调性优化 DP', '决策单调性', '四边形不等式', 'divide and conquer optimization'] },
  { name: '最小斯坦纳树', code: 'dp.steiner', tags: ['最小斯坦纳树', '斯坦纳树', 'steiner tree', 'steiners tree'] },
  { name: '插头 DP', code: 'dp.plug', tags: ['插头 DP', '插头DP', '轮廓线', '轮廓线DP', 'connected component dp'] },
  { name: '动态规划', code: 'dp.general', tags: ['动态规划', '线性DP', '递推', 'DP', 'dp', 'dynamic programming'] },

  // ---------- 图论 ----------
  { name: '堆优化 Dijkstra', code: 'graph.dijkstra', tags: ['堆优化 Dijkstra', 'dijkstra', '迪杰斯特拉', '单源最短路'] },
  { name: 'SPFA', code: 'graph.spfa', tags: ['SPFA', 'spfa', '负环', '判负环', 'bellman-ford', 'Bellman-Ford'] },
  { name: 'Kruskal 最小生成树', code: 'graph.kruskal', tags: ['Kruskal 最小生成树', '最小生成树', '生成树', 'kruskal', 'MST', 'minimum spanning tree'] },
  { name: '拓扑排序', code: 'graph.topo', tags: ['拓扑排序', '拓扑', 'toposort', 'topological sort', 'topological sorting', 'DAG', '有向无环图'] },
  { name: '匈牙利算法', code: 'graph.hungarian', tags: ['匈牙利算法', '匈牙利', '二分图', '二分图匹配', '二分图最大匹配', '匹配', '二部图', 'bipartite matching', 'graph matchings'] },
  { name: 'Floyd', code: 'graph.floyd', tags: ['Floyd', 'floyd', '弗洛伊德', '多源最短路', 'floyd-warshall', '传递闭包'] },
  { name: '欧拉路', code: 'graph.euler', tags: ['欧拉路', '欧拉回路', '欧拉路径', 'eulerian', 'euler path'] },
  { name: '差分约束', code: 'graph.diff-constraint', tags: ['差分约束', 'difference constraint', 'difference constraints'] },
  { name: 'Tarjan 缩点', code: 'graph.tarjan-scc', tags: ['Tarjan 缩点', '强连通', '强连通分量', '缩点', 'tarjan', 'SCC', 'scc', 'kosaraju'] },
  { name: '割点与桥', code: 'graph.cut', tags: ['割点与桥', '割点', '割顶', '桥', '双连通', '点双', '边双', 'articulation point', 'bridge'] },
  { name: '2-SAT', code: 'graph.2sat', tags: ['2-SAT', '2-sat', '2SAT', 'two-sat'] },
  { name: 'Dinic 最大流', code: 'graph.dinic', tags: ['Dinic 最大流', '网络流', '最大流', 'flows', 'flow', 'dinic', 'max flow', 'maximum flow'] },
  { name: '最小费用最大流', code: 'graph.mcmf', tags: ['最小费用最大流', '费用流', '最小费用', '最小费用流', 'mcmf', 'min cost max flow', 'cost flow'] },
  { name: '严格次小生成树', code: 'graph.second-mst', tags: ['严格次小生成树', '次小生成树', 'second minimum spanning tree'] },
  { name: 'Boruvka', code: 'graph.boruvka', tags: ['Boruvka', 'boruvka', '博鲁夫卡'] },
  { name: 'k 短路', code: 'graph.kth-path', tags: ['k 短路', 'k短路', '第k短路', 'kth shortest path'] },
  { name: '生成树计数', code: 'graph.matrix-tree', tags: ['生成树计数', '矩阵树', 'matrix tree', 'matrix-tree theorem', '基尔霍夫定理'] },
  { name: '朱刘算法', code: 'graph.chu-liu', tags: ['朱刘算法', '最小树形图', 'chu-liu', 'chu liu'] },
  { name: '平面图判定与对偶图', code: 'graph.planar', tags: ['平面图判定与对偶图', '平面图', '对偶图', 'planar graph'] },
  { name: '区间图与弦图', code: 'graph.chordal', tags: ['区间图与弦图', '弦图', '区间图', '完美消元', 'chordal graph'] },
  { name: '最短路', code: 'graph.shortest-path', tags: ['最短路', '最短路问题', 'shortest path', 'shortest paths'] },
  { name: '分层图与拆点建模', code: 'graph.layered', tags: ['分层图与拆点建模', '分层图', '分层图最短路', '拆点', '拆点建图'] },

  // ---------- 数学 ----------
  { name: '快速幂', code: 'math.quick-pow', tags: ['快速幂', '快速幂取模', '龟速乘', '取模', 'fast pow', 'fast power', 'binary exponentiation'] },
  { name: '线性筛', code: 'math.sieve', tags: ['线性筛', '筛法', '素数筛', '埃氏筛', '欧拉筛', '欧拉函数', 'sieve', 'prime sieve'] },
  { name: 'exgcd 与逆元', code: 'math.exgcd', tags: ['exgcd 与逆元', 'exgcd', '扩展欧几里得', '逆元', '同余方程', 'modular inverse', 'extended euclidean'] },
  { name: '组合数预处理', code: 'math.comb', tags: ['组合数预处理', '组合数', '组合数取模', '排列组合', '二项式', '卡特兰数', 'Catalan', '阶乘与逆元'] },
  { name: '二项式反演', code: 'math.binomial-inversion', tags: ['二项式反演', 'binomial inversion', '恰好与至少', '至少转恰好'] },
  { name: '矩阵快速幂', code: 'math.matrix-pow', tags: ['矩阵快速幂', '矩阵', '矩阵加速', '矩阵乘法', 'matrix exponentiation', 'matrix', 'matrices'] },
  { name: '博弈论基础', code: 'math.game-theory', tags: ['博弈论基础', '博弈论', '博弈', 'SG函数', 'Nim游戏', 'nim', 'game theory', 'games'] },
  { name: '欧拉定理与降幂', code: 'math.euler-theorem', tags: ['欧拉定理与降幂', '欧拉定理', '扩展欧拉', '欧拉降幂', '降幂'] },
  { name: '卢卡斯定理', code: 'math.lucas', tags: ['卢卡斯定理', '卢卡斯', 'lucas', 'lucas theorem'] },
  { name: '中国剩余定理', code: 'math.crt', tags: ['中国剩余定理', '剩余定理', '扩展中国剩余定理', 'CRT', 'crt', 'excrt'] },
  { name: '高斯消元', code: 'math.gauss', tags: ['高斯消元', '高斯约旦消元', '行列式', '线性代数', '线性方程组', '矩阵求逆', 'gaussian elimination'] },
  { name: '线性基', code: 'math.linear-basis', tags: ['线性基', '异或线性基', 'linear basis'] },
  { name: '拉格朗日插值', code: 'math.lagrange', tags: ['拉格朗日插值', '拉格朗日', '插值', 'lagrange', 'lagrange interpolation'] },
  { name: 'LGV 引理', code: 'math.lgv', tags: ['LGV 引理', 'LGV', '不交路径计数', 'lindstrom gessel viennot'] },
  { name: '莫比乌斯反演', code: 'math.mobius', tags: ['莫比乌斯反演', '莫比乌斯', '莫反', 'mobius', 'mobius inversion'] },
  { name: 'FFT / NTT', code: 'math.fft', tags: ['FFT / NTT', 'FFT', 'NTT', '快速傅里叶', '快速傅里叶变换', '多项式', '卷积', 'fft', 'ntt'] },
  { name: 'BSGS', code: 'math.bsgs', tags: ['BSGS', '大步小步', '离散对数', 'baby-step giant-step'] },
  { name: 'Pólya 定理与置换群', code: 'math.polya', tags: ['Pólya 定理与置换群', 'polya', '波利亚', '置换群', 'burnside'] },
  { name: '自适应辛普森积分', code: 'math.simpson', tags: ['自适应辛普森积分', '辛普森', '数值积分', 'simpson'] },
  { name: '单纯形', code: 'math.simplex', tags: ['单纯形', '单纯形法', '线性规划', 'simplex'] },
  { name: '数论', code: 'math.number-theory', tags: ['数论', '数论分块', '数论基础', '素数', '质数', '最大公约数', '同余', 'number theory', 'gcd', 'GCD'] },
  { name: '组合计数', code: 'math.combinatorics', tags: ['组合计数', '计数问题', '组合问题', 'combinatorics'] },

  // ---------- 字符串 ----------
  { name: 'KMP', code: 'string.kmp', tags: ['KMP', 'kmp', '前缀函数', 'next数组'] },
  { name: '字符串哈希', code: 'string.hash', tags: ['字符串哈希', '哈希', '双哈希', 'hashing', 'hash', 'hash table'] },
  { name: 'Trie', code: 'string.trie', tags: ['Trie', 'trie', '字典树', '前缀树', 'trie树'] },
  { name: 'Manacher', code: 'string.manacher', tags: ['Manacher', 'manacher', '回文', '最长回文', '马拉车'] },
  { name: 'Z 函数', code: 'string.z-function', tags: ['Z 函数', 'Z函数', 'z-function', '扩展KMP', 'exKMP', 'extended kmp', 'z algorithm'] },
  { name: 'AC 自动机', code: 'string.ac-automaton', tags: ['AC 自动机', 'AC自动机', '自动机', 'ac automaton', 'aho-corasick'] },
  { name: '后缀数组', code: 'string.suffix-array', tags: ['后缀数组', '后缀排序', 'suffix array', 'SA'] },
  { name: '后缀自动机', code: 'string.sam', tags: ['后缀自动机', 'SAM', 'sam', 'suffix automaton', 'suffix automata'] },
  { name: '最小表示法', code: 'string.minimal-rotation', tags: ['最小表示法', '最小表示', 'minimal rotation'] },
  { name: '01-Trie', code: 'string.01trie', tags: ['01-Trie', '01Trie', '01trie', '01字典树', '01 trie'] },
  { name: '回文自动机', code: 'string.pam', tags: ['回文自动机', '回文树', 'PAM', 'eertree'] },
  { name: '字符串', code: 'string.general', tags: ['字符串', '字符串处理', '字符串模拟', 'string', 'strings'] },

  // ---------- 计算几何 ----------
  { name: '点积 / 叉积与方向判定', code: 'geo.cross', tags: ['点积 / 叉积与方向判定', '叉积', '点积', '向量', '向量运算', 'cross product', 'dot product'] },
  { name: '曼哈顿与切比雪夫距离互转', code: 'geo.manhattan-chebyshev', tags: ['曼哈顿与切比雪夫距离互转', '曼哈顿距离', '切比雪夫距离', '坐标变换', 'manhattan distance', 'chebyshev distance'] },
  { name: '凸包', code: 'geo.convex-hull', tags: ['凸包', '二维凸包', 'convex hull'] },
  { name: '点在多边形内', code: 'geo.point-in-polygon', tags: ['点在多边形内', '射线法', 'point in polygon'] },
  { name: '旋转卡壳', code: 'geo.rotating-calipers', tags: ['旋转卡壳', '最远点对', 'rotating calipers'] },
  { name: 'Pick 定理与格点计数', code: 'geo.pick', tags: ['Pick 定理与格点计数', 'Pick定理', '格点', '格点计数', 'pick'] },
  { name: '扫描线', code: 'geo.scanline', tags: ['扫描线', '矩形面积并', 'scanline', 'sweep line'] },
  { name: '半平面交', code: 'geo.half-plane', tags: ['半平面交', 'half plane intersection', 'half-plane'] },
  { name: '计算几何', code: 'geo.general', tags: ['计算几何', '几何', 'geometry', 'computational geometry'] },

  // ---------- STL 与杂项 ----------
  { name: 'STL 容器速用', code: 'misc.stl', tags: ['STL 容器速用', 'STL', 'stl', '标准库', '容器'] },
  { name: '位运算技巧', code: 'misc.bitwise', tags: ['位运算技巧', '位运算', '位操作', '位掩码', '异或', 'bitmask', 'bitmasks', 'bit manipulation', 'bitwise', 'xor'] },
  { name: '高精度', code: 'misc.bignum', tags: ['高精度', '高精度计算', '大整数', '大数运算', 'bignum', 'bigint'] },
  { name: 'bitset 压位优化', code: 'misc.bitset', tags: ['bitset 压位优化', 'bitset', '压位'] },
  { name: '置换与置换环', code: 'misc.permutation', tags: ['置换与置换环', '置换环', '置换', 'permutation cycle'] },
  { name: 'CDQ 分治与整体二分', code: 'misc.cdq-whole', tags: ['CDQ 分治与整体二分', 'CDQ', 'cdq', 'CDQ分治', '整体二分'] },
  { name: '打表与卡常', code: 'misc.table-cast', tags: ['打表与卡常', '打表', '卡常', '常数优化'] },
  { name: '排序', code: 'misc.sorting', tags: ['排序', '排序算法', '归并排序', '基数排序', '快速排序', '堆排序', '逆序对', 'sort', 'sorting', 'sortings'] },

  // ---------- 入门基础 + 2026-10 对照 XCPC 思维导图补位 ----------
  // 组名逐字等于 taxonomy 的 name（不变量 1）；已属于既有组的 tag 一律不重复收（不变量 4），
  // 例如「排序」「模拟」「栈」「枚举」「暴力」「计数」仍归各自的粗粒度组，这里只收新的写法。
  { name: '数组下标与循环枚举', code: 'intro.array-loop', tags: ['数组下标与循环枚举', '数组', '一维数组', '二维数组'] },
  { name: '数据范围与复杂度分析', code: 'intro.complexity', tags: ['数据范围与复杂度分析', '复杂度', '时间复杂度', '空间复杂度', '复杂度分析'] },
  { name: '简单排序与结构体自定义比较', code: 'intro.sort-basic', tags: ['简单排序与结构体自定义比较', '简单排序', '冒泡排序', '选择排序', '插入排序', 'cmp'] },
  { name: '高效排序与逆序对', code: 'intro.sort-advanced', tags: ['高效排序与逆序对', '高效排序', '快排', '归并', 'nth_element', 'partial_sort'] },
  { name: '模拟与实现', code: 'intro.simulation', tags: ['模拟与实现', '大模拟', '按题意模拟'] },
  { name: '字符串基础处理', code: 'intro.string-basic', tags: ['字符串基础处理', '字符串基础', '简单字符串', 'getline'] },
  { name: '递归与递推', code: 'intro.recurrence', tags: ['递归与递推', '递归', '递推式', '记忆化递归'] },
  { name: '栈与队列', code: 'intro.stack-queue', tags: ['栈与队列', '队列', 'queues', 'queue', '表达式求值', '括号匹配', '后缀表达式'] },
  { name: '数组模拟链表', code: 'intro.linked-list', tags: ['数组模拟链表', '链表', 'linked list', 'linked lists', '双向链表', '约瑟夫环'] },
  { name: '枚举与剪枝', code: 'intro.brute-force', tags: ['枚举与剪枝', '剪枝', '枚举子集', '子集枚举', 'next_permutation'] },
  { name: '对拍与随机造数据', code: 'intro.duipai', tags: ['对拍与随机造数据', '对拍', '随机造数据', '数据生成器'] },
  { name: '三分法', code: 'basic.ternary-search', tags: ['三分法', '三分', 'ternary search'] },
  { name: '线段树合并', code: 'ds.segtree-merge', tags: ['线段树合并', '动态开点线段树'] },
  { name: '可持久化并查集', code: 'ds.persistent-dsu', tags: ['可持久化并查集', '持久化并查集'] },
  { name: '计数 DP', code: 'dp.counting', tags: ['计数 DP', '计数dp', 'counting dp', '方案数'] },
  { name: '图上 DP', code: 'dp.on-graph', tags: ['图上 DP', '图上dp', 'DAG 上 DP', '拓扑序 DP'] },
  { name: '动态 DP', code: 'dp.dynamic', tags: ['动态 DP', '动态dp', 'DDP'] },
  { name: '树的哈希', code: 'tree.hash', tags: ['树的哈希', '树哈希', 'tree hash', '同构判定'] },
  { name: '长链剖分', code: 'tree.long-chain', tags: ['长链剖分', 'long chain decomposition'] },
  { name: 'KM 算法', code: 'graph.km', tags: ['KM 算法', 'KM', '最大权匹配', '带权匹配', 'Kuhn-Munkres'] },
  { name: '一般图最大匹配', code: 'graph.blossom', tags: ['一般图最大匹配', '一般图匹配', '带花树', 'blossom'] },
  { name: '上下界网络流', code: 'graph.flow-bounds', tags: ['上下界网络流', '上下界', '有源汇上下界', '可行流'] },
  { name: '全局最小割与最小割树', code: 'graph.global-mincut', tags: ['全局最小割与最小割树', '全局最小割', '最小割树', 'Stoer-Wagner', 'Gomory-Hu'] },
  { name: '支配树', code: 'graph.dominator', tags: ['支配树', '必经点', 'dominator tree', 'Lengauer-Tarjan'] },
  { name: 'Miller-Rabin 与 Pollard-Rho', code: 'math.miller-rabin', tags: ['Miller-Rabin 与 Pollard-Rho', 'Miller-Rabin', 'miller rabin', 'Pollard-Rho', 'pollard rho', '素性测试'] },
  { name: '容斥原理与 min-max 容斥', code: 'math.inc-exc', tags: ['容斥原理与 min-max 容斥', '容斥原理', '容斥', 'min-max容斥', 'min-max 容斥', 'inclusion-exclusion'] },
  { name: '卡特兰数、错排、斯特林数与拆分数', code: 'math.sequences', tags: ['卡特兰数、错排、斯特林数与拆分数', '常见数列', '错排', '斯特林数', '拆分数', 'Stirling'] },
  { name: 'Prüfer 序列', code: 'math.prufer', tags: ['Prüfer 序列', 'prufer', 'Prufer 序列', 'Cayley'] },
  { name: '原根与指数', code: 'math.primitive-root', tags: ['原根与指数', '原根', 'primitive root'] },
  { name: 'BM 算法与常系数线性递推', code: 'math.berlekamp-massey', tags: ['BM 算法与常系数线性递推', 'Berlekamp-Massey', 'berlekamp massey', '常系数线性递推', '线性递推'] },
  { name: '杜教筛与 min_25 筛', code: 'math.sieve-advanced', tags: ['杜教筛与 min_25 筛', '杜教筛', 'min_25', 'min25', 'min_25 筛'] },
  { name: 'Lyndon 分解', code: 'string.lyndon', tags: ['Lyndon 分解', 'Lyndon', 'Duval'] },
  { name: '圆与直线/圆的交点、切线与面积交并', code: 'geo.circle', tags: ['圆与直线/圆的交点、切线与面积交并', '圆相关', '圆的交点', '圆的切线', '圆面积交并'] },
  { name: '最小圆覆盖', code: 'geo.min-circle', tags: ['最小圆覆盖', '最小覆盖圆', 'Welzl'] },

  // ---------- 2026-10 第二轮对照补位（A/B 档 17 讲） ----------
  // 「多重背包」「分组背包」从「背包 DP」组、「FWT」从「FFT / NTT」组迁到这里：
  // 同一 tag 只能有一个归属组（不变量 4），而这两类题现在有了自己的课程位。
  { name: 'DP 状态设计与转移', code: 'dp.state-design', tags: ['DP 状态设计与转移', '状态设计', '状态表示', '转移方程'] },
  { name: '多重背包与分组 / 混合背包', code: 'dp.knapsack-variants', tags: ['多重背包与分组 / 混合背包', '多重背包', '分组背包', '混合背包', '多维背包', '依赖背包', '二进制优化'] },
  { name: '换根 DP', code: 'dp.tree-reroot', tags: ['换根 DP', '换根dp', '换根', 'reroot dp'] },
  { name: '单调栈优化 DP', code: 'dp.mono-stack-opt', tags: ['单调栈优化 DP', '单调栈优化', '单调栈优化dp'] },
  { name: '数据结构优化 DP', code: 'dp.ds-opt', tags: ['数据结构优化 DP', '数据结构优化', '数据结构优化dp'] },
  { name: '填坑 DP', code: 'dp.fill-board', tags: ['填坑 DP', '填坑dp', '填坑'] },
  { name: 'dp 套 dp', code: 'dp.nested', tags: ['dp 套 dp', 'dp套dp'] },
  { name: '二维树状数组', code: 'ds.bit-2d', tags: ['二维树状数组', '多维树状数组', '2D BIT', '二维 BIT'] },
  { name: '可持久化平衡树', code: 'ds.persistent-balanced', tags: ['可持久化平衡树', '持久化平衡树', '可持久化 treap'] },
  { name: '析合树', code: 'ds.xihe-tree', tags: ['析合树', '析合'] },
  { name: '最短路径树与最短路计数', code: 'graph.shortest-path-tree', tags: ['最短路径树与最短路计数', '最短路径树', '最短路计数'] },
  { name: '竞赛图', code: 'graph.tournament', tags: ['竞赛图', 'tournament graph', 'Landau'] },
  { name: '边分治', code: 'tree.edge-divide', tags: ['边分治', 'edge divide and conquer'] },
  { name: '类欧几里得', code: 'math.floor-sum', tags: ['类欧几里得', '类欧', 'floor sum', 'floor_sum'] },
  { name: '生成函数', code: 'math.ogf', tags: ['生成函数', 'OGF', 'EGF', '母函数'] },
  { name: 'FWT 与 FMT', code: 'math.fwt', tags: ['FWT 与 FMT', 'FWT', 'FMT', '快速沃尔什变换', '快速莫比乌斯变换', '集合幂级数'] },
  { name: '点定位与 Voronoi 图', code: 'geo.point-location', tags: ['点定位与 Voronoi 图', '点定位', 'Voronoi', '沃罗诺伊', 'Delaunay', '梯形图'] },

  // ---------- 粗粒度层（为高频但无法细分的题源标签提供落点，见清洗重构 spec §2.1） ----------
  // 这批组带 code：组名必须逐字等于 taxonomy 的 name（不变量 1），否则掌握度地图会裂成两个点。
  // 原先无 code 的 7 个粗粒度组（数据结构 / 图论 / 树上算法 / 数学 / 模拟 / 构造 / 交互）
  // 是**就地升级**为带 code —— 同一 tag 只能有一个归属组（不变量 4），
  // 另起一组同名同标签的组只会静默覆盖，codeOfTag 结果取决于数组顺序。
  // 组名取 taxonomy 长名（「数学（综合）」），故 canonicalTag('数学') 由「数学」变为「数学（综合）」——
  // 这正是「粗粒度概念 = 一个真实知识点」的口径，消费方（题单分类目录）同步使用该长名。
  { name: '数据结构（综合）', code: 'ds.general', tags: ['数据结构（综合）', '数据结构', 'data structures', 'data structure'] },
  { name: '图论（综合）', code: 'graph.general', tags: ['图论（综合）', '图论', '图论基础', '图上问题', '图的遍历', 'graph', 'graphs'] },
  { name: '树上算法（综合）', code: 'tree.general', tags: ['树上算法（综合）', '树上算法', '树论', '树形结构', '树上问题', 'tree', 'trees'] },
  { name: '数学（综合）', code: 'math.general', tags: ['数学（综合）', '数学', '数学题', '数论与组合数学', 'mathematics', 'math', 'maths'] },
  { name: '模拟', code: 'misc.simulation', tags: ['模拟', '模拟题', 'simulation', 'implement', 'implementation'] },
  { name: '构造', code: 'misc.construction', tags: ['构造', '构造题', '构造算法', 'constructive', 'constructive algorithms', 'construction'] },
  { name: '交互', code: 'misc.interactive', tags: ['交互', '交互题', 'interactive', 'interactive problem'] },
  { name: '暴力枚举', code: 'basic.brute-force', tags: ['暴力枚举', '暴力', 'brute force', 'brute-force', 'bruteforce'] },
  { name: '数组与实现', code: 'misc.array', tags: ['数组与实现', 'array', 'arrays'] },
  { name: '计数', code: 'misc.counting', tags: ['计数', 'counting', 'count'] },
  { name: '栈', code: 'misc.stack', tags: ['栈', 'stack', 'stacks'] },
  { name: '枚举', code: 'basic.enumeration', tags: ['枚举', 'enumeration', 'enumerate'] },
];

const GROUP_BY_NAME = new Map(TAG_SYNONYM_GROUPS.map((g) => [g.name, g]));

const NAME_BY_TAG = new Map<string, string>();
for (const group of TAG_SYNONYM_GROUPS) {
  for (const tag of group.tags) NAME_BY_TAG.set(tag, group.name);
}

/** tag → 规范名（兼容旧调用方：Record 形态） */
export const TAG_ALIAS_TO_CANONICAL: Record<string, string> = Object.fromEntries(NAME_BY_TAG);

/** 标签的规范名：命中同义词组则归并为组名，否则原样返回（幂等） */
export function canonicalTag(tag: string): string {
  return NAME_BY_TAG.get(tag) ?? tag;
}

/**
 * 标签的同义集合（含自身）：用于题目筛选「中文 tag 命中英文标签的题」及反向。
 * 例：expandTag('二分') → ['二分', '二分查找', 'binary search', …]
 */
export function expandTag(tag: string): string[] {
  const canonical = canonicalTag(tag);
  const group = GROUP_BY_NAME.get(canonical);
  return group ? [...new Set([tag, ...group.tags])] : [tag];
}

/**
 * 标签 → taxonomy code（无对应知识点时返回 undefined）。
 * 供掌握度地图/推荐等需要 code 粒度的消费方使用，避免再用「名称精确匹配」这种脆弱手段。
 */
export function codeOfTag(tag: string): string | undefined {
  return GROUP_BY_NAME.get(canonicalTag(tag))?.code;
}

/** 组名 → taxonomy code（同名组不存在时返回 undefined；粗粒度层落地后所有组均带 code） */
export function codeOfCanonicalName(name: string): string | undefined {
  return GROUP_BY_NAME.get(name)?.code;
}

/**
 * 粗粒度归类名（无 code）。
 *
 * ⚠️ 当前恒返回 `[]`：粗粒度层落地后（见 knowledge-cleaning-redesign spec §2.1），
 * 原先 7 个无 code 的粗组已全部升级为带 code 的知识点，本函数的筛选条件不再命中。
 * 保留函数与导出的原因：`routes/lists.ts` 的分类目录仍把它与
 * `TAG_ALIAS_TO_CANONICAL` 取并集，删掉会改动那条调用链；且将来若重新引入
 * 无 code 的纯人类友好分类，这里会自动恢复生效。
 */
export function coarseCategoryNames(): string[] {
  return TAG_SYNONYM_GROUPS.filter((g) => g.code === undefined).map((g) => g.name);
}
