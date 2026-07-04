use crate::error::AppError;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

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

pub fn decompress_zip(data: &[u8], output_dir: &str) -> Result<Vec<DecompressedFile>, AppError> {
    let reader = io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| AppError::Decompress(e.to_string()))?;

    let out = Path::new(output_dir);
    fs::create_dir_all(out)?;

    let mut files = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| AppError::Decompress(e.to_string()))?;

        let outpath = out.join(file.name());

        // Zip Slip 防护：确保解压路径在目标目录内
        if !outpath.starts_with(out) {
            return Err(AppError::Decompress(format!(
                "非法路径，拒绝解压: {}",
                file.name()
            )));
        }

        if file.is_dir() {
            fs::create_dir_all(&outpath)?;
            files.push(DecompressedFile {
                name: file.name().to_string(),
                path: outpath.to_string_lossy().to_string(),
                size: 0,
                is_directory: true,
            });
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = File::create(&outpath)?;
            io::copy(&mut file, &mut outfile)?;
            files.push(DecompressedFile {
                name: file.name().to_string(),
                path: outpath.to_string_lossy().to_string(),
                size: file.size(),
                is_directory: false,
            });
        }
    }
    Ok(files)
}

pub fn decompress_gzip(data: &[u8], output_dir: &str) -> Result<Vec<DecompressedFile>, AppError> {
    let out = Path::new(output_dir);
    fs::create_dir_all(out)?;

    let mut decoder = flate2::read::GzDecoder::new(data);
    let mut buffer = Vec::new();
    decoder.read_to_end(&mut buffer)
        .map_err(|e| AppError::Decompress(e.to_string()))?;

    let outpath = out.join("decompressed");
    fs::write(&outpath, &buffer)?;

    Ok(vec![DecompressedFile {
        name: "decompressed".to_string(),
        path: outpath.to_string_lossy().to_string(),
        size: buffer.len() as u64,
        is_directory: false,
    }])
}
