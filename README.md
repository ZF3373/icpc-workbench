# ICPC Workbench · ICPC 备赛工作台

**中文** | [English](./README.en.md)

基于刷题记录（Codeforces / AtCoder / 洛谷 / 牛客 / 代码源 / LeetCode / 计蒜客）分析弱项、由 AI 生成个性化训练计划，并提供日历打卡的**本地 Web 应用**。

## 功能

- **多平台刷题导入**：Codeforces / AtCoder 自动同步（官方/社区公开 API，增量去重）；洛谷 / 代码源 / LeetCode / 计蒜客配置 Cookie 后自动同步；全平台支持手动导入（JSON / CSV / 表单）
- **同步可观测性**：每次平台同步（成败皆记）写入任务历史——拉取数、去重数、限速等待、耗时与可解释的失败分类（凭据失效 / 限流 / 页面结构变化 / 需手动导入等）；`GET /api/sync/diagnostics` 可导出纯文本诊断报告（不含任何密钥），`POST /api/sync/:platform` 支持 `days` 参数仅同步最近 N 天；拉取速度用户可调并带每域名安全下限（防风控），提交过多自动分批、再次同步续拉不重复；数据概览常驻同步状态卡（进行中显示逐平台进度，空闲可展开上次同步结果抽屉）
- **数据保护**：每日首次启动、应用升级前、大批量导入前、换账号重置前自动创建 SQLite 恢复点（`VACUUM INTO` 一致快照，按类型分级保留）；「设置 → 备份与恢复点」可手动备份与一键恢复（重启应用生效）；手动导入 JSON/CSV 前先展示变更预览（新增 / 跳过 / 非法行明细），确认后才写入
- **本地安全边界**：服务端固定监听 127.0.0.1，不暴露局域网；设置接口只回传「是否已配置」状态，绝不返回 API Key / 搜索 Key / Cookie 原文；AI 网页抓取内置 SSRF 防护——拦截本机/内网/链路本地地址（含 DNS 解析校验与逐跳重定向校验），重定向不泄露平台 Cookie
- **内置题库**：软件自带约 1.3 万题离线题库（Codeforces 全量 + 洛谷普及/提高- 及以上，含难度与算法标签），首次启动自动入库、开箱即可供训练计划/题单选题；需要更多时在「题目管理 → 拉取题库」按平台扩充（CF 单次调用秒级，洛谷/牛客/计蒜客按页拉取）
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
  - **多会话并行**：每个会话独立标记生成状态，会话 A 回复中切到会话 B 照常输入发送，两个会话并行流式输出互不阻塞；生成中发送按钮变红色「停止」可中止（已收到部分保留并标注「已停止生成」）
  - 多会话管理：侧边栏会话记录，支持新建 / 切换 / 删除 / 置顶 / 双击重命名 / 拖拽排序，会话记录保存在浏览器本地
  - 切换模块再回来不丢会话；生成中切走，回来后回复自动出现
  - **消息复制 / 再次编辑**：助手消息可一键复制全文；用户消息支持「再次编辑」重发（失败回合自动剔除不回传给模型）
  - **数学公式渲染增强**：AI 输出的裸数学表达式（不带 `$` 定界符的下标/上标/LaTeX 命令等）自动识别并包裹渲染；`\(...\)` / `\[...\]` 定界符自动归一化为 `$` / `$$`；Unicode 数学符号（≤ ≥ ≠ ⊕ ⊗ ℓ 等）自动转为 LaTeX 命令；解析失败时以普通文本回退而非刺眼红字
  - **可配输出上限**：「设置 → AI 配置」可调最大输出 token（默认 384K，长输出场景可再调大）与模型上下文长度（默认 1000K，超限自动裁剪最早消息并提示）；回复因达到上限被截断时末尾会出现提示
  - 图片附件：消息可附上题面 / 评测截图（JPEG/PNG/GIF/WebP，≤64MiB），经 OpenAI 兼容 Files API 上传后以 file 内容块随消息引用
