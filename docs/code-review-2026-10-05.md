# 代码审查报告（2026-10-05）

> 范围：server（约 6.2 万行 TS）、client（约 2.7 万行 TS）、shared。方式：类型检查与 1603 个单元测试全部通过的前提下，按模块分区深查测试覆盖不到的逻辑 bug，重点为最近高频改动区（账号级凭据、AtCoder 同步修复、复习事件、AI 工具循环、双通道更新）。所有 P1 发现均经数据流追踪人工核实或最小复现实证。
>
> 状态标注：✅ = 本次已修复并带回归测试；📋 = 已定位未修复（建议排期）；❓ = 存疑（未确证，不建议直接当 bug 修）。

## P1（已全部修复）

### 1. ✅ 打包版/Docker 入口缺少 Cookie 迁移——升级用户账号同步全部失效
- 位置：`server/src/sea.ts`（启动序列）对照 `server/src/index.ts:44-50`
- 成因：`migratePlatformCookieToAccounts` 只在 dev 入口 index.ts 调用；打包版唯一入口 sea.ts（`build-exe.mjs` 的 entryPoints，Docker 非 SEA 分支同样走它）从 createDb 到 listen 完全没有这一步。v0.9 起 `effectiveCredentials` 不再回退平台级 Cookie，pre-0.9 升级用户的账号同步从此全部报「未配置 Cookie」且界面无法自愈。
- 修复：sea.ts 补齐同序调用；`route-parity.test.ts` 的 STARTUP_CALLS 清单加入 `migratePlatformCookieToAccounts(`，从源头堵住双入口遗漏。

### 2. ✅ AtCoder 回看窗口 × 单次上限：游标停滞/回退，高频用户新提交永远同步不进来
- 位置：`server/src/adapters/sync.ts:281`、`server/src/adapters/atcoder.ts`（行循环与上限判定）
- 成因：4178f28 让 AtCoder 增量固定从 `last_sync_at − 12h` 起拉（回看窗口），但适配器对已入库行一无所知，300 条单次上限把回看窗口内的**旧行**也计入预算——12h 窗口内 ≥300 条提交（日均 ≥600，比赛周末常见）时旧行吃满预算，游标停在原处甚至倒退，反复同步永远「新增 0 条、已截断」。
- 修复：AtCoder 声明 `knownIdsFilter`，sync.ts 对升序平台在 days 窗口模式同样注入 knownExternalIds；适配器把已入库行跳过且**不占上限预算**（升序扫描不做整页提前终止）。

### 3. ✅ AtCoder 同秒砍点丢提交；「整秒收下」防护是死代码
- 位置：`server/src/adapters/atcoder.ts`（旧 :203 的 `raws.length > maxSubmissions` 恒假）
- 成因：内层循环先判上限再 push，`raws.length` 永远不会超过上限 → 上限落在某一秒中间时，该秒剩余行被砍掉后，秒级游标（末行秒+1）把它们永久跳过（460 逐秒 + 41 同秒 + 1 更晚的模拟实丢 1 条）。
- 修复：砍点判定移入行循环——上限满时同秒行继续收下（略超上限也在所不惜）、遇到更晚秒才砍批；同步层光标停在砍点整秒，下轮重拉由 knownIds 跳过（不占预算）+ 唯一键去重兜底。

### 4. ✅ 账号 Cookie 清空后被启动迁移「复活」成别的账号的登录态
- 位置：`server/src/adapters/accountCreds.ts`（migratePlatformCookieToAccounts）+ `server/src/routes/settings.ts:311-320`
- 成因：迁移自称「一次性、幂等」，实际是每次启动把平台级影子 Cookie 播种给**所有尚无槽位**的绑定账号。用户显式清空账号 A（只删槽位、影子值保留）或新绑定账号还没配 Cookie，重启后都被播种上影子值——即最后保存凭据那个账号的 Cookie，同步/检测全链路被静默污染。
- 修复：每平台一次性台账（settings 键 `accountCreds.migrated.<platform>`）：迁移执行过一次（哪怕当时无账号可迁）就永不再播种；升级当刻已绑定的无槽位账号拿到的正是升级前实际共用的值（迁移本意），此后的新账号与清空动作一律尊重现状。注意：已随 v0.9 跑过旧迁移的用户，其清空过的凭据会在升级后的第一次启动被复活最后一次，之后永不再发生。

