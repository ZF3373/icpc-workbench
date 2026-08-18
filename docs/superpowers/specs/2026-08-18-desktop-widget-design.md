# 桌面挂件（Desktop Widget）框架设计

日期：2026-08-18
状态：已与用户逐节确认（总体架构 / 窗口行为 / 构建测试分发 均获通过）

## 背景与目标

ICPC Workbench 已有 Web 挂件页 `http://localhost:{port}/widget`（Express 直接服务的零依赖单页，
展示当天任务、连续打卡徽标、一键打卡，60s 轮询）。本设计为其补一个 **Tauri 桌面壳**，
做成透明、无边框、可置顶、可拖动、可点击穿透的常驻桌面小窗，以独立小 exe 分发。

已确认的关键决策：

| 决策点 | 结论 |
| --- | --- |
| 组件形态 | 桌面挂件小窗（非整个应用桌面化） |
| 技术选型 | Tauri v2（系统 WebView2，小体积、低内存） |
| 集成分发 | 独立 widget.exe，与主 exe 独立发布；典型用法两者同目录。主 exe（SEA 模式）启动后自动拉起同目录 widget.exe，找不到时静默跳过 |
| 承载方案 | 远程 URL 直载：窗口直接加载主服务的 `/widget` 页，Rust 侧做服务发现 |
| 第一版能力 | 透明无边框置顶 + 拖动位置记忆；点击穿透切换；托盘（退出/自启）；掉线检测 + 拉起主程序 |

明确不做（YAGNI）：挂件自身版本更新通道、多挂件/多尺寸、非 Windows 平台适配、
把整个工作台桌面化。

## 总体架构

```
icpc-workbench/
├── server/ …               # 主仓不动（除 widget.html 注入一小段桌面模式脚本）
└── desktop/                # 新增：独立 Tauri v2 工程（cargo，不进 npm workspaces）
    ├── ui/
    │   └── offline.html    # 兜底页：主服务未运行时的提示 + 「启动主程序」按钮
    └── src-tauri/
        ├── src/
        │   ├── main.rs     # 入口：装配托盘/窗口、single-instance 防重复、启动发现与守护
        │   ├── discovery.rs# 端口扫描与实例验证
        │   ├── watcher.rs  # 周期健康检查，掉线/恢复切换页面
        │   ├── lifecycle.rs# 拉起主 exe、退出清理
        │   └── state.rs    # widget.json 读写（位置/隐藏）
        └── tauri.conf.json
```

数据流：

```
widget.exe 启动
  → discovery 并行探测 127.0.0.1:3001..3020 的 /api/health
      命中（{ok:true, platforms:[…]}，与 sea.ts isOurInstance 同一判据）
        → 建窗加载 http://127.0.0.1:{port}/widget
      全部未命中
        → 建窗加载本地 ui/offline.html
  → watcher 每 10s 探测当前端口
      掉线 → webview.navigate(offline.html)
      恢复 → navigate(http://127.0.0.1:{port}/widget)
  → 用户交互（拖动/穿透/托盘/打卡）经 Tauri command 或直接 HTTP 打到主服务
```

### 模块职责

- **discovery.rs**：`find_server() -> Option<(port, health)>`。并行 GET 各端口
  `/api/health`（单请求超时 300ms），校验 JSON 结构后返回端口。扫描结果缓存最近命中端口，
  watcher 优先复用；失效再全量扫。
- **watcher.rs**：持有当前服务端口，10s 周期探测；状态变化时通过窗口事件通知前端 + 切换
  webview URL。防抖：连续 2 次失败才判掉线，避免单次超时误切。
- **lifecycle.rs**：`launch_main_app()` spawn 同目录 `icpc-workbench.exe`
  （`detached + windowsHide`，不等待、不持有句柄）；同目录找不到 exe 时返回错误原因给前端。
  主 exe 自带防重复启动，重复拉起无害。
- **state.rs**：持久化到 widget.exe 旁 `widget.json`。字段：
  `{ x, y, hidden }`（置顶为固定行为；穿透为会话级状态、重启即交互态，均不入文件）。
  损坏/缺失时静默用默认值，下次成功写入时覆盖修复。开机自启状态由 Tauri autostart
  插件自管，不入此文件。

### 对主仓的改动（刻意最小）

1. `server/src/public/widget.html`：文件末尾追加约 15 行「桌面模式」脚本——
   检测到 Tauri 环境（`window.__TAURI_INTERNALS__`）时给 header 元素加
   `data-tauri-drag-region` 属性启用原生拖动。浏览器中零副作用。
   （穿透不设面板按钮，见「窗口行为」。）
2. `server/src/sea.ts`：`bootSea` 成功监听端口后，若 `config.launchWidget !== false` 且同目录
   存在 `widget.exe`，则 spawn 拉起（`detached + stdio:ignore + windowsHide + unref`），
   找不到或 spawn 失败一律静默跳过（独立分发语义：主 exe 单独可用，挂件是可选增强）。
   仅 SEA 模式拉起；dev 模式不拉起（开发者自行 `cargo tauri dev`）。
   挂件为 detached 进程，不随主程序退出而退出——主程序关闭后挂件转 offline 页，
   用户可从挂件一键重启主程序（与掉线检测设计闭环）。
3. `server/src/config.ts`：`AppConfig` 增加 `launchWidget: boolean`（默认 `true`），
   `config.example.json` 同步补字段；不进 DB 设置页。
4. README 增补桌面挂件章节（构建、使用、验收清单、自动拉起行为与关闭方法）。

REST API 零改动。

## 窗口行为

- **窗口**：340×520，无边框、透明（`transparent: true`，wry 将 WebView2
  `DefaultBackgroundColor` 置透明）、置顶（`always_on_top`）。现有 widget.html 的
  `html, body` 本就是透明背景，页面无需样式改动。
