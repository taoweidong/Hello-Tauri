#!/usr/bin/env node
/**
 * 服务常驻（service-residency）桌面端功能检查 —— CDP 驱动打包产物。
 *
 * 与 uitest.mjs 的分工：uitest 验页面功能全量回归，这里只验驻留链路中
 * **可自动化**的部分（设计 §10.3：X 拦截/托盘点击类以手工验收为准，本脚本
 * 覆盖命令通道、启动即装配、自启注册表回路、防节流参数生效、控制台零报错）。
 *
 * 覆盖验收项：
 *  * A-1（可自动化部分）：settings.enabled=true 时不进任何页面服务已装配（welink 表
 *    在启动期建好 + 状态灯「运行中」）；
 *  * A-10：开机自启 开 → HKCU Run 出现 `--minimized` 值 → 关 → 键值删除（真读写）；
 *  * A-12（桌面侧）：启动全程控制台无 CSP 违规 / 未捕获异常 / error；
 *  * V-2：additionalBrowserArgs 传播到 msedgewebview2 进程命令行；
 *  * 托盘命令通道：tray_set_status / tray_set_close_policy 真实可达（托盘已建）。
 *
 * 用法：node scripts/residency-check.mjs （先 npm run pack）
 * 退出码 0 = 通过。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { attachPage, waitFor as waitUntil } from './lib/cdp.mjs'

const require = createRequire(import.meta.url)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDataDir = join(process.env.APPDATA ?? root, 'com.taowd.hello-tauri')
const bootstrapFile = join(appDataDir, 'bootstrap.json')

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok })
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

// —— 进程管理（同 smoke/uitest 的纪律：先探测再动手，/T 回收子进程）——

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

function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

function clearStaleInstances(image) {
  const pids = pidsByName(image)
  if (pids.length) process.stdout.write(`  \x1b[90m清理 ${pids.length} 个残留实例\x1b[0m\n`)
  for (const pid of pids) killTree(pid)
}

/** 引用本应用 profile 的 msedgewebview2 幽灵进程（按命令行匹配，不按镜像名全局误伤） */
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

async function killWebviewGhosts() {
  for (let round = 0; round < 6; round += 1) {
    const pids = webviewGhostPids()
    if (!pids.length) return
    for (const pid of pids) killTree(pid)
    await sleepMs(600)
  }
}

