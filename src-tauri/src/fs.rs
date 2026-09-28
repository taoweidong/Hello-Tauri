use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::AppHandle;

use crate::storage;

/// 把相对路径安全解析到存储根之下。只接受不含绝对前缀、盘符、`..` 的路径；
/// 返回归一化后的绝对路径。`..` 与 RootDir/Prefix 组件一律拒绝，因此字符串层面
/// 的拼接结果必然落在根目录内。
///
/// **为什么还需要 [`contain_root`] 的二次复核**（S-6）：字符串检查挡不住
/// **文件系统层面**的逃逸 —— 若存储根内存在指向根外的符号链接或目录联接
/// （junction），拼接出来的路径词法上在根内、实际读写却落在根外。
/// 词法检查是「第一道门」，canonicalize 复核是「第二道门」。
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

/// 去掉 Windows 的 `\\?\` 扩展长度前缀，便于前缀比较。
fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

/// 复核 `target`（若已存在）的真实位置确实在 `root` 之内。
///
/// 关键细节：**canonicalize 对不存在的路径会失败**，而 `fs_write` 的常规用法
/// 就是「写一个还不存在的文件」。因此这里向上回溯到最近的存在祖先做复核 ——
/// 判据是「已存在的部分没有逃出根」，那么在其下新建的文件也不可能逃出。
fn contain_root(root: &Path, target: &Path) -> Result<(), String> {
    // root 本身也可能是个符号链接/联接，先取其真实路径再比对
    let real_root = strip_verbatim(&fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf()));
    let mut probe = target;
    loop {
        if probe.exists() {
            let real = strip_verbatim(&fs::canonicalize(probe).map_err(|e| format!("路径解析失败: {e}"))?);
            if real.starts_with(&real_root) {
                return Ok(());
            }
            return Err(format!(
                "路径经符号链接/联接落在存储根之外，已拒绝：{}",
                target.display()
            ));
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent,
            // 回溯到根仍不存在（含 root 本身未创建）：交给调用方的
            // create_dir_all / write 去报具体错误，不在这里误报为越权
            _ => return Ok(()),
        }
    }
}

/// 通用文件读（相对存储根），不存在返回 None。
#[tauri::command]
pub fn fs_read(app: AppHandle, relative: String) -> Result<Option<String>, String> {
    let root = PathBuf::from(storage::resolve_storage(&app).root);
    let target = resolve_within_root(&root, &relative)?;
    if !target.exists() {
        return Ok(None);
    }
    // S-6：读之前复核真实位置（挡符号链接/junction 逃逸）
    contain_root(&root, &target)?;
    fs::read_to_string(&target)
        .map(Some)
        .map_err(|error| format!("读取失败: {error}"))
}

/// 通用文件写（相对存储根），自动建父目录，返回落盘的绝对路径。
#[tauri::command]
pub fn fs_write(app: AppHandle, relative: String, content: String) -> Result<String, String> {
    let root = PathBuf::from(storage::resolve_storage(&app).root);
    let target = resolve_within_root(&root, &relative)?;
    // S-6：写之前复核。顺序很重要 —— 必须在 **create_dir_all 之前**，
    // 否则建出目录再检查就晚了（目录已落在根外）。
    contain_root(&root, &target)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(&target, content).map_err(|error| format!("写入失败: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}