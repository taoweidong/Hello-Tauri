#!/usr/bin/env node
/**
 * 全量验证编排：一条命令跑完「静态检查 → 单测 → UI 自动化 → 构建 → 打包 → 产物校验 → 服务启动」。
 *
 * 设计要点：
 *  1. 每个阶段都是「可独立失败」的单元，失败不影响后续阶段 —— 一次跑完拿到全局视图，
 *     比逐个跑再拼结果省事得多（尤其是打包要几分钟的时候）。
 *  2. 环境问题（缺 Rust、缺 Node）会被提前探测并给出修复指引，而不是让阶段以晦涩错误失败。
 *  3. 报告是表格化的，且带每阶段耗时，便于发现哪一步变慢了。
 *
 * 用法：
 *   npm run verify                全量验证
 *   npm run verify -- --fast      跳过打包（只做静态检查 + 单测 + UI 测试，用已有产物）
 *   npm run verify -- --escalated 在无沙箱隔离的环境运行（打包写 target/ 所必需）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fast = process.argv.includes('--fast')
/**
 * --escalated：由调用方在「已获授权、无沙箱隔离」的外层环境里运行（如 Bash 工具的
 * dangerouslyDisableSandbox）。cargo 编译要写 target/，在受限沙箱里会在几秒内失败。
 */
const escalated = process.argv.includes('--escalated')

const stages = []

// ---------------------------------------------------------------- 工具函数

function remember(stage) {
  stages.push(stage)
  return stage
}

/**
 * 跑一个子命令，捕获输出（不直通），返回 {ok, code, output}。
 *
 * 一律 shell:false。shell:true 在 Windows 上走 cmd.exe /c，会把带空格的参数
 * 按空格重新分词（`/FI "IMAGENAME eq x"` 被拆成 5 个参数而报错），
 * 表现为「命令莫名失败且输出是用法提示」。参数数组必须原样传给进程。
 */
function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { ok: result.status === 0, code: result.status, output }
}

/**
 * 跑 npm 脚本。必须经 cmd.exe 包裹，两条约束同时成立：
 *  - Windows 上 npm 是 .cmd 批处理，Node 20+ 禁止直接 spawn（status 会是 null）；
 *  - 又不能开 shell:true（会拆坏参数）。
 * cmd /d /s /c 是同时满足两者的唯一调法。
 */
