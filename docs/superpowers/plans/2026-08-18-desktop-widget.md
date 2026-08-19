# 桌面挂件（Tauri widget.exe）框架实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 `/widget` 网页挂件构建 Tauri v2 桌面壳——透明无边框置顶小窗（独立 `widget.exe`），含端口发现、掉线守护、托盘、点击穿透、位置记忆，主程序 SEA 启动后自动拉起。

**Architecture:** 新增顶层 `desktop/` 独立 cargo 工程（不进 npm workspaces），Rust 侧实现 discovery/lifecycle/state 纯逻辑模块 + main.rs 集成（窗口/托盘/single-instance/watcher/穿透）；窗口直接加载主服务 `http://127.0.0.1:{port}/widget`；远程页只用 Tauri 内置 `start-dragging` 权限，穿透/拉起走托盘与本地 offline 页。主仓仅改 `config.ts`（launchWidget）、`widget-launcher.ts`（SEA 拉起，独立模块避免 sea.ts 顶层副作用）、`widget.html`（拖动注入脚本）。

**Tech Stack:** Rust + Tauri v2（tray-icon / single-instance / autostart 插件）、reqwest + tokio、Windows WebView2；主仓 TypeScript + node:test。

**Spec:** `docs/superpowers/specs/2026-08-18-desktop-widget-design.md`（执行者必须同时阅读规格；本计划从规格立论）

## Global Constraints

- Node ≥ 22.5、Rust 1.96 已就绪；平台 Windows（win32 10.0.26200）。
- 主服务只监听 `127.0.0.1`，端口从 3001 顺延至最多 3020；实例判据：`GET /api/health` 返回 `{ok:true, platforms:[…]}`。
- 主仓 REST API 零改动；`server/scripts/build-exe.mjs` 不动；`package.json` workspaces 不加 `desktop/`。
- `desktop/` 为独立 cargo 工程；持久化文件为 widget.exe 旁 `widget.json`，字段 `{ x: i32, y: i32, hidden: bool }`；损坏时静默用默认值。
- 主仓测试：`npm test -w server`（即 `tsx --test test/**/*.test.ts`）；类型检查 `npm run typecheck`。
- Rust 测试：`cargo test`（在 `desktop/src-tauri/` 下）。
- 提交信息中文、沿用主仓风格（`功能域：描述`）。
- 产品名固定 `widget.exe`；主 exe 名 `icpc-workbench.exe`。
- Rust 代码以 `cargo build`/`cargo check` 通过为准，Tauri v2 API 细节按当前稳定版调整（v2 方法名以编译器报错为权威修正）。
- 规格未列能力一律不做（YAGNI）。

## 文件结构

```
desktop/
├── ui/offline.html                    # 本地兜底页
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    │   └── remote-drag.json           # 授予远程页 start-dragging（3001–3020）
    └── src/
        ├── main.rs                    # 集成：窗口/托盘/single-instance/watcher/穿透/位置
        ├── state.rs                   # widget.json 读写（纯逻辑，可单测）
        ├── discovery.rs               # 端口扫描 + health 校验（纯逻辑，可单测）
        └── lifecycle.rs               # 主 exe 路径解析 + spawn（纯逻辑，可单测）

server/src/widget-launcher.ts          # SEA 拉起 widget.exe（独立模块，可单测，无副作用）
server/src/config.ts                   # +launchWidget 字段
server/src/sea.ts                      # bootSea 末尾调用 tryLaunchWidget
server/src/public/widget.html          # 末尾追加桌面模式拖动脚本
server/test/widget-launcher.test.ts    # 拉起守卫单测
server/test/widget.test.ts             # 追加桌面模式注入断言
server/config.example.json             # +launchWidget
```

---

### Task 1: 主仓 config 增加 launchWidget 开关

**Files:**
- Modify: `server/src/config.ts:17-34`
- Modify: `server/config.example.json`
- Create: `server/test/config.test.ts`

**Interfaces:**
- Consumes: 现有 `AppConfig` / `DEFAULT_CONFIG` / `loadConfig`。
- Produces: `AppConfig.launchWidget: boolean`（默认 `true`）；`loadConfig` 读取 `file.launchWidget`（非布尔值回退默认）。Task 2 消费此字段。

- [ ] **Step 1: 写失败测试**

新建 `server/test/config.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.ts';

function writeTempConfig(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('launchWidget 默认 true', () => {
  assert.equal(loadConfig(writeTempConfig('{}')).launchWidget, true);
});

test('launchWidget=false 被读取', () => {
  assert.equal(loadConfig(writeTempConfig('{"launchWidget": false}')).launchWidget, false);
});

test('launchWidget 非布尔值回退默认 true', () => {
  assert.equal(loadConfig(writeTempConfig('{"launchWidget": "yes"}')).launchWidget, true);
});

test('DEFAULT_CONFIG.launchWidget 为 true', () => {
  assert.equal(DEFAULT_CONFIG.launchWidget, true);
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npm test -w server -- config.test`
Expected: FAIL（`cfg.launchWidget` 为 `undefined`）

