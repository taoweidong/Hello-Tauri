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
//!
//! 【2026-10-11 第三轮实机勘误】tray-icon crate 对 `Shell_NotifyIconW(NIM_ADD)` 的
//! 失败**静默吞掉**（crate 源码：失败仅「保持窗口存活等 TaskbarCreated」），而部分
//! 安全软件会对未签名 exe 的 NIM_ADD 返回 ACCESS_DENIED —— 表现为「build 成功、
//! 应用照常启动，但 explorer 里根本没有图标」（设计 §15.6 根因）。因此本模块自带
//! **注册验证 + 守护重试**（`spawn_tray_guardian`，以 `TrayIcon::rect()` 为对账手段）、
//! **可见区钉住**（`ensure_icon_promoted`，写 NotifyIconSettings 的 IsPromoted）与
//! **诚实上报**（`tray_health` 命令 + Blocked 态关窗回退旧行为，绝不「藏进不存在的托盘」）。

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
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
/// 用 Mutex 而非 OnceLock：守护线程重建托盘（注册失败重试/钉住可见区重加）时
/// 菜单项句柄会换新，必须可覆盖写入。
static PAUSE_ITEM: Mutex<Option<MenuItem<Wry>>> = Mutex::new(None);

/// 托盘注册状态（守护线程对账 `TrayIcon::rect()` 后写入；`tray_health` 与关窗闸口只读）：
/// 0 = 验证中（启动宽限期内尚无结论），1 = explorer 已接纳图标，2 = 确认被拒。
const STATE_VERIFYING: u8 = 0;
const STATE_REGISTERED: u8 = 1;
const STATE_BLOCKED: u8 = 2;
static TRAY_STATE: AtomicU8 = AtomicU8::new(STATE_VERIFYING);

/// 图标是否已钉在任务栏**可见**通知区（NotifyIconSettings 的 IsPromoted=1）。
/// Win11 默认把新图标收进「^」溢出区，不钉住则右下角看不见（设计 §15.6 根因二）。
static TRAY_PROMOTED: AtomicBool = AtomicBool::new(false);

/// 注册被拒时探测到的 OS 错误码（5 = ACCESS_DENIED，安全软件拦截的典型签名）。
static LAST_DENY_CODE: AtomicU32 = AtomicU32::new(0);

/// 启动验证宽限：2s × 10 次 ≈ 20s。覆盖 explorer 未就绪等瞬态；仍失败才判 Blocked。
const VERIFY_TICKS: u32 = 10;
const VERIFY_INTERVAL: Duration = Duration::from_secs(2);
/// 守护线程稳态巡检间隔：注册丢失/被拒后的重试节奏，兼顾响应与零噪声。
const GUARD_INTERVAL: Duration = Duration::from_secs(30);

/// 单实例互斥量名（Local\ 会话级命名空间）。与 single-instance 插件的互斥量相互
/// 独立：插件靠 WM_COPYDATA 跨进程唤回，实机会被安全软件静默拦截（见
/// `restore_existing_instance` 注释），本互斥量是唤回兜底通道的判据。
const INSTANCE_MUTEX: &str = "Local\\com.taowd.hello-tauri-instance";

/// 唤回事件名（自动复位，Local\ 会话级）。二次实例 `SetEvent` → 首实例
/// `spawn_wake_watcher` 的常驻线程被唤醒 → 主线程显示主窗。内核对象的等待/置位
/// 不经跨进程消息注入、不查询对方进程，是安全软件设防环境下唯一可靠的唤回方式
/// （2026-10-11 E2E 实测：WM_COPYDATA 与 OpenProcess/ShowWindow 通道均被拦截）。
const WAKE_EVENT: &str = "Local\\com.taowd.hello-tauri-wake";

/// 首实例的唤回事件句柄。以 usize 存：裸 HANDLE 非 Send/Sync，不能直接入静态量。
static WAKE_HANDLE: OnceLock<usize> = OnceLock::new();

/// tao 主窗口的窗口类名（2026-10-11 实机 EnumWindows 实测：class="Tauri Window"）。
const TAURI_WINDOW_CLASS: &str = "Tauri Window";

