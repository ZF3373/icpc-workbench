# PTA（拼题A）平台接入

日期：2026-11-09

## 背景

用户在 PTA（[pintia.cn](https://pintia.cn)，浙江大学运维的拼题A）上刷 PAT 甲/乙/顶级、团体程序设计天梯赛、
以及学校课程题集，但这些记录一直进不了本应用。PTA 没有公开 API 文档，早期的判断（「无公开接口」）是基于
「找不到文档」而不是「实测过」——这次逐接口实测后接入。

## 实测结论（2026-11，全部为线上真实响应）

| 接口 | 匿名 | 说明 |
| --- | --- | --- |
| `GET /api/problem-sets/always-available` | ✅ | 23 套公开题集（PAT 甲/乙/顶级练习集、天梯赛练习集、浙大版教材题集、ZOJ 题库…） |
| `GET /api/problem-sets?filter={"endAtAfter":...}` | ❌ 401 | 「我加入的题集」（课程作业、内部赛），需 PTASession |
| `GET /api/problem-sets/{ps}/exam-problem-list?problem_type=PROGRAMMING&page=&limit=200` | ✅ | 题集题目表，含题号/标题 |
| `GET /api/problem-sets/{ps}/users/{uid}/submissions?limit=200&before={id}` | ✅ | 指定用户的提交，cursor 分页 |
| `GET https://passport.pintia.cn/api/u/current` | ❌（返回 200 + 空身份） | 判定登录态 |

推导过程中被实测否掉的假设（都写进适配器注释，避免以后重复踩）：

1. **`/api/problem-sets/{ps}/submissions`（不带用户）匿名可读，但 `userId=` / `userName=` 查询参数会被忽略** ——
   传入后返回的仍是全站所有人的提交。带用户过滤的正确路径是 `/users/{uid}/submissions`。
2. **分页是 cursor 不是页码**：`page=1/2/3`、`offset=`、`start=`、`filter={"page":1}`、`after=` 全部返回第一页；
   只有 `before={上一页最后一条的提交 id}` 生效。
3. **`limit` 上限 200**：`limit=1000` 仍只回 100～200 条。
4. **提交行不带题目标题**：`problemSetProblemById[].title` 实测恒为空串，标题只能从 `exam-problem-list` 取。
5. **难度是 0-5 的枚举，但公开题集实测恒为 0**：`exam-problem-list` 的 `difficulty` 字段在 23 套题集
   1906 道题里 **1906/1906 都是 0**。0 在站点枚举里是 `UNLIMITED`（教师未标注），不是「最简档」。
   当时据此判为「没有难度字段」并记 `scale=none` —— 这一条在 2026-11-11 被修正，见文末
   「难度映射」一节。
6. **handle 必须是数字 userId**：`/users/leonyret/submissions` → 400；`/users/{数字}` → 200。

## 实现

- **适配器** `server/src/adapters/pta.ts`：题集枚举（公开 ∪ 我加入的）→ 逐集 cursor 翻页 → 状态映射 →
  对确有新行的题集补拉题目表取标题。增量沿用同步层的 `knownExternalIds`（整页已知即跳过该题集），
  改判/窗口/单次上限/补全全部沿用既有机制（与计蒜客同构，但容器从「比赛」换成「题集」）。
- **题号口径** `{题集id}-{题集内题目id}`，与题库拉取同键，提交行与题库行天然合并。
  不用题目详情里的全局 `problemId`：同一道题在不同题集里 `problemId` 不同（「一元多项式求导」在 PAT 乙级是
  10069、在数据结构题目集是 603），站点把它们当两道题，键也就该分开。
- **题库** `fetchPtaBank`（`adapters/problemBank.ts`）：公开题集逐个翻页，约 4700 题入池。
- **赛事日历** `contests/ptaContests.ts`：`/api/competitions/public`，实测 46 场 XCPC 网络预选赛/省赛。
- **难度回填**：`pta` 登记进 `NO_DIFFICULTY_SOURCE`，不写负缓存也不重扫（公开题集的 `difficulty`
  实测全为 0，回填结构性无解；教师自建题集若标了 1-5，同步/题库路径会照常换算）。
- **凭据**：`PTASession`（可选）。不配也能同步 23 套公开题集；配了才覆盖「我加入的题集」。
- **应用内登录 + 自动识别账号**（桌面版，见下节）：登录成功后由凭据反查 userId 并自动绑定账号。
- **链接识别**：`pintia.cn/problem-sets/{ps}/problems/{id}` 与老式 `/exam-problems/{id}` 都能粘进题单/复习。

## 取舍

- **不强制 Cookie**：`PLATFORMS.sync` 记的是 `cookie`（语义 = 「配 Cookie 后更完整」），但适配器在没有 Cookie 时
  照常工作，只是「我加入的题集」拉不到。这是站点匿名开放能力的直接结果，比强行要求凭据更可用。
- **单次同步的请求量天然等于题集数**：提交列表只能按题集查，所以一次同步至少打 23 次请求。页预算因此取
  `max(题集数, pageBudget)`，保证每套题集都被「看一眼」（增量判定正是靠那一次请求）。全量首同步实测约 36 秒。
- **标题补拉只在确有新行时做**：否则每次同步要额外多打 23 次题目表请求。
- **不猜难度**：`0`/缺失一律未知（不下发 `difficulty` 键），不按通过率臆造档位
  （映射只在有真档位 1-5 时发生，见下节）。

## 应用内登录与自动识别账号（2026-11-10 补充）

PTA 的账号名是 **19 位数字 userId**，让用户自己去个人主页地址栏抄一遍几乎必错；填昵称站点直接 400。
而这串数字本来就由站点自己提供（`GET passport.pintia.cn/api/u/current` 返回 `id`），没有理由让用户手抄。
于是把「登录」接成了「登录 → 识别 → 绑定 → 存凭据」一条龙。

### 关键坑：游客也有 PTASession

`passport.pintia.cn/api/u/current` 在**未登录时也返回 200，并下发一枚匿名 `PTASession`**
（实测响应头 `Set-Cookie: PTASession=<uuid>; Domain=pintia.cn`，body 是
`{"emailLogin":false,"omsLogin":false,"studentUserLogin":false,"phoneLogin":false,"userMfa":[]}`）。
因此桌面壳原有的完成判据「该平台的凭据字段都抓到了」在 PTA 上**恒为真**——用户刚打开窗口还没输密码，
壳就会认为登录完成并把匿名会话推回来，界面显示已登录、同步却仍只覆盖公开题集。

修正：给 `LoginSpec` 加 `identify: bool`。这类平台的完成判据改成
「**凭据齐 + identify 成功**」；identify 失败就继续等，用户关窗/超时则明确报「未检测到登录」，
**不把匿名 Cookie 当登录结果推回**。

### 身份判定只看内容

站点前端的口径是 `isGuest = !id`，且游客身份的 `id` 是字符串 `"0"`（不是缺字段）。
故 `ptaIdentity` 要求 id 是**正的非零数字**，否则一律判为未登录——响应体 `{user:{...}}` 与平铺两种形状都接受。

### 落地

- `PlatformAdapter.identify?(opts) → { ok, handle, nickname, message }`（新增可选能力），
  PTA 实现之；`checkAuth` 复用它同一条 `/api/u/current` 请求（语义分开：checkAuth 回答「还能用吗」，
  identify 回答「这是谁」）。
- `POST /api/settings/cookies/identify`：由已保存凭据反查 handle，附带 `bound` 告知是否已绑定。
  **只读不建账号**——静默建账号会让用户不清楚自己多了一个要同步的账号。
- 桌面壳登录流程：identify 成功 → 先 `POST /accounts` 绑定 → 再推凭据（顺序不能反：
  账号槽位只对已绑定账号开放，反了会退化成「平台级暂存」，用户还得再抓一次）。
  PTA 登录窗直接开 `/auth/login`，少点一次「登录」按钮。
- 网页版：账号卡片新增「识别账号」按钮（`cookies/identify`），把 userId 填进账号名输入框，
  **不自动保存**——改名会迁移提交记录，属于有副作用的决定，留给用户按「保存」。
- 识别结果与卡片上的 handle 不一致时**以识别结果为准**并在消息里提示：否则在账号 A 的卡片里登录成 B，
  B 的 Cookie 会写进 A 的槽位，A 的同步就去拉 B 的提交记录（静默串号）。
- 「识别账号」按钮在**新增账号**模式下也出现（旧实现那排按钮整排挂在 handle 上）：刚粘完 Cookie、
  还不知道账号名，正是最需要识别的时候。

### 验证

- `ptaIdentity` / `identify` 单测：匿名会话（`id="0"` + 各 login 标志 false）必须判失败，
  `{user:{...}}` 与平铺两种形状都能取到 userId。
- `POST /cookies/identify` 路由测试：读平台级影子值 → 返回 handle/nickname/bound；
  绑定后再问 `bound=true`；未实现 identify 的平台返回 200 + `ok:false`（不是错误）。
- 对线上实测：`passport.pintia.cn/api/u/current` 确实对游客下发匿名 `PTASession`，
  适配器对这份匿名会话的 `identify` 与 `checkAuth` 均返回 `ok:false`
  （修复前壳会把它当成登录成功）。
- 平台元数据与适配器能力一致性的用例：`PLATFORMS.pta.identify === true` 且适配器确有 `identify`，
  防止前端渲染出必然失败的按钮。
- 桌面壳 `cargo check`（MSVC 工具链）通过；服务端 1601 / 客户端 669 用例全绿。

## 难度映射：PTA 0-5 枚举 → Codeforces rating（2026-11-11 补充）

### 站点到底给了什么

前文第 5 条（「平台没有难度字段」）是**错判**，纠正如下。站点前端 `exam-app` 包里嵌着序数表
（`a9fbe1721d059cda.chunk.js`，2026-11 实测）：

```js
{0:{name:"UNLIMITED"},1:{name:"BEGINNER"},2:{name:"EASY"},
 3:{name:"MEDIUM"},4:{name:"DIFFICULT"},5:{name:"HARD"}}
```

同包的 i18n 词典给出中文名：**不限 / 入门 / 简单 / 中等 / 较难 / 困难**。题集配置里的
`showDifficulty` 只控制**考生能否看见**该列，不改变接口返回值。

所以域是 **0-5 六个序数**，其中 **0 = UNLIMITED = 教师没标**（不是「最简档」）。实测覆盖面：

| 观测 | 结果 |
| --- | --- |
| 23 套公开题集的 `exam-problem-list` | 1906 道题，`difficulty` **1906/1906 = 0** |
| `GET /api/problems/{id}`（单题详情） | 401，需登录 |
| `/api/problem-sets/{ps}/config` 的 `showDifficulty` | 23/23 套都**没有**该字段 |
| `/api/competitions/{id}`（XCPC 赛题） | 401，需登录 |

结论：**匿名/公开路径拿不到非 0 的难度**。只有教师在自己建的题集里手动标过档的题才有 1-5，
这需要「已登录 + 该题在你的题集里」。代码因此照常搬运并换算 —— 拿得到就换算，拿不到就是未知。

### 映射表

**没有权威对照表。** 站点未公布档位与任何 rating 的换算；社区也没有可用样本（PTA 题目没有可
与 CF 对齐的公开通过率榜单，公开题集难度又全是 0，无法做回归）。因此这里是**启发式锚定**：
把 5 档对齐到 **[Codeforces 官方段位分界](https://en.wikipedia.org/wiki/Codeforces#Rating_system)**
（与本文件已有的 `cfRatingTitle` 同一套边界），每个锚点可引用、单调递增，且都落在
CF 题目的实际取值域 [800, 3500] 内（实测 `problemset.problems` 11194 道有评级题，min=800、max=3500、
28 个离散值）。

| PTA 档 | 中文名 | → CF rating | 锚点依据 |
| --- | --- | --- | --- |
| 0 | 不限（UNLIMITED） | **未知（null）** | 教师未标注，不是难度 |
| 1 | 入门 | 800 | CF 题库 rating 下限 |
| 2 | 简单 | 1200 | Newbie / Pupil 分界 |
| 3 | 中等 | 1600 | Expert 段起点 |
| 4 | 较难 | 2100 | Master 段起点 |
| 5 | 困难 | 2600 | International Grandmaster 段起点 |
| 6+ / 非整数 / 非数字 | — | **未知（null）** | 超出已知域，见下 |

**精度声明（推测程度）**：这张表是**启发式**，不是实测回归。5 档压缩 CF 的 28 个离散 rating，
单档跨度 300-500，量化误差本身就有 **±200-300**。它只可作为粗分档信号（弱项归类、推荐候选池），
不要用它做精确评级，也不要在同一道题上把它与 CF 原生 rating 直接比大小。

### 边界处理（与其余平台同口径）

| 情况 | 处理 | 理由 |
| --- | --- | --- |
| `difficulty = 0` | 不下发 `difficulty` 键；`nativeDifficulty = '0'`（原文留存）；`scale = pta-level-5` | 0 = UNLIMITED = 未标注。与洛谷 0「暂无评定」同义 |
| 字段缺失 / `null` | 不下发 `difficulty`；无原生原文 | 与上面同义，但连原文都没有 |
| `1`–`5`（数字或整数字符串） | 换算 + 档位名 + 原文 | 正常路径 |
| `6+` / 负数 | 不下发 `difficulty`，**不钳位**，原文留存 | 把 6 当 5 用等于替站点编造数据；原文留着，站点日后扩档可重算 |
| `2.5` 等非整数 | 同上 | 站点只发整数序数 |
| `'MEDIUM'` 等非数字串 | 同上 | 不猜测字符串含义 |

「未知」的呈现刻意与其余平台一致：`difficulty` 缺键 → 前端 `formatDifficulty` 走空态
（默认「难度未知」；若回填已确认上游给不出，显示 `OFFICIAL_NO_DIFFICULTY_TEXT`）。
标度始终记为 `pta-level-5`（而不是 `none`）—— 它描述的是**这个平台的难度域是什么**，
与「这道题有没有值」是两件事；回填/前端据此知道可换算。

### 落地

映射表**只有一份**，在 `shared/src/difficulty.ts`（项目铁律：适配器与路由层不得各写一份，
见 `server/test/adapters-difficulty.test.ts` 的扫描用例）：

- `PTA_DIFFICULTY_NAMES` / `PTA_LEVEL_TO_RATING` / `PTA_DIFFICULTY_MAX`：域与表
- `parsePtaDifficulty(raw)`：域校验（只接受 1-5 整数，其余 null，不钳位）
- `DifficultyScale` 新增 `'pta-level-5'`；`parseNativeDifficulty` 新增 `case 'pta'`
- 搬运动作分两处（都只透传原文，不本地换算）：`adapters/pta.ts` 的
  `parsePtaProblemList` / `fetchProblemMetaMap`（同步路径）、`adapters/problemBank.ts` 的 `fetchPtaBank`
- 前端 `client/src/uiFormat.ts` 的 `SCALE_PLATFORM_NAME` 加 `'pta-level-5': 'PTA'`，
  展示成 `1600 · PTA 中等`

同步路径的取值时机：提交行本身**不带难度**（与标题同理），只能在
`exam-problem-list` 里取；沿用既有的「只对确有新行的题集补拉一次题目表」策略，
所以增加难度**不增加任何请求**（同一次请求里多读一个字段而已）。

回填路径仍把 `pta` 记在 `NO_DIFFICULTY_SOURCE`：公开题集的 1906 道题全是 0，
每轮重扫必然一无所获。若用户账号所在的教师题集标了档，那批题在**同步**时就已带难度入库。

### 验证

- `server/test/difficulty.test.ts`：覆盖**整个 0-5 域**（0/1-5/6/999/-1/2.5/'MEDIUM'/''/null/undefined
  逐个断言）；5 档严格单调且各自落在所声明的 CF 段位；`difficultyFields` 在未知时确实**缺
  `difficulty` 键**、异常值时原文仍留存。
- `server/test/pta.test.ts`：题集题目表给 3 → 提交行 `difficulty=1600` + 原生 `'3'` + 标度
  `pta-level-5`；给 0 / 缺字段 → 不下发 `difficulty`；给 9（模拟站点扩档）→ 不钳位、原文留存；
  `parsePtaProblemList` 原样透传序数。

## 同步请求频率限制（2026-11-11 补充）

### 改之前的问题

PTA 的请求特征不是「慢」，而是**多而小且没有上界**：

提交列表只能按题集查 → 一次同步至少 1（题集清单）+ 23（每集一页）次请求；
**元数据补拉**（标题 + 难度）另算，而它原先有三个漏洞（实测 2026-11-11）：

| 问题 | 证据 | 后果 |
| --- | --- | --- |
| 元数据请求**完全不计入** `pagesUsed` | 代码里它在主循环之外，只判 `pagesUsed >= budget + sets.size * 5` —— 而 `pagesUsed` 从不为它自增 | 主预算保护不到它 |
| 元数据请求**没有独立上限** | 20 套有新行的题集 × 每集最多 5 页 = **100 次** | 同步几条提交却翻了上百页题目表 |
| 元数据页间用**裸 `sleep`** | 不经过 `sleepTracked` | `sync_runs.waited_ms` 里看不见这段耗时 |
| 题库内层翻页是**无界 `for (;;)`** | 只要站点返回满页就继续 | 站点一旦忽略 `limit` 就永不结束 |

节流表本身也有档位问题：`pintia.cn` 原为 1500ms，与计蒜客同档。但计蒜客一次同步是
「参加过的比赛总数」（几十场），PTA 的固定开销是 23 套题集**每套都至少一次**，密度更高。

### 改了什么

**1. 元数据补拉封顶 + 计入限速**（`adapters/pta.ts`）

- 新增 `META_FETCH_MAX_PER_SYNC = 12`：一次同步的题目表请求总数上限（跨题集累计）。
  取 12 而不是 100 的理由：元数据只影响标题/难度的**展示完整度**，缺了下次同步还能补，
  不值得为它把请求量翻倍。20 套全有新增时也最多 12 次（实测从 100 → 12）。
- 每个题集的 `fetchProblemMetaMap` 接收 `budgetLeft`，返回 `requestsUsed` 供扣减；
  预算不足即整集跳过（不越界多发）。
- 页间等待改走 `sleepTracked`（累计进 `waited_ms`），且剩余预算不足时不再多等一次。
- 预算用尽时**连页间 sleep 都不做**（不空转）。

**2. 题库翻页加上界**（`adapters/problemBank.ts`）

新增 `PTA_BANK_MAX_PAGES = 60`（≈12000 题，远高于当前公开题集全量 4700 题）。
外层循环在页预算用尽时也直接收工，不再为余下每套空转一次 sleep。

**3. 节流表提档**（`net/hostThrottle.ts`）

`pintia.cn` / `passport.pintia.cn`：**1500ms → 2000ms**。

依据：站点**没有任何公开限额**（实测无 429/503），所以不能像 clist.by 那样按「官方配额」定档；
这里按「最坏情况短时请求密度」定 —— 2000ms = 上限 30 次/分钟，与 `codeforces.com` /
`kenkoooo.com` 同档（那两个是明确要求 ≥1s 的站点，取其 2 倍裕度），比计蒜客（1500）保守一档。

两层是**取较大者**而非叠加（既有语义）：适配器自带的 1200ms 只是「没挂节流层时」的兜底
（单测注入 mock、脚本、未来重构遗漏），线上实际节奏由节流表把关。

### 实测（对线上 pintia.cn，2026-11-11）

真实同步 30 条（`maxSubmissions=30`），在**真正发出请求**的位置打点：

```
rows 30 | actual sends 14 | elapsed 26075ms
sent gaps ms: [2010,1995,1995,2000,2005,2000,1997,2007,1997,2007,1990,2001,2001]
min actual gap 1990 | avg 2000 | peak 30.2 req/min
```

改前同条件：`avg interval 1098ms`（1200ms 自延迟 + 少量漂移），即 **≈55 次/分钟**。
现在稳定 2000ms / 30 次每分钟，且**每一次**间隔都不低于 1990ms（无突发）。

元数据封顶的对照（20 套题集全有新行、题目表恒返回满页）：

| | 提交请求 | 元数据请求 | 合计 |
| --- | --- | --- | --- |
| 改前 | 20 | 100 | 120 |
| 改后 | 20 | **12** | 32 |

### 参数面

- 用户在设置页拉「拉取速度」倍率时，PTA 的秒数会**自动跟着变**（`requestIntervalBase`
  取自节流表，无需改前端）。1× = 2s/请求，5× = 10s/请求。
- `sync_runs.waited_ms` 现在覆盖元数据段（此前只有提交分页段）。

### 边界与取舍

- **宁可元数据不全也不越界**：预算耗尽时后几套题集的标题会退回题号、难度保持未知。
  这不是缺陷：写入层有「title == problem_key 不覆盖」的守卫，下次同步补上时标题会正常覆盖。
- **不做指数退避封禁**：PTA 实测未出现 429/503，适配器已把这两个状态映射成
  `rate_limited`（提示「请稍后再同步」），但不做自动冷却 —— 没有观测到持续性限流，
  加以分钟级冷却只会让用户误以为同步卡死。
- **不按通过率估算难度**：这与频率无关，但同属「不臆造」原则（见上节）。

## 题目链接 404 修复（2026-11-11 补充）

### 现象

从题库/提交记录点开 PTA 题目，浏览器显示 `404 Not Found`：

```
/problem-sets/91827364500/problems/91827364656
```

但题目本身**完全存在**（`GET /api/problem-sets/91827364500/exam-problems/91827364656` → 200，
标题、题面、样例齐全），说明是**链接拼错**而不是数据问题。

### 根因：拼了站点路由表里不存在的路径

站点是 SPA，**任意路径都返回 HTTP 200 + 同一个 HTML 外壳**，404 由前端路由兜底时渲染。
所以「curl 一下看到 200」完全不能证明链接有效 —— 这也是当初判断失误的原因。

查站点 `exam-app` 包体的路由表，`/problem-sets/:id/problems/:id` **不在其中**。真实路由是：

```
/problem-sets/:id/exam/problems/type/:type?problemSetProblemId=<psp>
```

两个关键差别：

| | 旧（错） | 新（对） |
| --- | --- | --- |
| 路径 | `/problem-sets/{ps}/problems/{psp}` | `/problem-sets/{ps}/exam/problems/type/7` |
| 题目 id | 路径段 | **查询参数** `?problemSetProblemId=` |

`{type}` 是站点 `ProblemType` 枚举的**序数**，编程题 = **7**
（同表：2 单选、4 填空、5 程序填空、6 代码补全、8 主观）。

交叉验证（三个互相独立的来源都指向同一形态）：

1. 站点 `exam-app` 包体的路由表：`"/problem-sets/:id/exam/problems/type/:type": ...`
2. 仓库外第三方工具的页面检测规则表：`isProgrammingDetailPage() → /problem-sets/{id}/exam/problems/type/7?problemSetProblemId={id}`
3. 用户脚本的 `@match` 与多个公开题解里贴出的 PTA 链接

同时反向印证了旧形态是错的：`competitive-companion` issue #714「doesn't work on pta」里贴的正是
`.../exam/problems/type/7?problemSetProblemId=...` 这种正确形态，而**没有任何来源**使用
`/problem-sets/{ps}/problems/{psp}`。

### 改动

- `adapters/pta.ts` 的 `ptaProblemUrl`：改为拼真实路由，新增常量
  `PTA_PROGRAMMING_TYPE_ORDINAL = 7`（附枚举来源说明）。
- `adapters/problemBank.ts`：题库路径**原本自己又写了一份**同款错误 URL，改为**复用**
  `ptaProblemUrl`（一处真源，避免再次漂移）。
- `problems/parseProblemList.ts`：新增识别新形态（题目 id 在查询参数里 —— 正则必须把
  `?...problemSetProblemId=` 一起吃进来，否则还原出的 URL 会断在路径上）；
  旧形态保留识别能力（历史题单/别人文档里仍会贴，只是点开会被站点渲染成 404）。

### 验证

- 往返一致：`ptaProblemUrl(key)` 生成的链接喂回 `parseProblemListText` 必须解出**同一个键**
  （这条断言进了单测 —— 它同时守住「链接拼错」和「反向解析漏掉查询参数」两类回归）。
- 带 `&page=1` 的链接、老形态链接都能正确解析。
- 对线上交叉验证：题目 `91827364656` 的 `type` 确实是 `PROGRAMMING`，与链接里的 `type/7` 一致；
  题集 3179 题全部可查。
