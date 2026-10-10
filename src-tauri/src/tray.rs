//! 系统托盘驻留（docs/design-service-residency-2026-10-10.md）。
//!
//! 边界（T-L/T-N）：只做「建托盘 + 拦关窗 + 显隐窗 + 状态显示」，零业务规则。
//! 托盘动作 → host 事件推给前端，由 `src/stores/welink/host-link.ts` 决策；
//! 菜单文案/tooltip ← 前端经 `tray_set_status` 回写（单一真值在 store.status，T-K）。
//!
//! [TRAY-ASSUME] 核实记录（设计 §11，实施期逐项过）：
//!  * V-1 `default_window_icon()`：bundle.active=false 下仍由 codegen 从 bundle.icon
//!    嵌入窗口图标（实现期已留 include_image 编译期兜底双路）；
//!  * V-2 `additionalBrowserArgs` 为整体替换语义（写全默认三项，见 tauri.conf.json）；
//!  * V-4 菜单文案更新不走 `tray.menu()`（tauri 2.11.6 的 TrayIcon 无该访问器），
//!    改为 build() 时把「暂停/恢复」项句柄存入 `PAUSE_ITEM`（tauri 菜单包装
//!    unsafe impl Send/Sync，可入静态量；set_text 内部自行路由主线程）。

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::OnceLock;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};

use crate::shell;

/// 托盘 id / 主窗 label（与 tauri.conf.json windows[0].label 一致）
pub const TRAY_ID: &str = "main-tray";
pub const MAIN_WINDOW: &str = "main";

/// 菜单项 id（tray_set_status 经 PAUSE_ITEM 直接回写「暂停/恢复」文案）
pub const MENU_OPEN: &str = "tray-open";
pub const MENU_PAUSE: &str = "tray-pause";
pub const MENU_QUIT: &str = "tray-quit";

/// Rust → 前端 host 事件白名单（与 `src/api/types.ts` 的 `HostEventName` 一一对应，T-H）
pub const EV_WINDOW_HIDDEN: &str = "host://window-hidden";
pub const EV_WINDOW_SHOWN: &str = "host://window-shown";
pub const EV_TRAY_TOGGLE: &str = "host://tray-toggle";

/// 关闭策略（T-B）：0 = 隐藏入托盘（默认），1 = 直接退出。真值在前端配置，启动时下发。
const POLICY_HIDE: u8 = 0;
const POLICY_QUIT: u8 = 1;
static CLOSE_POLICY: AtomicU8 = AtomicU8::new(POLICY_HIDE);

/// 首次入托盘的气球提示只发一次（进程生命周期）
static FIRST_HIDE_DONE: AtomicBool = AtomicBool::new(false);

/// 「暂停/恢复」菜单项句柄：build() 时写入，tray_set_status 回写文案用。
/// tauri 菜单包装为 Send/Sync（内部访问统一路由主线程），可安全入静态量。
static PAUSE_ITEM: OnceLock<MenuItem<Wry>> = OnceLock::new();

/// 创建托盘。在 setup 里调用：建不出来即启动失败（宁可早暴露，不做静默降级——
/// 「驻留能力」是本次交付的主体，不允许出现「看起来启动了但其实没托盘」态）。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "打开主界面", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, MENU_PAUSE, "暂停服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let sep_a = PredefinedMenuItem::separator(app)?;
    let sep_b = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep_a, &pause, &sep_b, &quit])?;
    let _ = PAUSE_ITEM.set(pause);

    // T-E：图标零外部文件。优先默认窗图标（codegen 自 bundle.icon 嵌入）；
    // 取不到则 include_image 编译期嵌入兜底（相对 CARGO_MANIFEST_DIR 解析）。
    let icon = match app.default_window_icon() {
        Some(image) => image.clone(),
        None => tauri::include_image!("icons/32x32.png"),
    };

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Hello-Tauri · 服务运行中")
        .menu(&menu)
        // Windows 默认左键也会弹菜单，关掉才能把「左键=唤回窗口」让给 TrayIconEvent（T-F）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main(app),
            MENU_PAUSE => {
                // Rust 不判断「该暂停还是恢复」——动作语义全在前端（T-L）
                let _ = app.emit(EV_TRAY_TOGGLE, ());
            }
            MENU_QUIT => {
                // T-C：直接终止。WAL 已提交即持久；sending 中断态由
                // orchestrator/bootstrap 三分支恢复兜底（设计 §4.5）。
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击抬起/双击 → 唤回窗口；右键交给系统弹 Menu，此处不处理
            let left_activate = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );
            if left_activate {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// 恢复并聚焦主窗口。托盘左键、菜单「打开主界面」、单实例二次启动唤回，三路共用。
pub fn show_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit(EV_WINDOW_SHOWN, ());
}

