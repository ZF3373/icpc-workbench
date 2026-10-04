#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! ICPC 备赛工作台桌面壳：
//! - 启动时拉起同目录的 icpc-core.exe（无窗口核心，ICPC_EMBEDDED=1 不抢浏览器）
//! - 探测核心服务端口（3001-3020），把原生窗口导航到应用页面
//! - 看护循环：探活连续失败才认定掉线，先静默原地恢复（不重载页面），
//!   超过静默预算才切加载页；恢复失败且核心无响应时强制结束并重拉
//! - 单实例：重复启动只聚焦已有窗口
//! - 壳与核心的运行日志都落盘（data/logs/core.log），「莫名重启」有迹可循

mod discovery;

use std::io::Write;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// WebviewUrl 仅在建窗（setup）使用，run 回调路径不需要
#[allow(unused_imports)]
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const PORT_MIN: u16 = 3001;
const PORT_MAX: u16 = 3020;
/// 首次启动等待核心就绪的预算（SEA 核心冷启 1-2s，留足慢盘/杀软扫描余量）
const START_BUDGET: Duration = Duration::from_secs(60);
/// 看护循环间隔
const WATCH_INTERVAL: Duration = Duration::from_secs(10);
/// 首拍探活失败后的补拍次数：全败才认定掉线，过滤单次抖动（issue #39）
const CONFIRM_PROBES: u32 = 3;
/// 补拍间隔
const CONFIRM_GAP: Duration = Duration::from_millis(400);
/// 静默恢复预算：掉线后的第一阶段不惊动页面，原地等服务回来。
/// 核心重启后多半仍落回原端口，静默期内恢复成功则页面完全不需要重载。
const SILENT_RECOVER: Duration = Duration::from_secs(6);
/// 可见恢复（已切加载页）的单轮预算
const RECOVER_BUDGET: Duration = Duration::from_secs(30);
/// 恢复期探活/补拉节奏
const RECOVER_GAP: Duration = Duration::from_millis(700);

/// 核心子进程句柄（退出时 kill）
type CoreHandle = Mutex<Option<Child>>;
/// 当前服务端口（None = 掉线/未就绪）
type PortState = Mutex<Option<u16>>;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(windows)]
const CORE_FILE: &str = "icpc-core.exe";
#[cfg(not(windows))]
const CORE_FILE: &str = "icpc-core";

fn core_path() -> PathBuf {
    exe_dir().join(CORE_FILE)
}

/// 日志目录：与核心数据目录同源（Windows 便携版 exe 旁 data/；
/// macOS 数据目录经 ICPC_DATA_DIR 挪出应用包，见 macos_data_dir 说明）。
#[cfg(target_os = "macos")]
fn log_dir() -> PathBuf {
    macos_data_dir().unwrap_or_else(exe_dir).join("logs")
}

#[cfg(not(target_os = "macos"))]
fn log_dir() -> PathBuf {
    exe_dir().join("data").join("logs")
}

fn log_path() -> PathBuf {
    log_dir().join("core.log")
}

/// Unix 秒 → (年, 月, 日)。Howard Hinnant 的 civil_from_days 算法；
/// 标准库无时区 API，日志统一按 UTC 记（带 Z 后缀）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 写一行壳日志：控制台照常输出（dev 跑壳时可见），同时追加到日志文件。
/// GUI 进程没有控制台，stdout 一丢，用户反馈「莫名重启」时就无迹可查。
/// 打不开日志文件不影响运行。
fn logln(line: &str) {
    println!("{line}");
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    let _ = writeln!(
        f,
        "[{:04}-{:02}-{:02} {:02}:{:02}:{:02}Z] {line}",
        y,
        mo,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    );
}

