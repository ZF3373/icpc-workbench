#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub const PORT_MIN: u16 = 3001;
pub const PORT_MAX: u16 = 3020;

mod discovery;
mod lifecycle;
mod state;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

fn parse_port_hint() -> Option<u16> {
    let arg = std::env::args().find(|a| a.starts_with("--port="))?;
    arg.trim_start_matches("--port=").parse().ok()
}

fn offline_url() -> tauri::WebviewUrl {
    // offline.html 通过 tauri.conf 的 frontendDist 提供，用 tauri:// 协议加载
    tauri::WebviewUrl::App("offline.html".into())
}

fn widget_url(port: u16) -> tauri::WebviewUrl {
    let url: tauri::Url = format!("http://127.0.0.1:{}/widget", port)
        .parse()
        .expect("合法的 widget URL");
    tauri::WebviewUrl::External(url)
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
