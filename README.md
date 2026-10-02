# ICPC Workbench · ICPC 备赛工作台

**中文** | [English](./README.en.md)

基于刷题记录（Codeforces / AtCoder / 洛谷 / 牛客 / 代码源 / LeetCode / 计蒜客）分析弱项、由 AI 生成个性化训练计划，并提供日历打卡的**本地 Web 应用**。

## 功能

- **多平台刷题导入**：Codeforces / AtCoder 自动同步（官方/社区公开 API，增量去重）；洛谷 / 代码源 / LeetCode / 计蒜客配置 Cookie 后自动同步；全平台支持手动导入（JSON / CSV / 表单）
- **同步可观测性**：每次平台同步（成败皆记）写入任务历史——拉取数、去重数、限速等待、耗时与可解释的失败分类（凭据失效 / 限流 / 页面结构变化 / 需手动导入等）；`GET /api/sync/diagnostics` 可导出纯文本诊断报告（不含任何密钥），`POST /api/sync/:platform` 支持 `days` 参数仅同步最近 N 天；拉取速度用户可调并带每域名安全下限（防风控），提交过多自动分批、再次同步续拉不重复；数据概览常驻同步状态卡（进行中显示逐平台进度，空闲可展开上次同步结果抽屉）
- **数据保护**：每日首次启动、应用升级前、大批量导入前、换账号重置前自动创建 SQLite 恢复点（`VACUUM INTO` 一致快照，按类型分级保留）；「设置 → 备份与恢复点」可手动备份与一键恢复（重启应用生效）；手动导入 JSON/CSV 前先展示变更预览（新增 / 跳过 / 非法行明细），确认后才写入
- **多账号绑定**：同一平台支持绑定多个账号（如主力号 + 练习小号），不再使用的账号可随时删除；「设置 → 备份与恢复点」里不再需要的备份/恢复点也支持手动删除，释放磁盘
- **统计账号视角**：绑了多个账号后，数据概览与掌握度地图页头出现「全部账号 / 某账号」切换器（单账号用户不显示）。选中具体账号时，AC 率、难度与标签分布、弱项画像、近 12 周趋势、刷题热力图、掌握度地图全部只统计该账号的提交——**弱项基准（相对自身平均 AC 率）也随之收窄**，否则主力号反复卡住的知识点会被小号的水题冲淡成"已掌握"。视角记在本地，切页与重启都保持；能力值估算刻意仍是全部账号口径（它估计的是"你这个人的水平"，且带一条缓慢校准轨迹，跟着视角切会互相污染）
- **本地安全边界**：服务端默认只监听 127.0.0.1，不暴露局域网（Docker 镜像内经 `HOST=0.0.0.0` 开放端口映射，对外部署需自行加反向代理 + 认证，见「Docker 部署」）；设置接口只回传「是否已配置」状态，绝不返回 API Key / 搜索 Key / Cookie 原文；AI 网页抓取内置 SSRF 防护——拦截本机/内网/链路本地地址（含 DNS 解析校验与逐跳重定向校验），重定向不泄露平台 Cookie
- **内置题库**：软件自带约 1.3 万题离线题库（Codeforces 全量 + 洛谷普及/提高- 及以上，含难度与算法标签），首次启动自动入库、开箱即可供训练计划/题单选题；需要更多时在「题目管理 → 拉取题库」按平台扩充（CF 单次调用秒级，洛谷/牛客/计蒜客按页拉取）
- **题目难度体系**：每题可同时持有「平台原生难度 + 统一 CF 标尺」双标度，题库页并列展示、页签按平台能力渲染；「一键回填」从各平台批量补难度与标签——按缺口排序、平台按实测成本升序执行，**可随时中止**（已落库不受影响、可反复续跑），并顺带修正旧映射留下的过时难度值；上游确认「给不出难度」的题记 30 天负缓存，列表里「无官方难度」与「未知」明确区分，绝不臆造数值（CF gym / 官方未评级题如实标注来源限制）；个别平台查不到的难度支持**手动指定**兜底
- **自建知识点管线**：入库时按 L1 规则（标题规则 + 题源标签映射）生成结构化知识点标注（按“知识点、置信度、方法、证据、管线版本”存储，可审计、可重建，题库页支持一键重建），统计与推荐优先使用知识点标注、未标注题目回退题源标签；人工校正置顶。
- **题目管理**：重复题自动去重（平台 + 标题 + 归一化题号键，清理标签时合并同类）；重复/废弃题目可删除并进回收站（墓碑按归一化键匹配，同步回来的旧提交不会“复活”，误删可一键恢复）；页首概览条置顶展示库内统计，可折叠
- **弱项分析**：按标签 / 难度区间 / 平台统计 AC 率，输出相对自身平均的弱项画像；近 12 周趋势
- **掌握度地图**：按知识点五档评估掌握度（未开始→接触→入门→掌握→熟练），串联刷题数据、弱项画像与模板课程；每个知识点可直达对应练习题目（含题库未做题，按难度从低到高）与课程；CF 等平台的英文标签与课程中文知识点自动归并（binary search ↔ 二分），同一知识点不分裂；掌握/熟练带 ⭐/🏆 徽章、升档进度条与新达成 🎉 标记
- **刷题热力图**：数据概览页 GitHub contributions 风格年历，格子深浅 = 当天 AC 去重题数（同题重复 AC 只记 1 题），分档阈值按非零日四分位数动态计算——「每天 1~3 题」的集中分布也能拉开色阶层次；GitHub 贡献图同款四档色板，深浅色主题自动适配；格子尺寸随卡片宽度自适应填满，近 3 月 / 近半年 / 近 1 年切换，悬停看当日「AC N 题 / 提交 M 次」；与打卡/日历同一本地日口径（凌晨刷的题算当天，不跨天错位），同步数据后自动刷新
- **概览模块拖拽排序**：数据概览 6 个模块卡片（热力图 / 平台分布 / 难度分布 / 弱项标签 / 近 12 周趋势 / 写题历史）按住标题栏即可拖动，悬停实时交换、松手即存（localStorage 持久化，刷新/重启保持）；拖拽只从标题栏发起——图表悬停提示、写题历史表格、热力图范围切换等交互不受影响；沿用平台小卡片的手写 mouse 事件方案，零第三方拖拽依赖，桌面 WebView2 壳同样可用
- **练习数据汇总**：一键生成完整个人画像（总量/平台/难度/知识点/弱项/掌握度/趋势/近期 AC/卡壳题/复习库/课程进度/打卡），可下载 `.md` 存档复盘
- **估算能力值**：按解题证据加权估算（难度、AC 证据量、新题完成度），慢速再校准避免单日表现引起大幅波动；AI 评估后可一键覆盖为评估值（今日训练三档随之按新值分档），随时恢复计算值
- **今日训练**：按弱项 + 计划任务智能挑题，每天一个可执行的小目标；每题可一键同步该平台最新提交（做完题后即时拉取 AC 状态刷新推荐）；推荐带冷却机制——近期已推/已做的题进入冷却，每日题集真正轮换更新，不会天天重复
- **AI 训练计划（双通道）**：
  - 内置生成：配置 OpenAI 兼容 API Key 一键生成（DeepSeek / OpenAI / 智谱 / Ollama 等）
  - 导出通道：无 Key 也可下载数据包 + 提示词 `.md`，手动喂给任意 AI，返回的 JSON 通过设置页「导入 AI 计划」粘贴/上传即可入库（自动清洗围栏与解释文字）
  - 提示词已内置完整练习数据汇总：AI 能看到掌握薄弱知识点、课程盲区、近期在练的题、卡壳题、复习库到期与打卡节奏，据此编排重做/补模板/复习任务
  - **自定义训练要求**：生成计划时可手写额外要求（如「重点补 DP 和图论」「每天不超过 3 题」「避开周末」），注入 AI 提示词后优先满足，与数据画像冲突时尽量兼顾
  - 任务全部附带可点击的题目链接：练习任务直接跳题目页；回顾/模拟赛任务跳 CF 提交记录/题集入口；AI 输出缺链接时自动按题库回退补链