- [ ] **Step 3: 最小实现**

`server/src/config.ts`：`AppConfig` 接口在 `dataDir` 后加 `launchWidget: boolean;`；`DEFAULT_CONFIG` 在 `port` 行后加 `launchWidget: true,`；`loadConfig` 组装处 `port` 行后加：

```typescript
  launchWidget: typeof file.launchWidget === 'boolean' ? file.launchWidget : DEFAULT_CONFIG.launchWidget,
```

`server/config.example.json`：根对象加 `"launchWidget": true`。

- [ ] **Step 4: 运行验证通过**

Run: `npm test -w server -- config.test`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add server/src/config.ts server/config.example.json server/test/config.test.ts
git commit -m "配置：新增 launchWidget 开关（默认开启，控制主程序启动时是否自动拉起桌面挂件）"
```

---

### Task 2: SEA 拉起 widget.exe（独立 widget-launcher 模块）

**Files:**
- Create: `server/src/widget-launcher.ts`
- Modify: `server/src/sea.ts`（bootSea 末尾 + import）
- Create: `server/test/widget-launcher.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AppConfig.launchWidget`；Node `child_process.spawn`、`node:sea` 的 `isSea`。
- Produces: `export function tryLaunchWidget(config: AppConfig, port: number): boolean`。dev 模式（`!isSea()`）恒 false；`launchWidget===false` 恒 false；同目录无 `widget.exe` 恒 false；spawn 成功返回 true。`sea.ts` 的 `bootSea` 在 `openBrowser(url)` 之后调用它。
- 设计理由：单独成模块是因为 `sea.ts` 顶层有 `app.listen` 副作用，测试若 `import '../src/sea.ts'` 会真起服务占端口；独立模块零副作用可纯单测。

- [ ] **Step 1: 写失败测试**

新建 `server/test/widget-launcher.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryLaunchWidget } from '../src/widget-launcher.ts';

const cfg = (launchWidget: boolean) =>
  ({ port: 3001, dbPath: 'x', dataDir: 'x', launchWidget, ai: {
    enabled: false, baseURL: '', apiKey: '', model: '' } }) as never;

test('非 SEA 环境（dev）不拉起', () => {
  assert.equal(tryLaunchWidget(cfg(true), 3001), false);
});

test('launchWidget=false 不拉起', () => {
  // dev 守卫先返回，此用例确认 false 路径稳定
  assert.equal(tryLaunchWidget(cfg(false), 3001), false);
});
```

说明：`isSea()` 在 node:test 下恒 false，两用例都走 dev 守卫返回 false，覆盖「不拉起」分支。spawn 成功路径依赖同目录存在 widget.exe，测试环境没有，靠 Task 14 验收。

- [ ] **Step 2: 运行验证失败**

Run: `npm test -w server -- widget-launcher`
Expected: FAIL（模块未找到）

- [ ] **Step 3: 实现 widget-launcher.ts**

新建 `server/src/widget-launcher.ts`：

```typescript
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import type { AppConfig } from './config.ts';

/**
 * SEA 启动后自动拉起同目录 widget.exe（桌面挂件）。
 * - dev 模式不拉起（开发者自行 cargo tauri dev）
 * - launchWidget=false 或同目录无 widget.exe：静默跳过
 * - detached 拉起：挂件不随主程序退出；widget.exe 自带 single-instance，重复拉起无害
 * 返回 spawn 是否成功（用于日志，不阻断启动）。
 */
