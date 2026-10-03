# 代码细节优化计划（行为不变）

> 生成时间：2026-09（v0.5.3 基线）
> 范围：`server/src`、`client/src`、`shared/src`（桌面壳与构建脚本待补，见文末路线图）
> 原则：**只打磨细节，不新增/删除功能、不改变对外行为**。每条附【文件:行号】与建议改法，按主题分组、以「收益/风险比」排序。
>
> **验证状态图例**：✅ = 已人工读码复核属实；⚠️ = 子代理报告、待复核；无标记 = 待复核。

## 总体评估

代码整体质量很高：注释充分、防御性写法到位、SQL 建了索引、测试与 CI 齐全、类型安全良好（仅 epub2 动态导入处有 `any`）。以下条目属于「细节层面」的收尾打磨。已复核条目详见文末「已复核条目与修复示意」一节。

---

## 一、错误处理与信息泄露（高收益，改动小）

- [ ] **1. 全局错误中间件回显内部细节** ✅ · `server/src/middleware.ts:30`
  所有未特判错误统一 `res.status(500).json({ error: \`服务器内部错误：${err.message}\` })`，把文件路径 / SQL / 上游错误原文直接暴露给前端。
  **改法**：500 统一返回模糊文案，`err.message` 只进 `console.error`。

- [ ] **2. body-parser JSON 解析错误误报 500** ✅ · `server/src/middleware.ts:24-30`
  `express.json()` 的 `entity.parse.failed`（status 400）未特判，落到 500 分支并回显解析器原文。
  **改法**：补 `err.type === 'entity.parse.failed'` 分支返回 400「请求体不是合法 JSON」。

- [ ] **3. `headersSent` 分支未转交，可能挂起** ✅ · `server/src/middleware.ts:21`
  `if (res.headersSent) return;` 注释写「交给 Express 默认处理」但未调 `next(err)`，响应已发出后抛错时连接可能挂到超时。
  **改法**：改为 `return next(err)`。

- [ ] **4. 多处 502/500 回显上游原文** ⚠️ · `server/src/routes/problems.ts:525,710`、`lists.ts:257`、`settings.ts:591,662`
  拉取失败 / 回填失败 / 改名删号失败等把 `e.message`（含上游 fetch / AI / DB 异常）原样返回。
  **改法**：对用户不可操作的上游错误做白名单化或脱敏，本地错误用固定文案。

---

## 二、后端 SQL 性能（重复 prepare / N+1 / 冗余索引）

- [ ] **5. clean-tags 去重循环内重复 prepare** ✅ · `server/src/routes/problems.ts:587-623`
  循环体内 11 条固定 UPDATE/DELETE 每次迭代 `db.prepare()`；而同函数 `problemById`(580)、`markDeleted`(575) 已 hoist，写法自相矛盾。
  **改法**：全部 hoist 到循环外。

- [ ] **6. mergeSlashedCfKeys 循环内重复 prepare** ✅ · `server/src/db/index.ts:306-313`
  两条 DELETE 语句在循环内重复 prepare，其余语句（repointReviews/dropReviews/…）均已 hoist。
  **改法**：补 hoist 即可。

- [ ] **7. review_item_id 相关子查询 N+1** ✅ · `server/src/routes/problems.ts:295-296`
  `(SELECT ri.id FROM review_items ri WHERE ri.problem_id = p.id AND ri.user_id = ${DEFAULT_USER_ID})` 逐题标量子查询，`GET /` 不分页返回约 1.9 万行时即 1.9 万次子查询。
  **改法**：一次 `LEFT JOIN` 或请求内预取 Map 消除 N+1。

- [ ] **8. settings 逐 key 重复 prepare** ⚠️ · `server/src/routes/settings.ts:65-89,152-218` + `config.ts:96-102`
  一次 `GET /settings` 累计 15+ 次同名 `SELECT value FROM settings WHERE key=?`。
  **改法**：settings 是小表，一次 `SELECT key,value` 建 Map 复用。

- [ ] **9. 冗余索引** ✅ · `server/src/db/schema.sql:197` + `db/index.ts:109`
  `idx_submissions_user_platform(user_id,platform)` 是 `idx_submissions_user_account(user_id,platform,account)` 的严格前缀，完全冗余，每条提交 INSERT 多维护一个索引。
  **改法**：删除（注意迁移幂等，老库需一并处理）。

---

## 三、后端适配器 / AI 健壮性

- [ ] **10. http 传输层覆盖调用方 AbortSignal** ✅ · `server/src/adapters/http.ts:119`
  `res = await fn(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })`——`...init` 在前、`signal` 在后，覆盖 `init.signal`，与 `http1.ts` / `hostThrottle.ts`「遵守 init.signal」语义相反，客户端断连取消会静默失效。
  **改法**：合并调用方 signal 与超时（如 `AbortSignal.any([init.signal, timeout])`，需过滤 undefined）。

- [ ] **11. http1 缺 `res.on('error')`** ⚠️ · `server/src/adapters/http1.ts:78-95`
  响应体中途被 reset 会在 res 上抛未处理的 'error' 事件，`req.on('error')` 接不住。
  **改法**：补 `res.on('error', ...)`。