- **AI 助手（全局）**：左侧菜单「AI 助手」独立的 AI 交流窗口——回答算法问题、粘贴代码调试（markdown 代码块 + 数学公式渲染）、解读练习数据与问题分布统计（自动注入练习数据汇总 + 弱项画像 + 近期赛事日历）；可关联训练计划让 AI 直接修改计划（plan-modify 块 → 前端确认后原位应用，「日期+标题」相同的任务保留打卡记录）；也支持让 AI 从零生成全新训练计划（plan-create 块 → 确认后创建新计划入库，与 plan-modify 区别在于无需关联现有计划）；AI 评估后可一键更新估算能力值（ability-update 块，今日训练三档随之按新值分档，可随时恢复计算值）；AI 讨论中可把思路沉淀为模板写入模板库（template-add 块，用户确认后落库）；模拟赛安排会自动对齐近 14 天真实赛事时间
  - **联网搜索**：到「设置 → AI 配置」配置搜索引擎（Tavily / Brave，均有免费额度）+ API Key 后，AI 需要时会自动搜索互联网获取最新信息（近期赛事、最新文档等），回复末尾附搜索来源链接；留空则不启用
  - **工具调用（function calling）**：AI 可抓取给定网址内容（fetch-url）与解析 PDF 文件（pdf-parse），支持「帮我把这个题单链接的题目导入题单整理」等场景；需模型支持 function calling（DeepSeek / GPT / 智谱等均支持）
  - **多格式文档附件**：除图片外，消息可附带 PDF / Word / Excel / PPT / HTML / CSV / JSON / XML / EPub 文档（PDF ≤10 MiB、其余 ≤20 MiB），服务端本地提取文本注入对话（不依赖 Files API，兼容所有模型）；附件内容按会话级缓存，后续任意轮次 AI 都能引用已上传文件（不会"忘记"）
  - **赛后复盘**：左栏「对话上下文」可关联一场参加过的比赛——列表 = 本地提交推导 + 平台参赛记录双通道：Codeforces/AtCoder 官方 API（user.rating / history）补齐 rated 场次并带排名与 Rating 变化；洛谷拉「参加过的比赛」（含团队赛/重现赛，按官方窗口归因 T 号比赛题提交）；牛客拉参赛历史（带排名/AC 数；比赛内提交本就随练习同步入库，按参赛窗口归因到场次）；本地推导兜底（CF 参赛信号与 gym ≥3 题集中作答、AtCoder 日历时间窗、计蒜客/QOJ 比赛题键）；代码源/LeetCode 暂不支持。参赛记录**落库持久化、增量拉取**：首次全量（单次翻页上限 30 页，触顶下次续拉），之后每 30 分钟过期、后台静默只拉新增（通常 1 页），打开页签直接读库秒出，牛客 Rating 未结算/不计分时不再显示平台占位值。选中后预填复盘请求，发送时注入比赛链接、该场逐题提交（时间线相对开赛、赛时/补题标注、难度与标签）与**赛时未提交的题目清单**（题目集来自牛客 problem-list / CF contest.standings / AtCoder `/contests/{slug}/tasks`，复盘时按需补拉并持久缓存）。**题面自动抓取**：按场次后台抓取该场**全部题的题面**（含赛时已 AC 的题与未提交的题）并落库（永久缓存），复盘时注入 system prompt 锚定题意——AtCoder（连官方题名一起抓，顺带修正社区数据串号的标题）与洛谷（匿名过 C3VK 反爬）可抓；**拿不到题面的题会在上下文里逐个列名并明确禁止 AI 凭题名推断题意**（AtCoder/洛谷/牛客的比赛题目页可抓——牛客个别页需登录；Codeforces 的 HTML 页被 Cloudflare 拦死、计蒜客/QOJ 无公开来源，这些请把题面粘贴给 AI）。AI 结构化点评（整体发挥 → 逐题卡点与未开题归因 → 联动弱项画像 → 补题建议）
  - **多会话并行**：每个会话独立标记生成状态，会话 A 回复中切到会话 B 照常输入发送，两个会话并行流式输出互不阻塞；生成中发送按钮变红色「停止」可中止（已收到部分保留并标注「已停止生成」）
  - 多会话管理：侧边栏会话记录，支持新建 / 切换 / 删除 / 置顶 / 双击重命名 / 拖拽排序，会话记录保存在浏览器本地
  - 切换模块再回来不丢会话；生成中切走，回来后回复自动出现
  - **消息复制 / 再次编辑**：助手消息可一键复制全文；用户消息支持「再次编辑」重发（失败回合自动剔除不回传给模型）
  - **数学公式渲染增强**：AI 输出的裸数学表达式（不带 `$` 定界符的下标/上标/LaTeX 命令等）自动识别并包裹渲染；`\(...\)` / `\[...\]` 定界符自动归一化为 `$` / `$$`；Unicode 数学符号（≤ ≥ ≠ ⊕ ⊗ ℓ 等）自动转为 LaTeX 命令；解析失败时以普通文本回退而非刺眼红字
  - **可配输出上限**：「设置 → AI 配置」可调最大输出 token（默认 384K，长输出场景可再调大）与模型上下文长度（默认 1000K，超限自动裁剪最早消息并提示）；回复因达到上限被截断时末尾会出现提示
  - 图片附件：消息可附上题面 / 评测截图（JPEG/PNG/GIF/WebP，≤64MiB），经 OpenAI 兼容 Files API 上传后以 file 内容块随消息引用