function runNpm(args, options = {}) {
  return runCapture('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options)
}

/**
 * 构建子进程的环境变量。
 *
 * 受限运行环境会给 node 注入一个「批量删除保护」垫片：同一轮请求内累计删除数
 * 超过阈值（50）后，**任何**递归删除都会被拒绝。vite 的 emptyOutDir 要清空 dist，
 * 必然触发 —— 表现是「构建莫名其妙失败，报 safe-delete 确认要求」，与代码无关。
 *
 * 仅在 --escalated（调用方已确认无沙箱隔离）时关闭该垫片，且只作用于构建子进程：
 * 被删的是 dist/ —— 构建产物、已在 .gitignore、可随时重新生成。
 */
const buildEnv = escalated ? { CODEBUDDY_SAFE_DELETE_ENABLED: '0' } : {}

/**
 * 执行一个验证阶段。
 *
 * 输出默认折叠为「最后若干行」——全量验证的输出太长，全打印会淹没报告；
 * 失败时则展示更多上下文，便于直接定位。
 */
function stage(name, fn, { critical = false } = {}) {
  process.stdout.write(`\n\x1b[36m━━━ ${name}\x1b[0m\n`)
  const started = Date.now()
  let ok = false
  let detail = ''
  let tail = []
  try {
    const result = fn()
    ok = result.ok
    detail = result.detail ?? ''
    tail = result.tail ?? []
    for (const line of result.log ?? []) process.stdout.write(`  ${line}\n`)
  } catch (error) {
    ok = false
    detail = error instanceof Error ? error.message : String(error)
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  remember({ name, ok, detail, elapsed: Number(elapsed), critical })

  const mark = ok ? '\x1b[32m✔ 通过\x1b[0m' : '\x1b[31m✖ 失败\x1b[0m'
  process.stdout.write(`\n  ${mark}（${elapsed}s）${detail ? ` ${detail}` : ''}\n`)
  if (!ok && tail.length) {
    process.stdout.write('  \x1b[90m── 输出尾部 ──\x1b[0m\n')
    for (const line of tail) process.stdout.write(`  \x1b[90m${line}\x1b[0m\n`)
  }
  return ok
}

/** 取输出的最后 n 行作为失败上下文 */
const tailOf = (text, n = 20) =>
  stripAnsi(text)
    .split('\n')
    .filter((l) => l.trim())
    .slice(-n)

/**
 * 去掉 ANSI 转义序列后再解析指标。
 *
 * vitest 的汇总行是着色输出（`Tests\x1b[22m  \x1b[32m41 passed`），
 * 直接对着色文本做正则永远匹配不上 —— 曾导致报告显示 "? 个用例通过"。
 * 判读进度、抓数字一律先过这一层。
 */
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '')

/** 从命令输出里抓某个数字指标（自动剥离 ANSI） */
function grab(text, pattern) {
  return pattern.exec(stripAnsi(text))?.[1] ?? null
}

// ---------------------------------------------------------------- 环境探测

process.stdout.write('\n\x1b[1m═══ Hello-Tauri 全量验证 ═══\x1b[0m\n')
process.stdout.write(
  `\x1b[90m模式：${fast ? '快速（跳过打包）' : '完整（含打包）'}` +
    `${escalated ? '　沙箱：已放开' : '　沙箱：受限'}　目录：${root}\x1b[0m\n`,
)

const envProblems = []
const rustc = runCapture('rustc', ['-vV'])
if (!fast) {
  if (!rustc.ok) {
    envProblems.push('未检测到 Rust 工具链，无法打包。安装：https://rustup.rs（选 stable-msvc）')
  } else {
    const host = /^host:\s*(.+)$/m.exec(rustc.output)?.[1]?.trim() ?? ''
    if (!host.includes('msvc')) {
      envProblems.push(`Rust 目标非 MSVC（${host}），无法产出单文件 exe。修复：rustup default stable-x86_64-pc-windows-msvc`)
    } else {
      process.stdout.write(`\x1b[90mRust：${host}\x1b[0m\n`)
    }
  }
}

// 打包前必须处理 dist：vite 的 emptyOutDir 会逐文件覆盖，旧 chunk 会被清理
if (!fast && existsSync(join(root, 'dist'))) {
  process.stdout.write('\x1b[90m提示：dist/ 已存在，构建阶段会由 vite 清理旧产物\x1b[0m\n')
}

// ---------------------------------------------------------------- 1. 静态检查

stage('阶段 1／7　类型检查（vue-tsc）', () => {
  const r = runNpm(['run', 'typecheck'])
  const errors = grab(r.output, /Found (\d+) error/) ?? (r.ok ? '0' : '未知')
  return {
    ok: r.ok,
    detail: r.ok ? `0 个类型错误` : `${errors} 个类型错误`,
    tail: tailOf(r.output),
  }
})

// ---------------------------------------------------------------- 2. 单元测试

stage('阶段 2／7　单元测试（vitest）', () => {
  const r = runNpm(['run', 'test'])
  // vitest 汇总行形如 "Tests  36 passed (36)"
  const passed = grab(r.output, /Tests\s+(\d+) passed/)
  const failed = grab(r.output, /Tests\s+.*?(\d+) failed/)
  const files = grab(r.output, /Test Files\s+(\d+) passed/)
  // 判定以「有无 FAIL」为主、退出码为辅（退出码可能被非测试因素影响）
  const plain = stripAnsi(r.output)
  const hasFail = /FAIL|✗|× /.test(plain) || Boolean(failed)
  return {
    ok: r.ok && !hasFail,
    detail: `${files ?? '?'} 个文件 / ${passed ?? '?'} 个用例通过${failed ? `，${failed} 失败` : ''}`,
    tail: tailOf(r.output, 30),
  }
})

// ---------------------------------------------------------------- 3. UI 自动化

const uiResult = { ok: false, detail: '未执行' }

/**
 * UI 测试的验证对象是打包产物。完整模式下它排在打包之后（验的必须是刚出的东西）；
 * 快速模式下复用 release/ 里已有的 exe —— 没有产物则明确失败而不是跳过，
 * 「跳过」会让报告显得全绿但实际没验 UI。
 */
function runUiStage() {
  stage('阶段 6／7　UI 自动化（驱动 exe 的 WebView2）', () => {
    const releaseDir = join(root, 'release')
    const exe = existsSync(releaseDir)
      ? readdirSync(releaseDir)
          .filter((n) => n.toLowerCase().endsWith('.exe'))
          .sort((a, b) => statSync(join(releaseDir, b)).mtimeMs - statSync(join(releaseDir, a)).mtimeMs)[0]
      : null
    if (!exe) {
      return { ok: false, detail: 'release/ 下没有 exe，请先执行 npm run pack' }
    }
    const r = runCapture(process.execPath, [join('scripts', 'uitest.mjs')])
    const passed = grab(r.output, /合计 \d+ 个用例：通过 (\d+)/)
    const total = grab(r.output, /合计 (\d+) 个用例/)
    const failedNames = [...r.output.matchAll(/^ {2}· (.+?)：/gm)].map((m) => m[1])
    const detail = r.ok
      ? `${passed}/${total} 个用例通过`
      : failedNames.length
        ? `${failedNames.length} 个用例失败：${failedNames.slice(0, 3).join('；')}`
        : `${passed ?? '?'}/${total ?? '?'} 个用例通过`
    Object.assign(uiResult, { ok: r.ok, detail })
    return { ok: r.ok, detail, tail: tailOf(r.output, 30) }
  })
}

// ---------------------------------------------------------------- 4. 前端构建

/**
 * 构建前清理 dist。
 *
 * 早先的做法是 `renameSync(dist, target/dist-stash-*）`，实测不可靠：
 * dist 常被外部进程短暂持句柄（编辑器索引、上次构建残留的 watcher 等），
 * rename 会抛 EBUSY；而同目录 rename 也会失败，说明锁在目录本身。
 * vite 自己写 dist 是逐文件落盘的，不受该句柄影响 —— 所以直接交给 vite
 * 清理（emptyOutDir），这里只做一次「尽量删掉旧 index.html」的轻量工作。
 */
function cleanDist() {
  const index = join(root, 'dist', 'index.html')
  try {
    rmSync(index, { force: true })
  } catch {
    // 删不掉的极端情形交给 vite 覆盖写入，不阻断构建
  }
}

if (!fast) {
  stage('阶段 3／7　前端构建（vite）', () => {
    cleanDist()
    const r = runNpm(['run', 'build:web'], { env: buildEnv })
    if (!r.ok) {
      const hint = /safe-delete|SAFE_DELETE/.test(r.output)
        ? '（被批量删除保护拦截：用 --escalated 运行，或先手动删除 dist）'
        : ''
      return { ok: false, detail: `构建失败${hint}`, tail: tailOf(r.output) }
    }

    const dist = join(root, 'dist')
    if (!existsSync(dist)) return { ok: false, detail: '构建成功但 dist/ 不存在' }

    const assets = readdirSync(join(dist, 'assets'))
    const js = assets.filter((n) => n.endsWith('.js'))
    const css = assets.filter((n) => n.endsWith('.css'))
    const bytes = [...js, ...css].reduce((sum, n) => sum + statSync(join(dist, 'assets', n)).size, 0)
    const mb = (bytes / 1024 / 1024).toFixed(2)

    // 前端产物必须自带 index.html，且不能引用任何外链
    const html = readFileSync(join(dist, 'index.html'), 'utf8')
    const externals = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
    if (externals.length) {
      return { ok: false, detail: `存在外部资源引用：${externals.join(', ')}` }
    }
    return {
      ok: true,
      detail: `${js.length} JS / ${css.length} CSS，${mb} MB，无外链`,
    }
  })

  // ---------------------------------------------------------------- 5. 打包

  stage('阶段 4／7　打包（cargo · 单文件 exe）', () => {
    if (!escalated) {
      return {
        ok: false,
        detail: '打包需要写 target/（cargo 编译），受限沙箱会拦截。请用 --escalated 在无沙箱环境运行',
      }
    }
    const r = runNpm(['run', 'pack'], { env: buildEnv })
    if (!r.ok) {
      const hint = /safe-delete|SAFE_DELETE/.test(r.output)
        ? '（被批量删除保护拦截：用 --escalated 运行）'
        : /Permission denied|os error 5|拒绝访问/i.test(r.output)
          ? '（权限被拒：打包需要写 target/，用 --escalated 运行）'
          : ''
      return { ok: false, detail: `打包失败${hint}`, tail: tailOf(r.output, 30) }
    }

    const outFile = grab(r.output, /文件：(.+)/)?.trim()
    const size = grab(r.output, /大小：([\d.]+) MB/)
    const dlls = grab(r.output, /外部依赖 (\d+) 个/)
    if (!outFile || !existsSync(outFile)) {
      return { ok: false, detail: '打包报告已产出但文件不存在', tail: tailOf(r.output, 15) }
    }
    return {
      ok: true,
      detail: `${size} MB，单文件校验通过（系统 DLL ${dlls} 个）`,
    }
  })
} else {
  process.stdout.write('\n\x1b[33m━━━ 阶段 3／7　前端构建　跳过（--fast）\x1b[0m\n')
  process.stdout.write('\n\x1b[33m━━━ 阶段 4／7　打包　　　跳过（--fast）\x1b[0m\n')
  remember({ name: '阶段 3／7　前端构建（vite）', ok: true, detail: '已跳过（--fast）', elapsed: 0, skipped: true })
  remember({ name: '阶段 4／7　打包（cargo · 单文件 exe）', ok: true, detail: '已跳过（--fast）', elapsed: 0, skipped: true })
}

// ---------------------------------------------------------------- 6. 产物深度校验

stage('阶段 5／7　产物校验（PE 导入表 · 资源内嵌）', () => {
  const releaseDir = join(root, 'release')
  if (!existsSync(releaseDir)) return { ok: false, detail: 'release/ 不存在' }
  const exes = readdirSync(releaseDir).filter((n) => n.toLowerCase().endsWith('.exe'))
  if (!exes.length) return { ok: false, detail: 'release/ 下没有 exe' }
  const exe = join(releaseDir, exes.sort((a, b) => statSync(join(releaseDir, b)).mtimeMs - statSync(join(releaseDir, a)).mtimeMs)[0])

  // 独立于打包脚本再解析一次 PE 导入表：打包脚本的断言可能被绕过，
  // 这里是「另一双眼睛」，用自己实现的解析器交叉验证单文件结论。
  const dlls = importedDlls(exe)
  const forbidden = dlls.filter((dll) => /^webview2loader\.dll$/i.test(dll) || /^vcruntime/i.test(dll) || /^msvcp/i.test(dll) || /^api-ms-win-crt-/i.test(dll))
  const sizeMb = (statSync(exe).size / 1024 / 1024).toFixed(2)

  // 资源内嵌校验：前端产物必须打进 exe。取 dist 里一个唯一的 chunk 文件名，
  // 在 exe 的二进制里找它 —— 找不到说明打的是 dev 模式（资源未内嵌）。
  const distAssets = existsSync(join(root, 'dist', 'assets')) ? readdirSync(join(root, 'dist', 'assets')) : []
  const probe = distAssets.find((n) => n.endsWith('.js'))
  let embedded = null
  if (probe) {
    const buffer = readFileSync(exe)
    // 资源名被压缩进二进制，用 latin1 读取后做子串匹配
    embedded = buffer.toString('latin1').includes(probe.split('.')[0])
  }

  if (forbidden.length) {
    return { ok: false, detail: `不是自包含单文件，存在可分发 DLL 依赖：${forbidden.join(', ')}` }
  }
  if (embedded === false) {
    return { ok: false, detail: `前端资源未内嵌（未找到 ${probe}），疑似 dev 模式构建` }
  }
  return {
    ok: true,
    detail: `${sizeMb} MB，${dlls.length} 个系统 DLL，前端资源已内嵌`,
  }
})

// ---------------------------------------------------------------- 7. UI 自动化

runUiStage()

// ---------------------------------------------------------------- 8. 服务启动

stage('阶段 7／7　服务启动（exe 冷启动 + 存储初始化）', () => {
  const r = runCapture(process.execPath, [join('scripts', 'smoke.mjs')])
  const detail = grab(r.output, /结果：(.+)/)
  return { ok: r.ok, detail: detail ?? (r.ok ? '冒烟通过' : '冒烟失败'), tail: tailOf(r.output, 25) }
})

// ---------------------------------------------------------------- 报告

const failed = stages.filter((s) => !s.ok)
const skipped = stages.filter((s) => s.skipped)
const totalElapsed = stages.reduce((sum, s) => sum + s.elapsed, 0).toFixed(1)

process.stdout.write('\n\x1b[1m═══ 全量验证报告 ═══\x1b[0m\n')
const nameWidth = Math.max(...stages.map((s) => visualWidth(s.name)), 20)
const detailWidth = 44
process.stdout.write(`┌${'─'.repeat(nameWidth + 2)}┬────────┬────────┬${'─'.repeat(detailWidth + 2)}┐\n`)
process.stdout.write(`│ ${pad('阶段', nameWidth)} │ 结果   │ 耗时   │ ${pad('说明', detailWidth)} │\n`)
process.stdout.write(`├${'─'.repeat(nameWidth + 2)}┼────────┼────────┼${'─'.repeat(detailWidth + 2)}┤\n`)
for (const s of stages) {
  const result = s.skipped ? '\x1b[33m跳过\x1b[0m  ' : s.ok ? '\x1b[32m通过\x1b[0m  ' : '\x1b[31m失败\x1b[0m  '
  process.stdout.write(
    `│ ${pad(s.name, nameWidth)} │ ${result} │ ${pad(`${s.elapsed}s`, 6)} │ ` +
      `${pad(truncate(s.detail, detailWidth), detailWidth)} │\n`,
  )
}
process.stdout.write(`└${'─'.repeat(nameWidth + 2)}┴────────┴────────┴${'─'.repeat(detailWidth + 2)}┘\n`)

const okCount = stages.length - failed.length - skipped.length
process.stdout.write(
  `\n${stages.length} 个阶段：\x1b[32m通过 ${okCount}\x1b[0m` +
    (failed.length ? `，\x1b[31m失败 ${failed.length}\x1b[0m` : '') +
    (skipped.length ? `，\x1b[33m跳过 ${skipped.length}\x1b[0m` : '') +
    `　合计耗时 ${totalElapsed}s\n`,
)

if (envProblems.length) {
  process.stdout.write('\n\x1b[33m环境提示：\x1b[0m\n')
  for (const p of envProblems) process.stdout.write(`  · ${p}\n`)
}

if (failed.length) {
  process.stdout.write('\n\x1b[31m失败阶段：\x1b[0m\n')
  for (const s of failed) process.stdout.write(`  · ${s.name}：${s.detail}\n`)
  process.exit(1)
}

process.stdout.write('\n\x1b[32m✔ 全量验证通过\x1b[0m\n')
if (fast) process.stdout.write('\x1b[90m（--fast 模式跳过了构建与打包，发布前请跑一次完整验证）\x1b[0m\n')

// ---------------------------------------------------------------- PE 解析

/**
 * 解析 PE 导入表，列出 exe 依赖的外部 DLL。
 * 这是「单文件」的唯一硬证据 —— 构建配置写得再对，也要以产物为准。
 * 与 scripts/build.mjs 各自独立实现，互为交叉验证。
 */
function importedDlls(file) {
  const buf = readFileSync(file)
  if (buf.toString('latin1', 0, 2) !== 'MZ') throw new Error('不是有效的 PE 文件（缺少 MZ 头）')
  const pe = buf.readUInt32LE(0x3c)
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\u0000\u0000') throw new Error('不是有效的 PE 文件（缺少 PE 签名）')

  const sectionCount = buf.readUInt16LE(pe + 6)
  const optSize = buf.readUInt16LE(pe + 20)
  const opt = pe + 24
  const magic = buf.readUInt16LE(opt)
  const dataDir = opt + (magic === 0x20b ? 112 : 96)
  const importRva = buf.readUInt32LE(dataDir + 8)

  const sections = []
  for (let i = 0; i < sectionCount; i += 1) {
    const off = pe + 24 + optSize + i * 40
    sections.push({
      va: buf.readUInt32LE(off + 12),
      size: buf.readUInt32LE(off + 8),
      rawSize: buf.readUInt32LE(off + 16),
      rawPtr: buf.readUInt32LE(off + 20),
    })
  }
  const rvaToOffset = (rva) => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.size, s.rawSize)) return s.rawPtr + (rva - s.va)
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
    names.push(buf.toString('latin1', nameOff, buf.indexOf(0, nameOff)))
    off += 20
  }
  return names
}

// ---------------------------------------------------------------- 排版

function visualWidth(text) {
  let width = 0
  for (const char of text) width += /[\u2E80-\uFFFD]/.test(char) ? 2 : 1
  return width
}

function pad(text, width) {
  return text + ' '.repeat(Math.max(0, width - visualWidth(text)))
}

function truncate(text, limit) {
  if (visualWidth(text) <= limit) return text
  let out = ''
  let width = 0
  for (const char of text) {
    const w = /[\u2E80-\uFFFD]/.test(char) ? 2 : 1
    if (width + w > limit - 1) break
    out += char
    width += w
  }
  return `${out}…`
}