use crate::PORT_MAX;
use crate::PORT_MIN;
use std::time::Duration;

pub async fn check(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(400))
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
    // 全量并行探测（20 个端口同时发），按端口升序取第一个命中（最低端口优先）
    let tasks = (PORT_MIN..=PORT_MAX).map(|p| async move { (p, check(p).await) });
    futures::future::join_all(tasks)
        .await
        .into_iter()
        .find(|(_, ok)| *ok)
        .map(|(p, _)| p)
}
