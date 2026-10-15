# 题面证据接入计划

**目标：** 让计划生成、题单讨论和比赛复盘共享实际题面，减少仅凭标签与难度给建议。

**设计：** 保留现有抓取和缓存表，修复正文提取与过早截断；新增按平台题号读取的共享服务与 AI 工具。仅构造可信题目 URL，跨平台只使用明确的同题镜像，Cookie 按来源隔离。关联上下文先进行有数量和时间上限的准备，其余通过工具读取；正文分页并显式标记未取得或截断，正文属于外部数据，不是指令。

**技术：** TypeScript、SQLite、node:test，沿用现有 AI 工具协议。

## 实施与验证

- [x] 在 `server/test/problem-statements.test.ts` 添加长题面、洛谷多段正文、嵌套 HTML 回归，先运行看到缺失章节或尾部的断言失败。修复 `server/src/contests/problemStatements.ts`，保存正文而非上下文摘要。
- [x] 新建 `server/src/problems/statements.ts` 与 `server/src/ai/read-problem.ts`。在新测试中覆盖同题镜像缓存、无搜索密钥读取、分页、失败、Cookie 隔离、取消与不可信题号。缓存仍使用 `problem_statements`，返回来源、正文范围和缺失状态。
- [x] 修改 `server/src/plans/planService.ts`、`server/src/routes/ai.ts`，在有界准备后注入正文，并给计划生成接入有界工具循环。通过注入的抓取传输测试首次响应和工具往返，不访问用户数据库。
- [x] 补齐独立的 `server/src/routes/lists.ts` AI 分类/建议入口，与计划共用 `server/src/ai/problem-reading-chat.ts`。预取至多 6 题/12 秒，非流式 AI 最多 4 轮，累计工具读取时间 30 秒；取消时不再生成或写回建议。既有建议缓存通过重新生成更新。
- [x] 更新两个提示词、助手读取状态与 README；不得把标签当解法证明，也不得从 WA 时间线断言用户具体误区。训练建议默认不剧透解法。
- [x] 运行相关测试、完整测试、类型检查、构建和 lint；按 requesting-code-review 技能做独立审查并处理发现。提交和推送留待用户指令。

验证结果：后端完整测试 1310 项、前端完整测试 578 项全部通过，最后受影响回归 91 项通过；类型检查与构建通过，lint 无错误（保留原有 8 条警告）。独立审查发现已修复，真实 AtCoder、洛谷与 CF 洛谷镜像正文读取已验证。
