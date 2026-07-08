use crate::error::AppError;
use crate::file_ops;
use crate::decompress;
use std::path::{Path, PathBuf, Component};
use tauri::Manager;

/// 路径安全校验：
/// 1. 逐段检查路径组件，拒绝包含 `..` 的路径
/// 2. 若提供 allowed_base，则校验解析后的绝对路径必须在允许目录内
/// 3. 对不存在的文件，先 canonicalize 父目录再拼接文件名
fn validate_path(path: &str, allowed_base: Option<&Path>) -> Result<PathBuf, AppError> {
    let input = Path::new(path);

    // 逐段检查路径组件，拒绝 .. 组件
    for component in input.components() {
        if matches!(component, Component::ParentDir) {
            return Err(AppError::Permission("路径包含 '..' 组件，不允许路径穿越".into()));
        }
    }

    let resolved = PathBuf::from(path);

    if let Some(base) = allowed_base {
        // 对 base 路径做 canonicalize
        let base_canonical = base.canonicalize()
            .map_err(|_| AppError::Permission("基础目录不存在或无法访问".into()))?;

        // 对目标路径：若存在则 canonicalize，否则 canonicalize 父目录后拼接文件名
        let canonical = if resolved.exists() {
            resolved.canonicalize()?
        } else {
            // 文件不存在（如 write_file / ensure_dir），对父目录做 canonicalize
            if let Some(parent) = resolved.parent() {
                if parent.as_os_str().is_empty() {
                    // 相对路径无父目录，使用 base
                    base_canonical.join(resolved.file_name().unwrap_or_default())
                } else {
                    let canon_parent = parent.canonicalize()
                        .unwrap_or_else(|_| base_canonical.clone());
                    canon_parent.join(resolved.file_name().unwrap_or_default())
                }
            } else {
                // 无父目录也无文件名，退回 base
                base_canonical.clone()
            }
        };

        if !canonical.starts_with(&base_canonical) {
            tracing::warn!("路径校验失败: '{}' 不在允许目录 '{}' 内", path, base.display());
            return Err(AppError::Permission(format!(
                "路径 '{}' 不在允许目录 '{}' 内",
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
    tracing::info!("读取文件: {}", resolved.display());
    tokio::fs::read(&resolved).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(path.clone())
        } else {
            AppError::Io(e)
        }
    })
}

#[tauri::command]
pub async fn write_file(path: String, data: Vec<u8>, app: tauri::AppHandle) -> Result<(), AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    tracing::info!("写入文件: {} ({} 字节)", resolved.display(), data.len());
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
    let dir = app_data_base(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

/// 递归创建目录（若已存在则忽略）
#[tauri::command]
pub async fn ensure_dir(path: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    tracing::info!("创建目录: {}", resolved.display());
    tokio::fs::create_dir_all(&resolved).await.map_err(AppError::Io)
}

/// 检查文件或目录是否存在
#[tauri::command]
pub async fn file_exists(path: String, app: tauri::AppHandle) -> Result<bool, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    tokio::fs::try_exists(&resolved).await.map_err(AppError::Io)
}

/// 删除单个文件（仅限普通文件，不删除目录）
#[tauri::command]
pub async fn delete_file(path: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;

    // 检查目标是否为普通文件（防止删除目录或符号链接目标）
    let metadata = tokio::fs::metadata(&resolved).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound(path.clone())
        } else {
            AppError::Io(e)
        }
    })?;

    if !metadata.is_file() {
        return Err(AppError::InvalidInput(format!(
            "'{}' 不是普通文件，拒绝删除",
            resolved.display()
        )));
    }

    tracing::info!("删除文件: {}", resolved.display());
    tokio::fs::remove_file(&resolved).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn mmap_read(path: String, offset: u64, length: u64, app: tauri::AppHandle) -> Result<Vec<u8>, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&path, Some(&base))?;
    let path_clone = resolved.clone();
    // 使用 spawn_blocking 避免同步 I/O 阻塞异步运行时
    tokio::task::spawn_blocking(move || {
        file_ops::mmap_read(&path_clone, offset, length)
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?
}

#[tauri::command]
pub async fn list_files(dir: String, app: tauri::AppHandle) -> Result<Vec<file_ops::FileMeta>, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&dir, Some(&base))?;
    let dir_clone = resolved.clone();
    // 使用 spawn_blocking 避免递归遍历阻塞异步运行时
    tokio::task::spawn_blocking(move || {
        file_ops::list_files(&dir_clone)
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?
}

#[tauri::command]
pub async fn decompress(data: Vec<u8>, format: String, output_dir: String, file_name: Option<String>, app: tauri::AppHandle) -> Result<decompress::DecompressResult, AppError> {
    let base = app_data_base(&app)?;
    let resolved = validate_path(&output_dir, Some(&base))?;

    let result = match format.as_str() {
        "zip" => decompress::decompress_zip(&data, &resolved),
        "gzip" => decompress::decompress_gzip(&data, &resolved, file_name.as_deref()),
        _ => return Err(AppError::UnsupportedFormat(format)),
    };

    match result {
        Ok(files) => Ok(decompress::DecompressResult { success: true, files, error: None }),
        Err(e) => {
            tracing::error!("解压失败: {}", e);
            Ok(decompress::DecompressResult { success: false, files: vec![], error: Some(e.to_string()) })
        }
    }
}