- [ ] **12. 同步失败分类误判** ✅ · `server/src/adapters/sync.ts:45-46`
  第 45 行 `rate_limited` 正则只含 `限流`，第 46 行 `auth_expired` 正则含 `风控`——「牛客 503 可能触发风控」会命中「风控」被误判为「凭据失效」，前端提示重填 Cookie 是误导。
  **改法**：`风控` 移入 rate_limited 或独立 blocked 分类。

- [ ] **13. AtCoder 题库重复拉全量 JSON 且无缓存** ⚠️ · `server/src/adapters/problemBank.ts:588-606`
  每次调用现拉两份全量大 JSON + 无条件 sleep 1s；`atcoder.ts:58` 对同端点已做 24h 磁盘缓存。
  **改法**：共享缓存 + 先判 `probRes.ok` 早退（失败不再白睡 1s、不再发无用 modelRes）。

- [ ] **14. luogu tag 字典三套独立实现 + 无退避** ⚠️ · `problemBank.ts:213,694` 与 `luogu.ts:235,246`
  `/_lfe/tags` 同进程可能重复拉 2-3 次；`ensureTagDict` 非 2xx 时不 throw 也不记退避，每抓一题重发一次。
  **改法**：收敛为一处 + 补退避时间戳。

- [ ] **15. docConverter 大表栈溢出** ⚠️ · `server/src/ai/docConverter.ts:153,430`
  `Math.max(...rows.map(r=>r.length))` 对大 xlsx（可达百万行）展开会栈溢出。
  **改法**：循环求最大值。

- [ ] **16. tavilyExtract 用裸 fetch** ⚠️ · `server/src/ai/fetch-url.ts:181`
  绕过注入的 `fetchFn` 与按域名节流，测试无法 stub。
  **改法**：走统一传输层。

---

## 四、前端竞态与生命周期（高收益）

- [ ] **17. 账号视角切换竞态** ⚠️ · `client/src/pages/Dashboard.tsx:342-368` + `Mastery.tsx:141-162`
  `load` 无请求序号护栏，切 scope 时旧响应晚到会覆盖新数据。Problems/Today/Calendar/Contests 均有 `reqSeq` 护栏，唯独这两个 scope 页缺失（既竞态又不一致）。
  **改法**：补 `reqSeq`/`current` 序号护栏。

- [ ] **18. AI 深链只在挂载消费一次** ⚠️ · `client/src/pages/Assistant.tsx:929-1015`
  `?contest=`/`?plan=` 二次跳转被静默丢弃；Problems 对 `?q=` 有专门监听。
  **改法**：对 `searchParams` 增监听，参数变化时重新消费。

- [ ] **19. 速度滑块防抖定时器未清理** ⚠️ · `client/src/pages/Settings.tsx:220,631-637,406-412`
  `scaleSaveTimer` 卸载时未 `clearTimeout`，600ms 内离开页面会打到已卸载组件。
  **改法**：卸载 effect 中补 `clearTimeout(scaleSaveTimer)`。

---

## 五、前端渲染性能

- [ ] **20. Dashboard 图表每次渲染重建** ⚠️ · `client/src/pages/Dashboard.tsx:714-901`
  `moduleNodes`（含 3 个 recharts 图表 + HistoryPanel）整体重建且无 `React.memo`，拖拽时每次 mousemove 全量重渲染。
  **改法**：`React.memo` 卡片子组件 + 必要时 `useMemo` 图表节点。

- [ ] **21. 组件体内定义常量数组** ⚠️ · `client/src/pages/Assistant.tsx:662-682`
  `TEXT_EXTENSIONS` 等三个数组 + 4 个 `is*File` 函数定义在组件体内每次重建（流式时每秒重渲染十几次）；同文件 `STORAGE_KEY`/`MAX_SESSIONS` 已是模块级。
  **改法**：提为模块级常量。

- [ ] **22. `cols` 未 useMemo** ⚠️ · `client/src/pages/Problems.tsx:1070-1243`、`Plans.tsx:172-207`
  ColumnsType 大数组 + render 闭包每次渲染重建。

- [ ] **23. Markdown `pre` 双重遍历** ⚠️ · `client/src/components/Markdown.tsx:257`
  每次渲染 `langOf()`+`collectText()` 两次整棵高亮子树遍历，超长代码块每帧重跑。
  **改法**：合并为单次遍历或 `React.memo` 代码块。

- [ ] **24. context value 每帧新建** ⚠️ · `client/src/updateContext.tsx:188`
  （`themeContext.tsx:195` 已用 useMemo，此处不一致）。

- [ ] **25. 平台名线性查找** ⚠️ · `client/src/ui.ts:174-176`
  `platformName` 每次 `PLATFORMS.find()`（`menuConfig` 已用 Map）。

---

## 六、一致性 / 重复代码收敛