- **拖动**：header 区域为拖动把手（`data-tauri-drag-region`）。窗口移动结束时把 `(x, y)`
  写入 widget.json；下次启动恢复位置。首次启动放工作区右下角（留 20px 边距）。
- **点击穿透**：Tauri v2 `set_ignore_cursor_events(true)`（Windows 底层即 WebView2
  透明命中测试，穿透期间 WebView 收不到任何鼠标事件，**没有 forward 转发**——那是
  Electron 的 `setIgnoreMouseEvents({forward})` 特性）。因此穿透的退出不能依赖前端事件：
  **开启与退出都走托盘菜单「切换点击穿透」**（穿透态下窗口收不到点击，前端无从恢复；
  托盘是系统级入口不受穿透影响）。不设面板按钮——远程页调用自定义 command 需要逐源
  ACL 授权（3001–3020 二十条）且是 v2 中变动较多的区域，v1 不值得为此冒险；拖动所需的
  `core:window:allow-start-dragging` 是单一稳定权限，经 capability 的 `remote.urls`
  授予即可。保底：穿透开启 60s 后自动恢复交互（防用户找不到出口）；穿透态不持久化，
  重启挂件一律回到可交互态。即：不存在穿透后无法找回的死角。
- **托盘**：右键菜单：「显示/隐藏挂件」「切换点击穿透」「开机自启 开/关」「退出」。
  关闭窗口 ≠ 退出：隐藏到托盘，托盘单击恢复显示；`hidden` 状态入 widget.json。
  真正退出仅托盘菜单「退出」。
- **offline.html**：与 widget.html 同视觉风格的卡片：“主程序未运行”说明 +
  「启动主程序」按钮（Tauri command `launch_main_app`）+ 扫描动画。watcher 恢复检测后
  自动切回远程页。

## 错误处理

- 端口探测：单请求 300ms 超时、并行发出；全量扫描最坏 ~数百毫秒，不阻塞建窗（先建窗显示
  offline/加载态，发现服务后再导航）。
- watcher 误判防护：连续 2 次失败才切 offline；恢复 1 次成功即切回。
- 拉起失败：offline 页按钮下方红字显示具体原因（找不到 exe / spawn 失败）。
- widget.json 损坏：静默用默认值；下次写入覆盖修复。
- 主服务换端口（3001 被占顺延）：watcher 失效后 discovery 全量重扫，自动跟上。

## 构建、测试与分发

- **开发**：`desktop/` 下 `cargo tauri dev`；主仓照常 `npm run dev`。
- **发布**：`cargo tauri build` 产出单 `widget.exe`（预计 3–8MB；WebView2 为
  Win10/11 常见内置，缺失时启动引导用户安装 WebView2 Runtime）。
  主仓 `server/scripts/build-exe.mjs` 不动，两者独立发布。
- **Rust 单元测试**（`cargo test`）：
  - discovery：本地起假 `/api/health` 服务器（含 ok / 非 ok / 不响应三种）验证判据；
  - state：默认值、往返读写、损坏 JSON 容错；
  - lifecycle：同目录 exe 路径解析（存在/缺失）。
- **主仓测试**：`server/test/widget.test.ts` 追加断言——widget.html 含桌面模式注入脚本
  与 `data-tauri-drag-region` 逻辑，且不影响现有断言。
- **手动验收清单**（写入 README）：透明效果、拖动+位置记忆、穿透开关（托盘）与 60s 自动恢复、
  托盘全菜单、掉线→offline→自动恢复、开机自启、同目录/不同目录两种摆放。

## 风险与兜底

| 风险 | 概率 | 兜底 |
| --- | --- | --- |
| WebView2 透明对外部 URL 不生效 | 低 | `/widget` 路由支持 `?desktop=1` 返回显式透明背景页（主仓一行改动） |
| 远程页（127.0.0.1:3001..3020）调用 Tauri command 需逐源授权，且端口会顺延 | 中 | tauri.conf.json `dangerousRemoteDomainIpcAccess` 按端口生成 20 条授权（构建时脚本/代码生成）；若端口级匹配不可行，改为 Rust 侧 initialization_script 注入交互脚本走 wry 原生 ipc 通道（不经过 Tauri 权限层） |
| forward 穿透在部分 WebView2 版本行为差异 | 中（已消除） | 设计已改为「托盘退出 + 60s 自动恢复 + 重启不继承穿透」，不依赖 forward |
| 用户把 widget.exe 放在非同目录 | 高（预期内） | 拉起按钮置灰并提示摆放位置，其余功能不受影响；主 exe 自动拉起在此场景静默跳过 |
| 主程序反复重启导致重复孵化挂件 | 中 | widget.exe 使用 Tauri single-instance 插件，二次拉起仅聚焦既有窗口 |

## 成功标准

1. 双击 widget.exe（主程序已运行）→ 透明小窗出现在右下角，可拖动、重启后位置保持。
2. 主程序关闭 → 10~20s 内挂件切到 offline 提示页；点「启动主程序」→ 服务起来后自动恢复任务列表。
3. 穿透开启后鼠标可穿过挂件操作桌面；托盘「切换点击穿透」可退出；60s 未退出自动恢复交互。
4. 托盘可显示/隐藏、开关自启、退出；关闭窗口不杀进程。
5. 主仓 `npm test`、`npm run typecheck` 与 `cargo test` 全绿。
6. 双击主 exe（同目录有 widget.exe）→ 挂件自动出现；反复重启主程序只有一份挂件；
   `config.json` 设 `launchWidget: false` 后不再自动拉起；主 exe 单独存在时正常使用。
