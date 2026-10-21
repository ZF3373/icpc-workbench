//! 桌面壳凭据自动化：内嵌 WebView 登录抓取 + QOJ 凭据保活。
//!
//! 两条能力：
//! 1. **登录抓取（全 Cookie 平台）**：前端请求后弹出该平台的可见 WebView 窗口，
//!    用户像在普通浏览器里一样输账号密码登录；壳轮询 Cookie store，取齐该平台的
//!    凭据字段后推回核心（写账号槽位或平台级），用户从此不必 F12 手工复制。
//! 2. **QOJ 保活**：cf_clearance 有效期 = 站点 Cloudflare「Challenge Passage」
//!    （默认 30 分钟，客户端无法延长）。普通浏览器无感是因为过期后下一次导航会
//!    静默重过盾；Node 同步请求没有 JS 环境，只会收到 403 挑战页。故额外维护一个
//!    隐藏 WebView 每 20 分钟访问 qoj.ac 静默续签，再把新凭据推回核心。
//!    其余平台的会话 Cookie 均为长效，登录一次即可，无续签语义。
//!
//! 通道：**不走 Tauri IPC**——远程页面（http://127.0.0.1:port）的 IPC 在 WebView2
//! 上被 ACL 判为不可匹配 origin，remote capability 放行不了（见 widget 壳
//! capabilities/remote-drag.json 的实测结论）。因此以核心为中介：
//!
//! ```text
//! 前端设置页 --POST /api/settings/shell-auth/request--> 核心（action+platform+handle）
//! 本壳(3s轮询) --GET  /api/settings/shell-auth/pending--> 核心   （pop 语义）
//! 本壳 --开窗/读 Cookie --POST /api/settings/cookies--> 核心    （推送新凭据）
//! 本壳 --POST /api/settings/shell-auth/status----------> 核心    （结果/心跳）
//! 前端 --GET  /api/settings/shell-auth/status----------> 核心    （按 id 轮询结果）
//! ```
//!
//! 线程模型：窗口创建走 run_on_main_thread（跨线程建窗的平台兼容做法）；
//! `cookies_for_url` 文档明确警告在主线程同步上下文会死锁（WebView2 issue），
//! 所以读 Cookie 一律在本任务的 tokio 工作线程直接调用。

use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::PortState;

/// 登录窗口统一 UA（显式指定而非读运行时真实值）：QOJ 的 cf_clearance 与签发它的
/// UA 逐字节绑定，请求端（Node 适配器）复刻同一串，两端必然一致。与 qoj.ts 适配器
/// 内置回退 UA 同款（Chrome/131），已是实测可过盾的取值；其余平台无 UA 绑定问题，
/// 但统一的正常浏览器 UA 也能避免各站对异常 UA 的风控。
const WEBVIEW_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// 单平台的登录抓取规格。字段表与 shared/src/credentials.ts COOKIE_FIELDS 同口径：
/// （cookie 名 → cookieFields 的字段 key），同 key 多个 cookie 名 = 新旧名兼容（取先到）。
struct LoginSpec {
    platform: &'static str,
    url: &'static str,
    title: &'static str,
    fields: &'static [(&'static str, &'static str)],
    /// 凭据与浏览器 UA 绑定（QOJ）
    ua: bool,
    /// WebView 同源代理平台（QOJ）：站点 Cloudflare 把 cf_clearance 绑定到签发客户端的
    /// TLS 指纹，抓到的 Cookie 在 Node 侧重放必被拦（2026-10-11 实测）。这类平台不再
    /// 「抓 Cookie 推回」，而是注入守护脚本让 WebView 自己同源抓取提交页（qojAgent）。
    agent: bool,
}