- [ ] **26. API 错误解析块重复 3-5 次** ✅（部分） · `client/src/api.ts`
  `api` / `chatWithAssistantStream` / `uploadAiFile` / `uploadImage` / `extractDocumentText` 各一份 `if(!res.ok){...res.json()...}`。
  **改法**：抽 `parseErrorResponse(res)` 辅助函数。

- [ ] **27. 四类复制粘贴收敛** ⚠️：
  - 撤销提示（`message.destroy()+message.open`）：`Dashboard.tsx:376`、`Templates.tsx:481`、`Lists.tsx:293`、`Assistant.tsx:896`
  - 拖拽 mouse 事件方案：Dashboard（2 处）、Templates、Lists、Assistant
  - `kind→标签/颜色`：`Plans.tsx:36-47` 与 `Calendar.tsx:15-26` 完全重复
  - `formatBytes`：`Assistant.tsx:395` 与 `Settings.tsx:1872` 精度不一致
  **改法**：抽公共组件 / hook / 常量。

- [ ] **28. 归一化题号表达式跨文件内联** ⚠️ · `LOWER(REPLACE(...,' ',''))`
  problems.ts 三处手写内联（虽已抽 `NORMALIZED_KEY_SQL` 常量却未用）、`import/importService.ts:84`、`import/problemMerge.ts:105`、`db/index.ts:86` 亦重复，口径易漂移。
  **改法**：统一引用共享常量。

- [ ] **29. platform 白名单校验三处逐字重复** ⚠️ · `problems.ts:312-316 / 336-340 / 387-391`
  **改法**：抽公共函数。

- [ ] **30. Unicode 符号→LaTeX 映射两份独立实现** ✅ · `markdownMath.ts:1033-1072` 与 `markdownCode.ts:361-368`
  检测侧 `SYMBOL_MAP`（约 18 符号）与渲染侧 `.replace()` 链（约 40 符号，含 ⊕⊗÷↔⇔⇒⌊⌋⌈⌉∉⊆⊇∀∃∂ 等）是同一映射的两份独立实现，**已漂移**——往渲染侧加的符号不会被检测侧识别。上/下标字符映射同理重复（`markdownMath.ts:1076-1093` vs `markdownCode.ts:48-68`）。
  **改法**：合并为单一映射来源（渲染侧引用检测侧的表或反之）。

- [ ] **31. `sleep()` / UA 字符串重复** ⚠️ ·
  `sleep` 在 4 处各写一份（provider 版可中断语义不同）；浏览器 UA 字符串在 luogu/nowcoder/problemBank 等 8+ 处硬编码。
  **改法**：收敛为 shared 常量。

- [ ] **32. `INTENT_OUTCOMES` 位置** ⚠️ · `problems.ts:734-735`
  定义在函数体内每次重建 Set，与模块级 `STATUS_FILTERS` 风格不一致。

---

## 七、日期与口径一致性

- [ ] **33. 导出文件名日期戳用 UTC** ✅ · `server/src/routes/templates.ts:804` + `client/src/pages/Templates.tsx:112`
  `new Date().toISOString().slice(0,10)` 与 `dates.ts` 确立的本地日口径不一致（UTC+8 凌晨生成「昨天」的文件名）。
  **改法**：改 `localToday()`。

- [ ] **34. 注释自相矛盾** ✅ · `server/src/reviews/schedule.ts:36`
  「当地时区 YYYY-MM-DD（与 planService.today 口径一致：UTC 日期）」。

- [ ] **35. schema 注释漏值** ✅ · `server/src/db/schema.sql:178`
  outcome 枚举漏 `editorial`（代码 `problems.ts:735` 已支持 5 种值）。

---

## 八、可访问性与 UX 细节

- [ ] **36. 不可键盘可达的「链接」** ⚠️ ·
  `Plans.tsx:176`（`<a onClick>` 无 href/role/tabIndex）、`Contests.tsx:422-429`（无 URL 时渲染成假链接）；对比 Templates/Lists 的 `role="button"+tabIndex` 做法不一致。

- [ ] **37. 硬编码 ⌘K** ⚠️ · `client/src/App.tsx:112`
  Windows 用户看到 ⌘ 而非 Ctrl+K（handler 已支持 ctrlKey）。

- [ ] **38. 图标按钮 / 交互缺可访问名与键盘** ⚠️ ·
  `NoteEditor.tsx:71-78`（无 aria-label）、`HistoryPanel.tsx:309-317`（antd `<Tag onClick>` 无键盘）、`Today.tsx:391-398`（`<span title>` 读屏不可达）、`ActivityHeatmap.tsx:198`（Tooltip 包 div 不可聚焦）。

- [ ] **39. 热力图把网络错误当空态** ⚠️ · `ActivityHeatmap.tsx:71`
  `.catch(console.error)` 吞错，显示成「没有提交记录」。
  **改法**：区分错误态与空态。

- [ ] **40. `data-theme` 未同步 `color-scheme`** ⚠️ · `themeContext.tsx:53-55`

---

## 九、边界健壮性（低概率但真实）