- **题单整理**：粘贴平台题单（洛谷 / Codeforces / AtCoder / 代码源 / 牛客 / LeetCode 的题号或链接，每行一题）自动识别建单；按知识点分类（已同步题库 tags 规则分类 + AI 分类 + 手动调整），联查题库标注难度与已 AC 状态；洛谷题单中的 CF/AtCoder 镜像题自动回退到原生平台查 tags 分类；规则分类只更新题库有 tags 的题，查不到的保留已有分类（不会被抹成「其他」）；AI 读取题单内容结合弱项画像给出练习建议
- **复习库**：题目复评与遗忘曲线调度（到期数量提醒、正/负反馈调节复习间隔）
- **模板库**：114 节内置算法模板课程（分 10 大类），学习状态/笔记/进度追踪；支持自建分类归类整理，整套模板可一键导出 Markdown / PDF 存档分享；自建模板支持 Tab 缩进的代码编辑框（Tab 缩进、Shift+Tab 反缩进、回车自动缩进，保留撤销栈）；思路备注配备 Markdown 编辑器（格式工具栏、粘贴图片、实时预览），支持完整 Markdown 渲染（GFM 表格/删除线/代码块 + 数学公式，行内 `$...$` 与块级 `$$...$$`，兼容 Obsidian 语法）；页头可切换缩进空格数（2/4，本地持久化）
- **写题历史**：数据概览页一键查询「我在哪些平台写过哪些题」——按题目汇总（提交/AC 次数）或逐条提交两种视图，平台筛选、全部 AC / 未通过过滤，直达原题链接
- **赛事中心**：Codeforces / AtCoder / 洛谷 / 牛客 / 计蒜客 五平台场次聚合（即将开始 / 已结束，单源失败自动降级），赛前选场、赛后补题
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
| 牛客 | ✅ | 公开 HTML `acm/contest/profile/{uid}/practice-coding` | 「难度分」**200–4000、100 的倍数**（与 CF 同量纲，原值钳到 800–3500 直接用；约 20% 题目为空 → 未知） | 无需登录/Cookie（牛客已下线 JSON API）；解析提交表格，支持增量与分页；题库页可解析算法标签 |
| 代码源 | ✅（需 Cookie） | Hydro JSON API `/record?uidOrName=`（`Accept: application/json`） | 站内 1–10 档（管理员设定，否则按 Hydro `round(10 − 13·s·acRate)` 算法复算）→ 800/900/1000/1200/1400/1600/1800/2000/2200/2400 | 设置页填写 `sid` 一项会话 Cookie 后自动同步（每页 100 条，增量提前终止）；走 Hydro 原生 JSON 内容协商直接取 rdocs 数组，不依赖 HTML 模板解析，Hydro 升级改前端模板不会破坏适配器；状态按 Hydro STATUS 数字枚举映射统一 Verdict；仅含非比赛提交；题库页 `/p/{id}` 公开 |
| LeetCode | ✅（需 Cookie） | leetcode.cn GraphQL `submissionList` | easy/medium/hard 三档 → 1000/1500/2100（面试导向，启发式） | 设置页填写 Cookie 后自动同步（每页 40 条，最多 250 页）；仅接入力扣中国（leetcode.cn），国际版接口结构不同暂未接入；题库匿名可访问，拉取带中文标签（`nameTranslated`） |
| 计蒜客 | ✅（需 Cookie） | `/api/contests?hasParticipated=true` + 逐赛 `/api/contest/submissions`；另含练习（题库）提交 | `difficultyType` = level1…level8 共 8 档（入门/普及−/普及/普及+/提高−/提高/提高+/省选/国赛）→ 与洛谷同表 800/1000/1500/1800/2200/2400/2600/3400 | 设置页整段粘贴登录 Cookie 后自动同步（站点给未登录访客也发游客 `s` 会话，需确认已登录再从 Network 请求头复制）；无统一记录页，按「参加过的比赛」逐场拉取提交（每场至多 2 个请求，30 场/次分批）；以比赛序号为补全游标；**练习（自由练题/题库）提交默认同步**（预筛 `/api/problems` 的 `status=passed` / `status=attempted` 两轮过滤 + 逐题 `/api/problem/submissions`），可在设置页关闭，「仅同步最近 N 天」窗口模式不跑练习段 |
| QOJ | ✅（需 Cookie） | UOJ 系接口（Cloudflare 挑战后，需 UOJSESSID / cf_clearance 两项 Cookie + 浏览器 UA；设置页按 Cookie 名分框填写，后端自动合并成 Cookie 头） | **不提供难度**（UOJ 数据模型无难度字段）→ 难度恒为「未知」 | 提交可同步；**不支持拉取题库**（题目列表在 Cloudflare 挑战之后，且平台无难度字段）；因难度为空，QOJ 题目不进入训练计划候选池 |

