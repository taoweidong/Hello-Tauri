//! 自动更新通道（docs/design-auto-update-2026-10-10.md）。
//!
//! 与 http.rs / cli.rs 同构的薄桥接：Rust 无业务规则 —— 清单协议、版本判定、
//! 调度节流全部在 TS 侧（`src/orchestrator/update.ts`），宿主只做三件事：
//! 字节搬运、文件系统安全闸（复用 fs.rs 双闸）、进程自替换。
//!
//! 契约（与 TS Bridge 侧一致）：
//!  * `update_download`：仅传输层故障 reject；非 2xx 直接 reject（下载通道没有
//!    「状态码回传给业务判定」的语义，与 `http_get_text` 不同）；
//!  * `verify_minisign` / `update_apply`：**永不 reject**，一切失败折叠进结果对象
//!    （windows-infra 同款语义），TS 侧无需 try/catch（公钥解析失败除外：公钥是
//!    编译期常量，解析失败 = 发布错误，属通道故障）。
//!
//! [UPD-ASSUME] U-1「运行中映像可 rename」已于 2026-10-11 PoC 实测通过
//! （运行中进程改名后继续存活，见设计 §5.1 / §13）；U-3（tauri signer 与
//! minisign-verify 往返）由本模块 `tests::tauri_signer_roundtrip` 锁定。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::fs::{contain_root, resolve_within_root};
use crate::storage;

/// Rust → 前端下载进度事件名（与 `src/api/types.ts` 的更新事件白名单一致）。
pub const EV_PROGRESS: &str = "update://progress";

/// 单次下载硬上限：产物约 4.5 MB，留一个数量级余量，仅防异常源洪泛（同 MAX_BODY 思路）。
const MAX_DOWNLOAD: u64 = 64 * 1024 * 1024;
/// 进度事件推送步长：每个 chunk 都发会在大文件下产生数千次 IPC，按 64 KB 步长节流。
const PROGRESS_STEP: u64 = 64 * 1024;
/// rename 重试：安全软件实时扫描会瞬时锁住新落盘的文件（lib.rs 跨卷陷阱同款环境）。
const SWAP_RETRIES: u32 = 3;
const SWAP_RETRY_DELAY: Duration = Duration::from_millis(500);
/// 换位成功、spawn 新进程后，给 IPC 响应留出送达时间再退出。
const EXIT_DELAY: Duration = Duration::from_millis(200);
/// 残留清理重试：以「.old 映像可删除」为旧进程已退出的信号（删除失败 ≈ 旧进程
/// 还活着），每轮间隔 100ms、最多 50 轮（≈5s）—— 兼顾单实例互斥量的释放竞态。
const PRUNE_ROUNDS: u32 = 50;
const PRUNE_RETRY_DELAY: Duration = Duration::from_millis(100);

/// 新进程启动参数：setup 阶段清理上一轮替换的 .old/.up 残留（§5.1）。
pub const PRUNE_ARG: &str = "--update-prune";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub received: u64,
    /// content-length 缺失时为 None，前端降级显示已接收字节数
    pub total: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOutcome {
    pub valid: bool,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub ok: bool,
    /// 失败发生的阶段：locate/probe/copy/rename_current/rename_staged/spawn/verify
    pub step: Option<String>,
    /// 是否已回滚到替换前状态（rename_staged 失败会回滚；spawn 失败不回滚——文件已是新版）
    pub rolled_back: bool,
    pub reason: Option<String>,
}

