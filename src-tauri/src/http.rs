//! 通用 HTTP JSON POST 通道（大模型对接，`docs/design-llm-connection-2026-10-02.md` §11）。
//!
//! 为什么需要宿主通道：大模型服务（阿里云 MaaS compatible-mode 等 OpenAI 兼容端点）
//! 不返回 CORS 头（2026-10-04 实测：预检 401 且无 Access-Control-Allow-Origin），
//! WebView 里的 `window.fetch` 会被浏览器层拦截。与 `cli_run` 同构：Rust 只做薄转发，
//! URL/鉴权头/请求体全部由 TS 侧组装（`src/infra/agent/agent-http.ts`），本命令
//! 不理解任何业务协议，也不含任何业务规则。
//!
//! 契约（与 TS Bridge 侧一致）：
//!  * 收到 HTTP 响应（含 4xx/5xx）**不算错误**：状态码与正文原样回传，业务判定在 TS；
//!  * 只有传输层故障（DNS/TLS 握手/连接失败/超时）才 reject（Err）；
//!  * 超时在宿主侧强制生效：TS 层超时判定后，请求也不会在后台无限占用连接。

use std::time::Duration;

use serde::Serialize;

/// 响应正文上限（同 cli.rs MAX_OUTPUT 的 2 MB）：LLM 回复远小于此，仅防异常服务洪泛。
const MAX_BODY: usize = 2 * 1024 * 1024;
/// 默认超时：60s（与 agent 设置默认一致）。Rust 侧兜底，TS 侧可按需调整。
const DEFAULT_TIMEOUT_MS: u64 = 60_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpPostOutcome {
    /// HTTP 状态码（4xx/5xx 原样回传，成败由 TS 侧按业务判定）
    pub status: u16,
    /// 响应正文（UTF-8；超出上限截断，截断后 JSON 解析会失败并按调用方兜底处理）
    pub body: String,
}

/// 以宿主进程身份 POST JSON（Agent 大模型通道）。
///
/// reqwest 已是 tauri 的传递依赖，这里显式声明只为打开 native-tls 特性：
/// TLS 交给系统 schannel（Windows 组件，不新增可分发 DLL，证书走系统库）。
/// 每次调用新建 Client：轮询场景低频（每分钟数条）开销可忽略，换来无全局状态。
#[tauri::command]
pub async fn http_post_json(
    url: String,
    headers: Vec<(String, String)>,
    body: String,
    timeout_ms: Option<u64>,
) -> Result<HttpPostOutcome, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(200));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
        .map_err(|error| format!("HTTP 客户端构建失败：{error}"))?;

    let mut request = client.post(&url);
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    let mut response = request
        .body(body)
        .send()
        .await
        .map_err(|error| describe_transport_error(&error, timeout))?;

    let status = response.status().as_u16();
    let mut raw: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("读取响应失败：{error}"))?
    {
        let room = MAX_BODY.saturating_sub(raw.len());
        let take = room.min(chunk.len());
        raw.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            break; // 超限截断：停止读取并丢弃连接余量
        }
    }
    Ok(HttpPostOutcome {
        status,
        body: String::from_utf8_lossy(&raw).into_owned(),
    })
}

/// 传输层故障的可读化（TS 侧只按「reject = 通道故障」分类，不解析消息文本）。
fn describe_transport_error(error: &reqwest::Error, timeout: Duration) -> String {
    if error.is_timeout() {
        format!("Agent 请求超时（{}ms）：{error}", timeout.as_millis())
    } else if error.is_connect() {
        format!("Agent 连接失败：{error}")
    } else {
        format!("Agent 请求失败：{error}")
    }
}
