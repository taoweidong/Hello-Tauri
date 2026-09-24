#!/usr/bin/env node
/**
 * 一键打包：类型检查 -> 前端构建 -> Tauri 编译 -> 校验单文件 -> 拷贝为 release exe
 * 用法：npm run pack
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'

function run(command, args, label, env) {
  process.stdout.write(`\n▶ ${label}\n`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWindows,
    env: env ? { ...process.env, ...env } : process.env,
  })
  if (result.status !== 0) {
    process.stderr.write(`\n✖ ${label} 失败（退出码 ${result.status ?? 'unknown'}）\n`)
    process.exit(result.status ?? 1)
  }
}

const cargo = spawnSync('cargo', ['--version'], { shell: isWindows, encoding: 'utf8' })
if (cargo.status !== 0) {
  process.stderr.write(
    '\n✖ 未检测到 Rust 工具链。\n' +
      '  请先安装：https://rustup.rs （安装时选择默认的 stable-msvc 工具链）\n' +
      '  安装完成后重新打开终端，再执行 npm run pack\n',
  )
  process.exit(1)
}

// 单文件 exe 的前提是 MSVC：webview2-com-sys 对 target_env=msvc 静态链接
// WebView2LoaderStatic.lib；GNU 工具链会链接 WebView2Loader.dll。
const verbose = spawnSync('rustc', ['-vV'], { shell: isWindows, encoding: 'utf8' })
const host = /^host:\s*(.+)$/m.exec(verbose.stdout ?? '')?.[1]?.trim() ?? ''
if (host && !host.includes('msvc')) {
  process.stderr.write(
    `\n✖ 当前 Rust 目标不是 MSVC（检测到 ${host}），无法保证产出单文件 exe。\n` +
      '  MSVC 工具链会把 WebView2Loader 静态链接进 exe，GNU 工具链则会依赖外部 DLL。\n' +
      '  修复：rustup default stable-x86_64-pc-windows-msvc\n',
  )
  process.exit(1)
}
process.stdout.write(`\n▶ Rust 工具链：${host}（MSVC，WebView2Loader 静态链接）\n`)

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

run(npmCmd, ['run', 'typecheck'], '类型检查 (vue-tsc)')
run(npmCmd, ['run', 'build:web'], '前端构建 (vite)')

// 桌面编译不用 `tauri build`，直接 `cargo build --features tauri/custom-protocol`。原因：
//   1. tauri build 的 Rust 子进程会自行注入 CARGO_TARGET_<TRIPLE>_RUSTFLAGS（实测把
//      .cargo/config.toml 的 +crt-static 顶掉，产物退回动态 CRT），且该覆盖无法从
//      npm 子进程环境变量穿透。
//   2. tauri v2 的 dev/生产语义由 tauri crate 的 custom-protocol feature 决定
//      （build.rs: `let dev = !custom_protocol`）；不传 feature 的裸 cargo build 是
//      dev 模式，资源不内嵌。这里显式传 feature 进入生产模式。
//   3. 裸 cargo 没有 beforeBuildCommand，前端构建由上面的 build:web 显式负责，不重复。
//
// 强制桌面 crate 重新编译：generate_context! 只在 crate 重编译时重新读取并内嵌 dist/，
// 而 tauri-build 的 build.rs 只 watch tauri.conf.json 与 capabilities，不含 dist/
// （tauri-codegen 也未通过 proc_macro::track_path 跟踪前端资源）。pack 每次都重建前端，
// 若不强制重编，前端单独变更时 cargo 会判定 crate 未过期、内嵌过期资源。
// 触碰 lib.rs 的 mtime 即可让 cargo 重跑 build script 与宏、重新内嵌最新 dist。
const libRs = join(root, 'src-tauri', 'src', 'lib.rs')
{
  const now = new Date()
  utimesSync(libRs, now, now)
}

run('cargo', ['build', '--release', '--features', 'tauri/custom-protocol', '--offline', '--manifest-path', join('src-tauri', 'Cargo.toml')], '桌面编译 (cargo build · 生产模式)')

const releaseDir = join(root, 'target', 'release')
const binary = ['Hello-Tauri.exe', 'hello-tauri.exe']
  .map((name) => join(releaseDir, name))
  .find((path) => existsSync(path))

if (!binary) {
  process.stderr.write(`\n✖ 未找到编译产物，请检查 ${releaseDir}\n`)
  process.exit(1)
}

/**
 * 解析 PE 导入表，列出 exe 依赖的外部 DLL。
 * 这是「单文件」的唯一硬证据 —— 构建配置写得再对，也要以产物为准。
 */
