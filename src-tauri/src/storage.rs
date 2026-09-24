use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 需求指定的数据根目录：配置、数据、日志全部落在这里。
pub(crate) const PREFERRED_ROOT: &str = "D:\\TangYuan";

pub(crate) const CONFIG_SUBDIR: &str = "config";
pub(crate) const DATA_SUBDIR: &str = "data";
pub(crate) const LOGS_SUBDIR: &str = "logs";

pub(crate) const CONFIG_FILE: &str = "config.json";
pub(crate) const TABLE_FILE: &str = "table.json";
pub(crate) const DB_FILE: &str = "app.db";

/// 真实探测目录是否可写：创建目录 -> 写探针文件 -> 删除。
/// 只判断 `exists()` 不够 —— 目录存在但只读同样会导致后续写入失败。
pub(crate) fn probe_writable(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建目录失败: {error}"))?;
    let probe = dir.join(".write-probe");
    fs::write(&probe, b"ok").map_err(|error| format!("目录不可写: {error}"))?;
    fs::remove_file(&probe).map_err(|error| format!("无法删除探针文件: {error}"))?;
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

/// 解析存储布局：优先 D:\TangYuan，不可写时回退到用户配置目录。
/// 程序必须永远能启动，所以回退是兜底而非报错。
pub(crate) fn resolve_storage(app: &AppHandle) -> StorageLayout {
    let preferred = PathBuf::from(PREFERRED_ROOT);
    let mut fallback = false;
    let mut note = String::new();

    let root = match probe_writable(&preferred) {
        Ok(()) => preferred,
        Err(primary_error) => {
            fallback = true;
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            match probe_writable(&dir) {
                Ok(()) => {
                    note = format!(
                        "{PREFERRED_ROOT} 不可用（{primary_error}），已回退到 {}",
                        dir.display()
                    );
                    dir
                }
                Err(fallback_error) => {
                    // 两个位置都不可写：仍返回首选路径，具体读写命令会给出明确错误
                    note = format!(
                        "{PREFERRED_ROOT} 与 {} 均不可写（{primary_error} / {fallback_error}）",
                        dir.display()
                    );
                    PathBuf::from(PREFERRED_ROOT)
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

pub(crate) fn write_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(path, content).map_err(|error| format!("写入失败: {error}"))
}

pub(crate) fn read_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("读取失败: {error}"))
}