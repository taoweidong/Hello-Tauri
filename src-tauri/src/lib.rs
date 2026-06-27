mod commands;
mod error;
mod file_ops;
mod decompress;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::get_temp_dir,
            commands::mmap_read,
            commands::list_files,
            commands::decompress,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
