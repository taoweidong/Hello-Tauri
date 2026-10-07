#!/usr/bin/env node
/**
 * windows-infra-foundation 桌面冒烟（tasks 8.2）。
 *
 * 原理与 scripts/uitest.mjs 相同：给 WebView2 注入 remote-debugging-port，
 * 通过 CDP 在真实桌面应用的页面上下文里直接调用 Tauri 命令 —— 不经任何 UI，
 * 验证的是「Rust 命令端到端可用 + 输出可读」。
 *
 * 覆盖面：
 *  * 系统信息四命令：sys_overview / sys_env_var / sys_disks / sys_adapters；
 *  * 注册表 8 条诊断命令（经 cli_run 白名单通道，程序/参数与 registry.ts 一致）；
 *  * GBK 中文输出可读性（ipconfig 在中文 Windows 上输出 GBK）；
 *  * Shell 交互：clipboard_write→read 往返（并恢复原剪贴板）、notify_send、
 *    shell_open（URL 与数据根目录各一）。
 *
 * 注意：notify/shell_open 会产生**用户可见副作用**（toast 通知、浏览器标签页、
 * 资源管理器窗口）；剪贴板会先备份原内容、结束前尽力恢复。
 *
 * 用法：node openspec/changes/windows-infra-foundation/smoke-windows-infra.mjs
 */
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { attachPage, sleep } from '../../../scripts/lib/cdp.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CDP_PORT = 9333
const DEV_LOG = join(root, 'target', 'smoke-tauri-dev.log')
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  process.stdout.write(`  ${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}\n`)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
    return true
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
    return false
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
  return condition
}

/** Node 侧解码（与 utils/b64 同链路）：base64 → 严格 UTF-8 → GBK 兜底 */
function decodeB64Text(b64) {
  const bytes = new Uint8Array(Buffer.from(String(b64 || '').replace(/\s+/g, ''), 'base64'))
  if (!bytes.length) return { text: '', encoding: 'utf-8' }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    /* 继续尝试 GBK */
  }
  try {
    return { text: new TextDecoder('gbk').decode(bytes), encoding: 'gbk' }
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'lossy' }
  }
}

/** 注册表 8 条命令（与 src/infra/windows/registry.ts 一致，含必填追加参数） */
const REGISTRY_SMOKE = [
  { id: 'system-info', program: 'systeminfo', args: [], budgetMs: 15_000 },
  { id: 'ipconfig-all', program: 'ipconfig', args: ['/all'], budgetMs: 10_000 },
  { id: 'task-list', program: 'tasklist', args: [], budgetMs: 10_000 },
  { id: 'where-exe', program: 'where', args: ['ping'], budgetMs: 10_000 },
  { id: 'whoami', program: 'whoami', args: [], budgetMs: 10_000 },
  { id: 'hostname', program: 'hostname', args: [], budgetMs: 10_000 },
  { id: 'nslookup', program: 'nslookup', args: ['localhost'], budgetMs: 10_000 },
  { id: 'ping-host', program: 'ping', args: ['-n', '4', '127.0.0.1'], budgetMs: 15_000 },
]

