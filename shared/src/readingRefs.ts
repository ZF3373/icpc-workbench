/**
 * 外部学习资源：cp-algorithms 延伸阅读索引（唯一真源）。
 *
 * 为什么是「分类级」而不是「一讲一文」：
 * 内置课程 181 讲与 cp-algorithms 163 篇并不是一一对应的。数据结构只有 10 篇，
 * 却覆盖了 26 讲（并查集 / 线段树 / 主席树 / 树套树 / 析合树…）；图论 47 篇又比
 * 课程的 30 讲还多。按 slug 自动配对会产生大量错配（实测「二分查找」被配到
 * Binary Exponentiation、「前缀和」被配到 Prefix function），所以这里手工按
 * 课程分类归位，宁可少给也不给错。
 *
 * 授权：站点内容为 CC BY-SA 4.0，只做**外链引用**，不镜像、不摘录、不入库，
 * 因此不产生任何署名/相同方式共享义务。若将来要离线镜像，必须先补署名与修改标注。
 *
 * 语言：站点为纯英文。中文讲解统一交给 AI 助手（见 buildArticleAskText），
 * 应用内不维护译文，避免跟随上游更新而腐坏。
 */

/** 站点元信息（关于页 / 模板库页脚 / AI 提示词共用一份） */
export interface ReadingSite {
  id: string
  name: string
  url: string
  /** 一句话定位（中文） */
  tagline: string
  /** 原文语言，提示用户这是英文站 */
  language: 'en'
  /** 内容授权（仅用于展示与合规提示，不代表我们分发其内容） */
  license: string
  /** 收录文章数（随上游变动，此处为 2026-11 快照） */
  articleCount: number
}

export const CP_ALGORITHMS: ReadingSite = {
  id: 'cp-algorithms',
  name: 'cp-algorithms',
  url: 'https://cp-algorithms.com/',
  tagline: '竞赛算法与数据结构的英文百科，每篇含完整证明、复杂度分析与可编译实现',
  language: 'en',
  license: 'CC BY-SA 4.0',
  articleCount: 163,
}

/** 一篇延伸阅读 */
export interface ReadingArticle {
  /** 中文标题（便于在中文界面里一眼找到，非官方译名） */
  title: string
  /** 原文标题（英文，与站点一致，便于站内搜索核对） */
  titleEn: string
  url: string
  /** 可选的一句话说明：这篇文章能补课程的哪个缺口 */
  note?: string
}

/** 课程分类 key → 该分类的延伸阅读 */
export type ReadingRefMap = Record<string, ReadingArticle[]>

const A = 'https://cp-algorithms.com/'

/**
 * 内置课程 11 个分类 → cp-algorithms 文章。
 *
 * 映射原则：
 * 1. 只收与该分类**核心内容**对得上的文章，边缘话题（如 Stern-Brocot 树、15 数码）
 *    归入「STL 与杂项」，不硬塞进数学/搜索；
 * 2. 一篇只出现一次（同一篇挂在最贴切的分类下），避免模板库重复展示；
 * 3. 课程里有、站点没有的（树剖、主席树、莫队、WQS…）**留空不凑数**。
 */