fn fail(step: &str, reason: String) -> ApplyOutcome {
    ApplyOutcome { ok: false, step: Some(step.to_string()), rolled_back: false, reason: Some(reason) }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("读取文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    // 流式读取：staged exe 约 4.5 MB，整读也可接受，但流式对 64 MB 上限的大文件同样成立
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|e| format!("读取文件失败: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn now_stamp() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// 流式 GET 下载落盘（存储根内相对路径），边下边算 sha256，进度经事件推送。
/// `expected_sha256` 非空时由本命令收尾比对（大小写不敏感），不符则删除落地文件并
/// reject（失败表 #6 的「staging 删除」落地为下载通道的完整性收尾，不新增 fs 删除命令）。
#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    url: String,
    dest_relative: String,
    timeout_ms: Option<u64>,
    expected_sha256: Option<String>,
) -> Result<DownloadOutcome, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("更新下载只允许 http/https".to_string());
    }
    let root = PathBuf::from(storage::resolve_storage(&app).root);
    let dest = resolve_within_root(&root, &dest_relative)?;
    // fs.rs 同款双闸：写前复核真实位置（防符号链接/junction 逃逸）
    contain_root(&root, &dest)?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(300_000).max(5_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_millis(10_000))
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败：{e}"))?;

    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| crate::http::describe_transport_error(&e, timeout, "HTTP"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("下载失败：HTTP {status}"));
    }
    let total = response.content_length();

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let mut file = fs::File::create(&dest).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?
    {
        received += chunk.len() as u64;
        if received > MAX_DOWNLOAD {
            drop(file);
            let _ = fs::remove_file(&dest);
            return Err("下载超出上限，已中止并清理".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
        // 事件尽力而为：窗口已关/监听者不在都不影响下载本身；按 64 KB 步长节流
        if received - last_emit >= PROGRESS_STEP {
            last_emit = received;
            let _ = app.emit(EV_PROGRESS, ProgressPayload { received, total });
        }
    }
    file.flush().map_err(|e| format!("落盘失败: {e}"))?;
    let sha256 = format!("{:x}", hasher.finalize());
    // 完整性收尾（闸①）：与清单声明的 sha256 不符 → 删除 staging 并拒绝
    if let Some(expected) = expected_sha256.filter(|s| !s.trim().is_empty()) {
        if !sha256.eq_ignore_ascii_case(expected.trim()) {
            let _ = fs::remove_file(&dest);
            return Err("下载内容校验失败，请重试".to_string());
        }
    }
    // 收尾补发一次精确进度（不足一个步长时前端也能看到终值）
    let _ = app.emit(EV_PROGRESS, ProgressPayload { received, total });
    Ok(DownloadOutcome { bytes: received, sha256 })
}

/// minisign 验签（对象是清单文本，不是 exe —— §5.2）。
/// 永不 reject：解析/验证失败折叠进 valid:false + reason；仅公钥解析失败 reject。
///
/// `allow_legacy = true`：`tauri signer`（minisign 工具链）默认产出非预哈希
/// （"Ed"，对原文直接签名）的签名；该参数只放宽签名**算法代次**，不放宽信任
/// （两种代次都要求私钥签名，U-3 往返测试锁定）。
#[tauri::command]
pub fn verify_minisign(
    message: String,
    signature: String,
    public_key: String,
) -> Result<VerifyOutcome, String> {
    let key = minisign_verify::PublicKey::from_base64(public_key.trim())
        .map_err(|e| format!("公钥解析失败: {e}"))?;
    let sig = match minisign_verify::Signature::decode(signature.trim()) {
        Ok(sig) => sig,
        Err(e) => return Ok(VerifyOutcome { valid: false, reason: format!("签名格式非法: {e}") }),
    };
    match key.verify(message.as_bytes(), &sig, true) {
        Ok(()) => Ok(VerifyOutcome { valid: true, reason: String::new() }),
        Err(e) => Ok(VerifyOutcome { valid: false, reason: format!("{e}") }),
    }
}

/// 新进程拉起方式（可注入测试替身）：生产实现带 `--update-prune` 参数 spawn。
pub type Launcher = dyn Fn(&Path) -> Result<(), String>;

/// 自替换四步换位核心（§5.1）：copy → rename 运行映像 → rename 新文件就位 → spawn。
/// `launcher` 为注入点（单测传假实现）；永不 panic（panic="abort" 纪律）。
///
/// 现场约定：
///  * ②③ 是**同目录 rename**，必然同卷、原子性好；唯一的跨卷动作是 ① 的 copy
///    （存储根与 exe 目录可能不同卷）；
///  * `.old-<ts>.exe` 在旧进程退出前无法删除（映像仍被映射）—— 由新进程 setup
///    阶段带 `--update-prune` 清理；删除失败不报错，留给下次 apply 时再扫。
pub(crate) fn perform_swap(staged: &Path, exe: &Path, launcher: &Launcher) -> ApplyOutcome {
    let Some(exe_dir) = exe.parent() else {
        return fail("locate", "exe 路径异常（无父目录）".into());
    };
    let stem = exe
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "app".into());
    let ext = exe
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "exe".into());
    let ts = now_stamp();
    let tmp = exe_dir.join(format!("{stem}.up-{ts}.tmp.{ext}"));
    let old = exe_dir.join(format!("{stem}.old-{ts}.{ext}"));

    // ① 跨卷安全的 copy（存储根与 exe 目录可能不同卷）
    if let Err(e) = fs::copy(staged, &tmp) {
        let _ = fs::remove_file(&tmp);
        return fail("copy", format!("复制新文件失败: {e}"));
    }
    // ② 运行映像改名（可改名不可删；AV 瞬时锁 → 重试）
    if !rename_with_retry(exe, &old) {
        let _ = fs::remove_file(&tmp);
        return fail(
            "rename_current",
            "当前程序文件被占用（可能有多开副本或安全软件锁定），请关闭其他副本后重试".into(),
        );
    }
    // ③ 新文件就位（失败即回滚原状）
    if !rename_with_retry(&tmp, exe) {
        let _ = fs::rename(&old, exe);
        return ApplyOutcome {
            ok: false,
            step: Some("rename_staged".into()),
            rolled_back: true,
            reason: Some("新文件就位失败，已回滚到当前版本".into()),
        };
    }
    // ④ 拉起新进程（带清理参数），调用方随后退出本进程
    if let Err(e) = launcher(exe) {
        // 文件已是新版本，不回滚；引导用户手动启动（失败表 #9）
        return ApplyOutcome {
            ok: false,
            step: Some("spawn".into()),
            rolled_back: false,
            reason: Some(format!("已更新但自动重启失败: {e}，请手动双击启动")),
        };
    }
    ApplyOutcome { ok: true, step: None, rolled_back: false, reason: None }
}

