# QOJ 同步修复：macOS 桌面版与 Docker / 网页版（issue #63）

issue #63：「MacOS 桌面版打开内置浏览器一直卡在 cf 验证循环，docker 版输入 cookie 信息和
User-Agent 也无法同步」。两条反馈是**两个不同的故障**，都已定位到根因。

## 一、macOS 卡在 Cloudflare 验证循环

根因有三处，全部在桌面壳（`desktop/app/src-tauri/src/shell_auth.rs`），Windows 一路没暴露：

1. **UA 与引擎自相矛盾（主因）**。`WEBVIEW_UA` 是无条件写死的
   `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/131`。Windows 壳跑 WebView2（Chromium），
   这么说没问题；macOS 壳跑的是 WKWebView（Safari/WebKit 引擎），它发不出 Chrome 的
   `Sec-CH-UA` 客户端提示头，Cloudflare 把 UA 与 CH 一对就判定异常，托管挑战因此永远不放行
   —— 用户看到的就是「一直卡在 cf 验证循环」。
   改为按平台取：Windows 仍是 Chrome/131，macOS 说真话（Safari 17 + Macintosh），
   Linux 构建说 X11/Chrome。适配器侧的回退 UA 保持原样（那是 Node 直连路径用的，互不影响）。

2. **页面里跨源 fetch 被 WebKit 的混合内容策略拦死**。守护脚本在 https://qoj.ac 页面里
   `fetch('http://127.0.0.1:PORT/api/qoj-agent/next')`。Chromium 把 127.0.0.1 当「本地回环
   豁免」直接放行；WebKit **不豁免**（WebKit bug 171934，2017 年提出、至今仍是 NEW），
   请求直接被 Mixed Content 拦下 —— 于是代理永远「未就绪」。
   改法：macOS 不再让页面自己轮询。新增 `spawn_agent_driver`（每平台一条常驻任务）：
   壳用 reqwest 打本服务的 `/next` 与 `/result`（不经 WebKit），只有「抓目标页」这一跳
   仍留在页面里 —— 用 `eval` 调注入的 `__icpcGrabRun`，那才是唯一能带上真实 TLS 指纹与
   登录态的上下文。`/next`、`/result` 的语义完全没变，适配器与解析层零改动。

3. **隐藏窗口 + eval 的时机**。macOS 上 `visible(false)` 的 WKWebView 会被 WebKit 判为不可见，
   进而降频甚至挂起定时器；`eval` 出去的脚本也不跨文档存活（WebView2 会重注入，WKWebView 不会）。
   改为「可见但移出屏幕」（`position(20_000, 20_000)` + `background_throttling(Disabled)`，
   macOS 14+ 生效），并用 `initialization_script` 在每个文档一开始就注入抓取函数，
   再由驱动任务按需补注入。

另外：macOS 上助手窗以前只靠 20 分钟一次的保活来创建，用户「一开软件就同步」必然白等。
驱动任务发现窗口不存在时会主动拉起（幂等，走同一条 `renew_agent` 路径）。

## 二、Docker / 网页版填了 Cookie 与 UA 也同步不了

根因：`adapters/qoj.ts` 只要有 `pageTransport` 就**只走** WebView 代理，代理不在线
（Docker / 网页版根本没有壳，桌面版窗口被关掉也一样）就直接抛「助手窗口未就绪」，
用户在卡片里填的 Cookie 与 UA 一条都没用上。

改法：

- `adapters/qojAgent.ts` 新增 `AgentUnavailableError`（带 `reason: 'not-ready' | 'timeout'`），
  把「通道不可用」与「代理抓回一个失败响应」区分开。
- `adapters/qoj.ts`：代理抛 `AgentUnavailableError` **且用户确实填了 Cookie** 时，回退到
  Cookie + UA 直连路径（HTTP/1.1 传输层，与改造前的 legacy 路径同一套代码，抽成
  `fetchSubmissionsPageDirect`）。没填 Cookie 时保留代理那条更可操作的提示，不盲目回退。
- 助手窗口回 `status = 0`（没能在预算内抓回页面）时给出一句「可能还在过验证/窗口刚刷新，
  稍后重试」的可读提示，而不是把它当成账号问题。

需要说清楚的局限：qoj.ac 的 Cloudflare 把 `cf_clearance` 绑到签发客户端的 TLS 指纹，
Node（OpenSSL）重放**经常**被拦。所以这条回退是「Docker / 网页版至少还有一条路」，
不是保证能过 —— 过不了会走既有的挑战判定，提示用户整段复制 Cookie 并填 UA。
桌面版仍优先走 WebView 同源代理（指纹与登录态都是浏览器本尊）。

## 三、设置页文案

QOJ 那段提示原来只讲桌面版和网页版，没讲 Docker。现在明确列出网页版 / Docker 的三件套
（`__Host-UOJSESSID`、`cf_clearance`、User-Agent 都要有，缺 UA 同样判凭据无效），
并提示填好后点「检测凭据」验证。

## 验证

- `server/test/qoj-agent.test.ts` 新增 3 项：代理不在线抛类型化错误；有 Cookie 时回退直连
  且确实带上用户 Cookie；没填 Cookie 时保留助手窗口提示不回退。该文件 17 项全通过。
- `server/test/qoj.test.ts` + `qoj-session-cookie.test.ts` 32 项全通过（解析、判定、
  整段 Cookie 透传、挑战引导等既有行为未被改动）。
- `npm run typecheck`（server + client）与 `npm run lint` 通过。
- 桌面壳：`cargo check` 在 Windows 工具链下通过；macOS 分支用同一份源码做了
  cfg 置换后的编译检查（`not(windows)` 分支全部计入），无错误无告警。
  **真机验证仍需 macOS**：验证点是「设置页点『在应用内登录 QOJ』→ 窗口不再反复刷 CF
  验证页 → 同步能拉到提交列表」。签名与打包流程未改动。