export const READING_REFS: ReadingRefMap = {
  // ---------- 入门基础 ----------
  intro: [
    { title: '动态规划入门', titleEn: 'Introduction to Dynamic Programming', url: A + 'dynamic_programming/intro-to-dp.html' },
    { title: '位运算技巧', titleEn: 'Bit manipulation', url: A + 'algebra/bit-manipulation.html' },
    { title: '格雷码', titleEn: 'Gray code', url: A + 'algebra/gray-code.html' },
    { title: '约瑟夫问题', titleEn: 'Josephus problem', url: A + 'others/josephus_problem.html' },
    { title: '龟兔赛跑（链表判环）', titleEn: 'Tortoise and Hare Algorithm', url: A + 'others/tortoise_and_hare.html' },
  ],

  // ---------- 基础算法 ----------
  basic: [
    { title: '二分查找', titleEn: 'Binary Search', url: A + 'num_methods/binary_search.html', note: '含「二分答案」的判定函数写法与边界处理' },
    { title: '三分法', titleEn: 'Ternary Search', url: A + 'num_methods/ternary_search.html' },
    { title: '前缀和 / 最大子段和', titleEn: 'Search the subsegment with the maximum/minimum sum', url: A + 'others/maximum_average_segment.html' },
    { title: '分治 DP', titleEn: 'Divide and Conquer DP', url: A + 'dynamic_programming/divide-and-conquer-dp.html' },
    { title: 'RMQ 问题', titleEn: 'RMQ task', url: A + 'sequences/rmq.html' },
    { title: '第 k 小（O(N)）', titleEn: 'K-th order statistic in O(N)', url: A + 'sequences/k-th.html' },
    { title: 'MEX 问题', titleEn: 'MEX task', url: A + 'sequences/mex.html' },
  ],

  // ---------- 搜索 ----------
  search: [
    { title: '深度优先搜索', titleEn: 'Depth First Search', url: A + 'graph/depth-first-search.html' },
    { title: '广度优先搜索', titleEn: 'Breadth First Search', url: A + 'graph/breadth-first-search.html' },
    { title: '0-1 BFS', titleEn: '0-1 BFS', url: A + 'graph/01_bfs.html', note: '边权只有 0/1 时的双端队列最短路' },
    { title: '模拟退火', titleEn: 'Simulated Annealing', url: A + 'num_methods/simulated_annealing.html' },
    { title: '牛顿迭代法', titleEn: "Newton's method for finding roots", url: A + 'num_methods/roots_newton.html' },
    { title: '辛普森积分', titleEn: "Integration by Simpson's formula", url: A + 'num_methods/simpson-integration.html' },
    { title: '任意图上的博弈', titleEn: 'Games on arbitrary graphs', url: A + 'game_theory/games_on_graphs.html', note: '博弈 + 记忆化搜索的胜负态判定' },
  ],

  // ---------- 数据结构 ----------
  ds: [
    { title: '并查集', titleEn: 'Disjoint Set Union', url: A + 'data_structures/disjoint_set_union.html', note: '含按秩合并、路径压缩与「删除元素」变体' },
    { title: '树状数组', titleEn: 'Fenwick Tree', url: A + 'data_structures/fenwick.html' },
    { title: '线段树', titleEn: 'Segment Tree', url: A + 'data_structures/segment_tree.html', note: '懒标记、区间修改与合并顺序的完整讨论' },
    { title: 'ST 表', titleEn: 'Sparse Table', url: A + 'data_structures/sparse-table.html' },
    { title: 'Treap（平衡树）', titleEn: 'Treap', url: A + 'data_structures/treap.html' },
    { title: '分块', titleEn: 'Sqrt Decomposition', url: A + 'data_structures/sqrt_decomposition.html' },
    { title: 'Sqrt Tree', titleEn: 'Sqrt Tree', url: A + 'data_structures/sqrt-tree.html', note: 'O(1) 区间查询的进阶结构' },
    { title: '随机化堆', titleEn: 'Randomized Heap', url: A + 'data_structures/randomized_heap.html' },
    { title: '最小栈 / 最小队列', titleEn: 'Minimum Stack / Minimum Queue', url: A + 'data_structures/stack_queue_modification.html', note: '单调栈 / 单调队列的理论背景' },
    { title: 'O(log n) 删除元素', titleEn: 'Deleting from a data structure in O(T(n) log n)', url: A + 'data_structures/deleting_in_log_n.html' },
  ],

  // ---------- 动态规划 ----------
  dp: [
    { title: '动态规划入门', titleEn: 'Introduction to Dynamic Programming', url: A + 'dynamic_programming/intro-to-dp.html' },
    { title: '背包问题', titleEn: 'Knapsack Problem', url: A + 'dynamic_programming/knapsack.html', note: '01 / 完全 / 多重背包的统一视角' },
    { title: '最长上升子序列', titleEn: 'Longest increasing subsequence', url: A + 'dynamic_programming/longest_increasing_subsequence.html', note: 'O(n log n) 贪心 + 二分解法与方案还原' },
    { title: '分治优化 DP', titleEn: 'Divide and Conquer DP', url: A + 'dynamic_programming/divide-and-conquer-dp.html' },
    { title: 'Knuth 优化', titleEn: "Knuth's Optimization", url: A + 'dynamic_programming/knuth-optimization.html', note: '四边形不等式的一类经典应用' },
    { title: '轮廓线 DP（插头 DP）', titleEn: 'Dynamic Programming on Broken Profile', url: A + 'dynamic_programming/profile-dynamics.html' },
    { title: '最大全零子矩阵', titleEn: 'Finding the largest zero submatrix', url: A + 'dynamic_programming/zero_matrix.html' },
    { title: '固定长度路径数 / 最短路', titleEn: 'Number of paths of fixed length', url: A + 'graph/fixed_length_paths.html', note: '矩阵快速幂加速的图上 DP' },
  ],

  // ---------- 图论 ----------
  graph: [
    { title: 'Dijkstra 最短路', titleEn: 'Dijkstra', url: A + 'graph/dijkstra.html' },
    { title: '稀疏图上的 Dijkstra', titleEn: 'Dijkstra on sparse graphs', url: A + 'graph/dijkstra_sparse.html' },
    { title: 'Bellman-Ford 与负权', titleEn: 'Bellman-Ford', url: A + 'graph/bellman_ford.html' },
    { title: 'Floyd-Warshall', titleEn: 'Floyd-Warshall', url: A + 'graph/all-pair-shortest-path-floyd-warshall.html' },
    { title: 'D´Esopo-Pape 算法', titleEn: "D´Esopo-Pape algorithm", url: A + 'graph/desopo_pape.html' },
    { title: 'Kruskal 最小生成树', titleEn: 'Minimum Spanning Tree - Kruskal', url: A + 'graph/mst_kruskal.html' },
    { title: 'Kruskal + 并查集', titleEn: 'MST - Kruskal with DSU', url: A + 'graph/mst_kruskal_with_dsu.html' },
    { title: 'Prim 最小生成树', titleEn: 'Minimum Spanning Tree - Prim', url: A + 'graph/mst_prim.html' },
    { title: '严格次小生成树', titleEn: 'Second best MST', url: A + 'graph/second_best_mst.html' },
    { title: '生成树计数（Matrix-Tree）', titleEn: 'Kirchhoff Theorem', url: A + 'graph/kirchhoff-theorem.html' },
    { title: 'Prüfer 序列', titleEn: 'Prüfer code', url: A + 'graph/pruefer_code.html' },
    { title: '拓扑排序', titleEn: 'Topological Sorting', url: A + 'graph/topological-sort.html' },
    { title: '判环与找环', titleEn: 'Finding a cycle', url: A + 'graph/finding-cycle.html' },
    { title: '判负环', titleEn: 'Finding a Negative Cycle', url: A + 'graph/finding-negative-cycle-in-graph.html' },
    { title: '欧拉路', titleEn: 'Eulerian Path', url: A + 'graph/euler_path.html' },
    { title: '连通分量', titleEn: 'Finding Connected Components', url: A + 'graph/search-for-connected-components.html' },
    { title: '割点', titleEn: 'Finding Articulation Points', url: A + 'graph/cutpoints.html' },
    { title: '桥', titleEn: 'Finding Bridges', url: A + 'graph/bridge-searching.html' },
    { title: '在线桥（动态连通性）', titleEn: 'Finding Bridges Online', url: A + 'graph/bridge-searching-online.html' },
    { title: '强连通分量与缩点', titleEn: 'Strongly Connected Components', url: A + 'graph/strongly-connected-components.html' },
    { title: '强定向', titleEn: 'Strong Orientation', url: A + 'graph/strong-orientation.html' },
    { title: '2-SAT', titleEn: '2-SAT', url: A + 'graph/2SAT.html' },
    { title: '二分图判定', titleEn: 'Bipartite Graph Check', url: A + 'graph/bipartite-check.html' },
    { title: '匈牙利算法（二分图匹配）', titleEn: "Kuhn's Algorithm", url: A + 'graph/kuhn_maximum_bipartite_matching.html' },
    { title: 'KM 算法（二分图最大权匹配）', titleEn: 'Hungarian Algorithm', url: A + 'graph/hungarian-algorithm.html' },
    { title: 'Edmonds-Karp 最大流', titleEn: 'Maximum flow - Edmonds-Karp', url: A + 'graph/edmonds_karp.html' },
    { title: 'Dinic 最大流', titleEn: 'Maximum flow - Dinic', url: A + 'graph/dinic.html' },
    { title: 'Push-relabel 最大流', titleEn: 'Maximum flow - Push-relabel', url: A + 'graph/push-relabel.html' },
    { title: 'Push-relabel 优化版', titleEn: 'Push-relabel improved', url: A + 'graph/push-relabel-faster.html' },
    { title: 'MPM 最大流', titleEn: 'Maximum flow - MPM', url: A + 'graph/mpm.html' },
    { title: '上下界网络流', titleEn: 'Flows with demands', url: A + 'graph/flow_with_demands.html' },
    { title: '最小费用最大流', titleEn: 'Minimum-cost flow', url: A + 'graph/min_cost_flow.html' },
    { title: '指派问题（费用流建模）', titleEn: 'Assignment problem', url: A + 'graph/Assignment-problem-min-flow.html' },
    { title: '全局最小割（Stoer-Wagner）', titleEn: 'Stoer-Wagner minimum cut', url: A + 'graph/stoer_wagner_mincut.html' },
    { title: '边连通度 / 点连通度', titleEn: 'Edge / Vertex connectivity', url: A + 'graph/edge_vertex_connectivity.html' },
    { title: '树的染色', titleEn: 'Tree painting', url: A + 'graph/tree_painting.html' },
    { title: 'LCA 最近公共祖先', titleEn: 'Lowest Common Ancestor', url: A + 'graph/lca.html' },
    { title: 'LCA（倍增）', titleEn: 'LCA - Binary Lifting', url: A + 'graph/lca_binary_lifting.html' },
    { title: 'LCA（Farach-Colton & Bender）', titleEn: 'LCA - Farach-Colton and Bender', url: A + 'graph/lca_farachcoltonbender.html' },
    { title: 'LCA（Tarjan 离线）', titleEn: "LCA - Tarjan's off-line", url: A + 'graph/lca_tarjan.html' },
    { title: '用 LCA 求 RMQ', titleEn: 'Solve RMQ by finding LCA', url: A + 'graph/rmq_linear.html' },
    { title: '树链剖分', titleEn: 'Heavy-light decomposition', url: A + 'graph/hld.html' },
    { title: '点分治', titleEn: 'Centroid decomposition', url: A + 'graph/centroid_decomposition.html' },
  ],

  // ---------- 树论 ----------
  tree: [
    { title: 'LCA 最近公共祖先', titleEn: 'Lowest Common Ancestor', url: A + 'graph/lca.html' },
    { title: 'LCA（倍增）', titleEn: 'LCA - Binary Lifting', url: A + 'graph/lca_binary_lifting.html' },
    { title: 'LCA（Tarjan 离线）', titleEn: "LCA - Tarjan's off-line", url: A + 'graph/lca_tarjan.html' },
    { title: '树链剖分', titleEn: 'Heavy-light decomposition', url: A + 'graph/hld.html', note: '重链剖分与「路径查询转区间查询」的完整推导' },
    { title: '点分治', titleEn: 'Centroid decomposition', url: A + 'graph/centroid_decomposition.html' },
    { title: 'Prüfer 序列', titleEn: 'Prüfer code', url: A + 'graph/pruefer_code.html', note: '树与序列的双射，用于带度数限制的计数' },
    { title: '生成树计数（Matrix-Tree）', titleEn: 'Kirchhoff Theorem', url: A + 'graph/kirchhoff-theorem.html' },
    { title: '严格次小生成树', titleEn: 'Second best MST', url: A + 'graph/second_best_mst.html' },
    { title: '树的染色', titleEn: 'Tree painting', url: A + 'graph/tree_painting.html' },
  ],

  // ---------- 数学 ----------
  math: [
    { title: '快速幂', titleEn: 'Binary Exponentiation', url: A + 'algebra/binary-exp.html', note: '含矩阵快速幂与「结合律」推广' },
    { title: '欧几里得算法（gcd）', titleEn: 'Euclidean algorithm', url: A + 'algebra/euclid-algorithm.html' },
    { title: '扩展欧几里得', titleEn: 'Extended Euclidean Algorithm', url: A + 'algebra/extended-euclid-algorithm.html' },
    { title: '线性丢番图方程', titleEn: 'Linear Diophantine Equations', url: A + 'algebra/linear-diophantine-equation.html' },
    { title: '斐波那契数列', titleEn: 'Fibonacci Numbers', url: A + 'algebra/fibonacci-numbers.html' },
    { title: '埃氏筛', titleEn: 'Sieve of Eratosthenes', url: A + 'algebra/sieve-of-eratosthenes.html' },
    { title: '线性筛', titleEn: 'Linear Sieve', url: A + 'algebra/prime-sieve-linear.html' },
    { title: '素性测试', titleEn: 'Primality tests', url: A + 'algebra/primality_tests.html', note: 'Miller-Rabin 的概率正确性证明' },
    { title: '整数分解', titleEn: 'Integer factorization', url: A + 'algebra/factorization.html', note: '含 Pollard-Rho' },
    { title: '欧拉函数', titleEn: "Euler's totient function", url: A + 'algebra/phi-function.html' },
    { title: '约数个数与约数和', titleEn: 'Number of divisors / sum of divisors', url: A + 'algebra/divisors.html' },
    { title: '逆元', titleEn: 'Modular Inverse', url: A + 'algebra/module-inverse.html' },
    { title: '线性同余方程', titleEn: 'Linear Congruence Equation', url: A + 'algebra/linear_congruence_equation.html' },
    { title: '中国剩余定理（CRT）', titleEn: 'Chinese Remainder Theorem', url: A + 'algebra/chinese-remainder-theorem.html' },
    { title: "Garner 算法（任意模数 CRT）", titleEn: "Garner's Algorithm", url: A + 'algebra/garners-algorithm.html' },
    { title: '阶乘取模', titleEn: 'Factorial modulo p', url: A + 'algebra/factorial-modulo.html' },
    { title: '阶乘的因子幂次', titleEn: 'Finding Power of Factorial Divisor', url: A + 'algebra/factorial-divisors.html' },
    { title: '离散对数（BSGS）', titleEn: 'Discrete Log', url: A + 'algebra/discrete-log.html' },
    { title: '原根', titleEn: 'Primitive Root', url: A + 'algebra/primitive-root.html' },
    { title: '离散平方根', titleEn: 'Discrete Root', url: A + 'algebra/discrete-root.html' },
    { title: 'Montgomery 乘法', titleEn: 'Montgomery Multiplication', url: A + 'algebra/montgomery_multiplication.html' },
    { title: '平衡三进制', titleEn: 'Balanced Ternary', url: A + 'algebra/balanced-ternary.html' },
    { title: '快速傅里叶变换（FFT）', titleEn: 'Fast Fourier transform', url: A + 'algebra/fft.html' },
    { title: '多项式与级数运算', titleEn: 'Operations on polynomials and series', url: A + 'algebra/polynomial.html', note: '求逆 / 开根 / 对数 / 指数 / 分治乘法' },
    { title: '连分数', titleEn: 'Continued fractions', url: A + 'algebra/continued-fractions.html' },
    { title: '幂的因式分解（Factoring Exponentiation）', titleEn: 'Factoring Exponentiation', url: A + 'algebra/factoring-exp.html' },
    { title: '高精度整数', titleEn: 'Arbitrary-Precision Arithmetic', url: A + 'algebra/big-integer.html' },
    { title: '枚举子集', titleEn: 'Enumerating submasks of a bitmask', url: A + 'algebra/all-submasks.html', note: '状压 DP 里 O(3^n) 枚举子集的原理' },
    { title: '二项式系数', titleEn: 'Binomial Coefficients', url: A + 'combinatorics/binomial-coefficients.html' },
    { title: '卡特兰数', titleEn: 'Catalan Numbers', url: A + 'combinatorics/catalan-numbers.html' },
    { title: '容斥原理', titleEn: 'The Inclusion-Exclusion Principle', url: A + 'combinatorics/inclusion-exclusion.html' },
    { title: "Burnside 引理与 Pólya 定理", titleEn: "Burnside's lemma / Pólya enumeration theorem", url: A + 'combinatorics/burnside.html' },
    { title: '隔板法（stars and bars）', titleEn: 'Stars and bars', url: A + 'combinatorics/stars_and_bars.html' },
    { title: '生成所有 k 组合', titleEn: 'Generating all K-combinations', url: A + 'combinatorics/generating_combinations.html' },
    { title: '括号序列计数', titleEn: 'Balanced bracket sequences', url: A + 'combinatorics/bracket_sequences.html' },
    { title: '带标号图的计数', titleEn: 'Counting labeled graphs', url: A + 'combinatorics/counting_labeled_graphs.html' },
    { title: '高斯消元（解线性方程组）', titleEn: 'Gauss & System of Linear Equations', url: A + 'linear_algebra/linear-system-gauss.html' },
    { title: '高斯消元（行列式）', titleEn: 'Gauss & Determinant', url: A + 'linear_algebra/determinant-gauss.html' },
    { title: 'Kraut 法求行列式', titleEn: 'Kraut & Determinant', url: A + 'linear_algebra/determinant-kraut.html' },
    { title: '矩阵的秩', titleEn: 'Rank of a matrix', url: A + 'linear_algebra/rank-matrix.html' },
    { title: 'Sprague-Grundy 定理与 Nim', titleEn: 'Sprague-Grundy theorem. Nim', url: A + 'game_theory/sprague-grundy-nim.html', note: 'SG 函数与博弈和的完整证明' },
    { title: 'Stern-Brocot 树与 Farey 序列', titleEn: 'The Stern-Brocot Tree and Farey Sequences', url: A + 'others/stern_brocot_tree_farey_sequences.html' },
  ],

  // ---------- 字符串 ----------
  string: [
    { title: '字符串哈希', titleEn: 'String Hashing', url: A + 'string/string-hashing.html', note: '含双哈希与防碰撞讨论' },
    { title: 'Rabin-Karp 匹配', titleEn: 'Rabin-Karp for String Matching', url: A + 'string/rabin-karp.html' },
    { title: '前缀函数与 KMP', titleEn: 'Prefix function - Knuth-Morris-Pratt', url: A + 'string/prefix-function.html' },
    { title: 'Z 函数', titleEn: 'Z-function', url: A + 'string/z-function.html' },
    { title: '后缀数组', titleEn: 'Suffix Array', url: A + 'string/suffix-array.html' },
    { title: 'AC 自动机', titleEn: 'Aho-Corasick algorithm', url: A + 'string/aho_corasick.html' },
    { title: '后缀树（Ukkonen）', titleEn: 'Suffix Tree', url: A + 'string/suffix-tree-ukkonen.html' },
    { title: '后缀自动机', titleEn: 'Suffix Automaton', url: A + 'string/suffix-automaton.html' },
    { title: 'Manacher（回文子串）', titleEn: "Manacher's Algorithm", url: A + 'string/manacher.html' },
    { title: 'Lyndon 分解', titleEn: 'Lyndon factorization', url: A + 'string/lyndon_factorization.html' },
    { title: 'Main-Lorentz（重复串）', titleEn: 'Finding repetitions', url: A + 'string/main_lorentz.html' },
    { title: '表达式解析', titleEn: 'Expression parsing', url: A + 'string/expression_parsing.html' },
  ],

  // ---------- 计算几何 ----------
  geo: [
    { title: '计算几何基础', titleEn: 'Basic Geometry', url: A + 'geometry/basic-geometry.html', note: '向量、叉积、有向面积与精度处理' },
    { title: '两点式转一般式', titleEn: 'Finding the equation of a line for a segment', url: A + 'geometry/segment-to-line.html' },
    { title: '直线交点', titleEn: 'Intersection Point of Lines', url: A + 'geometry/lines-intersection.html' },
    { title: '线段相交判定', titleEn: 'Check if two segments intersect', url: A + 'geometry/check-segments-intersection.html' },
    { title: '线段交与求交', titleEn: 'Intersection of Segments', url: A + 'geometry/segments-intersection.html' },
    { title: '圆与直线交点', titleEn: 'Circle-Line Intersection', url: A + 'geometry/circle-line-intersection.html' },
    { title: '两圆交点', titleEn: 'Circle-Circle Intersection', url: A + 'geometry/circle-circle-intersection.html' },
    { title: '两圆公切线', titleEn: 'Common tangents to two circles', url: A + 'geometry/tangents-to-two-circles.html' },
    { title: '线段并的长度', titleEn: 'Length of the union of segments', url: A + 'geometry/length-of-segments-union.html' },
    { title: '三角形有向面积', titleEn: 'Oriented area of a triangle', url: A + 'geometry/oriented-triangle-area.html' },
    { title: '简单多边形面积', titleEn: 'Area of simple polygon', url: A + 'geometry/area-of-simple-polygon.html' },
    { title: '点在凸多边形内（O(log n)）', titleEn: 'Check if points belong to the convex polygon', url: A + 'geometry/point-in-convex-polygon.html' },
    { title: '凸多边形闵可夫斯基和', titleEn: 'Minkowski sum of convex polygons', url: A + 'geometry/minkowski.html' },
    { title: 'Pick 定理', titleEn: "Pick's Theorem", url: A + 'geometry/picks-theorem.html' },
    { title: '非格点多边形的格点', titleEn: 'Lattice points of non-lattice polygon', url: A + 'geometry/lattice-points.html' },
    { title: '凸包', titleEn: 'Convex hull construction', url: A + 'geometry/convex-hull.html' },
    { title: '凸包优化与李超树', titleEn: 'Convex hull trick and Li Chao tree', url: A + 'geometry/convex_hull_trick.html', note: '斜率优化的几何视角，与 DP 优化互通' },
    { title: '线段相交对', titleEn: 'Search for a pair of intersecting segments', url: A + 'geometry/intersecting_segments.html' },
    { title: '平面图的面', titleEn: 'Finding faces of a planar graph', url: A + 'geometry/planar.html' },
    { title: '点定位', titleEn: 'Point location in O(log N)', url: A + 'geometry/point-location.html' },
    { title: '最近点对', titleEn: 'Finding the nearest pair of points', url: A + 'geometry/nearest_points.html' },
    { title: 'Delaunay 三角剖分与 Voronoi 图', titleEn: 'Delaunay triangulation and Voronoi diagram', url: A + 'geometry/delaunay.html' },
    { title: '垂直分解', titleEn: 'Vertical decomposition', url: A + 'geometry/vertical_decomposition.html' },
    { title: '半平面交', titleEn: 'Half-plane intersection', url: A + 'geometry/halfplane-intersection.html' },
    { title: '曼哈顿距离', titleEn: 'Manhattan Distance', url: A + 'geometry/manhattan-distance.html' },
    { title: '最小圆覆盖', titleEn: 'Minimum Enclosing Circle', url: A + 'geometry/enclosing-circle.html' },
  ],

  // ---------- STL 与杂项 ----------
  misc: [
    { title: '位运算技巧', titleEn: 'Bit manipulation', url: A + 'algebra/bit-manipulation.html' },
    { title: '约瑟夫问题', titleEn: 'Josephus problem', url: A + 'others/josephus_problem.html' },
    { title: '龟兔赛跑（链表判环）', titleEn: 'Tortoise and Hare Algorithm', url: A + 'others/tortoise_and_hare.html' },
    { title: '15 数码的可解性', titleEn: '15 Puzzle Game: Existence Of The Solution', url: A + 'others/15-puzzle.html' },
    { title: '最大子段和', titleEn: 'Search the subsegment with the maximum/minimum sum', url: A + 'others/maximum_average_segment.html' },
    { title: 'Stern-Brocot 树与 Farey 序列', titleEn: 'The Stern-Brocot Tree and Farey Sequences', url: A + 'others/stern_brocot_tree_farey_sequences.html' },
    { title: 'MEX 问题', titleEn: 'MEX task', url: A + 'sequences/mex.html' },
    { title: '第 k 小（O(N)）', titleEn: 'K-th order statistic in O(N)', url: A + 'sequences/k-th.html' },
    { title: 'RMQ 问题', titleEn: 'RMQ task', url: A + 'sequences/rmq.html' },
    { title: '单机调度', titleEn: 'Scheduling jobs on one machine', url: A + 'schedules/schedule_one_machine.html' },
    { title: '双机调度', titleEn: 'Scheduling jobs on two machines', url: A + 'schedules/schedule_two_machines.html' },
    { title: '带截止时间的调度', titleEn: 'Optimal schedule of jobs', url: A + 'schedules/schedule-with-completion-duration.html' },
    { title: '棋盘放象问题', titleEn: 'Placing Bishops on a Chessboard', url: A + 'combinatorics/bishops-on-chessboard.html' },
  ],
}

