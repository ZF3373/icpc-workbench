use std::fs;
use std::path::Path;
use std::path::PathBuf;

pub struct WidgetState {
    pub x: i32,
    pub y: i32,
    pub hidden: bool,
}

impl WidgetState {
    pub fn default() -> Self {
        Self { x: -1, y: -1, hidden: false }
    }

    pub fn load() -> Self {
        load_from(&state_file_path())
    }

    pub fn save(&self) {
        let _ = save_to(self, &state_file_path());
    }
}

pub fn state_file_path() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("widget.exe"));
    exe.with_file_name("widget.json")
}

fn load_from(p: &Path) -> WidgetState {
    let Ok(text) = fs::read_to_string(p) else { return WidgetState::default(); };
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => WidgetState {
            x: v.get("x").and_then(|x| x.as_i64()).map(|n| n as i32).unwrap_or(-1),
            y: v.get("y").and_then(|y| y.as_i64()).map(|n| n as i32).unwrap_or(-1),
            hidden: v.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false),
        },
        Err(_) => WidgetState::default(),
    }
}

fn save_to(s: &WidgetState, p: &Path) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::json!({ "x": s.x, "y": s.y, "hidden": s.hidden });
    fs::write(p, json.to_string()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_state_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("icpc-state-{}", name));
        let _ = fs::create_dir_all(&dir);
        dir.join("widget.json")
    }

    #[test]
    fn default_values() {
        let s = WidgetState::default();
        assert_eq!(s.x, -1);
        assert_eq!(s.y, -1);
        assert!(!s.hidden);
    }

    #[test]
    fn roundtrip() {
        let p = tmp_state_file("roundtrip");
        let _ = fs::remove_file(&p);
        let s = WidgetState { x: 100, y: 200, hidden: true };
        save_to(&s, &p).unwrap();
        let loaded = load_from(&p);
        assert_eq!((loaded.x, loaded.y, loaded.hidden), (100, 200, true));
    }

    #[test]
    fn missing_file_returns_default() {
        let p = tmp_state_file("missing").join("nonexistent.json");
        let loaded = load_from(&p);
        assert_eq!((loaded.x, loaded.y), (-1, -1));
    }

    #[test]
    fn corrupt_json_returns_default() {
        let p = tmp_state_file("corrupt");
        fs::write(&p, "{ not json").unwrap();
        let loaded = load_from(&p);
        assert_eq!(loaded.x, -1);
    }

    #[test]
    fn partial_fields_use_defaults() {
        let p = tmp_state_file("partial");
        fs::write(&p, r#"{"x": 50}"#).unwrap();
        let loaded = load_from(&p);
        assert_eq!(loaded.x, 50);
        assert_eq!(loaded.y, -1);
        assert!(!loaded.hidden);
    }
}
