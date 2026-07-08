mod commands;
mod error;
mod file_ops;
mod decompress;

pub fn run() {
    // 初始化日志系统
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
        )
        .init();

    tracing::info!("Hello-Tauri 应用启动");

    if let Err(e) = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::get_temp_dir,
            commands::get_app_data_dir,
            commands::ensure_dir,
            commands::file_exists,
            commands::delete_file,
            commands::mmap_read,
            commands::list_files,
            commands::decompress,
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("Tauri 应用运行错误: {e}");
        std::process::exit(1);
    }
}