/// 创建托盘。在 setup 里调用：建不出来即启动失败（宁可早暴露，不做静默降级——
/// 「驻留能力」是本次交付的主体，不允许出现「看起来启动了但其实没托盘」态）。
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "打开主界面", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, MENU_PAUSE, "暂停服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let sep_a = PredefinedMenuItem::separator(app)?;
    let sep_b = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep_a, &pause, &sep_b, &quit])?;
    if let Ok(mut slot) = PAUSE_ITEM.lock() {
        *slot = Some(pause);
    }

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

/// 二次实例唤回（实机修复 2026-10-11，设计 §4.6 路线 A+B 混合 + §15.5 事件通道）。
///
/// 背景：single-instance 插件靠 WM_COPYDATA 跨进程通知首实例唤回窗口，实机被
/// 安全软件**静默拦截**（与 D:\TangYuan 拒绝访问 / Run 注册表 os error 5 同源）；
/// 备用的 EnumWindows + 跨进程 ShowWindow 实测同样被拦。最终主通道改为**命名
/// 事件**：首实例启动时创建 `WAKE_EVENT` 并由 `spawn_wake_watcher` 常驻线程等待，
/// 二次实例只需 `SetEvent`（普通内核对象操作，HIPS 不拦）后 `exit(0)`。
///
/// 本函数在 Builder 装配**之前**调用。返回 `true` = 已把唤回请求送达首实例
/// （调用方应立即退出）；`false` = 本进程是首实例或判不准（继续正常启动；
/// 插件的 WM_COPYDATA 通道保留为最后一道防线）。
pub fn restore_existing_instance() -> bool {
    #[cfg(not(windows))]
    {
        false
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM,
        };
        use windows_sys::Win32::System::Threading::{
            CreateEventW, CreateMutexW, GetCurrentProcessId, OpenEventW, OpenProcess,
            QueryFullProcessImageNameW, SetEvent, EVENT_MODIFY_STATE,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsIconic, SetForegroundWindow,
            ShowWindow, SW_RESTORE, SW_SHOW,
        };

        fn wide(text: &str) -> Vec<u16> {
            text.encode_utf16().chain(std::iter::once(0)).collect()
        }

        let name = wide(INSTANCE_MUTEX);
        let mutex = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if mutex.is_null() {
            return false; // 建不出互斥量：判不准就当首实例，不拦启动（防御式）
        }
        if GetLastError() != ERROR_ALREADY_EXISTS {
            // 首实例：句柄有意「泄漏」不关闭 —— 裸指针 HANDLE 无 Drop 语义，互斥量
            // 与进程同生命周期，进程退出由 OS 自动回收
            let _ = mutex;
            // 创建唤回事件（自动复位、初始无信号），供 spawn_wake_watcher 等待
            let event = CreateEventW(std::ptr::null(), 0, 0, wide(WAKE_EVENT).as_ptr());
            if !event.is_null() {
                let _ = WAKE_HANDLE.set(event as usize);
            }
            return false;
        }

        // —— 二次实例 ——
        // 主通道：命名事件唤回（首实例监视线程收到后在主线程显示窗口）
        let wake_name = wide(WAKE_EVENT);
        let mut signaled = false;
        let event = OpenEventW(EVENT_MODIFY_STATE, 0, wake_name.as_ptr());
        if !event.is_null() {
            signaled = SetEvent(event) != 0;
            CloseHandle(event);
        }

        // 备用通道：EnumWindows 定位首实例主窗直接 ShowWindow（类名 + exe 路径双比对，
        // 防误伤其他 Tauri 应用）。两通道都生效时幂等无害（对已显示窗口 show 是 no-op）。
        let Ok(me) = std::env::current_exe() else {
            return signaled;
        };
        struct Ctx {
            exe_lower: String,
            class: Vec<u16>,
            my_pid: u32,
            found: HWND,
        }
        let mut ctx = Ctx {
            exe_lower: me.to_string_lossy().to_lowercase(),
            class: TAURI_WINDOW_CLASS.encode_utf16().collect(),
            my_pid: GetCurrentProcessId(),
            found: std::ptr::null_mut(),
        };
        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> i32 {
            let ctx = &mut *(lparam as *mut Ctx);
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) as usize;
            if n == 0 || class[..n] != ctx.class[..] {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 || pid == ctx.my_pid {
                return 1;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return 1;
            }
            let mut path = [0u16; 1024];
            let mut len = path.len() as u32;
            let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut len);
            CloseHandle(process);
            if ok == 0 {
                return 1;
            }
            if String::from_utf16_lossy(&path[..len as usize]).to_lowercase() == ctx.exe_lower {
                ctx.found = hwnd;
                return 0; // 命中即停止枚举
            }
            1
        }
        EnumWindows(Some(cb), &mut ctx as *mut Ctx as LPARAM);

        if !ctx.found.is_null() {
            if IsIconic(ctx.found) != 0 {
                ShowWindow(ctx.found, SW_RESTORE);
            } else {
                ShowWindow(ctx.found, SW_SHOW);
            }
            SetForegroundWindow(ctx.found);
            return true;
        }
        // 找不到窗：事件已送达则首实例监视线程会显示窗口；未送达则继续启动交插件兜底
        signaled
    }
}