### 5. ✅ review_events 外键清理遗漏——洛谷 T 号转正后同步链路永久中断
- 位置：`server/src/import/problemMerge.ts:69/118`、`server/src/routes/problems.ts:599/612`、`server/src/db/index.ts:253/277/538`
- 成因：964cb02 新增的 `review_events` 带两个不级联外键（review_item_id / problem_id），但删条目/删题只在两条路径补了清理。洛谷比赛题 T 号赛后转 P 号触发 `mergeProblemRow` 时：`DELETE review_items`（撞 UNIQUE 分支）或 `DELETE problems` 抛 `FOREIGN KEY constraint failed` → 整个同步事务回滚；旧键提交每次同步重新下发，同步从此每次失败（sqlite 最小复现实证）。clean-tags 去重与两处启动迁移为同型雷。
- 修复：四处统一口径——搬移条目的反馈历史对齐保留行（条目 id 不变、problem_id 改指保留行），丢弃条目的反馈历史随条目删除；dedupeReviewItems 先删 events 再删条目。

### 6. ✅ AI 工具轮次循环丢失中断信号——点「停止」后后台继续烧配额
- 位置：`server/src/routes/ai.ts`（工具往返循环，旧 :806 的 chatStream 无 signal、循环体无 aborted 检查）
- 成因：第一轮传了 `signal`，循环内的后续轮次与工具执行没有任何监听——用户在第 2 轮起点「停止」，剩余轮次的生成与工具调用照常跑完（最多再烧 4 轮 + web_search/fetch_url 各十几秒），写入死连接。
- 修复：循环内 chatStream 传同一 abortController.signal；循环顶与每个工具执行前检查 aborted 立即退出；中断异常交外层 aborted 分支收尾（不再误写「AI 调用失败」错误事件）。

### 7. ✅ 难度回填「停止」后按钮永久卡死（跨页面/标签页场景）
- 位置：`client/src/pages/Problems.tsx`（stopBackfill / stopping 状态）
- 成因：`stopped: true` 时不复位 stopping，复位依赖的 runBackfill finally 只覆盖本组件实例发起的回填；回填由服务端跑、刷新/重开后重新打开页面（代码注释明确支持）或双开标签页时点停止 → 「一键回填」永久禁用、「停止回填」永久转圈。
- 修复：新增 effect——轮询到服务端运行已结束（`run.running === false`）即复位 stopping，停止按钮的 loading 语义变为「等真正停稳」。

### 8. ✅ 设置页其他操作静默清空未保存的 AI 配置编辑
- 位置：`client/src/pages/Settings.tsx`（AiSettingsCard 同步 effect）
- 成因：effect 依赖 `[ai, form]`，任何一处无关 `load()`（账号启停/删除、同步开关、提醒保存等 10+ 处）都产生新 `ai` 引用 → 用服务端值整体重建提供商草稿并重置表单——正在编辑的密钥/地址/模型/参数、尚未保存的新增提供商整条消失。本页 252-260 行注释记载了 cookieInputs/acctInputs 的同款历史缺陷及修复，AI 卡片是漏网的。
- 修复：首挂载全量对齐；此后只做「结构对账」——服务端新增补草稿、本地未保存的新增保留、本地未保存的删除不复活（locallyDeleted 台账）、已存提供商的草稿内容不动（hasApiKey/apiKeyMasked 两个服务端权威展示字段除外）；saveAi 成功后就地清空本次提交的密钥草稿（clearSubmittedApiKeys）。

## P2（已定位，未修复）

**服务端**
1. 📋 `pruneBackups` 缺「待恢复目标不可删」守卫（`backup.ts:135-152,228`）：保留策略可删掉登记在 restore-pending.json 的备份，`applyPendingRestore` 静默清标记——用户点了恢复、重启后什么都没发生也无日志。
2. 📋 `POST /api/update/apply` 在校验 staged 前就创建升级前备份（`update.ts:376`）：无待更新时反复点「应用」会把真正的升级前恢复点挤出保留窗口。
3. 📋 `/accounts/rename` 迁移不完整（`settings.ts:576`）：participated_contests 与增量游标不跟随改名 → 旧 handle 数据残留成重复记录 + 全量重拉。
4. 📋 CF 适配器忽略 `windowSince`（`codeforces.ts:94`）：「仅同步最近 N 天」在 CF 上是假窗口，且会向用户谎报「窗口内仍有未覆盖的记录」。
5. 📋 CF 纯数字题号 `problemUrl` 拆错（`codeforces.ts:71`）：`92101` → `contest/9210/problem/1`（应为 gym 921 的 01 题）；`participated.ts` 的 contestIdOf 已有正确规则未复用。
6. 📋 sea.ts 非 SEA 分支（Docker 生产入口）无 listen 错误处理、无 SIGTERM/SIGINT 优雅退出；SEA 优雅退出不关 db、Windows 关窗实际走 SIGHUP 未监听；重复实例探测只查默认端口，端口漂移后会拉起第二个完整实例（`sea.ts:279-342`）。
7. 📋 DSML 残片抢救只覆盖 `dsmlMode`：正常文本模式流结束时暂扣的 `<｜DS` 类前缀（≤7 字符）无出口被静默丢弃（`provider.ts:559,665`）。

