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
    // sea === true 必须一起校验（与服务端 instance-health.ts 同口径）：
    // 3001..3020 上完全可能蹲着 tsx dev server（sea:false）或另一份安装的核心，
    // 只看 ok+platforms 会让壳把窗口挂到一个「不是它拉起的、数据目录也可能不同」的实例上。
    v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false)
        && v.get("platforms").map(|p| p.is_array()).unwrap_or(false)
        && v.get("sea").and_then(|s| s.as_bool()).unwrap_or(false)
}

/// 读核心写下的 data/runtime.json，取出上一次/本次运行的实际端口（issue #66）。
///
/// 为什么先看它：核心允许端口漂移（3001 被占就往后试），而壳的扫描范围只有
/// PORT_MIN..=PORT_MAX。默认端口被别的程序（含另一份安装）长期占用时，
/// 核心会落到扫描范围之外，壳就永远探不到，页面停在「本地服务未响应」——
/// 用户双击 icpc-core.exe 却一切正常。文件里带 pid，用来剔除上次运行留下的僵尸记录。
///
/// 只在文件声明的端口确实能探通时才采信：文件是磁盘上的普通 JSON，可能过期（上次运行
/// 异常退出没删掉）、也可能被用户手改；探不通就当它不存在，退回范围扫描。
pub async fn runtime_port() -> Option<u16> {
    let path = crate::exe_dir().join("data").join("runtime.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let port = v.get("port")?.as_u64()?;
    if port == 0 || port > 65535 {
        return None;
    }
    let port = port as u16;
    if check(port).await {
        return Some(port);
    }
    None
}

pub async fn find_server(hint: Option<u16>) -> Option<u16> {
    if let Some(p) = hint {
        if check(p).await {
            return Some(p);
        }
    }
    // 再试核心自己记下的实际端口（可能落在 PORT_MIN..=PORT_MAX 之外）
    if let Some(p) = runtime_port().await {
        return Some(p);
    }
    // 全量并行探测（20 个端口同时发），按端口升序取第一个命中（最低端口优先）
    let tasks = (PORT_MIN..=PORT_MAX).map(|p| async move { (p, check(p).await) });
    futures::future::join_all(tasks)
        .await
        .into_iter()
        .find(|(_, ok)| *ok)
        .map(|(p, _)| p)
}