const LOGIN_SPECS: &[LoginSpec] = &[
    LoginSpec {
        platform: "qoj",
        url: "https://qoj.ac/",
        title: "QOJ 登录 · 登录后同步自动经本窗口完成（可随手关闭）",
        fields: &[("__Host-UOJSESSID", "uojsessid"), ("UOJSESSID", "uojsessid"), ("cf_clearance", "clearance")],
        ua: true,
        agent: true,
    },
    LoginSpec {
        platform: "luogu",
        url: "https://www.luogu.com.cn/",
        title: "洛谷登录 · 登录后 Cookie 自动保存（可随手关闭）",
        fields: &[("_uid", "uid"), ("__client_id", "clientId")],
        ua: false,
        agent: false,
    },
    LoginSpec {
        platform: "daimayuan",
        url: "https://bs.daimayuan.top/",
        title: "代码源登录 · 登录后 Cookie 自动保存（可随手关闭）",
        fields: &[("sid", "sid")],
        ua: false,
        agent: false,
    },
    LoginSpec {
        platform: "leetcode",
        url: "https://leetcode.cn/",
        title: "LeetCode 登录 · 登录后 Cookie 自动保存（可随手关闭）",
        fields: &[("LEETCODE_SESSION", "session"), ("csrftoken", "csrftoken")],
        ua: false,
        agent: false,
    },
    LoginSpec {
        platform: "jisuanke",
        url: "https://www.jisuanke.com/",
        title: "计蒜客登录 · 登录后 Cookie 自动保存（可随手关闭）",
        fields: &[("s", "s"), ("JSKUSS", "jskuss")],
        ua: false,
        agent: false,
    },
    LoginSpec {
        platform: "atcoder",
        url: "https://atcoder.jp/",
        title: "AtCoder 登录 · 登录后 Cookie 自动保存（可随手关闭）",
        fields: &[("REVEL_SESSION", "revelSession")],
        ua: false,
        agent: false,
    },
];

fn spec_of(platform: &str) -> Option<&'static LoginSpec> {
    LOGIN_SPECS.iter().find(|s| s.platform == platform)
}

/// 隐藏保活窗（QOJ 专用：其余平台凭据长效，无续签语义）
const WORKER_LABEL: &str = "qoj-worker";

/// QOJ 守护脚本：注入到 qoj.ac 页面上下文（与页面同源 → 同源 fetch 自动携带完美客户端
/// 指纹与真实登录态，Cloudflare 无法区分）。自轮询领任务 → 同源抓取 → 回传。
/// 幂等（window 标记）；导航换文档后由壳的下一次注入重建。__PORT__ 由注入时替换为核心端口。
const AGENT_DAEMON_SCRIPT: &str = r#"(function () {
  if (window.__icpcAgent) return;
  window.__icpcAgent = true;
  // GPU 节能：隐藏窗里对 body 挂 content-visibility + contain，降低不可见区域的绘制压力
  try {
    var s = document.createElement('style');
    s.textContent = 'body { contain: layout paint; content-visibility: auto; }';
    document.head.appendChild(s);
  } catch (e0) { /* 旧版 WebView2 不支持 content-visibility，忽略 */ }
  (async function () {
    var PORT = "__PORT__";
    for (;;) {
      try {
        var r = await fetch('http://127.0.0.1:' + PORT + '/api/qoj-agent/next');
        var j = await r.json();
        if (j && j.job) {
          var res = await fetch(j.job.url, { credentials: 'include' });
          var body = await res.text();
          await fetch('http://127.0.0.1:' + PORT + '/api/qoj-agent/result', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: j.job.id, status: res.status, finalUrl: res.url, body: body })
          });
        } else {
          await new Promise(function (r2) { setTimeout(r2, 4000); });
        }
      } catch (e) {
        await new Promise(function (r2) { setTimeout(r2, 5000); });
      }
    }
  })();
})();
"#;

