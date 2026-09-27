//! 通用子进程通道（D1：Rust 只做薄管道，命令名与参数拼装全在 TS）。
//!
//! 为什么是 async + spawn_blocking（D9）：
//! Tauri 的同步命令在 WebView 主线程上执行，而 cli_run 要阻塞等待子进程（最长 15s），
//! 会直接把 UI 卡死（白屏/掉帧）。因此命令声明为 async，进程逻辑丢进阻塞线程池。
//!
//! 安全与可靠性要点：
//!  * **白名单**：仅放行文件主干为 `welink-cli` 的可执行文件，其余一律拒绝；
//!  * args 以数组传递、**不经 shell**，杜绝命令注入；
//!  * Windows 下 `CREATE_NO_WINDOW`，不弹黑框；
//!  * stdout/stderr 各截断到 [`MAX_OUTPUT`]，超出部分继续读走丢弃 —— 不这样做的话
//!    子进程会因管道写满而永久阻塞；
//!  * 超时（默认 [`DEFAULT_TIMEOUT_MS`]）强杀进程并回收管道；
//!  * 输出以 **base64** 回传：编码判定（UTF-8 严格失败 → GBK 兜底）留给 TS 侧
//!    （`src/utils/b64.ts`），Rust 不做编码猜测，也不因非法字节丢掉输出。
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// 单路输出上限（设计 §9：2 MB）。防止子进程输出洪泛撑爆 IPC 载荷。
const MAX_OUTPUT: usize = 2 * 1024 * 1024;
/// 默认超时：15s（设计 §9）。Rust 侧兜底，TS 侧可按需缩短/放宽。
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
/// 仅允许此主干名的可执行文件（不含扩展名，大小写不敏感）。
const ALLOWED_STEM: &str = "welink-cli";
/// Windows CREATE_NO_WINDOW：不创建控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliOutcome {
    /// 退出码；进程被超时强杀时为 None
    pub exit_code: Option<i32>,
    /// stdout 原始字节的 base64（TS 侧解码，UTF-8 → GBK 兜底）
    pub stdout: String,
    /// stderr 原始字节的 base64
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// 白名单校验：取文件主干名比对，大小写不敏感。
/// 允许绝对路径（用户自配 cliPath），但主干名必须是 welink-cli.exe / welink-cli。
fn assert_allowed(program: &str) -> Result<(), String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err("未配置 CLI 路径（cliPath 为空）".to_string());
    }
    let stem = Path::new(trimmed)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    if stem.eq_ignore_ascii_case(ALLOWED_STEM) {
        Ok(())
    } else {
        Err(format!(
            "程序名不在白名单内：{stem}（仅允许 {ALLOWED_STEM}）"
        ))
    }
}

/// 读一路输出：读到上限后继续读取并丢弃，保证子进程不会因管道写满而阻塞。
fn read_limited(mut stream: impl Read + Send + 'static) -> (Vec<u8>, bool) {
    let mut head = Vec::with_capacity(8 * 1024);
    let mut buffer = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if head.len() < MAX_OUTPUT {
                    let room = MAX_OUTPUT - head.len();
                    let take = room.min(count);
                    head.extend_from_slice(&buffer[..take]);
                    if take < count {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    (head, truncated)
}

/// 标准 base64（无换行）。自实现而非引第三方 crate：本项目要求离线打包，
/// 少一个依赖就少一处缓存/许可风险，编码器本身只有二十行。
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0] as u32;
        let second = *chunk.get(1).unwrap_or(&0) as u32;
        let third = *chunk.get(2).unwrap_or(&0) as u32;
        let packed = (first << 16) | (second << 8) | third;
        out.push(TABLE[((packed >> 18) & 63) as usize] as char);
        out.push(TABLE[((packed >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((packed >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(packed & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 阻塞执行子进程（在 spawn_blocking 线程里跑）。
fn run_blocking(program: &str, args: &[String], timeout: Duration) -> Result<CliOutcome, String> {
    let started = Instant::now();
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("启动子进程失败：{error}"))?;

    // 两路输出各开一个读线程：同一线程里顺序读会在其中一个管道写满时死等，
    // 而超时判定又必须能持续推进（否则「超时强杀」形同虚设）。
    let stdout_stream = child.stdout.take();
    let stderr_stream = child.stderr.take();
    let stdout_handle = stdout_stream.map(|stream| thread::spawn(move || read_limited(stream)));
    let stderr_handle = stderr_stream.map(|stream| thread::spawn(move || read_limited(stream)));

    let mut timed_out = false;
    let mut exit_code: Option<i32> = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                thread::sleep(Duration::from_millis(40));
            }
            Err(error) => return Err(format!("等待子进程结束失败：{error}")),
        }
    }

    let (stdout, stdout_truncated) = stdout_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or((Vec::new(), false));
    let (stderr, stderr_truncated) = stderr_handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or((Vec::new(), false));

    Ok(CliOutcome {
        exit_code,
        stdout: base64_encode(&stdout),
        stderr: base64_encode(&stderr),
        stdout_truncated,
        stderr_truncated,
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 执行白名单内的命令行程序。
///
/// 返回结构里带 `timedOut` / `exitCode`，退出码非 0 **不算 Rust 层错误** ——
/// 「CLI 报错」与「通道故障」是两种语义，由 TS 侧分类（`infra/welink/exec.ts`）。
#[tauri::command]
pub async fn cli_run(
    program: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<CliOutcome, String> {
    assert_allowed(&program)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(200));

    // 关键：await 阻塞线程池的 JoinHandle，而不是在主线程上等待子进程（D9）。
    // 外层错误是 JoinError（线程 panic/被取消），内层是业务错误，两层都要透传。
    tauri::async_runtime::spawn_blocking(move || run_blocking(&program, &args, timeout))
        .await
        .map_err(|error| format!("子进程执行线程异常退出：{error}"))?
}