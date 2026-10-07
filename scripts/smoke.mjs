#!/usr/bin/env node
/**
 * 服务启动冒烟：验证打包产物能真正「跑起来」并完成存储初始化。
 *
 * 与 uitest.mjs 的区别：uitest 验的是功能正确性（点击、数据一致性），
 * 这里验的是「启动即用」——冷启动能否成功、目录结构能否自动建立、
 * 数据库能否建表、日志能否落盘。打包环节最容易出问题的恰恰是启动路径。
 *
 * 用法：node scripts/smoke.mjs
 * 退出码 0 = 通过。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDataDir = join(process.env.APPDATA ?? root, 'com.taowd.hello-tauri')
const bootstrapFile = join(appDataDir, 'bootstrap.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  process.stdout.write(
    `  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${name}${detail ? ` \x1b[90m— ${detail}\x1b[0m` : ''}\n`,
  )
}

async function check(name, fn) {
  try {
    record(name, true, (await fn()) ?? '')
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function findExe() {
  const releaseDir = join(root, 'release')
  if (!existsSync(releaseDir)) throw new Error('release/ 不存在，请先执行 npm run pack')
  const exe = readdirSync(releaseDir)
    .filter((n) => n.toLowerCase().endsWith('.exe'))
    .map((n) => join(releaseDir, n))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (!exe) throw new Error('release/ 下没有 exe')
  return exe
}

// 注意：这里一律 shell:false。Windows 上 spawnSync(..., { shell: true }) 会吞掉
// tasklist/taskkill 的 stdout，导致 includes() 判断永远为假（曾误报"进程已退出"）。
function killByName(image) {
  // ⚠️ 必须「先取 PID，再 killTree（= taskkill /F /T /PID）」。
  // `taskkill /F /IM <image>` 只杀 exe 本身，**不回收它的 WebView2 子进程** ——
  // 留下的孤儿会一直占着该应用的 user-data 目录，让之后每一次启动都起不来 WebView2
  // （现象：进程活着但窗口全白、CDP 端口永不监听）。
  // 2026-10-07 实测：一个被 `/IM` 杀掉的白屏实例留下 5 个孤儿，随后所有启动全部失败。
  for (const pid of pidsByName(image)) killTree(pid)
}

/** 该镜像名当前所有进程的 PID（tasklist 在「没有匹配」时输出本地化提示语，要按行滤掉） */
function pidsByName(image) {
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return (r.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() && !/没有运行|No tasks|INFO:/i.test(line))
    .map((line) => Number(line.split('","')[1]))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/**
 * 引用**本应用 profile** 的 msedgewebview2 幽灵进程 PID。
 *
 * 用命令行里的 profile 标识匹配，**不是**按镜像名 `msedgewebview2.exe` 扫 ——
 * 后者属于所有 WebView2 应用（Edge、Outlook、其他 Tauri/Electron），按名扫是全局误伤。
 */
function webviewGhostPids() {
  const marker = "$_.CommandLine -match 'Hello-Tauri|com\\.taowd\\.hello-tauri' -and $_.CommandLine -notmatch '--type='"
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { ${marker} } | Select-Object -ExpandProperty ProcessId`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  return (r.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/**
 * 冷启动前清掉幽灵 WebView2 进程，**并等它们真的消失**。
 *
 * Chromium 的 user-data 目录同一时刻只允许一个浏览器进程：只要有一个幽灵占着 profile，
 * 本次启动的 WebView2 就创建不起来 —— 进程活着 12s、却一个目录都不建（冒烟会报
 * 「scandir ...sandbox 不存在」）。幽灵由应用异常终止产生（release 档 `panic = "abort"`，
 * 进程被直接终止、来不及回收子进程），所以即便 killTree 的 `/T` 本身是干净的也必须防御。
 */
async function killWebviewGhosts() {
  let total = 0
  for (let round = 0; round < 6; round += 1) {
    const pids = webviewGhostPids()
    if (!pids.length) break
    for (const pid of pids) killTree(pid)
    total += pids.length
    await sleep(600)
  }
  if (total) {
    process.stdout.write(`  \x1b[90m已清理 ${total} 个占着 profile 的 WebView2 幽灵进程\x1b[0m\n`)
  }
  return total
}

/**
 * 该镜像名当前有几个进程在跑（0 表示没有残留）。用于「先探测再动手」。
 *
 * ⚠️ 绝不按镜像名杀 `msedgewebview2.exe`：那个镜像名属于**所有**基于 WebView2
 * 的应用（Edge、Outlook、其他 Tauri/Electron 应用）。本应用退出后它的 WebView2
 * 子进程会随 killTree(pid) 的 /T 精确回收（uitest.mjs 2026-09-28 实测：仅
 * killTree 后基线进程数精确回落，无孤儿）——按名清扫纯属误伤，还会在两个
 * 验证流程并发时互相杀掉对方的进程（已真实发生过，表现为用例大面积假失败）。
 */
function countByName(image) {
  return pidsByName(image).length
}

/**
 * 清理**本应用自己的**残留实例：先探测再动手，没有残留时一个进程都不杀。
 * 无条件调用会让「用户正开着本应用」变成「冒烟把他的应用关掉」。
 */
function clearStaleInstances(exeName) {
  const count = countByName(exeName)
  if (count === 0) return
  process.stdout.write(`  \x1b[90m检测到 ${count} 个残留的 ${exeName} 实例（会独占数据目录），已清理\x1b[0m\n`)
  killByName(exeName)
}

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

/** 冷启动 exe（纯冷启：不注入调试参数，模拟用户的真实双击） */
function launch(exe) {
  const child = spawn(exe, [], { cwd: dirname(exe), detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

/** 判断进程是否还活着（还活着才说明没崩）。比 tasklist 可靠且不受本地化影响。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function openDb(dataDir) {
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(join(dataDir, 'data', 'app.db'), { readOnly: true })
}

/** 本次冒烟使用的沙箱根（每次运行唯一，见 main 里的说明） */
let sandboxRoot = null

async function main() {
  const started = Date.now()
  process.stdout.write('\n\x1b[1m═══ 服务启动冒烟（冷启动真实 exe）═══\x1b[0m\n')

  const exe = findExe()
  const image = basename(exe)
  process.stdout.write(`\x1b[90m产物：${exe}\x1b[0m\n`)

  // 沙箱：把数据根指向工作区内部，避免污染用户真实数据目录。
  // 用全新的带时间戳目录而不是原地清空 —— 清空要递归删几十个文件，
  // 会撞上运行环境的批量删除保护，反而让冒烟在收尾阶段失败。
  sandboxRoot = join(root, 'target', `smoke-sandbox-${Date.now()}`)
  const backup = existsSync(bootstrapFile) ? readFileSync(bootstrapFile, 'utf8') : null
  mkdirSync(appDataDir, { recursive: true })
  writeFileSync(bootstrapFile, JSON.stringify({ dataDir: sandboxRoot }, null, 2), 'utf8')

  let pid = null
  try {
    // 清场后冷启动：只清理本应用自己的残留，绝不按镜像名扫 msedgewebview2.exe
    clearStaleInstances(image)
    // 幽灵 WebView2 会占着 profile，本次冷启动就起不来 WebView2（进程活着但一个目录都不建）
    await killWebviewGhosts()
    await sleep(1200)
    pid = launch(exe)

    await check('进程冷启动后持续存活（未崩溃）', async () => {
      // 给 WebView2 初始化留时间；崩溃通常发生在前几秒
      for (let i = 0; i < 12; i += 1) {
        await sleep(1000)
        if (!isAlive(pid)) throw new Error(`启动后第 ${i + 1} 秒进程已退出`)
      }
      return '存活 12s'
    })

    await check('自动创建 config/ data/ logs 目录结构', async () => {
      const dirs = readdirSync(sandboxRoot).sort()
      for (const expected of ['config', 'data', 'logs']) {
        assert(dirs.includes(expected), `缺少目录 ${expected}（实际：${dirs.join(', ') || '空'}）`)
      }
      return dirs.join(', ')
    })

    await check('生成 SQLite 数据库并完成建表', async () => {
      assert(existsSync(join(sandboxRoot, 'data', 'app.db')), 'app.db 不存在')
      const db = openDb(sandboxRoot)
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
          .map((r) => r.name)
        assert(tables.includes('records'), `records 表缺失（实际：${tables.join(', ')}）`)
        assert(tables.includes('_migrations'), '_migrations 表缺失')
        const count = db.prepare('SELECT COUNT(*) AS c FROM records').get().c
        assert(count > 0, '首次启动未导入种子数据')
        return `${tables.length} 张表，${count} 条种子记录`
      } finally {
        db.close()
      }
    })

    await check('写入 config.json', async () => {
      const file = join(sandboxRoot, 'config', 'config.json')
      assert(existsSync(file), 'config.json 不存在')
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      assert(typeof parsed.pageSize === 'number', 'pageSize 缺失')
      return Object.keys(parsed).join(', ')
    })

    await check('日志按本地日期落盘且格式正确', async () => {
      const logsDir = join(sandboxRoot, 'logs')
      const files = readdirSync(logsDir).filter((n) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(n))
      assert(files.length > 0, `未生成日志文件（实际：${readdirSync(logsDir).join(', ') || '空'}）`)
      const latest = files.sort().pop()
      const lines = readFileSync(join(logsDir, latest), 'utf8').trim().split('\n')
      assert(
        lines.every((l) => /^\d{2}:\d{2}:\d{2}\.\d{3} \[(INFO|WARN|ERROR)\]/.test(l)),
        `日志行格式不符：${lines[0]}`,
      )
      return `${latest}，${lines.length} 行`
    })

    await check('无遗留旧版 table.json', async () => {
      const legacy = join(sandboxRoot, 'data', 'table.json')
      assert(!existsSync(legacy), '出现了 table.json')
      return '无'
    })
  } finally {
    // 清理一律 best-effort：受限环境会拦截递归删除，那不是冒烟失败。
    // bootstrap.json 必须还原，否则会污染用户真实数据目录。
    try {
      // /T 连带回收 WebView2 渲染/GPU/网络子进程，无需再按镜像名清扫
      killTree(pid)
      await sleep(600)
    } catch {
      // 进程清理失败不影响结论
    }
    try {
      if (backup === null) rmSync(bootstrapFile, { force: true })
      else writeFileSync(bootstrapFile, backup, 'utf8')
    } catch (error) {
      process.stdout.write(
        `\x1b[31m警告：bootstrap.json 还原失败（${bootstrapFile}），请手工检查：` +
          `${error instanceof Error ? error.message : error}\x1b[0m\n`,
      )
    }
    try {
      rmSync(sandboxRoot, { recursive: true, force: true })
    } catch {
      // 沙箱遗留在 target/ 下（已 gitignore），不影响结论
    }
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  process.stdout.write(
    `\n结果：${failed.length ? `失败 ${failed.length}/${results.length}` : `全部通过 ${passed}/${results.length}`}（${elapsed}s）\n`,
  )
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  · ${f.name}：${f.detail}\n`)
    process.exit(1)
  }
  process.stdout.write('\x1b[32m✔ 服务启动冒烟通过：exe 冷启动可用，存储自动初始化\x1b[0m\n')
}

main().catch((error) => {
  process.stderr.write(`\n未捕获异常：${error?.stack ?? error}\n`)
  process.exit(1)
})
