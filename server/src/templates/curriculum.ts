/**
 * 模板库学习大纲（A 路线：系统学习板块的课程骨架）。
 * 这里只定义「学什么」：分类、模板名称、难度、标签、例题与一句话要点；
 * 模板本体（代码 / 思路 / 复杂度 / 出处）完全由用户自己在应用内写入，
 * 存于 template_progress 的内容列，不随代码分发。
 * tags 与刷题标签同词表，供弱项分析联动推荐。
 *
 * 学习顺序设计（分类先后 = 数组顺序，分类内编号 = templates 数组顺序；
 * 「下一课」推荐 / 模板库页编号都按此顺序走，调整顺序前先想清楚依赖）：
 * 1. 阶段递进：零基础（intro）→ 工具与思维（basic）→ 状态空间（search）→ 结构（ds）
 *    → 优化思想（dp）→ 图上问题（graph）→ 树上专题（tree）→ 数学工具（math）
 *    → 文本（string）→ 几何（geo）→ 杂项收尾（misc）。
 * 2. 依赖前置：并查集先于 Kruskal / 线段树分治，线段树先于李超 / 主席树 / 树剖 / 线段树合并，
 *    单调栈先于笛卡尔树，状压先于 SOS，Tarjan 先于 2-SAT / 支配树，高斯消元先于 LGV，
 *    栈与队列（intro）先于单调栈 / 单调队列，递归（intro）先于分治与 DFS。
 *    跨类强依赖（如斯坦纳树要最短路、WQS 例题是最小生成树）在 outline 里自含解释，
 *    线性跟随者可在例题处现学，不为此打散分类。
 * 3. 块内难度爬坡；块与块的接缝允许难度回落（每个新阶段的入口课总是简单的）。
 * 4. 分类显示顺序可被用户在模板库页拖拽自定义（localStorage）覆盖，这里只是默认值。
 *
 * difficulty 的 1-5 在界面上渲染成竞赛段位（入门 / 铜牌 / 银牌 / 金牌 / 争冠，
 * 见 shared/src/templateTiers.ts）——段位口径参考 XCPC 算法知识思维导图
 * 的节点配色：入门=不会就写不出任何题，铜牌=区域赛正常题的基本盘，
 * 银牌=进区域赛奖项线要会，金牌/争冠=冲牌位才需要投入的板子。
 *
 * 大纲覆盖面参考两份外部材料：
 * 1. AlgoWiki 竞赛技巧社区条目（https://www.algowiki.cn/competitions?tab=tricks）：
 *    2026-10 对照其全部 180 条 trick 筛选 —— 成体系的算法/技巧补成独立模板位
 *    （WQS 二分、决策单调性、李超线段树、线段树分治、根号分治、Boruvka 等 16 讲），
 *    一句话级的小 trick（异或前缀和规律、minp 快速分解、光速幂、Dilworth 对偶等）
 *    并入最相近模板位的 outline；纯脑洞/趣味条目不收。
 * 2. XCPC 算法知识思维导图（杜老师、沃老师）：2026-10 两轮对照其全树 229 个叶子做覆盖审计。
 *    第一轮——其「基础」分支几乎全是入门级节点（数组 / 简单排序 / 模拟 / 递归 / 栈队列 / 链表），
 *    而原大纲第一课就是二分、默认这些已经会了，据此补出 intro「入门基础」11 讲；
 *    其余分支补出高阶缺口 23 讲（计数 DP / 动态 DP / 线段树合并 / 可持久化并查集 /
 *    长链剖分 / KM / 带花树 / 支配树 / 最小割树 / 上下界网络流 / 容斥 / 卡特兰与常见数列 /
 *    原根 / Miller-Rabin 与 Pollard-Rho / 杜教筛与 min_25 / Prüfer 序列 / Lyndon 分解 /
 *    圆相关与最小圆覆盖 / 树哈希 / 三分 / 图上 DP）。
 *    第二轮——重跑审计后补 17 讲：基本盘 7 讲（DP 状态设计、多重/分组背包、换根 DP、
 *    单调栈优化 DP、二维树状数组、竞赛图、最短路径树与最短路计数）+ 金牌/争冠板子 10 讲
 *    （生成函数、FWT 与 FMT、类欧几里得、填坑 DP、dp 套 dp、数据结构优化 DP、边分治、
 *    点定位与 Voronoi 图、可持久化平衡树、析合树）；另有 15 个知识点（括号序、链上/树上分块、
 *    pbds、Kosaraju、Hopcroft-Karp、矩阵求逆、Burnside、狄利克雷卷积、动态高维前缀和、爬山、
 *    桶/基数排序、循环链表、杨辉三角、动态点分治与边分治、替罪羊树）体量太小，
 *    并入最相近一课的 outline 而不占独立位。
 *    导图标灰（useless）的节点（堆排序 / 希尔排序 / A* / 斐波那契堆 / 遗传算法 / 拟阵 /
 *    二次剩余 / 贝尔数 / 后缀树 / AVL / 红黑树 / ZKW 系 / 左偏堆 等 17 项）一律不补位；
 *    标黑（板子）的节点是模板库该收的东西，全部收。
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
    key: 'intro',
    name: '入门基础',
    description: '数组、排序、栈队列、递归与模拟——后面每一课都踩在这些之上',
    templates: [
      {
        id: 'intro-array-loop',
        name: '数组下标与循环枚举',
        difficulty: 1,
        tags: ['数组', '枚举'],
        outline: '一维/二维数组的下标从 0 还是从 1 开始要一次定死；把「区间」「前缀」「全部配对」这三类循环模板写到不用想，注意越界与读入顺序。',
        examples: [
        lg('P1427', '小鱼的数字游戏'),
        lg('P1428', '小鱼比可爱'),
        lg('P1046', '[NOIP 2005 普及组] 陶陶摘苹果'),
        lg('P1085', '[NOIP 2004 普及组] 不高兴的津津'),
      ],
      },
      {
        id: 'intro-complexity',
        name: '数据范围与复杂度分析',
        difficulty: 1,
        tags: ['复杂度', '卡常'],
        outline: '按 1e8 次/秒 估：看 n 反推可接受的复杂度，看值域反推要不要 long long / 高精度。会算读入量、内存上限和递归栈深度，别用 O(n²) 去撞 n=1e5。',
        examples: [
        lg('P1177', '【模板】排序'),
        lg('P1923', '【深基9.例4】求第 k 小的数'),
      ],
      },
      {
        id: 'intro-sort-basic',
        name: '简单排序与结构体自定义比较',
        difficulty: 1,
        tags: ['排序', '结构体'],
        outline: '冒泡与插入排序各手写一遍，理解「相邻交换次数恰好等于逆序对数」，并说清选择排序为什么交换更少但比较仍是 O(n²)；多关键字排序用结构体 + 比较函数，想清楚相等时的次关键字方向和稳定性要求（不稳定就退化成手写 cmp 里再比原下标）。',
        examples: [
        lg('P1059', '[NOIP 2006 普及组] 明明的随机数'),
        lg('P1093', '[NOIP 2007 普及组] 奖学金'),
        lg('P1104', '生日'),
        lg('P1786', '帮贡排序'),
      ],
      },
      {
        id: 'intro-sort-advanced',
        name: '高效排序与逆序对',
        difficulty: 2,
        tags: ['排序', '归并', '逆序对'],
        outline: '快排的划分与随机基准、归并的合并过程各自手写一遍（考场上仍用 sort）；归并时在合并步统计跨区间的逆序对数，这是树状数组求逆序对的预处理版。线性时间的桶/基数排序按位或按值域分桶再稳定收集，只在值域小或需要 O(n) 时才用；std::sort 搞不定的「第 k 小」用 nth_element 平均 O(n)。',
        examples: [
        lg('P1908', '逆序对'),
        cf('2248/B', 'Merge to Match'),
      ],
      },
      {
        id: 'intro-simulation',
        name: '模拟与实现',
        difficulty: 1,
        tags: ['模拟', '实现'],
        outline: '把题目过程原样翻译成代码：先定状态变量与「每一步改什么」，再写循环。方向/朝向用偏移数组，环形下标统一用 (x + n) % n，边界条件按样例逐步打表验证。',
        examples: [
        lg('P1563', '[NOIP 2016 提高组] 玩具谜题'),
        lg('P1014', '[NOIP 1999 普及组] Cantor 表'),
        cf('2254/A', 'Riptide'),
        cf('2256/B', 'Domino Tiles'),
      ],
      },
      {
        id: 'intro-string-basic',
        name: '字符串基础处理',
        difficulty: 1,
        tags: ['字符串', '实现'],
        outline: '读入方式（>> 遇空格断 / getline 整行 / 逐字符）先选对；分割、查找、截取、字典序比较与字符计数是四件套，注意下标类型 size_t 无符号减法的坑。',
        examples: [
        lg('P1308', '[NOIP 2011 普及组] 统计单词数'),
        lg('P1321', '单词覆盖还原'),
        lg('P1553', '数字反转（升级版）'),
        cf('2257/A', 'Creating Abbreviations'),
      ],
      },
      {
        id: 'intro-recurrence',
        name: '递归与递推',
        difficulty: 1,
        tags: ['递归', '递推'],
        outline: '递归先写「参数表示什么、什么时候停、如何调更小规模」再考虑返回值；能把递归式子改成自底向上的递推数组，并说清这次改写省掉了多少重复计算。斐波那契数列是这条链的最小样本：朴素递归 O(φⁿ) → 记忆化 / 递推 O(n) → 矩阵快速幂 O(log n)，三种写法各跑过一次才知道差在哪。',
        examples: [
        lg('P1464', '[PacNW 1999] Function'),
        lg('P1255', '数楼梯'),
        lg('P1028', '[NOIP 2001 普及组] 数的计算'),
      ],
      },
      {
        id: 'intro-stack-queue',
        name: '栈与队列',
        difficulty: 2,
        tags: ['栈', '队列'],
        outline: '栈管「最近的还没配对的东西」——括号匹配、表达式求值、进制转换；队列管「先到先得」——BFS 的骨架就是它。两种容器都要能手写数组版，才知道 top/front 的判空时机。',
        examples: [
        lg('P1739', '表达式括号匹配'),
        lg('P1449', '后缀表达式'),
        lg('P4387', '【深基15.习9】验证栈序列'),
        lg('P2186', '小 Z 的栈函数'),
      ],
      },
      {
        id: 'intro-linked-list',
        name: '数组模拟链表',
        difficulty: 2,
        tags: ['链表', '模拟'],
        outline: '竞赛里几乎不用 new 节点，一律 pre[]/nxt[] 数组模拟：删除就是两端接起来，插入就是先接后断。约瑟夫环、队列安排这类「反复在某个位置插删」的题是第一信号。双向用 pre/nxt 两个数组、循环链表靠取模回绕，判「下一个存活」时注意删最后一个点要同时更新头指针。',
        examples: [
        lg('P1160', '队列安排'),
        lg('P1996', '约瑟夫问题'),
      ],
      },
      {
        id: 'intro-brute-force',
        name: '枚举与剪枝',
        difficulty: 2,
        tags: ['枚举', '剪枝'],
        outline: '先写出一定对但一定慢的全排列/子集/三元组枚举，再往上加剪枝：可行性提前判、剩余量不够就 return、枚举顺序按约束最紧的一维优先。位运算枚举子集 (s = (s-1) & m) 是子集类问题的暴力上限。',
        examples: [
        lg('P1618', '三连击（升级版）'),
        lg('P1036', '[NOIP 2002 普及组] 选数'),
        cf('2259/A', 'Moo Language School'),
      ],
      },
      {
        id: 'intro-duipai',
        name: '对拍与随机造数据',
        difficulty: 2,
        tags: ['对拍', '调试'],
        outline: '正解 + 暴力 + 随机数据 + 死循环比较，四件套脚本要能一次跑起来；生成器按「小数据密集、边界数据、最坏数据」三档出，发现自己与暴力不一致时先固定随机种子复现再改代码。',
        examples: [
        lg('P1309', '[NOIP 2011 普及组] 瑞士轮'),
        lg('P1098', '[NOIP 2007 提高组] 字符串的展开'),
        lg('P1052', '[NOIP 2005 提高组] 过河'),
      ],
      },
    ],
  },

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
        examples: [
        lg('P2249', '【深基13.例1】查找'),
        cf('279/B', 'Books'),
        lg('P1102', 'A-B 数对'),
        lg('P1678', '烦恼的高考志愿'),
      ],
      },

      {
        id: 'basic-two-pointers',
        name: '双指针（滑动窗口）',
        difficulty: 2,
        tags: ['双指针', 'two pointers'],
        outline: '固定右端点、收缩左端点的窗口模板，含窗口内计数维护与撤销。',
        examples: [
        cf('279/B', 'Books'),
        lg('P1638', '逛画展'),
        cf('676/C', 'Vasya and String'),
        lg('P1102', 'A-B 数对'),
      ],
      },

      {
        id: 'basic-prefix-sum',
        name: '前缀和与差分',
        difficulty: 1,
        tags: ['前缀和', '差分'],
        outline: '一维/二维前缀和与区间查询公式；差分完成区间加减后一遍前缀和还原，区间加等差/多项式就再升一阶用高阶差分。',
        examples: [
        lg('P1115', '最大子段和'),
        lg('P2367', '语文成绩'),
        lg('P1719', '最大加权矩形'),
        lg('P3406', '海底高铁'),
      ],
      },

      {
        id: 'basic-discretization',
        name: '离散化',
        difficulty: 2,
        tags: ['离散化', '排序'],
        outline: '排序 + 去重 + lower_bound 映射三步，值域大而点稀疏时的标准前置。',
        examples: [
        lg('P1496', '火烧赤壁'),
        lg('P1955', '[NOI2015] 程序自动分析'),
        lg('P1908', '逆序对'),
        lg('P1966', '[NOIP 2013 提高组] 火柴排队'),
      ],
      },

      {
        id: 'basic-greedy',
        name: '贪心（区间调度）',
        difficulty: 2,
        tags: ['贪心'],
        outline: '按右端点排序选不相交区间的经典贪心，附一句交换论证为什么它对。',
        examples: [
        lg('P1803', '凌乱的yyy / 线段覆盖'),
        lg('P1223', '排队接水'),
        lg('P1208', '[USACO1.3] 混合牛奶 Mixing Milk'),
        lg('P5019', '[NOIP 2018 提高组] 铺设道路'),
        cf('2245/A', 'Who Watches the Watchpig?'),
        cf('2241/A', 'Divide and Conquer'),
      ],
      },

      {
        id: 'basic-regret-greedy',
        name: '反悔贪心',
        difficulty: 3,
        tags: ['反悔贪心'],
        outline: '先按贪心选，出现更优候选时用堆弹出已选中最差的替换（「反悔」），数量/容量限制由此动态满足；交换论证说明每次替换不变差。',
        examples: [
        lg('P2949', '[USACO09OPEN] Work Scheduling G'),
      ],
      },

      {
        id: 'basic-binary-answer',
        name: '二分答案',
        difficulty: 2,
        tags: ['二分', '贪心'],
        outline: '「最大化最小值 / 最小化最大值」在值域上二分 + O(n) check 判定，注意值域上下界与无解时的输出约定。',
        examples: [
        lg('P1873', '[COCI 2011/2012 #5] EKO / 砍树'),
        lg('P2678', '[NOIP 2015 提高组] 跳石头'),
        lg('P2440', '木材加工'),
        lg('P1462', '通往奥格瑞玛的道路'),
        cf('1983/C', 'Have Your Cake and Eat It Too'),
        cf('2028/B', 'Alice\'s Adventures in Permuting'),
      ],
      },

      {
        id: 'basic-ternary-search',
        name: '三分法（单峰函数极值）',
        difficulty: 3,
        tags: ['三分', '二分'],
        outline: '单峰函数上取两个内点比较函数值，砍掉不可能含峰的一侧区间；整数域要注意左右中点的取整方向否则会死循环。离散/浮点两种写法各备一份，浮点版用固定轮数迭代代替 while 判 eps。',
        examples: [
        lg('P1883', '【模板】三分 / 函数 / [ICPC 2010 Chengdu R] Error Curves'),
        cf('1996/A', 'Legs'),
        cf('1288/A', 'Deadline'),
      ],
      },

      {
        id: 'basic-doubling',
        name: '倍增',
        difficulty: 2,
        tags: ['倍增'],
        outline: '预处理 2^k 级跳跃表，把线性步数换成二进制拼装；核心是想清楚 f[k][x] 的状态定义与合并顺序。',
        examples: [
        lg('P1613', '跑路'),
        lg('P4155', '[SCOI2015] 国旗计划'),
        lg('P1084', '[NOIP 2012 提高组] 疫情控制'),
      ],
      },

      {
        id: 'basic-divide-conquer',
        name: '分治',
        difficulty: 2,
        tags: ['分治', '递归'],
        outline: '「切一半、递归、跨中合并」三段式：棋盘覆盖式构造与平面最近点对都靠跨中线的一次线性扫描完成合并。',
        examples: [
        lg('P1228', '地毯填补问题'),
        lg('P1429', '平面最近点对（加强版）'),
        lg('P1257', '平面上的最接近点对'),
        lg('P1908', '逆序对'),
      ],
      },
    ],
  },

  {
    key: 'search',
    name: '搜索',
    description: 'DFS / BFS / A* / 折半 / 随机化——状态空间问题的通用解法框架',
    templates: [
      {
        id: 'search-floodfill',
        name: '连通块 Flood Fill',
        difficulty: 1,
        tags: ['DFS', 'BFS', '连通性'],
        outline: '扫描全图 + 从每个未访问目标格染色整个连通块，统计块数；想清楚四连通还是八连通。',
        examples: [
        lg('P1596', '[USACO10OCT] Lake Counting S'),
        lg('P1451', '求细胞数量'),
        lg('P1141', '01迷宫'),
      ],
      },

      {
        id: 'search-dfs-backtrack',
        name: 'DFS 与回溯',
        difficulty: 2,
        tags: ['DFS', '搜索', '回溯'],
        outline: '「做选择 → 递归 → 撤销选择」三段式框架，现场恢复完整。',
        examples: [
        lg('P1706', '全排列问题'),
        lg('P1219', '[USACO1.5] 八皇后 Checker Challenge'),
        lg('P1605', '迷宫'),
        lg('P1019', '[NOIP 2000 提高组] 单词接龙（疑似错题）'),
      ],
      },

      {
        id: 'search-bfs-grid',
        name: 'BFS 最短路模型',
        difficulty: 2,
        tags: ['BFS', '搜索'],
        outline: '网格 BFS：方向数组、越界/障碍/访问判断、入队时标记，第一次到达即最少步数。',
        examples: [
        lg('P1443', '马的遍历'),
        lg('P1135', '奇怪的电梯'),
        lg('P1032', '[NOIP 2002 提高组] 字串变换（疑似错题）'),
        lg('P2895', '[USACO08FEB] Meteor Shower S'),
      ],
      },

      {
        id: 'search-memo',
        name: '记忆化搜索',
        difficulty: 3,
        tags: ['DFS', '记忆化', '动态规划'],
        outline: 'DFS 暴力 + memo 缓存的写法（引用取位前先判未算），与递推 DP 的等价关系。',
        examples: [
        lg('P1434', '[SHOI2002] 滑雪'),
        lg('P1464', '[PacNW 1999] Function'),
        lg('P1216', '[IOI 1994 / USACO1.5] 数字三角形 Number Triangles'),
      ],
      },

      {
        id: 'search-bidirectional-bfs',
        name: '双向 BFS',
        difficulty: 3,
        tags: ['BFS', '搜索'],
        outline: '起点终点交替扩展、始终扩队列较小的一侧，相遇即最短；每层用整层 for 控制，避免跳层漏解。',
        examples: [
        lg('P1379', '八数码难题'),
        lg('P2730', '[IOI 1996 / USACO3.2] 魔板 Magic Squares'),
      ],
      },

      {
        id: 'search-annealing',
        name: '模拟退火（随机化搜索）',
        difficulty: 3,
        tags: ['随机化', '模拟退火'],
        outline: '温度从高到低，以 exp(-Δ/T) 的概率接受劣解逃离局部最优；while 卡到时限边缘多跑几轮取最优。爬山（只接受更优、卡在局部最优就重启）是它的退化版，实现更短、多数构造类得分题先到这里就够了；两者都是「赌随机」，务必固定种子保证可复现。',
        examples: [
        lg('P1337', '[JSOI2004] 平衡点 / 吊打XXX'),
        lg('P2503', '[HAOI2006] 均分数据'),
        lg('P3878', '[TJOI2010] 分金币'),
        lg('P2962', '[USACO09NOV] Lights G'),
      ],
      },

      {
        id: 'search-astar',
        name: 'A* 与 IDA*',
        difficulty: 4,
        tags: ['A*', '启发式搜索'],
        outline: '按 g+h 出堆的优先队列搜索，h 必须是可采纳的下界估计才保证最优；迭代加深版以 f = g+h 限深剪枝。',
        examples: [
        lg('P2324', '[SCOI2005] 骑士精神'),
        lg('P1379', '八数码难题'),
        lg('P1074', '[NOIP 2009 提高组] 靶形数独'),
      ],
      },

      {
        id: 'search-meet-in-middle',
        name: '折半搜索（meet in the middle）',
        difficulty: 4,
        tags: ['搜索', '折半搜索'],
        outline: '枚举减半：两半各自 2^(n/2) 张表，一半排序后另一半二分/哈希拼接答案，O(2^n) 降到 O(2^(n/2)·log)。',
        examples: [
        lg('P4799', '[CEOI 2015] 世界冰球锦标赛 (Day2)'),
        cf('888/E', 'Maximum Subsequence'),
        cf('525/E', 'Anya and Cubes'),
        cf('1006/F', 'Xor-Paths'),
        cf('799/D', 'Field expansion'),
      ],
      },

      {
        id: 'search-dlx',
        name: '舞蹈链 DLX（精确覆盖）',
        difficulty: 5,
        tags: ['搜索', 'DLX', '精确覆盖'],
        outline: '十字双向链表 O(1) 覆盖/恢复，递归回溯时选剩余元素最少的列；数独是精确覆盖，重复覆盖改用估价函数剪枝。',
        examples: [
        lg('P4929', '【模板】舞蹈链（DLX）'),
        lg('P1784', '数独'),
        lg('P1074', '[NOIP 2009 提高组] 靶形数独'),
      ],
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
        examples: [
        lg('P1551', '亲戚'),
        lg('P3367', '【模板】并查集'),
        lg('P1536', '村村通'),
        lg('P1111', '修复公路'),
        cf('1249/B1', 'Books Exchange (easy version)'),
        cf('217/A', 'Ice Skating'),
        cf('501/B', 'Misha and Changing Handles'),
      ],
      },

      {
        id: 'ds-heap',
        name: '堆（priority_queue 与对顶堆）',
        difficulty: 2,
        tags: ['堆', '优先队列'],
        outline: '大根堆配小根堆动态维护第 k 大（对顶堆）的平衡条件；pair 入堆时的比较方向易错。',
        examples: [
        lg('P1090', '[NOIP 2004 提高组] 合并果子'),
        lg('P1801', '黑匣子'),
        lg('P1168', '中位数'),
        lg('P6033', '[NOIP 2004 提高组] 合并果子 加强版'),
      ],
      },

      {
        id: 'ds-mono-stack',
        name: '单调栈',
        difficulty: 3,
        tags: ['单调栈', '数据结构'],
        outline: '求「左侧第一个更小元素」的四向问题同构说明 + 每元素至多进出栈一次的均摊论证。',
        examples: [
        lg('P5788', '【模板】单调栈'),
        lg('P2947', '[USACO09MAR] Look Up S'),
        lg('P1908', '逆序对'),
      ],
      },

      {
        id: 'ds-mono-deque',
        name: '单调队列',
        difficulty: 2,
        tags: ['单调队列', '队列'],
        outline: '队尾弹失去单调性、队头弹滑出窗口，队头即当前最值；队列里存下标，出队判断用下标而非值。',
        examples: [
        lg('P1886', '【模板】单调队列 / 滑动窗口'),
        lg('P1440', '求m区间内的最小值'),
        lg('P2032', '扫描'),
        lg('P1419', '寻找段落'),
      ],
      },

      {
        id: 'ds-bit',
        name: '树状数组（单点改 + 区间和）',
        difficulty: 3,
        tags: ['树状数组', '数据结构'],
        outline: 'lowbit 原理 + add/query 双循环，区间和 = 两次前缀查询；想清楚下标为何从 1 起；「第 k 小/前缀二分」直接在树上倍增爬行（BIT 倍增），比外挂二分少一个 log。',
        examples: [
        lg('P3374', '【模板】树状数组 1'),
        lg('P1908', '逆序对'),
        lg('P3368', '【模板】树状数组 2'),
        lg('P1966', '[NOIP 2013 提高组] 火柴排队'),
      ],
      },

      {
        id: 'ds-bit-2d',
        name: '二维树状数组',
        difficulty: 3,
        tags: ['树状数组', '二维'],
        outline: '把 lowbit 循环嵌套两层就是二维版：单点改 + 矩形和 O(log n log m)，内存 O(nm) 因此只用在 n,m 都 ≤ 1e3~2e3 的网格上。矩形改 + 单点查靠二维差分（4 次单点改），矩形改 + 矩形查要开 4 棵带系数 (x+1)(y+1) 的树。维数一高就得先算内存账。',
        examples: [
        lg('P1719', '最大加权矩形'),
        lg('P2163', '[SHOI2007] 园丁的烦恼'),
      ],
      },

      {
        id: 'ds-sparse-table',
        name: 'ST 表（静态 RMQ）',
        difficulty: 3,
        tags: ['ST表', '倍增', 'RMQ'],
        outline: '倍增预处理 2^k 区间最值 + 查询两段可重叠覆盖；为什么只能用于可重复贡献运算。',
        examples: [
        lg('P3865', '【模板】ST 表 & RMQ 问题'),
        lg('P1816', '忠诚'),
        lg('P2880', '[USACO07JAN] Balanced Lineup G'),
        lg('P2251', '质量检测'),
      ],
      },

      {
        id: 'ds-segtree',
        name: '线段树（区间加 + 区间求和，懒标记）',
        difficulty: 4,
        tags: ['线段树', '数据结构'],
        outline: 'pushup / pushdown / apply 骨架 + 整段命中返回；数组 4 倍空间的原因；节点信息不能由儿子直接拼出时（楼房重建式）单侧递归下潜，O(log²) 均摊。',
        examples: [
        lg('P3373', '【模板】线段树 2'),
        lg('P3372', '【模板】线段树 1'),
        lg('P2574', 'XOR 的艺术'),
        lg('P4513', '小白逛公园'),
      ],
      },

      {
        id: 'ds-li-chao',
        name: '李超线段树',
        difficulty: 4,
        tags: ['李超线段树'],
        outline: '每个节点只保留「在该区间中点处最高」的那条线段，插入 O(log n)、查询沿路径取 max；斜率优化里斜率与询问位置都不单调时的通用替代。',
        examples: [
        lg('P4097', '【模板】李超线段树 / [HEOI2013] Segment'),
      ],
      },

      {
        id: 'ds-weighted-dsu',
        name: '带权 / 扩展域并查集',
        difficulty: 3,
        tags: ['并查集', '数据结构'],
        outline: '路径压缩时顺带递推节点到根的权值（先递归再更新）；关系类问题也可拆「真/假」扩展域建双份集合。',
        examples: [
        lg('P1196', '[NOI2002] 银河英雄传说'),
        lg('P1892', '[BalticOI 2003] 团伙 (Day 2)'),
        lg('P2024', '[NOI2001] 食物链'),
        lg('P5937', '[CEOI 1999] Parity Game'),
        cf('2033/E', 'Sakurako, Kosuke, and the Permutation'),
        cf('1559/D1', 'Mocha and Diana (Easy Version)'),
      ],
      },

      {
        id: 'ds-chairman-tree',
        name: '主席树（可持久化线段树）',
        difficulty: 4,
        tags: ['线段树', '可持久化', '数据结构'],
        outline: '每次插入只新建 O(log n) 个节点、复用旧版本；静态区间第 k 小按权值域比较左右子树大小下潜。',
        examples: [
        lg('P3834', '【模板】可持久化线段树 2（静态区间第 k 小）'),
        lg('P2617', 'Dynamic Rankings'),
        lg('P3168', '[CQOI2015] 任务查询系统'),
      ],
      },

      {
        id: 'ds-segtree-merge',
        name: '线段树合并',
        difficulty: 5,
        tags: ['线段树合并', '线段树'],
        outline: '动态开点两棵树递归合并：都空则返回空，只有一个非空就直接返回那棵（不新建节点），否则累加信息后左右合并。总复杂度按「被合并掉的节点数」算，n 棵单点树合并完是 O(n log n)。树上背包/权值线段树上树常用它替代树套树。',
        examples: [
        lg('P4556', '【模板】线段树合并 / [Vani 有约会] 雨天的尾巴'),
      ],
      },

      {
        id: 'ds-persistent-dsu',
        name: '可持久化并查集',
        difficulty: 4,
        tags: ['可持久化并查集', '并查集', '可持久化'],
        outline: '用主席树存 fa[i] 数组，每次 find 沿主席树版本往下查父亲、union 只改一个位置，从而保留历史版本。不能路径压缩（会改一堆点），只按秩合并，单次操作 O(log n · log n)。',
        examples: [
        lg('P3402', '【模板】可持久化并查集'),
      ],
      },

      {
        id: 'ds-fhq-treap',
        name: '平衡树（FHQ Treap）',
        difficulty: 4,
        tags: ['平衡树', '数据结构'],
        outline: '按权值分裂 + 按大小分裂，merge/split 两个函数撑起全部操作；随机键维持期望平衡，无需旋转。替罪羊树走另一条路：不存随机键，子树大小失衡就整棵重构，靠「重构代价摊到每次插入」证 O(log n) 均摊，写起来比旋转类平衡树短。',
        examples: [
        lg('P3369', '【模板】普通平衡树'),
        lg('P3391', '【模板】文艺平衡树'),
        lg('P2042', '[NOI2005] 维护数列'),
      ],
      },

      {
        id: 'ds-persistent-balanced',
        name: '可持久化平衡树',
        difficulty: 5,
        tags: ['可持久化', '平衡树'],
        outline: 'FHQ Treap 天生好持久化：split/merge 每经过一个节点就复制一个（新随机键可复用），其余子树直接共享指针，单次操作只新建 O(log n) 个节点；根存进版本数组即得第 k 版。绝不能就地改 child 指针，那会污染历史版本。文艺平衡树（区间反转）再加一层可持久化就是「可持久化文艺平衡树」。',
        examples: [
        lg('P5055', '【模板】可持久化文艺平衡树'),
      ],
      },

      {
        id: 'ds-sqrt-decomposition',
        name: '分块',
        difficulty: 4,
        tags: ['分块', '数据结构'],
        outline: '整块打懒标记、散块暴力扫的维护框架，块长取 √n 附近平衡两类代价；「优雅的暴力」是万能保底。链上分块把树按 √n 个关键点切成块、预处理块内两两信息，是树剖之外的另一类带修改路径查询；树上分块则按 DFS 序分块或按深度分块，专门接「k 层祖先 / 子树第 k 深」这类树剖不好写的操作。',
        examples: [
        lg('P2801', '教主的魔法'),
        lg('P3203', '[HNOI2010] 弹飞绵羊'),
        lg('P4168', '[Violet] 蒲公英'),
      ],
      },

      {
        id: 'ds-sqrt-split',
        name: '根号分治',
        difficulty: 4,
        tags: ['根号分治'],
        outline: '按出现次数/规模对阈值 B 分类：小的一侧直接暴力（总量受 B 控制），大的一侧个数 ≤ n/B 单独预处理答案；两类代价之和在 B=√n 附近最小。',
        examples: [
        lg('P3396', '哈希冲突'),
        cf('797/E', 'Array Queries'),
      ],
      },

      {
        id: 'ds-mo-algorithm',
        name: '莫队（普通 + 带修）',
        difficulty: 4,
        tags: ['莫队', '离线'],
        outline: '按（左端点块, 右端点奇偶）排序后双指针暴力增删；带修加时间维变三维排序，注意奇偶优化与增删次序；「数颜色」转统计 pre_i < l 的位置数（前驱二维数点）。',
        examples: [
        lg('P2709', '【模板】莫队 / 小 B 的询问'),
        lg('P1903', '【模板】带修莫队 / [国家集训队] 数颜色 / 维护队列'),
        lg('P1494', '[国家集训队] 小 Z 的袜子'),
      ],
      },

      {
        id: 'ds-cartesian-tree',
        name: '笛卡尔树',
        difficulty: 4,
        tags: ['笛卡尔树'],
        outline: '下标为 BST、权值为堆的树，用单调栈 O(n) 构建；区间最值 = 两端点 LCA，直方图计数 / 最值分治类问题先把序列拍成它再上树形 DP。',
        examples: [
        lg('P5854', '【模板】笛卡尔树'),
      ],
      },

      {
        id: 'ds-majority-vote',
        name: '摩尔投票与绝对众数',
        difficulty: 3,
        tags: ['摩尔投票', '绝对众数'],
        outline: '(val, cnt) 两两相抵可合并，严格过半的绝对众数必是投票候选——但候选未必合法，须二次计数验证；配线段树维护区间候选即成区间众数框架。',
        examples: [
        cf('1514/D', 'Cut and Stick'),
      ],
      },

      {
        id: 'ds-segtree-divide',
        name: '线段树分治',
        difficulty: 5,
        tags: ['线段树分治'],
        outline: '把每个「只在一段时间内存活」的修改挂到时间线段树的 O(log n) 个节点上，DFS 进节点应用、出节点回滚，叶子处回答该时刻询问；前提是结构只加可撤销（可撤销并查集不能路径压缩）。',
        examples: [
        lg('P5787', '【模板】线段树分治 / 二分图'),
      ],
      },

      {
        id: 'ds-kd-tree',
        name: 'K-D 树',
        difficulty: 5,
        tags: ['数据结构', 'KD树', '计算几何'],
        outline: '交替按维度切分建树，矩形到目标点的最小/最大距离做剪枝查最近/最远点对；插入过深时按替罪羊思路重构子树。',
        examples: [
        lg('P4169', '[Violet] 天使玩偶/SJY摆棋子'),
        lg('P4357', '[CQOI2016] K 远点对'),
      ],
      },

      {
        id: 'ds-tree-in-tree',
        name: '树套树',
        difficulty: 5,
        tags: ['数据结构', '树套树', '平衡树'],
        outline: '线段树套平衡树（外层线段树按位置、内层平衡树 / 权值线段树按值域），查询 = O(log n) 个内层结构的拼合；单点版常见，带区间改要在内层打标记。',
        examples: [
        lg('P3380', '【模板】树套树'),
        lg('P3332', '[ZJOI2013] K 大数查询'),
      ],
      },

      {
        id: 'ds-xihe-tree',
        name: '析合树',
        difficulty: 5,
        tags: ['析合树', '数据结构'],
        outline: '把排列的所有「连续区间」（值域与下标域同时连续的段）组织成一棵树：析节点是若干个极大真子段的并、合节点是它们，交替出现，叶子是单个位置。用单调栈 + 集合并在线 O(n log n) 建树（或 O(n) 版）。它同时是笛卡尔树与「区间图分裂树」的推广，问「有多少个连续子段仍是连续值域」这类计数题时是标准工具。',
        examples: [
        lg('P4747', '[CERC2017] Intrinsic Interval'),
      ],
      },

      {
        id: 'ds-partition-tree',
        name: '划分树',
        difficulty: 5,
        tags: ['数据结构', '划分树'],
        outline: '按排序中位数逐层左右分层，记「进入左子树的前缀个数」即可 O(1) 下溯，静态区间第 k 小不用在线插入；空间 O(n log n) 比主席树省，已被其取代但值得会。',
        examples: [
        lg('P3834', '【模板】可持久化线段树 2（静态区间第 k 小）'),
      ],
      },
    ],
  },

  {
    key: 'dp',
    name: '动态规划',
    description: '背包、区间、树形、状压——把大问题拆成无后效性的子问题',
    templates: [
      {
        id: 'dp-state-design',
        name: 'DP 状态设计与转移（入门）',
        difficulty: 2,
        tags: ['动态规划', '状态设计'],
        outline: '三步固定：f[…] 到底表示「前 i 个的最优」还是「恰好容量 j 的最优」；转移方程从「最后一步怎么来的」推，不是背；初值与非法态（-inf / +inf）先定下来再写循环。同时练「最优子结构」与「无后效性」——加一维把影响决策的历史信息显式记进状态，是无后效性不成立时唯一的出路。',
        examples: [
        lg('P1216', '[IOI 1994 / USACO1.5] 数字三角形 Number Triangles'),
        lg('P1091', '[NOIP 2004 提高组] 合唱队形'),
      ],
      },

      {
        id: 'dp-knapsack',
        name: '背包 DP（01 / 完全）',
        difficulty: 3,
        tags: ['动态规划', '背包'],
        outline: '一维滚动数组：01 倒序、完全正序的原因；「恰好装满」与「不超过容量」的初始化差异。',
        examples: [
        lg('P1048', '[NOIP 2005 普及组] 采药'),
        lg('P1616', '疯狂的采药'),
        lg('P1064', '[NOIP 2006 提高组] 金明的预算方案'),
        lg('P1164', '小 A 点菜'),
      ],
      },

      {
        id: 'dp-knapsack-variants',
        name: '多重背包与分组 / 混合背包',
        difficulty: 3,
        tags: ['背包', '动态规划'],
        outline: '多重背包三种复杂度要分清：朴素 O(V·Σm)、二进制拆分件数后 O(V·Σlog m)、单调队列按余数分层优化到 O(V·n)。分组背包是「每组至多选一个」，三重循环必须按「组 → 容量（逆序）→ 组内物品」排，把容量放在组内物品外层才能保证同一组只选一件。混合背包先按 01 / 完全 / 多重逐件分类处理再统一转移；依赖型（选子物品必须先选父物品）就是树上分组背包；多维背包（体积 + 重量双限制）把 f 开成二维、每一维都各自逆序扫。',
        examples: [
        lg('P1776', '宝物筛选'),
        lg('P1833', '樱花'),
        lg('P2515', '[HAOI2010] 软件安装'),
        lg('P1616', '疯狂的采药'),
      ],
      },

      {
        id: 'dp-lis',
        name: '最长上升子序列（贪心 + 二分）',
        difficulty: 3,
        tags: ['动态规划', '二分', 'LIS'],
        outline: 'tail 数组的含义（每长度最优末尾）+ lower/upper_bound 对应严格升与不降；Dilworth 对偶（最少不降链覆盖 = 最长上升长）、排列 LCS 转 LIS、a[i]−i 消「严格递增」约束，三个常用变体。',
        examples: [
        lg('B3637', '最长上升子序列'),
        lg('P1020', '[NOIP 1999 提高组] 导弹拦截'),
        lg('P2782', '友好城市'),
        lg('P1439', '两个排列的最长公共子序列'),
      ],
      },

      {
        id: 'dp-interval',
        name: '区间 DP',
        difficulty: 3,
        tags: ['动态规划', '区间DP'],
        outline: '按长度枚举 + 分割点转移的骨架（石子合并），环状断环为链的处理。',
        examples: [
        lg('P1880', '[NOI1995] 石子合并'),
        lg('P1063', '[NOIP 2006 提高组] 能量项链'),
        lg('P1220', '关路灯'),
      ],
      },

      {
        id: 'dp-counting',
        name: '计数 DP',
        difficulty: 3,
        tags: ['计数DP', '动态规划'],
        outline: '状态表示「方案数」而非最值：转移是加法原理的分情况求和，最后对 1e9+7 或 998244353 取模。想清「同一方案会不会被数两次」——按最后一个位置/最大值/最后一步分类是去重的标准手法。',
        examples: [
        lg('P2513', '[HAOI2009] 逆序对数列'),
        lg('P4648', '[IOI 2007] pairs 动物对数'),
      ],
      },

      {
        id: 'dp-tree',
        name: '树形 DP',
        difficulty: 4,
        tags: ['动态规划', '树形DP', 'DFS'],
        outline: '子树为状态域的后序合并（选/不选当前点 0/1 维），DFS 记 fa 防回走。',
        examples: [
        lg('P1352', '没有上司的舞会'),
        lg('P2014', '[CTSC1997] 选课'),
        lg('P2015', '二叉苹果树'),
        lg('P3177', '[HAOI2015] 树上染色'),
        cf('161/D', 'Distance in Tree'),
        cf('1975/D', 'Paint the Tree'),
      ],
      },

      {
        id: 'dp-tree-reroot',
        name: '换根 DP',
        difficulty: 4,
        tags: ['树形DP', '换根', '动态规划'],
        outline: '先以任意点（1 号）为根跑一遍自底向上求出 f(1)，再自顶向下推「父亲的答案如何改写成儿子作为根的答案」的 delta 转移。转移里凡是取 max / min 的，必须同时维护最优与次优（或前缀后缀两个数组），否则把儿子那一份贡献去掉时取不到正确值。两次 DFS 出全部 n 个根的答案，O(n)。',
        examples: [
        lg('P3478', '[POI 2008] STA-Station'),
      ],
      },

      {
        id: 'dp-on-graph',
        name: '图上 DP（拓扑序与基环树）',
        difficulty: 4,
        tags: ['图上DP', '动态规划', '拓扑排序'],
        outline: 'DP 能上图的唯一前提是依赖关系无环：先在 DAG 上跑拓扑排序，按拓扑序转移就是「带后效性的图版递推」。图上带环时先缩点成 DAG 再 DP；基环树则断环成树、分别固定断边两端的状态跑两遍。',
        examples: [
        lg('P1137', '旅行计划'),
        lg('P4017', '最大食物链计数'),
      ],
      },

      {
        id: 'dp-bitmask',
        name: '状压 DP',
        difficulty: 4,
        tags: ['动态规划', '状态压缩', '位运算'],
        outline: '行状态压整数 + 相邻行转移合法性（纵/斜冲突位运算判断），滚动数组降维。',
        examples: [
        lg('P1896', '[SCOI2005] 互不侵犯'),
        lg('P2704', '[NOI2001] 炮兵阵地'),
        lg('P1879', '[USACO06NOV] Corn Fields G'),
      ],
      },

      {
        id: 'dp-sos',
        name: '高维前缀和（子集和变换）',
        difficulty: 3,
        tags: ['高维前缀和'],
        outline: '对每个二进制位做一遍「含该位则从去掉该位的状态转移」，O(n·2ⁿ) 完成 ∑_{T⊆S} f_T（子集和/SOS）或其超集对偶；两个方向相反，别写反。要支持「改某个 f(S) 再查子集和」就把每一维的转移套一层树状数组（动态高维前缀和），代价乘一个 log。',
        examples: [
        cf('449/D', 'Jzzhu and Numbers'),
        cf('165/E', 'Compatible Numbers'),
      ],
      },

      {
        id: 'dp-digit',
        name: '数位 DP',
        difficulty: 4,
        tags: ['动态规划', '数位DP'],
        outline: '逐位枚举 + limit/前导零状态记忆化，答案 = solve(r) - solve(l-1)；状态只记「贴不贴上界」往往就够。',
        examples: [
        lg('P2602', '[ZJOI2010] 数字计数'),
        lg('P4127', '[AHOI2009] 同类分布'),
        cf('1036/C', 'Classy Numbers'),
      ],
      },

      {
        id: 'dp-probability',
        name: '期望 DP',
        difficulty: 4,
        tags: ['动态规划', '概率期望'],
        outline: '概率正推、期望逆推（f[u] = Σ p·f[后继] + 边代价）；「期望的线性性」拆开各贡献独立算，卡住时再试尾和公式（E[X] = Σ P(X≥k)）与势能法。',
        examples: [
        lg('P4316', '绿豆蛙的归宿'),
        lg('P1654', 'OSU!'),
        lg('P1365', 'WJMZBMR打osu! / Easy'),
      ],
      },

      {
        id: 'dp-mono-queue-opt',
        name: '单调队列优化 DP',
        difficulty: 4,
        tags: ['动态规划', '单调队列'],
        outline: '转移形如 f[i] = max(f[j] + w(i) - w(j)) 且 j 落在定长窗口内时，滑动窗口维护决策点均摊 O(1)。',
        examples: [
        lg('P1725', '琪露诺'),
        lg('P2627', '[USACO11OPEN] Mowing the Lawn G'),
        lg('P3957', '[NOIP 2017 普及组] 跳房子'),
      ],
      },

      {
        id: 'dp-mono-stack-opt',
        name: '单调栈优化 DP',
        difficulty: 4,
        tags: ['单调栈', '动态规划'],
        outline: '当转移形如 f[i] = max(f[j] + w(j,i))（j < i）且「j 是 i 左边第一个比它大的位置」这类单调关系成立时，候选 j 的集合恰好是单调栈里的内容：每个点只入栈出栈一次，把 O(n²) 降到 O(n)。先证明被弹掉的位置之后再也不可能成为最优转移点，这是这类 DP 的全部难点。',
        examples: [
        lg('P1901', '发射站'),
      ],
      },

      {
        id: 'dp-slope-opt',
        name: '斜率优化（凸壳转移）',
        difficulty: 5,
        tags: ['动态规划', '斜率优化', '凸壳'],
        outline: '把含 i²/j² 的转移整理成斜截式，决策点构成下凸壳：斜率单调弹队首 O(1)，否则二分凸壳 O(log)。',
        examples: [
        lg('P3195', '[HNOI2008] 玩具装箱'),
        lg('P3648', '[APIO2014] 序列分割'),
        lg('P2120', '[ZJOI2007] 仓库建设'),
        lg('P4027', '[NOI2007] 货币兑换'),
      ],
      },

      {
        id: 'dp-decision-mono',
        name: '决策单调性优化 DP（四边形不等式）',
        difficulty: 5,
        tags: ['决策单调性'],
        outline: '代价满足四边形不等式时最优决策点随 i 单调：分治「先算中点决策再递归两侧」O(n log n)，或单调栈维护决策区间 O(n)；套用前必须先验证单调性，否则 WA。',
        examples: [
        lg('P4767', '[IOI 2000] 邮局 加强版'),
        cf('321/E', 'Ciel and Gondolas'),
      ],
      },

      {
        id: 'dp-ds-opt',
        name: '数据结构优化 DP',
        difficulty: 4,
        tags: ['动态规划', '线段树', '树状数组'],
        outline: '把「枚举上一个决策点」换成一次区间查询：转移是区间 max/sum 就开线段树或树状数组按 f 值下标维护，扫到 i 先查再插入。多维限制就升维（二维数点配二维 BIT / CDQ）。判据是转移方程里对 j 的约束能写成 j 的某个函数落在一个区间内。',
        examples: [
        lg('P3287', '[SCOI2014] 方伯伯的玉米田'),
        lg('P2627', '[USACO11OPEN] Mowing the Lawn G'),
      ],
      },

      {
        id: 'dp-wqs',
        name: 'WQS 二分（凸优化）',
        difficulty: 5,
        tags: ['WQS 二分'],
        outline: '「恰好选 k 个」的最优化给每个被选对象加惩罚 λ 后去掉限制，(选数, 最优值) 随 λ 单调且构成凸壳，二分 λ 命中 k；须同时记录选数并小心平局（斜率相等段）。',
        examples: [
        lg('P2619', '[国家集训队] Tree I'),
      ],
      },

      {
        id: 'dp-dynamic',
        name: '动态 DP（矩阵加速树形 DP）',
        difficulty: 5,
        tags: ['动态DP', '树链剖分', '矩阵'],
        outline: '把树形 DP 的转移写成「轻子树贡献已合并进 g 数组，重链上是一次 max-plus 矩阵乘法」，再用链剖 + 线段树维护每条重链的矩阵乘积；改点权只影响到链顶，O(log²n) 修改。核心是把 max+加法当成半区间跑矩阵乘法。',
        examples: [
        lg('P4719', '【模板】动态 DP'),
        lg('P5024', '[NOIP 2018 提高组] 保卫王国'),
      ],
      },

      {
        id: 'dp-nested',
        name: 'dp 套 dp',
        difficulty: 5,
        tags: ['dp套dp', '动态规划'],
        outline: '外层 DP 的每个状态里还要再跑一遍内层 DP：常见形态是「外层枚举决策/位置、内层求该决策下的最优代价」，或「外层背包 + 内层子问题转移」。写之前先确认内层结果只依赖外层当前状态与一个可枚举的参数，否则两层会互相依赖而成环。复杂度是两层乘积，必须靠内层的单调性/前缀和优化把其中一层压下来。',
        examples: [
        lg('P4590', '[TJOI2018] 游园会'),
        lg('P5279', '[ZJOI2019] 麻将'),
      ],
      },

      {
        id: 'dp-steiner',
        name: '最小斯坦纳树',
        difficulty: 5,
        tags: ['动态规划', '状压DP', '最短路'],
        outline: 'f[u][S] 连通关键点集 S 的最小代价：子集枚举「合并两半」与最短路松弛「同集转移」交替直到收敛。',
        examples: [
        lg('P6192', '【模板】最小斯坦纳树'),
        lg('P4294', '[WC2008] 游览计划'),
      ],
      },

      {
        id: 'dp-fill-board',
        name: '填坑 DP',
        difficulty: 5,
        tags: ['填坑DP', '状态压缩', '动态规划'],
        outline: '按「第一个空格」而不是按格推进：状态是整个棋盘占位压成的三进制/二进制串，每次枚举能盖住这个空格的骨牌或连通块放下去，转移到新状态。天然免重（永远填最靠前的坑），所以不需要像插头 DP 那样维护轮廓线连通性；代价是状态数随空格数指数增长，只适合 n·m ≤ 12~15 的小棋盘。',
        examples: [
        lg('P4363', '[九省联考 2018] 一双木棋 chess'),
      ],
      },

      {
        id: 'dp-plug',
        name: '插头 DP（轮廓线状压）',
        difficulty: 5,
        tags: ['动态规划', '状压DP', '插头DP'],
        outline: '逐格转移维护轮廓线上插头的连通性（最小表示法编码），分新建/延续/合并三类讨论；哈希表存状态防膨胀。',
        examples: [
        lg('P5056', '【模板】插头 DP'),
        lg('P5074', 'Eat the Trees'),
      ],
      },
    ],
  },

  {
    key: 'graph',
    name: '图论',
    description: '最短路、生成树、连通性、网络流——竞赛图论全图谱',
    templates: [
      {
        id: 'graph-topo',
        name: '拓扑排序（Kahn）',
        difficulty: 2,
        tags: ['图论', '拓扑排序', 'DAG'],
        outline: '入度数组反复摘 0 入点，输出数量 < n 即有环；字典序最小用小根堆。',
        examples: [
        lg('B3644', '【模板】拓扑排序 / 家谱树'),
        lg('P4017', '最大食物链计数'),
        lg('P1113', '[USACO02FEB] 杂务'),
        cf('1851/E', 'Nastya and Potions'),
      ],
      },

      {
        id: 'graph-floyd',
        name: 'Floyd（多源最短路 / 传递闭包）',
        difficulty: 2,
        tags: ['图论', '最短路'],
        outline: 'dp[k][i][j] = 只经前 k 个中转点的最短路，k 必须在最外层；按「中转点开放时间」排序可处理动态加点。',
        examples: [
        lg('P1119', '灾后重建'),
        lg('P1522', '[USACO2.4] 牛的旅行 Cow Tours'),
        lg('P2910', '[USACO08OPEN] Clear And Present Danger S'),
        cf('601/A', 'The Two Routes'),
        cf('954/D', 'Fight Against Traffic'),
      ],
      },

      {
        id: 'graph-dijkstra',
        name: '堆优化 Dijkstra',
        difficulty: 3,
        tags: ['图论', '最短路', '堆'],
        outline: '小根堆 + done 惰性删除的写法；为什么负权边会使其出错。',
        examples: [
        lg('P4779', '【模板】单源最短路径（标准版）'),
        cf('20/C', 'Dijkstra?'),
        lg('P1629', '邮递员送信'),
        cf('1547/E', 'Air Conditioners'),
        cf('35/C', 'Fire Again'),
      ],
      },

      {
        id: 'graph-shortest-path-tree',
        name: '最短路径树与最短路计数',
        difficulty: 4,
        tags: ['最短路', '图论'],
        outline: '跑 Dijkstra 时只记录「第一个把 dist 放松到最优」的那条前驱边，n−1 条前驱边就构成最短路径树，树上路径即某一条最短路径。计数则在放松的同时挂 cnt：严格更短则继承 cnt，恰好相等则累加，最后对答案取模；边权为 0 时 Dijkstra 的松弛顺序不再唯一，要改成拓扑式处理或按层 BFS。',
        examples: [
        lg('P1144', '最短路计数'),
        lg('P1364', '医院设置'),
      ],
      },

      {
        id: 'graph-spfa',
        name: 'SPFA（判负环）',
        difficulty: 3,
        tags: ['图论', '最短路'],
        outline: '队列松弛框架 + 「入队次数 ≥ n 判负环」；何时会被卡到 O(nm)。',
        examples: [
        lg('P3385', '【模板】负环'),
        lg('P1938', '[USACO09NOV] Job Hunt S'),
        lg('P2850', '[USACO06DEC] Wormholes G'),
      ],
      },

      {
        id: 'graph-kruskal',
        name: 'Kruskal 最小生成树',
        difficulty: 3,
        tags: ['图论', '最小生成树', '并查集'],
        outline: '边排序 + 并查集判环 + 选满 n-1 条；不连通时的判定输出。',
        examples: [
        lg('P3366', '【模板】最小生成树'),
        lg('P1991', '无线通讯网'),
        lg('P2820', '局域网'),
        lg('P1111', '修复公路'),
      ],
      },

      {
        id: 'graph-euler',
        name: '欧拉路（Euler Path）',
        difficulty: 3,
        tags: ['图论', '欧拉路'],
        outline: '先按度数判存在性（无向图奇度点 0/2 个，有向图出入度平衡或差 1），Hierholzer 算法用栈倒序输出路径；「每条边至少走一遍」的最少花费先配平奇度点（中国邮路思路）。',
        examples: [
        lg('P7771', '【模板】欧拉路径'),
        lg('P2731', '[USACO3.3] 骑马修栅栏 Riding the Fences'),
        lg('P1341', '无序字母对'),
      ],
      },

      {
        id: 'graph-tournament',
        name: '竞赛图',
        difficulty: 3,
        tags: ['竞赛图', '图论'],
        outline: '每对点之间恰有一条有向边。两条必背结论：任意竞赛图都存在哈密顿路径（插入法归纳构造）；强连通竞赛图必有哈密顿回路。得分序列（出度序列）非降排列后满足 Landau 判据（前 k 项和 ≥ C(k,2) 且总和 = C(n,2)）才是可实现的。传递闭包 / 拓扑序在这类图上总能给出答案。',
        examples: [
        cf('27/B', 'Tournament'),
        lg('P3561', '[POI 2017] Turysta'),
        cf('850/D', 'Tournament Construction'),
        cf('323/B', 'Tournament-graph'),
      ],
      },

      {
        id: 'graph-diff-constraint',
        name: '差分约束',
        difficulty: 3,
        tags: ['图论', '最短路', '差分约束'],
        outline: '不等式统一成 x_i ≤ x_j + w 后建边跑最短路，超级源点保证连通；求最大解跑最长路、等式拆成两条。',
        examples: [
        lg('P5960', '【模板】差分约束'),
        lg('P1250', '种树'),
        lg('P1993', '小 K 的农场'),
      ],
      },

      {
        id: 'graph-layered',
        name: '分层图与拆点建模',
        difficulty: 4,
        tags: ['分层图'],
        outline: '状态多一维（剩余次数/时间/资源）就把 (u, t) 展开成新图分层跑最短路；「点/边至多用 k 次」拆成入点出点连容量边转网络流，注意连到入点还是出点。',
        examples: [
        lg('P4568', '[JLOI2011] 飞行路线'),
        lg('P2939', '[USACO09FEB] Revamping Trails G'),
      ],
      },

      {
        id: 'graph-boruvka',
        name: 'Boruvka 最小生成树',
        difficulty: 4,
        tags: ['Boruvka'],
        outline: '每轮为每个连通块各找一条连向外部的最小边再合并，轮数 O(log n)；完全图边权由点权按规律生成（异或/曼哈顿等）无法显式建边时的标准解法。',
        examples: [
        cf('888/G', 'Xor-MST'),
        cf('1242/B', '0-1 MST'),
      ],
      },

      {
        id: 'graph-second-mst',
        name: '严格次小生成树',
        difficulty: 4,
        tags: ['图论', '最小生成树', 'LCA'],
        outline: '枚举非树边 (u,v,w)，替换树上 u→v 路径中严格小于 w 的最大边权；倍增维护路径前两大值。',
        examples: [
        lg('P4180', '[BJWC2010] 严格次小生成树'),
        cf('609/E', 'Minimum spanning tree for each edge'),
      ],
      },

      {
        id: 'graph-hungarian',
        name: '匈牙利算法（二分图最大匹配）',
        difficulty: 4,
        tags: ['图论', '二分图', '匹配'],
        outline: '增广路递归腾位写法 + vis 每轮清空；matchR 下标方向（右 → 左）；König 定理三件套：最小点覆盖 = 最大匹配、最大独立集 = n − 最大匹配、最小边覆盖 = n − 最大匹配。要跑更快就上 Hopcroft-Karp（BFS 分层 + 多路增广，O(E√V)），稠密图或 n 上千时匈牙利会 TLE。',
        examples: [
        lg('P3386', '【模板】二分图最大匹配'),
        lg('P2756', '飞行员配对方案问题'),
        lg('P2055', '[ZJOI2009] 假期的宿舍'),
        lg('P1640', '[SCOI2010] 连续攻击游戏'),
        cf('1525/D', 'Armchairs'),
        cf('1437/C', 'Chef Monocarp'),
      ],
      },

      {
        id: 'graph-km',
        name: 'KM 算法（二分图最大权匹配）',
        difficulty: 4,
        tags: ['KM', '二分图', '匹配'],
        outline: '顶标 lx/ly 只允许匹配到满足 lx(x)+ly(y)=w(x,y) 的边（相等子图），先在相等子图里找增广路；找不到就把交错树覆盖到的顶标整体下调「最小的 lx+ly−w」，让至少一条新边进入相等子图再试。O(n³) 写法要背熟 slack 数组的增量维护，否则每次重扫会退化成 O(n⁴)。',
        examples: [
        lg('P6577', '【模板】二分图最大权完美匹配'),
      ],
      },

      {
        id: 'graph-blossom',
        name: '一般图最大匹配（带花树）',
        difficulty: 5,
        tags: ['带花树', '一般图匹配'],
        outline: '奇环会让匈牙利算法的增广路交替性失效，带花树把奇环整体缩成一朵「花」再交替树继续找路，找到外部点后逐层展开还原增广路。板子级代码，重点是 lca/merge/mark 三个子过程别写错，O(n³)。',
        examples: [
        lg('P6113', '【模板】一般图最大匹配'),
        lg('P4258', '[WC2016] 挑战NPC'),
      ],
      },

      {
        id: 'graph-tarjan-scc',
        name: 'Tarjan 缩点（强连通分量）',
        difficulty: 4,
        tags: ['图论', 'Tarjan', 'DAG'],
        outline: 'dfn/low 回溯收分量（栈内即当前 SCC），缩点后成 DAG；通常接拓扑 DP 求最长链、可达性或点权并。Kosaraju 两遍 DFS（正图完成序 + 反图染色）更好想也不易写错，代价是要建反图，作为对拍的另一份实现很合适。',
        examples: [
        lg('P3387', '【模板】缩点 / 强连通分量'),
        lg('P2341', '[USACO03FALL / HAOI2006] 受欢迎的牛 G'),
        lg('P2812', '校园网络 / [IOI 1996 / USACO5.3] 校园网 Network of Schools 加强版'),
      ],
      },

      {
        id: 'graph-cut',
        name: '割点与桥（无向图双连通）',
        difficulty: 4,
        tags: ['图论', 'Tarjan', '双连通'],
        outline: 'low 只用「子树 + 反向边」更新（不用父边）；割点 root 特判儿子数，边双/点双缩点后建分量树。',
        examples: [
        lg('P3388', '【模板】割点（割顶）'),
        lg('P2860', '[USACO06JAN] Redundant Paths G'),
        lg('P4320', '道路相遇'),
      ],
      },

      {
        id: 'graph-dominator',
        name: '支配树',
        difficulty: 4,
        tags: ['支配树', '图论'],
        outline: '以 s 为根跑 DFS 树，用半支配点 sdom(v) 与「路径上的最小 sdom」两次并查集压缩递推，Lengauer-Tarjan 求出每个点的直接支配者 idom，建成支配树。树上一条链就是必经点链，问「去掉哪些点 s 到 t 不连通」直接查 t 到根的路径。',
        examples: [
        cf('1864/I', 'Future Dominators'),
      ],
      },

      {
        id: 'graph-2sat',
        name: '2-SAT',
        difficulty: 4,
        tags: ['图论', '2-SAT'],
        outline: '「选 a 则必选 b」建单向边，Tarjan 求 SCC 后取分量编号（逆拓扑）当真值；x 与 ¬x 同分量即无解。',
        examples: [
        lg('P4782', '【模板】2-SAT'),
        lg('P4171', '[JSOI2010] 满汉全席'),
        cf('776/D', 'The Door Problem'),
        cf('468/B', 'Two Sets'),
        cf('1715/D', '2+ doors'),
      ],
      },

      {
        id: 'graph-dinic',
        name: 'Dinic 最大流',
        difficulty: 4,
        tags: ['图论', '网络流'],
        outline: 'BFS 分层 + DFS 沿层增广 + 当前弧优化，O(n²m)；反向边流量做抵消是整个算法的精髓，链式前向星异或配对；二元选择代价满足次模性时拆源汇连边直接转最小割。',
        examples: [
        lg('P3376', '【模板】网络最大流'),
        lg('P2764', '最小路径覆盖问题'),
        lg('P2762', '太空飞行计划问题'),
        lg('P1345', '[USACO5.4] 奶牛的电信 Telecowmunication'),
        cf('1214/D', 'Treasure Island'),
        cf('965/D', 'Single-use Stones'),
      ],
      },

      {
        id: 'graph-flow-bounds',
        name: '上下界网络流',
        difficulty: 5,
        tags: ['上下界网络流', '网络流'],
        outline: '每条边容量改成 [l,r] 后先给每个点记 demand=入下界和−出下界和，边容量降为 r−l，再连超级源→demand>0 的点、demand<0 的点→超级汇求「可行流」，跑满才算有解。有源汇时先补一条 T→S 的 [0,∞] 边化成循环流；求最大流就在可行流之后删掉这条边、再从 S 到 T 增广，求最小流则反过来从 T 到 S 退流。',
        examples: [
        lg('P3254', '圆桌问题'),
      ],
      },

      {
        id: 'graph-mcmf',
        name: '最小费用最大流（SSP）',
        difficulty: 4,
        tags: ['图论', '网络流', '费用流'],
        outline: '每次在残余图上 SPFA 找费用最短增广路，增广到满流为止；反向边费用取负保证可撤销。',
        examples: [
        lg('P3381', '【模板】最小费用最大流'),
        lg('P1251', '餐巾计划问题'),
        lg('P4016', '负载平衡问题'),
        lg('P4013', '数字梯形问题'),
        cf('653/D', 'Delivery Bears'),
      ],
      },

      {
        id: 'graph-global-mincut',
        name: '全局最小割与最小割树',
        difficulty: 4,
        tags: ['全局最小割', '最小割树', '网络流'],
        outline: 'Stoer-Wagner 每轮用 Prim 式「挑与已选集合连边总权最大」的点扩出一个割阶段，设最后加入的两点依次为 s、t，则本轮割权 = t 加入时它与已选集合的连边总权，取所有轮次的最小值即全局最小割，随后把 s、t 合并继续下一轮，无向图 O(n³)。要回答任意两点间最小割就把合并过程建成最小割树（Gomory-Hu），n−1 次网络流后树上路径的最小边权即为答案。',
        examples: [
        lg('P4897', '【模板】最小割树（Gomory-Hu Tree）'),
      ],
      },

      {
        id: 'graph-kth-path',
        name: 'k 短路',
        difficulty: 5,
        tags: ['图论', '最短路', 'A*'],
        outline: '反图跑终点最短路作为 h，正向堆按 g+h 弹出，第 k 次到达终点即 k 短路；限制弹出次数防内存爆炸。',
        examples: [
        lg('P2483', '【模板】k 短路 / [SDOI2010] 魔法猪学院'),
      ],
      },

      {
        id: 'graph-matrix-tree',
        name: '生成树计数（Matrix-Tree 定理）',
        difficulty: 5,
        tags: ['图论', '线性代数', '行列式'],
        outline: 'Kirchhoff 矩阵（度数 - 邻接）去掉任意一行一列，其行列式 = 生成树个数；模质数域用高斯消元，非质模换辗转相除消元。',
        examples: [
        lg('P4111', '[HEOI2015] 小 Z 的房间'),
        lg('P3317', '[SDOI2014] 重建'),
        lg('P4336', '[SHOI2016] 黑暗前的幻想乡'),
      ],
      },

      {
        id: 'graph-chu-liu',
        name: '朱刘算法（最小树形图）',
        difficulty: 5,
        tags: ['图论', '生成树'],
        outline: '每轮给除根外每个点选最小入边，出现环则整体缩点、入边权减去环内被替换边权后重跑；先判根可达所有点。',
        examples: [
        lg('P4716', '【模板】最小树形图'),
      ],
      },

      {
        id: 'graph-planar',
        name: '平面图判定与对偶图',
        difficulty: 5,
        tags: ['图论', '平面图', '2-SAT'],
        outline: '判定走「找哈密顿回路 + 圈内圈外边建 2-SAT 染色」的经典路线；对偶图把平面图最短路 ↔ 对偶图最小割互相转化。',
        examples: [
        lg('P3209', '[HNOI2010] 平面图判定'),
      ],
      },

      {
        id: 'graph-chordal',
        name: '区间图与弦图',
        difficulty: 5,
        tags: ['图论', '弦图', '完美消元'],
        outline: 'MCS 最大势搜索求完美消元序列判弦图，色数 = 最大团数、独立数 = 最小覆盖；区间图按右端点贪心即可直接建模。',
        examples: [
        lg('P14506', '【模板】弦图'),
        lg('P3196', '[HNOI2008] 神奇的国度'),
        lg('P3852', '[TJOI2007] 小朋友'),
      ],
      },
    ],
  },

  {
    key: 'tree',
    name: '树论',
    description: '直径、重心、LCA、树剖、点分治——把树上问题变成序列与子树问题的专属工具',
    templates: [
      {
        id: 'tree-diameter',
        name: '树的直径',
        difficulty: 3,
        tags: ['树上算法', '树的直径'],
        outline: '两次 DFS 或树形 DP（最长下行链 + 次长下行链拼过点路径）皆可，负权边只能用 DP 法；「直径中点」常是结论题入口。',
        examples: [
        lg('P3304', '[SDOI2013] 直径'),
        lg('P1099', '[NOIP 2007 提高组] 树网的核'),
      ],
      },

      {
        id: 'tree-centroid',
        name: '树的重心',
        difficulty: 3,
        tags: ['树上算法', '树的重心'],
        outline: '一次 DFS 求 max(最大子树, n-子树) 最小的点；重心性质（最大子树 ≤ n/2、换根时 O(1) 转移距离和）要能现场推导。',
        examples: [
        lg('P1364', '医院设置'),
        lg('P1395', '会议'),
        lg('P5536', '【XR-3】核心城市'),
        lg('P2986', '[USACO10MAR] Great Cow Gathering G'),
      ],
      },

      {
        id: 'tree-lca',
        name: '最近公共祖先（倍增）',
        difficulty: 3,
        tags: ['LCA', '倍增', '树上算法'],
        outline: '深度对齐后二进制上跳的倍增写法；配合树上差分可把路径统计降到 O(1) 标记 + O(n) 还原；k 点 LCA = dfn 相邻点的 LCA，两条链是否相交用四个两两 LCA 判定。',
        examples: [
        lg('P3379', '【模板】最近公共祖先（LCA）'),
        lg('P1967', '[NOIP 2013 提高组] 货车运输'),
        lg('P3128', '[USACO15DEC] Max Flow P'),
      ],
      },

      {
        id: 'tree-dfs-order',
        name: 'DFS 序与子树统计',
        difficulty: 3,
        tags: ['DFS序', '树状数组', '树上算法'],
        outline: '进出栈时间戳把子树映射成连续区间（tin/tout），子树修改查询即区间操作，接 BIT/线段树；换根的 delta 推导。括号序（进栈记点、出栈记负点）是它的可逆版本——两棵树的括号序相同即同构，LCA 也能退成 RMQ。',
        examples: [
        lg('P3178', '[HAOI2015] 树上操作'),
        lg('P2146', '[NOI2015] 软件包管理器'),
        lg('P3258', '[JLOI2014] 松鼠的新家'),
      ],
      },

      {
        id: 'tree-hash',
        name: '树的哈希（同构判定）',
        difficulty: 4,
        tags: ['树哈希', '树上算法'],
        outline: '自底向上把每棵子树压成一个整数：hs(u)=∏(hs(v)+p[size(v)])，按子树大小取不同质数乘起来，保证「儿子多重集相同才同构」。有根树直接比根的 hs；无根树要先找重心（或直径中点）当根，否则两棵同构树可能算出不同值。',
        examples: [
        cf('1800/G', 'Symmetree'),
      ],
      },

      {
        id: 'tree-hld',
        name: '树链剖分（重链剖分）',
        difficulty: 4,
        tags: ['树上算法', '树链剖分', '线段树'],
        outline: '重儿子优先分配 dfn 保证重链连续，任意路径拆成 O(log n) 段连续区间交给线段树；两次 DFS 维护 fa/son/top/dfn；边权信息挂到深度较深的端点转成点权。',
        examples: [
        lg('P3384', '【模板】重链剖分 / 树链剖分'),
        lg('P2590', '[ZJOI2008] 树的统计'),
        lg('P2680', '[NOIP 2015 提高组] 运输计划'),
      ],
      },

      {
        id: 'tree-long-chain',
        name: '长链剖分',
        difficulty: 5,
        tags: ['长链剖分', '树上算法'],
        outline: '把重链剖分的「选最大子树」换成「选深度最大的儿子」。关键性质：u 往下的第 k 条长链恰好覆盖 u 子树内深度比 u 大 k 的所有点，所以所有长链长度之和只有 O(n)；于是 f[u][k] 这种按深度开的二维数组可以让轻链复用长链尾部的缓冲区，总空间从 O(n²) 降到 O(n)。适合「距根恰为 k 的点数」「树上定长路径计数」这类按深度维度的 DP。',
        examples: [
        lg('P5904', '[POI 2014] HOT-Hotels 加强版'),
      ],
      },

      {
        id: 'tree-dsu-on-tree',
        name: '树上启发式合并',
        difficulty: 4,
        tags: ['树上启发式合并'],
        outline: '轻儿子的贡献算完即撤销、重儿子的贡献保留继承，每个点只被轻边扫 O(log n) 次；静态子树统计（无修改）用一次 DFS 全部答完，是「离线 + 好合并」类子树问题的首选。',
        examples: [
        cf('600/E', 'Lomsat gelral'),
        cf('570/D', 'Tree Requests'),
      ],
      },

      {
        id: 'tree-centroid-decomp',
        name: '点分治',
        difficulty: 5,
        tags: ['树上算法', '点分治', '分治'],
        outline: '每层选重心为根统计跨根路径再删根递归，共 O(log n) 层；容斥减去同子树路径防重复计数。点分树的版本（动态点分治）在重心树上前缀维护子树信息，可支持修改，常数与实现量都很大；边分治改成按边权中点拆（虚点重连后度数 ≤ 3），在「点对距离满足可合并关系」时比点分更好接 LCA。',
        examples: [
        lg('P3806', '【模板】点分治'),
        lg('P4178', 'Tree'),
        lg('P2634', '[国家集训队] 聪聪可可'),
      ],
      },

      {
        id: 'tree-edge-divide',
        name: '边分治',
        difficulty: 5,
        tags: ['边分治', '树上算法', '分治'],
        outline: '找一条「删掉后两侧点数都 ≤ n/2」的边拆开递归。直接枚举边不好找，先按度 > 2 的点挂虚边重构成二叉树（新边权 0、原边权 1），重心边就必然存在且好求。分治层用桶/树状数组按深度统计跨被拆边的点对，比点分治少一层容斥，代价是深度多算 1 要回扣。',
        examples: [
        lg('P4178', 'Tree'),
      ],
      },

      {
        id: 'tree-pseudo',
        name: '基环树（环套树）',
        difficulty: 4,
        tags: ['树上算法', '基环树'],
        outline: '找环、断环成「环 + 两棵树」分别处理后合并结果；n 条边的连通图先判定是不是基环树。',
        examples: [
        lg('P5022', '[NOIP 2018 提高组] 旅行'),
        lg('P2607', '[ZJOI2008] 骑士'),
        lg('P4381', '[IOI 2008] Island'),
      ],
      },

      {
        id: 'tree-virtual',
        name: '虚树',
        difficulty: 5,
        tags: ['树上算法', '虚树', 'LCA'],
        outline: '只保留关键点与其 LCA 的压缩树：关键点按 dfs 序排序、栈维护右链，相邻两点 LCA 判插入；原树 DP 搬到 O(k) 规模上跑。',
        examples: [
        lg('P2495', '【模板】虚树 / [SDOI2011] 消耗战'),
        lg('P4103', '[HEOI2014] 大工程'),
      ],
      },

      {
        id: 'tree-lct',
        name: 'Link-Cut-Tree（动态树）',
        difficulty: 5,
        tags: ['树上算法', 'LCT', 'splay'],
        outline: 'splay 维护偏好路径 + access 打通根到当前点的实链，makeroot 翻转、link/cut 换父是三个基本件；动态连边删边下的路径/子树信息靠它。',
        examples: [
        lg('P3690', '【模板】动态树（LCT）'),
        lg('P2147', '[SDOI2008] 洞穴勘测'),
      ],
      },

      {
        id: 'tree-cactus',
        name: '仙人掌（圆方树）',
        difficulty: 5,
        tags: ['树上算法', '仙人掌', '圆方树'],
        outline: '每条边至多属一个环的结构：Tarjan 建圆方树，环变方点；DP 遇到环先拆环成链（断一端枚举或两次 DP）再合并。',
        examples: [
        lg('P4244', '[SHOI2008] 仙人掌图 II'),
        lg('P5236', '【模板】静态仙人掌'),
      ],
      },
    ],
  },

  {
    key: 'math',
    name: '数学',
    description: '筛法、逆元、组合数、插值——数论与代数工具箱',
    templates: [
      {
        id: 'math-quick-pow',
        name: '快速幂（与龟速乘）',
        difficulty: 1,
        tags: ['数学', '快速幂', '取模'],
        outline: '指数二进制分解循环写法；中间乘法溢出时的 __int128 / 龟速乘；同一底数被海量取模求幂时光速幂（a^b = (a^B)^q·a^r 平方根分块预处理）。',
        examples: [
        lg('P1226', '【模板】快速幂'),
        lg('P1962', '斐波那契数列'),
        lg('P1593', '因子和'),
      ],
      },

      {
        id: 'math-sieve',
        name: '线性筛（素数 + 欧拉函数）',
        difficulty: 3,
        tags: ['数学', '筛法', '欧拉函数'],
        outline: '合数只被最小质因子筛掉一次的循环结构 + 欧拉函数两分支递推；顺手留一份最小质因子 minp 数组，q 次质因数分解从 O(q√V) 降到 O(V + q log V)。',
        examples: [
        lg('P3383', '【模板】线性筛素数'),
        lg('P2158', '[SDOI2008] 仪仗队'),
        lg('P1865', 'A % B Problem'),
        lg('P2568', 'GCD'),
      ],
      },

      {
        id: 'math-miller-rabin',
        name: 'Miller-Rabin 与 Pollard-Rho',
        difficulty: 4,
        tags: ['Miller-Rabin', 'Pollard-Rho', '素性测试'],
        outline: 'Miller-Rabin 用 a^(d·2^r)≡1 的二次探测定素性，long long 范围内取固定基底 {2,3,5,7,11,13,17,19,23,29,31,37} 即无假阳；Pollard-Rho 用 f(x)=x²+c 的迭代序列撞 gcd 找非平凡因子，配合龟速乘防溢出，递归分解后因子排序即可。',
        examples: [
        lg('P1075', '[NOIP 2012 普及组] 质因数分解'),
      ],
      },

      {
        id: 'math-exgcd',
        name: 'exgcd 与逆元',
        difficulty: 3,
        tags: ['数学', '数论', '逆元'],
        outline: '递归回溯求 ax+by=gcd 的系数（x/y 交换传参），逆元结果统一 (x % p + p) % p。',
        examples: [
        lg('P1082', '[NOIP 2012 提高组] 同余方程'),
        lg('P3811', '【模板】模意义下的乘法逆元'),
        lg('P1516', '[ZJOI2002] 青蛙的约会'),
        lg('P2613', '【模板】有理数取余'),
      ],
      },

      {
        id: 'math-comb',
        name: '组合数预处理（阶乘 + 逆元）',
        difficulty: 3,
        tags: ['数学', '组合计数'],
        outline: '阶乘 + 阶乘逆元线性预处理，C(a,b) O(1) 查询；适用前提模数为质数，除法取模可用 (N mod p·M)/M 规避先乘逆元。模数不是质数或干脆不取模时退回杨辉三角 O(n²) 递推 C(n,m)=C(n−1,m−1)+C(n−1,m)，慢但没有任何前提。',
        examples: [
        lg('P2822', '[NOIP 2016 提高组] 组合数问题'),
        lg('P4071', '[SDOI2016] 排列计数'),
        lg('P1313', '[NOIP 2011 提高组] 计算系数'),
      ],
      },

      {
        id: 'math-inc-exc',
        name: '容斥原理与 min-max 容斥',
        difficulty: 3,
        tags: ['容斥', '计数'],
        outline: '「至少/恰好/全不」三类问法靠 ±1 符号交替统一：枚举哪些约束被强制违反，贡献乘 (−1)^|S|。min-max 容斥把「最早命中」换成「最后命中」的期望差，是处理「集齐所有」类期望题的标准一步。',
        examples: [
        lg('P2167', '[SDOI2009] Bill的挑战'),
      ],
      },

      {
        id: 'math-sequences',
        name: '卡特兰数、错排、斯特林数与拆分数',
        difficulty: 2,
        tags: ['卡特兰数', '组合计数'],
        outline: '四个必背递推/通项：卡特兰 C(n)=C(2n,n)/(n+1)（合法括号、出栈序列、凸多边形划分、不越过对角线路径）；错排 D(n)=(n−1)(D(n−1)+D(n−2))；第二类斯特林 S(n,k)=k·S(n−1,k)+S(n−1,k−1)（n 个有标号球放进 k 个无标号非空盒）；整数拆分数用一维完全背包型递推。模数不质数时卡特兰要退化成质因数分解计数。',
        examples: [
        lg('P1044', '[NOIP 2003 普及组] 栈'),
        lg('P2181', '对角线'),
        lg('P4841', '[集训队作业2013] 城市规划'),
      ],
      },

      {
        id: 'math-prufer',
        name: 'Prüfer 序列',
        difficulty: 4,
        tags: ['Prüfer 序列', '计数'],
        outline: 'n 个标号点的无根树与长度 n−2 的标号序列一一对应：每次删编号最小的叶子记录父亲，还原时每次取「未出现的最小标号」当叶子。度数 = 出现次数 + 1 这一条就推出 Cayley 公式 n^(n−2)，也是所有「给定度数序列求树数」「带限制标号树计数」的入口。',
        examples: [
        lg('P2290', '[HNOI2004] 树的计数'),
      ],
      },

      {
        id: 'math-euler-theorem',
        name: '欧拉定理与降幂',
        difficulty: 3,
        tags: ['数学', '欧拉函数', '取模'],
        outline: 'a^b ≡ a^(b mod φ(p))（mod p，gcd(a,p)=1）；扩展欧拉定理对 b ≥ φ(p) 分层处理，配合快速幂实现指数降幂。',
        examples: [
        lg('P5091', '【模板】扩展欧拉定理'),
        lg('P4139', '上帝与集合的正确用法'),
      ],
      },

      {
        id: 'math-primitive-root',
        name: '原根与指数',
        difficulty: 4,
        tags: ['原根', '数论'],
        outline: '模 m 简化剩余系里阶等于 φ(m) 的元素就是原根，它把乘法群同构到加法群（于是乘法变加法、离散对数可查表）。求法：枚举 g 从 2 起，对 φ(m) 的每个质因子 p 验证 g^(φ(m)/p) ≢ 1 (mod m)；只有 2、4、p^k、2p^k（p 为奇素数）这些模数存在原根。NTT 的 n 次单位根就是素数模下原根的 g^((p−1)/n)，前提 n | p−1。',
        examples: [
        cf('284/A', 'Cows and Primitive Roots'),
      ],
      },

      {
        id: 'math-lucas',
        name: '卢卡斯定理',
        difficulty: 3,
        tags: ['数学', '组合计数'],
        outline: '模小质数 p 时 C(n,m) 按 p 进制逐位相乘，组合数只需预处理到 p-1；mod 2 特例 (n&m)==m 即奇，可直接 O(1) 判定。不互质模数走 exLucas 拆质因数。',
        examples: [
        lg('P3807', '【模板】卢卡斯定理 / Lucas 定理'),
        lg('P4345', '[SHOI2015] 超能粒子炮·改'),
        lg('P2480', '[SDOI2010] 古代猪文'),
      ],
      },

      {
        id: 'math-game-theory',
        name: '博弈论基础',
        difficulty: 3,
        tags: ['博弈论', '数学'],
        outline: 'Nim：各堆异或和非零先手必胜；巴什：n % (m+1) != 0 先手必胜；威佐夫：d = (b-a)·(√5+1)/2 与 min(a,b) 比较；SG：SG(x)=mex{后继SG}，多子游戏取异或和。',
        examples: [
        lg('P2197', '【模板】Nim 游戏'),
        lg('P2252', '【模板】威佐夫博弈 / [SHOI2002] 取石子游戏'),
        lg('P1247', '取火柴游戏'),
        lg('P1290', '欧几里德的游戏'),
        cf('276/B', 'Little Girl and Game'),
        cf('2239/A', 'Nim Game Is XOR Game'),
      ],
      },

      {
        id: 'math-crt',
        name: '中国剩余定理（CRT / EXCRT）',
        difficulty: 4,
        tags: ['数学', '同余方程'],
        outline: '互质模数直接合并余数；不互质用 EXCRT 两两合并同余方程，exgcd 解 ax ≡ c (mod m) 时注意无解判定与最小非负解。',
        examples: [
        lg('P1495', '【模板】中国剩余定理（CRT）/ 曹冲养猪'),
        lg('P4777', '【模板】扩展中国剩余定理（EXCRT）'),
        lg('P4774', '[NOI2018] 屠龙勇士'),
        cf('919/E', 'Congruence Equation'),
        cf('1500/B', 'Two chandeliers'),
      ],
      },

      {
        id: 'math-matrix-pow',
        name: '矩阵快速幂',
        difficulty: 4,
        tags: ['数学', '矩阵', '快速幂'],
        outline: '矩阵乘法（k 外层 + 稀疏剪枝）与单位阵初始化的快速幂；线性递推转矩阵的思想，固定边数的最短路/可达把普通乘法换成 min-plus / 布尔乘法照样快速幂。',
        examples: [
        lg('P3390', '【模板】矩阵快速幂'),
        lg('P1962', '斐波那契数列'),
        lg('P1939', '矩阵加速（数列）'),
        lg('P3193', '[HNOI2008] GT考试'),
        cf('691/E', 'Xor-sequences'),
        cf('222/E', 'Decoding Genome'),
      ],
      },

      {
        id: 'math-gauss',
        name: '高斯消元',
        difficulty: 3,
        tags: ['数学', '线性代数'],
        outline: '列主元消元 + 回代解线性方程组；用 eps 判无解/无穷解，01 异或方程组按 bit 消元且行数 = 状态维数。同一次消元顺手把增广矩阵左边换成单位矩阵就得到逆矩阵，判行列式则只看主元乘积（换行变号）。',
        examples: [
        lg('P3389', '【模板】高斯消元法'),
        lg('P2455', '[SDOI2006] 线性方程组'),
        lg('P2447', '[SDOI2010] 外星千足虫'),
      ],
      },

      {
        id: 'math-berlekamp-massey',
        name: 'BM 算法与常系数线性递推',
        difficulty: 4,
        tags: ['BM', '线性递推'],
        outline: 'BM 在模素数下从数列前若干项在线求出最短线性递推式（每次用上一条失败转移序列修正 discrepancy）；拿到 k 阶递推后用多项式快速幂/线性递推第 n 项把 O(n) 降到 O(k²log n) 或 NTT 版 O(k log k log n)。',
        examples: [
        lg('P4723', '【模板】常系数齐次线性递推'),
      ],
      },

      {
        id: 'math-binomial-inversion',
        name: '二项式反演',
        difficulty: 4,
        tags: ['二项式反演'],
        outline: '「恰好 k 个满足」= Σ (-1)^{k-i} C(k,i)·「钦定 i 个满足」——把难算的恰好计数换成好算的钦定/至少计数再容斥回来；注意钦定后剩余对象仍自由。',
        examples: [
        lg('P4859', '已经没有什么好害怕的了'),
        lg('P4491', '[HAOI2018] 染色'),
      ],
      },

      {
        id: 'math-linear-basis',
        name: '线性基',
        difficulty: 4,
        tags: ['数学', '位运算', '线性基'],
        outline: '按最高位插入消元维护一组异或基，支持查最大异或值/第 k 小/判可达；两个基的合并就是逐个插入，O(log²)。',
        examples: [
        lg('P3812', '【模板】线性基'),
        cf('1100/F', 'Ivan and Burgers'),
        lg('P4151', '[WC2011] 最大 XOR 和路径'),
      ],
      },

      {
        id: 'math-lagrange',
        name: '拉格朗日插值',
        difficulty: 4,
        tags: ['数学', '多项式'],
        outline: 'n+1 个点唯一确定 n 次多项式；横坐标连续（1..k+1）时用前缀/后缀积把求单点值降到 O(n)。',
        examples: [
        lg('P4781', '【模板】拉格朗日插值'),
        cf('622/F', 'The Sum of the k-th Powers'),
      ],
      },

      {
        id: 'math-ogf',
        name: '生成函数（OGF / EGF）',
        difficulty: 5,
        tags: ['生成函数', '多项式', '组合计数'],
        outline: '把数列装进形式幂级数，组合构造逐项对应：序列 = 1/(1−A)、无序选取 = 乘积、有标号结构用 EGF（乘积对应「划分成两个有标号子集」）。计数题先写出生成函数再用多项式求逆 / ln / exp / sqrt 算出前 n 项。注意区分「有标号用 EGF、无标号用 OGF」，用错会差一个 n!。',
        examples: [
        lg('P4389', '付公主的背包'),
      ],
      },

      {
        id: 'math-bsgs',
        name: 'BSGS（大步小步）',
        difficulty: 4,
        tags: ['数学', '同余方程', 'BSGS'],
        outline: '分块 a^⌈√p⌉ 哈希查表解 a^x ≡ b (mod p)，O(√p)；a 与 p 不互质时先 exBSGS 逐步归一 gcd 再转互质情形。',
        examples: [
        lg('P3846', '【模板】BSGS / [TJOI2007] 可爱的质数'),
        lg('P4195', '【模板】扩展 BSGS / exBSGS'),
        lg('P4884', '多少个 1？'),
      ],
      },

      {
        id: 'math-lgv',
        name: 'LGV 引理',
        difficulty: 5,
        tags: ['LGV 引理'],
        outline: 'DAG 上 k 条两两不交路径组带符号计数 = 路径条数矩阵的行列式；平面网格上起点终点顺序固定时符号恒正，直接建矩阵求 det。',
        examples: [
        lg('P6657', '【模板】LGV 引理'),
        lg('P7736', '[NOI2021] 路径交点'),
      ],
      },

      {
        id: 'math-mobius',
        name: '莫比乌斯反演',
        difficulty: 5,
        tags: ['数学', '莫比乌斯反演', '数论分块'],
        outline: 'F = f * 1 时 f(n) = Σ μ(d)·F(n/d)；套路是交换枚举顺序把「统计 gcd 为定值」转成「整除值域分段」，配合数论分块；「枚举因数/倍数」的 DP 本质就是 Dirichlet 卷积。',
        examples: [
        lg('P2522', '[HAOI2011] Problem b'),
        lg('P3455', '[POI 2007] ZAP-Queries'),
        lg('P2257', 'YY的GCD'),
      ],
      },

      {
        id: 'math-floor-sum',
        name: '类欧几里得（floor 和）',
        difficulty: 4,
        tags: ['类欧几里得', '数论'],
        outline: '求 f(a,b,c,n)=Σ_{i=0..n}⌊(ai+b)/c⌋ 以及同族的 Σ i⌊…⌋、Σ⌊…⌋²。做法是把求和看成「斜率直线下方的整点数」，用一次几何对偶（交换求和轴、对矩形做平移与转置）得到与 a、c 互换的递归式，每层 (a,c)→(c mod a, a)，形态与欧几里得一样，O(log max(a,c))。是 AtCoder practice2_i 那一类题的正解。',
        examples: [
        lg('P5170', '【模板】类欧几里德算法'),
        lg('P5171', 'Earthquake'),
      ],
      },

      {
        id: 'math-sieve-advanced',
        name: '杜教筛与 min_25 筛',
        difficulty: 5,
        tags: ['杜教筛', 'min_25 筛', '数论分块'],
        outline: '杜教筛：挑一个好算前缀和的 g 使 f*g 也好算，用 S(n)=(Σ(f*g)−Σ_{d≥2}g(d)S(⌊n/d⌋))/g(1) 配整除分块 + 哈希表记忆化，先把前 n^(2/3) 线性筛出来，复杂度 O(n^(2/3))。min_25 筛则处理 f(p) 是关于 p 的低次多项式、且可扩展成完全积性的 Σ_{p≤n}f(p)，把质数求和拆成「合数按最小质因子分类」的递归。前置是狄利克雷卷积 (f*g)(n)=Σ_{d|n}f(d)g(n/d)：莫比乌斯 μ 是 1 的卷积逆，很多恒等式（Σ_{d|n}φ(d)=n 即 φ*1=id）一句话就能推出来。',
        examples: [
        lg('P3768', '简单的数学题'),
      ],
      },

      {
        id: 'math-fft',
        name: 'FFT / NTT',
        difficulty: 5,
        tags: ['数学', 'FFT', '多项式'],
        outline: '分治蝶形在系数/点值表示间 O(n log n) 互化；NTT 用原根替代单位根避免精度问题，注意长度补到 2 的幂。',
        examples: [
        lg('P3803', '【模板】多项式乘法（FFT）'),
        lg('P3723', '[AHOI2017/HNOI2017] 礼物'),
        lg('P4238', '【模板】多项式乘法逆'),
        cf('993/E', 'Nikita and Order Statistics'),
        cf('1342/E', 'Placing Rooks'),
      ],
      },

      {
        id: 'math-fwt',
        name: 'FWT 与 FMT（集合幂级数）',
        difficulty: 4,
        tags: ['FWT', 'FMT', '集合幂级数'],
        outline: '对子集卷积 / 超集卷积 / 对称差（异或）卷积做点值化：FMT 是「含该位则加上不含该位的那份」的 O(n·2ⁿ) 变换，FWT-AND / OR / XOR 各自有正逆变换与对应的逐点乘规则，XOR 版要记得除 2 归一。子集和（SOS）就是 FMT-AND 的另一种叫法；卷积结果只对「恰好不相交」成立时还要按 popcount 分维做子集卷积。',
        examples: [
        lg('P4717', '【模板】快速莫比乌斯 / 沃尔什变换 (FMT / FWT)'),
      ],
      },

      {
        id: 'math-polya',
        name: 'Pólya 定理与置换群',
        difficulty: 5,
        tags: ['数学', '置换群', '组合计数'],
        outline: '在置换群下计不等价染色数：等价类数 = 各置换不动点数的平均，不动点数由循环节个数决定（c^轮数）。Burnside 是它的一般形式（群元个数取平均、Polya 再把 c^轮数 换成权值和），只问「不等价方案数」时用 Burnside 更短；轮数用置换的 gcd 结构 O(√n) 算出来。',
        examples: [
        lg('P4980', '【模板】Pólya 定理'),
        lg('P1446', '[HNOI2008] Cards'),
      ],
      },

      {
        id: 'math-simpson',
        name: '自适应辛普森积分',
        difficulty: 5,
        tags: ['数学', '数值积分'],
        outline: '二次插值近似定积分，中点二分递归、|左右和 - 整段| 足够小才接受；先确认被积函数可计算再谈精度。',
        examples: [
        lg('P4525', '【模板】自适应辛普森法 1'),
        lg('P4526', '【模板】自适应辛普森法 2'),
      ],
      },

      {
        id: 'math-simplex',
        name: '单纯形（线性规划）',
        difficulty: 5,
        tags: ['数学', '线性规划', '单纯形'],
        outline: '标准型上选入基/出基变量转轴迭代，pivot 选取防死循环；对偶转化（不等式组 ↔ 变量上下界）常比直接建模好写。',
        examples: [
        lg('P3980', '[NOI2008] 志愿者招募'),
      ],
      },
    ],
  },

  {
    key: 'string',
    name: '字符串',
    description: 'KMP、哈希、Trie——文本处理三件套加回文/匹配进阶',
    templates: [
      {
        id: 'str-hash',
        name: '字符串哈希',
        difficulty: 2,
        tags: ['字符串', '哈希'],
        outline: '前缀哈希 + 幂次数组的 O(1) 子串截取公式；自然溢出 vs 双哈希的取舍。',
        examples: [
        lg('P3370', '【模板】字符串哈希'),
        cf('1200/E', 'Compress Words'),
        lg('P4391', '[BalticOI 2009] Radio Transmission 无线传输'),
        cf('1849/C', 'Binary String Copying'),
        cf('1536/C', 'Diluc and Kaeya'),
      ],
      },

      {
        id: 'str-trie',
        name: 'Trie（字典树）',
        difficulty: 2,
        tags: ['字符串', 'Trie'],
        outline: '静态数组儿子表 + 插入/查询框架；空间按 26 × 总字符数估算。',
        examples: [
        lg('P2580', '于是他错误的点名开始了'),
        lg('P1481', '魔族密码'),
      ],
      },

      {
        id: 'str-kmp',
        name: 'KMP',
        difficulty: 3,
        tags: ['字符串', 'KMP'],
        outline: 'nxt 数组构建 + 主串匹配双循环；可重叠计数时失配后 j = nxt[j-1]。',
        examples: [
        lg('P3375', '【模板】KMP'),
        lg('P4391', '[BalticOI 2009] Radio Transmission 无线传输'),
        lg('P3435', '[POI 2006] OKR-Periods of Words'),
      ],
      },

      {
        id: 'str-z-function',
        name: 'Z 函数（扩展 KMP）',
        difficulty: 4,
        tags: ['字符串'],
        outline: '维护最右匹配段 [l,r] + z[i-l] 继承；拼接分隔符求模式匹配。',
        examples: [
        lg('P5410', '【模板】扩展 KMP / exKMP（Z 函数）'),
        cf('1200/E', 'Compress Words'),
      ],
      },

      {
        id: 'str-minimal-rotation',
        name: '最小表示法',
        difficulty: 3,
        tags: ['字符串', '最小表示法'],
        outline: '双指针比较循环同构串，失配时按结果 i += k+1 跳过整段，均摊线性求最小循环起点。',
        examples: [
        lg('P1368', '工艺'),
      ],
      },

      {
        id: 'str-lyndon',
        name: 'Lyndon 分解（Duval 算法）',
        difficulty: 4,
        tags: ['Lyndon 分解', '字符串'],
        outline: 'Lyndon 词 = 严格小于自己所有非平凡后缀的串；Duval 用 i/j/k 三个指针一遍扫把串分解成 s₁s₂…sₜ（sᵢ ≥ sᵢ₊₁ 且每个都是 Lyndon 词），O(n) 且只用常数额外空间。最小表示法、最小后缀、以及「至少改几个字符使串最小」这类题都直接套这个分解。',
        examples: [
        lg('P6114', '【模板】Lyndon 分解'),
      ],
      },

      {
        id: 'str-01trie',
        name: '01-Trie（异或极值）',
        difficulty: 3,
        tags: ['Trie', '位运算', '字符串'],
        outline: '数值按二进制高位到低位建 Trie，异或最大值在树上贪心走相反分支；配合前缀异或可查任意区间极值。',
        examples: [
        lg('P4551', '最长异或路径'),
        cf('706/D', 'Vasiliy\'s Multiset'),
        lg('P4735', '最大异或和'),
      ],
      },

      {
        id: 'str-manacher',
        name: 'Manacher（最长回文）',
        difficulty: 4,
        tags: ['字符串', '回文'],
        outline: '插 # 统一奇偶 + 镜像继承半径 + 右边界外暴力扩展；原串/新串下标换算。',
        examples: [
        lg('P3805', '【模板】Manacher'),
        lg('P4555', '[国家集训队] 最长双回文串'),
        lg('P1659', '[国家集训队] 拉拉队排练'),
        lg('P4287', '[SHOI2011] 双倍回文'),
      ],
      },

      {
        id: 'str-ac-automaton',
        name: 'AC 自动机',
        difficulty: 4,
        tags: ['字符串', 'AC自动机', 'Trie'],
        outline: 'Trie 上 BFS 建 fail 指针（指向最长真后缀），匹配时沿 fail 跳跃统计；本质是多模式串版 KMP。',
        examples: [
        lg('P3808', 'AC 自动机（简单版）'),
        lg('P3796', 'AC 自动机（简单版 II）'),
        lg('P5357', '【模板】AC 自动机'),
        lg('P2444', '[POI 2000 R1] 病毒'),
        cf('633/C', 'Spy Syndrome 2'),
        cf('514/C', 'Watto and Mechanism'),
      ],
      },

      {
        id: 'str-suffix-array',
        name: '后缀数组（倍增构造）',
        difficulty: 4,
        tags: ['字符串', '后缀数组'],
        outline: '倍增 + 基数排序双关键字 O(n log n)；height[i] 为相邻排名后缀的 LCP，h[i] ≥ h[i-1]-1 保证均摊线性。',
        examples: [
        lg('P3809', '【模板】后缀排序'),
        lg('P2408', '不同子串个数'),
        lg('P2870', '[USACO07DEC] Best Cow Line G'),
        cf('432/D', 'Prefixes and Suffixes'),
      ],
      },

      {
        id: 'str-sam',
        name: '后缀自动机（SAM）',
        difficulty: 5,
        tags: ['字符串', '后缀自动机'],
        outline: '增量构造维护 len/link（endpos 等价类），子串个数 = Σ(len(v)-len(link(v)))；parent 树上 DP 是绝大多数题的后续。',
        examples: [
        lg('P3804', '【模板】后缀自动机（SAM）'),
        lg('P4070', '[SDOI2016] 生成魔咒'),
        lg('P3975', '[TJOI2015] 弦论'),
        cf('427/D', 'Match & Catch'),
      ],
      },

      {
        id: 'str-pam',
        name: '回文自动机（PAM）',
        difficulty: 5,
        tags: ['字符串', '回文', '回文自动机'],
        outline: '每加一个字符至多新增一个本质不同回文节点，fail 指向最长回文后缀；以节点回文长度/出现次数为状态做统计。',
        examples: [
        lg('P5496', '【模板】回文树 / 回文自动机（PAM）'),
        lg('P3649', '[APIO2014] 回文串'),
        lg('P4287', '[SHOI2011] 双倍回文'),
      ],
      },
    ],
  },

  {
    key: 'geo',
    name: '计算几何',
    description: '叉积定向、凸包、半平面交——几何题的常用工具箱',
    templates: [
      {
        id: 'geo-cross',
        name: '点积 / 叉积与方向判定',
        difficulty: 2,
        tags: ['计算几何'],
        outline: '叉积符号 = 旋转方向的原语地位；全程整型避免精度问题的坐标约定；任意多边形有向面积用鞋带公式（∑ 交叉项），几何中心 = 各三角形有向面积加权平均。',
        examples: [
        lg('P1183', '多边形的面积'),
        lg('P2742', '【模板】二维凸包 / [USACO5.1] 圈奶牛Fencing the Cows'),
      ],
      },

      {
        id: 'geo-manhattan-chebyshev',
        name: '曼哈顿与切比雪夫距离互转',
        difficulty: 2,
        tags: ['曼哈顿距离', '切比雪夫距离'],
        outline: '(x, y) → (x+y, x−y) 的 45° 旋转使 |Δx|+|Δy| = max(|Δx′|,|Δy′|)，曼哈顿最值转成切比雪夫最值；多维绝对值和类问题先试符号展开/旋转。',
        examples: [
        lg('P5098', '[USACO04OPEN] Cave Cows 3'),
      ],
      },

      {
        id: 'geo-pick',
        name: 'Pick 定理与格点计数',
        difficulty: 2,
        tags: ['计算几何', '数学'],
        outline: 'S = a + b/2 - 1（a 内部格点、b 边上格点），边上格点数 = gcd(|dx|, |dy|)；三角形容斥算多边形。',
        examples: [
        lg('P2735', '[USACO3.4] 网 Electric Fences'),
        lg('P1183', '多边形的面积'),
      ],
      },

      {
        id: 'geo-convex-hull',
        name: '凸包（Andrew 单调链）',
        difficulty: 3,
        tags: ['计算几何', '凸包'],
        outline: '排序去重 + 下链/上链两遍扫（叉积 ≤0 弹栈）；共线点保留与否的选择。',
        examples: [
        lg('P2742', '【模板】二维凸包 / [USACO5.1] 圈奶牛Fencing the Cows'),
        cf('166/B', 'Polygons'),
      ],
      },

      {
        id: 'geo-rotating-calipers',
        name: '旋转卡壳（最远点对）',
        difficulty: 3,
        tags: ['计算几何', '凸包'],
        outline: '在凸包上维护对踵点双指针：固定一条边移动第三点，叉积单峰所以均摊线性；先求凸包是前提。',
        examples: [
        lg('P1452', '[USACO03FALL] Beauty Contest G'),
      ],
      },

      {
        id: 'geo-point-in-polygon',
        name: '点在多边形内（射线法）',
        difficulty: 3,
        tags: ['计算几何'],
        outline: '奇偶穿越法 + 半开区间约定处理顶点穿越；点在边上的单独判定。',
        examples: [
        lg('P1355', '神秘大三角'),
        lg('P3738', '[HAOI2014] 穿越封锁线'),
        lg('P8645', '[蓝桥杯 2016 国 B] 广场舞'),
      ],
      },

      {
        id: 'geo-circle',
        name: '圆与直线/圆的交点、切线与面积交并',
        difficulty: 3,
        tags: ['计算几何', '圆'],
        outline: '全套只用两个量：圆心到直线的距离 d 和半径。d=r 判切、d<r 用垂足±沿方向·√(r²−d²) 求交点；两圆按 |r₁−r₂| 与 r₁+r₂ 分内含/内切/相交/外切/相离，公切线条数同判；面积交用两弓形相减，多圆面积并可直接随机化或扫描线。所有比较用 eps 而不是 ==。',
        examples: [
        cf('600/D', "Area of Two Circles' Intersection"),
      ],
      },

      {
        id: 'geo-min-circle',
        name: '最小圆覆盖（Welzl 算法）',
        difficulty: 4,
        tags: ['最小圆覆盖', '计算几何'],
        outline: '随机增量：把点打乱后逐个加入，新点落在当前圆外时，它必然在答案边界上，退化成「两点定圆」；再加一层循环处理「两点在边界」，最后三点定圆就是外接圆。期望 O(n)，边界情况（共线、重合点）要在增量循环里显式判掉。',
        examples: [
        lg('P1742', '最小圆覆盖'),
      ],
      },

      {
        id: 'geo-scanline',
        name: '扫描线（矩形面积并）',
        difficulty: 4,
        tags: ['计算几何', '线段树', '扫描线'],
        outline: '按 y 排序上下边事件，线段树维护 x 轴覆盖长度；只算不散播的「覆盖长度」无需 pushdown。',
        examples: [
        lg('P5490', '【模板】扫描线 & 矩形面积并'),
        lg('P1856', '[IOI 1998 / USACO5.5] 矩形周长 Picture'),
        lg('P1904', '天际线'),
      ],
      },

      {
        id: 'geo-point-location',
        name: '点定位与 Voronoi 图',
        difficulty: 5,
        tags: ['点定位', 'Voronoi 图', '计算几何'],
        outline: '点定位：把平面剖分成梯形（Sweep 建梯形图）后逐层二分下降，O(n log n) 建、O(log n) 查，是「给很多点问落在哪个多边形/哪个区域」的标准结构。Voronoi 图是它的对偶问题——n 个点的最近点划分，边数 ≤ 3n−6，可用随机增量（和最小圆覆盖同一套框架）或半平面交（每个点对的垂直平分半平面）求；Delaunay 三角剖分是其对偶，空圆性质是判据。',
        examples: [
        lg('P4073', '[WC2013] 平面图'),
        lg('P2588', '[ZJOI2008] Risk'),
        lg('P6505', 'Run Away'),
      ],
      },

      {
        id: 'geo-half-plane',
        name: '半平面交',
        difficulty: 4,
        tags: ['计算几何', '半平面交'],
        outline: '按极角排序后双端队列维护有效半平面（叉积判淘汰）；平行同向取更紧的一条、反向则无交。',
        examples: [
        lg('P4196', '【模板】半平面交 / [CQOI2006] 凸多边形'),
        lg('P2600', '[ZJOI2008] 瞭望塔'),
      ],
      },
    ],
  },

  {
    key: 'misc',
    name: 'STL 与杂项',
    description: 'STL 容器、位运算、高精度与离线分治——赛场上随取随用的通用工具',
    templates: [
      {
        id: 'misc-stl',
        name: 'STL 容器速用（map / set / priority_queue / deque）',
        difficulty: 1,
        tags: ['STL'],
        outline: 'map/set 的 lower_bound/erase 迭代器陷阱、multiset 只删一个的正确写法、deque 两端 O(1) 的适用边界。pbds（__gnu_pbds 的 tree / priority_queue / cc_hash_table）能当 order_statistics_tree 用，直接查第 k 小与排名，但常数大且不能删除重复键，赛场要先确认评测机支持。',
        examples: [
        lg('P1449', '后缀表达式'),
        lg('P1177', '【模板】排序'),
        lg('P1059', '[NOIP 2006 普及组] 明明的随机数'),
        lg('P1093', '[NOIP 2007 普及组] 奖学金'),
      ],
      },

      {
        id: 'misc-bitwise',
        name: '位运算技巧',
        difficulty: 1,
        tags: ['位运算'],
        outline: 'lowbit、popcount、枚举子集 s = (s-1) & S 的循环写法；「按位拆贡献」独立统计每一位是通用思考方式；1..n 连续异或和按 n%4 四循环可直接 O(1)。',
        examples: [
        lg('P2114', '[NOI2014] 起床困难综合症'),
        lg('P1469', '找筷子'),
        lg('P5657', '[CSP-S 2019] 格雷码'),
        cf('1514/B', 'AND 0, Sum Big'),
        cf('1420/B', 'Rock and Lever'),
      ],
      },

      {
        id: 'misc-bignum',
        name: '高精度',
        difficulty: 2,
        tags: ['高精度'],
        outline: 'vector 按位存十进制（或压 9 位省内存）实现加减乘除：进借位方向、除法的高位试商与商前导零。',
        examples: [
        lg('P1601', '高精度加法'),
        lg('P1303', 'A*B Problem'),
        lg('P2142', '高精度减法'),
        lg('P1009', '[NOIP 1998 普及组] 阶乘之和'),
      ],
      },

      {
        id: 'misc-table-cast',
        name: '打表与卡常',
        difficulty: 2,
        tags: ['打表', '卡常', '技巧'],
        outline: '打表：本地暴力 + 脚本生成答案数组直接查表（分段打表控制代码长度）；卡常：快读、减少取模、循环展开、内存连续访问。',
        examples: [
        lg('P10508', '质因子'),
        lg('B3615', '测测你的矩阵乘法'),
        lg('P1366', '有序表的合并'),
      ],
      },

      {
        id: 'misc-permutation',
        name: '置换与置换环',
        difficulty: 3,
        tags: ['置换环'],
        outline: '「任意交换/按规则交换」先抽象成置换：最少交换次数 = n − 环数、交换奇偶性 = n − 环数的奇偶；目标是把给定排列变成目标置换时从环上拆解。',
        examples: [
        lg('P8637', '[蓝桥杯 2016 省 B] 交换瓶子'),
      ],
      },

      {
        id: 'misc-bitset',
        name: 'bitset 压位优化',
        difficulty: 4,
        tags: ['bitset', '位运算'],
        outline: '把布尔转移并行化，可达性/背包计数等 O(n²) 过程整体除以 64；左移位数超类型宽度是未定义行为，需分段。',
        examples: [
        lg('P4141', '消失之物'),
        lg('P3674', '小清新人渣的本愿'),
      ],
      },

      {
        id: 'misc-cdq-whole',
        name: 'CDQ 分治与整体二分',
        difficulty: 5,
        tags: ['分治', '离线', 'CDQ分治'],
        outline: 'CDQ：左半的修改贡献给右半的查询，三维偏序逐维消去；整体二分：操作序列与值域同时二分，离线求第 k 大类问题。',
        examples: [
        lg('P3810', '【模板】三维偏序 / 陌上花开'),
        lg('P3527', '[POI 2011] MET-Meteors'),
      ],
      },
    ],
  },
];

export const TEMPLATE_TOTAL = CURRICULUM.reduce((n, c) => n + c.templates.length, 0);
