#!/usr/bin/env node
/**
 * 自动更新发布脚本（design-auto-update §9.3 / §9.5）—— 独立于 `npm run pack`，
 * 不碰打包主流程与单文件硬闸。
 *
 * 用法（在已完成 `npm run pack` 的打包机上）：
 *   node scripts/publish-update.mjs \
 *     --base-url http://10.0.0.8/update/hello-tauri \
 *     --exe "release/Hello-Tauri-0.2.0-x64-<ts>.exe" \
 *     --notes "1. 新增 XX
 * 2. 修复 YY"
 *
 * 可选参数：
 *   --out <dir>      产物目录（默认 publish/<版本>/）
 *   --key <path>     私钥路径（默认读环境变量 TAURI_SIGNING_PRIVATE_KEY_PATH）
 *   --notes-file <p> 从文件读更新说明（多行；与 --notes 二选一）
 *   --min-version    清单 minVersion（仅驱动「强烈建议更新」提示，不阻断）
 *
 * 产物（上传服务器或整目录拷 U 盘摆渡）：
 *   publish/<版本>/
 *   ├── latest.json           ← 清单（发布真值：版本/sha256/大小来自产物文件本身）
 *   ├── latest.json.minisig   ← armored minisign 文本（客户端 verify_minisign 直接消费）
 *   └── files/<exe>           ← 带版本号的 exe（服务器布局 §9.2）
 *
 * 私钥纪律（同 LLM 密钥先例）：只存打包机本机、经环境变量/参数注入、脚本不落任何
 * 密钥明文、绝不入仓；**先传 exe 后传 latest.json**（顺序反了会出现清单指向 404 的窗口期）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i += 1
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

function fail(message) {
  console.error(`[publish-update] ${message}`)
  process.exit(1)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 产物名 Hello-Tauri-<ver>-x64-<ts>.exe → <ver>（版本唯一真值纪律：与 package.json 交叉校验） */
function versionFromFileName(fileName) {
  const match = /^Hello-Tauri-(\d+\.\d+\.\d+)-x64-.*\.exe$/.exec(fileName)
  return match ? match[1] : null
}

const args = parseArgs(process.argv.slice(2))

// ---------- 1. 定位产物 exe ----------
let exePath = args.exe ? resolve(root, String(args.exe)) : null
if (!exePath) {
  const releaseDir = join(root, 'release')
  const candidates = existsSync(releaseDir)
    ? readdirSync(releaseDir)
        .filter((name) => /^Hello-Tauri-\d+\.\d+\.\d+-x64-.*\.exe$/.test(name))
        .sort()
    : []
  if (!candidates.length) fail('release/ 下没有 Hello-Tauri-<ver>-x64-<ts>.exe 产物；请先 npm run pack')
  exePath = join(releaseDir, candidates.at(-1))
  console.log(`[publish-update] 未指定 --exe，选用最新产物：${candidates.at(-1)}`)
}
if (!existsSync(exePath)) fail(`产物不存在：${exePath}`)

const exeName = exePath.replaceAll('\\', '/').split('/').at(-1)
const version = versionFromFileName(exeName)
if (!version) fail(`产物文件名不符合 Hello-Tauri-<ver>-x64-<ts>.exe 约定：${exeName}`)

const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
if (version !== pkgVersion) {
  fail(`产物版本 (${version}) 与 package.json 版本 (${pkgVersion}) 不一致 —— 打包与发布不是同一批产物，禁止发布`)
}

// ---------- 2. 基础参数 ----------
const baseUrl = String(args['base-url'] ?? '').replace(/\/+$/, '')
if (!/^https?:\/\/.+/.test(baseUrl)) {
  fail('必须提供 --base-url（更新服务器根，如 http://10.0.0.8/update/hello-tauri）')
}

const notes = args['notes-file']
  ? readFileSync(resolve(root, String(args['notes-file'])), 'utf8').trim()
  : String(args.notes ?? '').trim()
if (!notes) fail('必须提供 --notes 或 --notes-file（更新说明会展示在设置页）')

const keyPath = args.key ? String(args.key) : process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
if (!keyPath) fail('必须提供 --key 或环境变量 TAURI_SIGNING_PRIVATE_KEY_PATH（私钥不入仓，只放打包机本机）')
if (!existsSync(keyPath)) fail(`私钥文件不存在：${keyPath}`)

// ---------- 3. 生成清单 ----------
const sha256 = sha256File(exePath)
const sizeBytes = Math.max(1, readFileSync(exePath).length)
const manifest = {
  manifestVersion: 1,
  version,
  notes,
  pubDate: new Date().toISOString(),
  minVersion: args['min-version'] ? String(args['min-version']) : null,
  platforms: {
    'windows-x86_64': {
      url: `${baseUrl}/files/${exeName}`,
      sha256,
      sizeBytes,
    },
  },
}

const outDir = args.out ? resolve(root, String(args.out)) : join(root, 'publish', version)
const filesDir = join(outDir, 'files')
mkdirSync(filesDir, { recursive: true })

const manifestPath = join(outDir, 'latest.json')
// UTF-8、LF、无 BOM（§9.1：验签对象 = 该文件的完整字节，任何规范化都会破坏签名）
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`[publish-update] 清单已生成：${manifestPath}`)
console.log(`[publish-update]   version=${version}  sha256=${sha256.slice(0, 16)}…  size=${sizeBytes}`)

// ---------- 4. 签名（tauri signer → armored minisign） ----------
const sigBase64Path = join(outDir, 'latest.json.sig')
// 进程内调用本仓 @tauri-apps/cli 的原生绑定（spawn npx 在 Node 22+ 对 .cmd 报 EINVAL）
const { run: runTauriCli } = await import('@tauri-apps/cli/main.js')
const signArgs = ['signer', 'sign', '-f', resolve(keyPath), '--app-version', version, manifestPath]
const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
if (password) {
  // 密码经环境变量注入，不进命令行
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password
  await runTauriCli(signArgs)
} else {
  await runTauriCli([...signArgs, '-p', ''])
}
if (!existsSync(sigBase64Path)) fail('签名未产出 latest.json.sig（检查 tauri signer 输出）')

// tauri signer 产物是「base64 包裹的 armored minisign 文本」；客户端验签吃 armored 原文，
// 发布侧统一解码一层（[UPD-ASSUME] U-3 已由 Rust 往返测试锁定该格式）。
const armored = Buffer.from(readFileSync(sigBase64Path, 'utf8').trim(), 'base64').toString('utf8')
if (!armored.startsWith('untrusted comment:')) {
  fail('签名解码结果不是 armored minisign 文本 —— tauri signer 输出格式可能已变化，请人工核对')
}
writeFileSync(join(outDir, 'latest.json.minisig'), armored, 'utf8')

// ---------- 5. 归集产物 ----------
const target = join(filesDir, exeName)
if (resolve(target) !== resolve(exePath)) {
  try {
    renameSync(exePath, target)
  } catch (error) {
    fail(`移动产物失败（${error.message}）；可手动把 ${exeName} 放入 ${filesDir}`)
  }
}

console.log('[publish-update] 完成。发布三件套：')
console.log(`  ${outDir}`)
console.log(`  ├── latest.json`)
console.log(`  ├── latest.json.minisig`)
console.log(`  └── files/${exeName}`)
console.log('[publish-update] 上传服务器时先传 files/ 再传 latest.json（防 404 窗口期）。')
console.log('[publish-update] 私钥备份核查：丢失 = 存量用户只能手动升级（设计 §5.2）。')