/// 主循环轮询间隔（pending 请求的响应延迟上界）
const POLL_TICK: Duration = Duration::from_secs(3);
/// 在线心跳间隔（核心侧 3 分钟没心跳即判壳离线，见 routes/shellAuth.ts）
const HEARTBEAT_EVERY: Duration = Duration::from_secs(60);
/// QOJ 保活间隔：cf_clearance 30 分钟过期，20 分钟一续保证永远比有效期新
const KEEPALIVE_EVERY: Duration = Duration::from_secs(20 * 60);
/// 首次保活延迟：核心 2-5 秒就绪，15 秒即拉起 QOJ 助手窗口——首屏自动凭据检测
/// 依赖代理在线（fetchPageViaAgent 会等它最多 20 秒），起得太晚首屏检测就会撞空窗
const FIRST_KEEPALIVE_DELAY: Duration = Duration::from_secs(15);
/// 静默续签的等待窗口：非交互挑战通常几秒内完成，30s 已足够宽松
const PULL_WAIT: Duration = Duration::from_secs(30);
/// 登录窗观察窗口：等用户完成（可能的）人机验证 + 登录
const LOGIN_WATCH: Duration = Duration::from_secs(10 * 60);
/// QOJ 保活连续失败 N 次后弹出可见登录窗请人工过盾（挑战可能是交互式的）
const KEEPALIVE_FAIL_SHOW: u32 = 2;

/// 抓到的凭据：字段 key → 裸值（key 按 LoginSpec.fields 归并，取先到的非空值）
type Creds = Vec<(String, String)>;

/// 启动保活任务（setup 里调用一次）
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run(app).await;
    });
}

async fn run(app: AppHandle) {
    crate::logln("[shell-auth] 凭据任务启动");
    let mut last_heartbeat = tokio::time::Instant::now() - HEARTBEAT_EVERY; // 启动即发一跳
    let mut last_keepalive = tokio::time::Instant::now() - KEEPALIVE_EVERY + FIRST_KEEPALIVE_DELAY;
    let mut keepalive_fails: u32 = 0;
    loop {
        tokio::time::sleep(POLL_TICK).await;
        let Some(port) = current_port(&app) else { continue };

        // 心跳：前端设置页用它判定「桌面壳在线」，决定展示一键登录还是手动粘贴引导
        if last_heartbeat.elapsed() >= HEARTBEAT_EVERY {
            last_heartbeat = tokio::time::Instant::now();
            post_status(port, &json!({ "kind": "heartbeat", "ok": true, "at": now_secs() })).await;
        }

        // 前端动作：login = 打开该平台可见登录窗并盯到取齐凭据；pull = QOJ 隐藏窗静默续签
        if let Some(req) = pop_pending(port).await {
            match req.action.as_str() {
                "login" => handle_login(&app, port, &req).await,
                "pull" if req.platform == "qoj" => handle_qoj_pull(&app, port, req.id).await,
                _ => post_failure(port, "login", Some(req.id), &format!("不支持的平台: {}", req.platform)).await,
            }
            continue;
        }

        // 周期保活（仅 QOJ）
        if last_keepalive.elapsed() >= KEEPALIVE_EVERY {
            last_keepalive = tokio::time::Instant::now();
            keepalive_tick(&app, port, &mut keepalive_fails).await;
        }
    }
}

// ---------- 两个入口 ----------