- [ ] **41. aiBlocks 数值校验被强转绕过** ✅ · `client/src/aiBlocks.ts:23-24,59,63`
  `Number(v.level)` 后 `null`→0 通过 `Number.isInteger`，`null` 被静默当成 level=0；`difficulty: null` 同理变 0 而非注释声明的回退 3。
  **改法**：先 `typeof v.level === 'number'` 再 Number.isInteger；difficulty 同理。

- [ ] **42. `String.fromCharCode` 应改 `fromCodePoint`** ⚠️ · `server/src/ai/docConverter.ts:450`
  emoji 等数字实体码点 >0xFFFF 会截断。

- [ ] **43. `decodeURIComponent` 无 try/catch** ⚠️ · `server/src/adapters/qoj.ts:265,336`
  非法 `%` 序列抛 URIError。

- [ ] **44. `replace` 缺 g 标志** ⚠️ · `markdownMath.ts:954-956`
  集合构造 `{x|y|z}` 第二个 `|` 不转写。

- [ ] **45. `JSON.parse(e.newValue)` 无守卫** ⚠️ · `accountScope.ts:125`
  脏值残留会抛未捕获异常。

- [ ] **46. `revokeObjectURL` 过早** ✅ · `client/src/download.ts:46-53`
  `a.click()` 后同步 `URL.revokeObjectURL(a.href)`，且 `<a>` 未插入 DOM——Firefox/Safari 可能取消下载。
  **改法**：`setTimeout(revoke, 0)` 或延迟回收；必要时 append 到 body 再 click。

- [ ] **47. 难度 0 被当 falsy** ⚠️ · `server/src/routes/lists.ts:562`
  洛谷「暂无评定」映射 difficulty=0 的题在 AI 提示里缺标注。

---

## 十、代码卫生

- [ ] **48. console.error 打正常流程日志** ⚠️ · `server/src/routes/ai.ts:742,804,832`
  「轮次 N 开始/结束」应降为 debug/log。

- [ ] **49. 首轮流式缺 `writableEnded` 守卫** ⚠️ · `server/src/routes/ai.ts:737-739`
  与后续轮次写法不一致。

- [ ] **50. `saveAiConfig` 结果被丢弃又重读** ⚠️ · `server/src/routes/settings.ts:457,469`

- [ ] **51. lint 告警未收敛** ✅（已跑 `npm run lint` 实测）· oxlint 报 9 个 `react-hooks/exhaustive-deps`
  `syncProgressContext.tsx:94`、`Reviews.tsx:62`、`themeContext.tsx:211`、`updateContext.tsx:193`、`Calendar.tsx:59/82`、`Contests.tsx:207`、`Templates.tsx:186`、`Assistant.tsx:1048`。部分文件已用注释抑制、部分未注释，抑制方式不统一。

---

## 已复核条目与修复示意（✅ 部分）

以下为已人工读码确认的关键条目，附「现状 → 修后」示意，可直接据此实现：

### #3 headersSent 未转交
```ts
// 现状
if (res.headersSent) return; // 注释说「交给 Express 默认处理」实际没交
// 修后
if (res.headersSent) return next(err);
```

### #5 clean-tags 循环内重复 prepare
```ts
// 现状（循环体内，11 条 .prepare 每次迭代编译）
for (const g of duplicateGroups) {
  for (const dup of g.remove) {
    db.prepare('UPDATE submissions SET ...').run(...)
    db.prepare('UPDATE submission_intents SET ...').run(...)
    // ...共 11 条
  }
}
// 修后：全部提到双重循环外，与 problemById/markDeleted 一致
const updSub = db.prepare('UPDATE submissions SET ...')
// ...
for (...) for (...) { updSub.run(...) }
```

### #7 review_item_id N+1
```sql
-- 现状：coreSelect 里的标量子查询，GET / 返回 1.9 万行即 1.9 万次
(SELECT ri.id FROM review_items ri
  WHERE ri.problem_id = p.id AND ri.user_id = 1) AS review_item_id
-- 修后：LEFT JOIN 一次性带出
LEFT JOIN review_items ri
       ON ri.problem_id = p.id AND ri.user_id = 1
-- SELECT 里改 ri.id AS review_item_id（注意 review_items 有 UNIQUE(user_id,problem_id)，不会放大行数）
```

### #9 冗余索引
```sql
-- 冗余（schema.sql:197）：是下面复合索引的严格前缀
CREATE INDEX idx_submissions_user_platform ON submissions(user_id, platform);
-- 已存在（db/index.ts:109）：
CREATE INDEX idx_submissions_user_account ON submissions(user_id, platform, account);
-- 删除前者即可；老库需在 migrate 里同步 DROP INDEX IF EXISTS
```

### #10 signal 被覆盖
```ts
// 现状：init.signal 被覆盖
res = await fn(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) })
// 修后：合并调用方 signal 与超时
const timeoutSig = AbortSignal.timeout(timeoutMs)
const signal = init.signal ? AbortSignal.any([init.signal, timeoutSig]) : timeoutSig
res = await fn(url, { ...init, headers, signal })
```

