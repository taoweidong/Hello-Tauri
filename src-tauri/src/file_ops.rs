use crate::error::AppError;
use memmap2::Mmap;
use std::fs::File;
use std::path::Path;

/// 内存映射读取文件的指定区间
///
/// # 安全性
/// `Mmap::map` 是 unsafe 操作。此处安全的前提是：
/// 文件在映射期间不会被外部进程截断或修改（只读映射场景下风险极低）。
pub fn mmap_read(path: &Path, offset: u64, length: u64) -> Result<Vec<u8>, AppError> {
    let metadata = std::fs::metadata(path)?;

    // 空文件保护：mmap 在零长度文件上会返回错误
    if metadata.len() == 0 {
        return Ok(Vec::new());
    }

    let file = File::open(path)?;
    // SAFETY: 只读映射，且文件在映射期间不会被外部修改
    let mmap = unsafe { Mmap::map(&file)? };
    let start = offset as usize;
    // 安全加法，防止 offset + length 溢出
    let end = offset
        .checked_add(length)
        .ok_or_else(|| {
            AppError::InvalidInput("offset + length 溢出".into())
        })? as usize;
    if end > mmap.len() {
        return Err(AppError::InvalidInput("读取范围超过文件大小".into()));
    }
    Ok(mmap[start..end].to_vec())
}

/// 递归列出目录下的所有文件和子目录
pub fn list_files(dir: &Path) -> Result<Vec<FileMeta>, AppError> {
    let mut results = Vec::new();
    walk_dir(dir, &mut results, 0, 20)?;
    Ok(results)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
}

/// 递归遍历目录，带深度限制防止栈溢出
fn walk_dir(dir: &Path, results: &mut Vec<FileMeta>, depth: usize, max_depth: usize) -> Result<(), AppError> {
    if depth > max_depth {
        tracing::warn!("目录遍历深度超过 {}，跳过: {}", max_depth, dir.display());
        return Ok(());
    }
    if dir.is_dir() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.metadata()?;
            results.push(FileMeta {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                size: meta.len(),
                is_directory: meta.is_dir(),
            });
            if meta.is_dir() {
                walk_dir(&path, results, depth + 1, max_depth)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_mmap_read() {
        let dir = std::env::temp_dir().join("test_mmap_ht");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.txt");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let result = mmap_read(&path, 0, 5).unwrap();
        assert_eq!(result, b"hello");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn test_mmap_read_empty_file() {
        let dir = std::env::temp_dir().join("test_mmap_empty_ht");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty.txt");
        File::create(&path).unwrap();

        let result = mmap_read(&path, 0, 0).unwrap();
        assert!(result.is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn test_list_files() {
        let dir = std::env::temp_dir().join("test_list_ht");
        std::fs::create_dir_all(&dir).unwrap();
        File::create(dir.join("a.txt")).unwrap();
        File::create(dir.join("b.txt")).unwrap();

        let files = list_files(&dir).unwrap();
        assert_eq!(files.len(), 2);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