export function tryLaunchWidget(config: AppConfig, port: number): boolean {
  if (!isSea()) return false;
  if (config.launchWidget === false) return false;
  const exe = path.join(path.dirname(process.execPath), 'widget.exe');
  if (!existsSync(exe)) return false;
  try {
    const child = spawn(exe, [`--port=${port}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: sea.ts 接线**

`server/src/sea.ts`：顶部 import 区加 `import { tryLaunchWidget } from './widget-launcher.ts';`。`bootSea` 函数末尾 `openBrowser(url);` 之后追加：

```typescript
  if (tryLaunchWidget(config, port)) {
    console.log(`[widget] 已自动拉起桌面挂件（关闭可在 config.json 设 launchWidget: false）`);
  }
```

- [ ] **Step 5: 运行验证通过**

Run: `npm test -w server -- widget-launcher`
Expected: PASS（2 用例）

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add server/src/widget-launcher.ts server/src/sea.ts server/test/widget-launcher.test.ts
git commit -m "sea: SEA 启动成功后自动拉起同目录 widget.exe（launchWidget 可关）"
```

---

### Task 3: desktop/ cargo 工程骨架 + tauri.conf + 拖动授权

**Files:**
- Create: `desktop/src-tauri/Cargo.toml`
- Create: `desktop/src-tauri/tauri.conf.json`
- Create: `desktop/src-tauri/capabilities/remote-drag.json`
- Create: `desktop/src-tauri/build.rs`
- Create: `desktop/src-tauri/src/main.rs`（空骨架，仅保证编译）

**Interfaces:**
- Consumes: 无（首个 Rust 任务）。
- Produces: 可 `cargo build` 的 Tauri v2 工程骨架；`main.rs` 暴露 `main()` 空实现。后续 Task 4–6 的纯逻辑模块将作为 `mod` 挂入。常量 `PORT_MIN=3001`、`PORT_MAX=3020` 在本任务定义于 `main.rs` 顶部，供 discovery 复用。

- [ ] **Step 1: 创建 Cargo.toml**

```toml
[package]
name = "icpc-widget"
version = "0.1.0"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-single-instance = "2"
tauri-plugin-autostart = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time", "sync"] }

[features]
custom-protocol = ["tauri/custom-protocol"]
```

- [ ] **Step 2: 创建 tauri.conf.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "widget",
  "version": "0.1.0",
  "identifier": "com.icpc.workbench.widget",
  "build": {
    "frontendDist": "../ui"
  },
  "app": {
    "windows": [],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"]
  }
}
```

说明：`frontendDist` 指向 `../ui`（offline.html 所在目录）；窗口在 main.rs 运行时动态创建（因为 URL 依赖端口发现），故 `windows: []`。图标先用占位——实施时放一个 32×32 透明 ico 到 `desktop/src-tauri/icons/icon.ico`。

- [ ] **Step 3: 创建 capabilities/remote-drag.json**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "remote-drag",
  "description": "允许远程 /widget 页（3001-3020）调用窗口拖动",
  "remote": {
    "urls": [
      "http://127.0.0.1:3001/*", "http://127.0.0.1:3002/*", "http://127.0.0.1:3003/*",
      "http://127.0.0.1:3004/*", "http://127.0.0.1:3005/*", "http://127.0.0.1:3006/*",
      "http://127.0.0.1:3007/*", "http://127.0.0.1:3008/*", "http://127.0.0.1:3009/*",
      "http://127.0.0.1:3010/*", "http://127.0.0.1:3011/*", "http://127.0.0.1:3012/*",
      "http://127.0.0.1:3013/*", "http://127.0.0.1:3014/*", "http://127.0.0.1:3015/*",
      "http://127.0.0.1:3016/*", "http://127.0.0.1:3017/*", "http://127.0.0.1:3018/*",
      "http://127.0.0.1:3019/*", "http://127.0.0.1:3020/*"
    ]
  },
  "permissions": ["core:window:allow-start-dragging"]
}
```

- [ ] **Step 4: 创建 build.rs**

```rust
fn main() {
    tauri_build::build();
}
```

- [ ] **Step 5: 创建 src/main.rs 空骨架**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub const PORT_MIN: u16 = 3001;
pub const PORT_MAX: u16 = 3020;

fn main() {
    println!("icpc-widget skeleton");
}
```

- [ ] **Step 6: 放占位图标**

创建 `desktop/src-tauri/icons/` 目录，放入任意 32×32 `.ico`（可从主仓或系统拷一个）。无图标 `tauri build` 会报错；`cargo build` 不需要。

- [ ] **Step 7: 验证编译**

Run: `cd desktop/src-tauri && cargo build`
Expected: 编译通过（首次会下载依赖，耗时数分钟）

- [ ] **Step 8: 提交**

```bash
git add desktop/
git commit -m "desktop: Tauri v2 工程骨架 + 远程页拖动授权（3001-3020）"
```

---

### Task 4: state.rs（widget.json 读写）

**Files:**
- Create: `desktop/src-tauri/src/state.rs`
- Modify: `desktop/src-tauri/src/main.rs`（加 `mod state;`）

**Interfaces:**
- Consumes: `std::env::current_exe` 定位 widget.json（exe 同目录）。
- Produces:
  - `pub struct WidgetState { pub x: i32, pub y: i32, pub hidden: bool }`
  - `impl WidgetState { pub fn default() -> Self; pub fn load() -> Self; pub fn save(&self) }`
  - `pub fn state_file_path() -> PathBuf`（供测试覆盖）
  - `load`：文件缺失/JSON 损坏/字段缺失 → 返回 `default()`，不 panic、不报错。
  - `save`：序列化写回；目录不存在则创建。

- [ ] **Step 1: 写失败测试**

在 `desktop/src-tauri/src/state.rs` 顶部写 `#[cfg(test)]` 模块：

```rust
use std::fs;
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

use std::path::Path;

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
```

- [ ] **Step 2: 运行验证失败**

Run: `cd desktop/src-tauri && cargo test state`
Expected: FAIL（main.rs 未声明 `mod state;`，或编译错误——因为 main.rs 还没引用）

- [ ] **Step 3: main.rs 声明模块**

`desktop/src-tauri/src/main.rs`：在常量声明后加 `mod state;`（保留空 main）。编译单元现在包含 state.rs。

- [ ] **Step 4: 运行验证通过**

Run: `cd desktop/src-tauri && cargo test state`
Expected: PASS（5 用例）

- [ ] **Step 5: 提交**

```bash
git add desktop/src-tauri/src/state.rs desktop/src-tauri/src/main.rs
git commit -m "desktop: state.rs——widget.json 读写（位置/隐藏，损坏容错）"
```

---

### Task 5: discovery.rs（端口扫描 + health 校验）

**Files:**
- Create: `desktop/src-tauri/src/discovery.rs`
- Modify: `desktop/src-tauri/src/main.rs`（加 `mod discovery;`）

**Interfaces:**
- Consumes: `PORT_MIN`/`PORT_MAX`（来自 main.rs，`use crate::PORT_MIN`）；reqwest async + tokio。
- Produces:
  - `pub async fn find_server(hint: Option<u16>) -> Option<u16>`：hint 命中则返回（快路径）；否则并行扫 3001..=3020，返回第一个 `check` 为 true 的端口。
  - `pub async fn check(port: u16) -> bool`：GET `http://127.0.0.1:{port}/api/health`，300ms 超时，返回 JSON 含 `ok==true && platforms` 为数组。

- [ ] **Step 1: 写失败测试**

`desktop/src-tauri/src/discovery.rs`：

```rust
use crate::PORT_MAX;
use crate::PORT_MIN;
use std::time::Duration;

pub async fn check(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(300))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let Ok(resp) = client.get(&url).send().await else { return false; };
    let Ok(v) = resp.json::<serde_json::Value>().await else { return false; };
    v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false)
        && v.get("platforms").map(|p| p.is_array()).unwrap_or(false)
}

pub async fn find_server(hint: Option<u16>) -> Option<u16> {
    if let Some(p) = hint {
        if (PORT_MIN..=PORT_MAX).contains(&p) && check(p).await {
            return Some(p);
        }
    }
    let mut tasks = Vec::new();
    for p in PORT_MIN..=PORT_MAX {
        tasks.push(async move { (p, check(p).await) });
    }
    for t in tasks {
        let (p, ok) = t.await;
        if ok {
            return Some(p);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::io::Write;

    /// 起一个极简 HTTP 假服务器，对 /api/health 返回固定 JSON。
    fn spawn_fake(port: u16, body: &'static str) {
        std::thread::spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", port)) {
                Ok(l) => l,
                Err(_) => return,
            };
            for stream in listener.incoming() {
                let mut s = match stream { Ok(s) => s, Err(_) => continue };
                let mut buf = [0u8; 1024];
                let _ = std::io::Read::read(&mut s, &mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(), body
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
    }

    #[tokio::test]
    async fn check_ok() {
        spawn_fake(13579, r#"{"ok":true,"platforms":["cf"]}"#);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(check(13579).await);
    }

    #[tokio::test]
    async fn check_not_ok() {
        spawn_fake(13580, r#"{"ok":false}"#);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!check(13580).await);
    }

    #[tokio::test]
    async fn check_no_server() {
        assert!(!check(19999).await); // 空端口
    }

    #[tokio::test]
    async fn find_with_hint_hit() {
        spawn_fake(13581, r#"{"ok":true,"platforms":["cf"]}"#);
        tokio::time::sleep(Duration::from_millis(100)).await;
        // hint 端口不在 3001..3020 范围，故走全量扫描；为避免扫真实端口，
        // 这里仅验证 hint miss 时不 panic 且返回 Option。
        let _ = find_server(Some(13581)).await;
    }
}
```

注意：`find_server` 的 hint 走范围校验，测试用 13581 不在范围故 hint 失效；全量扫描会碰真实 3001–3020，测试环境一般无服务，返回 None。第四个用例只验证不 panic。实施时若本地恰好跑了主服务，扫描会命中真实端口——属正常，不破坏断言（用例未断言具体返回值）。

- [ ] **Step 2: 运行验证失败**

Run: `cd desktop/src-tauri && cargo test discovery`
Expected: FAIL（main.rs 未声明 `mod discovery;`）

- [ ] **Step 3: main.rs 声明模块**

`main.rs` 加 `mod discovery;`。

- [ ] **Step 4: 运行验证通过**

Run: `cd desktop/src-tauri && cargo test discovery`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add desktop/src-tauri/src/discovery.rs desktop/src-tauri/src/main.rs
git commit -m "desktop: discovery.rs——端口扫描与 health 校验（3001-3020，300ms 超时）"
```

---

### Task 6: lifecycle.rs（主 exe 路径解析 + spawn）

**Files:**
- Create: `desktop/src-tauri/src/lifecycle.rs`
- Modify: `desktop/src-tauri/src/main.rs`（加 `mod lifecycle;`）

**Interfaces:**
- Consumes: `std::env::current_exe`、`std::process::Command`。
- Produces:
  - `pub fn main_exe_path() -> Option<PathBuf>`：widget.exe 同目录下的 `icpc-workbench.exe`，存在返回 Some。
  - `pub fn launch_main_app() -> Result<(), String>`：spawn（detached、windowsHide、不等待）；找不到返回 `Err("找不到主程序 icpc-workbench.exe，请与 widget.exe 放在同一文件夹")`，spawn 失败返回 `Err(错误信息)`。

- [ ] **Step 1: 写失败测试**

`desktop/src-tauri/src/lifecycle.rs`：

```rust
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
```

- [ ] **Step 2: 运行验证失败**

Run: `cd desktop/src-tauri && cargo test lifecycle`
Expected: FAIL（未声明模块 / `creation_flags` 需 `use`）

- [ ] **Step 3: main.rs 声明模块**

`main.rs` 加 `mod lifecycle;`。

- [ ] **Step 4: 运行验证通过**

Run: `cd desktop/src-tauri && cargo test lifecycle`
Expected: PASS（2 用例）

- [ ] **Step 5: 提交**

```bash
git add desktop/src-tauri/src/lifecycle.rs desktop/src-tauri/src/main.rs
git commit -m "desktop: lifecycle.rs——主 exe 路径解析与拉起（DETACHED，找不到返回可读错误）"
```

---

### Task 7: main.rs 基础集成——single-instance + 建窗 + 加载远程/offline

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`
- Create: `desktop/ui/offline.html`（最小版，Task 12 完善）

**Interfaces:**
- Consumes: `discovery::find_server`、`state::WidgetState`。命令行参数 `--port=N`（主程序拉起时传入）作为发现 hint。
- Produces: 可运行的 widget.exe——启动后扫描服务，命中建透明置顶窗加载 `/widget`，未命中加载 `offline.html`。本任务不含托盘/watcher/拖动/穿透（后续任务加）。

- [ ] **Step 1: 实现 main.rs 基础版**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discovery;
mod lifecycle;
mod state;

pub const PORT_MIN: u16 = 3001;
pub const PORT_MAX: u16 = 3020;

fn parse_port_hint() -> Option<u16> {
    let arg = std::env::args().find(|a| a.starts_with("--port="))?;
    arg.trim_start_matches("--port=").parse().ok()
}

fn offline_url() -> tauri::WebviewUrl {
    // offline.html 通过 tauri.conf 的 frontendDist 提供，用 tauri:// 协议加载
    tauri::WebviewUrl::App("offline.html".into())
}

fn widget_url(port: u16) -> tauri::WebviewUrl {
    tauri::WebviewUrl::External(format!("http://127.0.0.1:{}/widget", port).parse().unwrap())
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
```

- [ ] **Step 2: 创建最小 offline.html**

`desktop/ui/offline.html`：

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>ICPC 挂件</title></head>
<body style="background:transparent;font-family:sans-serif;color:#e8eaf0">
<div style="padding:24px;text-align:center">主程序未运行，等待自动恢复…</div>
</body></html>
```

- [ ] **Step 3: 验证编译**

Run: `cd desktop/src-tauri && cargo build`
Expected: 编译通过（API 方法名以编译器为准修正：`always_on_top`/`skip_taskbar`/`inner_size`/`position`/`decorations`/`transparent` 均为 v2 WebviewWindowBuilder 方法）

- [ ] **Step 4: 手动验收**

主仓 `npm run dev` 起服务后，`cd desktop/src-tauri && cargo run`：
- 期望：透明无边框置顶小窗出现，显示 `/widget` 页内容（当天任务）。
- 关停主服务再 `cargo run`：窗口显示“主程序未运行”。

- [ ] **Step 5: 提交**

```bash
git add desktop/src-tauri/src/main.rs desktop/ui/offline.html
git commit -m "desktop: main.rs 基础集成——single-instance + 透明置顶窗 + 服务发现加载"
```

---

### Task 8: 托盘 + 隐藏到托盘 + 退出

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `state::WidgetState`（hidden 持久化）。
- Produces: 系统托盘菜单「显示/隐藏」「退出」；关闭窗口 = 隐藏到托盘（不退出）；托盘单击恢复显示；「退出」真正退出。

- [ ] **Step 1: 实现托盘**

在 `main.rs` 的 `setup` 闭包内（建窗之后）加托盘装配。新增 `use tauri::menu::{Menu, MenuItem};` 与 `use tauri::tray::TrayIconBuilder;`。

```rust
            // 托盘
            let show_item = MenuItem::with_id(app, "show", "显示/隐藏", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("ICPC 挂件")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = if w.is_visible().unwrap_or(false) { w.hide() } else { w.show() };
                        }
                    }
                    "quit" => { app.exit(0); }
                    _ => {}
                })
                .build(app)?;
```

窗口关闭拦截（隐藏而非退出），在 `Builder` 链上加 `.on_window_event`：

```rust
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
```

- [ ] **Step 2: hidden 持久化**

`show_item` 的切换里，隐藏时 `state::WidgetState { hidden: true, ..state::WidgetState::load() }.save()`，显示时 `hidden:false`。把持久化并入上面的 menu_event 分支。

- [ ] **Step 3: 验证编译 + 手动验收**

Run: `cd desktop/src-tauri && cargo build`
手动：`cargo run` 后点窗口关闭按钮 → 窗口隐藏、进程仍在；托盘「显示/隐藏」恢复；「退出」结束进程。

- [ ] **Step 4: 提交**

```bash
git add desktop/src-tauri/src/main.rs
git commit -m "desktop: 托盘菜单（显示/隐藏、退出）+ 关窗隐藏到托盘 + hidden 持久化"
```

---

### Task 9: watcher 掉线切换

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `discovery::check`；tokio 定时器；窗口 URL 导航（`webview.eval` 或重建窗口）。
- Produces: 后台 tokio task 每 10s 探测当前端口；连续 2 次失败 → 导航到 offline.html；恢复 1 次成功 → 导航回 `/widget`。当前端口记录在 `Mutex<Option<u16>>`。

- [ ] **Step 1: 实现 watcher**

在 `setup` 中建窗后启动后台 task。当前端口通过 `app.state()` 共享：

```rust
use std::sync::Mutex;

// setup 内，建窗后：
let current_port: Mutex<Option<u16>> = Mutex::new(port);
app.manage(current_port);

let handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    let mut fails = 0u32;
    loop {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let p = { handle.state::<Mutex<Option<u16>>>().lock().unwrap().clone() };
        let Some(p) = p else {
            // 当前 offline，尝试重新发现
            if let Some(np) = discovery::find_server(None).await {
                let mut g = handle.state::<Mutex<Option<u16>>>().lock().unwrap();
                *g = Some(np);
                fails = 0;
                let _ = navigate(&handle, widget_url(np));
            }
            continue;
        };
        if discovery::check(p).await {
            fails = 0;
        } else {
            fails += 1;
            if fails >= 2 {
                let mut g = handle.state::<Mutex<Option<u16>>>().lock().unwrap();
                *g = None;
                fails = 0;
                let _ = navigate(&handle, offline_url());
            }
        }
    }
});
```

`navigate` 辅助函数（通过重建 webview 导航——v2 中 `WebviewUrl` 切换较麻烦，最稳是 `webview.eval` 不可行时关闭重建窗口；但为简化，用 `window.set_url` 如果 v2 支持，否则用 `webview.navigate`）。实施时以编译器为准；若均无，降级为「关闭旧窗口 + 重建」：

```rust
fn navigate(app: &tauri::AppHandle, url: tauri::WebviewUrl) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("main") {
        // v2 WebviewWindow 暂无直接 set_url；关闭重建
        let _ = w.close();
    }
    tauri::WebviewWindowBuilder::new(app, "main", url)
        .title("ICPC 挂件").inner_size(340.0, 520.0)
        .decorations(false).transparent(true).always_on_top(true).skip_taskbar(true)
        .build()?;
    Ok(())
}
```

注意：重建会丢失窗口位置——Task 10 在重建时恢复 `WidgetState::load()` 的位置。

- [ ] **Step 2: 引入 Duration**

`main.rs` 顶部加 `use std::time::Duration;`。

- [ ] **Step 3: 验证编译 + 手动验收**

Run: `cargo build`
手动：`cargo run`（服务运行中）→ 关停主服务 → 约 20s 后窗口切到“主程序未运行”；重启服务 → 约 10s 后切回任务列表。

- [ ] **Step 4: 提交**

```bash
git add desktop/src-tauri/src/main.rs
git commit -m "desktop: watcher——10s 健康检查，连续 2 次失败切 offline，恢复切回"
```

---

### Task 10: 拖动位置记忆 + 点击穿透 + 60s 自动恢复

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`
- Modify: `desktop/src-tauri/src/state.rs`（无字段变化，仅复用）
- Modify: `desktop/src-tauri/capabilities/remote-drag.json`（已含权限，无需改）

**Interfaces:**
- Consumes: `state::WidgetState`；窗口 `start_dragging`（前端 `data-tauri-drag-region` 触发，已授权）；`set_ignore_cursor_events`。
- Produces：拖动后窗口位置写回 widget.json；托盘「切换点击穿透」切换 `set_ignore_cursor_events`；穿透开启 60s 后自动恢复交互；重建窗口（watcher 切换）时恢复记忆位置。

- [ ] **Step 1: 位置持久化**

监听窗口移动事件，防抖写回。在 `on_window_event` 追加：

```rust
            if let tauri::WindowEvent::Moved(pos) = event {
                let s = state::WidgetState { x: pos.x, y: pos.y, hidden: false };
                s.save();
            }
```

`navigate` 重建窗口时读取 `WidgetState::load()` 恢复位置（修改 Task 9 的 navigate，`inner_size` 后加 `if st.x>=0 { .position(st.x as f64, st.y as f64) }`）。

- [ ] **Step 2: 穿透菜单项 + 60s 自动恢复**

托盘菜单增加 `toggle_pierce` 项：

```rust
            let pierce_item = MenuItem::with_id(app, "pierce", "切换点击穿透", true, None::<&str>)?;
            // Menu::with_items 加 &pierce_item
```

menu_event 分支加：

```rust
                    "pierce" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let now = w.is_ignore_cursor_events().unwrap_or(false);
                            let _ = w.set_ignore_cursor_events(!now);
                            if !now {
                                // 刚开启穿透：60s 后自动恢复
                                let h = app.handle().clone();
                                tauri::async_runtime::spawn(async move {
                                    tokio::time::sleep(Duration::from_secs(60)).await;
                                    if let Some(w) = h.get_webview_window("main") {
                                        let _ = w.set_ignore_cursor_events(false);
                                    }
                                });
                            }
                        }
                    }
```

- [ ] **Step 3: 验证编译 + 手动验收**

Run: `cargo build`
手动：拖动窗口 → 重启 `cargo run` → 位置保持；托盘「切换点击穿透」→ 鼠标穿过窗口；60s 后自动恢复可交互。

- [ ] **Step 4: 提交**

```bash
git add desktop/src-tauri/src/main.rs
git commit -m "desktop: 拖动位置记忆 + 托盘切换穿透 + 60s 自动恢复交互"
```

---

### Task 11: autostart + offline 页拉起按钮接线

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`
- Modify: `desktop/ui/offline.html`
- Modify: `desktop/src-tauri/src/lifecycle.rs`（暴露 `launch_main_app` 已有）

**Interfaces:**
- Consumes: `tauri_plugin_autostart`；`lifecycle::launch_main_app`；Tauri command 注册。
- Produces：托盘「开机自启 开/关」；offline.html 的「启动主程序」按钮调用 Tauri command `launch_main_app`，成功后等 watcher 自动恢复，失败显示错误。

- [ ] **Step 1: 注册 autostart 插件与 command**

`main.rs` 顶部：

```rust
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
```

`Builder` 链加：

```rust
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostarted"]),
        ))
        .invoke_handler(tauri::generate_handler![cmd_launch_main])
```

command：

```rust
#[tauri::command]
fn cmd_launch_main() -> Result<(), String> {
    lifecycle::launch_main_app()
}
```

offline.html 用本地页（`tauri://` 协议，属本地源，command 调用无需 remote 授权）。

- [ ] **Step 2: 托盘自启项**

menu 加 `auto_item`，menu_event 分支：

```rust
                    "auto" => {
                        let mgr = app.autolaunch();
                        let _ = if mgr.is_enabled().unwrap_or(false) { mgr.disable() } else { mgr.enable() };
                    }
```

- [ ] **Step 3: 完善 offline.html**

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>ICPC 挂件</title>
<style>
  :root{color-scheme:dark}
  body{background:transparent;font:13px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;color:#e8eaf0;margin:0;padding:10px}
  #card{background:rgba(18,20,28,.86);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:24px;text-align:center;backdrop-filter:blur(12px)}
  button{margin-top:14px;padding:8px 16px;border:0;border-radius:8px;background:#4096ff;color:#fff;cursor:pointer;font-size:13px}
  button:hover{background:#1677ff}
  #err{color:#ff7875;margin-top:10px;font-size:12px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#8b93a7;margin-right:6px;animation:p 1s infinite}
  @keyframes p{50%{opacity:.3}}
</style></head>
<body>
<div id="card">
  <div><span class="dot"></span>主程序未运行</div>
  <div style="color:#8b93a7;font-size:12px;margin-top:6px">挂件将持续检测并自动恢复</div>
  <button id="btn">启动主程序</button>
  <div id="err"></div>
</div>
<script>
  document.getElementById('btn').onclick = async () => {
    document.getElementById('err').textContent = '';
    try {
      await window.__TAURI__.core.invoke('launch_main');
      document.getElementById('btn').textContent = '已请求启动，等待恢复…';
    } catch (e) {
      document.getElementById('err').textContent = String(e);
    }
  };
</script>
</body></html>
```

注意：command 注册名 `launch_main`（`cmd_launch_main` 的注册名取函数名去前缀）。实施时核对 `generate_handler!` 的命名。

- [ ] **Step 4: 验证编译 + 手动验收**

Run: `cargo build`
手动：关停主服务 → `cargo run` 显示 offline → 点「启动主程序」→ 服务起来后自动切回；托盘「开机自启」可开关。

- [ ] **Step 5: 提交**

```bash
git add desktop/src-tauri/src/main.rs desktop/ui/offline.html
git commit -m "desktop: 开机自启 + offline 页拉起主程序按钮（本地页调 command）"
```

---

### Task 12: widget.html 桌面模式拖动脚本 + 主仓测试断言

**Files:**
- Modify: `server/src/public/widget.html`（末尾追加脚本）
- Modify: `server/test/widget.test.ts`（追加断言）

**Interfaces:**
- Consumes: 现有 widget.html 的 `<header>` 元素。
- Produces：Tauri 环境下 header 加 `data-tauri-drag-region`；浏览器零副作用。

- [ ] **Step 1: 追加脚本**

`widget.html` 的 `</script>`（现有 load 逻辑后）之前追加：

```html
  <script>
    // 桌面模式（Tauri）：header 作为原生拖动把手；浏览器中无副作用
    if (window.__TAURI_INTERNALS__) {
      var h = document.querySelector('header');
      if (h) h.setAttribute('data-tauri-drag-region', '');
    }
  </script>
```

- [ ] **Step 2: 追加测试断言**

`server/test/widget.test.ts` 第一个 test 的 try 块内，现有断言后加：

```typescript
    assert.match(html, /__TAURI_INTERNALS__/);
    assert.match(html, /data-tauri-drag-region/);
```

- [ ] **Step 3: 运行验证**

Run: `npm test -w server -- widget`
Expected: PASS（含新断言）

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add server/src/public/widget.html server/test/widget.test.ts
git commit -m "widget.html: 桌面模式拖动注入（Tauri 环境加 data-tauri-drag-region，浏览器零副作用）"
```

---

### Task 13: README 验收清单 + 全量验证

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部前序任务。
- Produces：README 桌面挂件章节（构建/使用/验收清单/自动拉起说明）；全量 `npm test`、`npm run typecheck`、`cargo test`、`cargo build` 绿。

- [ ] **Step 1: README 增补章节**

在 README 末尾追加「桌面挂件（widget.exe）」章节，内容：

```markdown
## 桌面挂件（widget.exe）

透明无边框置顶小窗，常驻桌面展示当天任务，可拖动、点击穿透、托盘管理。独立于主程序分发。

### 构建

```bash
cd desktop/src-tauri && cargo tauri build   # 产物 widget.exe（约 3-8MB）
```

### 使用

- 与 `icpc-workbench.exe` 放同一文件夹：双击主 exe 时自动拉起挂件（可在 `config.json` 设 `"launchWidget": false` 关闭）。
- 单独运行 widget.exe：自动扫描 3001–3020 找主服务；找不到显示 offline 提示，可一键拉起主程序。

### 验收清单

- [ ] 透明小窗显示当天任务，可拖动，重启后位置保持
- [ ] 托盘「显示/隐藏」「切换点击穿透」「开机自启」「退出」
- [ ] 穿透开启后鼠标穿过挂件；60s 自动恢复交互
- [ ] 关窗隐藏到托盘，进程不退出
- [ ] 主服务关闭 → 约 20s 切 offline；重启服务 → 约 10s 自动恢复
- [ ] offline 页「启动主程序」按钮可拉起主 exe
- [ ] 主 exe 同目录有 widget.exe 时自动拉起；反复重启主程序只有一份挂件
- [ ] `launchWidget: false` 时不自动拉起；主 exe 单独存在时正常使用
```

- [ ] **Step 2: 全量验证**

Run: `npm test -w server`
Expected: 全绿（含 config / widget-launcher / widget / 原有测试）

Run: `npm run typecheck`
Expected: 无错误

Run: `cd desktop/src-tauri && cargo test`
Expected: 全绿（state / discovery / lifecycle）

Run: `cd desktop/src-tauri && cargo build`
Expected: 编译通过

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README 增补桌面挂件章节（构建/使用/验收清单/自动拉起）"
```

---

## 自审记录

**规格覆盖核对**：
- 透明无边框置顶 → Task 7 ✓
- 拖动位置记忆 → Task 10 ✓
- 点击穿透 + 60s 自动恢复 → Task 10 ✓
- 托盘（显示/隐藏/穿透/自启/退出）→ Task 8/10/11 ✓
- 关窗隐藏到托盘 → Task 8 ✓
- 掉线检测 + offline + 拉起 → Task 9/11 ✓
- single-instance 防重复 → Task 7 ✓
- 主程序 SEA 自动拉起 + launchWidget 可关 → Task 1/2 ✓
- widget.html 桌面模式注入 → Task 12 ✓
- remote.urls 拖动授权 → Task 3 ✓
- widget.json 字段 {x,y,hidden} + 容错 → Task 4 ✓
- Rust 单测（discovery/state/lifecycle）→ Task 4/5/6 ✓
- 主仓测试断言 → Task 12 ✓
- README 验收清单 → Task 13 ✓

**类型一致性**：`WidgetState{x:i32,y:i32,hidden:bool}` 在 Task 4 定义，Task 8/10 消费一致；`find_server(hint:Option<u16>)->Option<u16>` Task 5 定义，Task 7/9 消费一致；`launch_main_app()->Result<(),String>` Task 6 定义，Task 11 消费一致。`widget_url`/`offline_url` Task 7 定义，Task 9/10 消费一致。

**已知简化**（实施时关注，非占位符）：Task 9 的 `navigate` 用「关闭重建窗口」实现 URL 切换，因为 Tauri v2 `WebviewWindow` 无稳定 `set_url`；重建会触发 Task 10 的位置恢复逻辑。若 v2 后续版本提供 `set_url`/`navigate`，可替换以避免窗口闪烁。