async function main() {
  process.stdout.write(`启动 tauri:dev（WebView2 headless + CDP，日志 ${DEV_LOG}）...\n`)
  const logFd = openSync(DEV_LOG, 'w')
  const child = spawn('npm', ['run', 'tauri:dev'], {
    cwd: root,
    shell: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --headless=new`,
    },
    detached: true,
  })

  let client
  try {
    // 冷启动含 cargo 全量编译，给足预算
    ;({ client } = await attachPage(CDP_PORT, { timeoutMs: 600_000 }))
    // 等 Tauri internals 就绪
    const deadline = Date.now() + 30_000
    for (;;) {
      const ready = await client
        .evaluate(
          `typeof window.__TAURI_INTERNALS__ !== 'undefined' && typeof window.__TAURI_INTERNALS__.invoke === 'function'`,
        )
        .catch(() => false)
      if (ready) break
      assert(Date.now() < deadline, '等待 __TAURI_INTERNALS__ 超时')
      await sleep(300)
    }

    const invoke = (cmd, args = {}) =>
      client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`, {
        awaitPromise: true,
      })

    // —— 系统信息四命令 ——
    let dataRoot = ''
    await check('sys_overview 系统概要', async () => {
      const overview = await invoke('sys_overview')
      assert(overview && overview.osName, 'osName 为空')
      assert(overview.hostname && overview.username, '主机名/用户名为空')
      dataRoot = overview.dataRoot
      return `${overview.osName} / ${overview.osVersion} / ${overview.hostname} / ${overview.username}`
    })
    await check('sys_env_var 环境变量', async () => {
      const value = await invoke('sys_env_var', { name: 'PATH' })
      assert(typeof value === 'string' && value.length > 0, 'PATH 读取为空')
      const missing = await invoke('sys_env_var', { name: 'CERTAINLY_NOT_SET_VAR_XYZ' })
      assert(missing === null, '缺失变量应返回 null')
      return `PATH 长度 ${value.length}；缺失变量 → null`
    })
    await check('sys_disks 磁盘枚举', async () => {
      const disks = await invoke('sys_disks')
      assert(Array.isArray(disks) && disks.length > 0, '磁盘清单为空')
      const first = disks[0]
      assert(first.totalBytes > 0, '容量为 0')
      return `${disks.map((d) => `${d.letter}: ${(d.totalBytes / 2 ** 30).toFixed(0)}GB`).join('、')}`
    })
    await check('sys_adapters 网卡枚举', async () => {
      const adapters = await invoke('sys_adapters')
      assert(Array.isArray(adapters), '网卡清单非数组')
      const up = adapters.filter((a) => a.enabled)
      assert(up.length > 0, '无启用状态的网卡')
      const withIp = up.find((a) => a.ipv4)
      assert(withIp, '启用网卡均无 IPv4 地址')
      return `${adapters.length} 个适配器，启用 ${up.length} 个，示例 ${withIp.name} = ${withIp.ipv4}`
    })

    // —— 注册表 8 条命令 + GBK 可读性 ——
    for (const entry of REGISTRY_SMOKE) {
      await check(`cli_run ${entry.id}`, async () => {
        const outcome = await invoke('cli_run', {
          program: entry.program,
          args: entry.args,
          timeoutMs: entry.budgetMs,
        })
        assert(outcome.timedOut !== true, '命令超时（超出冒烟预算）')
        const stdout = decodeB64Text(outcome.stdout)
        const text = stdout.text.slice(0, 80).replace(/\r?\n/g, ' ⏎ ')
        return `exit=${outcome.exitCode} 编码=${stdout.encoding} 输出前 80 字：${text || '(空)'}`
      })
    }
    await check('GBK 可读性（ipconfig 中文输出）', async () => {
      const outcome = await invoke('cli_run', { program: 'ipconfig', args: ['/all'], timeoutMs: 10_000 })
      const stdout = decodeB64Text(outcome.stdout)
      assert(stdout.encoding !== 'lossy', '输出退化为 lossy（编码兜底失败）')
      if (stdout.encoding === 'gbk') {
        assert(!stdout.text.includes('\uFFFD'), 'GBK 解码出现替换符 U+FFFD')
        return `编码=gbk，中文片段：${(stdout.text.match(/[\u4e00-\u9fa5]+/) ?? ['(无中文)'])[0].slice(0, 20)}`
      }
      return `编码=utf-8（本机 ipconfig 输出为 UTF-8，GBK 路径由单测覆盖）`
    })

    // —— Shell 交互 ——
    await check('clipboard 写读往返（含恢复原内容）', async () => {
      const original = await invoke('clipboard_read')
      const originalText = typeof original === 'string' ? original : null
      const marker = `Hello-Tauri 冒烟 ${Date.now()}`
      await invoke('clipboard_write', { text: marker })
      const roundTrip = await invoke('clipboard_read')
      assert(roundTrip === marker, `往返不一致：${JSON.stringify(roundTrip)}`)
      if (originalText !== null) await invoke('clipboard_write', { text: originalText })
      return `往返一致；原剪贴板${originalText === null ? '为空，无需恢复' : '已恢复'}`
    })
    await check('notify_send 系统通知', async () => {
      await invoke('notify_send', {
        title: 'Hello-Tauri 冒烟',
        body: 'Windows 基础设施通知冒烟（windows-infra-foundation）',
      })
      return '已发送（桌面右下角应出现 toast/气球提示）'
    })
    await check('shell_open URL', async () => {
      await invoke('shell_open', { target: 'https://example.com' })
      return '默认浏览器应已打开 example.com'
    })
    await check('shell_open 数据根目录', async () => {
      assert(dataRoot, '数据根未知（sys_overview 未成功）')
      await invoke('shell_open', { target: dataRoot })
      return `资源管理器应已打开 ${dataRoot}`
    })

    // —— 汇总 ——
    const passed = results.filter((r) => r.ok).length
    const total = results.length
    const lines = [
      '# 冒烟记录 — windows-infra-foundation（tasks 8.2）',
      '',
      `- 时间：${new Date().toLocaleString('zh-CN')}`,
      '- 方式：tauri:dev + WebView2 CDP（headless），页面上下文直接 invoke Tauri 命令',
      `- 结果：${passed}/${total} 通过`,
      '',
      '| 检查项 | 结果 | 详情 |',
      '| --- | --- | --- |',
      ...results.map((r) => `| ${r.name} | ${r.ok ? '✔' : '✖'} | ${String(r.detail).replaceAll('|', '\\|')} |`),
      '',
    ]
    writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'smoke-record.md'), lines.join('\n'), 'utf8')
    process.stdout.write(`\n记录已写入 smoke-record.md：${passed}/${total} 通过\n`)
    if (passed !== total) process.exitCode = 1
  } finally {
    client?.close()
    // Windows：按进程树杀掉 npm → cargo → exe 链
    if (child.pid) {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { shell: true, stdio: 'ignore' })
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
