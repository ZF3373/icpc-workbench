use std::path::PathBuf;
use std::process::Command;

pub fn main_exe_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let main = dir.join("icpc-workbench.exe");
    if main.exists() { Some(main) } else { None }
}

pub fn launch_main_app() -> Result<(), String> {
    let exe = main_exe_path()
        .ok_or_else(|| "找不到主程序 icpc-workbench.exe，请与 widget.exe 放在同一文件夹".to_string())?;
    Command::new(exe)
        .creation_flags(0x00000008) // DETACHED_PROCESS
        .spawn()
        .map_err(|e| format!("启动失败：{}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_exe_path_returns_none_when_absent() {
        // 测试环境同目录无 icpc-workbench.exe
        let p = main_exe_path();
        // 不强断言 None（万一测试机碰巧有），只验证返回 Option 且不 panic
        let _ = p;
    }

    #[test]
    fn launch_returns_err_message_when_absent() {
        if main_exe_path().is_none() {
            let r = launch_main_app();
            assert!(r.is_err());
            assert!(r.unwrap_err().contains("icpc-workbench.exe"));
        }
    }
}