/// 主窗口事件闸口（挂 `Builder::on_window_event`）：
/// X / Alt+F4 / 任务栏关闭 → 按策略拦截隐藏（默认）或放行退出。
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if CLOSE_POLICY.load(Ordering::Relaxed) == POLICY_QUIT {
        return; // 不拦截：走 Tauri 默认「最后窗口关闭即退出」，等价旧行为（T-B）
    }
    api.prevent_close();
    if window.hide().is_err() {
        return; // 隐藏失败也不退出：宁可窗口异常，不可静默杀服务
    }
    let _ = window.emit(EV_WINDOW_HIDDEN, ());
    // T-A：首次入托盘一次性指引（复用 Shell_NotifyIcon 气球通道；内部自带 10s 延迟清理，
    // 调用即返回不阻塞事件循环）。
    if !FIRST_HIDE_DONE.swap(true, Ordering::Relaxed) {
        let _ = shell::notify_blocking(
            "已收进系统托盘",
            "服务继续运行。左键托盘图标恢复界面；右键托盘图标可退出程序。",
        );
    }
}

/// `tray_set_close_policy`：前端把 config.json 的 closeBehavior 翻译成策略字节下发（T-B）。
#[tauri::command]
pub fn tray_set_close_policy(policy: String) -> Result<(), String> {
    match policy.as_str() {
        "tray" => CLOSE_POLICY.store(POLICY_HIDE, Ordering::Relaxed),
        "quit" => CLOSE_POLICY.store(POLICY_QUIT, Ordering::Relaxed),
        other => return Err(format!("未知关闭策略：{other}")),
    }
    Ok(())
}

/// `tray_set_status`（T-K/T-F）：前端回写服务状态 → 菜单动态文案 + tooltip。
/// 只读改显示，不改行为；托盘未就绪（构建失败等异常态）返回 Err 由前端折叠为结果对象。
///
/// panic = "abort" 约束下的纪律（设计 §8.2 注）：回调与命令内零 unwrap，
/// 可失败点全部 `let _ =` —— 显示劣化可容忍，服务崩溃不可容忍。
#[tauri::command]
pub fn tray_set_status(app: AppHandle, running: bool, status_text: String) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Err("托盘未就绪".into());
    };
    if let Some(item) = PAUSE_ITEM.get() {
        let _ = item.set_text(if running { "暂停服务" } else { "恢复服务" });
    }
    let _ = tray.set_tooltip(Some(format!("Hello-Tauri · {status_text}")));
    Ok(())
}

/// 供单测锁定「菜单项 id 与事件匹配键一致」：托盘菜单事件按 id 字符串分发，
/// id 漂移会让 MENU_OPEN/MENU_PAUSE/MENU_QUIT 静默失联。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_ids_are_distinct_and_prefixed() {
        let ids = [MENU_OPEN, MENU_PAUSE, MENU_QUIT];
        for (i, a) in ids.iter().enumerate() {
            for b in ids.iter().skip(i + 1) {
                assert_ne!(a, b, "菜单项 id 重复：{a}");
            }
            assert!(a.starts_with("tray-"), "菜单项 id 缺少前缀：{a}");
        }
    }

    #[test]
    fn host_events_match_bridge_whitelist() {
        // 与 src/api/types.ts 的 HostEventName 逐字一致（T-H），任何一侧漂移都会断链
        assert_eq!(EV_WINDOW_HIDDEN, "host://window-hidden");
        assert_eq!(EV_WINDOW_SHOWN, "host://window-shown");
        assert_eq!(EV_TRAY_TOGGLE, "host://tray-toggle");
    }

    #[test]
    fn close_policy_bytes_stay_distinct() {
        assert_ne!(POLICY_HIDE, POLICY_QUIT);
        assert_eq!(POLICY_HIDE, 0, "默认策略必须是「隐藏入托盘」");
    }
}