### #12 风控误判
```ts
// 现状
if (/HTTP 429|限流|Too Many Requests/i.test(msg)) return 'rate_limited';
if (/HTTP 40[13]|Cookie|风控|登录|auth/i.test(msg)) return 'auth_expired';
// 修后：把「风控」从 auth 正则移入限流/独立分类
if (/HTTP 429|限流|风控|Too Many Requests/i.test(msg)) return 'rate_limited';
```

### #30 符号映射双真相
```ts
// 现状：检测侧 markdownCode.ts:361 与渲染侧 markdownMath.ts:1033-1072 各一份，
// 渲染侧多出 ⊕⊗÷↔⇔⇒ 等约 20 个符号，检测侧认不出
// 修后：单一来源，两侧共用一张表（检测/渲染各自遍历同一份映射）
```

### #41 aiBlocks 数值强转绕过
```ts
// 现状：null → Number(null)=0 → 通过 isInteger
const level = Number(v.level)
if (!Number.isInteger(level)) return null
// 修后：先验类型
if (typeof v.level !== 'number' || !Number.isInteger(v.level)) return null
const level = v.level
```

---

## 建议实施顺序

按「收益/风险比」分三批，全部为行为不变的细节打磨：

| 批次 | 条目 | 内容 | 风险 | 预估工作量 |
| --- | --- | --- | --- | --- |
| **第一批** | #1-12 | 错误处理脱敏、SQL 重复 prepare / N+1 / 冗余索引、适配器健壮性 | 最低 | S–M（多为单文件 1–3 行改动） |
| **第二批** | #17-19、#26-30 | 前端竞态 + 重复代码收敛 | 中等 | M（涉及抽公共函数/组件） |
| **第三批** | #20-25、#36-51 其余 | 渲染性能微调 + UX/边界/卫生 | 低（零散但安全） | S–M（逐条小改） |

> 备注：实施时逐条改、逐条 `npm run typecheck && npm run lint && npm test` 验证，避免一次性大改引入回归。涉及 DB 迁移（#9 删索引、#35 注释）需在 `db/index.ts` 的 migrate 里以幂等方式处理老库。

---

## 深挖完成度（三区域已覆盖）

三块「待深挖」区域已由子代理逐一读码产出结论，共 58 条新发现，编为 #54–#111 并入下文。#52（verifyChecksums 整读内存）已并入 #85；#53（difficultyBackfill 的 prepare 负结论）作为背景记录，不再单列为可执行项。

> 已复核（✅，共 16 条）：#1、#2、#3、#5、#6、#7、#9、#10、#12、#30、#33、#34、#35、#41、#46、#51（#26 部分复核）。其余 ⚠️/无标记条目为子代理报告，实施前建议先读码确认。

---

## 十一、分析 / 今日 / 知识点域（#54–#73，子代理报告）

- [ ] **54.【高·性能】weakness 每 tag 重跑同一难度分布 SQL + 逐 (tag×桶) prepare** · `analysis/weakness.ts:74,109-135` + `knowledge/conceptStats.ts:111-117`
  `averageWeightForCode` 在 `[...tagMap].map(...)` 里每 tag 调用一次，其内部 `GROUP BY difficulty` 查询与 code 无关却重复执行；`informativenessFor` 对每 (tag×桶) 再 inline `prepare().get()`，未用现成的 `conceptStatsFor`（整桶 Map）。改法：难度分布提到循环外算一次，按桶预载 code→informativeness Map。

- [ ] **55.【高·性能】taxonomy allPoints 每次 flatMap 全表 + 线性 find** · `knowledge/taxonomy.ts:54-65`
  `nameOfCode/isValidCode/fullNameOfCode/templateIdsOfCode` 每次 `allPoints().find(...)`，热循环内被逐点/逐 tag 调用（store.ts:186,284；tagAnnotate.ts:35；mastery.ts:150,193）。改法：缓存 flatMap 结果 + 建 code→point Map。

- [ ] **56.【高·性能】回填早停每页 `[...wanted]` 摊平整个 Set** · `analysis/difficultyBackfill.ts:811,857`
  力扣/计蒜客最多 200–300 页、wanted 可达上千，每页新建完整数组再 every。改法：`for (const k of wanted) if (!table.has(...)) break` 或维护 remaining 集合递减。

- [ ] **57.【高·性能】icpcBoard 每 board 重跑 5 次 replace 的 normalize** · `analysis/icpcBoard.ts:289,297,666`
  `matchRanklandBoard` 对每个 ref 对上百个 board 重跑 `normalizeMatchText`。改法：对 board 的 uk/name/fileId 归一文本做一次 memo。

- [ ] **58.【高·性能】currentPipelineVersion 逐点重算** · `knowledge/store.ts:255,302,313` + `ruleEngine.ts:95-101`
  `taxonomyVersion` 已 hoist，`currentPipelineVersion()` 却在 points 循环内逐点调用；SEA 下 `rulesVersion()` 每次 `JSON.parse` 整份 rules JSON。改法：提到循环外一次。

- [ ] **59.【高·性能】pipeline DELETE 的 prepare 写在逐行循环里** · `knowledge/pipeline.ts:114`
  与本文件 86-91 已 hoist 的 hasManual/hasAny 不一致。改法：提到循环前。

