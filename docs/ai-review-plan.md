# AI 赛后复盘优化 — 最终版计划

> 本文合并了此前的实现审查与证据增强两份文档，是**唯一权威版本**。所有需求与优化点均已完整保留。
>
> **实施状态（2026-09-26 更新）**：阶段 0–6 已全部落地，`npm test`（server 907 + client 332，0 失败）、
> `npm run typecheck`、`npm run lint`（0 error）、`npm run build` 全绿，详见文末「七、实施状态」。
> 上线后修掉三个真实缺陷：**已 AC 的题没有题面 → AI 编造题意**（7.1）；
> **题面覆盖与抽取质量**（AtCoder 旧实现只抽 68 字符、噪声被当题面、题名串号，见 7.2）；
> **赛事中心总题数显示成"我交过几题"**（7.3）。
> 唯一剩下的平台边界：**Codeforces 的 HTML 页被 Cloudflare 拦死，服务端拿不到 CF 题面**（7.2 有实测依据）。

## 目标与需求（完整保留）

用户提出的需求，按提出顺序：

1. **（原始）** 审查当前 AI 复盘的实现方式，进行优化。
2. **（第二轮）** 让 AI 查看已结束比赛的**题解**或**成功 AC 的代码**，更准确判断**题目类型、知识点标签**，更好得进行分析，并且**不会因为题目过难而想不出或给出错误的题解**。
3. **（第三轮）** 当前 AI **并不知道题面**，只根据**题目名字**很容易出现偏差。

---

## 一、总体评价：架构扎实，但有四个层次的缺口

整体设计是**扎实**的，几个关键判断都踩对了：

- **不做比赛实体表，从提交记录反解**——避免在库里维护易腐的赛程镜像，各平台用各自信号（CF 的 `context`、AtCoder 的 url slug、计蒜客/QOJ 的 `{contestId}-{pid}` 键、洛谷 T 号前缀），判定口径写在注释且有测试（[contests-participated.test.ts](server/test/contests-participated.test.ts)）。
- **"宁缺毋滥"的推导哲学**是对的：CF 纯补题组不列、洛谷纯时间窗不认、AtCoder 日历有该场但提交全在窗外不猜。**列一场没参加过的比赛比漏掉一场更糟。**
- **落库 + 增量游标 + 30 分钟过期 + 后台静默刷新 + 读库秒出**这条链成熟，[contests.ts](server/src/routes/contests.ts) 的"首次使用才同步初始化，否则读库 + `kickBackgroundRefresh`"分支处理得很细。
- **`resolveContestGroup` 与 `deriveParticipatedContests` 走同一套索引**，保证"列表里能选到的场，注入时一定解析得回同一组数据"——这个不变量很关键。
- **防编造约束**（无佐证须标注"未经题解验证"、CF 明确告知无稳定源）针对真实失败模式；`fetch_editorial` 里牛客两跳发现 + 登录墙判定（`gatedNowcoderPost`）是踩过坑才有的代码。

**缺口分四层**，其中前两层是根因，后两层是随之失效的连锁：

- **A 层（根因）**：AI 不知道**题面**——题名信息量极低，判断系统性偏差。
- **B 层（根因）**：AI 没有**题解/代码**等权威佐证——难题上想不出或编造。
- **C 层**：**官方标签供给不足**——仅 CF 有 tags，且渲染截断 + 来源不明。
- **D 层**：**链路开销与状态一致性**——每条消息打外网、缓存语义错误等。

---

## 二、根因认定：题面缺失是第一位的问题

用户第三轮的判断经核查成立，且比"题解/代码缺失"更根本。

