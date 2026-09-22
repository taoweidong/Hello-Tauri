#!/usr/bin/env node
/**
 * 一键打包：类型检查 -> 前端构建 -> Tauri 编译 -> 拷贝为单文件 exe
 * 用法：npm run pack
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'

function run(command, args, label) {
  process.stdout.write(`\n▶ ${label}\n`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: isWindows })
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

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

run(npmCmd, ['run', 'typecheck'], '类型检查 (vue-tsc)')
run(npmCmd, ['run', 'build:web'], '前端构建 (vite)')
run(npmCmd, ['run', 'tauri', '--', 'build'], '桌面编译 (tauri build)')

const releaseDir = join(root, 'src-tauri', 'target', 'release')
const binary = ['Hello-Tauri.exe', 'hello-tauri.exe']
  .map((name) => join(releaseDir, name))
  .find((path) => existsSync(path))

if (!binary) {
  process.stderr.write(`\n✖ 未找到编译产物，请检查 ${releaseDir}\n`)
  process.exit(1)
}

const outDir = join(root, 'release')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `Hello-Tauri-${version}-x64.exe`)
copyFileSync(binary, outFile)

const sizeMb = (statSync(outFile).size / 1024 / 1024).toFixed(2)
process.stdout.write(
  `\n✔ 打包完成\n  文件：${outFile}\n  大小：${sizeMb} MB\n` +
    '  说明：单文件绿色版，目标机器无需安装 Node.js / Rust / WebView2 之外的依赖。\n',
)
