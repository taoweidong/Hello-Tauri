use crate::error::AppError;

#[tauri::command]
pub async fn read_file(path: String) -> Result<Vec<u8>, AppError> {
    let file_path = std::path::Path::new(&path);
    if path.contains("..") {
        return Err(AppError::NotFound("Path traversal not allowed".into()));
    }
    tokio::fs::read(file_path).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn get_temp_dir() -> Result<String, AppError> {
    let dir = std::env::temp_dir();
    Ok(dir.to_string_lossy().to_string())
}
