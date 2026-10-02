# windows-shell-integration Specification

## Purpose

提供与 Windows Shell 的基础交互原语——默认程序打开、剪贴板文本读写、系统通知，
统一「失败明确上报、不静默吞掉、不拖垮调用方」的语义，为后续桌面级功能提供公共底座。

## Requirements

### Requirement: 默认程序打开

系统 SHALL 支持用系统默认程序打开 URL（http/https）、本地文件与本地目录；打开
动作由操作系统 Shell 完成，应用不内置任何协议处理逻辑。

#### Scenario: 打开网址

- **WHEN** 以 https 网址发起打开请求
- **THEN** 系统默认浏览器打开该网址

#### Scenario: 打开目录

- **WHEN** 以本地目录路径发起打开请求
- **THEN** 资源管理器打开该目录

#### Scenario: 打开目标不存在

- **WHEN** 以不存在的本地路径发起打开请求
- **THEN** 返回明确的打开失败错误，可被调用方捕获展示

### Requirement: 剪贴板文本读写

系统 SHALL 支持向系统剪贴板写入纯文本并读取回来；剪贴板当前内容不是文本时，
读取 MUST 返回空结果而不报错。

#### Scenario: 写入并读回

- **WHEN** 写入一段文本后立即读取剪贴板
- **THEN** 读回内容与写入内容一致

#### Scenario: 剪贴板为非文本内容

- **WHEN** 系统剪贴板当前持有图片等非文本内容时发起读取
- **THEN** 返回空结果，不产生错误

### Requirement: 系统通知

系统 SHALL 支持发出带标题与正文的系统通知；通知能力不可用或发送失败时 MUST
返回未送达的结果而不向调用方抛出异常。

#### Scenario: 发出系统通知

- **WHEN** 以标题与正文发起通知请求且系统能力可用
- **THEN** 系统展示该通知，返回已送达结果

#### Scenario: 通知能力不可用

- **WHEN** 系统通知能力不可用（权限关闭、平台不支持）时发起通知请求
- **THEN** 返回未送达结果并附原因，调用方流程不中断

### Requirement: 浏览器模式等价实现

浏览器（web Bridge）模式 SHALL 以浏览器等价 API 实现同一契约（window.open、
clipboard API、Notification API）；浏览器能力缺失或权限被拒时返回与桌面一致的
失败结果结构。

#### Scenario: 浏览器剪贴板权限被拒

- **WHEN** 浏览器模式下剪贴板权限被拒绝时发起写入
- **THEN** 返回明确的失败结果，错误结构与桌面模式一致