/// 首实例唤回监视（setup 内调用）：常驻线程等待命名事件，收到二次实例的唤回
/// 请求后经 `run_on_main_thread` 在主线程显示主窗（tauri 窗口操作统一主线程执行）。
/// `WaitForSingleObject` 是内核等待，零 CPU 占用；自动复位事件被消费后循环继续等。
pub fn spawn_wake_watcher(app: AppHandle) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};

        let Some(&handle_addr) = WAKE_HANDLE.get() else {
            return; // 事件未建成：不监视（托盘左键/菜单唤回路径不受影响）
        };
        std::thread::spawn(move || {
            let event = handle_addr as HANDLE;
            loop {
                // SAFETY：event 是首实例自建的命名事件句柄，进程存活期内有效
                let waited = unsafe { WaitForSingleObject(event, INFINITE) };
                if waited != WAIT_OBJECT_0 {
                    break; // 句柄异常：放弃监视，绝不空转烧 CPU
                }
                let target = app.clone();
                if app.run_on_main_thread(move || show_main(&target)).is_err() {
                    break; // 事件循环已收尾（进程退出中）
                }
                // 现场留痕：驻留期无 UI，日志是唤回链路唯一观察窗（设计 §13.7）。
                // best-effort：存储解析/写入失败不影响唤回本身。
                let layout = crate::storage::resolve_storage(&app);
                let _ = crate::logging::append_line(
                    std::path::Path::new(&layout.logs_dir),
                    "INFO",
                    "收到二次实例唤回请求，主窗口已恢复",
                );
            }
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// 驻留期日志留痕（与 spawn_wake_watcher 同口径：无 UI 时日志是唯一观察窗，§13.7）。
/// best-effort：存储解析/写入失败不影响托盘本身。
fn tray_log_with(app: &AppHandle, message: &str) {
    let layout = crate::storage::resolve_storage(app);
    let _ = crate::logging::append_line(std::path::Path::new(&layout.logs_dir), "INFO", message);
}

/// explorer 是否真的接纳了托盘图标。
///
/// **唯一对账手段**：`TrayIcon::rect()` 底层是 `Shell_NotifyIconGetRect` —— 图标
/// 未被 explorer 登记时返回 None。不能信 `TrayIconBuilder::build()` 的成功返回值：
/// tray-icon crate 对 NIM_ADD 失败静默吞掉（2026-10-11 实机根因，设计 §15.6）。
///
/// 调用约束：内部经 `run_item_main_thread!` 派发，**只能在非主线程调用**（守护线程
/// 满足）；主线程调用会自等死锁。派发失败（事件循环收尾中）按「已注册」乐观处理，
/// 避免退出瞬间误判 Blocked 触发无谓重建。
fn tray_registered_bg(app: &AppHandle) -> bool {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return false;
    };
    match tray.rect() {
        Ok(rect) => rect.is_some(),
        Err(_) => true,
    }
}

/// exe 路径同一性比对（注册表 ExecutablePath vs 当前映像）：大小写不敏感。
/// 抽出纯函数供单测锁定（NTFS 大小写不敏感，逐字比对会漏判）。
fn same_exe_path(stored: &str, current: &str) -> bool {
    stored.eq_ignore_ascii_case(current)
}

/// `HKCU\Control Panel\NotifyIconSettings` 钉住结果。
enum PromoteOutcome {
    /// 已是 IsPromoted=1，无需动作
    Already,
    /// 本次写入 1 成功：explorer 在 NIM_ADD 时读取该值，需删除重加图标才生效
    Changed,
    /// 本 exe 的条目尚不存在（首跑、explorer 尚未落条目）：稍后重试
    Missing,
    /// 写注册表被拒（os error 码）：安全软件拦截等，图标留在溢出区，诚实上报
    Denied(u32),
}

/// 把本 exe 的托盘图标钉到任务栏**可见**通知区（Win11 默认收进「^」溢出区）。
///
/// 机制（2026-10-11 实机核实，设计 §15.6）：explorer 为每个托盘图标在
/// `HKCU\Control Panel\NotifyIconSettings\<hash>` 落一条设置（含 ExecutablePath），
/// `IsPromoted=1` = 常驻可见区；该值在 **NIM_ADD 时**被读取 —— 首跑路径为
/// 「先注册 → 写 IsPromoted → 删除重加」（已实测生效，截图为证）。
/// 全程 best-effort：任何失败只降级为「图标在溢出区」，不影响驻留本身。
fn ensure_icon_promoted() -> PromoteOutcome {
    #[cfg(not(windows))]
    {
        PromoteOutcome::Missing
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
            HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_DWORD,
        };

        fn wide(text: &str) -> Vec<u16> {
            text.encode_utf16().chain(std::iter::once(0)).collect()
        }
        fn read_sz(hkey: HKEY, name: &str) -> Option<String> {
            let value = wide(name);
            let mut kind = 0u32;
            let mut buf = vec![0u16; 1024];
            let mut size = (buf.len() * 2) as u32;
            let status = unsafe {
                RegQueryValueExW(
                    hkey,
                    value.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    buf.as_mut_ptr() as *mut u8,
                    &mut size,
                )
            };
            if status != ERROR_SUCCESS {
                return None;
            }
            Some(String::from_utf16_lossy(
                &buf[..(size as usize / 2).saturating_sub(1)],
            ))
        }

        let Ok(me) = std::env::current_exe() else {
            return PromoteOutcome::Missing;
        };
        let me = me.to_string_lossy().to_string();
        let root = wide("Control Panel\\NotifyIconSettings");
        let mut hkey: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, root.as_ptr(), 0, KEY_READ, &mut hkey) != ERROR_SUCCESS
        {
            return PromoteOutcome::Missing; // 键都读不到：无从钉起，按缺条目处理
        }
        let mut outcome = PromoteOutcome::Missing;
        let mut index = 0u32;
        loop {
            let mut name = [0u16; 256];
            let mut name_len = name.len() as u32;
            let status = RegEnumKeyExW(
                hkey,
                index,
                name.as_mut_ptr(),
                &mut name_len,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if status != ERROR_SUCCESS {
                break;
            }
            index += 1;
            let sub = wide(&String::from_utf16_lossy(&name[..name_len as usize]));
            let mut subkey: HKEY = std::ptr::null_mut();
            if RegOpenKeyExW(hkey, sub.as_ptr(), 0, KEY_READ | KEY_SET_VALUE, &mut subkey)
                != ERROR_SUCCESS
            {
                continue;
            }
            let matched = read_sz(subkey, "ExecutablePath")
                .map(|stored| same_exe_path(&stored, &me))
                .unwrap_or(false);
            if matched {
                let value = wide("IsPromoted");
                let mut kind = 0u32;
                let mut data = 0u32;
                let mut size = 4u32;
                let read = RegQueryValueExW(
                    subkey,
                    value.as_ptr(),
                    std::ptr::null(),
                    &mut kind,
                    &mut data as *mut u32 as *mut u8,
                    &mut size,
                );
                if read == ERROR_SUCCESS && data == 1 {
                    outcome = PromoteOutcome::Already;
                } else {
                    let one = 1u32;
                    let code = RegSetValueExW(
                        subkey,
                        value.as_ptr(),
                        0,
                        REG_DWORD,
                        &one as *const u32 as *const u8,
                        4,
                    );
                    outcome = if code == ERROR_SUCCESS {
                        PromoteOutcome::Changed
                    } else {
                        PromoteOutcome::Denied(code)
                    };
                }
                RegCloseKey(subkey);
                break;
            }
            RegCloseKey(subkey);
        }
        RegCloseKey(hkey);
        outcome
    }
}

