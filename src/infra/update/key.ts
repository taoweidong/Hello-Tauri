/**
 * 更新清单验签公钥（U-M：编译期钉死，公钥非机密可入仓；钉死防服务器侧换钥）。
 *
 * [UPD-ASSUME] 当前是 **2026-10-11 PoC 一次性密钥对的公钥**（实现期 E2E 用，
 * 对应私钥已销毁、不留任何位置）：在它下面所有更新清单都会验签失败（安全的
 * 失败模式）。**首次真实发布前必须**：
 *   1. `npx tauri signer generate -w <打包机本机路径> --password "<可选>"` 生成正式密钥对；
 *   2. 把公钥文件内容 base64 解码后的第二行（key 数据行）替换本常量；
 *   3. 私钥按 LLM 密钥纪律只存打包机本机（TAURI_SIGNING_PRIVATE_KEY_PATH 注入）、
 *      入发布前备份清单，**绝不入仓**（丢失 = 存量用户只能手动换 exe）。
 * 发布流程见 `scripts/publish-update.mjs` 与设计文档 §9.5。
 */
export const UPDATE_PUBLIC_KEY = 'RWTys58y0gReACMFKgEEOW4W8pdoGOY/PybWIE1Nu8nNrbkoGhKtHM/3'
