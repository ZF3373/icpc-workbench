#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub const PORT_MIN: u16 = 3001;
pub const PORT_MAX: u16 = 3020;

mod discovery;
mod lifecycle;
mod state;

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// watcher 每 10s 探测的间隔
const WATCH_INTERVAL: Duration = Duration::from_secs(10);
/// 连续失败多少次后判定掉线
const WATCH_MAX_FAILS: u32 = 2;
/// 穿透开启后自动恢复交互的时限（穿透仅会话级，重启一律可交互）
const PIERCE_AUTO_RESTORE: Duration = Duration::from_secs(60);

/// 穿透状态（会话级，不持久化）。tauri 2.11.5 没有 `is_ignore_cursor_events`，
/// 只能自记标志；独立类型避免与端口的 `Mutex<Option<u16>>` 在 State 中撞类型。
type PierceState = Mutex<bool>;

fn parse_port_hint() -> Option<u16> {
    let arg = std::env::args().find(|a| a.starts_with("--port="))?;
    arg.trim_start_matches("--port=").parse().ok()
}

fn offline_url() -> tauri::WebviewUrl {
    // offline.html 通过 tauri.conf 的 frontendDist 提供，用 tauri:// 协议加载
    tauri::WebviewUrl::App("offline.html".into())
}

fn widget_abs_url(port: u16) -> tauri::Url {
    format!("http://127.0.0.1:{}/widget", port)
        .parse()
        .expect("合法的 widget URL")
}

fn widget_url(port: u16) -> tauri::WebviewUrl {
    tauri::WebviewUrl::External(widget_abs_url(port))
}

/// offline.html 的绝对地址（Windows 上 frontendDist 走 http://tauri.localhost 协议），
/// 供 watcher 的 `navigate`（需要绝对 URL）使用；建窗时仍用 `offline_url()`。
fn offline_abs_url() -> tauri::Url {
    "http://tauri.localhost/offline.html"
        .parse()
        .expect("合法的 offline URL")
}

/// 让主窗口在 /widget 与 offline.html 之间切换。
/// Tauri v2 的 WebviewWindowBuilder 只在建窗时消费 WebviewUrl，无稳定 set_url；
/// 但 2.x 提供 `WebviewWindow::navigate(url)`（wry load_url），在原窗口内切换，
/// 保留窗口位置与可见性，避免「销毁重建」的闪烁与 label 竞态。
fn navigate(app: &tauri::AppHandle, url: tauri::Url) -> tauri::Result<()> {
    match app.get_webview_window("main") {
        Some(w) => w.navigate(url),
        None => Ok(()),
    }
}

/// 后台健康检查：每 10s 探测当前端口，连续 2 次失败切 offline；
/// offline 期间每轮尝试重新发现服务，成功即切回 /widget。
/// 当前端口经 `Mutex<Option<u16>>` 共享（offline 时为 None）。
fn spawn_watcher(handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut fails = 0u32;
        loop {
            tokio::time::sleep(WATCH_INTERVAL).await;
            let current = { *handle.state::<Mutex<Option<u16>>>().inner().lock().unwrap() };
            let Some(p) = current else {
                // 当前 offline：尝试重新发现主服务
                if let Some(np) = discovery::find_server(None).await {
                    let mut guard = handle.state::<Mutex<Option<u16>>>().inner().lock().unwrap();
                    *guard = Some(np);
                    drop(guard);
                    fails = 0;
                    let _ = navigate(&handle, widget_abs_url(np));
                }
                continue;
            };
            if discovery::check(p).await {
                fails = 0;
            } else {
                fails += 1;
                if fails >= WATCH_MAX_FAILS {
                    let mut guard = handle.state::<Mutex<Option<u16>>>().inner().lock().unwrap();
                    *guard = None;
                    drop(guard);
                    fails = 0;
                    let _ = navigate(&handle, offline_abs_url());
                }
            }
        }
    });
}

/// 托盘「显示/隐藏」：切换主窗口可见性并持久化 hidden 状态
/// （x/y 保持 state 文件中的既有值，不触碰）。
fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let hidden = if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            true
        } else {
            let _ = w.show();
            let _ = w.set_focus();
            false
        };
        state::WidgetState { hidden, ..state::WidgetState::load() }.save();
    }
}

/// 托盘「切换点击穿透」：翻转 set_ignore_cursor_events。
/// tauri 2.11.5 没有 `is_ignore_cursor_events()`，当前态由 PierceState（Mutex<bool>）自记。
/// 刚开启穿透时 60s 后自动恢复交互（穿透仅会话级，重启一律可交互）。
fn toggle_pierce(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let piercing = {
            let state = app.state::<PierceState>();
            let mut g = state.inner().lock().unwrap();
            *g = !*g;
            *g
        };
        if w.set_ignore_cursor_events(piercing).is_err() {
            // 设置失败：回滚标志，保持「记录态 == 实际态」
            *app.state::<PierceState>().inner().lock().unwrap() = !piercing;
            return;
        }
        if piercing {
            // AppHandle 本身即 handle，直接 clone 进异步任务
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(PIERCE_AUTO_RESTORE).await;
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.set_ignore_cursor_events(false);
                }
                *handle.state::<PierceState>().inner().lock().unwrap() = false;
            });
        }
    }
}

