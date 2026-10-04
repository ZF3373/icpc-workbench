use crate::PORT_MAX;
use crate::PORT_MIN;
use std::sync::OnceLock;
use std::time::Duration;

/// 单次健康探测超时。核心是单线程 Node 事件循环，同步 SQLite（node:sqlite 全同步 API）、
/// VACUUM INTO 备份、大结果集序列化都会短暂阻塞响应——超时太短会把正常卡顿误判成掉线，
/// 壳随即整页重载，用户看到的就是「工作台莫名重启」（issue #39）。回环地址没有真丢包，
/// 宽松超时只拖慢「进程在但不响应」的极端场景，不影响「进程已死」（连接立即被拒）的判定速度。
const PROBE_TIMEOUT: Duration = Duration::from_millis(2500);

/// 共享 HTTP 客户端：探活每次都新建 Client 会在 20 端口并行扫描时重复构建连接池。
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(PROBE_TIMEOUT)
            .build()
            .expect("构建健康探测 HTTP 客户端失败")
    })
}

pub async fn check(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let Ok(resp) = client().get(&url).send().await else { return false; };
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