/// 探测「本进程此刻发 Shell_NotifyIconW 是否被拒」及 OS 错误码。
///
/// 用途：区分「explorer 未就绪（瞬态）」与「被安全软件拦截（os error 5，确定态）」，
/// 给日志与前端告警一个可行动的错误码。做法是注册一个**最小通知图标**（仅
/// NIF_MESSAGE、无图标无菜单）并立即删除 —— 与 tray-icon crate 同一条系统通道，
/// 成功即删除不留痕；失败时 GetLastError 即拒绝签名。
fn probe_notify_deny_code() -> u32 {
    #[cfg(not(windows))]
    {
        0
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM};
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::UI::Shell::{
            NIF_MESSAGE, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW, Shell_NotifyIconW,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, HWND_MESSAGE,
            WNDCLASSW,
        };

        unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        let class = crate::sysinfo::to_wide("HelloTauriTrayProbeClass");
        let hinstance = GetModuleHandleW(std::ptr::null());
        let mut wc: WNDCLASSW = std::mem::zeroed();
        wc.lpfnWndProc = Some(wnd_proc);
        wc.hInstance = hinstance;
        wc.lpszClassName = class.as_ptr();
        RegisterClassW(&wc); // 重复注册报错可忽略，以建窗结果为准
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return GetLastError();
        }
        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = hwnd;
        nid.uID = 0x4854_5001; // "HTP1"：与 crate 计数器/气球 uID 均不冲突
        nid.uFlags = NIF_MESSAGE;
        nid.uCallbackMessage = WM_USER_TRAY_PROBE;
        let ok = Shell_NotifyIconW(NIM_ADD, &nid);
        let code = if ok == 0 { GetLastError() } else { 0 };
        if ok != 0 {
            let mut del: NOTIFYICONDATAW = std::mem::zeroed();
            del.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            del.hWnd = hwnd;
            del.uID = nid.uID;
            Shell_NotifyIconW(NIM_DELETE, &del);
        }
        DestroyWindow(hwnd);
        code
    }
}

