mod cli;
mod commands;
mod db;
mod fs;
mod http;
mod logging;
mod shell;
mod storage;
mod sysinfo;

use std::env;
use std::path::{Component, Path, PathBuf};

use tauri::Manager;

/// WebView2 profile（用户数据目录）相对 exe 所在目录的子目录名。
const WEBVIEW_PROFILE_SUBDIR: &str = ".webview2";

/// WebView2 运行时读取的环境变量：用于**覆盖**宿主传入的 user data folder。
const WEBVIEW_PROFILE_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";

/// 两个路径是否位于同一个卷。Windows 下比较盘符前缀；拿不到盘符前缀（相对路径、
/// 设备路径等）时一律视为「同卷」—— 判不准就不干预，宁可保持上游默认行为。
fn same_volume(left: &Path, right: &Path) -> bool {
    match (left.components().next(), right.components().next()) {
        (Some(Component::Prefix(a)), Some(Component::Prefix(b))) => a.kind() == b.kind(),
        _ => true,
    }
}

/// 在 exe 同目录下挑一个 profile 目录；探针判定不可写时返回 `None`（交给 WebView2 默认位置）。
fn pick_profile_dir(exe_dir: &Path, writable: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let candidate = exe_dir.join(WEBVIEW_PROFILE_SUBDIR);
    writable(&candidate).then_some(candidate)
}

/// 跨卷时把 WebView2 的 profile 目录从 `%LOCALAPPDATA%` 挪到 exe 同目录。
///
/// 背景（2026-10-07 实测，详见 skill `hello-tauri-verify` 同名章节）：Tauri 在 Windows 上
/// **强制**把 WebView2 的 user data folder 设为 `%LOCALAPPDATA%\<identifier>`
/// （见 tauri `manager/webview.rs`：「in `windows`, we need to force a data_directory」）。
/// 当 exe 与 `%LOCALAPPDATA%` **不在同一个卷**时，部分机器的安全软件（实数：联想电脑管家 +
/// 火绒内核）会**静默拦截**该程序在 `%LOCALAPPDATA%` 下新建目录 —— 表现是 WebView2
/// 环境创建**挂起**：进程存活、窗口全白、无任何日志与报错，profile 目录**压根不会被创建**。
/// 把 profile 放到 exe 同目录即可恢复正常（同卷/同盘场景实测正常）。
///
/// 只在跨卷时才改：单卷（绝大多数机器，exe 与 AppData 同在 C:）完全保持上游默认，
/// 零行为变化。已显式设置 `WEBVIEW2_USER_DATA_FOLDER` 时不覆盖（尊重调用方的选择）。
fn configure_webview_profile() {
    if env::var_os(WEBVIEW_PROFILE_ENV).is_some_and(|value| !value.is_empty()) {
        return;
    }

    let Some(exe_dir) = env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let Ok(local_app_data) = env::var("LOCALAPPDATA") else {
        return;
    };
    // 同卷：上游默认位置可用，不动
    if same_volume(&exe_dir, Path::new(&local_app_data)) {
        return;
    }

    if let Some(profile_dir) = pick_profile_dir(&exe_dir, &|dir| storage::probe_writable(dir).is_ok()) {
        env::set_var(WEBVIEW_PROFILE_ENV, &profile_dir);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 必须在 Builder 之前：改的是 WebView2 读取的环境变量，而窗口/WebView2 在
    // `Builder::run()` 内部创建，晚一步就来不及了。
    configure_webview_profile();

    tauri::Builder::default()
        .setup(|app| {
            // 打开（必要时创建）SQLite，托管为全局状态
            let handle = app.handle().clone();
            let database = db::open_db(&handle)?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::storage_info,
            commands::storage_migrate,
            commands::load_config,
            commands::save_config,
            commands::read_table,
            commands::write_table,
            commands::append_log,
            commands::open_storage_dir,
            commands::app_info,
            fs::fs_read,
            fs::fs_write,
            db::db_execute,
            db::db_select,
            db::db_transaction,
            db::db_migrate,
            cli::cli_run,
            // —— HTTP JSON POST 通道（大模型对接：WebView fetch 受 CORS 拦截，宿主代发）——
            http::http_post_json,
            // —— Windows 基础设施通道（windows-infra-foundation）——
            sysinfo::sys_overview,
            sysinfo::sys_env_var,
            sysinfo::sys_disks,
            sysinfo::sys_adapters,
            shell::shell_open,
            shell::clipboard_read,
            shell::clipboard_write,
            shell::notify_send
        ])
        .run(tauri::generate_context!())
        .expect("启动 Hello-Tauri 失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_volume_compares_drive_prefix() {
        // 同盘 → true；异盘 → false（这是「要不要挪 profile」的判据）
        assert!(same_volume(Path::new(r"C:\a\b"), Path::new(r"C:\x\y")));
        assert!(!same_volume(Path::new(r"C:\a"), Path::new(r"E:\a")));
        assert!(!same_volume(Path::new(r"D:\a"), Path::new(r"E:\a")));
        // 拿不到盘符前缀（相对路径）→ 判不准，视为同卷、不干预
        assert!(same_volume(Path::new("relative"), Path::new(r"C:\a")));
    }

    #[test]
    fn pick_profile_dir_respects_writability() {
        let exe_dir = Path::new(r"E:\GitHub\Hello-Tauri\release");
        let picked = pick_profile_dir(exe_dir, &|_| true).expect("可写时应给出候选目录");
        assert_eq!(picked, exe_dir.join(WEBVIEW_PROFILE_SUBDIR));
        assert_eq!(picked.file_name().unwrap(), WEBVIEW_PROFILE_SUBDIR);
        // 不可写（如装在 Program Files）→ None，交给 WebView2 默认位置
        assert!(pick_profile_dir(exe_dir, &|_| false).is_none());
    }
}