**`problems` 表没有题面字段。** [schema.sql:62-72](server/src/db/schema.sql#L62-L72) 全列：

```sql
problem_key TEXT NOT NULL,   -- 平台内唯一标识，如 1919C / abc321_a
title       TEXT NOT NULL,
difficulty  INTEGER,
url         TEXT,
tags        TEXT NOT NULL DEFAULT '[]',
difficulty_source TEXT, native_difficulty TEXT, difficulty_scale TEXT,
```

服务端全文搜索 `statement` / `题面` **零实现命中**（仅 [jisuanke.ts:660](server/src/adapters/jisuanke.ts) 一处注释出现过"题面"二字）。

**因此复盘时 AI 对每道题看到的全部信息就是：**

```
#### 1877D Yet Another Problem（难度 2100｜tags: dp, greedy）
- 题目链接：https://codeforces.com/contest/1877/problem/D
- 提交 3 次：+00:12 WA → +00:31 WA → +01:05 AC
- 结果：AC
```

题名 + 难度 + 粗分类标签 + 时间线，就是全部。而 OJ 题名信息量极低——`Yet Another Problem`、`Binary String`、`Counting`、`Game` 在 CF 上各自都有大量同名/近名题。

### 为什么这是根因，而不只是"又一个证据缺口"

**题面是把所有其他证据锚定到现实的那根桩。** 缺了它，连锁失效：

1. **题目类型判断必然偏差**——题名"Game"可能是博弈、SG 函数或纯模拟；tags 只有官方粗分类，且 CF 之外**根本没有 tags**。
2. **卡点分析会"编"**——AI 不知道题面，就无法知道用户当时在 WA 什么。它只能**虚构一个符合题名的题意，再针对虚构的题意给建议**。这种错误比"给不出题解"危险得多，**因为读起来完全合理、用户难以察觉**。
3. **难题上必然失手**——没有题面约束，模型只能靠参数记忆里的模糊印象去凑，难题上必然滑向编造。
4. **其他证据连带失效**——官方 tags 可能被误用（同一组 tags 在不同题意下分析方向完全不同）；题解佐证更会**错位匹配**（editorial 讲真实题意，AI 拿着虚构题意去读，产出更隐蔽的错误）。

**结论：题面是最高优先级，且必须排在题解/代码方案之前。** 题解是锦上添花，题面是地基。

---

## 三、平台现实与可行性（决定哪些能做、哪些不能）

| 平台 | **题面** | 题解 | AC 源码 |
| --- | --- | --- | --- |
| **Codeforces** | ✅ 公开、SSR、无需登录，**最稳** | ⚠️ editorial 是 blog 帖，无稳定 URL，需 `web_search` | ❌ `user.status` 无 source 字段；`contest.status` 匿名**不返回**源码 |
| **AtCoder** | ✅ 公开、SSR | ✅ 官方 `/contests/{slug}/editorial` 公开 | ⚠️ 匿名**可能**可读但无 API、JS 渲染，**需实测** |
| **洛谷** | ✅ 公开 | ✅ 题解区（需 Cookie，已实现） | ❌ 需登录且仅本人 |
| **牛客** | ⚠️ 部分需登录 | ⚠️ 讨论帖两跳 + `web_search` 兜底（已实现） | ❌ 需登录，他人代码不可见 |
| **计蒜客 / QOJ** | ⚠️ 视场次 | ❌ 无公开源 | ⚠️ QOJ 部分可见 |

**三个关键工程事实**：

1. **题面是最好抓的**。相比题解（无稳定入口）和源码（平台不给），题面在 CF/AtCoder/洛谷都是**公开静态 SSR 页面**，路径最短、结构最稳。
2. **入口链接已经现成**。[schema.sql:65](server/src/db/schema.sql#L65) 的 `problems.url` 已存全部题目链接；`fetch_url` 工具**已存在且已能读题面**（[participated.ts:643](server/src/contests/participated.ts) 的注释里就写着"AI 可用 fetch_url 读题面"）。
3. **缺的不是能力，是"促使 AI 去用"的机制 + "避免重复抓"的缓存**。AI 面对一堆只知题名的题时，倾向于直接开讲而非先取证。

---

## 四、实施阶段

### 阶段 0 — 提示词：把"读题面"设为**前置强制步骤**（立刻可做，零风险）

在 [assistant-prompt.md:52](server/src/ai/assistant-prompt.md) 复盘规则中新增硬性前置：

```markdown
### 复盘前置要求：先读题面，再下判断（硬性）

上下文中每道题**只有题名、难度、标签和提交时间线，没有题面**。题名信息量极低且大量重名，
**仅凭题名推断题意会系统性出错**。因此：

1. 凡要对某题给出**题意理解、考点判断、卡点分析、解法建议**之一，**必须先调用 `fetch_url`
   读取该题题目链接的题面**。未读题面的题，只允许陈述客观事实（提交次数/时间/结果），
   **禁止**推断考点与卡点。
2. 一次复盘应优先读**未通过的题**与**未提交的题**的题面；已 1A 的简单题可按用户要求略过。
3. 读题面后，把"题意一句话概括"写进该题点评的**开头**——这既是对用户的交付，
   也是让你自己（和用户）核对题意是否理解正确的锚点。
4. 若题面读取失败（登录墙/JS 渲染），**明确告知用户"未能读取题面"**，并只做方向性提示，
   不得虚构题意。
```

**立刻把行为从"凭题名猜"扭到"读了再讲"**，不引入新代码路径。两个已知代价由阶段 2 解决：AI 可能不遵守；每题每轮 `fetch_url` 会重复打网络，并撞上阶段 1 要修的 P0-1。

### 阶段 1 — 修复链路开销与缓存语义（阶段 2 的硬前置）

#### 1.1（P0）chat 路径复用读库快照，不再每条消息打外网

[ai.ts:491](server/src/routes/ai.ts) 直接**同步**调 `loadParticipationSources`，而 GET 路由用的是纯读库的 `readParticipationSnapshot` + `kickBackgroundRefresh`（[contests.ts:52-68](server/src/routes/contests.ts)）。**chat 这条更热的路径绕过了已有的缓存设计。**

后果：复盘时**每发一条消息**都可能触发 5 平台网络拉取，且发生在 `res.flushHeaders()` **之前**——用户看到的是无输出的黑屏等待；某平台超时则整条对话被拖住。

修法：

```ts
const snapshot = readParticipationSnapshot(db);
if (snapshot.stalePlatforms.length > 0) kickBackgroundRefresh(db, calendar);
const resolveOpts = { calendar, sources: snapshot.byPlatform };
```

代价是本次对话可能用陈旧 ≤30 分钟的参赛记录——复盘归因的是历史比赛，完全可接受，且**与 `contests/participated` 列表的新鲜度保持一致**（现在反而一个秒出一个阻塞）。

#### 1.2（P0）题目集补拉改为三态，"确认无题目集"可缓存

[participationSources.ts:779](server/src/contests/participationSources.ts) 先写退避时间戳再拉取，但**"成功但为空"与"网络失败"都返回 `null`**，调用方无法区分：

```ts
refs = list.length > 0 ? list : null;   // 空题目集 ← 与失败同义
```

而 [ai.ts:500](server/src/routes/ai.ts) 的条件又把"已知且确实为空"判成需要重拉，导致空题目集场次被**无限重复拉取**。

修法：改三态 `{ status: 'ok' | 'empty' | 'unavailable' }`；`empty` 需写回**新的哨兵值**（现有 `parseProblems` 把空数组视作未拉取，[participationSources.ts:443](server/src/contests/participationSources.ts)）或加 `problem_set_state` 列。

#### 1.3（P1）`resolveContestGroup` 按平台下推过滤

`buildContestIndex` 的 `fetchContestableRows` 是**全平台全量提交 ⋈ problems**，无 LIMIT、无时间下推，随刷题量线性增长，且在复盘长对话中每轮重跑。增加可选目标平台参数，SQL 按 `s.platform = ?` 过滤即可。

#### 1.4（P1）`force` 刷新不得被 in-flight 复用吞掉

[participationSources.ts:554](server/src/contests/participationSources.ts) 的 `inFlight` 是模块级**按平台**键。用户点"刷新"（`force: true`，[contests.ts:79](server/src/routes/contests.ts)）若撞上后台刷新的 in-flight，会走 `if (inflight) { await inflight; ... return; }` **直接复用而非强制重拉**——用户点刷新却看到旧数据。修法：`force` 不参与复用（或按 `${platform}:${force}` 建键），并补上 in-flight 分支的 `failures` 读取。

### 阶段 2 — 题面预取 + 落库缓存（**根治**）

**新增表**（迁移写法参照 [db/index.ts:83](server/src/db/index.ts)）：

```sql
CREATE TABLE IF NOT EXISTS problem_statements (
  platform    TEXT NOT NULL,
  problem_key TEXT NOT NULL,
  text        TEXT NOT NULL,      -- 抽取后的题面正文（含输入输出格式/样例）
  source_url  TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (platform, problem_key)
);
```

- **写入时机**：**不在 chat 请求路径里抓**。改为同步/复盘打开时**按场次批量预取**，或复用 `kickBackgroundRefresh` 同款后台通道异步补齐。缓存**永久有效**（题面几乎不变），仅 404/改版时失效重取。
  - ⚠️ **2026-09-26 修订**：原设计的"只对未通过 + 未提交的题抓取"**已被证明是错的**——已 AC 的题没有题面，而复盘结构要求逐题点评，模型便顺着题名**编造已 AC 题的题意**（用户实测反馈）。现覆盖**该场所有题**（未通过 → 未提交 → 已 AC），已 AC 的题按更小预算（1600 字符）注入。
- **注入时机**：`renderContestContext` **读库**拼题面（纯读库、零网络），受下方预算约束；**任何未注入题面的题都会在上下文里被显式列名**（见下）。
- **为什么必须落库**：复盘是**连续追问**场景（"那 C 题呢"、"补题顺序"），AI 每轮都要重新理解题意。现读意味着每轮重复抓取；落库后一次抓取、全对话复用，与 [cfProblemset.ts](server/src/contests/cfProblemset.ts) 已确立的"一次拉取、复盘零请求"模式一致。
- **硬依赖**：本阶段**必须**在阶段 1.1 之后。否则在"每条消息都可能打网络"的现状上叠加题面抓取，会显著恶化黑屏问题。

#### 题面注入的预算设计（必须做，否则压垮上下文）

题面很长（CF 一题常 3-8K 字符），一场 6 题可达 30-50K 字符，**不能无脑全塞**：

- **只注入要点**：题意 + 输入输出约束 + 关键样例；去掉冗长样例解释、公告、页脚导航。
- ~~**只给需要的题**：优先"未通过 + 未提交"；已 1A 的题仅在用户追问时注入。~~
  → **2026-09-26 修订**：**已 AC 的题必须注入**（预算更小即可）。理由：复盘的核心交付是逐题点评，包括"做对的题关键一步"；已 AC 的题不给题面，模型就会自己编一个题意——用户实测到过这种编造，且读起来完全合理。优先级仍为 未通过 → 未提交 → 已 AC。
- **空态必须声明（本轮新增的关键约束）**：未注入题面的题要在上下文里**逐个列名**，并明确"禁止凭题名概括题意、禁止推断考点与卡点"；无题面来源的平台（计蒜客/QOJ 等）单独说明。理由与「题目集未知 vs 已知且全部提交过」的空态区分同源：**模型不会自己说"我不知道"，它只会把空当满**。
- **每场设题面总量上限**（现为 30K 字符：覆盖已 AC 题后单场可达 10+ 题），超出时按优先级注入并列出被预算丢弃的题号。
- 与 [context.ts](server/src/ai/context.ts) 的 `trimContext`/`summarizeContext` 联动：system 膨胀会挤压对话历史预算，**提示词越胖、可保留的对话轮次越少**。

### 阶段 3 — 题解佐证 + 证据分级

阶段 0 生效后 AI 已有**正确题意**，此时给题解入口才有意义（题意对了才能与 editorial 正确对齐）。

**做法**：为未提交的题**拼接** editorial 入口（**纯字符串，无网络**）：

- AtCoder：`https://atcoder.jp/contests/{slug}/editorial`（可从比赛页推导）
- 洛谷：`https://www.luogu.com.cn/problem/solution/{pid}`
- CF / 牛客：无稳定规则 → 写明搜索关键词（"Codeforces Round {id} editorial" / "{比赛名} 题解"）

**把 URL 直接摆在模型面前，调用成本从"判断 + 构造"降到"照抄"**，实际调用率显著提高；拼不出时给出明确搜索词，也比现行长段说明更可能被遵循。

**配合提示词改为证据分级**（替换现行 [assistant-prompt.md:57](server/src/ai/assistant-prompt.md) 的"标注推断"免责式写法）：

```markdown
4. **证据分级（每题显式标注）**：
   - **A 级**：有题面 + 官方 tags → 可下确定结论
   - **B 级**：读过题解佐证 → 下结论并标注出处
   - **C 级**：无佐证 → **只给方向性提示**，明确写"未经题解验证"，**禁止**给出完整解法与复杂度分析

   **强制动作**：难度 ≥ 1800 且为 C 级的题，**必须先尝试 `fetch_editorial` / 题解入口链接 /
   搜索关键词**取证，失败才降为 C 级输出。不要跳过取证直接下结论。
```

保留现有牛客发现链（那是踩坑经验，不要删）。并补一条直接对应痛点的禁止条款：

> 若一题既无题面、又无题解佐证，**宁可说"这题我无法判断考点，建议你看题解"，也绝不编造算法**。用户明确表示宁可不知道，也不要错的题解。

### 阶段 4 — 官方标签补强与渲染优化

- **（P0 级收益，成本极小）** [participated.ts:155](server/src/contests/participated.ts) 的 `tags.slice(0, 5)` **放宽到 8**：CF 难题常有 4-6 个官方 tags，截断会丢掉区分性标签。
- **标注来源**：`｜tags: dp, greedy` → `｜官方 tags: dp, greedy（Codeforces 标注）`，让提示词的"以官方 tags 为准"有确切所指（现在 AI 无法区分官方标注与本地推断）。
- **注入本场 AC 语言**（`programmingLanguage` 已入库，[codeforces.ts:185](server/src/adapters/codeforces.ts)）——零成本，对"工具链是否顺手"有真实价值。
- **（P1）渲染预算按信息量分配**：[participated.ts:533](server/src/contests/participated.ts) 的 `MAX_RENDER_PROBLEMS = 40 / MAX_RENDER_SUBMISSIONS = 200` 截断按**渲染顺序**丢弃后段——复盘场景里后段往往是难题，**恰是最该复盘的却被整块丢掉**。改为：保证每题至少一条摘要行，对 AC 的题裁剪时间线、对**未通过**的题保留完整时间线与题面；截断时**列出被截断题号与难度**，而非只说"明细已截断"。200 条提交对 ICPC 级比赛偏紧，而 40 题用不满，两个上限的比例值得按真实数据校准。
- **（P1）提示词补篇幅分档**：6 个复盘部分 + 每题时间线 + 题面，极易产出超长回答。建议：题目 ≤6 逐题展开；>6 则逐题压成一行，只对**未通过**与**未提交**的题展开；始终不给完整题解（除非用户明确要求）。
- **（P1）区分"题目集未知"与"已知且全部提交过"**：现在 `unsubmittedProblems` 为空数组时两种空态**无法区分**，AI 容易顺着"未提交的题"一节**编出并不存在的题**。需在 `renderContestContext` 显式区分。

### 阶段 5 — AC 源码（如实降级）

**不做**跨平台源码抓取（第二节已说明：CF 明确不返回、牛客/洛谷需登录且他人代码不可见）。改为两条真实路径：

1. **用户投喂**：现有附件机制已支持代码文件（`textContent` 拼接，[ai.ts:386](server/src/routes/ai.ts)）——提示词应明确写"用户可粘贴/上传自己的 AC 代码，AI 据此还原当时的思路"。
2. **若确需 AtCoder 源码**：加**独立、显式触发**的工具（如 `fetch_accepted_code`），**绝不预取**；且必须先用真实提交 ID **实测匿名可读性**再实现。

### 阶段 6 — 前端与工具细节（P2）

- **`?contest=` 跳转不得静默丢弃**：[Assistant.tsx:702](client/src/pages/Assistant.tsx) 中 `valid` 为空时**静默落到普通会话**，预填文本丢失且无提示。应给明确提示（"该场未能从提交记录推导出来，可能尚未同步该平台提交"）并保留预填文本。
- **`REVIEW_REQUEST_TEXT` 带上本场关键事实**（[Assistant.tsx:277](client/src/pages/Assistant.tsx)）：如"这场 AC 了 2/6 题"；对 `joined-list` 且零提交的场次提示"我没有同步到该场提交记录"。
- **`gatedNowcoderPost` 判定窗口**：现只查前 400 字符（[fetch-editorial.ts:100](server/src/ai/fetch-editorial.ts)），"仅作者可见"可能出现在标题之后；建议放宽到 2000 字符，并与正文长度下限合并成一个明确的"像题解吗"判定函数。误判代价是**把导航噪声当题解喂给 AI**，比报错严重。
- **`isOneSitting` 阈值与赛事时长联动**：`SITTING_SPAN_MS = 6h`、`SITTING_MIN_PROBLEMS = 3` 硬编码（[participated.ts:190](server/src/contests/participated.ts)），对 2 小时 ABC 与 5 小时 ICPC 同口径。AtCoder 以日历匹配为主路径、风险可控，但建议注释说明来源或与日历 `durationMinutes` 联动。

---

## 五、优先级总表

| 阶段 | 改动 | 成本 | 对应需求 |
| --- | --- | --- | --- |
| **0** | 提示词强制"先读题面再判断" | **极小**（纯文本） | 需求 3：只凭题名偏差 |
| **1.1** | chat 路径改读库快照（P0） | 小（~10 行） | 链路开销（阶段 2 的硬前置） |
| **1.2** | 题目集三态 + 空态可缓存（P0） | 中（哨兵值/列 + 迁移） | 重复拉取、语义错误 |
| **1.3** | `resolveContestGroup` 下推过滤（P1） | 小 | 长对话 CPU/DB 开销 |
| **1.4** | `force` 不吃 in-flight（P1） | 小 | "刷新"按钮失效 |
| **2** | 题面预取 + 落库 + 预算控制 | 中（新表 + 抓取 + 预算） | 需求 3（根治） |
| **3** | 题解入口 + 证据分级/强制取证 | 小（拼接 + 文本） | 需求 2：不因过难而给错题解 |
| **4** | tags 放宽/标注 + AC 语言 + 渲染预算 + 篇幅分档 + 空态区分 | 极小-中 | 需求 2：更准确判断类型与标签 |
| **5** | AC 源码（用户投喂为主） | 小-中（AtCoder 需实测） | 需求 2（**平台受限**） |
| **6** | 前端提示、预填文本、工具判定 | 小 | 体验细节 |

### 推荐执行路径

1. **立即**：阶段 **0 + 4**（纯文本与小改动，效果立刻可见，**不依赖缓存修复**）。
2. **随后**：阶段 **1.1 + 1.2**（修缓存的硬前置）。
3. **再后**：阶段 **2**（题面落库，根治）。
4. **然后**：阶段 **3**。
5. **最后**：阶段 **5 + 6**。

**两条硬依赖**：
- 阶段 2 **必须**在 1.1 之后（否则网络开销叠加恶化黑屏）。
- 阶段 0 若遵循率不佳，则阶段 2 的服务端预取成为**必需**（把题面直接塞进上下文，不给模型跳过或编造的机会）。

---

## 六、必须诚实说明的限制

1. **"让 AI 自动看所有 AC 代码"大部分平台做不到**——CF 公开 API 明确不返回源码，牛客/洛谷需登录且他人代码不可见。这是**平台边界，不是实现难度**。方案给的是**题面 + 题解 + 语言 + 用户投喂**四条替代路径。
2. **题面与题解抓取的实测未做**（本会话无法联网）。CF/AtCoder 公开 SSR 把握较大，但**牛客登录墙、洛谷页面结构变化**需先小规模实测再铺开——参照 [cfProblemset.ts](server/src/contests/cfProblemset.ts) 的"失败静默 + 退避"约定。
3. **阶段 0 的遵循率未知**——提示词约束是"软"的，需真实对话观察。若 AI 仍不读题面，说明必须靠阶段 2 预取兜底。
4. **抓取的 ToS/频率风险**：批量抓取需遵守各平台 robots 与限速，建议复用已有的 [hostThrottle.ts](server/src/net/hostThrottle.ts) 节流设施，并控制单次预取题数。
5. **本计划最初产出时 PowerShell 与联网均不可用**（每次调用返回 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\01-代码项目\工作台)`，来自 DSH 文件沙箱为工作目录授权时的 Win32 错误 5）。该限制**已在后续实施会话解除**（沙箱授权失败时改用 `danger-full-access` 一次性提权即可运行 npm/git），故本文的「未运行测试」已不再成立——见文末第七节的实际验证结果。

### 实施后的验证要求

- 补跑 `npm test` 与 `npm run typecheck`；
- 重点覆盖：`test/contests-participated.test.ts`（推导与渲染断言）、`test/assistant.test.ts`（提示词断言）、`test/cf-problemset.test.ts`（缓存模式参照）；
- **新增** `problem_statements` 的用例（预取、缓存命中、抓取失败降级）；
- 为题目集三态返回值补充用例；
- 阶段 1.2 若引入新哨兵值或列，需写迁移（参照 [db/index.ts:83](server/src/db/index.ts)）。

---

## 七、实施状态（2026-09-26）

| 阶段 | 落地位置 | 状态 |
| --- | --- | --- |
| 0 提示词强制「先读题面再下判断」 | [assistant-prompt.md:52](server/src/ai/assistant-prompt.md#L52)（含第 5 条：上下文已注入题面则不重复抓） | ✅ |
| 1.1 chat 路径改读库快照 | [ai.ts:508](server/src/routes/ai.ts#L508) `readParticipationSnapshot` + `kickBackgroundRefresh` | ✅ |
| 1.2 题目集三态 + 空态可缓存 | `problem_set_state` 列（[schema.sql:353](server/src/db/schema.sql#L353)）+ 迁移（[db/index.ts:89](server/src/db/index.ts#L89)）+ [fetchContestProblemSet](server/src/contests/participationSources.ts#L800) | ✅ |
| 1.3 `resolveContestGroup` 按平台下推过滤 | [participated.ts:169](server/src/contests/participated.ts#L169) `fetchContestableRows(db, targetPlatform)` | ✅ |
| 1.4 `force` 不吃 in-flight + 补 failures | [participationSources.ts:679](server/src/contests/participationSources.ts#L679) | ✅ |
| 2 题面预取 + 落库 + 预算控制 | `problem_statements` 表（[schema.sql:398](server/src/db/schema.sql#L398)）+ [problemStatements.ts](server/src/contests/problemStatements.ts)（后台预取 + 读库注入 + ≤20K 字符预算） | ✅ |
| 3 题解入口 + 证据分级 | [editorialEntryPoint](server/src/contests/participated.ts#L801)（AtCoder/洛谷给 URL，CF/牛客给搜索词）+ 提示词证据分级（[assistant-prompt.md:75](server/src/ai/assistant-prompt.md#L75)） | ✅ |
| 4 tags 放宽/标注 + AC 语言 + 渲染预算 + 篇幅分档 + 空态区分 | [participated.ts](server/src/contests/participated.ts#L154)（8 个 tags、官方来源标注、AC 语言、预算按信息量分配、三态空态区分）；篇幅分档见 [assistant-prompt.md:93](server/src/ai/assistant-prompt.md#L93) | ✅ |
| 5 AC 源码（用户投喂为主） | 提示词「补题证据：用户投喂的 AC 代码 / 题解」（[assistant-prompt.md:95](server/src/ai/assistant-prompt.md#L95)）；不做跨平台源码抓取 | ✅ |
| 6 前端提示、预填文本、工具判定 | [assistantContest.ts](client/src/pages/assistantContest.ts)（复盘请求带本场事实 + 跳转失败明确提示并保留预填）+ `?contest=` 分支（[Assistant.tsx:704](client/src/pages/Assistant.tsx#L704)）+ [classifyNowcoderEditorial](server/src/ai/fetch-editorial.ts#L114)（登录墙窗口 400→2000，与体量下限合并判定） | ✅ |

**本轮实施中的两处取值决策（需知悉，非拍脑袋）**

1. **渲染上限 40 题/200 提交 → 24 题/400 提交**（[participated.ts:529](server/src/contests/participated.ts#L529)）。依据是平台赛事结构（CF Div1/Div2 6–9 题、ABC 7–8 题、ICPC/gym 10–13 题 → 24 已含近一倍余量；真正的约束是提交数），**不是本地样本**：本机真实库只推导得出 4 场比赛（最多 8 次提交 / 4 题），样本不足以统计校准。
2. **新增「给后续未渲染的题各预留 1 条时间线」**：预算是按渲染顺序消耗的，原实现下前段题可把总量吃光，导致后段（往往是最该复盘的难题）只剩一条空时间线。现保证每题至少一条摘要行（[participated.ts:698](server/src/contests/participated.ts#L698)）。

**实际验证结果（本轮）**

| 命令 | 结果 |
| --- | --- |
| `npm test` | server 893 通过 / 0 失败；client 332 通过 / 0 失败 |
| `npm run typecheck` | server + client 均无错误 |
| `npm run lint` | 0 error（14 个既有 warning，均不在本轮新增/改动文件） |
| `npm run build` | 构建成功（仅既有的 chunk 体积提示） |
| 真实库冒烟（只读） | 4 场可推导比赛全部「列表能选到 → 解析得回 → 渲染成文」；新字段（`AC 语言`、空态区分）实测输出正常 |

**仍未验证（诚实说明）**：题面/题解的真实联网抓取**没有实测**——`problem_statements` 表目前为空（真实库 0 行），抓取链路只有 stub fetch 的单测覆盖。首次真实复盘前建议先小规模试抓 CF/AtCoder 各 1 题，确认抽取质量与限速（复用 [hostThrottle.ts](server/src/net/hostThrottle.ts)）。

### 7.1 上线后修复：已 AC 题的题面编造（2026-09-26）

**用户实测反馈**：比赛复盘里，**赛时已 AC 的题没有抓题面**，AI 助手于是对已 AC 的题**编造题意**。

**根因**（两处叠加，缺一不可）：
1. **数据缺口**：`prefetchProblemStatementsBackground` 与 `renderStatementSection` 各自只挑「未通过 + 未提交」的题，已 AC 的题**既没抓也没注入**——甚至有测试把这条错误行为固化成断言（`不应包含已 AC 题的题面`）。
2. **空态未声明**：无缓存时 `renderStatementSection` 直接返回空数组，`### 题面` 一节整段消失 → 上下文里没有任何"这道题没有题面"的信号。而提示词要求「逐题点评…做对的题点出关键一步」「把题意一句话概括写进该题点评的开头」，还给了一句"已 1A 的简单题可按用户要求略过"的许可 → 模型只能靠题名补一个题意。**空态没被说清，模型不会说"我不知道"，它会把空当满。**

**修复**（[problemStatements.ts](server/src/contests/problemStatements.ts)）：
- 新增 `collectStatementTargets`：预取与注入**共用同一口径**，覆盖该场所有题（未通过 → 未提交 → **已 AC**），已 AC 的题按 1600 字符预算注入；预取单轮上限 26 题（其余下轮补）。
- `renderStatementSection`：**未注入题面的题逐个列名**并附「禁止凭题名概括题意、禁止推断考点与卡点」；区分"正在后台预取"与"平台无题面来源"；每场预算 20K → 30K。
- 提示词（[assistant-prompt.md:52](server/src/ai/assistant-prompt.md#L52)）：删掉"已 1A 可略过"的许可，明确"赛时已 AC ≠ 不需要题面"，并新增硬性第 6 条禁止对未取到题面的题描述题意。
- 测试：改掉固化了 bug 的两条断言，新增 4 条（含 `prefetchProblemStatementsBackground` 必须抓取已 AC 题的回归用例）；`assistant.test.ts` 增加"chat 注入的 system 必须带「未取到题面」声明"的端到端断言。

**本轮验证**：`npm test` server 897 / client 332 全通过，typecheck 无错，lint 0 error；真实库**迁移副本**冒烟：题面表为空时 4 题全部列入「未取到题面」，灌入 3 道已 AC 题的题面后它们被正常注入、只剩未提交/未通过的那题留在清单里。

### 7.2 覆盖与质量：尽量抓取所有能找到的题面（2026-09-26 真实联网实测）

用户要求「尽量抓取所有能找到的题目题面，确保分析准确」。本轮**真的连网实测**了各平台，
结论与据此做的改动如下（全部有实测依据，不再是推断）：

| 平台 | 实测结论 | 依据 |
| --- | --- | --- |
| **AtCoder** | ✅ 题面 + **题目列表**都能抓 | 题目页 `#task-statement` 内含 `lang-en`/`lang-ja` 两份；`/contests/{slug}/tasks` 实测列出 abc454 A–G 共 7 题 |
| **洛谷** | ✅ 匿名可抓（需过 C3VK 反爬） | 直连 `problem/P1001` 抛 `fetch failed`（302 循环）；改 `redirect:'manual'` + 取新 C3VK 重试 → 200，抽到 1537 字符题面 |
| **牛客** | ⚠️ **尽力抓**（多数比赛题目页公开可读） | 用户实际库（demo 数据集）里 6/6 成功，700-900 字符真实题面（题目描述/时空限制/样例齐全）；但部分页面返回「没有查看题目的权限哦」导航页（实测 `acm/problem/213096`）→ 照抓，噪声校验兜底 |
| **Codeforces** | ❌ HTML 页全被拦（**但配了 Cookie 会尝试**） | `/contest/1877/problem/A`、`/problemset/problem/1877/A` 均 403 "Just a moment..."；官方镜像 m1 返回 JS 机器人校验页、m2 403、mirror 连不上；`codeforces.com/api/*` 正常但**不含题面**。已留出口：`fetchProblemStatement` 对 blocked 平台在**存在该平台 Cookie** 时仍会尝试（CF 的 `cf_clearance` 可过挑战，同 QOJ 做法），抓回内容仍过噪声校验 |
| 计蒜客 / QOJ / 代码源 / 力扣 | ❌ 无公开可抓来源 | QOJ `/problem/*` 403 challenge；计蒜客题目页是 SPA（1472B 空壳） |

**据此做的四件事**

1. **AtCoder 抽取修好了（原本是坏的）**：旧实现 `([\s\S]*?)<\/div|span>` 懒匹配到第一个 `</span>` 就收工，
   实测**只抽到 68 字符**（一句「問題文」，丢掉约束/输入输出/全部样例）→ AI 拿半截题面照样出错。
   现按「语言 span + 外层 `class="lang"` 的连续两个 `</span>`」定界、优先英文块，
   实测 7 题得 670 / 1263 / 998 / 1896 / 2147 / 1479 / 3027 字符。
2. **题目集覆盖扩到 AtCoder**：`fetchContestProblemSet` 新增 `atcoder` 分支（`/contests/{slug}/tasks`），
   于是「赛时未提交的题」有题号/题名，**它们的题面也进得了预取范围**——实测 abc454 的 E/F/G 三题
   （本地从未提交）题面全部抓到并注入。
3. **噪声一律拒收 + 平台矩阵**：新增 `statementSupport()` 与 `statementLooksValid()`
   （权限墙/挑战页/站点导航 → 不落库）。语义现在是三档：
   **`ok`**（AtCoder/洛谷，公开必抓）、**`gated`**（牛客，尽力抓——公开页能拿到，登录墙页被噪声校验拦下）、
   **`blocked`/`unsupported`**（CF 需 Cookie、计蒜客·QOJ 无源 → 默认**不发请求**）。
   抓不到时上下文写明原因 + 可执行替代路径（请用户粘贴题面），提示词同步改成"取不到就先请用户贴，
   不许凭题名硬讲"。CF 也据此明确告知用户（这是平台边界，服务端无解）。
4. **顺手修掉一个题名串号的数据缺陷**：`problems.title` 来自 kenkoooo 社区 `problems.json`，
   实测字母前缀错位（`abc454_b` → 「C. Mapping」、`abc454_c` → 「F. Straw Millionaire」、
   `abc454_d` → 「G. (xx)」）；官方 tasks 页才是权威。现在抓题目集时**顺手修正库内 title**
   （写 `problems.title`，仅在本场且不一致时写），并在同一条消息内重解析一次，让本轮「逐题明细」
   与题面标签立刻一致（实测修复后：`abc454_b B. Mapping`）。

**CF 还差半步（未做，需用户决定）**：`fetchProblemStatement` 已支持"blocked 平台带 Cookie 就试一次"，
但**设置页目前没有 CF 的 Cookie 输入框**（CF 在 `PLATFORMS` 里是 `sync: 'auto'`，UI 只对 `sync: 'cookie'`
的平台渲染 Cookie 字段）。要真正解锁 CF 题面，需要：给 CF 加 `cf_clearance` + 匹配 UA 两个配置项
（`cf_clearance` 与浏览器 UA 绑定）并放开 UI 条件；本轮没做，因为**没有真实 `cf_clearance` 就无法验证**，
不想留一条假装能用的路径。

**本轮验证（真实联网，非 stub）**：`npm test` server 907 / client 332 全通过、typecheck 无错、lint 0 error；
真实库迁移副本跑完整链路（解析单场 → 补拉题目集 → 后台预取 → 渲染）：AtCoder abc454 七题题面全部落库并注入，
未提交题 E/F/G 也带上了官方题名与题解入口；洛谷 P1001 匿名取到 1537 字符题面；
牛客 320779/320786 取到真实题面（731/757 字符）、权限墙页 213096 被拒；
CF 返回 null 且上下文如实说明原因。

### 7.3 修复：赛事中心「我参加的」总题数显示成"我交过几题"（2026-09-26）

**用户反馈**：牛客周赛162 共 6 题、已 AC 4 题，赛事中心却显示总共只有 4 题。

**根因**（[participated.ts:371](server/src/contests/participated.ts#L371)）：
`qualifyGroup` 里 `problemCount: problemKeys.size` —— 取的是**本地提交里不同题目的个数**，
完全没用已经存好的权威数据。实测用户实际库（`server/config.json` 的 dbPath 指向
`videos/edit/demo-data/data/icpc.db`）该场一行：

```
nowcoder 140489 | 牛客周赛 Round 162 | problem_count=6 accepted_count=4 problem_ids=6 道
```

即**库里本来就有 6**，只是渲染时被 `problemKeys.size`（=4）覆盖了。同一缺陷还波及
「N 题 · AC M」列表行、AI 助手的比赛下拉项、复盘请求里的「AC 4/6 题」分母
（此前会写成「AC 4/4 题」），以及 `renderContestContext` 在题目集未知时的概况句。

**修复**：`problemCount` 语义明确为**该场共几题**，三者取最大（"至少这么多"——不可能提交到不存在的题）：
① 平台参赛记录题数 `src.problemCount` → ② 已拉取题目集 `src.problems.length`
→ ③ 本地提交去重 `problemKeys.size`（兜底）。

**验证**（读用户实际在用的库，只读）：
`nowcoder:140489 牛客周赛 Round 162 → 6 题 · AC 4 · 7 次提交`（修复前 `4 题 · AC 4`）；
同批发现在其它场次也一起修正了，例如 `codeforces:2241 → 20 题 · AC 4`（修复前 4 题）、
`luogu:358517 → 8 题 · AC 2`（修复前 2 题）。测试新增「牛客周赛162：共 6 题、交 4 题全 AC → 6 题 AC 4」
的回归用例（含未提交题 E/F 的推导与上下文概况断言）。

### 7.4 风控审查：把新老抓取路径全部收进全局节流（2026-09-26）

用户要求「审查已修改的代码，保证拉取不要过于频繁，避免风控」。审查结论与处置：

**现状（审查前）**：全局节流层 [hostThrottle.ts](server/src/net/hostThrottle.ts) 已存在且很严
（1× 安全下限：atcoder 2.5s / 洛谷 **4s** / 牛客 2s / CF 2s / QOJ 2.5s；用户可在设置里调到 1×–5×）。
同步、日历、难度回填、题面/题目集抓取**都**走它。但审查发现**两个 AI 工具绕过了节流**：

| 位置 | 问题 |
| --- | --- |
| [fetch-url.ts](server/src/ai/fetch-url.ts) `directFetch` | 用裸 `fetch`；逐跳跟随重定向（≤5 跳）+ 洛谷 C3VK 原地重试 = **一次工具调用可能对同一站点连发近十次请求，间隔为 0**（洛谷是全表最严的一档，风险最高） |
| [fetch-editorial.ts](server/src/ai/fetch-editorial.ts) | 默认 `fetchFn = fetch`，AI 每轮对话可多次调用，完全不受限速 |

**改动**

1. 两个工具的默认传输层改为全局节流单例（`FETCH_URL_TRANSPORT` / `EDITORIAL_TRANSPORT`），
   并在工具执行处支持 `ctx.fetchFn` 注入（测试用），生产缺省即节流；
   于是 AI 的每次抓取（含每一跳重定向、每一次 C3VK 重试）都按域名排队，与同步管道共享同一份节奏。
2. 题面失败退避从**固定 5 分钟**改为**指数退避 5→10→20→40→60 分钟封顶 + ±20% 确定性抖动**
   （`statementRetryDelayMs`）：一场比赛十几道题若因结构性原因全部失败，固定退避会在用户持续
   对话时形成「每 5 分钟重试全部题」的长期轮询（≈156 请求/小时）；指数退避后稳态降到
   ≈13 请求/小时（**约 1/12**），抖动还避免同一批题在同一秒齐发（抖动用 key 哈希，可复现）。
   成功落库即清退避记录——此后由缓存命中挡住，永不再请求。

**审查后的请求量（最坏情况，均为节流后）**

| 场景 | 请求量 | 说明 |
| --- | --- | --- |
| 首次复盘一场 AtCoder 比赛（13 题） | 14 次（1 题目列表 + 13 题面），≈32s 后台完成 | 题面永久缓存，**一场只发生一次** |
| 后续每条对话消息（比赛已关联） | 0 次网络（全命中缓存） | 只有 DB 查询；缺失的题受退避约束 |
| 抓取持续失败（路径性失败） | ≈13 次/小时/场（0.22 次/分） | 指数退避 + 抖动；单次间隔仍受 2.5s/4s 节流 |
| 同平台并行（同步 + 题面 + AI 工具） | 共享同一份按域名预约 | 不会出现两条路径叠加翻倍 |

**未纳入节流的路径（有意）**：LLM API（provider）、搜索 API（Tavily/Brave）、更新检查（GitHub）、
设置页模型探测、SEA 自检（127.0.0.1）—— 这些不是会被"风控封号"的 OJ 站点。

**测试**：新增 4 条——`statementRetryDelayMs` 指数/封顶/抖动可复现、失败后窗口内不再请求（请求量
不被对话轮次放大）、`FETCH_URL_TRANSPORT === throttledFetch`、`EDITORIAL_TRANSPORT === throttledFetch`；
`fetch-url.test.ts` 改为显式注入 mock 传输层（不再依赖 `globalThis.fetch` 补丁，测试仍封闭且不触发真实网络）。