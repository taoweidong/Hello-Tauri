//! Shell 交互命令（windows-infra-foundation，design D4）：
//! 默认程序打开 / 剪贴板文本读写 / 系统通知。
//!
//! 通知实现为「托盘气球提示」（Shell_NotifyIconW + NIF_INFO）：Win10+ 自动把
//! 气球提示转为 toast 通知，且不要求 AUMID/开始菜单快捷方式，对免安装单文件
//! exe 比通知中心 WinRT API 更可靠。剪贴板/通知同理不引第三方 crate
//! （arboard/notify-rust 不在内网 crate 缓存清单，会破坏打包不联网约束）。
//!
//! [WIN-ASSUME] 剪贴板属主为空（OpenClipboard(null)）：写入的数据在应用退出后
//! 可能被系统回收；文本量小、生命周期内读回是主要场景，必要时后续引入隐藏
//! 属主窗口方案。

use crate::sysinfo::{fill_wide, to_wide};

/// ShellExecuteW 返回值 > 32 为成功，SE_ERR_* 错误码均为 ≤32 的正数。
const SHELL_EXECUTE_SUCCESS_MIN: isize = 33;

/// 用系统默认程序打开 URL / 本地文件 / 本地目录。
///
/// URL 仅放行 http/https；本地路径必须已存在 —— 目标由前端给定，
/// 这里把「任意字符串交给 Shell」的暴露面收紧到两类明确场景。
#[tauri::command]
pub async fn shell_open(target: String) -> Result<(), String> {
    let is_url = target.starts_with("http://") || target.starts_with("https://");
    if !is_url && !std::path::Path::new(&target).exists() {
        return Err(format!("打开目标不存在：{target}"));
    }
    tauri::async_runtime::spawn_blocking(move || open_with_shell(&target))
        .await
        .map_err(|error| format!("打开线程异常退出：{error}"))?
}

#[cfg(windows)]
fn open_with_shell(target: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // ShellExecuteW 内部可能使用 COM：在当前线程初始化；已初始化为其他
    // 模型时（RPC_E_CHANGED_MODE）直接复用现有初始化，不反初始化。
    let com = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
    let owns_com = com >= 0;

    let file_w = to_wide(target);
    let verb_w = to_wide("open");
    let hinst = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb_w.as_ptr(),
            file_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if owns_com {
        unsafe { CoUninitialize() };
    }
    if (hinst as isize) >= SHELL_EXECUTE_SUCCESS_MIN {
        Ok(())
    } else {
        Err(format!("Shell 打开失败（错误码 {}）：{target}", hinst as isize))
    }
}

#[cfg(not(windows))]
fn open_with_shell(_target: &str) -> Result<(), String> {
    Err("当前平台不支持 Shell 打开".into())
}

/// 打开剪贴板（争用资源，短重试后放弃）。
#[cfg(windows)]
fn open_clipboard_with_retry() -> Result<(), String> {
    use windows_sys::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..10 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    Err("无法打开剪贴板（被其他程序长时间占用）".into())
}

/// 读剪贴板纯文本；剪贴板无文本内容时返回 None（不是错误）。
#[tauri::command]
pub async fn clipboard_read() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(clipboard_read_blocking)
        .await
        .map_err(|error| format!("剪贴板读取线程异常退出：{error}"))?
}

#[cfg(windows)]
fn clipboard_read_blocking() -> Result<Option<String>, String> {
    use windows_sys::Win32::Foundation::HGLOBAL;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    open_clipboard_with_retry()?;
    let outcome = (|| -> Result<Option<String>, String> {
        let format = CF_UNICODETEXT as u32;
        if unsafe { IsClipboardFormatAvailable(format) } == 0 {
            return Ok(None);
        }
        let handle = unsafe { GetClipboardData(format) };
        if handle.is_null() {
            return Ok(None);
        }
        let hmem = handle as HGLOBAL;
        let size = unsafe { GlobalSize(hmem) };
        let ptr = unsafe { GlobalLock(hmem) };
        if ptr.is_null() {
            return Err("锁定剪贴板内存失败".into());
        }
        // GlobalSize 按字节返回，可能为奇数（分配粒度），按 u16 对齐读取
        let count = size / std::mem::size_of::<u16>();
        let units = unsafe { std::slice::from_raw_parts(ptr.cast::<u16>(), count) };
        let len = units.iter().take_while(|&&unit| unit != 0).count();
        let text = String::from_utf16_lossy(&units[..len]);
        unsafe { GlobalUnlock(hmem) };
        Ok(Some(text))
    })();
    unsafe { CloseClipboard() };
    outcome
}

