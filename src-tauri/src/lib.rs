/// Tauri 应用启动入口
/// 仅注册官方插件，不包含自定义业务逻辑
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("Tauri 应用运行错误");
}