**客户端**
8. 📋 启动恢复 staged 更新失败是未处理 rejection 且 UI 卡在 100%（`updateContext.tsx:160-173`）。
9. 📋 后台静默检查更新失败会弹错误 toast，违背自身「完全静默」的设计注释（`UpdateChecker.tsx:27` + `updateContext.tsx:63`）。
10. 📋 流式生成期间每次 flush 对全部会话全量 JSON.stringify 写 localStorage（上限 50 会话，可到 MB 级），长回复明显卡主线程（`Assistant.tsx:211,1110`）。
11. 📋 模板目标/展开状态按消息下标做 key，「再次编辑」截断后下标移位导致选择错配（`Assistant.tsx:545,1352,1530`）。

## 存疑（❓ 不建议直接当 bug 修）

- 影子 Cookie 兜底拉取的参赛记录记在 `luoguAccounts[0] ?? ''` 名下，多账号时归属误标（`participationSources.ts:969-993`）。
- 续拉队列同平台单槽：`scheduleAutoContinue` 可能返回属于另一 handle 的既有状态（`syncScheduler.ts:104`）。
- 牛客「系统错误/未知错误」按非终态每轮重扫不落库（`nowcoder.ts:35`），与洛谷 UKE→RE 落库口径不一致。
- `fetch-url` 存在 DNS rebinding TOCTOU 窗口（`fetch-url.ts:117-130`）——桌面单用户场景风险有界。
- Linux 无 `xdg-open` 时 `openBrowser` 子进程未挂 error 监听会打崩 SEA 进程（`sea.ts:379`）；`migrateLegacyDataDir` 中断残留使迁移永不重试（`data-dir.ts:67-82`）。
- 赛前提醒 minutesBefore 的 onChange 即时提交在快速连续变更时可能乱序回填旧值（`Settings.tsx` 附近）。
- `ContestReminder.tsx:82`：Date.parse 为 NaN 时过期记录永不清理（仅 localStorage 损坏才触发）。

## 已查证无问题的重点

- `updater.ts` 分片并行 pwrite、PowerShell 单引号转义与 repo 白名单、`backup.ts` 的 VACUUM INTO 快照一致性、`db/index.ts` 各数据修复迁移的幂等性（rebuild 原子性为近期修复，现状正确）。
- `pagination.ts` 截断/补全游标语义、syncScheduler 抢占与防重入、http.ts/http1.ts 重试超时、qoj Cookie 改名、jisuanke 双段游标、participated 双口径、赛事日历五源。
- 复习调度状态机（阶梯/hard 折返边界、UTC 锚定日期、错峰、幂等加入、留存系数查询）、难度回填状态机（分批事务、负缓存、中断恢复）、CSV RFC4180 解析、tombstones 等价类放行。
- 客户端 streamBuffer 攒批与收尾必达、api.ts SSE 多字节/CRLF/半截 JSON 处理、各页面数据加载的 reqSeq 护栏、updateThrottle 语义、syncProgressContext seq 护栏。

## 本次修复涉及文件

| 类别 | 文件 |
| --- | --- |
| 服务端修复 | `sea.ts`、`adapters/sync.ts`、`adapters/atcoder.ts`、`adapters/types.ts`、`adapters/accountCreds.ts`、`import/problemMerge.ts`、`routes/problems.ts`、`routes/ai.ts`、`db/index.ts` |
| 客户端修复 | `client/src/pages/Problems.tsx`、`client/src/pages/Settings.tsx` |
| 新增测试 | `server/test/problem-merge-review-events.test.ts`（3 例） |
| 扩展测试 | `route-parity.test.ts`（STARTUP_CALLS +1）、`accountCreds.test.ts`（+4 例）、`atcoder.test.ts`（+2 例）、`ai-search-stop.test.ts`（+1 例）、`problem-duplicates.test.ts`（2 例断言加强） |

验证：`npm run typecheck` 通过；`npm test` server 1144 / client 459 全部通过；client lint 与改动前基线持平（9 条既有警告，无新增）。

---

# 第二轮审查与修复（同日，多提供商改造的改动集）

> 范围：工作区当时未提交的全部改动（多 AI 提供商重构 + 上一轮修复 + 新增测试）。方式同上：逐条最小复现，
> 且每处修复都配「移除修复即失败」的回归用例。

## P1（已修复）

1. ✅ **AtCoder 平台侧改判永久刷不回来**（本次改动引入的回归）：声明 `knownIdsFilter` 后，同步层在所有模式
   注入已知提交号，适配器对命中行无条件 `continue` —— 提交时还在评测队列（`WJ/WR/JUDGE → SKIPPED`）已入库的行
   再也不会进写入层，`importService.refreshVerdict` 无法把判定刷新成 AC/WA（能力值、统计、已做判定全错，无自愈路径）。
   违反 `FetchOptions.knownVerdicts/knownProblemKeys` 的明文契约（jisuanke/luogu 均按契约重发改判行）。
   修复：命中已知行时比对判定与题号，变了就重发（未注入时维持跳过语义；改判行未刷新前每轮都满足条件，不会被静默丢）。
