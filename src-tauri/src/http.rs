//! 通用 HTTP 通道（大模型对接 + 自动更新清单拉取）。
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

/// 构建带超时的 Client（POST/GET 两个命令共用：每次调用新建，换取无全局状态）。
fn build_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(timeout)
        .build()
        .map_err(|error| format!("HTTP 客户端构建失败：{error}"))
}

/// 读取响应正文（状态码原样回传不算错误，正文超限截断）——POST/GET 共用。
async fn read_text_body(mut response: reqwest::Response) -> Result<HttpPostOutcome, String> {
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
    let client = build_client(timeout)?;

    let mut request = client.post(&url);
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    let response = request
        .body(body)
        .send()
        .await
        .map_err(|error| describe_transport_error(&error, timeout, "Agent"))?;
    read_text_body(response).await
}

/// GET 文本通道（自动更新清单等小正文拉取，design-auto-update §10.2）。
///
/// 与 `http_post_json` 完全同构的契约：状态码原样回传不算错误、仅传输层故障
/// reject、宿主强制超时。错误通道名用 "HTTP"（与 Agent POST 区分来源）。
#[tauri::command]
pub async fn http_get_text(
    url: String,
    headers: Vec<(String, String)>,
    timeout_ms: Option<u64>,
) -> Result<HttpPostOutcome, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(200));
    let client = build_client(timeout)?;
    let mut request = client.get(&url);
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| describe_transport_error(&error, timeout, "HTTP"))?;
    read_text_body(response).await
}

/// 传输层故障的可读化（TS 侧只按「reject = 通道故障」分类，不解析消息文本）。
///
/// **必须剥离 URL**（S-05）：`reqwest::Error` 的 `Display` 实现会写出
/// ` for url (<完整 URL>)`，而 OpenAI 兼容端点常见 `?api-key=xxx` / `?key=xxx`
/// 形态的鉴权 —— 连接失败时密钥会经由 `Err` 字符串回传前端，若前端恰好记日志
/// 就落进了日志文件。`without_url()` 保留错误分类信息但不含 URL。
///
/// Rust 侧**不打印**该错误串（错误只回传前端），所以这里剥离是最后一道闸；
/// 真要根治还需 TS 侧校验 URL 来源（`agent-http.ts` 的 `assertAllowedHost`
/// 已拦公网 IP 字面量，但域名形式仍放行）。
///
/// `channel` 为业务域前缀（"Agent" = 大模型通道 / "HTTP" = 通用 GET 与更新下载），
/// 让日志里能区分故障来源；update.rs 的下载通道复用本函数。
pub(crate) fn describe_transport_error(error: &reqwest::Error, timeout: Duration, channel: &str) -> String {
    // `without_url` 取所有权而 `reqwest::Error` 不实现 Clone/Copy，
    // 而本函数的入参是 `&Error`（多处复用），所以拿不到所有权。
    // 改为格式化后**剥掉 Display 尾部的 ` for url (...)` 段**——
    // reqwest 的 Display 形态固定为 `<原因> for url (<URL>)`，
    // 截断到 " for url (" 之前即可，URL（含可能带密钥的 query）不会进消息。
    let raw = error.to_string();
    let detail = match raw.find(" for url (") {
        Some(at) => raw[..at].trim_end().to_string(),
        None => raw,
    };
    if error.is_timeout() {
        format!("{channel} 请求超时（{}ms）：{detail}", timeout.as_millis())
    } else if error.is_connect() {
        format!("{channel} 连接失败：{detail}")
    } else {
        format!("{channel} 请求失败：{detail}")
    }
}
