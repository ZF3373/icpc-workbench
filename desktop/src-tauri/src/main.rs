#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub const PORT_MIN: u16 = 3001;
pub const PORT_MAX: u16 = 3020;

mod discovery;
mod lifecycle;
mod state;

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            // 二次启动：聚焦已有窗口由 single-instance 默认行为处理
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running widget");
}