2. ✅ **保存 AI 配置会清空已配置的联网搜索密钥**：搜索密钥框是密码框、界面写「留空保持不变」，但客户端把整份
   表单值铺进请求体（恒带空串），服务端又把空串当显式写入 → 每次保存都抹掉密钥、`web_search` 工具随之不再注册。
   修复：客户端留空不下发 + 服务端把空串/空白当「保持已存值」（双保险）。

## P2（已修复）

3. ✅ **`AI_API_KEY` 环境变量密钥被原文写进 `settings.ai.providers`**（并随之进入每日备份）：迁移合成时把 env
   塞进 default 提供商的 apiKey，保存时又被当「已存密钥」兜底写库；旧单密钥路径下 env 密钥是永不落库的。
   修复：env 只参与运行时解析，绝不进读取/存储路径；视图新增 `apiKeyFromEnv`，前端显示「密钥来自环境变量」而非红标「未配密钥」。
4. ✅ **Cookie 迁移台账漏写**（台账只在「影子值已存在」时落）：而影子值是保存任一账号凭据时运行期写入的
   → 全新安装/从未配过平台级 Cookie 的用户会在日后某次重启被重新武装，把那时最后保存凭据的账号 Cookie 播种给
   所有无槽位账号（本次修复要消灭的静默借登录态）。修复：台账每平台**无条件**落一次，并与播种放进同一事务
   （写槽位失败则台账回滚、下次重试）。
5. ✅ **工具执行中点「停止」仍会再发一轮生成**（本次修复未覆盖的窗口）：轮次顶部的 aborted 检查只在每轮开始时
   生效，工具循环又只覆盖「下一个工具」；若停止落在最后一个工具执行中（web_search/fetch_url 十几秒，正是最可能点
   停止的时刻），控制流带着**已 aborted** 的 signal 走到下一轮 `chatStream`，而 provider 只挂监听不检查注册时状态
   → 监听器永不触发，照常发完整一轮生成。修复：工具循环后补 aborted 检查并抛 AbortError 交外层收尾；provider 对
   「进入时已 aborted」的信号就地取消（防御所有调用方）。

## P3（已修复）

6. ✅ **AtCoder 页边界把同一秒切开时静默丢提交**（既有缺陷，注释里的触发条件也写错了）：续拉游标只能按秒推进，
   末行同秒还有行排在 500 行窗口外时直接 +1 会把它们永久跳过且不置 truncated。修复：退回该秒重拉一次补齐
   （仅重试一次/秒防死循环；单秒 ≥500 行取不回的极端形态改为如实置 truncated）。
7. ✅ **AtCoder 页预算被已入库行吃满时 `last_sync_at` 直接跳到 now**：新增出参 `scannedUntil`，同步层用纯函数
   `ascendingNextLastSyncAt` 把光标停在扫描点，避免 (扫描点, now) 之间的提交被下一次 12h 回看窗口漏掉。
8. ✅ **模型目录勾选可超上限、保存时被服务端静默截到 50**（且结构对账不回写目录 → 界面与库永久不一致）：
   上限判断前移到采纳动作（`client/src/aiModelPicker.ts` 纯函数）并明确提示被挡下的条数。
9. ✅ **`POST /ai` 传空 `providers` 数组 → 500 且同请求全局项丢失**：改为显式 400 并给出原因。
10. ✅ **缺省 `activeProviderId` 被静默重置为首项**：缺省 = 保持已存活跃项，显式传入但失效才回退首项。

## 覆盖补充

- `mergeSlashedCfKeys` / `dedupeReviewItems` 的 `review_events` 清理此前无测试：补了「斜杠行带复习反馈历史时
  合并不炸启动」（回退修复即 `FOREIGN KEY constraint failed`，属「应用打不开」等级）。`dedupeReviewItems` 一支
  因 UNIQUE 约束无法在真实表上构造重复行，仍未覆盖（其清理语句与前者同一模式）。
- `route-parity.test.ts` 此前只做子串包含（注释掉的调用也能通过）：补了「启动副作用顺序一致且都不是注释」的断言。

## 有意保留（非缺陷）

- 切换提供商预设不重置模型目录（目录是用户资产，保留 + 提供「恢复默认模型」按钮）。
- `providers[].model` 允许留空（用户可能先存密钥后填模型；旧单密钥路径同样不校验）。

验证：`npm run typecheck` 通过；`npm test` server **1160** / client **464** 全部通过（较改动前 +16 / +5）；
client lint 仍为 9 条既有警告、无新增。关键修复均做过 A/B（移除修复后对应用例失败）。
