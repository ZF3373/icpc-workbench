# ICPC Workbench · ICPC 备赛工作台

基于刷题记录（Codeforces / AtCoder / 洛谷 / 牛客）分析弱项、由 AI 生成个性化训练计划，并提供日历打卡的**本地 Web 应用**。

## 功能

- **多平台刷题导入**：Codeforces / AtCoder 自动同步（官方/社区公开 API，增量去重）；洛谷 / 牛客手动导入（JSON / CSV / 表单）
- **弱项分析**：按标签 / 难度区间 / 平台统计 AC 率，输出相对自身平均的弱项画像；近 12 周趋势
- **今日训练**：按弱项 + 计划任务智能挑题，每天一个可执行的小目标
- **AI 训练计划（双通道）**：
  - 内置生成：配置 OpenAI 兼容 API Key 一键生成（DeepSeek / OpenAI / 智谱 / Ollama 等）
  - 导出通道：无 Key 也可下载数据包 + 提示词 `.md`，手动喂给任意 AI，返回的 JSON 通过设置页「导入 AI 计划」粘贴/上传即可入库（自动清洗围栏与解释文字）
  - 任务全部附带可点击的题目链接：练习任务直接跳题目页；回顾/模拟赛任务跳 CF 提交记录/题集入口；AI 输出缺链接时自动按题库回退补链
- **复习库**：题目复评与遗忘曲线调度（到期数量提醒、正/负反馈调节复习间隔）
- **模板库**：114 节内置算法模板课程（分 10 大类），学习状态/笔记/进度追踪；自建模板支持 Tab 缩进的代码编辑框（Tab 缩进、Shift+Tab 反缩进、回车自动缩进，保留撤销栈）
- **赛事中心**：Codeforces / AtCoder / 洛谷 / 牛客 四平台场次聚合（即将开始 / 已结束，单源失败自动降级），赛前选场、赛后补题
- **日历打卡**：月历查看每天训练任务、跳转做题链接、逐任务打卡；打卡数据与计划页联动；连续打卡统计
- **打卡提醒**：设置页配置每日提醒时间，应用打开期间到点若当天仍有未打卡任务，弹浏览器系统通知 + 页面内通知，点击直达日历
- **软件更新**：双通道检测（正式版 + GitHub 最新提交构建）+ 应用内一键自更新（详见下文）
- **Web 挂件**：`http://localhost:3001/widget` 零依赖单页（Express 直接服务），常驻小窗展示当天任务、连续打卡徽标，可直接打卡/跳转做题；透明置顶桌面挂件已按 Tauri 落地（widget.exe，见文末桌面挂件章节）

## 技术架构

```
icpc-workbench/
├── server/          # Node.js + Express + node:sqlite（内置 SQLite，零原生依赖）
│   ├── adapters/    # 平台适配器（CF/AtCoder 自动；洛谷/牛客受限）+ 增量同步
│   ├── analysis/    # 聚合统计 / 弱项画像 / 周趋势
│   ├── ai/          # OpenAI 兼容 provider + plan-prompt.md 提示词模板
│   ├── contests/    # 四平台赛事聚合（CF/AtCoder/洛谷/牛客，单源失败降级）
│   ├── plans/       # 计划生成（AI 优先，失败/未配置降级模板）+ 入库
│   ├── import/      # 手动导入（JSON/CSV/表单）+ 事务入库
│   ├── updater.ts   # 一键自更新（下载/SHA256 校验/原位替换）
│   └── routes/      # REST API（stats/problems/plans/reviews/today/templates/contests/checkins/settings/export/sync/import/update）
├── client/          # React + Vite + Ant Design（数据概览/今日训练/模板库/训练计划/复习库/题目管理/日历打卡/赛事中心/设置）
├── desktop/         # Tauri 桌面壳（app：主程序原生窗口 + Node 服务 sidecar；src-tauri：桌面挂件）
└── shared/          # 跨端共享类型与平台元信息
```

## 快速开始

要求：Node.js ≥ 22.5（使用内置 `node:sqlite`），npm。

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
- **提交通道**：tag 为 `nightly` 的预发布版——CI（`.github/workflows/nightly-desktop.yml`）在每次 push 到 master 时自动构建三件套并发布；应用对比构建时注入的 commit 与 nightly 的提交，未打 tag 的新提交也能感知
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

## 无 AI Key 用法（导出通道）

1. 「设置」→ 下载提示词 `.md`（或 `GET /api/export/plan-package` 取完整数据包）
2. 把内容粘贴给任意 AI，让其按模板输出 JSON 计划
3. 将返回的 JSON 通过「题目管理 → 逐条录入 / 上传文件」手动导入为计划

## 各平台接入状态

| 平台 | 自动同步 | 方式 | 说明 |
|------|---------|------|------|
| Codeforces | ✅ | 官方公开 API `user.status` | 无需登录；按新到旧分页，整页提交号已知即提前终止（增量） |
| AtCoder | ✅ | 社区 API `kenkoooo.com` v3 | 支持增量（from_second）；题目资源 24h 磁盘缓存；官方要求页间 ≥1s |
| 洛谷 | ✅（需 Cookie） | `record/list` 非官方 API | 设置页填写 `_uid` / `__client_id` 两项 Cookie 后自动同步；难度分级（0-8）自动映射为 CF rating；标签经 `x-lentille-request` 头 + `/_lfe/tags` 字典获取 |
| 牛客 | ✅ | 公开 HTML `acm/contest/profile/{uid}/practice-coding` | 无需登录/Cookie（牛客已下线 JSON API）；解析提交表格，支持增量与分页；题目无难度/标签字段（数据源限制） |