/// 可见登录窗：开窗（已开则聚焦，不重载用户正在看的页面）→ 盯到凭据取齐 → 推送。
/// 带 handle = 结果只写该账号槽位；不带 = 写该平台全部已绑定账号槽位（无槽位则平台级）。
async fn handle_login(app: &AppHandle, port: u16, req: &PendingRequest) {
    let Some(spec) = spec_of(&req.platform) else {
        post_failure(port, "login", Some(req.id), &format!("不支持的平台: {}", req.platform)).await;
        return;
    };
    let label = format!("login-{}", spec.platform);
    if !ensure_window(app, &label, spec.url, spec.title, true).await {
        post_failure(port, "login", Some(req.id), "无法打开登录窗口").await;
        return;
    }
    // WebView 同源代理平台（QOJ）：登录态留在壳内浏览器，抓取由守护脚本完成——
    // 这里只等登录会话出现，**不推送 Cookie**（重放已被站点 Cloudflare 指纹绑定拦死）
    if spec.agent {
        crate::logln(&format!("[shell-auth] {} 登录窗口已打开（同源代理模式），等待登录会话…", spec.platform));
        let deadline = tokio::time::Instant::now() + LOGIN_WATCH;
        let mut logged_in = false;
        loop {
            tokio::time::sleep(POLL_TICK).await;
            if app.get_webview_window(&label).is_none() {
                break; // 用户关窗
            }
            if let Some(c) = read_cookies(app, &label, spec) {
                if c.iter().any(|(k, _)| k == "uojsessid") {
                    logged_in = true;
                    break;
                }
            }
            // 幂等注入：登录过程会多次跳转换文档，守护脚本随文档重建
            inject_agent(app, &label, port);
            if tokio::time::Instant::now() >= deadline {
                break;
            }
        }
        if logged_in {
            // 回报成功前先等守护脚本上线：客户端收到成功后会立刻自动重检凭据，
            // 若此刻代理还没就绪，那次检测会超时变红，用户就会以为「登录了还是失败」
            let wait_start = tokio::time::Instant::now();
            while tokio::time::Instant::now() < wait_start + Duration::from_secs(15) {
                if get_json(port, "/api/qoj-agent/alive")
                    .await
                    .and_then(|v| v.get("alive").and_then(|a| a.as_bool()))
                    .unwrap_or(false)
                {
                    break;
                }
                inject_agent(app, &label, port);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            crate::logln("[shell-auth] qoj 登录态已就绪（同源代理模式）");
            post_result(
                port,
                "login",
                Some(req.id),
                true,
                "QOJ 登录态已就绪：同步将自动经内嵌窗口完成，本窗口可随手关闭",
            )
            .await;
        } else {
            post_failure(
                port,
                "login",
                Some(req.id),
                "未检测到 qoj.ac 登录：请在窗口里完成登录后再点一次「在应用内登录 QOJ」",
            )
            .await;
        }
        return;
    }
    crate::logln(&format!("[shell-auth] {} 登录窗口已打开，等待凭据…", spec.platform));
    let deadline = tokio::time::Instant::now() + LOGIN_WATCH;
    let mut creds: Option<Creds> = None;
    loop {
        tokio::time::sleep(POLL_TICK).await;
        if app.get_webview_window(&label).is_none() {
            break; // 用户关窗：用最后一次读到的凭据收尾
        }
        if let Some(c) = read_cookies(app, &label, spec) {
            let done = creds_complete(spec, &c);
            creds = Some(c);
            if done {
                break;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
    }
    match creds {
        Some(c) if creds_complete(spec, &c) => {
            let (pushed, message) = push_cookies(port, spec, req.handle.as_deref(), &c).await;
            crate::logln(&format!("[shell-auth] {} 登录抓取推送{}（{message}）", spec.platform, if pushed { "成功" } else { "失败" }));
            post_result(port, "login", Some(req.id), pushed, &message).await;
        }
        other => {
            let message = match other {
                None => "登录窗口已关闭且未取得登录 Cookie".to_string(),
                Some(c) => format_missing(spec, &c),
            };
            crate::logln(&format!("[shell-auth] {} 登录抓取未取齐凭据（{message}）", spec.platform));
            post_failure(port, "login", Some(req.id), &message).await;
        }
    }
}

/// QOJ「立即续签」：刷新助手窗口（重导航续签 Cloudflare 凭据 + 重建守护脚本）
async fn handle_qoj_pull(app: &AppHandle, port: u16, id: u64) {
    match renew_qoj_agent(app, port).await {
        Some(message) => {
            crate::logln(&format!("[shell-auth] qoj 助手窗口已刷新（{message}）"));
            post_result(port, "pull", Some(id), true, &message).await;
        }
        None => {
            post_failure(port, "pull", Some(id), "助手窗口未就绪：请稍候重试，或在设置页点「在应用内登录 QOJ」").await;
        }
    }
}

/// QOJ 周期保活：刷新助手窗口（重导航续签 Cloudflare 凭据 + 重建守护脚本）；
/// 连续失败多半是挑战需要人工交互，弹窗请人工过盾
async fn keepalive_tick(app: &AppHandle, port: u16, fails: &mut u32) {
    if !qoj_configured(port).await {
        *fails = 0;
        return;
    }
    crate::logln("[shell-auth] 保活：刷新 QOJ 助手窗口（续签 Cloudflare 凭据 + 重建守护脚本）");
    match renew_qoj_agent(app, port).await {
        Some(message) => {
            *fails = 0;
            crate::logln(&format!("[shell-auth] 保活完成（{message}）"));
            post_result(port, "keepalive", None, true, &message).await;
            return;
        }
        None => {
            *fails += 1;
        }
    }
    if *fails >= KEEPALIVE_FAIL_SHOW {
        // 连续失败多半是挑战需要人工交互：弹出可见窗口，用户点一下即恢复
        *fails = 0;
        crate::logln("[shell-auth] 保活连续失败，弹出登录窗口请人工完成验证");
        let _ = ensure_window(
            app,
            "login-qoj",
            "https://qoj.ac/",
            "QOJ 验证 · 请完成人机验证（完成后同步自动恢复）",
            true,
        )
        .await;
        post_status(
            port,
            &json!({ "kind": "keepalive", "ok": false, "pushed": false,
                     "message": "自动续签未成功：已打开 QOJ 窗口，请完成人机验证（完成后同步自动恢复）", "at": now_secs() }),
        )
        .await;
    } else {
        let message = "助手窗口刷新失败（窗口可能被系统关闭），下轮自动重试";
        crate::logln(&format!("[shell-auth] 保活未完成（{message}）"));
        post_status(
            port,
            &json!({ "kind": "keepalive", "ok": false, "pushed": false, "message": message, "at": now_secs() }),
        )
        .await;
    }
}

/// 刷新 QOJ 助手窗口：复用/创建隐藏窗 → 重新导航（触发 Cloudflare 重评估续签凭据）→
/// 注入守护脚本并轮询核心的 /alive 端点，脚本一上线就提前返回（把代理不可用窗口压到几秒，
/// 否则导航重建的 30 秒里用户触发的凭据检测会撞上超时变红）。成功返回展示消息。
async fn renew_qoj_agent(app: &AppHandle, port: u16) -> Option<String> {
    if !ensure_window(app, WORKER_LABEL, "https://qoj.ac/", "QOJ 助手", false).await {
        return None;
    }
    if !navigate_window(app, WORKER_LABEL, "https://qoj.ac/") {
        return None;
    }
    let deadline = tokio::time::Instant::now() + PULL_WAIT;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if app.get_webview_window(WORKER_LABEL).is_none() {
            return None;
        }
        inject_agent(app, WORKER_LABEL, port);
        // 守护脚本一旦开始轮询核心（alive=true）即视为就绪，提前收工
        if get_json(port, "/api/qoj-agent/alive")
            .await
            .and_then(|v| v.get("alive").and_then(|a| a.as_bool()))
            .unwrap_or(false)
        {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
    }
    Some("QOJ 助手窗口已就绪（Cloudflare 验证已随导航续签，守护脚本已重建）".to_string())
}

/// 幂等注入 QOJ 守护脚本：脚本在 qoj.ac 页面上下文里自轮询 /api/qoj-agent/next 领任务，
/// 同源 fetch 提交页（完美客户端指纹 + 真实登录态）后回传。重复注入由 window 标记挡掉。
fn inject_agent(app: &AppHandle, label: &str, port: u16) {
    if let Some(w) = app.get_webview_window(label) {
        let script = AGENT_DAEMON_SCRIPT.replace("__PORT__", &port.to_string());
        let _ = w.eval(&script);
    }
}

/// 建/取窗口。已存在时：可见窗 show+聚焦（不重载，保留用户浏览上下文），隐藏窗原样复用。
async fn ensure_window(app: &AppHandle, label: &str, url: &str, title: &str, visible: bool) -> bool {
    if let Some(w) = app.get_webview_window(label) {
        if visible {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return true;
    }
    let (tx, rx) = mpsc::sync_channel(1);
    let app2 = app.clone();
    let label = label.to_string();
    let url = url.to_string();
    let title = title.to_string();
    let queued = app.run_on_main_thread(move || {
        // WebView2 同一用户数据目录 → 各窗共享 Cookie 存储；UA 显式统一（见 WEBVIEW_UA）
        let mut builder = WebviewWindowBuilder::new(
            &app2,
            label,
            WebviewUrl::External(url.parse().expect("合法平台 URL")),
        )
        .title(title)
        .inner_size(1080.0, 800.0)
        .user_agent(WEBVIEW_UA);
        if !visible {
            builder = builder.visible(false);
        }
        let _ = tx.send(builder.build().is_ok());
    });
    queued.is_ok() && rx.recv_timeout(Duration::from_secs(15)).unwrap_or(false)
}

/// 重新导航到平台首页。navigate 与 supervise 同款跨线程调用（见 main.rs::navigate）。
fn navigate_window(app: &AppHandle, label: &str, url: &str) -> bool {
    match app.get_webview_window(label) {
        Some(w) => matches!(w.navigate(url.parse().expect("合法平台 URL")), Ok(())),
        None => false,
    }
}

/// 读平台域下的凭据 Cookie（按 LoginSpec 归并字段 key）。
/// ⚠ 必须在非主线程调用：tauri 文档明确 Windows 上于同步命令/事件处理（主线程）
/// 中读取会死锁（WebView2 issue）；本函数只从凭据任务的 tokio 线程调用。
/// 返回 None = 窗口不存在或未读到任何目标 Cookie；值缺失 = 该项 Cookie 不存在。
fn read_cookies(app: &AppHandle, label: &str, spec: &LoginSpec) -> Option<Creds> {
    let w = app.get_webview_window(label)?;
    let url: tauri::Url = spec.url.parse().expect("合法平台 URL");
    let cookies = w.cookies_for_url(url).ok()?;
    let mut out: Creds = Vec::new();
    for (name, key) in spec.fields {
        if out.iter().any(|(k, _)| k == key) {
            continue; // 同 key 的旧名兜底项：已有值（新名先到）即跳过
        }
        if let Some(c) = cookies.iter().find(|c| c.name() == *name) {
            let v = c.value().to_string();
            if !v.is_empty() {
                out.push((key.to_string(), v));
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

/// 是否取齐了该平台的全部凭据字段（字段表中每个 key 都有值）
fn creds_complete(spec: &LoginSpec, creds: &Creds) -> bool {
    spec.fields.iter().all(|(_, key)| creds.iter().any(|(k, _)| k == key))
}

/// 部分 Cookie 缺失时的提示（列出缺哪些，便于用户对照站点登录状态）
fn format_missing(spec: &LoginSpec, creds: &Creds) -> String {
    let missing: Vec<&str> = spec
        .fields
        .iter()
        .filter(|(_, key)| !creds.iter().any(|(k, _)| k == key))
        .map(|(name, _)| *name)
        .collect();
    format!("已抓到部分 Cookie，还缺：{}。请在窗口里完成登录（含人机验证）后重试", missing.join("、"))
}

// ---------- 凭据推送 ----------

/// 推送凭据到核心：
/// - 带 handle：只写该账号的凭槽位（多账号按账号分别抓取的定向通道）；
/// - 不带 handle：写该平台全部已绑定账号槽位（同步按账号槽位取凭据，漏推等于没保存）；
///   无任何已绑定账号则写平台级（影子值，供题库爬取/榜单等非账号功能；账号同步不走影子值，
///   消息里提示用户绑定后再抓一次）。
/// - UA（QOJ）：configOnly 语义，写平台级 ua.qoj（首个请求顺带即可，全部账号共用）。
/// 返回 (是否全部成功, 展示消息)。
async fn push_cookies(port: u16, spec: &LoginSpec, handle: Option<&str>, creds: &Creds) -> (bool, String) {
    let settings = get_json(port, "/api/settings").await;
    let mut targets: Vec<String> = Vec::new();
    if let Some(h) = handle {
        targets.push(h.to_string());
    } else if let Some(s) = &settings {
        if let Some(slots) = s.pointer(&format!("/accountCreds/{}", spec.platform)).and_then(|v| v.as_object()) {
            targets.extend(slots.keys().cloned());
        }
    }
    if targets.is_empty() {
        let ok = post_cookies(port, spec, None, creds).await.is_some();
        return (
            ok,
            if ok {
                format!("已保存 {} 平台级凭据（暂存：绑定账号后请在账号卡片重新抓取，账号同步只认账号槽位）", spec.platform)
            } else {
                "Cookie 写入设置失败".into()
            },
        );
    }
    let mut all_ok = true;
    let mut saved = 0usize;
    for target in &targets {
        let ok = post_cookies(port, spec, Some(target), creds).await.is_some();
        if ok {
            saved += 1;
        } else {
            all_ok = false;
        }
    }
    let scope = if handle.is_some() {
        format!("账号 {handle} 的凭据槽位", handle = targets[0])
    } else {
        format!("{}/{} 个账号槽位", saved, targets.len())
    };
    (all_ok, format!("已保存 {} 凭据（{scope}）", spec.platform))
}

/// 单次 POST /api/settings/cookies：账号级（带 handle）或平台级（不带）
async fn post_cookies(port: u16, spec: &LoginSpec, handle: Option<&str>, creds: &Creds) -> Option<Value> {
    let mut fields = Map::new();
    for (k, v) in creds {
        fields.insert(k.clone(), json!(v));
    }
    if spec.ua {
        fields.insert("ua".into(), json!(WEBVIEW_UA));
    }
    let mut body = json!({ "platform": spec.platform, "cookieFields": fields });
    if let Some(h) = handle {
        body["handle"] = json!(h);
    }
    post_json(port, "/api/settings/cookies", &body).await
}

/// 核心侧 QOJ 是否已配置凭据（有账号槽位或平台级影子值）——未配置则保活静默跳过
async fn qoj_configured(port: u16) -> bool {
    let Some(s) = get_json(port, "/api/settings").await else {
        return false;
    };
    let acct = s
        .pointer("/accountCreds/qoj")
        .and_then(|v| v.as_object())
        .map(|o| !o.is_empty())
        .unwrap_or(false);
    let platform = s
        .pointer("/cookies/qoj/configured")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    acct || platform
}

// ---------- 基础设施 ----------

/// pending 请求（GET /pending 的 request 字段）
struct PendingRequest {
    id: u64,
    action: String,
    platform: String,
    handle: Option<String>,
}

async fn pop_pending(port: u16) -> Option<PendingRequest> {
    let v = get_json(port, "/api/settings/shell-auth/pending").await?;
    let req = v.get("request")?;
    let id = req.get("id")?.as_u64()?;
    let action = req.get("action")?.as_str()?.to_string();
    let platform = req.get("platform")?.as_str()?.to_string();
    let handle = req.get("handle").and_then(|h| h.as_str()).map(|h| h.to_string());
    Some(PendingRequest { id, action, platform, handle })
}

fn current_port(app: &AppHandle) -> Option<u16> {
    let state: &PortState = app.state::<PortState>().inner();
    *state.lock().ok()?
}

fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .expect("构建壳凭据桥 HTTP 客户端失败")
    })
}

async fn get_json(port: u16, path: &str) -> Option<Value> {
    http()
        .get(format!("http://127.0.0.1:{port}{path}"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()
}

async fn post_json(port: u16, path: &str, body: &Value) -> Option<Value> {
    http()
        .post(format!("http://127.0.0.1:{port}{path}"))
        .json(body)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()
}

/// 回报动作成功/失败（kind=login/pull/keepalive；id 缺省 = 保活）
async fn post_result(port: u16, kind: &str, id: Option<u64>, pushed: bool, message: &str) {
    let mut payload = json!({ "kind": kind, "ok": pushed, "pushed": pushed, "message": message, "at": now_secs() });
    if let Some(i) = id {
        payload["id"] = json!(i);
    }
    post_status(port, &payload).await;
}

/// 回报动作失败（ok=false）
async fn post_failure(port: u16, kind: &str, id: Option<u64>, message: &str) {
    post_result(port, kind, id, false, message).await;
}

/// 回报状态到核心（best-effort：失败只记日志，不影响主流程）
async fn post_status(port: u16, body: &Value) {
    if post_json(port, "/api/settings/shell-auth/status", body).await.is_none() {
        crate::logln("[shell-auth] 状态回报失败（核心可能正在重启）");
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
