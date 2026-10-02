//! 系统信息只读探测命令（windows-infra-foundation，design D3）。
//!
//! 边界：只读、无业务规则；OS 版本读注册表 CurrentVersion 键，磁盘逐盘符
//! GetDiskFreeSpaceExW，网卡 GetAdaptersAddresses 仅取首个 IPv4 单播地址。
//! 全部 async + spawn_blocking（与 cli.rs/db.rs 同理由：统一走阻塞线程池，
//! 任何潜在阻塞都不落到 WebView 主线程）。
//!
//! 非 Windows 编译目标下探测函数返回空/未知（本应用仅支持 Windows，
//! 分支只为让 `cargo check` 在任意平台可编译）。

use serde::Serialize;
use tauri::AppHandle;

use crate::storage;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysOverview {
    /// 如 "Windows 11 专业版"（注册表 ProductName）
    pub os_name: String,
    /// 如 "23H2 build 22631"（DisplayVersion/ReleaseId + CurrentBuildNumber）
    pub os_version: String,
    /// 目标架构（x86_64 / aarch64）
    pub arch: String,
    /// 计算机名（COMPUTERNAME）
    pub hostname: String,
    /// 当前用户名（USERNAME）
    pub username: String,
    /// 应用数据根绝对路径
    pub data_root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysDisk {
    /// 盘符（如 "C"）
    pub letter: String,
    pub total_bytes: u64,
    /// 调用者可用空间
    pub free_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SysAdapter {
    /// 适配器友好名（如 "以太网"、"WLAN"）
    pub name: String,
    /// OperStatus == Up
    pub enabled: bool,
    /// 首个 IPv4 单播地址；无则 None
    pub ipv4: Option<String>,
}

/// 宽字符串（UTF-16 + NUL 结尾）。
pub(crate) fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 读 NUL 结尾的 UTF-16 宽字符串（有损解码，不因非法字符丢弃）。
pub(crate) fn wide_to_string(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len))
    }
}

/// 把文本按 UTF-16 填入定长缓冲区，NUL 结尾，超长截断（气球通知标题/正文字段）。
pub(crate) fn fill_wide(text: &str, buf: &mut [u16]) {
    let units: Vec<u16> = text.encode_utf16().collect();
    let take = units.len().min(buf.len().saturating_sub(1));
    buf[..take].copy_from_slice(&units[..take]);
}

#[cfg(windows)]
const CURRENT_VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

/// 读注册表 REG_SZ 值（只读；键缺失/类型不符返回 None）。
#[cfg(windows)]
fn read_reg_sz(subkey: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    let subkey_w = to_wide(subkey);
    let value_w = to_wide(value);
    let mut buf = [0u16; 512];
    let mut size = (buf.len() * std::mem::size_of::<u16>()) as u32;
    let err = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey_w.as_ptr(),
            value_w.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if err != ERROR_SUCCESS {
        return None;
    }
    // size 含结尾 NUL；截到缓冲区长度防异常返回值越界
    let count = ((size as usize) / std::mem::size_of::<u16>()).min(buf.len());
    let end = buf[..count].iter().position(|&c| c == 0).unwrap_or(count);
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// 组装系统概要（阻塞线程内执行）。
fn overview_blocking(data_root: String) -> SysOverview {
    #[cfg(windows)]
    let (os_name, os_version) = {
        let name = read_reg_sz(CURRENT_VERSION_KEY, "ProductName").unwrap_or_else(|| "Windows".into());
        let display = read_reg_sz(CURRENT_VERSION_KEY, "DisplayVersion")
            .or_else(|| read_reg_sz(CURRENT_VERSION_KEY, "ReleaseId"));
        let build = read_reg_sz(CURRENT_VERSION_KEY, "CurrentBuildNumber");
        let mut version = display.unwrap_or_default();
        if let Some(build) = build {
            if !version.is_empty() {
                version.push(' ');
            }
            version.push_str(&format!("build {build}"));
        }
        if version.is_empty() {
            version.push_str("未知");
        }
        (name, version)
    };
    #[cfg(not(windows))]
    let (os_name, os_version) = ("unknown".to_string(), "unknown".to_string());

    let env_or = |key: &str, fallback: &str| {
        std::env::var_os(key)
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback.to_string())
    };

    SysOverview {
        os_name,
        os_version,
        arch: std::env::consts::ARCH.to_string(),
        hostname: env_or("COMPUTERNAME", "未知"),
        username: env_or("USERNAME", "未知"),
        data_root,
    }
}