/// 托盘「开机自启 开/关」：翻转 autostart 注册（读取失败按已关处理）。
/// MacosLauncher 参数是插件 API 形状（macOS 枚举），Windows 上仍需传入但无效。
fn toggle_autostart(app: &tauri::AppHandle) {
    let mgr = app.autolaunch();
    let _ = if mgr.is_enabled().unwrap_or(false) {
        mgr.disable()
    } else {
        mgr.enable()
    };
}

/// offline 页「启动主程序」按钮的 command 入口。
/// 函数名即注册名（generate_handler! 默认取函数名本身），前端 invoke('launch_main')。
/// 与 lifecycle::launch_main_app 不同模块，不冲突。
#[tauri::command]
fn launch_main() -> Result<(), String> {
    lifecycle::launch_main_app()
}

/// 首启默认位置：主显示器工作区右下角（全物理像素计算，留 20px 边距）。
/// Tauri v2 monitor API 无「工作区」概念，size 即含任务栏的全屏尺寸；
/// Windows 任务栏默认在底部且高约 48px，底部边距取 60px 让挂件压在任务栏上方。
/// 监视器信息拿不到（无显示器/异常）时返回 None，由调用方回退硬编码。
fn workspace_bottom_right(
    app: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
) -> Option<tauri::PhysicalPosition<i32>> {
    let mon = app.primary_monitor().ok().flatten()?;
    let msize = mon.size();        // 物理像素
    let mpos = mon.position();     // 物理像素
    let wsize = win.outer_size().ok()?; // 建窗后的实际物理尺寸
    const MARGIN: i32 = 20;
    const TASKBAR: i32 = 60; // 底部任务栏预留
    Some(tauri::PhysicalPosition::new(
        mpos.x + msize.width as i32 - wsize.width as i32 - MARGIN,
        mpos.y + msize.height as i32 - wsize.height as i32 - TASKBAR,
    ))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：唤起并聚焦已有主窗口（可能已隐藏到托盘）
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                // hidden 状态闭环：恢复显示后落盘，重启后直接可见
                state::WidgetState { hidden: false, ..state::WidgetState::load() }.save();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostarted"]),
        ))
        .invoke_handler(tauri::generate_handler![launch_main])
        .setup(|app| {
            let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
            let port = rt.block_on(discovery::find_server(parse_port_hint()));
            let url = match port {
                Some(p) => widget_url(p),
                None => offline_url(),
            };
            let st = state::WidgetState::load();
            let win = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("ICPC 挂件")
                .inner_size(340.0, 520.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                // hidden 读回：上次退出时已隐藏到托盘，则启动即隐藏（托盘/二次启动可唤起）
                .visible(!st.hidden)
                .build()?;
            // 位置统一在 build 后以物理像素设置：
            // - 有记忆位置： Moved 事件存的即物理像素，物理对物理恢复（跨 DPI 迁移不漂移）
            // - 无记忆位置： 首启落在主显示器工作区右下角（留 20px 边距）
            // builder.position 是 logical 语义，与存储的物理像素不一致，故不在这里传。
            let pos = if st.x >= 0 && st.y >= 0 {
                tauri::PhysicalPosition::new(st.x, st.y)
            } else {
                workspace_bottom_right(app.handle(), &win).unwrap_or(tauri::PhysicalPosition::new(1200, 400))
            };
            let _ = win.set_position(pos);

            // 当前端口共享给 watcher（offline 时为 None），并启动后台健康检查
            app.manage(Mutex::new(port));
            // 穿透状态自记（tauri 无 is_ignore_cursor_events），初始 false = 可交互
            app.manage(PierceState::new(false));
            spawn_watcher(app.handle().clone());

            // 系统托盘：右键菜单「显示/隐藏」「切换点击穿透」「开机自启 开/关」「退出」，左键单击恢复显示
            let show_item = MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
            let pierce_item = MenuItem::with_id(app, "pierce", "切换点击穿透", true, None::<&str>)?;
            let auto_item = MenuItem::with_id(app, "auto", "开机自启 开/关", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &pierce_item, &auto_item, &quit_item])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("ICPC 挂件")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_main_window(app),
                    "pierce" => toggle_pierce(app),
                    "auto" => toggle_autostart(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键单击：若窗口处于隐藏态则恢复显示并聚焦
                    if matches!(event, TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. })
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            if !w.is_visible().unwrap_or(false) {
                                let _ = w.show();
                                let _ = w.set_focus();
                                // 从隐藏恢复显示：hidden 状态闭环，重启后直接可见
                                state::WidgetState { hidden: false, ..state::WidgetState::load() }.save();
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗 = 隐藏到托盘（进程保留），并持久化 hidden
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
                if window.label() == "main" {
                    state::WidgetState { hidden: true, ..state::WidgetState::load() }.save();
                }
            }
            // 拖动位置记忆：Moved 事件即存（小文件写，不做防抖）。
            // navigate 切换 URL 不重建窗口，位置天然保持，无需额外恢复逻辑。
            // hidden 沿用落盘值：Moved 通常意味着窗口可见，但隐藏期间的
            // 显示器/DPI 变化也可能触发 Moved，此时不应把 hidden:true 覆盖掉。
            if let tauri::WindowEvent::Moved(pos) = event {
                if window.label() == "main" {
                    state::WidgetState { x: pos.x, y: pos.y, ..state::WidgetState::load() }.save();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running widget");
}
