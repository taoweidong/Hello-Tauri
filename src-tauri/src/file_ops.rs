use crate::error::AppError;
use memmap2::Mmap;
use std::fs::File;
use std::path::Path;

pub fn mmap_read(path: &str, offset: u64, length: u64) -> Result<Vec<u8>, AppError> {
    let file = File::open(path)?;
    let mmap = unsafe { Mmap::map(&file)? };
    let start = offset as usize;
    let end = (offset + length) as usize;
    if end > mmap.len() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Read range exceeds file size",
        )));
    }
    Ok(mmap[start..end].to_vec())
}

pub fn list_files(dir: &str) -> Result<Vec<FileMeta>, AppError> {
    let mut results = Vec::new();
    walk_dir(Path::new(dir), &mut results)?;
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

fn walk_dir(dir: &Path, results: &mut Vec<FileMeta>) -> Result<(), AppError> {
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
                walk_dir(&path, results)?;
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
        let dir = std::env::temp_dir().join("test_mmap");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.txt");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let result = mmap_read(path.to_str().unwrap(), 0, 5).unwrap();
        assert_eq!(result, b"hello");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn test_list_files() {
        let dir = std::env::temp_dir().join("test_list");
        std::fs::create_dir_all(&dir).unwrap();
        File::create(dir.join("a.txt")).unwrap();
        File::create(dir.join("b.txt")).unwrap();

        let files = list_files(dir.to_str().unwrap()).unwrap();
        assert_eq!(files.len(), 2);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