- [ ] **60.【高·性能】select 每候选重建 new Set(weakTags)** · `today/select.ts:77-80,108`
  `weakOverlap` 每候选构造一次 Set，O(候选×弱项)。改法：Set 提到 map 外。

- [ ] **61.【中·性能】store 同 key 4 次 get** · `knowledge/store.ts:199-202,220-240`
  `lineVersion/lineAnnotatedTitle/lineAnnotatedAt` 各自重建 `${problemId}|${source}` 再 `latest.get`。改法：每 (题,源) 取一次 line 再派生四字段。

- [ ] **62.【中·性能】tagAnnotate 同一批 tag 跑两遍 codeOfTag+isValidCode** · `knowledge/tagAnnotate.ts:134,136,30-41`
  改法：单趟同时产出 codes 与 unmapped。

- [ ] **63.【中·性能】stats 两次 rows.filter(AC)** · `analysis/stats.ts:156-157`
  `ac` 与 `acRate` 各 filter 一次并分配中间数组。改法：主循环累计一次。

- [ ] **64.【中·一致性】1 位小数百分比公式重复三处** · `analysis/summary.ts:178,359` + `knowledge/store.ts:517`
  `summary.ts:178` 与 `rate()` 同式，应复用 `rate`；统一一个 percent helper。

- [ ] **65.【中·健壮性】difficultyBackfill 裸 JSON.parse(r.tags)** · `analysis/difficultyBackfill.ts:399,420`
  无 try/catch、无 Array 校验（对比 stats.ts:200-207 的 safeTags），同行还 parse 两次。改法：复用 safeTags 风格，避免同行重复 parse。

- [ ] **66.【中·性能】xcpcFacets 常量词逐 board 重复归一化 + 循环内重建正则** · `analysis/xcpcFacets.ts:79-83,262,277,279,285`
  `stageTerms/siteAliases` 每次 `normalizeMatchText`，`contestRound` 的 3 个 pattern 每次重建。改法：常量词/别名模块层预归一化，pattern hoist。

- [ ] **67.【中·健壮性】problemKey 未转义拼进 RegExp** · `analysis/difficultyBackfill.ts:535`
  题号含 `. + *` 等元字符会错配。改法：`problemKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`。

- [ ] **68.【低·性能】collectSolveEvidence 重复跑** · `today/ability.ts:322,325,453-454`
  `estimateBreakdown` 内部再 collect 一次。改法：先 collect 一次透传。

- [ ] **69.【低·性能】summary rows.map 中间数组** · `analysis/summary.ts:198`
  `new Set(rows.map(...))` 建完整中间数组。改法：主循环维护 touched Set。

- [ ] **70.【低·一致性】86_400_000 魔法数漂移** · `ability.ts:84,430`、`trend:24,68`、`mastery:97`、`stats:107`、`select:159`
  已定义 `DAY_MS` 却仍在多处写死。改法：统一引用常量。

- [ ] **71.【低·一致性】熔断后未尝试题计 failed（口径）** · `analysis/difficultyBackfill.ts:1492-1495`
  触发风控熔断后剩余题都计 `failed`，语义是「未尝试」。改法：改记 capped/deferred 或 break。

- [ ] **72.【低·性能】qojContest 循环内正则字面量** · `analysis/qojContest.ts:89,95,97`
  改法：hoist 到函数/模块级。

- [ ] **73.【低·一致性】summary 冗余包装/默认参** · `analysis/summary.ts:124,210`
  `const todayStr = () => localToday()` 与恰好等于默认值的显式参数。

---

## 十二、更新 / 备份 / 基础设施域（#74–#88，子代理报告）

- [ ] **74.【高·健壮性】恢复非原子 + 标记先删** · `backup.ts:220,226,239`
  `rmSync(markerPath)` 在真正复制前执行，`copyFileSync(source, dbPath)` 原地覆盖——中途崩溃 → 库损坏且标记已丢、下次不重试。改法：先写 `dbPath + '.restore.tmp'` 再 `renameSync`，标记移到成功后删。

- [ ] **75.【高·健壮性】spawn 未挂 'error' 监听** · `widget-launcher.ts:20-25`
  `try/catch` 只拦同步 throw，异步拉起失败（widget.exe 损坏）以 'error' 事件发出，未监听 → uncaught；SEA 分支被 `fatal()` 接管整应用退出。改法：`child.on('error', () => {})` 后返回 false。

- [ ] **76.【中·健壮性】SEA 临时目录从不清理** · `sea.ts:233,253`
  `mkdtempSync('icpc-web-*'/'icpc-widget-*')` 无退出清理，每次启动累积。改法：退出钩子 rmSync 或固定缓存目录复用。

- [ ] **77.【中·健壮性】知识点快照整读 + 非原子写** · `backup.ts:81,83`
  annotations.jsonl 同步整读再 JSON.stringify（体积翻倍），`writeFileSync` 非原子。改法：流式 + 临时文件 rename。

