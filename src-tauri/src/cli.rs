//! 通用子进程通道（D1：Rust 只做薄管道，命令名与参数拼装全在 TS）。
//!
//! 为什么是 async + spawn_blocking（D9）：
//! Tauri 的同步命令在 WebView 主线程上执行，而 cli_run 要阻塞等待子进程（最长 15s），
//! 会直接把 UI 卡死（白屏/掉帧）。因此命令声明为 async，进程逻辑丢进阻塞线程池。
//!
//! 安全与可靠性要点：
//!  * **白名单**：程序主干名须在 [`ALLOWED_STEMS`] 内**且扩展名在 [`ALLOWED_EXTS`] 内**
//!    （只比主干名会让 `python.bat` 这类脚本通过，cmd.exe 会解释执行它）；
//!  * **解释器额外约束**：python 族的 args 只允许版本探测（[`assert_python_args`]）——
//!    放行「程序」不等于放行「该程序的任意用法」，`python -c` 仍是任意代码执行；
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
/// 白名单：仅允许这些文件主干名（不含扩展名，大小写不敏感）。
///  * `welink-cli` —— 消息拉取/发送、快速建群、环境自检；
///  * `python` / `python3` / `py` —— 环境检测页的 Python 版本探测（只读 `--version`）；
///  * `systeminfo`/`ipconfig`/`tasklist`/`where`/`whoami`/`hostname`/`nslookup`/`ping`
///    —— Windows 只读诊断命令（windows-infra-foundation；登记表在
///    `src/infra/windows/registry.ts`，每条用途见该文件，均为 System32 独立 EXE）。
/// 白名单是防 Bridge 被当作通用命令通道的最后一道闸：TS 侧需要新程序时必须
/// 在此处显式放行并写明用途，不接受任何「传什么跑什么」的放宽。
const ALLOWED_STEMS: &[&str] = &[
    "welink-cli",
    // `codehub-cli` —— 内网 CodeHub MR 检视拉取（personal-workbench；与 welink-cli
    // 同构的 CLI 通道消费方，命令拼装与解析全在 TS 侧 `src/infra/codehub/`）。
    "codehub-cli",
    "python",
    "python3",
    "py",
    // —— 只读系统诊断（infra/windows 注册表闸 + 本清单 = 双层闸，design D1）——
    "systeminfo",
    "ipconfig",
    "tasklist",
    "where",
    "whoami",
    "hostname",
    "nslookup",
    "ping",
];

/// 扩展名白名单：**只允许真实可执行二进制**。
///
/// 为什么必须校验扩展名（只比主干名是不够的）：`file_stem()` 会把 `python.bat`
/// 也解析成 `python`，于是批处理/脚本类文件全部通过白名单。而 Windows 上
/// `CreateProcess` 遇到 `.bat`/`.cmd` 会交给 `cmd.exe` 解释执行，`.ps1` 同理——
/// 白名单于是从「只能跑这几个程序」退化成「能跑任何名字伪装成它们的脚本」。
/// 实测（Rust 1.98，`Path::file_stem` 语义自1.5起未变）：`python.bat`/`python.cmd`/
/// `python.ps1`/`..\python` 全部命中 ALLOWED_STEMS。
///
/// 只放 `.exe`/`.com`：白名单里的System32 诊断命令与两个 CLI 均为独立 EXE，
/// 没有一个需要 `.bat`/`.cmd` 包装，因此这里收窄不损失任何合法能力。
const ALLOWED_EXTS: &[&str] = &["exe", "com"];

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

/// 白名单校验：取文件主干名比对，大小写不敏感**且扩展名必须在 [`ALLOWED_EXTS`] 内**。
/// 允许绝对路径（用户自配 cliPath），但主干名必须命中 [`ALLOWED_STEMS`] 清单。
///
/// 两道校验缺一不可：只比主干名会让 `python.bat` 这类脚本文件通过（见 [`ALLOWED_EXTS`]）。
fn assert_allowed(program: &str) -> Result<(), String> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return Err("未配置 CLI 路径（cliPath 为空）".to_string());
    }
    let path = Path::new(trimmed);
    // 扩展名先校验：放行脚本文件等于放行任意代码（cmd.exe 会解释 .bat/.cmd）
    let ext = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTS.iter().any(|allowed| ext == *allowed) {
        return Err(format!(
            "程序扩展名不被允许：{ext}（仅允许 {}；脚本类文件如 .bat/.cmd/.ps1 一律拒绝）",
            ALLOWED_EXTS.join("、")
        ));
    }
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    if ALLOWED_STEMS.iter().any(|allowed| stem.eq_ignore_ascii_case(allowed)) {
        Ok(())
    } else {
        Err(format!(
            "程序名不在白名单内：{stem}（仅允许 {}）",
            ALLOWED_STEMS.join("、")
        ))
    }
}

/// 是否是 python 解释器族—— 白名单里唯一的「程序正确但用法可任意」类型，
/// 需要额外约束 args。
///
/// 覆盖带版本号后缀的真实安装形态：`python3.11.exe` / `python3.exe` 的 `file_stem`
/// 是 `python3.11` / `python3`，不做版本后缀剥离会**绕过 args 约束**
/// （`python3.11 -c "<代码>"` 同样是任意代码执行）。
fn is_python_stem(path: &Path) -> bool {
    path.file_stem()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .map(|stem| {
            // 先整体判定，再剥掉形如 `3` / `3.11` / `3.11.2` 的版本后缀再判一次，
            // 于是 `python` / `python3` / `python3.11` 全覆盖。
            stem == "py"
                || stem == "python"
                || stem.starts_with("python")
                    && stem["python".len()..]
                        .chars()
                        .all(|c| c.is_ascii_digit() || c == '.')
        })
        .unwrap_or(false)
}