#[tauri::command]
pub async fn sys_overview(app: AppHandle) -> Result<SysOverview, String> {
    let data_root = storage::resolve_storage(&app).root;
    tauri::async_runtime::spawn_blocking(move || Ok::<SysOverview, String>(overview_blocking(data_root)))
        .await
        .map_err(|error| format!("系统概要线程异常退出：{error}"))?
}

/// 按名读取当前进程环境变量（进程内直读，无子进程开销）。
/// 非严格 UTF-8 的值以有损文本返回而非报错。
#[tauri::command]
pub fn sys_env_var(name: String) -> Option<String> {
    std::env::var_os(&name).map(|value| value.to_string_lossy().to_string())
}

/// 逐盘符探测磁盘分区（GetDiskFreeSpaceExW 成功即计入）。
fn disks_blocking() -> Vec<SysDisk> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let mut disks = Vec::new();
        for code in b'A'..=b'Z' {
            let root = format!("{}:\\", code as char);
            let root_w = to_wide(&root);
            let mut free: u64 = 0;
            let mut total: u64 = 0;
            let ok = unsafe {
                GetDiskFreeSpaceExW(root_w.as_ptr(), &mut free, &mut total, std::ptr::null_mut())
            };
            if ok != 0 {
                disks.push(SysDisk {
                    letter: (code as char).to_string(),
                    total_bytes: total,
                    free_bytes: free,
                });
            }
        }
        disks
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub async fn sys_disks() -> Result<Vec<SysDisk>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok::<Vec<SysDisk>, String>(disks_blocking()))
        .await
        .map_err(|error| format!("磁盘探测线程异常退出：{error}"))?
}

/// GetAdaptersAddresses 枚举网卡（仅取友好名 / Up 状态 / 首个 IPv4 单播地址）。
#[cfg(windows)]
fn adapters_blocking() -> Result<Vec<SysAdapter>, String> {
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_UNSPEC, SOCKADDR_IN};

    // 跳过无关地址族，减小缓冲并加快调用
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut size: u32 = 0;
    // 第一次调用只探缓冲区大小：预期 ERROR_BUFFER_OVERFLOW
    let rc = unsafe {
        GetAdaptersAddresses(AF_UNSPEC as u32, flags, std::ptr::null(), std::ptr::null_mut(), &mut size)
    };
    if rc != ERROR_SUCCESS && rc != ERROR_BUFFER_OVERFLOW {
        return Err(format!("网卡探测失败（错误码 {rc}）"));
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let mut buffer = vec![0u8; size as usize];
    let rc = unsafe {
        GetAdaptersAddresses(
            AF_UNSPEC as u32,
            flags,
            std::ptr::null(),
            buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>(),
            &mut size,
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(format!("网卡探测失败（错误码 {rc}）"));
    }

    let mut adapters = Vec::new();
    let mut current = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    while !current.is_null() {
        let adapter = unsafe { &*current };
        let mut ipv4: Option<String> = None;
        let mut unicast = adapter.FirstUnicastAddress;
        while !unicast.is_null() {
            let address = unsafe { &*unicast }.Address;
            let sockaddr = address.lpSockaddr;
            if !sockaddr.is_null() && unsafe { (*sockaddr).sa_family } == AF_INET {
                let sin = unsafe { &*sockaddr.cast::<SOCKADDR_IN>() };
                let raw = unsafe { sin.sin_addr.S_un.S_addr }; // 网络字节序
                ipv4 = Some(format!(
                    "{}.{}.{}.{}",
                    raw & 0xff,
                    (raw >> 8) & 0xff,
                    (raw >> 16) & 0xff,
                    (raw >> 24) & 0xff
                ));
                break;
            }
            unicast = unsafe { (*unicast).Next };
        }
        adapters.push(SysAdapter {
            name: wide_to_string(adapter.FriendlyName),
            enabled: adapter.OperStatus == IfOperStatusUp,
            ipv4,
        });
        current = adapter.Next;
    }
    Ok(adapters)
}

#[tauri::command]
pub async fn sys_adapters() -> Result<Vec<SysAdapter>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            adapters_blocking()
        }
        #[cfg(not(windows))]
        {
            Ok::<Vec<SysAdapter>, String>(Vec::new())
        }
    })
    .await
    .map_err(|error| format!("网卡探测线程异常退出：{error}"))?
}
