use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 需求指定的数据根目录：配置、数据、日志全部落在这里。
pub(crate) const PREFERRED_ROOT: &str = "D:\\TangYuan";

pub(crate) const CONFIG_SUBDIR: &str = "config";
pub(crate) const DATA_SUBDIR: &str = "data";
pub(crate) const LOGS_SUBDIR: &str = "logs";

pub(crate) const CONFIG_FILE: &str = "config.json";
pub(crate) const TABLE_FILE: &str = "table.json";
pub(crate) const DB_FILE: &str = "app.db";

// ---------- 迁移写入状态机（评审 P1：迁移窗口与迁移后的写入防丢失） ----------
//
// 迁移语义是「复制 + 切引导指针 + 重启」，这里有两个数据丢失窗口：
//  * **复制窗口**（MIGRATING）：async 写命令跑在阻塞线程池上，可与复制并发，
//    把新数据写进**正在被复制的旧根**——重启切到新根后这部分即静默丢失；
//  * **迁移后**（FROZEN）：DB 连接仍指旧根，此时放行 DB 写等于写进废弃目录。
//    文件命令不受影响：resolve_storage 读引导文件已指向新根，写入自洽。

pub(crate) const STORE_NORMAL: u8 = 0;
pub(crate) const STORE_MIGRATING: u8 = 1;
pub(crate) const STORE_FROZEN: u8 = 2;

static STORE_STATE: AtomicU8 = AtomicU8::new(STORE_NORMAL);

/// 发起迁移：仅 NORMAL 态可进入 MIGRATING（并发/重复迁移在这里被闸掉）。
pub(crate) fn begin_migration() -> Result<(), String> {
    match STORE_STATE.compare_exchange(
        STORE_NORMAL,
        STORE_MIGRATING,
        Ordering::SeqCst,
        Ordering::SeqCst,
    ) {
        Ok(_) => Ok(()),
        Err(STORE_MIGRATING) => Err("存储目录迁移正在进行中".to_string()),
        Err(_) => Err("本次会话已完成迁移，重启后才能再次迁移".to_string()),
    }
}

/// 结束迁移：成功 → FROZEN（DB 写保持拒绝直到重启）；失败 → 回 NORMAL（旧根仍是权威）。
pub(crate) fn end_migration(succeeded: bool) {
    STORE_STATE.store(
        if succeeded { STORE_FROZEN } else { STORE_NORMAL },
        Ordering::SeqCst,
    );
}

/// DB 写命令入口检查：复制窗口与迁移后（连接仍指旧根）都拒绝写。
pub(crate) fn check_db_writes_allowed() -> Result<(), String> {
    match STORE_STATE.load(Ordering::SeqCst) {
        STORE_MIGRATING => Err(
            "存储目录迁移进行中，请稍后再试（避免数据写入正在被复制的旧目录）".to_string(),
        ),
        STORE_FROZEN => Err(
            "存储目录已迁移，重启后生效：期间拒绝写入以免数据落在旧目录（读取不受影响）".to_string(),
        ),
        _ => Ok(()),
    }
}

/// 文件写命令入口检查：只需拦「复制窗口」（FROZEN 态下文件写入已指向新根，自洽）。
pub(crate) fn check_file_writes_allowed() -> Result<(), String> {
    if STORE_STATE.load(Ordering::SeqCst) == STORE_MIGRATING {
        return Err("存储目录迁移进行中，请稍后再试".to_string());
    }
    Ok(())
}

/// 引导文件：固定放在用户配置目录，只存「真实数据根指向哪」。
/// 解决"数据根目录写在配置里、配置又在数据根目录下"的自引用悖论。
const BOOTSTRAP_FILE: &str = "bootstrap.json";

/// 真实探测目录是否可写：创建目录 -> 写探针文件 -> 删除。
/// 只判断 `exists()` 不够 —— 目录存在但只读同样会导致后续写入失败。
pub(crate) fn probe_writable(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建目录失败: {error}"))?;
    let probe = dir.join(".write-probe");
    fs::write(&probe, b"ok").map_err(|error| format!("目录不可写: {error}"))?;
    fs::remove_file(&probe).map_err(|error| format!("无法删除探针文件: {error}"))?;
    Ok(())
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    #[serde(default)]
    data_dir: Option<String>,
}

fn bootstrap_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(BOOTSTRAP_FILE)
}