> **难度统一标尺**：上表各平台的原生难度都映射到 Codeforces rating（800–3500），映射表**只有一份**，在 `shared/src/difficulty.ts`；原生值一并落库（`problems.native_difficulty` + `problems.difficulty_scale`），平台改档只需改这一个文件。映射为**近似值（±100–200）**，用于训练推荐与弱项分档，不作为精确评级。

> 洛谷基于社区维护的非官方 API，接口结构可能随平台变更；若同步失败请更新 Cookie 重试。Cookie 仅保存在本机数据库，请勿外泄。

## 已知限制

- **洛谷难度是官方「临时定义」**：官方难度文档明确标注为临时定义，且 2026-06 已调整过档位体系（新增青题「提高」），黑题拆分（NOI / NOI+/CTS）也在计划中 —— 本文档的洛谷映射表基于当时实测，官方定稿后需要复核重算（表驱动 + `difficulty_scale` 使其成本可控）。
- **牛客约 20% 题目没有难度分**：主要是新题，多为空值 → 这些题难度显示「未知」，回填管线会重试但仍可能长期为空。
- **QOJ 不提供难度**：平台数据模型里没有难度字段，本软件不猜、不发明 —— QOJ 题目难度恒为空，**因此不进入训练计划候选池**。
- **映射是近似值**：各平台难度与 CF rating 并非严格同构（AtCoder 的 kenkoooo 难度是社区 IRT 模型，力扣/代码源为启发式），映射误差约 ±100–200，仅用于训练推荐与弱项分档；平台改档或调整定义时，映射值可能需要重新实测。
- **AtCoder 的「用洛谷镜像补标签」覆盖有限**：标签来自第三方（洛谷镜像题）归属，默认关闭（开关在「拉取题库」页签、选中 AtCoder 时出现）；实测 250 行样本中 139 行命中题号、其中仅 68 行真的带标签，不作为完整标签来源。
- **难度回填按平台分批**：一次点击会遍历所有平台，但**每平台单次上限**（洛谷 400 题、牛客/代码源 300 题、整表平台 2000 题）会截断，超出的题数随响应回传，再点一次继续；未评级的题（洛谷「暂无评定」等）每次仍会被重新查询，属已知代价。
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
GET  /api/stats                   # 总体统计（from/to/platform 过滤）
GET  /api/stats/weakness          # 弱项画像（minAttempts/topN）
GET  /api/stats/trend             # 周趋势（weeks）
GET  /api/stats/mastery           # 知识点掌握度地图（刷题数据 × 模板课程联动）
GET  /api/stats/summary           # 完整个人练习数据汇总（JSON：总量/平台/难度/标签/弱项/掌握度/趋势/近期 AC/卡壳题/复习库/课程进度/打卡）
GET  /api/problems                # 题目列表（platform/difficulty/tag/q 过滤；tag 含同义英文别名命中）
GET  /api/today                   # 今日训练推荐（按弱项 + 计划任务挑题）
GET  /api/templates               # 内置模板课程全量 + 个人进度（total/mastered/learning/next）
GET  /api/templates/next          # 「下一课」推荐（学习中优先，其次大纲第一个未学）
POST /api/templates/custom        # 新建自建模板 | PATCH/DELETE /api/templates/custom/:id
PUT  /api/templates/:id/content   # 课程「写入我的模板」（思路/代码/复杂度/参考链接）
POST /api/templates/:id/status    # 学习状态（body: { status: todo|learning|mastered }）
PATCH /api/templates/:id/note     # 学习笔记（body: { note }）
GET  /api/reviews                 # 复习队列 | POST /api/reviews 新建复评
GET  /api/reviews/due-count       # 到期复习数量
POST /api/reviews/:id/feedback    # 复习反馈（记住/遗忘 → 调度下次复习）
GET  /api/contests                # 五平台赛事聚合（CF/AtCoder/洛谷/牛客/计蒜客；?type=upcoming|finished&platform=&limit=）
GET  /api/plans | POST /api/plans/generate | POST /api/plans/import | GET /api/plans/:id | DELETE /api/plans/:id
                                   # generate body: { days?, startDate?, dailyTasks?, requirements? } ← requirements 为用户手写训练要求，注入 AI 提示词优先满足
                                   # import body: { raw, startDate?, days? } ← 任意 AI 返回的计划 JSON 文本
