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

/// 剪贴板文本读取上限：8 MB。
///
/// 剪贴板内容**完全由外部进程控制**（用户从浏览器复制一张 base64 图片就能到几十 MB），
/// 不设上限等于让外部数据决定本应用的内存分配。8 MB 相对剪贴板文本绰绰有余，
/// 又远低于「可能拖垮进程」的量级。与 `cli.rs` 的 `MAX_OUTPUT`（2 MB）、
/// `http.rs` 的 `MAX_BODY`（2 MB）是同一纪律的三处入口，本处此前是唯一漏网的。
const MAX_CLIPBOARD_BYTES: usize = 8 * 1024 * 1024;

/// 可执行/脚本扩展名黑名单：`ShellExecuteW` 的 `open` 动词对可执行文件
/// **等于运行**，所以本地路径侧不能只凭 `exists()` 放行。
///
/// 配合 `fs.rs` 的 `fs_write`（可写存储根下任意相对路径）会构成一条
/// 「写入 → 执行」链：写一个 `logs/x.bat` 再打开它即等于执行任意脚本。
/// 存储根内本不该出现这类文件，因此在打开侧拦一道。
const EXECUTABLE_EXTS: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "vbs", "js", "msi", "jar", "lnk", "scr", "pif",
];

/// 用系统默认程序打开 URL / 本地文件 / 本地目录。
///
/// URL 仅放行 http/https；本地路径必须已存在**且不是可执行/脚本** ——
/// 目标由前端给定，这里把「任意字符串交给 Shell」的暴露面收紧到两类明确场景。
#[tauri::command]
pub async fn shell_open(target: String) -> Result<(), String> {
    // 大小写不敏感判定：此前用 `starts_with("http://")`，`HTTP://` 会掉进
    // 本地路径分支（不是可利用漏洞，但判定不严谨、错误信息误导）。
    let lower = target.trim().to_ascii_lowercase();
    let is_url = lower.starts_with("http://") || lower.starts_with("https://");
    if is_url {
        return open_target(&target).await;
    }
    let path = std::path::Path::new(&target);
    if !path.exists() {
        return Err(format!("打开目标不存在：{target}"));
    }
    // 可执行/脚本一律拒绝（`exists()` 不足以放行 —— `open` 动词会运行它）
    let ext = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if EXECUTABLE_EXTS.contains(&ext.as_str()) {
        return Err(format!(
            "拒绝打开可执行/脚本文件（{ext}）：该通道只用于打开文档与链接"
        ));
    }
    open_target(&target).await
}

async fn open_target(target: &str) -> Result<(), String> {
    let target = target.to_string();
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
        // 上限校验必须放在 GlobalLock **之前**：超限时内存还没被锁住，
        // 早拒绝可避免让外部进程（谁往剪贴板写的内容我们不控制）占住全局锁。
        // 与 cli.rs 的 MAX_OUTPUT / http.rs 的 MAX_BODY 同一纪律 ——
        // 三个「外部数据入口」里，唯独这条此前无上限，复制一个 200MB 的 base64
        // 图片就能让本命令分配同等内存。
        if size > MAX_CLIPBOARD_BYTES {
            return Err(format!(
                "剪贴板内容过大（{size} 字节），已拒绝读取（上限 {} 字节）",
                MAX_CLIPBOARD_BYTES
            ));
        }
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
pub(crate) fn notify_blocking(title: &str, body: &str) -> Result<(), String> {
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
pub(crate) fn notify_blocking(_title: &str, _body: &str) -> Result<(), String> {
    Err("当前平台不支持系统通知".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_extensions_are_rejected() {
        // 「fs_write 写入 → shell_open 执行」链的阻断点：
        // ShellExecuteW 的 open 动词对可执行文件等于运行，故一律拒绝。
        for ext in ["exe", "com", "bat", "cmd", "ps1", "vbs", "js", "msi", "jar", "lnk"] {
            assert!(
                EXECUTABLE_EXTS.contains(&ext),
                "扩展名黑名单遗漏：{ext}"
            );
        }
    }

    #[test]
    fn document_extensions_are_not_blocked() {
        // 文档/链接/图片是本通道的正用途，不能误伤
        for ext in ["md", "txt", "json", "log", "png", "jpg", "pdf", "xlsx"] {
            assert!(
                !EXECUTABLE_EXTS.contains(&ext),
                "文档扩展名被误拦：{ext}"
            );
        }
    }

    #[test]
    fn url_detection_is_case_insensitive() {
        // 此前用 starts_with("http://")，`HTTP://` 会掉进本地路径分支
        for target in [
            "http://example.com",
            "HTTP://example.com",
            "Https://example.com",
            "HTTPS://EXAMPLE.COM",
        ] {
            let lower = target.trim().to_ascii_lowercase();
            assert!(
                lower.starts_with("http://") || lower.starts_with("https://"),
                "URL 协议判定大小写敏感：{target}"
            );
        }
    }

    #[test]
    fn clipboard_limit_is_reasonable() {
        // 8 MB：远大于任何合理剪贴板文本，又远低于「能拖垮进程」的量级
        assert!(MAX_CLIPBOARD_BYTES >= 1024 * 1024, "下限过低，正常的富文本会被拒");
        assert!(
            MAX_CLIPBOARD_BYTES <= 64 * 1024 * 1024,
            "上限过高，外部进程仍可用超大剪贴板施压"
        );
    }
}