#[cfg(not(windows))]
fn clipboard_read_blocking() -> Result<Option<String>, String> {
    Err("当前平台不支持剪贴板读取".into())
}

/// 向剪贴板写入纯文本（覆盖现有内容）。
#[tauri::command]
pub async fn clipboard_write(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clipboard_write_blocking(&text))
        .await
        .map_err(|error| format!("剪贴板写入线程异常退出：{error}"))?
}

#[cfg(windows)]
fn clipboard_write_blocking(text: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, SetClipboardData};    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    open_clipboard_with_retry()?;
    let outcome = (|| -> Result<(), String> {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.push(0);
        let bytes = units.len() * std::mem::size_of::<u16>();
        unsafe {
            if EmptyClipboard() == 0 {
                return Err("清空剪贴板失败".into());
            }
            let hmem = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if hmem.is_null() {
                return Err("分配剪贴板内存失败".into());
            }
            let dst = GlobalLock(hmem);
            if dst.is_null() {
                GlobalFree(hmem);
                return Err("锁定剪贴板内存失败".into());
            }
            std::ptr::copy_nonoverlapping(units.as_ptr().cast::<u8>(), dst.cast::<u8>(), bytes);
            GlobalUnlock(hmem);
            // 成功后内存归系统所有，不再 GlobalFree
            if SetClipboardData(CF_UNICODETEXT as u32, hmem as HANDLE).is_null() {
                GlobalFree(hmem);
                return Err("写入剪贴板失败".into());
            }
        }
        Ok(())
    })();
    unsafe { CloseClipboard() };
    outcome
}

#[cfg(not(windows))]
fn clipboard_write_blocking(_text: &str) -> Result<(), String> {
    Err("当前平台不支持剪贴板写入".into())
}

/// 发出系统通知（托盘气球提示，Win10+ 显示为 toast）。
///
/// 图标展示期约 10s，由分离线程延迟清理（NIM_DELETE + 销毁窗口），命令本身
/// 立即返回；窗口类注册失败按「已注册」容忍，以 CreateWindowExW 结果为准。
#[tauri::command]
pub async fn notify_send(title: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || notify_blocking(&title, &body))
        .await
        .map_err(|error| format!("通知线程异常退出：{error}"))?
}

#[cfg(windows)]
fn notify_blocking(title: &str, body: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::{
        NIF_INFO, NIM_ADD, NIM_DELETE, NIIF_INFO, NOTIFYICONDATAW, Shell_NotifyIconW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, HWND_MESSAGE, RegisterClassW, WNDCLASSW,
    };

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    let class_name = to_wide("HelloTauriNotifyWindowClass");
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let mut class: WNDCLASSW = std::mem::zeroed();
        class.lpfnWndProc = Some(wnd_proc);
        class.hInstance = hinstance;
        class.lpszClassName = class_name.as_ptr();
        // 重复注册报错可忽略（类已存在），以 CreateWindowExW 的结果为准
        RegisterClassW(&class);

        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
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
            return Err("创建通知窗口失败".into());
        }

        let mut title_buf = [0u16; 64];
        fill_wide(title, &mut title_buf);
        let mut body_buf = [0u16; 256];
        fill_wide(body, &mut body_buf);

        let mut data: NOTIFYICONDATAW = std::mem::zeroed();
        data.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        data.hWnd = hwnd;
        data.uID = 1;
        data.uFlags = NIF_INFO;
        data.szInfo = body_buf;
        data.szInfoTitle = title_buf;
        data.dwInfoFlags = NIIF_INFO;

        if Shell_NotifyIconW(NIM_ADD, &data) == 0 {
            DestroyWindow(hwnd);
            return Err("系统通知发送失败（Shell_NotifyIconW 返回 0）".into());
        }

        // 气球提示展示期间保持托盘图标，展示期后由分离线程清理并销毁窗口。
        // HWND 裸指针不实现 Send，以 usize 中转（同指针值，跨线程传回后再转回）。
        let hwnd_addr = hwnd as usize;
        std::thread::spawn(move || {
            let hwnd = hwnd_addr as HWND;
            std::thread::sleep(std::time::Duration::from_secs(10));
            let mut remove: NOTIFYICONDATAW = std::mem::zeroed();
            remove.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            remove.hWnd = hwnd;
            remove.uID = 1;
            // 词法上位于外层 unsafe 块内，无需再包 unsafe
            Shell_NotifyIconW(NIM_DELETE, &remove);
            DestroyWindow(hwnd);
        });
    }
    Ok(())
}

#[cfg(not(windows))]
fn notify_blocking(_title: &str, _body: &str) -> Result<(), String> {
    Err("当前平台不支持系统通知".into())
}
