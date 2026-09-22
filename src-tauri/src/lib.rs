mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::load_config,
            commands::save_config,
            commands::app_info
        ])
        .run(tauri::generate_context!())
        .expect("启动 Hello-Tauri 失败");
}