- [ ] **78.【中·安全】/api/health 泄露绝对 dbPath** · `sea.ts:166`
  含用户名/安装路径，端点无鉴权、Docker 分支可绑 0.0.0.0。改法：只回相对名/布尔。

- [ ] **79.【中·性能】apply 后 staging 产物不清理** · `updater.ts:490,505-520`
  `copyFileSync` 复制而非移动，apply 成功后 `data/update-staging/` 仍留 20MB+ exe。改法：成功后 rmSync staging 或改 renameSync。

- [ ] **80.【中·性能】/apply 路径同步阻塞 IO** · `sea.ts:147` → `routes/update.ts:381-388` → `backup.ts:122` + `updater.ts:490`
  `preUpgradeBackup`（VACUUM INTO 全库复制）+ copyFileSync 大 exe 都在事件循环同步执行。改法：改 `() => Promise<void>` 并 await，或移入异步任务。

- [ ] **81.【中低·健壮性】数据目录迁移 cpSync 非原子** · `data-dir.ts:67,75`
  半迁移态被 `existsSync` 误判「已迁移」永不重试。改法：临时目录 + rename，或哨兵文件。

- [ ] **82.【中低·一致性】宿主 path vs path.win32 口径不一致** · `data-dir.ts:50-51 vs 69`
  `migrateLegacyDataDir` 用宿主 path，Linux 宿主解析 Windows 反斜杠路径会出错。改法：接受 platform 参数用相同 impl。

- [ ] **83.【中低·性能】/download 新查不写回缓存** · `routes/update.ts:344-347`
  缓存过期后由 /download 触发的 checkForUpdate 不更新 lastCheck，TTL 内重复打 GitHub。改法：fresh fetch 后写回。

- [ ] **84.【中低·一致性】stagingDir 字符串拼接** · `routes/update.ts:327`
  `` `${config.dataDir}/update-staging` `` 应改 `path.join`。

- [ ] **85.【中低·性能】同一产物被哈希两次（即原 readFileSync 整读内存问题的延伸）** · `updater.ts:342 vs 459`
  `checkDownloaded` 流式 SHA256 校验通过后，`verifyChecksums` 又整读重算。改法：复用已算哈希。

- [ ] **86.【低·性能】pruneBackups 重复推导目录** · `backup.ts:130,135-136`
  createBackup 已算 backupDir，pruneBackups 又跑一次 `PRAGMA database_list`。改法：传入已解析 dir。

- [ ] **87.【低·健壮性】分片 0 探测响应越界整块写** · `updater.ts:243-248`
  跨界块整块写入下一片区间，镜像两次响应不一致时产生交错字节。改法：越界时按 `end-pos+1` 截断。

- [ ] **88.【低·一致性】其它小项** · `backup.ts:42`（FILE_RE 解析歧义）、`routes/update.ts:257-258`（nightly 失败吞因）、`backup.ts:98`（按 mtime 排序清理）。

---

## 十三、桌面壳与构建脚本（#89–#111，子代理报告）

> **关键结论**：现行壳 = `desktop/app/src-tauri/`（`icpc-workbench`）；`desktop/src-tauri/` 是历史遗留的 `icpc-widget` 挂件旧壳（`Cargo.toml` name=`icpc-widget`），无任何构建脚本/CI 引用，属**死代码**，可整目录归档。以下标注「遗留树」的条目可随归档一并处理或忽略。

- [ ] **89.【高·性能】reqwest::Client 每次探测重建** · `desktop/app/src-tauri/src/discovery.rs:7-13`
  `check()` 每次新建 Client（连接池/DNS/TLS 全重来），`find_server` 一次并行 20 个 = 20 Client。改法：`OnceLock<Client>` 全局复用。

- [ ] **90.【高·性能】find_server 的 hint 是死参数，永远全量扫 20 端口** · `desktop/app/src-tauri/src/main.rs:184,221`
  掉线前已知端口存 PortState 却被清成 None。改法：记下旧端口走 `find_server(Some(last))` 快路径。

- [ ] **91.【高·性能·遗留树】挂件 Moved 每次 load()+save()** · `desktop/src-tauri/src/main.rs:345-348`
  拖动每秒几十次同步读写整文件。改法：内存缓存 + 防抖落盘（116/230/324/338 同类）。

- [ ] **92.【高·健壮性·遗留树】state.rs 非原子写** · `desktop/src-tauri/src/state.rs:46-47`
  `fs::write` 直接覆盖，崩溃丢位置；`save` 还吞错误。改法：临时文件 + rename。

- [ ] **93.【中·安全】签名密码明文进命令行** · `server/scripts/build-desktop.mjs:200-203`
  `CODESIGN_PFX_PASSWORD` 拼进 execSync 字符串。改法：execFileSync 传参数数组。

- [ ] **94.【中·健壮性】prepare-typst 下载无超时** · `server/scripts/prepare-typst.mjs:79-82`
  无 AbortSignal.timeout，网络挂起则构建无限卡住。改法：加 120s 超时。

- [ ] **95.【中·性能·遗留树】挂件 setup 另建 tokio Runtime** · `desktop/src-tauri/src/main.rs:239-240`
  改法：`tauri::async_runtime::block_on` 或 futures executor。

