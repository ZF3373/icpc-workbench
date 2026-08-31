/**
 * 模板库学习大纲（A 路线：系统学习板块的课程骨架）。
 * 这里只定义「学什么」：分类、模板名称、难度、标签、例题与一句话要点；
 * 模板本体（代码 / 思路 / 复杂度 / 出处）完全由用户自己在应用内写入，
 * 存于 template_progress 的内容列，不随代码分发。
 * tags 与刷题标签同词表，供弱项分析联动推荐。
 */

export interface TemplateExample {
  platform: 'codeforces' | 'luogu';
  key: string;
  title: string;
  url: string;
}

export interface TemplateItem {
  id: string;
  name: string;
  /** 1 易 - 5 难 */
  difficulty: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  /** 大纲要点：这个模板位需要覆盖什么（一句话，具体内容由用户自己写） */
  outline: string;
  examples: TemplateExample[];
}

export interface TemplateCategory {
  key: string;
  name: string;
  description: string;
  templates: TemplateItem[];
}

const lg = (key: string, title: string): TemplateExample => ({
  platform: 'luogu',
  key,
  title,
  url: `https://www.luogu.com.cn/problem/${key}`,
});

// 例题键必须与 CF 适配器的规范键一致（无斜杠，如 279B），
// 否则同步的提交挂在 279B 行、例题查的是 279/B 行，AC 追踪永远匹配不上。
// 入参沿用 279/B 书写便于阅读，出参统一规范化。
const cf = (key: string, title: string): TemplateExample => ({
  platform: 'codeforces',
  key: key.replace('/', ''),
  title,
  url: `https://codeforces.com/problemset/problem/${key.split('/')[0]}/${key.split('/')[1]}`,
});

