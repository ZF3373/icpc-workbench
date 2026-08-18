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
| 集成分发 | 独立 widget.exe，与主 exe 独立发布；典型用法两者同目录 |
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
        │   ├── main.rs     # 入口：装配托盘/窗口、启动发现与守护
        │   ├── discovery.rs# 端口扫描与实例验证
        │   ├── watcher.rs  # 周期健康检查，掉线/恢复切换页面
        │   ├── lifecycle.rs# 拉起主 exe、退出清理
        │   └── state.rs    # widget.json 读写（位置/穿透/置顶/隐藏/自启）
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
  `{ x, y, clickThrough, hidden }`（置顶为固定行为，不做成可配置）。损坏/缺失时静默用默认值，
  下次成功写入时覆盖修复。开机自启状态由 Tauri autostart 插件自管，不入此文件。

### 对主仓的改动（刻意最小）

1. `server/src/public/widget.html`：文件末尾追加约 20 行「桌面模式」脚本——
   检测到 Tauri 环境（`window.__TAURI_INTERNALS__`）时：header 加 `data-tauri-drag-region`
   启用原生拖动；显示穿透切换小按钮（仅桌面模式显示，调 Tauri command）。浏览器中零副作用。
2. README 增补桌面挂件章节（构建、使用、验收清单）。

REST API 零改动。

## 窗口行为

- **窗口**：340×520，无边框、透明（`transparent: true`，wry 将 WebView2
  `DefaultBackgroundColor` 置透明）、置顶（`always_on_top`）。现有 widget.html 的
  `html, body` 本就是透明背景，页面无需样式改动。
- **拖动**：header 区域为拖动把手（`data-tauri-drag-region`）。窗口移动结束时把 `(x, y)`
  写入 widget.json；下次启动恢复位置。首次启动放工作区右下角（留 20px 边距）。
- **点击穿透**：`set_ignore_cursor_events(true, { forward: true })`（Windows 支持
  forward：滚轮/点击穿透，鼠标移动事件仍转发 WebView）。完整交互回路：
  1. 用户从托盘菜单或面板按钮开启穿透 → 窗口整体进入穿透态（鼠标可穿过挂件操作桌面）；
  2. 穿透态下鼠标移入 header 区域（forward 转发的 mousemove 触发前端监听）→
     前端调 Tauri command `set_click_through(false)` **自动恢复交互**；
  3. 恢复交互后，用户可再点穿透按钮/托盘菜单重新进入穿透态。
  即「开启穿透靠用户，退出穿透靠移入 header 自动恢复」，不存在穿透后无法找回的死角。
- **托盘**：右键菜单：「显示/隐藏挂件」「点击穿透 开/关」」「开机自启 开/关」「退出」。
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
- **手动验收清单**（写入 README）：透明效果、拖动+位置记忆、穿透切换与回恢复、
  托盘全菜单、掉线→offline→自动恢复、开机自启、同目录/不同目录两种摆放。

## 风险与兜底

| 风险 | 概率 | 兜底 |
| --- | --- | --- |
| WebView2 透明对外部 URL 不生效 | 低 | `/widget` 路由支持 `?desktop=1` 返回显式透明背景页（主仓一行改动） |
| 远程页（127.0.0.1:3001..3020）调用 Tauri command 需逐源授权，且端口会顺延 | 中 | tauri.conf.json `dangerousRemoteDomainIpcAccess` 按端口生成 20 条授权（构建时脚本/代码生成）；若端口级匹配不可行，改为 Rust 侧 initialization_script 注入交互脚本走 wry 原生 ipc 通道（不经过 Tauri 权限层） |
| forward 穿透在部分 WebView2 版本行为差异 | 中 | header 恢复交互兜底：托盘菜单「点击穿透」随时可关；穿透开启时启动 30s 自动恢复交互的保底定时器 |
| 用户把 widget.exe 放在非同目录 | 高（预期内） | 拉起按钮置灰并提示摆放位置，其余功能不受影响 |

## 成功标准

1. 双击 widget.exe（主程序已运行）→ 透明小窗出现在右下角，可拖动、重启后位置保持。
2. 主程序关闭 → 10~20s 内挂件切到 offline 提示页；点「启动主程序」→ 服务起来后自动恢复任务列表。
3. 穿透开启后鼠标可穿过挂件操作桌面；移入 header 区域可重新交互并关闭穿透。
4. 托盘可显示/隐藏、开关自启、退出；关闭窗口不杀进程。
5. 主仓 `npm test`、`npm run typecheck` 与 `cargo test` 全绿。