/** 取某个课程分类的延伸阅读；无映射（如用户自建标签）返回空数组，调用方不必判空。 */
export function readingRefsOf(categoryKey: string): ReadingArticle[] {
  return READING_REFS[categoryKey] ?? []
}

/** 全部文章去重后的总数（同一篇可能挂在不同分类下） */
export function readingRefCount(): number {
  const set = new Set<string>()
  for (const list of Object.values(READING_REFS)) for (const a of list) set.add(a.url)
  return set.size
}

/**
 * 「让 AI 用中文讲这篇」的预填请求。
 *
 * 只给链接与明确要求，不预设文章内容——AI 会用 fetch_url 现取现讲，
 * 避免我们把英文原文塞进提示词（版权 + 上下文双输）。
 */
export function buildArticleAskText(article: { title: string; titleEn?: string; url: string }): string {
  const label = article.titleEn && article.titleEn !== article.title ? `（${article.titleEn}）` : ''
  return [
    `请用中文给我讲解这篇文章：${article.title}${label}`,
    article.url,
    '',
    '要求：先读原文再讲，不要凭标题猜内容；按「这篇文章解决什么问题 → 核心思路 → 关键推导 → 复杂度 → 实现要点与易错点」组织；保留原文链接，并指出我应该优先掌握哪一部分。',
  ].join('\n')
}
