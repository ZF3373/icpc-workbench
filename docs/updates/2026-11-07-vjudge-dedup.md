# VJudge 题目去重口径优化：有平台的映射回原站，没有的用 VJudge 数据

VJudge 是转发站，同一道题既可能从 VJudge 同步进来，也可能通过原站链接/题单导入进来。
去重的关键是**两者必须落到同一个题目身份**。本次修的是这条链路上两个方向上的错：

1. **有对应平台的题**：本来已经映射回原 OJ，但映射表只覆盖 9 个 OJ，且 `parseProblemList`
   与同步侧的口径并不完全一致（见下）；
2. **没有对应平台的题**：此前**直接丢弃**。VJudge 是这些 OJ 唯一可用的数据源，
   丢掉不等于没有 —— 用户相当一部分 AC 永远进不了库；
3. **落到同一身份之后**：题目行仍可能有多行（洛谷镜像、VJudge 转发），而复习条目按
   **题目行**判重 —— 同一道题会被排进复习队列两次（见「问题六」）。

## 问题一：未接入 OJ 的记录被静默丢弃

旧注释的理由是「避免幽灵题目」（落库只会造出永远补不上难度、也没有题面来源的行）。
代价被低估了。实测一次 `/status/data` 采样（200 行、15 个 OJ 字面量）：

| OJ | 行数 | 旧行为 | 新行为 |
| --- | --- | --- | --- |
| 洛谷 / 牛客 / CodeForces / AtCoder / QOJ | 149 | 映射回原站 | 不变 |
| CSES / EOlymp / HDU / Toph / UVA / CodeChef / SPOJ / LibreOJ / POJ / OpenJ_NOI | 51 | **丢弃** | `vjudge/{OJ}-{题号}` |

也就是说四分之一的提交直接消失。现在这类记录落 `vjudge` 身份、保留 VJudge 链接，
提交照常入库、照常进统计与复习。

## 问题二：OJ 字面量解析不能按 - 硬切

旧实现的两个正则都假设「OJ 是纯字母数字下划线、题号也是」：

- `vjudge.ts` 的历史键按**第一个** `-` 切分 → `Z-Trening-1000` 会被切成 `Z` + `Trening-1000`；
- `parseProblemList` 的正则只认字母数字下划线 → 带连字符的题号
  （`Toph-make-it-big`、`OpenJ_NOI-CH0106-02`）识别失败，整行被跳过。

现在统一走 `splitVjudgeProblemSlug`：**按已知 OJ 字面量做最长前缀匹配**（覆盖 VJudge
官方 OJ 列表的全部 60 项），匹配不到才退化为「第一个 `-` 之前是 OJ」。

## 问题三：映射表与「规范化」的真源分散

新增 `VJUDGE_OJS` 登记表（`adapters/vjudgeIdentity.ts`），每项是
`{ canonical, platform?, aliases? }`：

- `platform` 有值 = 本应用有该题库 → 映射回原 OJ；
- 缺省 = 本应用没有 → 落 `vjudge/{canonical}-{题号}`；
- `aliases` 只做**大小写与已确认同义**的归并（`LOJ`/`LibreOJ`、`UOJ`/`UniversalOJ`）。

**刻意不合并的**：`HYSBZ` / `黑暗爆炸` / `BZOJ` 在 VJudge 上是**三个独立 OJ**
（官方列表各占一项，分别指向 lydsy.com / darkbzoj.cc / new.bzoj.org）。题号大概率同源，
但「大概率」不足以合并 —— 题号一旦分叉，合并就是把两道不同的题静默算成一道。

同理，`CodeChef-FLOW013` 与 `CodeChef-flow013` 仍是两行：VJudge 的题号大小写混排，
不做归一化（那需要每个 OJ 的题号规则，猜错的代价是合并错题）。已解题目统计因此仍可能
对同一道题计两次 —— 这是**已知且有意保留**的保守取舍。

## 问题四：同一道题的两个地址

映射回原 OJ 时，同步侧存原站链接、导入侧存 VJudge 转发链接 —— 同一道题两个地址，
且转发链接在部分 OJ 上还要登录 VJudge 才跳得过去。现在两侧都取身份自带的规范地址
（`vjudgeIdentity().url`）。

## 问题五：题单导出的 OJ 字面量是错的

`client/src/pages/Lists.tsx` 导出 Virtual Judge Markdown 时用的是 `CF-` / `Luogu-` /
`nowcoder-`，而 VJudge 线上写的是 `CodeForces` / `洛谷` / `牛客` —— 导出的题单粘进
VJudge 认不出来。映射收敛到 `shared` 的 `VJUDGE_OJ_OF_PLATFORM`（单一真源，
服务端登记表是它的镜像）。

## 问题六：同一道题被排进复习队列两次

这是「映射回同一身份」之后仍然漏掉的一环。`review_items` 的唯一键是
`(user_id, problem_id)` —— 按**题目行**，而 problems 表里同一道题本来就允许多行：
`codeforces/1000A` 与洛谷镜像 `luogu/CF1000A` 共享 identity `codeforces:1000a`。

