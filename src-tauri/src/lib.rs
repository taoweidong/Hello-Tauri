mod commands;
mod db;
mod logging;
mod storage;

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
            db::db_execute,
            db::db_select,
            db::db_transaction,
            db::db_migrate
        ])
        .run(tauri::generate_context!())
        .expect("启动 Hello-Tauri 失败");
}