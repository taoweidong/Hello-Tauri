use crate::error::AppError;
use crate::file_ops;
use crate::decompress;
use tauri::Manager;

/// 路径安全校验：拒绝包含 `..` 的路径，防止路径穿越攻击
fn validate_path(path: &str) -> Result<(), AppError> {
    if path.contains("..") {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Path traversal not allowed",
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<Vec<u8>, AppError> {
    validate_path(&path)?;
    tokio::fs::read(&path).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn write_file(path: String, data: Vec<u8>) -> Result<(), AppError> {
    validate_path(&path)?;
    tokio::fs::write(&path, &data).await.map_err(AppError::Io)
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
pub async fn ensure_dir(path: String) -> Result<(), AppError> {
    validate_path(&path)?;
    tokio::fs::create_dir_all(&path).await.map_err(AppError::Io)
}

/// 检查文件或目录是否存在
#[tauri::command]
pub async fn file_exists(path: String) -> Result<bool, AppError> {
    validate_path(&path)?;
    Ok(tokio::fs::try_exists(&path).await.unwrap_or(false))
}

/// 删除单个文件
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), AppError> {
    validate_path(&path)?;
    tokio::fs::remove_file(&path).await.map_err(AppError::Io)
}

#[tauri::command]
pub fn mmap_read(path: String, offset: u64, length: u64) -> Result<Vec<u8>, AppError> {
    validate_path(&path)?;
    file_ops::mmap_read(&path, offset, length)
}

#[tauri::command]
pub fn list_files(dir: String) -> Result<Vec<file_ops::FileMeta>, AppError> {
    validate_path(&dir)?;
    file_ops::list_files(&dir)
}

#[tauri::command]
pub fn decompress(data: Vec<u8>, format: String, output_dir: String) -> Result<decompress::DecompressResult, AppError> {
    validate_path(&output_dir)?;
    let result = match format.as_str() {
        "zip" => decompress::decompress_zip(&data, &output_dir),
        "gzip" => decompress::decompress_gzip(&data, &output_dir),
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