实测（修复前）：

```
POST /api/reviews/from-url https://codeforces.com/contest/1000/problem/A
  -> codeforces/1000A  alreadyInQueue=false   （建了第 1 条）
POST /api/reviews/from-url https://www.luogu.com.cn/problem/CF1000A
  -> luogu/CF1000A      alreadyInQueue=false   （又建了第 2 条）
problems: 2 行（identity 都是 codeforces:1000a）
review_items: 2 条  <-- 同一道题被排了两次
```

后果不是"多一条数据"那么简单：今日训练里同一道题出现两次、复习日历与负载都算两次，
而且两条**各自独立排期** —— 一条练到 60 天档、另一条还停在 3 天档，用户等于在重复练习
同一道题。

修复后按**题目身份**判重（新增 `reviews/queue.ts` 的 `queueStateOf`，口径与
`routes/today.ts` 里早就按 identity 聚合的 `queued` CTE 一致）：

- `POST /api/reviews` 与 `POST /api/reviews/from-url` 都先按 identity 查，命中即复用那条的排期；
- 复用而不是新建，所以已经练到 60 天档的进度不会被镜像导入拽回 3 天档；
- 存量重复由启动迁移 `dedupeReviewItemsByIdentity` 合并：保留最早加入的一条，
  **档位取高、到期日取早**（既不让进度倒退，也不把该复习的题推远），复习日志改指保留条目、
  历史不删（留存系数要靠它做训练数据）。

## 数据迁移

### 题目身份

`db/vjudgeIdentityFix.ts`（启动时执行、幂等）扩展为三种情形：

- 有对应平台 + 目标键不存在 → 原地改名；
- 有对应平台 + 目标键已存在 → 跨平台合并（提交/复习/题单/知识点/墓碑一起走）；
- **没有对应平台 → 别名行归并到规范字面量**并补齐 VJudge 链接（旧实现对这些行原样不动，
  于是同一 OJ 的不同写法长期各占一行）。

已经是规范身份的行走空操作分支（键与链接都对才跳过），否则每次启动都会重写一遍。

### 复习条目

`db/index.ts` 新增 `dedupeReviewItemsByIdentity`（启动时执行、幂等）：把同一 (user_id, 题目身份)
下的多条复习条目合并成一条。它与既有的 `dedupeReviewItems`（同 (user_id, problem_id) 去重）
是两层不同粒度 —— 后者挡的是合并/重指留下的同键重复，前者挡的是**同一道题多行**造成的重复。

## 难度回填

`vjudge` 仍在 `NO_DIFFICULTY_SOURCE` 里：VJudge 不提供难度，未接入 OJ 又没有原站可查。
区别只是**理由变了** —— 旧实现下 vjudge 行只可能是历史遗留，现在是常态（题库未接入）。
行为不变：记 `gap_state` 终态、计 `missing` 而非 `failed`、不发任何上游请求。

## 改动文件

- `server/src/adapters/vjudgeIdentity.ts`：OJ 登记表、`splitVjudgeProblemSlug`、
  `vjudgeIdentity` 不再返回 null 丢弃记录、`vjudgeProblemUrl`。
- `server/src/adapters/vjudge.ts`：保留未接入 OJ 的记录；`problemUrl` 复用同一份编码。
- `server/src/problems/parseProblemList.ts`：VJudge 链接交给登记表解析，地址取规范值。
- `server/src/db/vjudgeIdentityFix.ts`：新增「未接入 OJ 别名归并」分支。
- `server/src/analysis/difficultyBackfill.ts`：注释同步新语义（行为未变）。
- `server/src/mcp/tools.ts`：`PLATFORM_IDS` 从 `shared/PLATFORMS` 派生（原先漏了 dashoj / vjudge）。
- `shared/src/index.ts`：新增 `VJUDGE_OJ_OF_PLATFORM`。
- `client/src/pages/Lists.tsx`：导出改用 shared 映射。
- `server/src/reviews/queue.ts`（新增）：`queueStateOf` —— 按题目身份查复习条目。
- `server/src/routes/reviews.ts` / `server/src/reviews/fromUrl.ts`：加复习改为按身份判重。
- `server/src/db/index.ts`：新增 `dedupeReviewItemsByIdentity` 启动迁移。
- `client/test/vjudgeExport.test.ts`（新增 4 项）：映射口径与「不登记 VJudge 没有的平台」。

## 验证

- `npm run typecheck`（server + client 均 0 error）
- `npm test -w server`：1568 项通过
- `npm test -w client`：含新增 `vjudgeExport` 4 项
- 新增/改写单测覆盖：未接入 OJ 落库不丢提交、别名归并后落库只有一行题目、
  同步与 URL 导入身份一致、带连字符的 OJ/题号不被切断、独立 OJ 不被猜测性合并、
  迁移的三种情形与幂等性、复习库可加入未接入 OJ 的链接、
  **同一道题多平台行共用一条复习条目**、复习条目合并迁移的保留口径与幂等性。