fn launch_new_process(exe: &Path) -> Result<(), String> {
    Command::new(exe)
        .arg(PRUNE_ARG)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{e}"))
}

/// 自替换四步换位（§5.1）：copy → rename 运行映像 → rename 新文件就位 → spawn → exit。
/// 永不 reject；成功且换位的场景下进程随即退出，本响应可能不达前端 —— TS 侧契约：
/// invoke 后 3s 无响应且进程消失 = 更新成功（重启中）。
#[tauri::command]
pub async fn update_apply(
    app: AppHandle,
    staged_relative: String,
    expected_sha256: Option<String>,
) -> Result<ApplyOutcome, String> {
    let Ok(exe) = std::env::current_exe() else {
        return Ok(fail("locate", "无法定位当前 exe 路径".into()));
    };
    if exe.parent().is_none() {
        return Ok(fail("locate", "exe 路径异常（无父目录）".into()));
    }
    let root = PathBuf::from(storage::resolve_storage(&app).root);
    let staged = match resolve_within_root(&root, &staged_relative).and_then(|p| contain_root(&root, &p).map(|_| p)) {
        Ok(p) => p,
        Err(e) => return Ok(fail("locate", e)),
    };
    if !staged.is_file() {
        return Ok(fail("locate", format!("待安装文件不存在：{staged_relative}")));
    }
    // 闸①收尾：apply 前对 staged 复核哈希（覆盖摆渡路径 —— inbox 文件没经过下载通道）
    if let Some(expected) = expected_sha256.filter(|s| !s.trim().is_empty()) {
        match hash_file(&staged) {
            Ok(actual) if actual.eq_ignore_ascii_case(expected.trim()) => {}
            Ok(_) => return Ok(fail("verify", "待安装文件哈希与清单不符，已拒绝".into())),
            Err(e) => return Ok(fail("verify", e)),
        }
    }
    // 上轮失败的残留先扫一遍（.old/.up 文件此时已不被映射，能删则删）
    if let Some(dir) = exe.parent() {
        clean_leftovers(dir);
    }
    // exe 目录不可写（如放在 Program Files、只读介质）：拒绝 + 引导手动更新（失败表 #7）
    if let Err(e) = storage::probe_writable(exe.parent().unwrap_or(Path::new("."))) {
        return Ok(fail("probe", format!("exe 所在目录不可写（{e}），请手动更新")));
    }

    let outcome = perform_swap(&staged, &exe, &launch_new_process);
    if outcome.ok {
        // WAL 已提交即持久；未完成业务由新进程 bootstrap 恢复（同托盘方案退出语义）。
        // 先睡再退：给 IPC 响应与前端收尾日志留出送达时间。
        tokio::time::sleep(EXIT_DELAY).await;
        app.exit(0);
    }
    Ok(outcome)
}

fn rename_with_retry(from: &Path, to: &Path) -> bool {
    for attempt in 0..SWAP_RETRIES {
        match fs::rename(from, to) {
            Ok(()) => return true,
            Err(_) if attempt + 1 < SWAP_RETRIES => std::thread::sleep(SWAP_RETRY_DELAY),
            Err(_) => return false,
        }
    }
    false
}