/// 探针图标的回调消息号（仅占位，探针窗口不处理任何消息）
#[cfg(windows)]
const WM_USER_TRAY_PROBE: u32 = 6100;

/// 删除并重建托盘图标（主线程执行）。两条用途：注册被拒后的重试；
/// 钉住可见区写值后迫使 explorer 重读 IsPromoted（NIM_ADD 时读取）。
fn rebuild_tray(app: &AppHandle) -> bool {
    let _ = app.remove_tray_by_id(TRAY_ID);
    match build(app) {
        Ok(()) => true,
        Err(error) => {
            tray_log_with(app, &format!("托盘重建失败：{error}"));
            false
        }
    }
}

/// 判 Blocked 时的隐藏态自救：外部关窗请求（安全软件窗管等）可能落在启动宽限期内
/// （STATE 尚为 VERIFYING，关窗闸口按隐藏语义放行）——于是「无托盘 + 窗口隐藏」的
/// 看不见进程现场复现。判 Blocked 时若主窗处于隐藏态则自动恢复：前端告警随之可见，
/// 用户再点 X 按回退语义直接退出（T-O）。健康机器永不进入 Blocked，行为零变化。
fn reveal_if_hidden_on_blocked(app: &AppHandle) {
    let target = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = target.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        // is_visible 失败按「可见」处理：不确定的时候不动窗口，避免误弹
        if window.is_visible().unwrap_or(true) {
            return;
        }
        tray_log_with(&target, "托盘注册被拒且窗口隐藏中：自动恢复窗口以呈现告警（再点 X 将直接退出）");
        show_main(&target);
    });
}