/// 读引导文件里的 dataDir。返回 (指向的目录, 异常说明)。
/// 文件不存在属正常首启 → (None, "")；存在但损坏/内容非法 → (None, 原因)，
/// 由 resolve_storage 计入 note——**不能**静默回退（评审 R-5）：用户已迁移到
/// E:\MyData 后引导文件被杀软清掉，静默回退 D:\TangYuan 在用户视角就是
/// 「数据全没了」，必须把原因写进 storage_info 的 note 让前端能展示。
fn read_bootstrap_dir(app: &AppHandle) -> (Option<String>, String) {
    let raw = match fs::read_to_string(bootstrap_path(app)) {
        Ok(raw) => raw,
        Err(_) => return (None, String::new()),
    };
    match serde_json::from_str::<Bootstrap>(&raw) {
        Ok(parsed) => match parsed.data_dir.filter(|dir| !dir.trim().is_empty()) {
            Some(dir) => (Some(dir), String::new()),
            None => (None, "引导文件存在但内容为空，已回退默认根".to_string()),
        },
        Err(error) => (
            None,
            format!("引导文件损坏（{error}），已回退默认根；如已迁移过数据，请修复该文件后重启"),
        ),
    }
}

/// 写引导文件。先写临时文件再 rename，保证不会留下半截 JSON。
pub fn write_bootstrap_dir(app: &AppHandle, data_dir: &str) -> Result<(), String> {
    let path = bootstrap_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建引导目录失败: {e}"))?;
    }
    let payload = Bootstrap {
        data_dir: Some(data_dir.to_string()),
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("写引导临时文件失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("替换引导文件失败: {e}"))?;
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StorageLayout {
    /// 实际生效的存储根目录
    pub root: String,
    /// 首选目录 D:\TangYuan
    pub preferred_root: String,
    pub config_file: String,
    pub table_file: String,
    pub db_file: String,
    pub logs_dir: String,
    /// 是否发生了降级回退
    pub fallback: bool,
    /// 降级原因（正常时为空串）
    pub note: String,
}

/// 解析存储布局。优先级：
///   1. bootstrap 里用户配置的 dataDir
///   2. 默认首选根 D:\TangYuan
///   3. 均不可写时回退用户配置目录（程序必须永远能启动，回退是兜底而非报错）
pub(crate) fn resolve_storage(app: &AppHandle) -> StorageLayout {
    let (configured_raw, corruption) = read_bootstrap_dir(app);
    // dataDir 合法性校验（评审 R-5）：必须是绝对路径且不能是盘根（如 D:\）。
    // 盘根/相对路径会让 config/data/logs 直接落在文件系统顶层。
    let configured = configured_raw.as_deref().map(|dir| PathBuf::from(dir.trim())).filter(|path| {
        path.is_absolute() && path.parent().is_some_and(|parent| parent != path)
    });
    let mut note = if configured.is_none() && !corruption.is_empty() {
        corruption
    } else if configured.is_none() && configured_raw.is_some() {
        "引导文件中的 dataDir 非法（须为非盘根的绝对路径），已回退默认根".to_string()
    } else {
        String::new()
    };
    let primary = configured.unwrap_or_else(|| PathBuf::from(PREFERRED_ROOT));
    let mut fallback = false;

    let root = match probe_writable(&primary) {
        Ok(()) => primary,
        Err(primary_error) => {
            fallback = true;
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            match probe_writable(&dir) {
                Ok(()) => {
                    if !note.is_empty() {
                        note.push_str("；");
                    }
                    note.push_str(&format!(
                        "{} 不可用（{primary_error}），已回退到 {}",
                        primary.display(),
                        dir.display()
                    ));
                    dir
                }
                Err(fallback_error) => {
                    // 两个位置都不可写：仍返回首选路径，具体读写命令会给出明确错误
                    if !note.is_empty() {
                        note.push_str("；");
                    }
                    note.push_str(&format!(
                        "{} 与 {} 均不可写（{primary_error} / {fallback_error}）",
                        primary.display(),
                        dir.display()
                    ));
                    primary
                }
            }
        }
    };

    let config_file = root.join(CONFIG_SUBDIR).join(CONFIG_FILE);
    let table_file = root.join(DATA_SUBDIR).join(TABLE_FILE);
    let db_file = root.join(DATA_SUBDIR).join(DB_FILE);
    let logs_dir = root.join(LOGS_SUBDIR);

    StorageLayout {
        root: root.to_string_lossy().to_string(),
        preferred_root: PREFERRED_ROOT.to_string(),
        config_file: config_file.to_string_lossy().to_string(),
        table_file: table_file.to_string_lossy().to_string(),
        db_file: db_file.to_string_lossy().to_string(),
        logs_dir: logs_dir.to_string_lossy().to_string(),
        fallback,
        note,
    }
}

/// 写文件：先写临时文件再 rename（与 write_bootstrap_dir 同一纪律，评审 R-4）。
/// 写到一半崩溃/断电时，rename 保证留下的要么是完整旧内容、要么是完整新内容，
/// 不会是半截 JSON——config.json/table.json 承载用户全部配置，损坏即配置尽失。
pub(crate) fn write_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|error| format!("写入失败: {error}"))?;
    if let Err(error) = fs::rename(&tmp, path) {
        // rename 失败时尽力清掉临时文件，避免目录里残留 config.tmp 类垃圾
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换文件失败: {error}"));
    }
    Ok(())
}

