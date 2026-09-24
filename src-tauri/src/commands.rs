use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 需求指定的数据根目录：配置、日志、数据全部落在这里。
const PREFERRED_ROOT: &str = "D:\\TangYuan";

const CONFIG_SUBDIR: &str = "config";
const DATA_SUBDIR: &str = "data";
const LOGS_SUBDIR: &str = "logs";

const CONFIG_FILE: &str = "config.json";
const TABLE_FILE: &str = "table.json";

/// 日志文件保留份数（按日期命名，字典序即时序），超出后删除最旧的。
const LOG_KEEP: usize = 30;

/// 单条日志的最大长度，防止前端异常把整个堆栈灌进来。
const LOG_LINE_MAX: usize = 4000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StorageLayout {
    /// 实际生效的存储根目录
    root: String,
    /// 首选目录 D:\TangYuan
    preferred_root: String,
    config_file: String,
    table_file: String,
    logs_dir: String,
    /// 是否发生了降级回退
    fallback: bool,
    /// 降级原因（正常时为空串）
    note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    tauri_version: String,
    platform: String,
    arch: String,
    config_path: String,
    storage: StorageLayout,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Timestamp {
    date: String,
    clock: String,
}

/// 真实探测目录是否可写：创建目录 -> 写探针文件 -> 删除。
/// 只判断 `exists()` 不够 —— 目录存在但只读同样会导致后续写入失败。
fn probe_writable(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建目录失败: {error}"))?;
    let probe = dir.join(".write-probe");
    fs::write(&probe, b"ok").map_err(|error| format!("目录不可写: {error}"))?;
    fs::remove_file(&probe).map_err(|error| format!("无法删除探针文件: {error}"))?;
    Ok(())
}

/// 解析存储布局：优先 D:\TangYuan，不可写时回退到用户配置目录。
/// 程序必须永远能启动，所以回退是兜底而非报错。
fn resolve_storage(app: &AppHandle) -> StorageLayout {
    let preferred = PathBuf::from(PREFERRED_ROOT);
    let mut fallback = false;
    let mut note = String::new();

    let root = match probe_writable(&preferred) {
        Ok(()) => preferred.clone(),
        Err(primary_error) => {
            fallback = true;
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            match probe_writable(&dir) {
                Ok(()) => {
                    note = format!(
                        "{PREFERRED_ROOT} 不可用（{primary_error}），已回退到 {}",
                        dir.display()
                    );
                    dir
                }
                Err(fallback_error) => {
                    // 两个位置都不可写：仍返回首选路径，具体读写命令会给出明确错误
                    note = format!(
                        "{PREFERRED_ROOT} 与 {} 均不可写（{primary_error} / {fallback_error}）",
                        dir.display()
                    );
                    preferred.clone()
                }
            }
        }
    };

    let config_file = root.join(CONFIG_SUBDIR).join(CONFIG_FILE);
    let table_file = root.join(DATA_SUBDIR).join(TABLE_FILE);
    let logs_dir = root.join(LOGS_SUBDIR);

    StorageLayout {
        root: root.to_string_lossy().to_string(),
        preferred_root: PREFERRED_ROOT.to_string(),
        config_file: config_file.to_string_lossy().to_string(),
        table_file: table_file.to_string_lossy().to_string(),
        logs_dir: logs_dir.to_string_lossy().to_string(),
        fallback,
        note,
    }
}

fn write_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败: {error}"))?;
    }
    fs::write(path, content).map_err(|error| format!("写入失败: {error}"))
}

fn read_file(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("读取失败: {error}"))
}

// ---------- 时间戳：直接用 Win32 GetLocalTime，避免引入 chrono 传递依赖 ----------

#[cfg(windows)]
fn now_local() -> Timestamp {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut st) };
    Timestamp {
        date: format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay),
        clock: format!(
            "{:02}:{:02}:{:02}.{:03}",
            st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
        ),
    }
}

/// 非 Windows 目标仅用于保证可编译（本项目只发布 Windows）。
#[cfg(not(windows))]
fn now_local() -> Timestamp {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;

    // Howard Hinnant 的 civil_from_days 算法
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    Timestamp {
        date: format!("{year:04}-{m:02}-{d:02}"),
        clock: format!(
            "{:02}:{:02}:{:02}.000",
            rem / 3600,
            (rem % 3600) / 60,
            rem % 60
        ),
    }
}

/// 日志目录只保留最近 LOG_KEEP 份（文件名日期字典序等于时序）。
fn prune_logs(logs_dir: &Path) {
    let Ok(entries) = fs::read_dir(logs_dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("app-") && name.ends_with(".log"))
        })
        .collect();

    if files.len() <= LOG_KEEP {
        return;
    }
    files.sort();
    let remove_count = files.len() - LOG_KEEP;
    for path in files.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub fn storage_info(app: AppHandle) -> StorageLayout {
    resolve_storage(&app)
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> Result<Option<String>, String> {
    read_file(&PathBuf::from(resolve_storage(&app).config_file))
}

#[tauri::command]
pub fn save_config(app: AppHandle, content: String) -> Result<(), String> {
    let path = PathBuf::from(resolve_storage(&app).config_file);
    write_file(&path, &content)
}

#[tauri::command]
pub fn read_table(app: AppHandle) -> Result<Option<String>, String> {
    read_file(&PathBuf::from(resolve_storage(&app).table_file))
}

#[tauri::command]
pub fn write_table(app: AppHandle, content: String) -> Result<(), String> {
    let path = PathBuf::from(resolve_storage(&app).table_file);
    write_file(&path, &content)
}

/// 追加一行日志。日志失败不影响业务，统一吞掉错误只回传状态。
#[tauri::command]
pub fn append_log(app: AppHandle, level: String, message: String) -> Result<String, String> {
    let layout = resolve_storage(&app);
    let logs_dir = PathBuf::from(&layout.logs_dir);
    fs::create_dir_all(&logs_dir).map_err(|error| format!("创建日志目录失败: {error}"))?;

    let now = now_local();
    let mut text = message.replace(['\r', '\n'], " ");
    if text.len() > LOG_LINE_MAX {
        // 按字符边界截断，避免切坏 UTF-8
        let mut cut = LOG_LINE_MAX;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str(" …[已截断]");
    }

    let file = logs_dir.join(format!("app-{}.log", now.date));
    let line = format!("{} [{}] {}\n", now.clock, level.to_uppercase(), text);
    let mut handle = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|error| format!("打开日志文件失败: {error}"))?;
    handle
        .write_all(line.as_bytes())
        .map_err(|error| format!("写入日志失败: {error}"))?;

    prune_logs(&logs_dir);
    Ok(file.to_string_lossy().to_string())
}

/// 在资源管理器中打开存储目录。用 explorer 直接调用，不引入任何插件。
#[tauri::command]
pub fn open_storage_dir(app: AppHandle) -> Result<(), String> {
    let layout = resolve_storage(&app);
    let dir = PathBuf::from(&layout.root);
    fs::create_dir_all(&dir).map_err(|error| format!("创建目录失败: {error}"))?;

    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|error| format!("无法打开资源管理器: {error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(format!("当前平台不支持打开目录: {}", dir.display()))
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let storage = resolve_storage(&app);
    let package = app.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        tauri_version: tauri::VERSION.to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        config_path: storage.config_file.clone(),
        storage,
    }
}