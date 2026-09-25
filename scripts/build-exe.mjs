/**
 * 一键打包脚本 —— 产出独立可运行的单文件 exe 到 build/exe/
 *
 * 用法：npm run build:exe
 *
 * 流程（为什么不用 tauri build）：
 *  1. tauri build 会给 cargo 子进程注入 CARGO_TARGET_<TRIPLE>_RUSTFLAGS 环境变量，
 *     优先级高于 config.toml，导致 src-tauri/.cargo/config.toml 的
 *     +crt-static（静态链接 VC 运行时）失效 → exe 依赖 VCRUNTIME140.dll。
 *  2. 因此绕开 tauri CLI：npm run build 产出前端 → cargo build 直接编译。
 *  3. 生产模式开关是 feature（tauri/custom-protocol），不是 CLI 参数 ——
 *     不带它 = dev 模式 = 前端资源不内嵌，启动白屏。
 *  4. tauri-build 的 build.rs 不 watch 前端产物目录 → 前端变更后 cargo 会复用
 *     陈旧资源，编译前 touch 入口 rs 强制重编。
 *
 * 验证：构建后解析 PE 导入表，确认无 WebView2Loader / VCRUNTIME / UCRT 依赖；
 *      再校验前端资源键已内嵌（v2 资源键为明文）。
 */