- **题单整理**：粘贴平台题单（洛谷 / Codeforces / AtCoder / 代码源 / 牛客 / LeetCode 的题号或链接，每行一题）自动识别建单；按知识点分类（已同步题库 tags 规则分类 + AI 分类 + 手动调整），联查题库标注难度与已 AC 状态；洛谷题单中的 CF/AtCoder 镜像题自动回退到原生平台查 tags 分类；规则分类只更新题库有 tags 的题，查不到的保留已有分类（不会被抹成「其他」）；支持向已有题单**追加题目**；AI 读取题单内容结合弱项画像给出练习建议
- **复习库**：题目复评与遗忘曲线调度。间隔阶梯 1/3/7/14/30/60/**120/240** 天——答对前进一档、轻松跳两档、失手**只退回两档**（不再一次手滑就把练到 60 天的题打回"明天再来"，那样只会让人不敢如实点困难）；阶梯爬到 240 天是为了让队列**收敛**：封顶在 60 天时，一道早已练熟的题每 60 天必回来一次，复习量永远只增不减。同一档位下再乘**留存系数**（0.5–1.6）：这个条目历史上失手过几次、所属知识点在掌握度地图上是「接触」还是「熟练」、这道题当初是不是靠看题解做出来的——都会把排期拉近或推远，于是同档的两道题不再同一天到期；系数只改写天数、档位本身不变，界面看到的「第 N 档」仍然可解释。每次反馈落一行**复习日志**（`review_events`：档位前后、原定到期日、实际间隔、生效系数），「这题忘过几次、上次为什么排这么远」随时可查，将来做真正的自适应也才有训练数据。新加入的题目按题号**错峰排进今日起 4 天内**到期（从题单/写题历史批量加几十道时，不会第二天全堆到一起），加入成功的提示会直接念出下次到期日；到期数量提醒在今日训练与挂件
- **模板库**：114 节内置算法模板课程（分 10 大类），学习状态/笔记/进度追踪；支持自建分类归类整理（自建标签可删除），整套模板可一键导出 Markdown / PDF 存档分享；AI 讨论中沉淀模板时可指定写入的目标标签；自建模板支持 Tab 缩进的代码编辑框（Tab 缩进、Shift+Tab 反缩进、回车自动缩进，保留撤销栈）；思路备注配备 Markdown 编辑器（格式工具栏、粘贴图片、实时预览），支持完整 Markdown 渲染（GFM 表格/删除线/代码块 + 数学公式，行内 `$...$` 与块级 `$$...$$`，兼容 Obsidian 语法）；页头可切换缩进空格数（2/4，本地持久化）
- **写题历史**：数据概览页一键查询「我在哪些平台写过哪些题」——按题目汇总（提交/AC 次数）或逐条提交两种视图，平台筛选、全部 AC / 未通过过滤，直达原题链接
- **赛事中心**：Codeforces / AtCoder / 洛谷 / 牛客 / 计蒜客 五平台场次聚合（即将开始 / 进行中 / 最近结束，单源失败自动降级），赛前选场、赛后补题；「我参加的」页签汇总各平台参赛记录（本地提交推导 + CF/AtCoder/洛谷/牛客参赛历史，带排名与 Rating 变化），一键跳转 AI 助手复盘该场。参赛记录**逐账号拉取**：同平台每个绑定账号各自增量、各自记状态，一个账号失败（如小号 Cookie 过期）不掩盖另一个已拉到的数据；同一场比赛多个号都参加过时列表仍只出一条，成绩取本地提交较多的账号并标注「多账号参赛」，AI 复盘的逐题时间线按账号分别标注（避免把小号的练手提交当成主力的临场发挥）
- **日历打卡**：月历查看每天训练任务、跳转做题链接、逐任务打卡；打卡数据与计划页联动；连续打卡统计
- **打卡提醒**：设置页配置每日提醒时间，应用打开期间到点若当天仍有未打卡任务，弹浏览器系统通知 + 页面内通知，点击直达日历；赛前提醒可配置开赛前 N 分钟通知（每场一次，点击直达赛事中心）
- **软件更新**：双通道检测（正式版 + GitHub 最新提交构建）+ 应用内一键自更新（更新驱动挂在全局 Provider，发起更新后切到别的模块也不会中断下载/替换流程；刷新页面自动恢复更新进度）
- **Web 挂件**：`http://localhost:3001/widget` 零依赖单页（Express 直接服务），常驻小窗展示当天任务、连续打卡徽标，可直接打卡/跳转做题

## 技术架构

```
icpc-workbench/
├── server/          # Node.js + Express + node:sqlite（内置 SQLite，零原生依赖）
│   ├── adapters/    # 平台适配器（CF/AtCoder 自动；洛谷/牛客/代码源/LeetCode/计蒜客受限）+ 增量同步
│   ├── analysis/    # 聚合统计 / 弱项画像 / 周趋势
│   ├── ai/          # OpenAI 兼容 provider + plan-prompt.md / assistant-prompt.md 提示词模板 + function calling 工具注册（fetch-url / pdf-parse / 联网搜索）+ 文档转换器（Word/Excel/PPT/HTML/CSV/JSON/XML/EPub → Markdown）
│   ├── contests/    # 五平台赛事聚合（CF/AtCoder/洛谷/牛客/计蒜客，单源失败降级）
│   ├── plans/       # 计划生成（AI 优先，失败/未配置降级模板）+ 入库
│   ├── import/      # 手动导入（JSON/CSV/表单）+ 事务入库
│   ├── knowledge/   # 自建知识点管线（L1 标题规则 + 题源标签映射 + JSONL 源真相 / SQLite 索引）
│   ├── updater.ts   # 一键自更新（下载/SHA256 校验/原位替换）
│   └── routes/      # REST API（stats/problems/plans/ai/lists/reviews/today/templates/contests/checkins/settings/export/sync/import/update/knowledge/backups）
├── client/          # React + Vite + Ant Design（数据概览/今日训练/AI助手/模板库/题单整理/训练计划/复习库/题目管理/掌握度地图/日历打卡/赛事中心/设置）
├── desktop/         # Tauri 桌面壳（app：主程序原生窗口 + Node 服务 sidecar）
└── shared/          # 跨端共享类型与平台元信息
```

## 快速开始

要求：Node.js ≥ 22.16（使用内置 `node:sqlite`；知识点管线依赖 `DatabaseSync.isTransaction`，该属性 22.16 起提供），npm。

```bash
npm install     # 安装全部 workspace 依赖
npm run dev     # 同时启动 server(:3001) 与 client(:5173)
```

打开 http://localhost:5173 使用。数据存储在 `server/data/icpc.db`（首次启动自动创建）。

常用脚本：

```bash
npm run dev          # 双端开发
npm run build        # 构建前端（dist/）
npm run typecheck    # server + client 类型检查
npm test             # server 单元测试（node:test）
npm run dev:server   # 仅后端
npm run dev:client   # 仅前端
```

## 桌面窗口版（原生窗口，不再依赖浏览器）

```bash
node server/scripts/build-desktop.mjs   # 桌面窗口版（壳 + 核心 + NSIS 安装程序）
```

要求本机装有 Rust 工具链（`cargo`）；首次构建会下载 Tauri/NSIS 组件。产物在 `server/release/`：

- `icpc-workbench_<版本>_x64-setup.exe`：NSIS 安装程序（中文向导、免管理员、自动创建开始菜单/桌面快捷方式；卸载前自动把练习数据备份到 `%APPDATA%\icpc-workbench`）
- `icpc-workbench.exe` + `icpc-core.exe`：便携版（双 exe 同文件夹，解压即用免安装）
- 可选代码签名：设置环境变量 `CODESIGN_PFX_PASSWORD` 并把 pfx 证书放进 `server/certs/`，构建时自动签名三个 exe

壳启动时自动拉起核心并探测端口（3001–3020），窗口直接加载应用页面；核心掉线自动重启恢复，关窗即退出（一并回收服务）。外链（题目链接、下载页等）自动在系统默认浏览器打开。

面向零基础用户的运行体验：

- 自己的原生窗口，不再依赖浏览器挂载；首启初始化几秒
- 数据落在 exe 旁 `data/icpc.db`，exe 与 data 同文件夹整体搬迁即可
- 升级：应用内「一键更新」自动完成；也可下载新版安装包覆盖，或用新便携版的两个 exe 覆盖旧文件，data 不用动

### macOS 版（Apple Silicon，nightly 提供）

```bash
node server/scripts/build-desktop-mac.mjs   # 仅 macOS 上运行
```

CI 的 nightly 预发布版随 Windows 三件套一起发布 `.dmg`（Apple Silicon M 系列；Node SEA 核心架构相关，暂不含 Intel Mac 版）：

- `icpc-workbench_<版本>_aarch64.dmg`：拖入「应用程序」即完成安装
- **构建时强制 ad-hoc 签名并校验**（`codesign --force --deep --sign -` + `codesign --verify --deep --strict`）：Apple 芯片要求包内每个可执行文件都有有效签名，未签名或签名失效的包在用户机上表现为「已损坏，无法打开」（issue #14）；签名不通过直接让 CI 失败，不发布坏包。刻意不开 hardened runtime（缺 allow-jit 会让 Node 核心的 JIT 起不来）
- 仍未公证（未购买 Apple 开发者证书），首次打开可能提示「无法验证开发者」，任选一种放行：右键 →「打开」；系统设置 →「隐私与安全性」→「仍要打开」；终端 `xattr -cr /Applications/icpc-workbench.app`
- 用户数据存放在 `~/Library/Application Support/icpc-workbench/data`（**不在 app 包内**：写包内会让签名失效导致「已损坏」，且覆盖安装新版会丢数据）；老 nightly 写在包内的数据会在首次启动时自动搬出来
- macOS 暂不支持应用内一键更新（该功能仅 Windows），更新请到 Releases 页手动下载覆盖

## Docker 部署（Web 服务器 / NAS）

把工作台跑成容器服务，适合部署到 Linux 服务器或 NAS 上长期使用。单容器单进程：后端 API、前端静态页面、widget 页面同端口服务。

**方式一：本地构建（仓库内已有 `Dockerfile` + `docker-compose.yml`）**

```bash
git clone <本仓库> && cd icpc-workbench
docker compose up -d      # 构建镜像并启动
```

**方式二：预构建镜像（CI 自动发布，amd64 + arm64）**

```bash
docker run -d --name icpc-workbench \
  -p 127.0.0.1:3080:3001 \
  -v icpc-data:/app/server/data \
  ghcr.io/ZF3373/icpc-workbench:latest
```

两种方式启动后访问 `http://127.0.0.1:3080`。

- **数据持久化**：数据库（WAL）、上传图片、知识点、每日备份全部在 `/app/server/data`，对应 compose 里的 `icpc-data` 卷；换镜像升级数据不丢（schema 迁移幂等，旧卷可跨版本复用）
- **配置**：`PORT`/`TZ` 已有默认值；`AI_API_KEY`、`SEARCH_API_KEY` 可用环境变量注入，也可在「设置」页配置（存库随卷持久化）；其余配置可选挂载 `server/config.json` 覆盖
- **升级**：`docker compose pull && docker compose up -d`（或拉新镜像重建容器）。容器内应用内「软件更新」不生效——容器版本的版本号固定为 `dev`，不会提示更新，更新一律通过换镜像完成
- **健康检查**：镜像内置 `HEALTHCHECK` 探测 `/api/health`，`docker ps` 可见 healthy 状态
- **安全（务必阅读）**：应用本身无任何认证，`-p 127.0.0.1:3080:3001` 默认只绑宿主机回环，仅本机可访问。如需局域网/公网使用，请改为 `-p 3080:3001` 并自行加装反向代理 + 认证 + TLS——直接暴露等同公开你的练习数据与 AI API Key

## 浏览器模式单文件 exe 打包（兼容保留）

```bash
node server/scripts/build-exe.mjs
```

产物在 `server/release/`：`icpc-workbench.exe`（约 90MB，Node SEA 单文件）+ `使用说明.txt`，
整个文件夹拷给用户即可。面向零基础用户的运行体验：

- 双击 exe → 自动打开默认浏览器进入软件页面（仅监听 127.0.0.1，不触发防火墙弹窗）
- 端口被占自动顺延（默认 3001 → 3002…），重复双击复用已运行实例并直接打开页面
- 启动失败时窗口不闪退，停留展示报错等待按键
- 数据库落在 exe 旁 `data/icpc.db`，exe 与 data 同文件夹整体搬迁即可

### 软件更新（双通道 + 一键自更新）

版本号与构建 commit 由打包脚本注入（`/api/health`、侧边栏、设置页均展示）。应用打开时自动静默检查（24 小时一次），有更新时页面顶部出现可关闭的横幅；设置页「软件更新」卡片可手动检查。

- **稳定通道**：GitHub Releases 正式版，按语义版本比较
- **提交通道**：tag 为 `nightly` 的预发布版——CI（`.github/workflows/nightly-desktop.yml`）在每次 push 到 master 时自动构建 Windows 三件套与 macOS（Apple Silicon）dmg 并发布；应用对比构建时注入的 commit 与 nightly 的提交，未打 tag 的新提交也能感知
- **一键自更新**（Windows 桌面版）：下载双 exe 到 `data/update-staging` → 按 Release 附带的 `checksums.sha256` 做 SHA256 校验（不过即放弃）→ 原位替换（运行中 exe 改名 `.old` 再拷入新文件），`data` 不受影响，关闭软件重新打开即生效
- **网络兜底**：检查与下载均为原生 fetch 优先，失败时 Windows 回退 PowerShell（系统证书库），企业网/安全软件 TLS 拦截环境下仍可用；断网等失败静默降级
- 浏览器模式或非 Windows 环境自动回退「前往下载页」手动更新


## 配置

- `server/config.json`（可选，参考 `server/config.example.json`）：端口、数据库路径、AI 默认值
- 运行时 AI 配置可在「设置」页修改并持久化到数据库；API Key 也可用环境变量 `AI_API_KEY` 提供

## AI 配置（内置生成器）

1. 「设置」→ 启用 AI 生成，填写 Base URL / API Key / 模型
2. 常用组合：
   - DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`
   - OpenAI：`https://api.openai.com/v1` + `gpt-4o-mini`
   - Ollama 本地：`http://localhost:11434/v1` + 已拉取的模型名
3. 「训练计划」→ 生成新计划（AI 失败或未配置时自动降级为模板计划）

进阶配置（均在「设置 → AI 配置」页）：

- **对话超时**：AI 助手对话的最长等待时间，响应慢的模型可调大（默认 120 秒）
- **最大输出 token**：单次回复的 token 上限，批量整理模板等长输出场景可调大；回复因达到上限被截断时末尾会提示
- **模型上下文长度**：对话历史超过此长度时自动裁剪最早消息并提示，避免触发 API 超限
- **联网搜索**：选择搜索引擎（Tavily / Brave，均有免费额度）并填入 API Key 即可启用，AI 需要时自动调用搜索并附来源链接；需模型支持 function calling

> AI 助手使用用户自行配置的 OpenAI 兼容接口，响应速度和 token 费用由所选模型和接口决定。如果某个模型响应较慢或频繁超时，可在「设置 → AI 配置」切换为响应更快的模型。

## 无 AI Key 用法（导出通道）

1. 「设置」→ 下载提示词 `.md`（或 `GET /api/export/plan-package` 取完整数据包）
2. 把内容粘贴给任意 AI，让其按模板输出 JSON 计划
3. 将返回的 JSON 通过「题目管理 → 逐条录入 / 上传文件」手动导入为计划

## 各平台接入状态

| 平台 | 自动同步 | 方式 | 难度标度（映射为 CF rating，800–3500） | 说明 |
|------|---------|------|------|------|
| Codeforces | ✅ | 官方公开 API `user.status` | `rating` 800–3500（参考标尺，原值直接用；Gym/Unrated 无值） | 无需登录；按新到旧分页，整页提交号已知即提前终止（增量） |
| AtCoder | ✅ | 社区 API `kenkoooo.com` v3 | kenkoooo IRT `difficulty`（−10000…4383，社区模型非官方）→ 按实测锚点分段线性映射 | 支持增量（from_second）；题目资源 24h 磁盘缓存；官方要求页间 ≥1s；拉取题库页签内有「用洛谷镜像补标签」开关（默认关，覆盖有限，命中计数随结果回传） |
| 洛谷 | ✅（需 Cookie） | `record/list` 非官方 API | `difficulty` **0–8 共 9 档**（0 = 暂无评定 → 未知）→ 800/1000/1500/1800/2200/2400/2600/3400 | 设置页填写 `_uid` / `__client_id` 两项 Cookie 后自动同步；标签经 `x-lentille-request` 头 + `/_lfe/tags` 字典获取 |
| 牛客 | ✅ | 公开 HTML `acm/contest/profile/{uid}/practice-coding` | 「难度分」**200–4000 的整数**（与 CF 同量纲，原值钳到 800–3500 直接用；**不保证是 100 的倍数**——老题实测 1049/623/726/972；约 20% 题目为空 → 未知） | 无需登录/Cookie（牛客已下线 JSON API）；解析提交表格，支持增量与分页；题库页可解析算法标签 |
| 代码源 | ✅（需 Cookie） | Hydro JSON API `/record?uidOrName=`（`Accept: application/json`） | 站内 1–10 档（管理员设定，否则按 Hydro `round(10 − 13·s·acRate)` 算法复算）→ 800/900/1000/1200/1400/1600/1800/2000/2200/2400 | 设置页填写 `sid` 一项会话 Cookie 后自动同步（每页 100 条，增量提前终止）；走 Hydro 原生 JSON 内容协商直接取 rdocs 数组，不依赖 HTML 模板解析，Hydro 升级改前端模板不会破坏适配器；状态按 Hydro STATUS 数字枚举映射统一 Verdict；仅含非比赛提交；题库页 `/p/{id}` 公开 |
| LeetCode | ✅（需 Cookie） | leetcode.cn GraphQL `submissionList` | easy/medium/hard 三档 → 1000/1500/2100（面试导向，启发式） | 设置页填写 Cookie 后自动同步（每页 40 条，最多 250 页）；仅接入力扣中国（leetcode.cn），国际版接口结构不同暂未接入；题库匿名可访问，拉取带中文标签（`nameTranslated`） |
| 计蒜客 | ✅（需 Cookie） | `/api/contests?hasParticipated=true` + 逐赛 `/api/contest/submissions`；另含练习（题库）提交 | `difficultyType` = level1…level8 共 8 档（入门/普及−/普及/普及+/提高−/提高/提高+/省选/国赛）→ 与洛谷同表 800/1000/1500/1800/2200/2400/2600/3400 | 设置页整段粘贴登录 Cookie 后自动同步（站点给未登录访客也发游客 `s` 会话，需确认已登录再从 Network 请求头复制）；无统一记录页，按「参加过的比赛」逐场拉取提交（每场至多 2 个请求，30 场/次分批）；以比赛序号为补全游标；**练习（自由练题/题库）提交默认同步**（预筛 `/api/problems` 的 `status=passed` / `status=attempted` 两轮过滤 + 逐题 `/api/problem/submissions`），可在设置页关闭，「仅同步最近 N 天」窗口模式不跑练习段 |
| QOJ | ✅（需 Cookie） | UOJ 系接口（Cloudflare 挑战后，需登录会话 `__Host-UOJSESSID`（旧名 UOJSESSID，发送前自动改名）/ cf_clearance 两项 Cookie + 浏览器 UA；设置页按 Cookie 名分框填写，后端自动合并成 Cookie 头） | **平台自身无难度字段**（UOJ 数据模型）；难度由「一键回填」用 **ICPC/CCPC 公开榜单**推导金/银/铜/铁档（`icpc-tier`，见下）→ 近似 CF 1000/1500/2000/2600 | 提交可同步；**不支持拉取题库**（题目列表在 Cloudflare 挑战之后）；难度推导三来源：`xcpcrating` 评分目录 + 该数据集的题型键（1100 道）+ **QOJ 比赛页**（题号字母映射，走 HTTP/1.1 + 已配置凭据），比赛名属性匹配榜单；仍未匹配到的题保持「未知」且**不进入训练计划候选池** |

> **难度统一标尺**：上表各平台的原生难度都映射到 Codeforces rating（800–3500），映射表**只有一份**，在 `shared/src/difficulty.ts`；原生值一并落库（`problems.native_difficulty` + `problems.difficulty_scale`），平台改档只需改这一个文件。映射为**近似值（±100–200）**，用于训练推荐与弱项分档，不作为精确评级。QOJ 的 `icpc-tier` 尤其粗（只有 4 档，±300–400）：档位由公开榜单的过题队伍占比判定（≤10% 金 / ≤30% 银 / ≤60% 铜 / 其余铁），原生档位与原始占比（如 `bronze:1019/2535`）一并落库，口径变化时可重算而无需重新抓取。

> **难度回填的优先级、取数方式与代价**（2026-09-27 起，2026-09-28 修正牛客）：一键回填按缺口排序——**真缺难度 → 缺标签 → 仅缺原生原文**。取数方式分两类：**整表类**（CF / AtCoder / 力扣 / 计蒜客 / 代码源，以及**目标数上千**时的牛客）各拉一次分页列表后在内存里逐题查；**逐题类**是洛谷（`GET /problem/{pid}`）与**目标数少**时的牛客（`keyword=<题号>` 搜索，1 请求 1 题）。牛客原先固定走整表，实测该整表是按题号**降序**、站点 1.47 万题 = 296 页而回填只翻到 200 页 → 老题号（如 `16593`）永远扫不到，`wantKeys`「全部命中才停」因此永不触发，每轮白扫几百页；改为「目标少时逐题」后既省一半以上请求，也补得上老题（见 `NOWCODER_PROBLEM_SEARCH_MAX`）。牛客与代码源改用整表/逐题查证后，「难度已有、只缺原生原文」的历史行**一轮即可补齐**，还会顺带**修正旧映射留下的过时难度值**（结果显示「修标题/标签/难度值 N 题」，明细里是「修正难度 700→800」）。因此 `deferred`（跳过 N 题）现在只会出现在洛谷上；需要强制逐题重查时 body 传 `includeNativeOnly: true`。整表类平台上限 20000，让历史行一轮收敛。
>
> **回填的平台顺序按实测成本升序**（QOJ ≈18s → AtCoder ≈3s → 代码源 ≈8s → CF ≈10s → 力扣 ≈53s → 计蒜客 ≈276s → 洛谷逐题 ≥4s/题 → 牛客逐题 ≥2s/题，目标多时整表几百页）。早期用字母序时 QOJ 排最后：一次点击要等十几分钟才轮到它，而**中途放弃或服务被重启（开发期 `tsx watch` 会因文件变更重启）时，排在后面的平台一行都不会写** —— 表现为「跑完回填，QOJ 还是没难度标签」。改成成本升序后，即使被打断，用户也已拿到 qoj/atcoder/CF 等绝大多数平台的标签。
>
> **整轮耗时的量级**：贵的是洛谷与牛客，两者都排在最后 —— 洛谷逐题 ≥4s/题（匿名请求的 C3VK 挑战码现在**跨题复用**，实测单题周期从 ≈8.5s 降到 ≈4.4s：原先每题都要先吃一个 302 再重试，而重试同样排一个 4 秒时间片）、单轮上限 400 题（最坏 ≈30 分钟）；牛客每道目标 ≈2s（实测 120 题 ≈4 分钟，原先为这几道题白扫整表 ≈7–10 分钟）。所以一次点击可能需要**几分钟到三十分钟**，取决于还剩多少真缺口；每平台写入是分批提交的，随时可以中断/关页面，已完成的部分都在库里，再点一次从剩余目标继续（不会重复已完成的题）。
>
> **请求节奏有两层**：① 全局按域名限速（`net/hostThrottle.ts`，洛谷 4s / 牛客 2s / AtCoder 2.5s / CF 2s / 力扣·计蒜客·代码源 1.5s）是线上实际节奏，可在「设置 → 拉取速度」按 1×–5× 调慢（1× 已是安全下限）；② 各适配器自带的页间/逐题 sleep 也已抬到**同一个安全下限**（原来洛谷 0.3s/题、牛客 0.5s/页）。两者取较大者，所以线上不会额外变慢，但**任何没走节流层的路径（本地脚本、单测、未来重构遗漏）也不会再打出风控级频率**。

> 洛谷基于社区维护的非官方 API，接口结构可能随平台变更；若同步失败请更新 Cookie 重试。Cookie 仅保存在本机数据库，请勿外泄。

## 已知限制

- **洛谷难度是官方「临时定义」**：官方难度文档明确标注为临时定义，且 2026-06 已调整过档位体系（新增青题「提高」），黑题拆分（NOI / NOI+/CTS）也在计划中 —— 本文档的洛谷映射表基于当时实测，官方定稿后需要复核重算（表驱动 + `difficulty_scale` 使其成本可控）。
- **牛客难度分有两种形态，曾有一批真值被自己误杀**：站上难度列**不保证是 100 的倍数**（老题实测 NC16640 = 1049、NC22014 = 623、NC22158 = 726、NC24739 = 972），旧校验器要求「100 的倍数」把这些真值判成未知（2026-09-27 已改为值域校验 + 列结构校验，并把这一批题补回）。另仍有约一部分题目**站上难度单元格本身为空**（多为「过关题目 / 语言题」，实测 41 道缺难度题里 30 道如此）→ 这些题显示「无官方难度」，并被记进负缓存，一个月内不再重复查询（见下）。
- **QOJ 难度靠公开榜单推导（2026-09-28 起三条来源，覆盖已打通）**：QOJ 平台自身没有难度字段（UOJ 数据模型），难度只能由 ICPC/CCPC 公开榜单的**过题队伍占比**推导档位（金/银/铜/铁 → CF 2600/2000/1500/1000）。整条链路是「题号 → 该场比赛 + 题号字母 → 榜单里该题的占比 → 档位」，其中第一环有三条来源：① `xcpcrating` 的 `problem-catalog.json`（评分数据集，实测覆盖 987 道 qoj 题号）；② **同一数据集的 `problem-types/*.json` 的键**（`赛场键:题号字母`，实测 1100 道）—— 旧实现只读它的 `detailTags`、把键丢掉，于是库内 `2513-14301/2/3`（2025 ICPC 亚洲东区网络赛第一场 A/B/C）明明有映射却仍被判「不在目录里」，症状正是「有标签、没难度」；③ **QOJ 比赛页**（`https://qoj.ac/contest/{比赛号}`，比赛号就写在库内题号里，如 `2513-14301`）：直接拿到比赛名与「题号字母 ↔ 题目 id」全表，覆盖前两条都没有的题（参考项目 OJ_Insight 的 `parse_category` 同款做法）。第二环匹配榜单时，来源①按赛场键匹配，来源③按**比赛名属性**（年份/系列/赛段/赛站/场次）打分匹配（`analysis/xcpcFacets.ts`；全国网络赛第一场 = 5+8+4+4 = 21 分，要求 ≥10 且最优唯一，兄弟场「第一场/第二场」靠场次区分）。QOJ 前置 Cloudflare：比赛页请求走 HTTP/1.1 + 设置页保存的 `cookie.qoj`/`ua.qoj`（与提交同步共用同一份凭据与同一个按域名节流桶），拿不到就如实降级为未知；比赛页按比赛号本地缓存 7 天、单轮最多读 6 场。数据源走 jsDelivr CDN 镜像（GitHub 直连在部分网络下被屏蔽），拿不到就整体降级为未知，不阻塞回填。仍未匹配到的题保持「未知」，**不进入训练计划候选池**。
- **Codeforces 的 gym 与官方未评级比赛没有公开难度**（实测 492 道 → 回填后剩 466）：`problemset.problems` **完全不含 gym**（11,425 题里 contestId≥100000 的为 0），gym 榜单 API 要求登录、题面 HTML 被 Cloudflare 403，洛谷也不镜像 gym 题 `CF100153A` —— 本机 115 道 gym 题确实无来源；另 351 道是**官方未评级**的常规比赛题（如 1116 的 Q# 量子题），官方 API 收录了它们但没有 `rating` 字段 → 回填如实记为「官方无难度」（`missing`），不臆造。
- **映射是近似值**：各平台难度与 CF rating 并非严格同构（AtCoder 的 kenkoooo 难度是社区 IRT 模型，力扣/代码源为启发式，QOJ 的 ICPC 档位只有 4 档），映射误差约 ±100–200（QOJ 档位 ±300–400），仅用于训练推荐与弱项分档；平台改档或调整定义时，映射值可能需要重新实测。
- **AtCoder 的「用洛谷镜像补标签」覆盖有限**：标签来自第三方（洛谷镜像题）归属，默认关闭（开关在「拉取题库」页签、选中 AtCoder 时出现）；实测 250 行样本中 139 行命中题号、其中仅 68 行真的带标签，不作为完整标签来源。
- **难度回填按平台分批**：一次点击会遍历所有平台，但**洛谷逐题上限 400 题**会截断，超出的题数随响应回传（`capped`），再点一次继续；整表类平台（CF / AtCoder / 力扣 / 计蒜客 / 代码源）上限 20000 以便历史行一轮收敛。洛谷「仅缺原生原文」的行默认跳过并计入 `deferred`（不占额度、不打上游），需要时勾选「拉取题库」页签里的**强制重查**（= `includeNativeOnly: true`，同时无视负缓存）；上游确实无难度的题（牛客空值题、洛谷「暂无评定」、CF gym）不再每轮重查：结果计入 `cached`，并见下条「无难度负缓存」；上游明确拒绝的题（401/403）另计 `denied`。

- **无难度负缓存**（`problems.gap_state` + `gap_checked_at`，TTL 30 天）：回填问过上游、上游明确表示给不出的维度（`difficulty` / `tags`）记在这两列上，TTL 内这些行**不再进入回填目标**，题数计入 `cached`，列表里显示「无官方难度」而不是横杠（横杠 = 还没查到）。四条边界：① 只有**单次响应即完整题库**的平台（CF / AtCoder）能把「查不到这行」当定论，分页扫描型（牛客/代码源/力扣/计蒜客）本次没翻到 ≠ 上游没有，不记；② 请求失败、风控页、洛谷逐题 404 一律不记（否则一次封号就把题锁 30 天）；③ QOJ 完全不记（它的 null 分不清「目录里没有」和「榜单源不可用」）；④ **题号形态必须先过校验**（2026-09-28 新增，见下条）。上游后来给出评级/标签时该维度立即退出缓存，不必等 TTL；`includeNativeOnly: true`（界面上的「强制重查」勾选项）同时绕过负缓存与洛谷的 `deferred` 重问一遍（题号形态修复前被误锁的旧定论已由启动迁移一次性作废，见下条；这个勾选项留给其它需要强查的场景，例如想立刻拿到平台刚补上的评级而 TTL 未到）。**标签维度另有两条例外**：`tags` 记的是「上游确实没有**可用的算法**标签」——洛谷只给赛事/来源/年份标签（如 `2013`、`USACO`、`洛谷原创`、`O2优化`）时，净化后为空，这属于真结论，照常记缓存（洛谷相当一部分缺标签的题属于此类，锁住它们是有意的，重查也拿不到算法标签）；而**上游给了 tag id 却解析不出名称**（`/_lfe/tags` 字典拉取失败时会静默变成空字典）时**不记**任何结论，避免把「我没拿到字典」误锁 30 天。
- **题号形态校验 + AtCoder 题号归一**（2026-09-28 取证的真 bug）：库内题号是展示形态 `abc300a`，而 kenkoooo 整表是 `abc300_a` → 整表查不到；AtCoder 又属于「单次响应即完整题库」，这个 miss 被当成「上游确实没有」写下 30 天负缓存（本机 demo 库 100 行 AtCoder 缺口全部被锁，其中 64 行的题号只差一个下划线）。现在两条防线：① **查询前归一**——AtCoder 按「原样优先，其次补下划线的规范形态」逐个查（`atcoderProblemIdCandidates`；kenkoooo 里还真的有 20 条例外题号原生没有下划线，如 `joi2011ho1`，所以候选表必须保序以库内原键打头），写库仍按库内原键、不做数据迁移；② **写定论前过形态校验**（`absenceIsDefinitive`）——库内题号的**比赛前缀必须真实存在于整表**（`abc308i` 的前缀 `abc308` 在表里 → 该题确实未被收录，可以定论；`abcc300a` 这种拼错的前缀不在表里 → 不写缓存，只记 `failed` 并在明细里注明「题号形态可疑，未记「无官方难度」定论」）。实测（真实 kenkoooo 快照 × demo 库 100 行）：10 行本就规范、64 行补下划线后命中（`nativeFilled: 64`）、25 行比赛存在但整表未收录（照旧定论）、1 行（`abc316g`，整个 abc316 都不在快照里）保持不定论、下轮重查；③ **旧定论一次性作废**（`db/index.ts` 的 `invalidateUnreliableGapVerdicts`）：归一/校验只对**新写下**的定论生效，已被误锁的行会一直被挡在回填目标之外，所以启动迁移会把「题号形态不可信且定论写于本次修复之前」的 AtCoder 定论清掉（幂等：重查后带新时刻写下的定论不再被清）—— 用户不需要知道去点「强制重查」就能解套，代价只是下一轮多一次 kenkoooo 整表请求（逐题型平台一条都不动）。同一条风险在牛客也存在（历史键 `NC20000` 与站点 id `20000`），那边在更早的版本已按「查询侧归一」处理。
- **上游明确拒绝（401/403）与「没翻到」分开记**：已删除 / 转私有 / 不对外开放的题，洛谷匿名给 401、带已配置 Cookie 给 403（本机实测 `T822401` 等 3 道）。这类是上游对**这一行**的确定性答复，现在记成 `denied`（结果文案里是「无公开来源 N 题（上游已下架/私有）」），并写入负缓存、下轮不再重打；而 HTTP 500 / 302 挑战页 / 504 仍只算「没拿到」（`failed`），下轮照旧重试、绝不写缓存。这类题唯一的出路是**在难度格上手动填写难度**（`PATCH /api/problems/:platform/:key/difficulty`）：`difficulty_source` 置 `manual`（优先级最高，回填/同步/题库都不覆盖），原生值与标度**同源**写入（记的就是这个 CF 数值本身，避免落成「手动 2400 + 平台原生『提高』(≈2200)」这种自相矛盾的组合），并清掉负缓存；传 `null` 则清除、恢复「未知」并重新参与回填。
- **一次回填可能跑十几分钟，且是「同步进行、边做边落库」**：牛客逐题 ≥2s/题（目标上千时改拉整表几百页）、洛谷逐题 ≥4s/题（数百题≈十几分钟），两者排在最后。每个平台的写入都是**分批次提交**的，所以中途关掉页面、或**服务被重启（开发期 `tsx watch` 会因文件变更自动重启）**时，已经跑完的平台成果都在库里，只需再点一次继续；qoj/atcoder/CF 等便宜平台排在前面，几秒内就能拿到结果。
- **可随时停止，停完再点一次接着补**：运行中点「停止回填」（`POST /api/problems/backfill-difficulty/stop`）会在**服务端**中止本轮——在途的上游请求立即中断，当前批次**提交**而非回滚，所以**已落库的题不受影响**、被中断的题仍是下次运行的目标（`results` 里被中断的平台带 `stopped: true`，中断不计 `failed`、也不写负缓存）。停止是服务端动作：前端只 abort 自己的 fetch 做不到这件事（服务端循环会照旧跑完写库）。页面刷新/重开也不会丢进度：`GET /api/problems/backfill-difficulty/run` 给出「正在处理 平台 N/M（本轮共 N 题）」与运行状态，界面据此继续显示进度和停止按钮。同一时刻只允许一轮（运行中重复触发返回 409，避免并发抢写同一批行、更快触发风控），运行状态**不跨进程持久化**（服务重启即中断，靠分批提交保住成果）。
- **旧库的难度值可能过时，回填会修正它**：映射表改版后，库里由旧表写下的值不会自动迁移。整表类平台（CF / AtCoder / 力扣 / 计蒜客 / 代码源，牛客两条链路同理）每轮回填都用上游当前值改写它们（计入 `repaired`，明细含「修正难度 X→Y」）；**洛谷这类只有逐题来源的平台例外**——其「仅缺原生原文」的行默认被跳过，因此库内洛谷旧映射值不会在默认回填里被修正，需显式开 `includeNativeOnly`。
- **后台续拉是进程内计划**：同步被单次上限截断时，后台按平台节奏（20–90 秒）自动续拉，默认最多 6 轮（设置页可改，0 = 关闭，可随时停止）；服务重启后续拉计划丢失，手动点一次同步即从已保存的游标继续。

## Cookie 配置方法（洛谷 / 代码源 / LeetCode / 计蒜客需要）

1. 浏览器登录洛谷后，F12 → Application（应用）→ Cookies → `https://www.luogu.com.cn`
2. 复制 `_uid` 与 `__client_id` 两项的值，分别填入「设置 → 洛谷」的两个输入框后保存（请求用 Cookie 头由应用拼装，C3LK 等其余 Cookie 自动续期，无需填写）
3. 代码源同理：浏览器登录 bs.daimayuan.top 后，F12 → Application → Cookies 复制 `sid` 一项（登录会话），填入「设置 → 代码源」后保存（支持直接整段粘贴 Cookie 头，自动提取字段；过期后重新复制一次即可）
4. LeetCode：浏览器登录 leetcode.cn 后，F12 → Application → Cookies 复制 `LEETCODE_SESSION` 与 `csrftoken` 两项，填入「设置 → LeetCode」后保存
5. 计蒜客：先确认浏览器已登录 www.jisuanke.com（右上角为头像），然后 F12 → Network → 刷新页面 → 点任一 api 请求 → Request Headers 复制整段 Cookie，填入「设置 → 计蒜客」后保存（handle 填昵称仅作备注）。注意：未登录时站点也会发游客 `s` 会话，从 Application 直接抄 `s` 大概率是游客会话，会提示无效
6. 到「题目管理」→ 平台同步 → 输入用户名/uid → 同步
7. 换绑账号时，新同步会自动清空该平台旧账号的提交数据

## API 一览

```
GET  /api/health
POST /api/sync/all               # 一键同步全部已绑定账号（各平台增量，单平台失败不影响其余）
POST /api/sync/:platform          # 同步单个平台账号（body: handle）
POST /api/import/manual           # 手动导入（body: platform, rows[]）
POST /api/import/csv              # CSV 导入（body: platform, csv）
GET  /api/stats                   # 总体统计（from/to/platform 过滤；account=账号视角，必须与 platform 成对，缺省 = 全部账号）
GET  /api/stats/weakness          # 弱项画像（minAttempts/topN；platform+account 同上——平均 AC 率基准随作用域收窄）
GET  /api/stats/trend             # 周趋势（weeks；platform+account 同上）
GET  /api/stats/heatmap           # 刷题热力图（days；platform+account 同上）
GET  /api/stats/mastery           # 知识点掌握度地图（刷题数据 × 模板课程联动；platform+account 同上）
GET  /api/stats/accounts          # 库内有提交记录的账号（platform/account/提交数/AC 数/过题数/最近提交时间），供前端「账号视角」切换器；无归属账号的手动导入行不列出
GET  /api/stats/summary           # 完整个人练习数据汇总（JSON：总量/平台/难度/标签/弱项/掌握度/趋势/近期 AC/卡壳题/复习库/课程进度/打卡）
GET  /api/problems                # 题目列表（platform/difficulty/tag/q 过滤；tag 含同义英文别名命中）
GET  /api/today                   # 今日训练推荐（按弱项 + 计划任务挑题）
GET  /api/templates               # 内置模板课程全量 + 个人进度（total/mastered/learning/next）
GET  /api/templates/next          # 「下一课」推荐（学习中优先，其次大纲第一个未学）
POST /api/templates/custom        # 新建自建模板 | PATCH/DELETE /api/templates/custom/:id
PUT  /api/templates/:id/content   # 课程「写入我的模板」（思路/代码/复杂度/参考链接）
POST /api/templates/:id/status    # 学习状态（body: { status: todo|learning|mastered }）
PATCH /api/templates/:id/note     # 学习笔记（body: { note }）
GET  /api/reviews                 # 复习队列（含每题 reviewCount/lapseCount；?due=1 只看到期与逾期）
GET  /api/reviews/due-count       # 复习负载分布：count=今日该做（逾期+到期），另回 overdue/dueToday/next7/total
POST /api/reviews/:id/feedback    # 复习反馈（hard 退两档 / ok 进一档 / easy 进两档）→ 乘留存系数后排期，并写一行 review_events
                                   # 返回 { stage, nextDueOn, intervalDays, factor }；POST /api/reviews 加入时按题号错峰 0–3 天
GET  /api/contests                # 五平台赛事聚合（CF/AtCoder/洛谷/牛客/计蒜客；?type=upcoming|finished&platform=&limit=）
GET  /api/contests/participated   # 赛后复盘「我参加的」：读库秒出（落库持久化），过期平台触发后台增量刷新
POST /api/contests/participated/refresh  # 强制同步拉取参赛记录（增量游标生效，单次翻页上限 30 页）
GET  /api/plans | POST /api/plans/generate | POST /api/plans/import | GET /api/plans/:id | DELETE /api/plans/:id
                                   # generate body: { days?, startDate?, dailyTasks?, requirements? } ← requirements 为用户手写训练要求，注入 AI 提示词优先满足
                                   # import body: { raw, startDate?, days? } ← 任意 AI 返回的计划 JSON 文本
PATCH /api/plans/tasks/:taskId    # 编辑单条任务（taskDate/title/kind/url/note，仅更新提交字段）
DELETE /api/plans/tasks/:taskId   # 删除单条任务（打卡记录级联删除）
POST /api/plans/:id/apply         # 应用 AI 计划修改（body: { raw }；按「日期+标题」匹配保留打卡）
POST /api/ai/chat                # 全局 AI 助手对话（body: { messages, planId?, listId?, contestKey? }；注入练习汇总/弱项画像/能力值/赛事日历/当前日期，planId 给定可改计划、无 planId 时可生成新计划，listId 关联题单，contestKey 关联参加过的比赛做赛后复盘；user 消息可带 attachments: [{ fileId, filename? }]，≤8 个，支持图片/PDF/多格式文档/文本代码；支持 function calling 工具：联网搜索 / fetch-url 抓取网页 / pdf-parse 解析 PDF）
POST /api/ai/extract-text         # 本地提取文档文本（原始字节流，header: content-type + x-file-name；PDF 用 unpdf ≤10MiB，Word/Excel/PPT/HTML/CSV/JSON/XML/EPub 用 docConverter ≤20MiB；返回 { text, pages?, warning? }）
POST /api/ai/files               # 上传文件到 AI Files API（原始字节流直传，header: x-file-name / x-expires-seconds?；服务端转 multipart 转发上游，purpose=user_data，≤64MiB）
GET  /api/ai/files               # 列出文件（?after=&limit=1-1000&order=asc|desc，游标分页）
GET  /api/ai/files/:fileId       # 查询文件元信息
DELETE /api/ai/files/:fileId     # 删除文件
GET  /api/ai/ability             # 估算能力值（computed/override/effective）
POST /api/ai/ability             # 应用 AI 能力值调整（body: { level, reason } 或 { reset: true }）
GET  /api/lists                  # 题单列表 | POST /api/lists 导入（body: { title, raw, sourceUrl? }）
GET  /api/lists/:id              # 题单详情（条目含难度/已 AC 状态）
POST /api/lists/:id/classify     # 按题库 tags 规则分类 | POST /:id/ai-classify AI 分类
POST /api/lists/:id/ai-suggest   # AI 读取题单内容给练习建议（返回 markdown）
PATCH /api/lists/items/:itemId   # 手动改分类（body: { category }）| DELETE 同路径移除条目
POST /api/knowledge/build         # 触发 L1 规则批跑 + 题源标签映射（body: { rerun?: boolean }）
GET  /api/knowledge/coverage      # 覆盖率报告（total / annotated / uncovered / bySource / 阈值）
GET  /api/knowledge/gaps          # 词表缺口报告（无法映射的题源标签 → 影响题数）
POST /api/knowledge/recompute-stats # 重算概念统计（覆盖率与信息量）
POST /api/knowledge/threshold     # 设置统计端置信度阈值（body: { value: 0..1 }；影响掌握度地图 / 题单统计 / 覆盖率已标注数 / 双口径对比未覆盖桶）
GET  /api/knowledge/taxonomy      # 知识点体系全量
GET  /api/knowledge/problem/:platform/:key # 单题当前标注
PUT  /api/knowledge/:platform/:key # L3 人工校正（body: { codes: string[] }）
GET  /api/knowledge/compare        # tag 口径 vs 知识点口径弱项对比
GET  /api/knowledge/sample         # 批跑后随机抽检清单（?rate=0.01）
GET  /api/knowledge/meta           # 管线版本与规则/知识点数量
POST /api/problems/:platform/:key/intent  # 记录用户声明的卡点（body: { outcome, code? }）
GET  /api/problems/:platform/:key/intents # 该题卡点记录
PATCH /api/problems/:platform/:key/difficulty # 手动填写/清除单题难度（body: { difficulty: 800-3500 整数 | null }）
                                    # 用于上游确实给不出难度的题（已删除/私有、洛谷「暂无评定」、CF gym/Unrated）：
                                    # difficulty_source 置 'manual'（回填与同步都不覆盖）、原生值与标度同源写入、
                                    # 并清掉「平台无公开难度」负缓存；null = 清除并恢复「未知」（重新参与回填）
GET  /api/checkins?month=YYYY-MM  # 月打卡视图
GET  /api/checkins/date/:date     # 当天任务（Web 挂件复用）
GET  /api/checkins/streak         # 连续打卡统计（current/longest/totalDays）
POST /api/checkins { taskId }     # 打卡 | DELETE /api/checkins/:taskId 取消
GET  /api/settings                # 设置（AI/账号/适配器开关/打卡提醒）
POST /api/settings/reminder       # 打卡提醒配置（body: enabled?, time? "HH:MM"）
POST /api/settings/cookies/check  # 检测 Cookie 登录态（检测与同步走同一数据页：洛谷 record/list 自检、代码源按绑定账号访问评测记录页）
GET  /api/export/plan-package     # 数据包（弱项+趋势+题目+提示词）
GET  /api/export/plan-prompt.md   # 渲染好的提示词下载（已内置练习数据汇总）
GET  /api/export/summary.md       # 完整个人练习数据汇总 .md 下载（复盘 / 喂给任意 AI）
GET  /api/update/check            # 更新检查（稳定版 + nightly 提交构建双通道）
GET  /api/update/progress         # 一键更新下载进度（phase/received/total）
POST /api/update/download         # 开始下载并 SHA256 校验 | POST /api/update/apply 原位替换
GET  /widget                      # Web 挂件单页（当天任务 + 打卡）
```

## 测试

```bash
npm test            # server 单元测试（schema/配置/适配器/导入/同步/分析/计划）
npm run typecheck   # 双端类型检查
```

测试覆盖：数据库 schema 与约束、配置校验、CF/AtCoder/牛客赛事适配器归一化（mock + 真实网络验证）、CSV 解析、导入去重、增量同步、统计/弱项/趋势与手工计算一致性、AI 生成三路径（成功/失败/未配置）、赛后复盘参赛推导（各平台判定信号/时间窗匹配/复盘上下文渲染）、更新双通道判定与 SHA256 校验解析、文档转换器（Word/Excel/PPT/HTML/CSV/JSON/XML/EPub）、Markdown 数学公式预处理管线、会话级附件内容缓存。

## 赞助

如果这个项目对你的备赛有帮助，欢迎请作者喝杯咖啡 ❤

[![Sponsor](https://img.shields.io/badge/Sponsor-❤-EA4AAA?style=for-the-badge&logo=githubsponsors)](https://github.com/sponsors/ZF3373)

也支持在仓库首页右侧点击「Sponsor this project」按钮赞助（赞助渠道配置见 [.github/FUNDING.yml](./.github/FUNDING.yml)）。

## 许可证

本项目代码以 [GPL-3.0 License](./LICENSE)（GNU 通用公共许可证 v3.0）发布：对项目的再分发与修改版同样须以 GPL-3.0 开源并保留版权声明。
第三方依赖及其许可证见 [CREDITS.md](./CREDITS.md)；安全问题请通过 [SECURITY.md](./SECURITY.md) 的私密渠道报告，勿公开发 Issue。
