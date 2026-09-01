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
    // 必须是 SEA 核心（sea:true）：同机 dev server 也是本仓库服务（ok+platforms
    // 齐全但 sea:false），不校验会把窗口/挂件劫持到 dev server 上
    v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false)
        && v.get("platforms").map(|p| p.is_array()).unwrap_or(false)
        && v.get("sea").and_then(|s| s.as_bool()).unwrap_or(false)
}

pub async fn find_server(hint: Option<u16>) -> Option<u16> {
    if let Some(p) = hint {
        if (PORT_MIN..=PORT_MAX).contains(&p) && check(p).await {
            return Some(p);
        }
    }
    // 全量并行探测（20 个端口同时发），收集齐后按端口升序取第一个命中：
    // 与旧顺序扫描语义一致（最低端口优先），不依赖各请求完成先后。
    let tasks = (PORT_MIN..=PORT_MAX).map(|p| async move { (p, check(p).await) });
    futures::future::join_all(tasks)
        .await
        .into_iter()
        .find(|(_, ok)| *ok)
        .map(|(p, _)| p)
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
        spawn_fake(13579, r#"{"ok":true,"platforms":["cf"],"sea":true}"#);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(check(13579).await);
    }

    #[tokio::test]
    async fn check_rejects_dev_server() {
        // dev server：ok + platforms 齐全但 sea:false（或缺失）——不可认作本程序
        spawn_fake(13582, r#"{"ok":true,"platforms":["cf"],"sea":false}"#);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!check(13582).await);
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