import { utimesSync, statSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_TAURI = join(ROOT, 'src-tauri')
const BUILD_EXE = join(ROOT, 'build', 'exe')

/** 步骤横幅 */
function step(msg) {
  console.log(`\x1b[36m▸ ${msg}\x1b[0m`)
}
/** 失败退出 */
function die(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`)
  process.exit(1)
}

// ── 0. 前置检查 ──
step('前置检查（cargo / rustc 工具链）')
const cargo = spawnSync('cargo', ['--version'], { shell: true, encoding: 'utf8' })
if (cargo.status !== 0) die('cargo 不可用，请先安装 Rust 工具链（https://rustup.rs）')
const rustc = spawnSync('rustc', ['-vV'], { shell: true, encoding: 'utf8' })
if (!/host:\s*x86_64-pc-windows-msvc/.test(rustc.stdout)) {
  die(`rustc host 不是 x86_64-pc-windows-msvc（当前：${(rustc.stdout.match(/host:\s*(\S+)/) || [])[1]}）。\n` +
    '  非 MSVC 工具链会动态依赖 WebView2Loader.dll，无法产出单文件 exe。\n' +
    '  修复：rustup default stable-x86_64-pc-windows-msvc')
}
console.log('  cargo / rustc OK (msvc)')

// ── 1. 前端生产构建（tauri 平台适配器）──
step('前端生产构建（VITE_PLATFORM=tauri）')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const webBuild = spawnSync(npmCmd, ['run', 'build'], {
  cwd: ROOT, shell: true, encoding: 'utf8',
  env: { ...process.env, VITE_PLATFORM: 'tauri' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
if (webBuild.status !== 0) die('前端构建失败')
if (!existsSync(join(ROOT, 'build', 'web', 'index.html'))) die('build/web/index.html 不存在 —— 前端构建异常')
console.log('  build/web 产出 OK')

// ── 2. touch 入口 rs，强制 tauri-build 重新生成资源上下文 ──
step('touch src-tauri/src/lib.rs（防陈旧资源内嵌）')
const libRs = join(SRC_TAURI, 'src', 'lib.rs')
const now = new Date()
utimesSync(libRs, now, now)
console.log('  done')

// ── 3. cargo release 构建（绕开 tauri build，保留 crt-static rustflags）──
step('cargo build --release --features tauri/custom-protocol')
const cargoBuild = spawnSync('cargo', [
  'build', '--release', '--features', 'tauri/custom-protocol',
], {
  cwd: SRC_TAURI, shell: true, encoding: 'utf8',
  env: { ...process.env, https_proxy: '', no_proxy: '*' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
if (cargoBuild.status !== 0) die('cargo 构建失败（若为网络问题请确认 ~/.cargo/config.toml 镜像源）')

const builtExe = join(SRC_TAURI, 'target', 'release', 'hello-tauri.exe')
if (!existsSync(builtExe)) die(`未找到编译产物 ${builtExe}`)

// ── 4. 复制产物到 build/exe/ ──
step('复制产物到 build/exe/')
mkdirSync(BUILD_EXE, { recursive: true })
const destExe = join(BUILD_EXE, '日志解析工具.exe')
copyFileSync(builtExe, destExe)
const sizeMB = (statSync(destExe).size / 1024 / 1024).toFixed(1)
console.log(`  ${destExe}  (${sizeMB} MB)`)

// ── 5. PE 导入表验证：单文件无外部可分发依赖 ──
step('PE 导入表验证（无 WebView2Loader / VCRUNTIME / UCRT 依赖）')
const dlls = parseImports(destExe)
const bad = dlls.filter(x => /webview2|vcruntime|msvcp|api-ms-win-crt/i.test(x))
if (bad.length > 0) {
  die(`发现可分发依赖：${bad.join(', ')}\n` +
    '  → crt-static 未生效。确认没有走 tauri build，且 src-tauri/.cargo/config.toml 配置了 +crt-static')
}
console.log(`  依赖 DLL ${dlls.length} 个（全部为系统自带）—— 单文件验证通过`)

// ── 6. 前端资源内嵌验证（v2 资源键为明文）──
step('前端资源内嵌验证')
const exeBin = readFileSync(destExe)
const assetsDir = join(ROOT, 'build', 'web', 'assets')
const names = existsSync(assetsDir) ? readdirSync(assetsDir) : []
const hit = names.filter(n => exeBin.includes(Buffer.from(n)))
if (names.length > 0 && hit.length === names.length) {
  console.log(`  资源内嵌 ${hit.length}/${names.length} —— 全部命中`)
} else if (names.length === 0) {
  console.log('  （无 assets 目录，跳过）')
} else {
  die(`资源内嵌校验失败（${hit.length}/${names.length}）—— 可能编译成了 dev 模式，检查 --features tauri/custom-protocol`)
}

// ── 7. 生成产物清单 ──
step('生成产物清单')
const manifest = [
  `# 打包产物清单`,
  ``,
  `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
  `- 产物：build/exe/日志解析工具.exe（${sizeMB} MB）`,
  `- 版本：${readFileSync(join(SRC_TAURI, 'tauri.conf.json'), 'utf8').match(/"version"\s*:\s*"([^"]+)"/)?.[1] ?? '未知'}`,
  `- 工具链：${(rustc.stdout.match(/rustc (\S+)/) || [])[1]}（x86_64-pc-windows-msvc，crt-static）`,
  `- 依赖 DLL：${dlls.length} 个系统自带（无 WebView2Loader / VCRUNTIME / UCRT）`,
  `- 前端资源：${hit.length}/${names.length} 已内嵌`,
  ``,
  `## 使用说明`,
  ``,
  `exe 为单文件自包含程序，可直接拷贝到任意 Windows 10/11 x64 机器运行，`,
  `无需安装 Rust / Node / WebView2 Loader / VC 运行库。`,
  `（系统需自带 WebView2 Runtime —— Win10 2004+/Win11 默认内置）`,
].join('\n')
writeFileSync(join(BUILD_EXE, 'README.md'), manifest)
console.log('  build/exe/README.md')

console.log(`\n\x1b[32m✓ 打包完成：build/exe/日志解析工具.exe\x1b[0m\n`)

/**
 * 解析 PE 文件导入表，返回依赖 DLL 名列表（纯 Node 实现，不依赖 dumpbin）
 * @param {string} file - exe 路径
 * @returns {string[]}
 */
function parseImports(file) {
  const d = readFileSync(file)
  const pe = d.readUInt32LE(0x3c)
  const nsec = d.readUInt16LE(pe + 6)
  const optsz = d.readUInt16LE(pe + 20)
  const opt = pe + 24
  const magic = d.readUInt16LE(opt)
  const ddoff = opt + (magic === 0x20b ? 112 : 96)
  const irva = d.readUInt32LE(ddoff + 8) // data directory[1] = import

  // 节表：va, vsize, rawptr, rawsz
  const secs = []
  for (let i = 0; i < nsec; i++) {
    const o = pe + 24 + optsz + i * 40
    const vs = d.readUInt32LE(o + 8)
    const va = d.readUInt32LE(o + 12)
    const pr = d.readUInt32LE(o + 20)
    const rs = d.readUInt32LE(o + 16)
    secs.push([va, vs, pr, rs])
  }
  /** RVA → 文件偏移 */
  function r2o(r) {
    for (const [va, vs, pr, rs] of secs) {
      if (r >= va && r < va + Math.max(vs, rs)) return pr + (r - va)
    }
    return null
  }

  const dlls = []
  let off = r2o(irva)
  while (off != null) {
    const nameRva = d.readUInt32LE(off + 12)
    if (nameRva === 0) break
    const no = r2o(nameRva)
    if (no == null) break
    const end = d.indexOf(0, no)
    dlls.push(d.slice(no, end).toString('latin1'))
    off += 20
  }
  return dlls
}
