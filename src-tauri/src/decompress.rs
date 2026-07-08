use crate::error::AppError;
use std::fs::{self, File};
use std::io;
use std::path::Path;

/// zip bomb 防护：累计解压大小上限（1GB）
const MAX_TOTAL_SIZE: u64 = 1_073_741_824;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompressedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompressResult {
    pub success: bool,
    pub files: Vec<DecompressedFile>,
    pub error: Option<String>,
}

/// 净化 zip 条目名称，拒绝路径穿越和非法字符
fn sanitize_zip_entry_name(name: &str) -> Result<String, AppError> {
    // 拒绝包含反斜杠、.. 或控制字符的条目名
    if name.contains('\\') || name.contains("..") {
        return Err(AppError::Zip(format!("非法条目名: {}", name)));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(AppError::Zip(format!("条目名包含控制字符: {}", name)));
    }
    Ok(name.to_string())
}

pub fn decompress_zip(data: &[u8], output_dir: &Path) -> Result<Vec<DecompressedFile>, AppError> {
    let reader = io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| AppError::Zip(e.to_string()))?;

    fs::create_dir_all(output_dir)?;

    // 对 output_dir 做 canonicalize 用于后续路径校验
    let canonical_out = output_dir.canonicalize()?;

    let mut files = Vec::new();
    let mut total_size: u64 = 0;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| AppError::Zip(e.to_string()))?;

        // 净化条目名称
        let safe_name = sanitize_zip_entry_name(file.name())?;
        let outpath = canonical_out.join(&safe_name);

        // Zip Slip 防护：规范化路径后检查前缀
        // 对不存在的文件，先规范化父目录再拼接文件名
        let safe_outpath = if outpath.exists() {
            outpath.canonicalize()?
        } else {
            // 文件尚不存在，对父目录做 canonicalize
            if let Some(parent) = outpath.parent() {
                let canon_parent = parent.canonicalize().unwrap_or_else(|_| canonical_out.clone());
                canon_parent.join(outpath.file_name().unwrap_or_default())
            } else {
                canonical_out.clone()
            }
        };

        if !safe_outpath.starts_with(&canonical_out) {
            return Err(AppError::Zip(format!(
                "路径穿越，拒绝解压: {}",
                safe_name
            )));
        }

        let file_size = file.size();

        // zip bomb 防护：检查累计解压大小
        total_size = total_size.saturating_add(file_size);
        if total_size > MAX_TOTAL_SIZE {
            return Err(AppError::Zip(format!(
                "累计解压大小超过上限 ({:.0} MB > {:.0} MB)",
                total_size as f64 / 1_048_576.0,
                MAX_TOTAL_SIZE as f64 / 1_048_576.0
            )));
        }

        if file.is_dir() {
            fs::create_dir_all(&safe_outpath)?;
            files.push(DecompressedFile {
                name: safe_name,
                path: safe_outpath.to_string_lossy().to_string(),
                size: 0,
                is_directory: true,
            });
        } else {
            if let Some(parent) = safe_outpath.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = File::create(&safe_outpath)?;
            io::copy(&mut file, &mut outfile)?;
            files.push(DecompressedFile {
                name: safe_name,
                path: safe_outpath.to_string_lossy().to_string(),
                size: file_size,
                is_directory: false,
            });
        }
    }

    tracing::info!("ZIP 解压完成: {} 个文件, 总计 {:.1} MB", files.len(), total_size as f64 / 1_048_576.0);
    Ok(files)
}

pub fn decompress_gzip(data: &[u8], output_dir: &Path, file_name: Option<&str>) -> Result<Vec<DecompressedFile>, AppError> {
    fs::create_dir_all(output_dir)?;

    // 从参数推断文件名，默认 "decompressed"
    let output_name = file_name.unwrap_or("decompressed");
    let outpath = output_dir.join(output_name);

    // 流式写入：边解码边写盘，避免全量加载到内存
    let mut decoder = flate2::read::GzDecoder::new(data);
    let mut outfile = File::create(&outpath)?;
    let written = io::copy(&mut decoder, &mut outfile)
        .map_err(|e| AppError::Decompress(e.to_string()))?;

    tracing::info!("GZIP 解压完成: {}, {:.1} MB", output_name, written as f64 / 1_048_576.0);

    Ok(vec![DecompressedFile {
        name: output_name.to_string(),
        path: outpath.to_string_lossy().to_string(),
        size: written,
        is_directory: false,
    }])
}
