//! 开机自启：HKCU Run 注册表薄桥接（service-residency T-I，设计 §8.5）。
//!
//! 不引 tauri-plugin-autostart——后者会拉入插件 API 面与启动参数处理，自研即可，
//! 且 windows-sys 的 Registry feature 早已启用（Cargo.toml），零新增依赖。
//!
//! 真值语义（T-I）：开关状态只落注册表 Run 项、**不入 config.json**（避免双真值漂移）；
//! 写入值带 `--minimized`（自启即静默入托盘）。同 windows-infra 永不-reject 精神，
//! 命令层返回 Result，Bridge 层折叠为 ProbeResult。

#[cfg(windows)]
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
#[cfg(windows)]
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
};

/// HKCU 当前用户开机自启 Run 项（无需管理员权限）。
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// 本应用在 Run 项下的值名。
const VALUE_NAME: &str = "Hello-Tauri";

/// UTF-16 零结尾转换（同 shell.rs/sysinfo.rs 私有 helper 的做法）。
fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `autostart_get`：Run 项存在且命令串包含当前 exe 路径才视为开启
/// （用户搬移 exe 后旧路径自然判 false，不残留假开关）。
#[tauri::command]
pub fn autostart_get() -> Result<bool, String> {
    #[cfg(not(windows))]
    {
        Err("当前平台不支持开机自启".into())
    }
    #[cfg(windows)]
    unsafe {
        let key = to_wide(RUN_KEY);
        let value = to_wide(VALUE_NAME);
        // RegQueryValueExW 只在「已打开的键」上查值（第二参是值名，不是子键路径），
        // 须先打开 Run 键；查询类访问不需要写权限。
        let mut hkey: HKEY = std::ptr::null_mut();
        let opened = RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_QUERY_VALUE, &mut hkey);
        if opened == ERROR_FILE_NOT_FOUND {
            return Ok(false); // 键不存在 = 自启未登记（明确的关闭态，不是失败）
        }
        if opened != ERROR_SUCCESS {
            return Err(format!("打开 Run 注册表项失败（os error {opened}）"));
        }
        let mut kind = 0u32;
        let mut buffer = vec![0u16; 1024];
        let mut size_bytes = (buffer.len() * 2) as u32;
        let status = RegQueryValueExW(
            hkey,
            value.as_ptr(),
            std::ptr::null(),
            &mut kind,
            buffer.as_mut_ptr() as *mut u8,
            &mut size_bytes,
        );
        RegCloseKey(hkey);
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(false); // 键在而值不在：同样是关闭态
        }
        if status != ERROR_SUCCESS {
            return Err(format!("注册表读取失败（os error {status}）"));
        }
        let stored = String::from_utf16_lossy(&buffer[..(size_bytes as usize / 2).saturating_sub(1)]);
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        Ok(kind == REG_SZ && stored.contains(exe.to_string_lossy().as_ref()))
    }
}

/// `autostart_set`：写入/删除 Run 项。写入值带 `--minimized`（自启即静默入托盘）。
#[tauri::command]
pub fn autostart_set(enabled: bool) -> Result<bool, String> {
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("当前平台不支持开机自启".into())
    }
    #[cfg(windows)]
    unsafe {
        let key = to_wide(RUN_KEY);
        let value = to_wide(VALUE_NAME);
        let code = if enabled {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let command = to_wide(&format!("\"{}\" --minimized", exe.display()));
            let mut hkey: HKEY = std::ptr::null_mut();
            let opened = RegOpenKeyExW(HKEY_CURRENT_USER, key.as_ptr(), 0, KEY_SET_VALUE, &mut hkey);
            if opened != ERROR_SUCCESS {
                return Err(format!("打开 Run 注册表项失败（os error {opened}）"));
            }
            let code = RegSetValueExW(
                hkey,
                value.as_ptr(),
                0,
                REG_SZ,
                command.as_ptr() as *const u8,
                (command.len() * 2) as u32,
            );
            RegCloseKey(hkey);
            code
        } else {
            // 值不存在按成功处理：语义目标是「自启不存在」
            RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr())
        };
        if code == ERROR_SUCCESS || (!enabled && code == ERROR_FILE_NOT_FOUND) {
            Ok(enabled)
        } else {
            Err(format!("注册表写入失败（os error {code}）"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_key_targets_hkcu_current_version() {
        // HKCU\...\Run 无需管理员权限，且是「登录启动」的标准位置
        assert_eq!(RUN_KEY, r"Software\Microsoft\Windows\CurrentVersion\Run");
        assert_eq!(VALUE_NAME, "Hello-Tauri");
    }

    #[test]
    fn to_wide_is_zero_terminated_utf16() {
        let wide = to_wide("ab");
        assert_eq!(wide, vec![0x61, 0x62, 0x0000]);
        assert!(to_wide("").ends_with(&[0u16]));
    }
}