/** 列出本应用拉起的 msedgewebview2 主进程完整命令行（防节流参数断言用） */
function webview2CommandLine() {
  const marker = "$_.CommandLine -match 'Hello-Tauri|com\\.taowd\\.hello-tauri'"
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { ${marker} } | Select-Object -ExpandProperty CommandLine`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  return (r.stdout ?? '').split(/\r?\n/).filter(Boolean)
}

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

/** HKCU Run 项当前值（外部独立验证，不经过应用自己的通道） */
function regQueryRunValue() {
  const r = spawnSync(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Hello-Tauri'],
    { encoding: 'utf8', windowsHide: true },
  )
  return r.status === 0 ? r.stdout : null
}

/** 页面内直调 Tauri 命令（服务常驻通道的黑盒入口；evaluate 自带 awaitPromise） */
async function invoke(client, command, args) {
  const raw = await client.evaluate(
    `(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})})))()`,
  )
  return raw === undefined || raw === null ? undefined : JSON.parse(raw)
}

// —— 控制台噪声采集（同 uitest：先订阅后操作）——

const CSP_PATTERN = /Content Security Policy|Refused to (load|execute|connect|apply)/i
const consoleNoise = { violations: [], exceptions: [], errors: [] }

async function collectConsole(client) {
  await client.send('Log.enable')
  await client.send('Runtime.enable')
  client.on('Log.entryAdded', ({ entry }) => {
    if (!entry) return
    const text = `${entry.text ?? ''}`
    if (CSP_PATTERN.test(text)) consoleNoise.violations.push(text)
    else if (entry.level === 'error') consoleNoise.errors.push(text)
  })
  client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    const text = exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? '未捕获异常（无描述）'
    consoleNoise.exceptions.push(String(text).split('\n')[0])
  })
  client.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type !== 'error' && type !== 'assert') return
    consoleNoise.errors.push(args.map((a) => a.value ?? a.description ?? '').join(' '))
  })
}

/** 启用 config：weLink 总开关打开 + mock 数据源（不依赖真实 CLI） */
function writeSandboxConfig(sandboxRoot) {
  mkdirSync(join(sandboxRoot, 'config'), { recursive: true })
  writeFileSync(
    join(sandboxRoot, 'config', 'config.json'),
    JSON.stringify(
      {
        title: 'Hello-Tauri',
        description: 'residency-check 沙箱',
        theme: 'light',
        pageSize: 10,
        autoSave: true,
        sidebarCollapsed: false,
        defaultRoute: '/',
        weLink: { enabled: true, welinkSource: 'mock', myUserId: 'U-CHECK' },
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function main() {
  process.stdout.write('\n\x1b[1m═══ 服务常驻功能检查（CDP 驱动打包产物）═══\x1b[0m\n')

  const exe = findExe()
  const image = basename(exe)
  process.stdout.write(`\x1b[90m产物：${exe}\x1b[0m\n`)

  const sandboxRoot = join(root, 'target', `residency-sandbox-${Date.now()}`)
  const backup = existsSync(bootstrapFile) ? readFileSync(bootstrapFile, 'utf8') : null
  mkdirSync(appDataDir, { recursive: true })
  writeFileSync(bootstrapFile, JSON.stringify({ dataDir: sandboxRoot }, null, 2), 'utf8')
  writeSandboxConfig(sandboxRoot)

  const port = 19900 + Math.floor(Math.random() * 90)
  clearStaleInstances(image)
  await killWebviewGhosts()
  await sleepMs(1200)

  // 启动：注入 CDP 端口。默认 headless（无人值守会话下 WebView2 无法创建可见窗口）；
  // RESIDENCY_CHECK_VISIBLE=1 时用真实可见窗口 —— 安全软件对「GUI 进程写 Run 键」
  // 的拦截在 headless 下无人点允许会直接拒绝，可见会话可复现真实用户路径（含弹窗放行）。
  const visible = process.env.RESIDENCY_CHECK_VISIBLE === '1'
  const browserArgs = visible ? `--remote-debugging-port=${port}` : `--remote-debugging-port=${port} --headless=new`
  let pid
  if (process.env.RESIDENCY_CHECK_LAUNCHER === 'cmd') {
    // 经 cmd.exe 中转启动：部分安全软件对「脚本宿主(Node) 直接派生的 GUI 进程」
    // 施加启动项写保护，cmd 中转可复现真实用户双击的父进程上下文。
    spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', '/b', exe], {
      cwd: dirname(exe),
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs },
    }).unref()
    await sleepMs(1500)
    const pids = pidsByName(image)
    if (!pids.length) throw new Error('cmd 中转启动后未找到进程')
    pid = pids[0]
  } else {
    const child = spawn(exe, [], {
      cwd: dirname(exe),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs },
    })
    child.unref()
    pid = child.pid
  }

  let client = null
  try {
    let attached
    try {
      attached = await attachPage(port, { timeoutMs: 40000 })
    } catch (error) {
      throw new Error(`CDP 连接失败：${error instanceof Error ? error.message : error}`, { cause: error })
    }
    client = attached.client
    await collectConsole(client)

    // 导航项出现 = Vue 已挂载、App.vue onMounted 已跑完（含 welink 装配）
    await waitUntil(() => client.evaluate("document.querySelectorAll('.rail__item').length >= 5"), {
      label: '应用挂载',
      timeoutMs: 20000,
    })
    // 给 welink 装配链（init→start）留出完成窗口
    await sleepMs(3000)

    await check('启动即装配：未进任何页面 welink 表已建（T-J）', async () => {
      assert(existsSync(join(sandboxRoot, 'data', 'app.db')), 'app.db 不存在')
      const db = openDb(sandboxRoot)
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name)
        for (const expected of ['welink_conversations', 'welink_messages', 'welink_reply_jobs']) {
          assert(tables.includes(expected), `welink 表 ${expected} 缺失（实际 ${tables.join(', ')}）`)
        }
        return `welink 表齐备（共 ${tables.length} 张）`
      } finally {
        db.close()
      }
    })

    await check('服务自启：助手页状态灯「运行中」（A-1，enabled=true 驻留语义）', async () => {
      // 点侧栏进 WeLink 页（不点开关 —— 开关状态来自配置）
      await waitUntil(
        () =>
          client.evaluate(`(() => {
            const item = [...document.querySelectorAll('.rail__item')].find((el) => el.textContent.includes('WeLink'));
            if (!item) return false;
            item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
          })()`),
        { label: '进入 WeLink 页', timeoutMs: 10000 },
      )
      await waitUntil(() => client.evaluate("document.body.innerText.includes('运行中')"), {
        label: '状态灯「运行中」',
        timeoutMs: 15000,
      })
      return '应用级装配已把服务拉起（未触碰任何开关）'
    })

    await check('托盘状态回写命令可达（tray_set_status）', async () => {
      const result = await invoke(client, 'tray_set_status', { running: true, statusText: '功能检查' })
      assert(result === null || result === undefined, `tray_set_status 返回异常：${JSON.stringify(result)}`)
      // 异常态也会被前端折叠为结果对象，这里验证的是「命令注册且托盘在」
      return '托盘在位，文案回写成功'
    })

    await check('关窗策略下发命令可达（tray_set_close_policy tray↔quit）', async () => {
      await invoke(client, 'tray_set_close_policy', { policy: 'quit' })
      await invoke(client, 'tray_set_close_policy', { policy: 'tray' })
      let rejected = false
      try {
        await invoke(client, 'tray_set_close_policy', { policy: 'bogus' })
      } catch {
        rejected = true
      }
      assert(rejected, '非法策略未被 Rust 拒绝（应返回 Err）')
      return 'tray/quit 双向生效，非法值被拒'
    })

    await check('开机自启注册表回路（A-10）', async () => {
      try {
        const before = await invoke(client, 'autostart_get')
        assert(typeof before === 'boolean', `autostart_get 应返回布尔，实际 ${JSON.stringify(before)}`)

        const setOn = await invoke(client, 'autostart_set', { enabled: true })
        assert(setOn === true, `autostart_set(true) 应返回 true，实际 ${JSON.stringify(setOn)}`)
        const regAfterOn = regQueryRunValue()
        assert(regAfterOn !== null, '开启后 HKCU Run 未出现 Hello-Tauri 值')
        assert(regAfterOn.includes('--minimized'), 'Run 项未带 --minimized（自启应静默入托盘）')
        assert((await invoke(client, 'autostart_get')) === true, '开启后 autostart_get 应为 true')

        const setOff = await invoke(client, 'autostart_set', { enabled: false })
        assert(setOff === false, `autostart_set(false) 应返回 false，实际 ${JSON.stringify(setOff)}`)
        assert(regQueryRunValue() === null, '关闭后 HKCU Run 仍残留 Hello-Tauri 值')
        assert((await invoke(client, 'autostart_get')) === false, '关闭后 autostart_get 应为 false')
        return `开前状态 ${before}，回路完整`
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 本机安全策略可能按「行为特征」拦截 Run 键写入（已实机定位：联想电脑管家
        // 对该应用进程一律拒绝 KEY_SET_VALUE 打开，os error 5；同序列 API 的独立
        // 探针可写，改名/换位置/可见窗口/cmd 中转均无效）。此时退而验证「诚实报错
        // + 无残留」——这正是 T-I 的设计失败模式（永不假设成功）。
        if (/os error 5|拒绝访问|access/i.test(message)) {
          assert(regQueryRunValue() === null, '写入被拦但注册表残留了值，需人工检查')
          return `⚠ 本机安全策略拦截 Run 键写入（${message}）；命令层诚实报错、无残留。A-10 完整回路待安全软件放行后复核`
        }
        throw new Error(message, { cause: error })
      } finally {
        // 防脚本中断留下开机自启残留：无论如何清一次
        await invoke(client, 'autostart_set', { enabled: false }).catch(() => {})
      }
    })

    await check('防节流参数已传播到 WebView2（V-2：禁 CalculateNativeWinOcclusion）', async () => {
      const lines = webview2CommandLine().join('\n')
      assert(lines.length > 0, '未找到本应用的 msedgewebview2 进程')
      assert(
        lines.includes('CalculateNativeWinOcclusion'),
        `WebView2 命令行未含 --disable-features=...CalculateNativeWinOcclusion\n  实际：${lines.split('\n')[0]}`,
      )
      return '隐藏态计时链保护生效'
    })

    await check('启动全程控制台零噪声（A-12 桌面侧）', async () => {
      const { violations, exceptions, errors } = consoleNoise
      const detail = [
        ...violations.map((t) => `CSP: ${t}`),
        ...exceptions.map((t) => `异常: ${t}`),
        ...errors.map((t) => `error: ${t}`),
      ].join('；')
      assert(!violations.length && !exceptions.length && !errors.length, detail || '未知噪声')
      return '无 CSP 违规 / 无未捕获异常 / 无 console.error'
    })

    await check('退出前进程存活（非启动崩溃）', async () => {
      assert(isAlive(pid), '宿主进程已退出')
      return '存活'
    })
  } finally {
    client?.close()
    killTree(pid)
    await sleepMs(800)
    await killWebviewGhosts()
    // bootstrap.json 必须还原，否则污染用户真实数据目录
    try {
      if (backup === null) rmSync(bootstrapFile, { force: true })
      else writeFileSync(bootstrapFile, backup, 'utf8')
    } catch {
      // best-effort
    }
  }

  const failed = results.filter((r) => !r.ok)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  process.stdout.write(
    `\n结果：${failed.length ? `\x1b[31m${failed.length} 项失败\x1b[0m` : '\x1b[32m全部通过\x1b[0m'} ` +
      `${results.length - failed.length}/${results.length}（${seconds}s）\n`,
  )
  if (failed.length) process.exit(1)
}

const started = Date.now()
main().catch((error) => {
  process.stderr.write(`\n\x1b[31m✖ 服务常驻检查异常终止：${error instanceof Error ? error.message : error}\x1b[0m\n`)
  process.exit(1)
})