function importedDlls(file) {
  const buf = readFileSync(file)
  const pe = buf.readUInt32LE(0x3c)
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\u0000\u0000') {
    throw new Error('不是有效的 PE 文件')
  }
  const sectionCount = buf.readUInt16LE(pe + 6)
  const optSize = buf.readUInt16LE(pe + 20)
  const opt = pe + 24
  const magic = buf.readUInt16LE(opt)
  const dataDir = opt + (magic === 0x20b ? 112 : 96)
  const importRva = buf.readUInt32LE(dataDir + 8)

  const sections = []
  for (let i = 0; i < sectionCount; i += 1) {
    const off = pe + 24 + optSize + i * 40
    const size = buf.readUInt32LE(off + 8)
    const va = buf.readUInt32LE(off + 12)
    const rawSize = buf.readUInt32LE(off + 16)
    const rawPtr = buf.readUInt32LE(off + 20)
    sections.push({ va, size, rawSize, rawPtr })
  }
  const rvaToOffset = (rva) => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.size, s.rawSize)) {
        return s.rawPtr + (rva - s.va)
      }
    }
    return null
  }

  let off = rvaToOffset(importRva)
  const names = []
  while (off !== null) {
    const entry = buf.subarray(off, off + 20)
    if (entry.length < 20 || entry.every((byte) => byte === 0)) break
    const nameRva = buf.readUInt32LE(off + 12)
    if (nameRva === 0) break
    const nameOff = rvaToOffset(nameRva)
    if (nameOff === null) break
    const end = buf.indexOf(0, nameOff)
    names.push(buf.toString('latin1', nameOff, end))
    off += 20
  }
  return names
}

/** 目标机未随附安装时会导致启动失败的可分发 DLL 特征 */
const FORBIDDEN = [/^webview2loader\.dll$/i, /^vcruntime/i, /^msvcp/i, /^api-ms-win-crt-/i]

function assertSingleFile(file) {
  const dlls = importedDlls(file)
  const offenders = dlls.filter((dll) => FORBIDDEN.some((pattern) => pattern.test(dll)))
  if (offenders.length) {
    process.stderr.write(
      `\n✖ 产物不是自包含单文件，存在需随附的可分发 DLL 依赖：\n` +
        offenders.map((dll) => `    - ${dll}\n`).join('') +
        '  说明：这些 DLL 目标机器未必有（WebView2Loader 需随附、VCRUNTIME 需装 VC++ 运行库）。\n' +
        '  排查：确认工具链为 MSVC，且 C 运行时已静态链接（-C target-feature=+crt-static）。\n',
    )
    process.exit(1)
  }
  return dlls.length
}

const dllCount = assertSingleFile(binary)

const outDir = join(root, 'release')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `Hello-Tauri-${version}-x64.exe`)
copyFileSync(binary, outFile)

const sizeMb = (statSync(outFile).size / 1024 / 1024).toFixed(2)
process.stdout.write(
  `\n✔ 打包完成\n  文件：${outFile}\n  大小：${sizeMb} MB\n` +
    `  单文件校验：通过（外部依赖 ${dllCount} 个，均为 Windows 系统自带 DLL）\n` +
    '  说明：目标机器无需安装 Node.js / Rust / VC++ 运行库。\n' +
    '        唯一前提是系统自带 WebView2 运行时（Win10 1803+ 与 Win11 已内置）。\n',
)