# 冒烟记录 — windows-infra-foundation（tasks 8.2）

- 时间：2026/10/2 13:37:20
- 方式：tauri:dev + WebView2 CDP（headless），页面上下文直接 invoke Tauri 命令
- 结果：17/17 通过

| 检查项                             | 结果 | 详情                                                                                                                                  |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| sys_overview 系统概要              | ✔    | Windows 10 Pro / 26H2 build 26300 / TAOWEIDONG-PC / Taowd                                                                             |
| sys_env_var 环境变量               | ✔    | PATH 长度 2239；缺失变量 → null                                                                                                       |
| sys_disks 磁盘枚举                 | ✔    | C: 200GB、D: 378GB、E: 374GB                                                                                                          |
| sys_adapters 网卡枚举              | ✔    | 6 个适配器，启用 3 个，示例 vEthernet (Default Switch) = 172.29.96.1                                                                  |
| cli_run system-info                | ✔    | exit=0 编码=gbk 输出前 80 字： ⏎ 主机名: TAOWEIDONG-PC ⏎ OS 名称: Microsoft Windows 11 专业版 ⏎ OS                                    |
| cli_run ipconfig-all               | ✔    | exit=0 编码=gbk 输出前 80 字： ⏎ Windows IP 配置 ⏎ ⏎ 主机名 . . . . . . . . . . . . . : Taoweidong-PC ⏎ 主 DNS 后                     |
| cli_run task-list                  | ✔    | exit=0 编码=gbk 输出前 80 字： ⏎ 映像名称 PID 会话名 会话# 内存使用 ⏎ =============                                                   |
| cli_run where-exe                  | ✔    | exit=0 编码=utf-8 输出前 80 字：C:\Windows\System32\PING.EXE ⏎                                                                        |
| cli_run whoami                     | ✔    | exit=0 编码=utf-8 输出前 80 字：taoweidong-pc\taowd ⏎                                                                                 |
| cli_run hostname                   | ✔    | exit=0 编码=utf-8 输出前 80 字：Taoweidong-PC ⏎                                                                                       |
| cli_run nslookup                   | ✔    | exit=0 编码=gbk 输出前 80 字：服务器: cmcc.wifi ⏎ Address: fe80::1 ⏎ ⏎ 名称: localhost ⏎ Addresses: ::1 ⏎ 127.                        |
| cli_run ping-host                  | ✔    | exit=0 编码=gbk 输出前 80 字： ⏎ 正在 Ping 127.0.0.1 具有 32 字节的数据: ⏎ 来自 127.0.0.1 的回复: 字节=32 时间<1ms TTL=128 ⏎ 来自 127 |
| GBK 可读性（ipconfig 中文输出）    | ✔    | 编码=gbk，中文片段：配置                                                                                                              |
| clipboard 写读往返（含恢复原内容） | ✔    | 往返一致；原剪贴板已恢复                                                                                                              |
| notify_send 系统通知               | ✔    | 已发送（桌面右下角应出现 toast/气球提示）                                                                                             |
| shell_open URL                     | ✔    | 默认浏览器应已打开 example.com                                                                                                        |
| shell_open 数据根目录              | ✔    | 资源管理器应已打开 E:\GitHub\Hello-Tauri\target\uitest-sandbox-1790613352785                                                          |