/// 轮转并打开核心会话日志（append）：上一份 core.log 挪到 core.old.log。
/// 只在真正拉起新核心时调用——旧子进程此时已退出、文件句柄已释放，Windows 上才能改名成功。
/// 核心的 stdout/stderr 指向该文件：Node 对文件 fd 的写入是同步的，
/// 未捕获异常的堆栈在进程退出前必然落盘，崩溃原因不再「未知」。
fn open_rotated_core_log() -> Option<std::fs::File> {
    let path = log_path();
    let dir = path.parent()?;
    let _ = std::fs::create_dir_all(dir);
    let old = dir.join("core.old.log");
    let _ = std::fs::remove_file(&old);
    let _ = std::fs::rename(&path, &old);
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

/// 用户主目录：$HOME 优先，缺失时查 getpwuid。
/// GUI 进程的环境变量不一定齐全，而数据目录必须落在应用包外，所以留一层兜底。
#[cfg(target_os = "macos")]
fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    // /etc/passwd 查询免依赖；仅在 $HOME 缺失时走到
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    let uid = std::env::var("UID").ok()?;
    passwd
        .lines()
        .find(|line| line.split(':').nth(2) == Some(uid.as_str()))
        .and_then(|line| line.split(':').nth(5))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// macOS 用户数据目录：
/// `~/Library/Application Support/icpc-workbench/data`。
///
/// 核心作为 sidecar 位于 `icpc-workbench.app/Contents/MacOS/`，若沿用 Windows 那种
/// 「exe 旁 data/」，用户数据会写进应用包内部——既让 .app 代码签名失效
/// （下次打开报「已损坏」，即 issue #14 的现象之一），又会在覆盖安装新版时丢数据。
/// 所以显式经 ICPC_DATA_DIR 把数据目录挪到应用包外。
#[cfg(target_os = "macos")]
fn macos_data_dir() -> Option<PathBuf> {
    Some(
        home_dir()?
            .join("Library")
            .join("Application Support")
            .join("icpc-workbench")
            .join("data"),
    )
}

/// 给核心子进程指定数据目录（macOS：挪出应用包，见 macos_data_dir 说明）。
/// 主目录彻底取不到时告警而不是静默退回包内目录——那正是要避免的故障。
#[cfg(target_os = "macos")]
fn apply_data_dir(cmd: &mut std::process::Command) {
    match macos_data_dir() {
        Some(dir) => {
            cmd.env("ICPC_DATA_DIR", dir);
        }
        None => logln("[shell] 无法确定用户主目录，核心将退回应用包内数据目录（不推荐）"),
    }
}

/// 给核心子进程指定数据目录（非 macOS 无需指定：Windows 便携版就用 exe 旁 data/）。
#[cfg(not(target_os = "macos"))]
fn apply_data_dir(_cmd: &mut std::process::Command) {}

/// 核心子进程是否仍在运行（无句柄或已退出都算不在运行）
fn core_running(app: &tauri::AppHandle) -> bool {
    let core: &CoreHandle = app.state::<CoreHandle>().inner();
    match core.lock() {
        Ok(mut guard) => matches!(guard.as_mut().map(|c| c.try_wait()), Some(Ok(None))),
        Err(_) => false,
    }
}

/// 拉起核心（无窗口、嵌入模式，stdout/stderr 落会话日志）。若核心进程仍在运行则跳过。
fn spawn_core(app: &tauri::AppHandle) {
    let core: &CoreHandle = app.state::<CoreHandle>().inner();
    let mut guard = match core.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(child) = guard.as_mut() {
        // 仍在运行 → 无需重启
        if matches!(child.try_wait(), Ok(None)) {
            return;
        }
    }
    let path = core_path();
    if !path.exists() {
        logln(&format!("[shell] 未找到核心程序: {}", path.display()));
        return;
    }
    let mut cmd = std::process::Command::new(&path);
    cmd.env("ICPC_EMBEDDED", "1");
    // 企业网 TLS 拦截下 Node 内置 CA 校验会失败（更新检查/下载），改走 Windows 系统证书库
    cmd.env("NODE_USE_SYSTEM_CA", "1");
    cmd.current_dir(exe_dir()); // data/ 与壳 exe 同目录，升级替换 exe 数据不丢
    apply_data_dir(&mut cmd);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    match open_rotated_core_log() {
        Some(f) => {
            if let Ok(f2) = f.try_clone() {
                cmd.stdout(std::process::Stdio::from(f2));
            }
            cmd.stderr(std::process::Stdio::from(f));
        }
        None => {
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::null());
        }
    }
    match cmd.spawn() {
        Ok(child) => {
            *guard = Some(child);
            logln(&format!("[shell] 核心已启动: {}", path.display()));
        }
        Err(e) => logln(&format!("[shell] 核心启动失败: {e}")),
    }
}

fn kill_core(app: &tauri::AppHandle) {
    let core: &CoreHandle = app.state::<CoreHandle>().inner();
    if let Ok(mut guard) = core.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
            logln("[shell] 核心进程已回收");
        }
    }
}

fn app_abs_url(port: u16) -> tauri::Url {
    format!("http://127.0.0.1:{port}/")
        .parse()
        .expect("合法的应用 URL")
}

fn navigate(app: &tauri::AppHandle, url: tauri::Url) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.navigate(url);
    }
}

fn navigate_loading(app: &tauri::AppHandle) {
    navigate(app, "http://tauri.localhost/loading.html".parse().unwrap());
}

fn navigate_offline(app: &tauri::AppHandle) {
    navigate(app, "http://tauri.localhost/offline.html".parse().unwrap());
}

