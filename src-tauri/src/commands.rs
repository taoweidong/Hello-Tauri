use crate::error::AppError;
use crate::file_ops;
use crate::decompress;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 路径安全校验：
/// 1. 拒绝包含 `..` 的路径，防止路径穿越攻击
/// 2. 若提供 allowed_base，则校验解析后的绝对路径必须在允许目录内
fn validate_path(path: &str, allowed_base: Option<&Path>) -> Result<PathBuf, AppError> {
    if path.contains("..") {
        return Err(AppError::Permission("Path traversal not allowed".into()));
    }
    let resolved = PathBuf::from(path);
    if let Some(base) = allowed_base {
        // 使用 canonicalize 解析符号链接和相对路径，确保真实路径在允许范围内
        let canonical = resolved.canonicalize().unwrap_or_else(|_| resolved.clone());
        let base_canonical = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
        if !canonical.starts_with(&base_canonical) {
            return Err(AppError::Permission(format!(
                "Path '{}' is outside allowed directory '{}'",
                path,
                base.display()
            )));
        }
    }
    Ok(resolved)
}

/// 获取允许的应用数据目录基路径
fn app_data_base(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))
}

#[tauri::command]
pub async fn read_file(path: String, app: tauri::AppHandle) -> Result<Vec<u8>, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    tokio::fs::read(&resolved).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn write_file(path: String, data: Vec<u8>, app: tauri::AppHandle) -> Result<(), AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    tokio::fs::write(&resolved, &data).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn get_temp_dir() -> Result<String, AppError> {
    let dir = std::env::temp_dir();
    Ok(dir.to_string_lossy().to_string())
}

/// 返回应用数据目录路径（持久化，重启不丢失）
#[tauri::command]
pub fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    Ok(dir.to_string_lossy().to_string())
}

/// 递归创建目录（若已存在则忽略）
#[tauri::command]
pub async fn ensure_dir(path: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    tokio::fs::create_dir_all(&resolved).await.map_err(AppError::Io)
}

/// 检查文件或目录是否存在
#[tauri::command]
pub async fn file_exists(path: String, app: tauri::AppHandle) -> Result<bool, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    Ok(tokio::fs::try_exists(&resolved).await.unwrap_or(false))
}

/// 删除单个文件
#[tauri::command]
pub async fn delete_file(path: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    tokio::fs::remove_file(&resolved).await.map_err(AppError::Io)
}

#[tauri::command]
pub fn mmap_read(path: String, offset: u64, length: u64, app: tauri::AppHandle) -> Result<Vec<u8>, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    file_ops::mmap_read(&resolved.to_string_lossy(), offset, length)
}

#[tauri::command]
pub fn list_files(dir: String, app: tauri::AppHandle) -> Result<Vec<file_ops::FileMeta>, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&dir, Some(&base))?;
    file_ops::list_files(&resolved.to_string_lossy())
}

#[tauri::command]
pub fn decompress(data: Vec<u8>, format: String, output_dir: String, app: tauri::AppHandle) -> Result<decompress::DecompressResult, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&output_dir, Some(&base))?;
    let result = match format.as_str() {
        "zip" => decompress::decompress_zip(&data, &resolved.to_string_lossy()),
        "gzip" => decompress::decompress_gzip(&data, &resolved.to_string_lossy()),
        _ => return Ok(decompress::DecompressResult {
            success: false,
            files: vec![],
            error: Some(format!("Unsupported format: {}", format)),
        }),
    };
    match result {
        Ok(files) => Ok(decompress::DecompressResult { success: true, files, error: None }),
        Err(e) => Ok(decompress::DecompressResult { success: false, files: vec![], error: Some(e.to_string()) }),
    }
}
