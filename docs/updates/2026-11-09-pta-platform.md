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
5. **平台没有难度字段**：`exam-problem-list` 的 `difficulty` 在 23 套题集里**恒为 0**（不是「1 档」而是「没有」）。
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
- **难度回填**：`pta` 登记进 `NO_DIFFICULTY_SOURCE`，不写负缓存也不重扫（平台侧根本没有难度）。
- **凭据**：`PTASession`（可选）。不配也能同步 23 套公开题集；配了才覆盖「我加入的题集」。
- **应用内登录 + 自动识别账号**（桌面版，见下节）：登录成功后由凭据反查 userId 并自动绑定账号。
- **链接识别**：`pintia.cn/problem-sets/{ps}/problems/{id}` 与老式 `/exam-problems/{id}` 都能粘进题单/复习。

## 取舍

- **不强制 Cookie**：`PLATFORMS.sync` 记的是 `cookie`（语义 = 「配 Cookie 后更完整」），但适配器在没有 Cookie 时
  照常工作，只是「我加入的题集」拉不到。这是站点匿名开放能力的直接结果，比强行要求凭据更可用。
- **单次同步的请求量天然等于题集数**：提交列表只能按题集查，所以一次同步至少打 23 次请求。页预算因此取
  `max(题集数, pageBudget)`，保证每套题集都被「看一眼」（增量判定正是靠那一次请求）。全量首同步实测约 36 秒。
- **标题补拉只在确有新行时做**：否则每次同步要额外多打 23 次题目表请求。
- **不猜难度**：平台不给就是未知（`difficulty=null` / `scale=none`），不按通过率臆造档位。

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