- [ ] **96.【中·健壮性】Mutex 一律 .lock().unwrap()** · `desktop/app/src-tauri/src/main.rs:194,207,213,230`
  锁中毒即 panic 拉死窗口；相邻读+写重复持锁。改法：`unwrap_or_else(|e| e.into_inner())`，合并持锁。

- [ ] **97.【中·一致性】版本同步写脏工作区 + 与 mac 脚本重复** · `build-desktop.mjs:66-72`（`build-desktop-mac.mjs:94-111` 几乎逐行重复）
  改法：抽 `_git-version.mjs` 共用，或 CI 环境变量注入。

- [ ] **98.【中·一致性】build-exe.mjs 的 git 缺 cwd** · `server/scripts/build-exe.mjs:52,65`
  依赖隐式 cwd；对比 build-desktop.mjs:57 显式传 `{cwd: repoRoot}`。改法：补 cwd。

- [ ] **99.【中·性能】prepare-typst 的 .cache 归档不清理不复用** · `server/scripts/prepare-typst.mjs:74-93`
  解压后 archive 永久留存，下次缺 target 仍重新下载。改法：解压后 rmSync 或先查缓存。

- [ ] **100.【中·一致性】两套 discovery 超时/校验口径漂移** · app=400ms 不校验 `sea:true`，src-tauri=300ms 校验
  app 树缺 `sea:true` 防护（src-tauri/discovery.rs:20 注释「同机 dev server 会被劫持」）。对齐时注意可能有意为之。

- [ ] **101.【低·一致性】macOS home_dir 注释与实现不符** · `desktop/app/src-tauri/src/main.rs:56-67`
  注释写 getpwuid，实为读 /etc/passwd + $UID，macOS 兜底基本无效。改法：用 `dirs`/`home` crate。

- [ ] **102.【低·一致性】app Cargo.toml 版本陈旧 0.4.0** · `desktop/app/src-tauri/Cargo.toml:3`
  与 tauri.conf.json 的 0.5.3 脱节。改法：同步或改 conf 单一来源。

- [ ] **103.【低·安全】两套 conf 均 csp:null** · CSP 全关（加 CSP 可能改变行为，需另行评估，不在「行为不变」范畴，仅提示）。

- [ ] **104.【低·遗留树】remote-drag.json 死 capability** · `desktop/src-tauri/capabilities/remote-drag.json`
  自述「已失效，保留占位」，可随遗留树整文件删除。

- [ ] **105.【低·遗留树】lifecycle.rs 硬编码 .exe + 魔法数** · `desktop/src-tauri/src/lifecycle.rs:7,15`
  改法：cfg 分支 + 命名常量 `DETACHED_PROCESS`。

- [ ] **106.【低·健壮性】state.rs `as i32` 截断** · `desktop/src-tauri/src/state.rs:34-35`
  改法：`i32::try_from(n).ok()`。

- [ ] **107.【低·一致性】gen-builtin-bank 两次 new Date()** · `server/scripts/gen-builtin-bank.ts:89,92`
  跨午夜理论不一致；`JSON.stringify` 无换行与 gen-taxonomy 风格不一。

- [ ] **108.【低·一致性】gen-taxonomy version:2 魔法数** · `server/scripts/gen-taxonomy.ts:71`
  改法：提 `TAXONOMY_VERSION` 常量。

- [ ] **109.【低·一致性】validate-weakness 硬编码 db 路径 + \u0000 重复 4 处** · `server/scripts/validate-weakness.ts:110,166,184,255,261`
  改法：用 loadConfig().dbPath、提分隔符常量。

- [ ] **110.【低·健壮性】gen-knowledge db.close 无 try/finally + --limit NaN** · `server/scripts/gen-knowledge.ts:45,16,28`
  改法：try/finally、`Number(undefined)=NaN` 兜底。

- [ ] **111.【低·健壮性】build-desktop-mac readdirSync 未守卫** · `server/scripts/build-desktop-mac.mjs:140-144`
  dmg 生成失败抛原始 ENOENT，对比 :122 已 existsSync 守卫。改法：补守卫。

---

## 建议实施顺序（更新）

在原三批基础上，新增区域按风险独立追加：

| 批次 | 条目 | 内容 | 风险 |
| --- | --- | --- | --- |
| 第一批 | #1-12、#74、#75、#78 | 错误处理脱敏 + SQL + 适配器 + 备份恢复原子性 + spawn error + health 泄密 | 低 |
| 第二批 | #17-19、#26-30、#54-60 | 前端竞态 + 重复收敛 + 分析域 N+1/性能 | 中 |
| 第三批 | 其余后端/前端/分析零散项 | 渲染微调 + 边界 + 一致性 | 低 |
| 第四批 | #89-92、#96-99（现行树） | 桌面壳性能（Client 复用 / hint / 锁） + 脚本一致性 | 中（需 Rust 重编译） |
| 归档随动 | #91、#92、#95、#104、#105 等遗留树 | 随 `desktop/src-tauri` 死代码归档一并处理或忽略 | — |
