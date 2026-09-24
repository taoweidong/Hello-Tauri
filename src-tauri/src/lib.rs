mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::storage_info,
            commands::load_config,
            commands::save_config,
            commands::read_table,
            commands::write_table,
            commands::append_log,
            commands::open_storage_dir,
            commands::app_info
        ])
        .run(tauri::generate_context!())
        .expect("启动 Hello-Tauri 失败");
}