export const CURRICULUM: TemplateCategory[] = [
  {
    key: 'basic',
    name: '基础算法',
    description: '二分、双指针、前缀和等必备基本功，几乎每道题都有它们的影子',
    templates: [
      {
        id: 'basic-binary-search',
        name: '二分查找（整数域）',
        difficulty: 1,
        tags: ['二分'],
        outline: '写一个自己背得熟的整数二分（求下界/上界），明确 mid 取整方向与区间收缩的配套关系。',
        examples: [lg('P2249', '【深基13.例1】查找'), cf('279/B', 'Books')],
      },
      {
        id: 'basic-two-pointers',
        name: '双指针（滑动窗口）',
        difficulty: 2,
        tags: ['双指针', 'two pointers'],
        outline: '固定右端点、收缩左端点的窗口模板，含窗口内计数维护与撤销。',
        examples: [cf('279/B', 'Books'), lg('P1638', '逛画展')],
      },
      {
        id: 'basic-prefix-sum',
        name: '前缀和与差分',
        difficulty: 1,
        tags: ['前缀和', '差分'],
        outline: '一维/二维前缀和与区间查询公式；差分完成区间加减后一遍前缀和还原。',
        examples: [lg('P1115', '最大子段和'), lg('P2367', '语文成绩')],
      },
      {
        id: 'basic-discretization',
        name: '离散化',
        difficulty: 2,
        tags: ['离散化', '排序'],
        outline: '排序 + 去重 + lower_bound 映射三步，值域大而点稀疏时的标准前置。',
        examples: [lg('P1496', '火烧赤壁')],
      },
      {
        id: 'basic-greedy',
        name: '贪心（区间调度）',
        difficulty: 2,
        tags: ['贪心'],
        outline: '按右端点排序选不相交区间的经典贪心，附一句交换论证为什么它对。',
        examples: [lg('P1803', '凌乱的yyy / 线段覆盖')],
      },
    ],
  },
  {
    key: 'search',
    name: '搜索',
    description: 'DFS / BFS / 记忆化，搜索是状态空间问题的通用解法框架',
    templates: [
      {
        id: 'search-dfs-backtrack',
        name: 'DFS 与回溯',
        difficulty: 2,
        tags: ['DFS', '搜索', '回溯'],
        outline: '「做选择 → 递归 → 撤销选择」三段式框架，现场恢复完整。',
        examples: [lg('P1706', '全排列问题')],
      },
      {
        id: 'search-bfs-grid',
        name: 'BFS 最短路模型',
        difficulty: 2,
        tags: ['BFS', '搜索'],
        outline: '网格 BFS：方向数组、越界/障碍/访问判断、入队时标记，第一次到达即最少步数。',
        examples: [lg('P1443', '马的遍历')],
      },
      {
        id: 'search-floodfill',
        name: '连通块 Flood Fill',
        difficulty: 1,
        tags: ['DFS', 'BFS', '连通性'],
        outline: '扫描全图 + 从每个未访问目标格染色整个连通块，统计块数；想清楚四连通还是八连通。',
        examples: [lg('P1596', '[USACO10OCT]Lake Counting S')],
      },
      {
        id: 'search-memo',
        name: '记忆化搜索',
        difficulty: 3,
        tags: ['DFS', '记忆化', '动态规划'],
        outline: 'DFS 暴力 + memo 缓存的写法（引用取位前先判未算），与递推 DP 的等价关系。',
        examples: [lg('P1434', '滑雪')],
      },
    ],
  },
  {
    key: 'ds',
    name: '数据结构',
    description: '并查集、树状数组、线段树——区间统计与动态维护的核心武器',
    templates: [
      {
        id: 'ds-dsu',
        name: '并查集（路径压缩 + 按秩合并）',
        difficulty: 2,
        tags: ['并查集', '数据结构'],
        outline: 'find 路径压缩 + unite 按秩合并的完整实现，能说明为什么均摊近 O(1)。',
        examples: [lg('P1551', '亲戚'), lg('P3367', '【模板】并查集')],
      },
      {
        id: 'ds-bit',
        name: '树状数组（单点改 + 区间和）',
        difficulty: 3,
        tags: ['树状数组', '数据结构'],
        outline: 'lowbit 原理 + add/query 双循环，区间和 = 两次前缀查询；想清楚下标为何从 1 起。',
        examples: [lg('P3374', '【模板】树状数组 1'), lg('P1908', '逆序对')],
      },
      {
        id: 'ds-segtree',
        name: '线段树（区间加 + 区间求和，懒标记）',
        difficulty: 4,
        tags: ['线段树', '数据结构'],
        outline: 'pushup / pushdown / apply 骨架 + 整段命中返回；数组 4 倍空间的原因。',
        examples: [lg('P3373', '【模板】线段树 2'), lg('P3372', '【模板】线段树 1')],
      },
      {
        id: 'ds-sparse-table',
        name: 'ST 表（静态 RMQ）',
        difficulty: 3,
        tags: ['ST表', '倍增', 'RMQ'],
        outline: '倍增预处理 2^k 区间最值 + 查询两段可重叠覆盖；为什么只能用于可重复贡献运算。',
        examples: [lg('P3865', '【模板】ST 表')],
      },
      {
        id: 'ds-mono-stack',
        name: '单调栈',
        difficulty: 3,
        tags: ['单调栈', '数据结构'],
        outline: '求「左侧第一个更小元素」的四向问题同构说明 + 每元素至多进出栈一次的均摊论证。',
        examples: [lg('P5788', '【模板】单调栈')],
      },
    ],
  },
  {
    key: 'dp',
    name: '动态规划',
    description: '背包、区间、树形、状压——把大问题拆成无后效性的子问题',
    templates: [
      {
        id: 'dp-knapsack',
        name: '背包 DP（01 / 完全）',
        difficulty: 3,
        tags: ['动态规划', '背包'],
        outline: '一维滚动数组：01 倒序、完全正序的原因；「恰好装满」与「不超过容量」的初始化差异。',
        examples: [lg('P1048', '采药'), lg('P1616', '疯狂的采药')],
      },
      {
        id: 'dp-lis',
        name: '最长上升子序列（贪心 + 二分）',
        difficulty: 3,
        tags: ['动态规划', '二分', 'LIS'],
        outline: 'tail 数组的含义（每长度最优末尾）+ lower/upper_bound 对应严格升与不降。',
        examples: [lg('B3637', '最长上升子序列'), lg('P1020', '导弹拦截')],
      },
      {
        id: 'dp-interval',
        name: '区间 DP',
        difficulty: 3,
        tags: ['动态规划', '区间DP'],
        outline: '按长度枚举 + 分割点转移的骨架（石子合并），环状断环为链的处理。',
        examples: [lg('P1880', '[NOI1995]石子合并')],
      },
      {
        id: 'dp-tree',
        name: '树形 DP',
        difficulty: 4,
        tags: ['动态规划', '树形DP', 'DFS'],
        outline: '子树为状态域的后序合并（选/不选当前点 0/1 维），DFS 记 fa 防回走。',
        examples: [lg('P1352', '没有上司的舞会')],
      },
      {
        id: 'dp-bitmask',
        name: '状压 DP',
        difficulty: 4,
        tags: ['动态规划', '状态压缩', '位运算'],
        outline: '行状态压整数 + 相邻行转移合法性（纵/斜冲突位运算判断），滚动数组降维。',
        examples: [lg('P1896', '[SCOI2005]互不侵犯')],
      },
    ],
  },
  {
    key: 'graph',
    name: '图论',
    description: '最短路、生成树、匹配——竞赛图论的五张底牌',
    templates: [
      {
        id: 'graph-dijkstra',
        name: '堆优化 Dijkstra',
        difficulty: 3,
        tags: ['图论', '最短路', '堆'],
        outline: '小根堆 + done 惰性删除的写法；为什么负权边会使其出错。',
        examples: [lg('P4779', '【模板】单源最短路径（标准版）')],
      },
      {
        id: 'graph-spfa',
        name: 'SPFA（判负环）',
        difficulty: 3,
        tags: ['图论', '最短路'],
        outline: '队列松弛框架 + 「入队次数 ≥ n 判负环」；何时会被卡到 O(nm)。',
        examples: [lg('P3385', '【模板】负环')],
      },
      {
        id: 'graph-kruskal',
        name: 'Kruskal 最小生成树',
        difficulty: 3,
        tags: ['图论', '最小生成树', '并查集'],
        outline: '边排序 + 并查集判环 + 选满 n-1 条；不连通时的判定输出。',
        examples: [lg('P3366', '【模板】最小生成树')],
      },
      {
        id: 'graph-topo',
        name: '拓扑排序（Kahn）',
        difficulty: 2,
        tags: ['图论', '拓扑排序', 'DAG'],
        outline: '入度数组反复摘 0 入点，输出数量 < n 即有环；字典序最小用小根堆。',
        examples: [lg('B3644', '【模板】拓扑排序 / 家谱树')],
      },
      {
        id: 'graph-hungarian',
        name: '匈牙利算法（二分图最大匹配）',
        difficulty: 4,
        tags: ['图论', '二分图', '匹配'],
        outline: '增广路递归腾位写法 + vis 每轮清空；matchR 下标方向（右 → 左）。',
        examples: [lg('P3386', '【模板】二分图最大匹配')],
      },
    ],
  },
  {
    key: 'math',
    name: '数学',
    description: '快速幂、筛法、逆元、组合数——数论工具箱',
    templates: [
      {
        id: 'math-quick-pow',
        name: '快速幂（与龟速乘）',
        difficulty: 1,
        tags: ['数学', '快速幂', '取模'],
        outline: '指数二进制分解循环写法；中间乘法溢出时的 __int128 / 龟速乘。',
        examples: [lg('P1226', '【模板】快速幂')],
      },
      {
        id: 'math-sieve',
        name: '线性筛（素数 + 欧拉函数）',
        difficulty: 3,
        tags: ['数学', '筛法', '欧拉函数'],
        outline: '合数只被最小质因子筛掉一次的循环结构 + 欧拉函数两分支递推。',
        examples: [lg('P3383', '【模板】线性筛素数'), lg('P2158', '仪仗队')],
      },
      {
        id: 'math-exgcd',
        name: 'exgcd 与逆元',
        difficulty: 3,
        tags: ['数学', '数论', '逆元'],
        outline: '递归回溯求 ax+by=gcd 的系数（x/y 交换传参），逆元结果统一 (x % p + p) % p。',
        examples: [lg('P1082', '[NOIP2012 提高组] 同余方程'), lg('P3811', '【模板】乘法逆元')],
      },
      {
        id: 'math-comb',
        name: '组合数预处理（阶乘 + 逆元）',
        difficulty: 3,
        tags: ['数学', '组合计数'],
        outline: '阶乘 + 阶乘逆元线性预处理，C(a,b) O(1) 查询；适用前提模数为质数。',
        examples: [lg('P2822', '[NOIP2016 提高组] 组合数问题')],
      },
      {
        id: 'math-matrix-pow',
        name: '矩阵快速幂',
        difficulty: 4,
        tags: ['数学', '矩阵', '快速幂'],
        outline: '矩阵乘法（k 外层 + 稀疏剪枝）与单位阵初始化的快速幂；线性递推转矩阵的思想。',
        examples: [lg('P3390', '【模板】矩阵快速幂'), lg('P1962', '斐波那契数列')],
      },
      {
        id: 'math-game-theory',
        name: '博弈论基础',
        difficulty: 3,
        tags: ['博弈论', '数学'],
        outline: 'Nim：各堆异或和非零先手必胜；巴什：n % (m+1) != 0 先手必胜；威佐夫：d = (b-a)·(√5+1)/2 与 min(a,b) 比较；SG：SG(x)=mex{后继SG}，多子游戏取异或和。',
        examples: [lg('P2197', '【模板】Nim游戏'), lg('P2252', '取石子游戏（威佐夫博弈）')],
      },
    ],
  },
  {
    key: 'string',
    name: '字符串',
    description: 'KMP、哈希、Trie——文本处理三件套加回文/匹配进阶',
    templates: [
      {
        id: 'str-kmp',
        name: 'KMP',
        difficulty: 3,
        tags: ['字符串', 'KMP'],
        outline: 'nxt 数组构建 + 主串匹配双循环；可重叠计数时失配后 j = nxt[j-1]。',
        examples: [lg('P3375', '【模板】KMP')],
      },
      {
        id: 'str-hash',
        name: '字符串哈希',
        difficulty: 2,
        tags: ['字符串', '哈希'],
        outline: '前缀哈希 + 幂次数组的 O(1) 子串截取公式；自然溢出 vs 双哈希的取舍。',
        examples: [lg('P3370', '【模板】字符串哈希')],
      },
      {
        id: 'str-trie',
        name: 'Trie（字典树）',
        difficulty: 2,
        tags: ['字符串', 'Trie'],
        outline: '静态数组儿子表 + 插入/查询框架；空间按 26 × 总字符数估算。',
        examples: [lg('P2580', '于是他错误的点名开始了')],
      },
      {
        id: 'str-manacher',
        name: 'Manacher（最长回文）',
        difficulty: 4,
        tags: ['字符串', '回文'],
        outline: '插 # 统一奇偶 + 镜像继承半径 + 右边界外暴力扩展；原串/新串下标换算。',
        examples: [lg('P3805', '【模板】manacher')],
      },
      {
        id: 'str-z-function',
        name: 'Z 函数（扩展 KMP）',
        difficulty: 4,
        tags: ['字符串'],
        outline: '维护最右匹配段 [l,r] + z[i-l] 继承；拼接分隔符求模式匹配。',
        examples: [lg('P5410', '【模板】扩展 KMP（Z 函数）')],
      },
    ],
  },
  {
    key: 'geo',
    name: '计算几何',
    description: '叉积定向、凸包——几何题的两块基石',
    templates: [
      {
        id: 'geo-cross',
        name: '点积 / 叉积与方向判定',
        difficulty: 2,
        tags: ['计算几何'],
        outline: '叉积符号 = 旋转方向的原语地位；全程整型避免精度问题的坐标约定。',
        examples: [],
      },
      {
        id: 'geo-convex-hull',
        name: '凸包（Andrew 单调链）',
        difficulty: 3,
        tags: ['计算几何', '凸包'],
        outline: '排序去重 + 下链/上链两遍扫（叉积 ≤0 弹栈）；共线点保留与否的选择。',
        examples: [lg('P2742', '【模板】二维凸包')],
      },
      {
        id: 'geo-point-in-polygon',
        name: '点在多边形内（射线法）',
        difficulty: 3,
        tags: ['计算几何'],
        outline: '奇偶穿越法 + 半开区间约定处理顶点穿越；点在边上的单独判定。',
        examples: [],
      },
    ],
  },
];

export const TEMPLATE_TOTAL = CURRICULUM.reduce((n, c) => n + c.templates.length, 0);