pub(crate) fn read_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("读取失败: {error}"))
}

/// 递归复制目录（含子目录）。返回复制的文件数。
/// 目标已存在的同名文件会被覆盖 —— 迁移语义下这是期望行为（新目录为权威副本）。
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<usize, String> {
    fs::create_dir_all(to).map_err(|e| format!("创建目标目录失败: {e}"))?;
    let mut count = 0usize;
    for entry in fs::read_dir(from).map_err(|e| format!("读取源目录失败: {e}"))?.flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            count += copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("复制 {} 失败: {e}", src.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

/// 迁移存储根：把当前生效根下的 config/data/logs 整体复制到新根，旧目录保留（Q2）。
/// 复制成功后写 bootstrap 指向新根。**需重启生效**：DB 连接仍持有旧路径。
///
/// 评审 P1 的两个数据丢失窗口在这里关闭：
///  1. **同步重 IO** → 命令已 async 化（commands.rs），复制跑在阻塞线程池；
///  2. **复制窗口/迁移后的写入** → `begin_migration` 进入 MIGRATING 后，
///     DB 命令再经 `with_db_exclusive` 独占连接（写命令排队到复制完成后
///     被 FROZEN 态拒绝），文件写命令被 `check_file_writes_allowed` 拦下。
/// 失败路径自动回 NORMAL：旧根仍是权威副本，复制残留留在新根（无害）。
pub fn migrate_data_dir(app: &AppHandle, new_root: &str) -> Result<MigrateReport, String> {
    begin_migration()?;
    let result = do_migrate(app, new_root);
    end_migration(result.is_ok());
    result
}

fn do_migrate(app: &AppHandle, new_root: &str) -> Result<MigrateReport, String> {
    let target = PathBuf::from(new_root.trim());
    if target.as_os_str().is_empty() {
        return Err("目标目录不能为空".to_string());
    }

    let current = resolve_storage(app);
    if PathBuf::from(&current.root) == target {
        return Err("目标目录与当前目录相同".to_string());
    }
    probe_writable(&target)?;

    // 独占 DB 直到复制完成：checkpoint 与复制之间绝不能有并发写入（否则新数据
    // 落在 -wal / 旧根，复制走的主文件缺最新事务）。期间所有 DB 命令在此排队。
    crate::db::with_db_exclusive(app, |conn| {
        // WAL 检查点：把 -wal 内容刷回主 .db 文件，保证复制的是完整数据。
        let db_checkpointed = conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .is_ok();

        let mut copied = 0usize;
        for sub in [CONFIG_SUBDIR, DATA_SUBDIR, LOGS_SUBDIR] {
            let from = PathBuf::from(&current.root).join(sub);
            if from.is_dir() {
                copied += copy_dir_recursive(&from, &target.join(sub))?;
            }
        }

        write_bootstrap_dir(app, new_root.trim())?;

        Ok(MigrateReport {
            from: current.root,
            to: target.to_string_lossy().to_string(),
            copied_files: copied,
            db_checkpointed,
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub from: String,
    pub to: String,
    pub copied_files: usize,
    /// DB 是否成功做了 WAL 检查点（失败时 -wal 可能未并入主文件）
    pub db_checkpointed: bool,
}