/// 看护循环：首次启动等待就绪 → 之后每 10s 探活；
/// 首拍失败先补拍确认（过滤抖动）→ 认定掉线后先静默原地恢复（不重载页面），
/// 超过静默预算才切加载页全端口扫描；恢复失败且核心无响应时强制结束、下轮重拉。
async fn supervise(app: tauri::AppHandle) {
    // —— 首次启动：拉起核心并等待就绪 ——
    logln("[shell] 工作台壳启动");
    spawn_core(&app);
    let deadline = tokio::time::Instant::now() + START_BUDGET;
    let mut found: Option<u16> = None;
    while tokio::time::Instant::now() < deadline {
        if let Some(p) = discovery::find_server(None).await {
            found = Some(p);
            break;
        }
        // 核心可能启动即失败：补拉
        spawn_core(&app);
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    // 窗口当前是否停在 loading/offline 恢复页（决定恢复后要不要重新导航）
    let mut on_recovery_page = false;
    match found {
        Some(p) => {
            *app.state::<PortState>().inner().lock().unwrap() = Some(p);
            logln(&format!("[shell] 服务就绪: http://127.0.0.1:{p}/"));
            navigate(&app, app_abs_url(p));
        }
        None => {
            on_recovery_page = true;
            navigate_offline(&app);
            logln("[shell] 核心启动超时，进入离线页（持续重试）");
        }
    }

    // —— 看护：掉线自动恢复 ——
    loop {
        tokio::time::sleep(WATCH_INTERVAL).await;
        let last = *app.state::<PortState>().inner().lock().unwrap();
        if let Some(p) = last {
            if discovery::check(p).await {
                continue; // 正常
            }
            // 首拍失败先快速补拍：全败才认定掉线。核心事件循环的短暂卡顿（同步 SQLite、
            // VACUUM 备份、GC、杀软拦截）只该无感挺过去，不该触发整页重载（issue #39）
            let mut down = true;
            for _ in 0..CONFIRM_PROBES {
                tokio::time::sleep(CONFIRM_GAP).await;
                if discovery::check(p).await {
                    down = false;
                    break;
                }
            }
            if !down {
                logln(&format!("[shell] 探测抖动，服务已自行恢复（端口 {p}），页面保持不动"));
                continue;
            }
            *app.state::<PortState>().inner().lock().unwrap() = None;
        }
        logln("[shell] 服务掉线，尝试自动恢复…");

        // 阶段一（静默）：原地等待服务回来，不惊动页面。核心重启后大概率仍监听原端口，
        // 静默期内恢复成功则页面从未离开应用——用户对整个故障无感（issue #39 的关键）。
        let mut recovered: Option<u16> = None;
        if let Some(p) = last {
            let silent_deadline = tokio::time::Instant::now() + SILENT_RECOVER;
            while tokio::time::Instant::now() < silent_deadline {
                spawn_core(&app); // 核心进程已退出才会真正拉起
                if discovery::check(p).await {
                    recovered = Some(p);
                    break;
                }
                tokio::time::sleep(RECOVER_GAP).await;
            }
        }

        // 阶段二（可见）：静默期没等到，才切加载页，全端口扫描
        if recovered.is_none() {
            if !on_recovery_page {
                on_recovery_page = true;
                navigate_loading(&app);
            }
            spawn_core(&app);
            let deadline = tokio::time::Instant::now() + RECOVER_BUDGET;
            while tokio::time::Instant::now() < deadline {
                if let Some(p) = discovery::find_server(last).await {
                    recovered = Some(p);
                    break;
                }
                spawn_core(&app);
                tokio::time::sleep(RECOVER_GAP).await;
            }
        }

        match recovered {
            Some(p) => {
                *app.state::<PortState>().inner().lock().unwrap() = Some(p);
                logln(&format!("[shell] 服务已恢复: http://127.0.0.1:{p}/"));
                // 静默期恢复且端口未变 → 页面从未离开应用，保持不动即是最好的恢复；
                // 只有已经切到恢复页（或端口变了，旧页面的 origin 已死）才重新导航
                if on_recovery_page || last != Some(p) {
                    on_recovery_page = false;
                    navigate(&app, app_abs_url(p));
                }
            }
            None => {
                // 整轮恢复失败：若核心进程还活着，说明它已无响应 ≥ 恢复预算，
                // 结束它下一轮才能拉起全新进程（SQLite WAL 模式下强杀不损数据）
                if core_running(&app) {
                    logln("[shell] 核心进程无响应超过恢复预算，强制结束后将于下轮重新拉起");
                    kill_core(&app);
                }
                navigate_offline(&app);
                logln("[shell] 本轮恢复失败，下轮继续重试");
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            app.manage::<CoreHandle>(Mutex::new(None));
            app.manage::<PortState>(Mutex::new(None));

            // 先建窗显示启动页，再异步拉核心/探活（避免阻塞 setup）
            let win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("loading.html".into()),
            )
            .title("ICPC 备赛工作台")
            .inner_size(1360.0, 860.0)
            .min_inner_size(960.0, 640.0)
            .build()?;

            let _ = win.set_focus();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                supervise(handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 退出软件：回收核心子进程（与网页版「关闭窗口即退出」语义一致）
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                kill_core(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                kill_core(app);
            }
        });
}