/// 托盘守护线程（setup 内启动）：注册验证 → 钉住可见区 → 稳态巡检重试。
///
/// 存在理由（2026-10-11 实机根因，设计 §15.6）：tray-icon crate 静默吞掉 NIM_ADD
/// 失败，安全软件拦截时应用会「以为有托盘其实没有」——点 X 藏进不存在的托盘，
/// 用户视角与「直接退出」无异。本线程把注册状态变成**可观测、可重试、可上报**：
///  * 启动宽限期内每 2s 对账一次 `rect()`，确认接纳后立即钉住可见区；
///  * 宽限期满仍未接纳 → 探测拒绝码、置 Blocked（关窗闸口据此回退旧退出行为）；
///  * 稳态每 30s 巡检：注册丢失/被拒 → 主线程重建重试（用户加白名单后自愈）；
///    已注册但未钉住 → 补写 IsPromoted 并重加。
pub fn spawn_tray_guardian(app: AppHandle) {
    #[cfg(windows)]
    {
        std::thread::spawn(move || {
            let mut registered = false;
            for _ in 0..VERIFY_TICKS {
                std::thread::sleep(VERIFY_INTERVAL);
                if tray_registered_bg(&app) {
                    registered = true;
                    break;
                }
            }
            if registered {
                TRAY_STATE.store(STATE_REGISTERED, Ordering::Relaxed);
                tray_log_with(&app, "托盘图标注册确认：explorer 已接纳");
                promote_with_retry(&app);
            } else {
                let code = probe_notify_deny_code();
                LAST_DENY_CODE.store(code, Ordering::Relaxed);
                TRAY_STATE.store(STATE_BLOCKED, Ordering::Relaxed);
                tray_log_with(
                    &app,
                    &format!(
                        "托盘图标注册未获 explorer 接纳（os error {code}）：可能被安全软件拦截。 \
                         后台每 30s 重试；期间关闭窗口按旧行为直接退出（不藏进不存在的托盘）。 \
                         处置：将本程序加入安全软件白名单，或将 exe 移出被拦截目录后重启。"
                    ),
                );
                reveal_if_hidden_on_blocked(&app);
            }

            loop {
                std::thread::sleep(GUARD_INTERVAL);
                let now = tray_registered_bg(&app);
                let prev = TRAY_STATE.swap(
                    if now { STATE_REGISTERED } else { STATE_BLOCKED },
                    Ordering::Relaxed,
                );
                if now {
                    if prev != STATE_REGISTERED {
                        let code = probe_notify_deny_code();
                        LAST_DENY_CODE.store(code, Ordering::Relaxed);
                        tray_log_with(&app, "托盘图标注册恢复（重试成功或拦截解除）");
                    }
                    if !TRAY_PROMOTED.load(Ordering::Relaxed) {
                        promote_with_retry(&app);
                    }
                } else {
                    if prev != STATE_BLOCKED {
                        let code = probe_notify_deny_code();
                        LAST_DENY_CODE.store(code, Ordering::Relaxed);
                        tray_log_with(&app, &format!("托盘图标注册丢失（os error {code}），开始后台重试"));
                        reveal_if_hidden_on_blocked(&app);
                    }
                    let target = app.clone();
                    // 重建必须主线程（菜单/窗口操作统一主线程语义）
                    let _ = app.run_on_main_thread(move || {
                        rebuild_tray(&target);
                    });
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// 钉住可见区（含首跑条目未落的短重试）；写值成功则重加图标使 explorer 重读。
fn promote_with_retry(app: &AppHandle) {
    for attempt in 0..6 {
        match ensure_icon_promoted() {
            PromoteOutcome::Already => {
                TRAY_PROMOTED.store(true, Ordering::Relaxed);
                return;
            }
            PromoteOutcome::Changed => {
                TRAY_PROMOTED.store(true, Ordering::Relaxed);
                tray_log_with(app, "托盘图标已钉住任务栏可见通知区（IsPromoted=1），重加图标生效");
                let target = app.clone();
                let _ = app.run_on_main_thread(move || {
                    rebuild_tray(&target);
                });
                return;
            }
            PromoteOutcome::Denied(code) => {
                tray_log_with(
                    app,
                    &format!("钉住可见区写注册表被拒（os error {code}）：图标将留在「^」溢出区，可在任务栏设置中手动固定"),
                );
                return;
            }
            PromoteOutcome::Missing => {
                if attempt + 1 < 6 {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
    }
    tray_log_with(app, "钉住可见区：explorer 尚未落注册表条目，交由稳态巡检补钉");
}

/// `tray_health`：托盘健康度上报（前端告警/设置页展示的唯一真值）。
/// 只读原子量，不做主线程派发（命令线程调用安全）。
#[tauri::command]
pub fn tray_health() -> TrayHealthReport {
    let state = TRAY_STATE.load(Ordering::Relaxed);
    TrayHealthReport {
        state,
        registered: state == STATE_REGISTERED,
        promoted: TRAY_PROMOTED.load(Ordering::Relaxed),
        deny_code: LAST_DENY_CODE.load(Ordering::Relaxed),
    }
}

/// 托盘健康度报告（serde camelCase 与 TS `TrayHealth` 逐字段对应）
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrayHealthReport {
    /// 0=验证中 1=已注册 2=确认被拒
    pub state: u8,
    pub registered: bool,
    pub promoted: bool,
    pub deny_code: u32,
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
    // Blocked = 确认没有托盘可藏：隐藏会复现「看似直接退出」的困惑现场（窗口消失、
    // 无图标、进程 invisibly 存活）。回退旧行为（放行关闭=退出），原因已由前端
    // 启动告警与落盘日志事先说明（设计 §15.6 T-O）。验证中/已注册维持隐藏语义。
    if TRAY_STATE.load(Ordering::Relaxed) == STATE_BLOCKED {
        tray_log_with(window.app_handle(), "托盘不可用（注册被拒）：关闭请求按旧行为直接退出");
        return;
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
            "服务继续在后台运行。图标可能收在任务栏右下角「^」溢出区：左键图标恢复界面，右键图标可退出。",
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
    if let Ok(slot) = PAUSE_ITEM.lock() {
        if let Some(item) = slot.as_ref() {
            let _ = item.set_text(if running { "暂停服务" } else { "恢复服务" });
        }
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

    #[test]
    fn tray_state_bytes_are_distinct_and_default_verifying() {
        // 关窗闸口与前端告警都按这三个字节分支，漂移即语义错乱
        assert_ne!(STATE_VERIFYING, STATE_REGISTERED);
        assert_ne!(STATE_REGISTERED, STATE_BLOCKED);
        assert_ne!(STATE_VERIFYING, STATE_BLOCKED);
        assert_eq!(
            TRAY_STATE.load(Ordering::Relaxed),
            STATE_VERIFYING,
            "启动默认必须是「验证中」：宽限期内关窗仍走隐藏语义"
        );
    }

    #[test]
    fn exe_path_match_is_case_insensitive() {
        // 注册表 ExecutablePath 与 current_exe 的大小写可能不一致（NTFS 不敏感），
        // 逐字比对会让「钉住可见区」永远找不到自己的条目
        assert!(same_exe_path(
            r"E:\GitHub\Hello-Tauri\release\Hello-Tauri.exe",
            r"e:\github\hello-tauri\RELEASE\hello-tauri.EXE"
        ));
        assert!(!same_exe_path(
            r"E:\GitHub\Hello-Tauri\release\Hello-Tauri.exe",
            r"E:\GitHub\Hello-Tauri\release\other.exe"
        ));
    }

    #[test]
    fn instance_mutex_is_session_scoped_and_identified() {
        // Local\ = 会话级命名空间（跨会话不误伤）；含 identifier = 不与其他应用互斥
        assert!(INSTANCE_MUTEX.starts_with("Local\\"), "互斥量应使用 Local\\ 命名空间");
        assert!(
            INSTANCE_MUTEX.contains("com.taowd.hello-tauri"),
            "互斥量名应含应用 identifier"
        );
        // 唤回事件与互斥量同规约（二次实例 SetEvent → 首实例监视线程显窗）
        assert!(WAKE_EVENT.starts_with("Local\\"), "唤回事件应使用 Local\\ 命名空间");
        assert!(WAKE_EVENT.contains("com.taowd.hello-tauri"), "唤回事件名应含应用 identifier");
        assert_ne!(INSTANCE_MUTEX, WAKE_EVENT, "互斥量与唤回事件必须是两个内核对象");
        // 类名漂移会让二次实例唤回静默失效（restore_existing_instance 按此定位主窗）
        assert_eq!(TAURI_WINDOW_CLASS, "Tauri Window");
    }
}
