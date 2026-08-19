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

/// watcher 每 10s 探测的间隔
const WATCH_INTERVAL: Duration = Duration::from_secs(10);
/// 连续失败多少次后判定掉线
const WATCH_MAX_FAILS: u32 = 2;

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：唤起并聚焦已有主窗口（可能已隐藏到托盘）
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
            let port = rt.block_on(discovery::find_server(parse_port_hint()));
            let url = match port {
                Some(p) => widget_url(p),
                None => offline_url(),
            };
            let st = state::WidgetState::load();
            let mut win = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("ICPC 挂件")
                .inner_size(340.0, 520.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true);
            if st.x >= 0 && st.y >= 0 {
                win = win.position(st.x as f64, st.y as f64);
            } else {
                // 默认右下角（粗略；精确工作区在 Task 10 处理）
                win = win.position(1200.0, 400.0);
            }
            win.build()?;

            // 当前端口共享给 watcher（offline 时为 None），并启动后台健康检查
            app.manage(Mutex::new(port));
            spawn_watcher(app.handle().clone());

            // 系统托盘：右键菜单「显示/隐藏」「退出」，左键单击恢复显示
            let show_item = MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("ICPC 挂件")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_main_window(app),
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
        })
        .run(tauri::generate_context!())
        .expect("error while running widget");
}