PATCH /api/plans/tasks/:taskId    # 编辑单条任务（taskDate/title/kind/url/note，仅更新提交字段）
DELETE /api/plans/tasks/:taskId   # 删除单条任务（打卡记录级联删除）
POST /api/plans/:id/apply         # 应用 AI 计划修改（body: { raw }；按「日期+标题」匹配保留打卡）
POST /api/ai/chat                # 全局 AI 助手对话（body: { messages, planId? }；注入练习汇总/弱项画像/能力值/赛事日历，planId 给定可改计划；user 消息可带 attachments: [{ fileId, filename? }]，≤8 个；支持 function calling 工具：联网搜索 / fetch-url 抓取网页 / pdf-parse 解析 PDF）
POST /api/ai/chat                # 全局 AI 助手对话（body: { messages, planId? }；注入练习汇总/弱项画像/能力值/赛事日历/当前日期，planId 给定可改计划、无 planId 时可生成新计划；user 消息可带 attachments: [{ fileId, filename? }]，≤8 个，支持图片/PDF/多格式文档/文本代码；支持 function calling 工具：联网搜索 / fetch-url 抓取网页 / pdf-parse 解析 PDF）
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

测试覆盖：数据库 schema 与约束、配置校验、CF/AtCoder/牛客赛事适配器归一化（mock + 真实网络验证）、CSV 解析、导入去重、增量同步、统计/弱项/趋势与手工计算一致性、AI 生成三路径（成功/失败/未配置）、更新双通道判定与 SHA256 校验解析、文档转换器（Word/Excel/PPT/HTML/CSV/JSON/XML/EPub）、Markdown 数学公式预处理管线、会话级附件内容缓存。

## 赞助

如果这个项目对你的备赛有帮助，欢迎请作者喝杯咖啡 ❤

[![Sponsor](https://img.shields.io/badge/Sponsor-❤-EA4AAA?style=for-the-badge&logo=githubsponsors)](https://github.com/sponsors/ZF3373)

也支持在仓库首页右侧点击「Sponsor this project」按钮赞助（赞助渠道配置见 [.github/FUNDING.yml](./.github/FUNDING.yml)）。

## 许可证

本项目代码以 [GPL-3.0 License](./LICENSE)（GNU 通用公共许可证 v3.0）发布：对项目的再分发与修改版同样须以 GPL-3.0 开源并保留版权声明。
第三方依赖及其许可证见 [CREDITS.md](./CREDITS.md)；安全问题请通过 [SECURITY.md](./SECURITY.md) 的私密渠道报告，勿公开发 Issue。