> 洛谷基于社区维护的非官方 API，接口结构可能随平台变更；若同步失败请更新 Cookie 重试。Cookie 仅保存在本机数据库，请勿外泄。

## Cookie 配置方法（仅洛谷需要）

1. 浏览器登录洛谷后，F12 → Application（应用）→ Cookies → `https://www.luogu.com.cn`
2. 复制 `_uid` 与 `__client_id` 两项的值，分别填入「设置 → 洛谷」的两个输入框后保存（请求用 Cookie 头由应用拼装，C3VK 等其余 Cookie 自动续期，无需填写）
3. 到「题目管理」→ 平台同步 → 输入用户名/uid → 同步
4. 换绑账号时，新同步会自动清空该平台旧账号的提交数据

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
GET  /api/problems                # 题目列表（platform/difficulty/tag/q 过滤）
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
GET  /api/contests                # 四平台赛事聚合（?type=upcoming|finished&platform=&limit=）
GET  /api/plans | POST /api/plans/generate | POST /api/plans/import | GET /api/plans/:id | DELETE /api/plans/:id
                                   # import body: { raw, startDate?, days? } ← 任意 AI 返回的计划 JSON 文本
PATCH /api/plans/tasks/:taskId    # 编辑单条任务（taskDate/title/kind/url/note，仅更新提交字段）
DELETE /api/plans/tasks/:taskId   # 删除单条任务（打卡记录级联删除）
GET  /api/checkins?month=YYYY-MM  # 月打卡视图
GET  /api/checkins/date/:date     # 当天任务（桌面挂件复用）
GET  /api/checkins/streak         # 连续打卡统计（current/longest/totalDays）
POST /api/checkins { taskId }     # 打卡 | DELETE /api/checkins/:taskId 取消
GET  /api/settings                # 设置（AI/账号/适配器开关/打卡提醒）
POST /api/settings/reminder       # 打卡提醒配置（body: enabled?, time? "HH:MM"）
POST /api/settings/cookies/check  # 检测 Cookie 登录态（洛谷：302/非 JSON 判定过期）
GET  /api/export/plan-package     # 数据包（弱项+趋势+题目+提示词）
GET  /api/export/plan-prompt.md   # 渲染好的提示词下载
GET  /api/update/check            # 更新检查（稳定版 + nightly 提交构建双通道）
GET  /api/update/progress         # 一键更新下载进度（phase/received/total）
POST /api/update/download         # 开始下载并 SHA256 校验 | POST /api/update/apply 原位替换
GET  /widget                      # Web 挂件单页（当天任务 + 打卡，桌面挂件同款 API）
```

## 桌面挂件扩展路线

桌面挂件已按 Tauri 方案落地（见文末「桌面挂件」章节）：打卡与任务 API 均按日期维度设计（`GET /api/checkins/date/:date`、`POST /api/checkins`），数据模型含 `plan_tasks.url` 跳转链接，加壳零改后端。

## 测试

```bash
npm test            # server 单元测试（schema/配置/适配器/导入/同步/分析/计划）
npm run typecheck   # 双端类型检查
```

测试覆盖：数据库 schema 与约束、配置校验、CF/AtCoder/牛客赛事适配器归一化（mock + 真实网络验证）、CSV 解析、导入去重、增量同步、统计/弱项/趋势与手工计算一致性、AI 生成三路径（成功/失败/未配置）、更新双通道判定与 SHA256 校验解析。

## 桌面挂件（widget.exe）

透明无边框置顶小窗，常驻桌面展示当天任务，可拖动、点击穿透、托盘管理。独立于主程序分发。

### 构建

```bash
cd desktop/src-tauri && cargo tauri build   # 产物 widget.exe（约 3-8MB）
```

### 使用

- 与 `icpc-workbench.exe` 放同一文件夹：双击主 exe 时自动拉起挂件（可在 `config.json` 设 `"launchWidget": false` 关闭）。
- 单独运行 widget.exe：自动扫描 3001–3020 找主服务；找不到显示 offline 提示，可一键拉起主程序。

### 验收清单

- [ ] 透明小窗显示当天任务，可拖动，重启后位置保持
- [ ] 托盘「显示/隐藏」「切换点击穿透」「开机自启」「退出」
- [ ] 穿透开启后鼠标穿过挂件；60s 自动恢复交互
- [ ] 关窗隐藏到托盘，进程不退出
- [ ] 主服务关闭 → 约 20s 切 offline；重启服务 → 约 10s 自动恢复
- [ ] offline 页「启动主程序」按钮可拉起主 exe
- [ ] 主 exe 同目录有 widget.exe 时自动拉起；反复重启主程序只有一份挂件
- [ ] `launchWidget: false` 时不自动拉起；主 exe 单独存在时正常使用

## 许可证

本项目代码以 [MIT License](./LICENSE) 发布。
第三方依赖及其许可证见 [CREDITS.md](./CREDITS.md)；安全问题请通过 [SECURITY.md](./SECURITY.md) 的私密渠道报告，勿公开发 Issue。
