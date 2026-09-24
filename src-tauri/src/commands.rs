use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

use crate::logging;
use crate::storage::{self, StorageLayout};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    tauri_version: String,
    platform: String,
    arch: String,
    config_path: String,
    storage: StorageLayout,
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub fn storage_info(app: AppHandle) -> StorageLayout {
    storage::resolve_storage(&app)
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> Result<Option<String>, String> {
    storage::read_file(&PathBuf::from(storage::resolve_storage(&app).config_file))
}

#[tauri::command]
pub fn save_config(app: AppHandle, content: String) -> Result<(), String> {
    let path = PathBuf::from(storage::resolve_storage(&app).config_file);
    storage::write_file(&path, &content)
}

#[tauri::command]
pub fn read_table(app: AppHandle) -> Result<Option<String>, String> {
    storage::read_file(&PathBuf::from(storage::resolve_storage(&app).table_file))
}

#[tauri::command]
pub fn write_table(app: AppHandle, content: String) -> Result<(), String> {
    let path = PathBuf::from(storage::resolve_storage(&app).table_file);
    storage::write_file(&path, &content)
}

/// 追加一行日志。日志失败不影响业务，错误以字符串回传由前端静默处理。
#[tauri::command]
pub fn append_log(app: AppHandle, level: String, message: String) -> Result<String, String> {
    let layout = storage::resolve_storage(&app);
    let file = logging::append_line(&PathBuf::from(&layout.logs_dir), &level, &message)?;
    Ok(file.to_string_lossy().to_string())
}

/// 在资源管理器中打开存储目录。用 explorer 直接调用，不引入任何插件。
#[tauri::command]
pub fn open_storage_dir(app: AppHandle) -> Result<(), String> {
    let layout = storage::resolve_storage(&app);
    let dir = PathBuf::from(&layout.root);
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建目录失败: {error}"))?;

    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|error| format!("无法打开资源管理器: {error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(format!("当前平台不支持打开目录: {}", dir.display()))
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let storage = storage::resolve_storage(&app);
    let package = app.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        config_path: storage.config_file.clone(),
        storage,
    }
}