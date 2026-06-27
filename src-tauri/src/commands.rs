use crate::error::AppError;
use crate::file_ops;
use crate::decompress;

#[tauri::command]
pub async fn read_file(path: String) -> Result<Vec<u8>, AppError> {
    if path.contains("..") {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Path traversal not allowed",
        )));
    }
    tokio::fs::read(&path).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn write_file(path: String, data: Vec<u8>) -> Result<(), AppError> {
    tokio::fs::write(&path, &data).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn get_temp_dir() -> Result<String, AppError> {
    let dir = std::env::temp_dir();
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn mmap_read(path: String, offset: u64, length: u64) -> Result<Vec<u8>, AppError> {
    file_ops::mmap_read(&path, offset, length)
}

#[tauri::command]
pub fn list_files(dir: String) -> Result<Vec<file_ops::FileMeta>, AppError> {
    file_ops::list_files(&dir)
}

#[tauri::command]
pub fn decompress(data: Vec<u8>, format: String, output_dir: String) -> Result<decompress::DecompressResult, AppError> {
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
