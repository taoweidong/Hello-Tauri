# 项目长期记忆（Hello-Tauri）

## 架构约束（用户明确，2026-07-18）
- **业务代码尽量使用 TypeScript；非必要时不引入 Rust。**
- **Rust 仅负责客户端打包（编译产物）与功能透传**：只暴露底层原子能力（读写字节、解压字节流等"薄原语"），**不实现业务逻辑**。
- 由此：**文件名净化、路径穿越防护、压缩炸弹大小上限、格式识别、`.tgz` 的 tar 解包等业务规则一律放在 TS 层**；Rust 命令最多保留结构性安全边界（如 `write_file` 必须落在 `app_data_dir` 沙箱内），不做业务判定。
- 影响范围：安全问题修复（gzip 穿越/炸弹防护改为 TS 侧 `src/core/archive-security.ts` + Rust `decompress` 改为返回 `{name,bytes}[]` 透传）、`.tgz` 解包用 JS tar 库、上传白名单按插件注册表动态生成。

## 项目性质
- Tauri 2 + Vue 3 + TypeScript 跨平台日志/压缩包解析预览工具；Web 与桌面双端（VITE_PLATFORM 切换）。
- 插件系统（压缩/解析）、适配器模式（Web/Tauri）、composable 模块级单例状态。