/// exe 目录内上一轮替换的残留文件判定：`<stem>.old-<ts>.exe` / `<stem>.up-<ts>.tmp.exe`。
/// 模式刻意收紧（前缀限定本程序 stem、后缀限定 .exe），不误伤用户自己的文件。
fn is_leftover(name: &str, stem: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem_lower = stem.to_ascii_lowercase();
    lower.starts_with(&stem_lower)
        && (lower.contains(".old-") || lower.contains(".up-"))
        && lower.ends_with(".exe")
}

/// 尽力而为清理一轮残留，返回是否还有删不掉的文件（= 仍被运行映像锁定）。
fn clean_leftovers(dir: &Path) -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    let Some(stem) = exe.file_stem().map(|s| s.to_string_lossy().into_owned()) else { return false };
    let Ok(entries) = fs::read_dir(dir) else { return false };
    let mut locked = false;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_leftover(&name, &stem) {
            if fs::remove_file(entry.path()).is_err() {
                locked = true;
            }
        }
    }
    locked
}

/// 新进程 setup 阶段调用：带 `--update-prune` 参数时清理上一轮替换残留。
///
/// 必须在 Builder 之前（lib.rs run 的第一步）：① 清理要赶在窗口出现前；② 单实例
/// 插件在 Builder 初始化时抢互斥量，而旧进程 spawn 本进程后 200ms 才退出 —— 以
/// 「.old 映像可删除」为旧进程已退出的信号带重试地等（删除失败 ≈ 旧进程还活着），
/// 否则本进程会被单实例插件误判为「二次启动」而把更新成果让给旧进程。
/// 超时（≈5s）后照样继续：宁可留下残留，不可让更新后的进程起不来。
pub fn prune_leftovers() {
    if !std::env::args().any(|arg| arg == PRUNE_ARG) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let Some(dir) = exe.parent().map(Path::to_path_buf) else { return };
    for _ in 0..PRUNE_ROUNDS {
        if !clean_leftovers(&dir) {
            return;
        }
        std::thread::sleep(PRUNE_RETRY_DELAY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// U-3（[UPD-ASSUME]）：`tauri signer` 产物与 minisign-verify 的格式兼容往返。
    /// 密钥材料为 2026-10-11 PoC 用一次性密钥对（target/upd-poc/keys 生成，私钥不落仓库）：
    /// 发布前必须用 `tauri signer generate` 换正式密钥（见 scripts/publish-update.mjs 流程）。
    const POC_PUBKEY: &str = "RWTys58y0gReACMFKgEEOW4W8pdoGOY/PybWIE1Nu8nNrbkoGhKtHM/3";
    const POC_SIGNATURE: &str = "untrusted comment: signature from tauri secret key\nRUTys58y0gReAHlYJMkQPbbJu/jMrjl9CdxrgdhyQqxc5FQqc/8X3g1muKR6xwbBI3gqo9ckUE+6uMqrGHAZMdYzv6nY2ACKrw4=\ntrusted comment: timestamp:1791659473\tfile:sample.json\ntFBX6mNG1jLCRdYLmGW/vk3pVpXEMryt7BmG5by3W/qJPUCEXsPwWKZdesIG3D1RqMnc9vKTjTSdckzgbZAoBQ==\n";
    const POC_MESSAGE: &str = r#"{"manifestVersion":1,"version":"0.2.0"}"#;

    #[test]
    fn tauri_signer_roundtrip() {
        // 正向：tauri signer sign 产物可被 Signature::decode + verify 接受
        let outcome = verify_minisign(POC_MESSAGE.into(), POC_SIGNATURE.into(), POC_PUBKEY.into())
            .expect("公钥可解析");
        assert!(outcome.valid, "tauri signer 签名应验证通过: {}", outcome.reason);
        // 反向：消息被篡改一个字节必须验签失败（闸① 的语义底线）
        let tampered = POC_MESSAGE.replace("0.2.0", "9.9.9");
        let outcome = verify_minisign(tampered, POC_SIGNATURE.into(), POC_PUBKEY.into()).expect("公钥可解析");
        assert!(!outcome.valid, "篡改后的清单必须验签失败");
        assert!(outcome.reason.contains("verification failed"), "实际文案: {}", outcome.reason);
    }

    #[test]
    fn verify_rejects_garbage_signature_without_panic() {
        let outcome = verify_minisign(POC_MESSAGE.into(), "not-a-signature".into(), POC_PUBKEY.into())
            .expect("公钥可解析");
        assert!(!outcome.valid);
        assert!(outcome.reason.contains("签名格式非法"));
    }

    #[test]
    fn verify_rejects_on_bad_public_key() {
        // 公钥解析失败 = 通道故障（发布错误），按契约 reject 而非折叠
        let result = verify_minisign(POC_MESSAGE.into(), POC_SIGNATURE.into(), "###".into());
        assert!(result.is_err());
    }

    /// swap 测试的可写临时目录：**不用 `std::env::temp_dir()`**（= %TEMP%，位于系统盘，
    /// 本机安全软件会拦截非系统盘程序写 C 盘）—— 与 storage.rs 测试同款纪律。
    fn scratch_dir(tag: &str) -> PathBuf {
        let stamp = format!("ht-update-test-{}-{}", std::process::id(), tag);
        let dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_else(std::env::temp_dir)
            .join(stamp);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn write_file(path: &Path, content: &[u8]) {
        fs::write(path, content).expect("write fixture");
    }

    #[test]
    fn perform_swap_success_replaces_exe_and_keeps_old() {
        let dir = scratch_dir("ok");
        let exe = dir.join("hello-tauri.exe");
        let staged = dir.join("staged.exe");
        write_file(&exe, b"old-image");
        write_file(&staged, b"new-image");

        let outcome = perform_swap(&staged, &exe, &|path| {
            // 记录拉起目标（借 RefCell 绕过 Fn 限制太啰嗦，直接断言目标存在即可）
            assert!(path.exists());
            Ok(())
        });
        assert!(outcome.ok, "swap 应成功: {:?}", outcome.reason);
        assert_eq!(fs::read(&exe).unwrap(), b"new-image", "exe 应为新内容");
        // 旧映像改名保留（新进程清理；这里手动验证它存在）
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".old-"))
            .collect();
        assert_eq!(leftovers.len(), 1, "应留下恰好一个 .old 残留: {leftovers:?}");
        assert!(leftovers[0].ends_with(".exe"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn perform_swap_launcher_failure_keeps_new_file_without_rollback() {
        let dir = scratch_dir("spawn-fail");
        let exe = dir.join("hello-tauri.exe");
        let staged = dir.join("staged.exe");
        write_file(&exe, b"old-image");
        write_file(&staged, b"new-image");

        let outcome = perform_swap(&staged, &exe, &|_path| Err("拒绝访问 (os error 5)".into()));
        assert_eq!(outcome.step.as_deref(), Some("spawn"));
        assert!(!outcome.rolled_back, "spawn 失败不回滚（文件已是新版）");
        assert_eq!(fs::read(&exe).unwrap(), b"new-image", "文件应保持为新版本");
        assert!(outcome.reason.unwrap().contains("请手动双击启动"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn perform_swap_copy_failure_folds_error_and_keeps_exe() {
        let dir = scratch_dir("copy-fail");
        let exe = dir.join("hello-tauri.exe");
        write_file(&exe, b"old-image");

        // staged 缺失（复制源不存在）→ 折叠为 copy 失败，原 exe 原封不动
        let outcome = perform_swap(&dir.join("missing.exe"), &exe, &|_path| Ok(()));
        assert_eq!(outcome.step.as_deref(), Some("copy"));
        assert!(!outcome.ok);
        assert_eq!(fs::read(&exe).unwrap(), b"old-image");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn perform_swap_rename_current_failure_cleans_tmp_and_keeps_exe() {
        let dir = scratch_dir("rename-fail");
        let exe = dir.join("hello-tauri.exe"); // 刻意不创建：② rename 源不存在 → 必然失败
        let staged = dir.join("staged.exe");
        write_file(&staged, b"new-image");

        let outcome = perform_swap(&staged, &exe, &|_path| Ok(()));
        assert_eq!(outcome.step.as_deref(), Some("rename_current"));
        assert!(!outcome.ok);
        assert!(outcome.reason.unwrap().contains("被占用"));
        // 失败现场必须清干净：不留 .up 临时文件
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".up-"))
            .collect();
        assert!(leftovers.is_empty(), "tmp 应被清理: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_leftover_matches_only_update_patterns() {
        let stem = "Hello-Tauri";
        assert!(is_leftover("Hello-Tauri.old-1730000000000.exe", stem));
        assert!(is_leftover("hello-tauri.up-1730000000000.tmp.exe", stem));
        // 不误伤用户自己的文件
        assert!(!is_leftover("notes.old-backup.exe", stem));
        assert!(!is_leftover("Hello-Tauri.exe", stem));
        assert!(!is_leftover("other.old-123.exe", stem));
        assert!(!is_leftover("Hello-Tauri.old-123.txt", stem));
    }
}
