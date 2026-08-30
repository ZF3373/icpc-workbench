fn main() {
    // 嵌入带 PerMonitorV2 DPI 感知的 manifest（cargo tauri CLI 默认会做，直接 cargo build 时需自理）。
    // 无 DPI 感知时窗口按 96-DPI 度量创建，WebView2 按实际缩放渲染 → 视口被裁、坐标错位。
    let manifest = std::path::Path::new("windows-app.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let _ = embed_resource::compile(manifest, embed_resource::NONE);
    tauri_build::build();
}
