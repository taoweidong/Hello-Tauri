use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("解压错误: {0}")]
    Decompress(String),
    #[error("Zip 错误: {0}")]
    Zip(String),
    #[error("未找到: {0}")]
    NotFound(String),
    #[error("权限拒绝: {0}")]
    Permission(String),
    #[error("不支持的格式: {0}")]
    UnsupportedFormat(String),
    #[error("无效输入: {0}")]
    InvalidInput(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
