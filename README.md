# ICPC Workbench · ICPC 备赛工作台

基于刷题记录（Codeforces / AtCoder / 洛谷 / 牛客）分析弱项、由 AI 生成个性化训练计划，并提供日历打卡的**本地 Web 应用**。

## 功能

- **多平台刷题导入**：Codeforces / AtCoder 自动同步（官方/社区公开 API，增量去重）；洛谷 / 牛客手动导入（JSON / CSV / 表单）
- **弱项分析**：按标签 / 难度区间 / 平台统计 AC 率，输出相对自身平均的弱项画像；近 12 周趋势
- **AI 训练计划（双通道）**：
  - 内置生成：配置 OpenAI 兼容 API Key 一键生成（DeepSeek / OpenAI / 智谱 / Ollama 等）
  - 导出通道：无 Key 也可下载数据包 + 提示词 `.md`，手动喂给任意 AI
- **日历打卡**：月历查看每天训练任务、跳转做题链接、逐任务打卡；打卡数据与计划页联动
- 桌面透明挂件为**后续扩展**：打卡/任务 API 均为纯 JSON 且按日期维度设计，未来接 Electron/Tauri 挂件无需改后端

## 技术架构

```
icpc-workbench/
├── server/          # Node.js + Express + node:sqlite（内置 SQLite，零原生依赖）
│   ├── adapters/    # 平台适配器（CF/AtCoder 自动；洛谷/牛客受限）+ 增量同步
│   ├── analysis/    # 聚合统计 / 弱项画像 / 周趋势
│   ├── ai/          # OpenAI 兼容 provider + plan-prompt.md 提示词模板
│   ├── plans/       # 计划生成（AI 优先，失败/未配置降级模板）+ 入库
│   ├── import/      # 手动导入（JSON/CSV/表单）+ 事务入库
│   └── routes/      # REST API（stats/problems/plans/checkins/settings/export/sync/import）
├── client/          # React + Vite + Ant Design（仪表盘/题目/计划/日历/设置）
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
| Codeforces | ✅ | 官方公开 API `user.status` | 无需登录；全量拉取最近提交，按提交号去重 |
| AtCoder | ✅ | 社区 API `kenkoooo.com` v3 | 支持增量（from_second）；题目资源 24h 磁盘缓存；官方要求页间 ≥1s |
| 洛谷 | ✅（需 Cookie） | `record/list` 非官方 API | 设置页填写登录 Cookie（+CSRF）后自动同步；未配置/失效时明确提示并引导手动导入 |
| 牛客 | ✅ | 公开 HTML `acm/contest/profile/{uid}/practice-coding` | 无需登录/Cookie（牛客已下线 JSON API）；解析提交表格，支持增量与分页 |

> 洛谷基于社区维护的非官方 API，接口结构可能随平台变更；若同步失败请更新 Cookie 重试。Cookie 仅保存在本机数据库，请勿外泄。

## Cookie 配置方法（仅洛谷需要）

1. 浏览器登录洛谷后，F12 → Network → 任选一个请求 → 复制 `Cookie` 请求头
2. 「设置」→ 洛谷 → 粘贴 Cookie 保存；可一并填写 `x-csrf-token`（可选）
3. 到「题目管理」→ 平台同步 → 输入用户名/uid → 同步
4. 换绑账号时，新同步会自动清空该平台旧账号的提交数据

## API 一览

```
GET  /api/health
POST /api/sync/:platform          # 同步平台账号（body: handle）
POST /api/import/manual           # 手动导入（body: platform, rows[]）
POST /api/import/csv              # CSV 导入（body: platform, csv）
GET  /api/stats                   # 总体统计（from/to/platform 过滤）
GET  /api/stats/weakness          # 弱项画像（minAttempts/topN）
GET  /api/stats/trend             # 周趋势（weeks）
GET  /api/problems                # 题目列表（platform/difficulty/tag/q 过滤）
GET  /api/plans | POST /api/plans/generate | GET /api/plans/:id
GET  /api/checkins?month=YYYY-MM  # 月打卡视图
GET  /api/checkins/date/:date     # 当天任务（桌面挂件复用）
POST /api/checkins { taskId }     # 打卡 | DELETE /api/checkins/:taskId 取消
GET  /api/settings                # 设置（AI/账号/适配器开关）
GET  /api/export/plan-package     # 数据包（弱项+趋势+题目+提示词）
GET  /api/export/plan-prompt.md   # 渲染好的提示词下载
```

## 桌面挂件扩展路线

打卡与任务 API 已按日期维度设计（`GET /api/checkins/date/:date`、`POST /api/checkins`），数据模型含 `plan_tasks.url` 跳转链接。未来实现透明置顶桌面挂件：

1. **Electron**（Node 生态现成，复用现有栈）：无边框透明窗口 + `alwaysOnTop`，轮询 `/api/checkins/date/今天` 展示当天任务，点击打开链接、打卡
2. **Tauri**（更轻，需 Rust 工具链）：同样的纯 JSON API，仅换外壳

## 测试

```bash
npm test            # server 单元测试（schema/配置/适配器/导入/同步/分析/计划）
npm run typecheck   # 双端类型检查
```

测试覆盖：数据库 schema 与约束、配置校验、CF/AtCoder 适配器归一化（mock + 真实网络验证）、CSV 解析、导入去重、增量同步、统计/弱项/趋势与手工计算一致性、AI 生成三路径（成功/失败/未配置）。
