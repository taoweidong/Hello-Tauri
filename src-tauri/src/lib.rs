mod cli;
mod commands;
mod db;
mod fs;
mod logging;
mod shell;
mod storage;
mod sysinfo;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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