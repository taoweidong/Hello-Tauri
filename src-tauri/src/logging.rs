use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 日志文件保留份数（按日期命名，字典序即时序），超出后删除最旧的。
const LOG_KEEP: usize = 30;

/// 单条日志的最大长度，防止前端异常把整个堆栈灌进来。
const LOG_LINE_MAX: usize = 4000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Timestamp {
    pub date: String,
    pub clock: String,
}

// ---------- 时间戳：直接用 Win32 GetLocalTime，避免引入 chrono 传递依赖 ----------
// 选它而非 chrono：chrono 会拉入 iana-time-zone，该 crate 不在内网缓存，
// 会破坏「打包过程不访问公网」的硬约束。

#[cfg(windows)]
pub fn now_local() -> Timestamp {
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
pub fn now_local() -> Timestamp {
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

/// 追加一行到日志文件（文件为运维留痕，人类可读，崩溃也留痕）。
pub fn append_line(logs_dir: &Path, level: &str, message: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(logs_dir).map_err(|error| format!("创建日志目录失败: {error}"))?;

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

    prune_logs(logs_dir);
    Ok(file)
}