use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::AppHandle;

use crate::storage;

/// 把相对路径安全解析到存储根之下。只接受不含绝对前缀、盘符、`..` 的路径；
/// 返回归一化后的绝对路径。`..` 与 RootDir/Prefix 组件一律拒绝，因此拼接结果
/// 必然落在根目录内，无需额外 containment 复核。
fn resolve_within_root(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute() || relative.contains(':') {
        return Err(format!("只允许存储根下的相对路径，收到：{relative}"));
    }
    let mut target = root.to_path_buf();
    for component in rel.components() {
        match component {
            Component::Normal(name) => target.push(name),
            Component::CurDir => {}
            _ => return Err(format!("非法路径片段：{relative}")),
        }
    }
    Ok(target)
}

/// 通用文件读（相对存储根），不存在返回 None。
#[tauri::command]
pub fn fs_read(app: AppHandle, relative: String) -> Result<Option<String>, String> {
    let root = PathBuf::from(storage::resolve_storage(&app).root);
    let target = resolve_within_root(&root, &relative)?;
    if !target.exists() {
        return Ok(None);
    }
    fs::read_to_string(&target)
        .map(Some)
        .map_err(|error| format!("读取失败: {error}"))
}

/// 通用文件写（相对存储根），自动建父目录，返回落盘的绝对路径。
#[tauri::command]
pub fn fs_write(app: AppHandle, relative: String, content: String) -> Result<String, String> {
    let root = PathBuf::from(storage::resolve_storage(&app).root);
    let target = resolve_within_root(&root, &relative)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(&target, content).map_err(|error| format!("写入失败: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}