/// python 是唯一的「解释器型」白名单项：`python -c "<任意代码>"` 等价于任意代码执行，
/// 而白名单放行它的唯一用途是环境检测页的**只读版本探测**
/// （`src/infra/envcheck/python.ts`，实测只传 `['--version']`）。
/// 因此这里把 args 钉死为版本探测形态 —— 白名单从此不能被当成通用解释器通道。
///
/// 返回 `Ok(())` 表示 args 合法。白名单不含 python 时本函数不会被调用。
fn assert_python_args(args: &[String]) -> Result<(), String> {
    let is_version_probe = matches!(args.len(), 1) && matches!(args[0].as_str(), "-V" | "--version");
    if is_version_probe {
        return Ok(());
    }
    Err(format!(
        "python 只允许版本探测（-V / --version），收到 {} 个参数；\
         解释器通道不在本白名单的授权范围内",
        args.len()
    ))
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
    // 解释器型白名单项额外约束 args：白名单放行「程序」不等于放行「该程序的任意用法」，
    // `python -c "<代码>"` 仍是任意代码执行。所有 python 变体同等对待。
    if is_python_stem(Path::new(program.trim())) {
        assert_python_args(&args)?;
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(200));

    // 关键：await 阻塞线程池的 JoinHandle，而不是在主线程上等待子进程（D9）。
    // 外层错误是 JoinError（线程 panic/被取消），内层是业务错误，两层都要透传。
    tauri::async_runtime::spawn_blocking(move || run_blocking(&program, &args, timeout))
        .await
        .map_err(|error| format!("子进程执行线程异常退出：{error}"))?
}
#[cfg(test)]
mod tests {
    use super::*;

    // —— 白名单：扩展名闸（修复前只比 file_stem，脚本文件全部漏过）——

    #[test]
    fn rejects_script_extensions_with_allowed_stem() {
        // 这些的 file_stem 都是白名单内的名字，但 CreateProcess 会交给
        // cmd.exe 解释执行 .bat/.cmd —— 必须拒绝，否则白名单等于没有。
        for program in [
            r"C:\tools\python.bat",
            r"C:\tools\python.cmd",
            r"C:\tools\python.ps1",
            r"C:\tools\welink-cli.bat",
            r"C:\tools\ipconfig.cmd",
        ] {
            assert!(
                assert_allowed(program).is_err(),
                "脚本文件被放行了：{program}"
            );
        }
    }

    #[test]
    fn rejects_stem_escape_via_dotdot_or_bare_name() {
        // `..\python` 的 file_stem 同样是 python —— 不能只靠 stem 判定
        for program in [r"..\python", r"..\python.bat", r"python."] {
            assert!(
                assert_allowed(program).is_err(),
                "路径逃逸形态被放行了：{program}"
            );
        }
    }

    #[test]
    fn rejects_unknown_stem_and_empty_program() {
        for program in [r"C:\Windows\System32\cmd.exe", "notepad", "", "   "] {
            assert!(assert_allowed(program).is_err(), "非白名单程序被放行：{program}");
        }
    }

    #[test]
    fn allows_real_executables_in_whitelist() {
        for program in [
            r"C:\tools\welink-cli.exe",
            r"C:\tools\codehub-cli.exe",
            r"C:\Windows\System32\ipconfig.exe",
            // 用户自配的绝对路径：主干名命中即放行（既有语义不变）
            r"D:\tools\python.exe",
            // 大小写不敏感
            r"D:\tools\PYTHON.EXE",
            // .com 也是真可执行（System32 里有若干 .com 工具）
            "where.com",
        ] {
            assert!(assert_allowed(program).is_ok(), "合法程序被误拒：{program}");
        }
    }

    // —— 解释器闸：白名单放行「程序」不等于放行「任意用法」——

    #[test]
    fn python_only_allows_version_probe() {
        let args = |items: &[&str]| items.iter().map(|v| v.to_string()).collect::<Vec<_>>();
        assert!(assert_python_args(&args(&["--version"])).is_ok());
        assert!(assert_python_args(&args(&["-V"])).is_ok());

        // -c 是任意代码执行，必须拒绝
        assert!(assert_python_args(&args(&["-c", "import os;os.system('calc')"])).is_err());
        // 无参、管道、脚本参数同理
        assert!(assert_python_args(&args(&[])).is_err());
        assert!(assert_python_args(&args(&["--version", "--version"])).is_err());
        assert!(assert_python_args(&args(&["-"])).is_err());
    }

    #[test]
    fn python_family_is_detected_case_insensitively() {
        // 含带版本号后缀的真实安装形态 —— file_stem 是 python3.11，
        // 早期实现只判python/python3/py，python3.11 会绕过 args 约束。
        for name in [
            "python", "PYTHON", "python3", "Python3", "py", "PY",
            "python3.11", "python3.11.exe", "python.exe", "py.exe",
        ] {
            assert!(
                is_python_stem(Path::new(name)),
                "python 族未被识别（会绕过 args 约束）：{name}"
            );
        }
        for name in ["welink-cli", "ipconfig", "systeminfo", "pythonic", "python3-config"] {
            assert!(
                !is_python_stem(Path::new(name)),
                "非 python 程序被误判为 python（会白拦合法调用）：{name}"
            );
        }
    }
}
