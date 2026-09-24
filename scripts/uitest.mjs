#!/usr/bin/env node
/**
 * UI 自动化测试：直接驱动「打包产物 exe」的 WebView2 完成端到端验证。
 *
 * 原理：给 exe 注入 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=N
 * --headless=new，WebView2 会开放 CDP 端点，脚本用纯 Node（fetch + WebSocket）接管页面，
 * 既能读真实 DOM，也能派发事件驱动真实交互。
 *
 * 为什么不用 playwright：本项目要求内网离线可构建，多一个测试框架就多一处网络依赖；
 * 而 CDP 是 WebView2 自带能力，零依赖即可完成同样的验证。验的又是最终产物本身，
 * 比在浏览器里测 dev server 更接近真实。
 *
 * 用法：node scripts/uitest.mjs [--keep]
 *   --keep   测试结束后保留沙箱目录，便于事后查看落盘产物
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { attachPage, sleep, waitFor as waitUntil, } from './lib/cdp.mjs'

// node:sqlite 是 Node 22 内置模块，用 createRequire 引入以避开 ESM 无 require 的限制
const require = createRequire(import.meta.url)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
const appDataDir = join(process.env.APPDATA ?? root, 'com.taowd.hello-tauri')
const bootstrapFile = join(appDataDir, 'bootstrap.json')

// ---------------------------------------------------------------- 测试框架

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  const mark = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'
  process.stdout.write(`  ${mark} ${name}${detail ? ` \x1b[90m— ${detail}\x1b[0m` : ''}\n`)
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

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function section(title) {
  process.stdout.write(`\n\x1b[36m▸ ${title}\x1b[0m\n`)
}

/**
 * 等布尔条件成立。
 *
 * 底层 waitUntil 把 `null/undefined` 视为未满足、其余视为已满足 —— 这样「等到值为 false」
 * 这类条件才能正确表达。但多数等待写的是布尔表达式，直接传 false 会被当成「已满足」，
 * 所以这里把 `false` 归一到 null（= 未满足），**其余值原样返回**（调用方常需要拿到检查结果本身，
 * 例如分页文案、行数据对象，不能统一压成 true）。
 */
function waitFor(check, options) {
  return waitUntil(async () => {
    const value = await check()
    return value === false ? null : value
  }, options)
}

// ------------------------------------------------- 页面侧求值（统一封装）

/**
 * 页面侧辅助函数，一次性挂到 globalThis（带幂等守卫）。
 *
 * 不能每次求值都用 `const norm = ...` 重新注入 —— 那是全局作用域声明，
 * 第二次求值会抛 "Identifier 'norm' has already been declared"。
 * 挂成 globalThis 属性后，后续任何作用域都能直接引用裸名。
 */
const INSTALL_HELPERS = `
  if (!globalThis.__htReady) {
    globalThis.__htReady = true;
    globalThis.norm = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    globalThis.$$ = (sel) => [...document.querySelectorAll(sel)];
    globalThis.$ = (sel) => document.querySelector(sel);
    // Vue 的 v-model 监听 input 事件，直接改 .value 不会触发；必须走原生 setter + 派发
    globalThis.setInput = (el, value) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    globalThis.click = (el) => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    };
    // 本地资源：同源 / file / data / blob 都算本地，其余视为外链（CDN 禁令检查用）
    globalThis.isLocalUrl = (url) => {
      try {
        const u = new URL(url, location.href);
        return u.origin === location.origin || ['file:', 'data:', 'blob:', 'about:'].includes(u.protocol);
      } catch { return false; }
    };
  }
  true;
`

/**
 * 执行一段页面侧脚本（可含 return），自动包 IIFE。
 *
 * 每次都前置注入辅助函数：CDP 的 JS 执行上下文会在页面加载/导航时被销毁重建，
 * 只注入一次会在导航后丢失（表现为 ReferenceError: $$ is not defined）。
 * 注入体自带幂等守卫，重复执行没有额外开销。
 *
 * 顶层 return 是语法错误，必须包 IIFE 才允许提前返回。
 */
function act(client, body) {
  return client.evaluate(`${INSTALL_HELPERS}\n(() => {\n${body}\n})()`)
}

/** 执行脚本并把返回值读回（走 JSON 通道，规避序列化差异） */
async function query(client, body) {
  const raw = await act(client, `return JSON.stringify((() => {\n${body}\n})())`)
  return raw === undefined || raw === null ? undefined : JSON.parse(raw)
}

/** 等某个路由就位：标题与激活态同时对上才算切换完成（页面有 out-in 过渡） */
async function gotoNav(client, label) {
  await act(client, `
    const btn = $$('.rail__item').find((el) => norm(el).includes(${JSON.stringify(label)}));
    if (!btn) throw new Error('未找到导航项：${label}');
    click(btn);
    return true;
  `)
  await waitFor(async () => {
    const state = await query(client, `
      return { h1: norm($('.page-title h1')), active: norm($('.rail__item.is-active')) };
    `)
    return state.h1 === label && state.active.includes(label) ? state : null
  }, { label: `进入「${label}」`, timeoutMs: 8000 })
}

/**
 * 按表头文字定位数据列的下标。
 *
 * 不硬编码列下标，也不靠弱选择器（`.cell .num` 会先命中编号列的 `num muted`）——
 * 列顺序一改，硬编码的下标会静默指错列，测试却照样通过。
 */
async function columnIndex(client, header) {
  const index = await query(client, `
    const ths = $$('.el-table__header th');
    const i = ths.findIndex((el) => norm(el).includes(${JSON.stringify(header)}));
    if (i < 0) throw new Error('未找到表头：${header}');
    return i;
  `)
  assert(typeof index === 'number' && index >= 0, `表头「${header}」下标异常：${index}`)
  return index
}

/** 读指定行、指定表头列的文字 */
function readCell(client, headerIndex, rowMatcher, column) {
  return act(client, `
    const row = $$('.el-table__body tbody tr').find((tr) => norm(tr.querySelector('.cell-name')) ${rowMatcher});
    if (!row) throw new Error('未找到目标行');
    const cell = row.querySelectorAll('td')[${column}];
    return cell ? norm(cell) : null;
  `)
}

// ---------------------------------------------------------------- 环境准备

/** 找到打包产物；不存在直接失败，UI 测试的验证对象就是它 */
function findExe() {
  const releaseDir = join(root, 'release')
  if (!existsSync(releaseDir)) throw new Error('release/ 不存在，请先执行 npm run pack')
  const exe = readdirSync(releaseDir)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .map((name) => join(releaseDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (!exe) throw new Error('release/ 下没有 exe，请先执行 npm run pack')
  return exe
}

/**
 * 备份并接管 bootstrap.json，把数据根指向沙箱目录。
 * 不这么做的话，验证会写进用户真实数据目录，把数据搅乱。
 */
function installBootstrap(dataDir) {
  const backup = existsSync(bootstrapFile) ? readFileSync(bootstrapFile, 'utf8') : null
  mkdirSync(appDataDir, { recursive: true })
  writeFileSync(bootstrapFile, JSON.stringify({ dataDir }, null, 2), 'utf8')
  return backup
}

function restoreBootstrap(backup) {
  if (backup === null) rmSync(bootstrapFile, { force: true })
  else writeFileSync(bootstrapFile, backup, 'utf8')
}

/**
 * 按镜像名清掉残留进程。shell:false —— 见下方 killTree 的说明。
 */
function killByName(image) {
  spawnSync('taskkill', ['/F', '/IM', image], { stdio: 'ignore', windowsHide: true })
}

/**
 * 杀进程树。必须 shell:false：Windows 下 shell:true 会经 cmd.exe /c 重新分词，
 * 参数里出现空格时会被拆成多个（tasklist 的 `/FI "IMAGENAME eq x"` 就因此报错）。
 */
function killTree(pid) {
  if (!pid) return
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

/** 启动 exe 并挂上 CDP 调试端口 */
function launch(exe, port) {
  const child = spawn(exe, [], {
    cwd: dirname(exe),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      // --headless=new 是必需的：非交互会话下 WebView2 无法创建可见窗口，
      // 不加它进程会静默存活但永远起不来 WebView2，调试端口永不监听。
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --headless=new`,
    },
  })
  child.unref()
  return child.pid
}

/**
 * 起一个 exe 实例，连上 CDP，跑 body，然后关掉。
 * 每次换端口，避免 TIME_WAIT 复用导致连到已死实例。
 */
async function session(exe, body) {
  const port = 19200 + Math.floor(Math.random() * 700)
  // 清场：残留实例与 msedgewebview2.exe 都会独占 user-data 目录，
  // 导致新实例 WebView2 初始化静默失败 —— 这是最隐蔽的坑。
  killByName(basename(exe))
  killByName('msedgewebview2.exe')
  await sleep(1200)

  const pid = launch(exe, port)
  let client
  try {
    let attached
    try {
      attached = await attachPage(port, { timeoutMs: 40000 })
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}\n` +
          '  排查：1) 是否有残留 msedgewebview2.exe 独占 user-data 目录；' +
          '2) exe 是否为 custom-protocol 生产构建（dev 构建不内嵌前端资源）。',
      )
    }
    client = attached.client
    await client.evaluate(INSTALL_HELPERS)
    // 导航项出现即代表 Vue 已挂载、App.vue onMounted 已跑
    await waitFor(() => client.evaluate("document.querySelectorAll('.rail__item').length >= 4"), {
      label: '应用挂载',
      timeoutMs: 20000,
    })
    return await body(client, port)
  } finally {
    client?.close()
    killTree(pid)
    killByName('msedgewebview2.exe')
    await sleep(800)
  }
}

// ---------------------------------------------------------------- 落盘校验

function openDb(sandboxRoot) {
  const dbFile = join(sandboxRoot, 'data', 'app.db')
  assert(existsSync(dbFile), `数据库文件不存在：${dbFile}`)
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(dbFile, { readOnly: true })
}

/** 直接读 SQLite 真值：运行时写入必须能在库里查到，DOM 显示不算数 */
function readRecords(sandboxRoot) {
  const db = openDb(sandboxRoot)
  try {
    return db.prepare('SELECT id, name, category, status, amount, owner, created_at FROM records ORDER BY id').all()
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- 功能用例

async function runFunctional(client, sandboxRoot) {
  // ---- 1. 首屏骨架 ----
  section('1. 首屏与布局渲染')

  await check('页面标题为 Hello-Tauri', async () => {
    const title = await client.evaluate('document.title')
    assertEqual(title, 'Hello-Tauri', 'title')
    return title
  })

  await check('四个导航项齐全且顺序正确', async () => {
    const items = await query(client, `return $$('.rail__item').map((el) => norm(el));`)
    assertEqual(items.join(','), '概览,数据管理,配置,关于', '导航项')
    return items.join(' / ')
  })

  await check('图标为内联 SVG（非字体图标 / 非图片）', async () => {
    const stats = await query(client, `
      return { svg: $$('svg').length, img: $$('img').length, iconFont: $$('i.el-icon').length };
    `)
    assert(stats.svg >= 15, `SVG 数量偏少：${stats.svg}`)
    assertEqual(stats.img, 0, '<img> 数量')
    assertEqual(stats.iconFont, 0, '字体图标数量')
    return `svg ${stats.svg} 个`
  })

  await check('无任何外部网络资源引用（CDN 禁令）', async () => {
    const external = await query(client, `
      return [...$$('script[src]'), ...$$('link[href]'), ...$$('img[src]')]
        .map((el) => el.src || el.href)
        .filter((url) => !isLocalUrl(url));
    `)
    assertEqual(external.length, 0, `外部资源数（${external.slice(0, 3).join(', ')}）`)
    return '0 个外链'
  })

  await check('运行模式标识为桌面模式', async () => {
    const text = await act(client, `return norm($('.rail__env'));`)
    assert(text.includes('桌面模式'), `实际：${text}`)
    return text
  })

  // ---- 2. 路由 ----
  section('2. 路由与页面可达性')

  for (const [label, marker] of [
    ['概览', '数据与运行状态一览'],
    ['数据管理', '业务记录的检索与维护'],
    ['配置', '界面偏好与存储位置'],
    ['关于', '版本信息与技术构成'],
  ]) {
    await check(`导航到「${label}」页面`, async () => {
      await gotoNav(client, label)
      const caption = await act(client, `return norm($('.page-title .caption'));`)
      assertEqual(caption, marker, '页面副标题')
      return caption
    })
  }

  // ---- 3. 表格渲染与筛选 ----
  section('3. 数据管理页 —— 渲染与筛选')

  await gotoNav(client, '数据管理')
  await waitFor(() => client.evaluate("document.querySelectorAll('.el-table__body tbody tr').length > 0"), {
    label: '表格首屏数据',
    timeoutMs: 10000,
  })

  await check('表格渲染记录且编号为 #N 格式', async () => {
    const idCol = await columnIndex(client, '编号')
    const info = await query(client, `
      const rows = $$('.el-table__body tbody tr');
      const first = rows[0]?.querySelectorAll('td')[${idCol}];
      return { rows: rows.length, firstId: norm(first) };
    `)
    assert(info.rows >= 5, `行数偏少：${info.rows}`)
    assert(/^#\d+$/.test(info.firstId), `编号格式不符：${info.firstId}`)
    return `${info.rows} 行，首行 ${info.firstId}`
  })

  await check('分页脚显示总数区间', async () => {
    const meta = await act(client, `return norm($('.pager__meta'));`)
    assert(/^\d+–\d+ \/ \d+$/.test(meta), `格式不符：${meta}`)
    return meta
  })

  const baseline = { count: 0 }
  await check('读取基线记录数并与 SQLite 交叉校验', async () => {
    baseline.count = await act(client, `return Number(norm($('.pager__meta')).split('/').pop().trim());`)
    assert(baseline.count > 0, '总数应大于 0')
    const dbRows = readRecords(sandboxRoot)
    assertEqual(dbRows.length, baseline.count, 'app.db 记录数与 DOM 总数')
    return `${baseline.count} 条（DOM 与 app.db 一致）`
  })

  await check('关键词搜索即时过滤', async () => {
    await act(client, `setInput($('.toolbar__search input'), '日志采集'); return true;`)
    await waitFor(async () => {
      const n = await client.evaluate("document.querySelectorAll('.el-table__body tbody tr').length")
      return n === 1 ? n : null
    }, { label: '搜索结果收敛为 1 行', timeoutMs: 6000 })
    const name = await act(client, `return norm($('.el-table__body tbody tr .cell-name'));`)
    assert(name.includes('日志采集'), `结果不符：${name}`)
    const meta = await act(client, `return norm($('.pager__meta'));`)
    assertEqual(meta, '1–1 / 1', '筛选后分页文案')
    return `${name}（1 行）`
  })

  await check('筛选激活时出现「清除筛选」入口', async () => {
    const text = await act(client, `return norm($('.toolbar__clear'));`)
    assert(text.includes('清除筛选'), `实际：${text}`)
    return text
  })

  await check('清除筛选后恢复全量', async () => {
    await act(client, `click($('.toolbar__clear')); return true;`)
    await waitFor(async () => {
      const meta = await act(client, `return norm($('.pager__meta'));`)
      return meta.endsWith(`/ ${baseline.count}`) ? meta : null
    }, { label: '恢复全量', timeoutMs: 6000 })
    const gone = await client.evaluate("!document.querySelector('.toolbar__clear')")
    assert(gone, '清除筛选按钮应消失')
    return `回到 ${baseline.count} 条`
  })

  await check('搜索无结果时展示空状态', async () => {
    await act(client, `setInput($('.toolbar__search input'), '不存在的记录XYZ'); return true;`)
    await waitFor(() => client.evaluate("Boolean(document.querySelector('.el-table__empty-block .empty'))"), {
      label: '空状态出现', timeoutMs: 6000,
    })
    const hint = await act(client, `return norm($('.el-table__empty-block .empty p'));`)
    assertEqual(hint, '没有匹配的记录', '空状态文案')
    await act(client, `
      const btn = $('.toolbar__clear') ?? $('.el-table__empty-block .empty__clear');
      if (btn) click(btn);
      return true;
    `)
    await waitFor(() => client.evaluate("document.querySelectorAll('.el-table__body tbody tr').length > 1"), {
      label: '恢复列表', timeoutMs: 6000,
    })
    return hint
  })

  // ---- 4. 分页 ----
  section('4. 分页交互')

  await check('翻到第 2 页并切回第 1 页', async () => {
    const first = await act(client, `return norm($('.pager__meta'));`)
    await act(client, `click($('.el-pagination .btn-next')); return true;`)
    const second = await waitFor(async () => {
      const meta = await act(client, `return norm($('.pager__meta'));`)
      return meta !== first ? meta : null
    }, { label: '翻页生效', timeoutMs: 6000 })
    assert(second.startsWith('11–'), `第 2 页区间异常：${second}`)
    await act(client, `click($('.el-pagination .btn-prev')); return true;`)
    await waitFor(async () => {
      const meta = await act(client, `return norm($('.pager__meta'));`)
      return meta === first ? meta : null
    }, { label: '回到第 1 页', timeoutMs: 6000 })
    return `${first} → ${second} → ${first}`
  })

  // ---- 5. 新增 ----
  section('5. 新增记录（DOM + SQLite 双向校验）')

  const created = { name: `自动化验证-${Date.now() % 100000}`, owner: '验证机器人', amount: 777 }

  await check('打开新增对话框', async () => {
    await act(client, `
      const btn = $$('.el-button').find((el) => norm(el) === '新增');
      if (!btn) throw new Error('未找到「新增」按钮');
      click(btn);
      return true;
    `)
    await waitFor(() => client.evaluate("Boolean(document.querySelector('.el-dialog .el-form'))"), {
      label: '对话框出现', timeoutMs: 8000,
    })
    const title = await act(client, `return norm($('.el-dialog__title'));`)
    assertEqual(title, '新增记录', '对话框标题')
    const labels = await query(client, `return $$('.el-dialog .el-form-item__label').map((el) => norm(el));`)
    assertEqual(labels.join(','), '名称,分类,负责人,状态,金额', '表单项')
    return title
  })

  await check('必填校验拦截空表单', async () => {
    await act(client, `
      const btn = $$('.el-dialog__footer .el-button').find((el) => norm(el).includes('创建记录'));
      click(btn);
      return true;
    `)
    await waitFor(() => client.evaluate("document.querySelectorAll('.el-form-item__error').length > 0"), {
      label: '校验错误提示', timeoutMs: 8000,
    })
    const errors = await query(client, `return $$('.el-form-item__error').map((el) => norm(el));`)
    assert(errors.length >= 2, `错误提示偏少：${errors.length}`)
    const stillOpen = await client.evaluate("Boolean(document.querySelector('.el-dialog .el-form'))")
    assert(stillOpen, '校验失败时对话框不应关闭')
    return errors.join('；')
  })

  await check('填写表单并提交', async () => {
    await act(client, `
      const items = $$('.el-dialog .el-form-item');
      const byLabel = (text) => items.find((el) => norm(el.querySelector('.el-form-item__label')).includes(text));
      setInput(byLabel('名称').querySelector('input'), ${JSON.stringify(created.name)});
      setInput(byLabel('负责人').querySelector('input'), ${JSON.stringify(created.owner)});
      setInput(byLabel('金额').querySelector('input'), '${created.amount}');
      return true;
    `)
    await act(client, `
      const btn = $$('.el-dialog__footer .el-button').find((el) => norm(el).includes('创建记录'));
      click(btn);
      return true;
    `)
    await waitFor(() => client.evaluate("!document.querySelector('.el-dialog .el-form')"), {
      label: '对话框关闭', timeoutMs: 10000,
    })
    return created.name
  })

  await check('DOM 中出现新记录且总数 +1', async () => {
    const state = await waitFor(async () => {
      const s = await query(client, `
        return { meta: norm($('.pager__meta')), first: norm($('.el-table__body tbody tr .cell-name')) };
      `)
      return s.meta.endsWith(`/ ${baseline.count + 1}`) ? s : null
    }, { label: '总数递增', timeoutMs: 8000 })
    assertEqual(state.first, created.name, '首行名称')
    return `总数 ${baseline.count} → ${baseline.count + 1}，首行 ${state.first}`
  })

  await check('SQLite 落盘：新记录真的写进了 app.db', async () => {
    const rows = readRecords(sandboxRoot)
    assertEqual(rows.length, baseline.count + 1, 'app.db 记录数')
    const found = rows.find((row) => row.name === created.name)
    assert(found, `app.db 中未找到「${created.name}」`)
    assertEqual(Number(found.amount), created.amount, '金额')
    assertEqual(found.owner, created.owner, '负责人')
    assertEqual(found.status, 'active', '状态')
    assert(/^\d{4}-\d{2}-\d{2}$/.test(found.created_at), `创建日期格式：${found.created_at}`)
    return `app.db 共 ${rows.length} 条，created_at=${found.created_at}`
  })

  // ---- 6. 编辑 ----
  section('6. 编辑记录')

  await check('编辑对话框回填原值并成功保存', async () => {
    await act(client, `
      const target = $$('.el-table__body tbody tr')
        .find((row) => norm(row.querySelector('.cell-name')) === ${JSON.stringify(created.name)});
      if (!target) throw new Error('未找到目标行');
      click([...target.querySelectorAll('.act')].find((el) => norm(el) === '编辑'));
      return true;
    `)
    await waitFor(() => client.evaluate("Boolean(document.querySelector('.el-dialog .el-form'))"), {
      label: '编辑对话框出现', timeoutMs: 8000,
    })
    const title = await act(client, `return norm($('.el-dialog__title'));`)
    assertEqual(title, '编辑记录', '对话框标题')
    // 回填校验：编辑必须带出原值，否则就是「改一条变新增一条」的经典 bug
    const prefilled = await query(client, `
      const items = $$('.el-dialog .el-form-item');
      const byLabel = (text) => items.find((el) => norm(el.querySelector('.el-form-item__label')).includes(text));
      return {
        name: byLabel('名称').querySelector('input').value,
        owner: byLabel('负责人').querySelector('input').value,
        amount: byLabel('金额').querySelector('input').value,
      };
    `)
    assertEqual(prefilled.name, created.name, '编辑框回填名称')
    assertEqual(prefilled.owner, created.owner, '编辑框回填负责人')
    assertEqual(Number(prefilled.amount), created.amount, '编辑框回填金额')

    await act(client, `
      const items = $$('.el-dialog .el-form-item');
      const byLabel = (text) => items.find((el) => norm(el.querySelector('.el-form-item__label')).includes(text));
      setInput(byLabel('金额').querySelector('input'), '888');
      return true;
    `)
    await act(client, `
      const btn = $$('.el-dialog__footer .el-button').find((el) => norm(el).includes('保存修改'));
      click(btn);
      return true;
    `)
    await waitFor(() => client.evaluate("!document.querySelector('.el-dialog .el-form')"), {
      label: '对话框关闭', timeoutMs: 10000,
    })
    return `${title}，回填正确，金额改为 888`
  })

  await check('DOM 与 app.db 同步为 888', async () => {
    const amountCol = await columnIndex(client, '金额')
    const domValue = await waitFor(async () => {
      const value = await readCell(client, amountCol, `=== ${JSON.stringify(created.name)}`, amountCol)
      return value && value.includes('888') ? value : null
    }, { label: 'DOM 金额更新', timeoutMs: 8000 })
    const rows = readRecords(sandboxRoot)
    assertEqual(rows.length, baseline.count + 1, 'app.db 记录数不应变化')
    const dbRow = rows.find((row) => row.name === created.name)
    assertEqual(Number(dbRow?.amount), 888, 'app.db 金额')
    return `DOM ${domValue} / DB 888`
  })

  // ---- 7. CSV 导出 ----
  section('7. CSV 导出')

  // 导出发生在「新增 + 编辑之后、删除之前」，此刻库里应有 baseline+1 条。
  // 导出内容是**导出时刻的快照**，之后删除记录不会回改 CSV —— 这里用当时行数断言。
  const snapshot = { count: 0 }

  await check('导出当前结果为 CSV 并落盘到 exports/', async () => {
    // 先记下导出前的 CSV 快照，用于确认产生了**新文件**而不是读到上一轮的残留
    const exportsDir = join(sandboxRoot, 'exports')
    const before = existsSync(exportsDir)
      ? new Set(readdirSync(exportsDir).filter((n) => n.endsWith('.csv')))
      : new Set()

    await act(client, `
      const btn = $$('.el-button').find((el) => norm(el) === '导出 CSV');
      if (!btn) throw new Error('未找到导出按钮');
      click(btn);
      return true;
    `)
    const file = await waitFor(() => {
      if (!existsSync(exportsDir)) return null
      const fresh = readdirSync(exportsDir).filter((n) => n.endsWith('.csv') && !before.has(n))
      return fresh.length ? join(exportsDir, fresh.sort().pop()) : null
    }, { label: 'CSV 文件生成', timeoutMs: 12000 })
    const content = readFileSync(file, 'utf8')
    assert(content.startsWith('\uFEFF'), '缺少 UTF-8 BOM，Excel 打开中文会乱码')
    assert(content.includes('编号,名称,分类,状态,金额,负责人,创建日期'), '表头缺失或列序不符')
    assert(content.includes(created.name), '未包含新增记录')
    // 编辑后的金额必须在快照里体现，否则导出的是旧值
    assert(content.includes('888'), '未反映编辑后的金额')
    assert(content.includes('\r\n'), '未使用 CRLF 换行')
    const dataLines = content.replace('\uFEFF', '').trim().split('\r\n').length - 1
    assertEqual(dataLines, baseline.count + 1, 'CSV 数据行数')
    snapshot.count = dataLines
    snapshot.file = file
    return `${basename(file)}，${dataLines} 行`
  })

  // ---- 8. 主题与侧栏 ----
  section('8. 主题与布局交互')

  await check('切换深色主题写入 html.dark', async () => {
    const readDark = () => client.evaluate("document.documentElement.classList.contains('dark')")
    const before = await readDark()
    await act(client, `click($('.topbar__theme')); return true;`)
    await waitFor(async () => {
      const now = await readDark()
      return now !== before ? now : null
    }, { label: '主题类名切换', timeoutMs: 6000 })
    const after = await readDark()
    assert(after !== before, '主题未切换')
    // 切回来，避免污染后续用例。这里必须等待「值变回 before」，
    // before 可能是 false —— 所以不能依赖返回值的真假，用显式比较。
    await act(client, `click($('.topbar__theme')); return true;`)
    await waitFor(async () => ((await readDark()) === before ? 'restored' : null), {
      label: '主题还原', timeoutMs: 6000,
    })
    const restored = await readDark()
    assertEqual(restored, before, '主题未还原')
    return `dark ${before} → ${after} → ${restored}`
  })

  await check('折叠侧栏切换 shell--collapsed', async () => {
    const readCollapsed = () =>
      client.evaluate("document.querySelector('.shell').classList.contains('shell--collapsed')")
    const before = await readCollapsed()
    await act(client, `click($('.rail__toggle')); return true;`)
    await waitFor(async () => {
      const now = await readCollapsed()
      return now !== before ? now : null
    }, { label: '折叠状态切换', timeoutMs: 6000 })
    const after = await readCollapsed()
    assert(after !== before, '折叠状态未变化')
    await act(client, `click($('.rail__toggle')); return true;`)
    await waitFor(async () => ((await readCollapsed()) === before ? 'restored' : null), {
      label: '折叠状态还原', timeoutMs: 6000,
    })
    return `collapsed ${before} → ${after} → ${before}`
  })

  // ---- 9. 配置页 ----
  section('9. 配置页与存储路径')

  await gotoNav(client, '配置')
  await waitFor(() => client.evaluate("Boolean(document.querySelector('.side .kv'))"), {
    label: '存储卡片出现', timeoutMs: 8000,
  })

  /** 存储卡片是 <dl>：dt/dd 按 DOM 顺序一一对应，先精确匹配 dt 再取同序 dd */
  const readStorageCard = () =>
    query(client, `
      const dts = $$('.side .kv dt');
      const dd = $$('.side .kv dd');
      const pick = (label) => {
        const i = dts.findIndex((el) => norm(el) === label);
        return i >= 0 && dd[i] ? norm(dd[i]) : null;
      };
      return { dataDir: pick('数据目录'), config: pick('配置文件'), logs: pick('日志目录') };
    `)

  await check('存储根展示为沙箱目录（bootstrap 指针生效）', async () => {
    const card = await readStorageCard()
    assertEqual(card.dataDir, sandboxRoot, '数据目录')
    return card.dataDir
  })

  await check('配置文件与日志目录路径正确', async () => {
    const card = await readStorageCard()
    assertEqual(card.config, join(sandboxRoot, 'config', 'config.json'), '配置文件路径')
    assertEqual(card.logs, join(sandboxRoot, 'logs'), '日志目录路径')
    return card.config
  })

  await check('桌面模式下存储操作按钮可用（非禁用）', async () => {
    const buttons = await query(client, `
      return $$('.side__actions .link').map((el) => ({ text: norm(el), disabled: el.disabled }));
    `)
    assert(buttons.length >= 2, '按钮数量不足')
    assert(buttons.every((item) => !item.disabled), `存在被禁用按钮：${JSON.stringify(buttons)}`)
    return buttons.map((item) => item.text).join(' / ')
  })

  await check('无降级告警（沙箱目录可写，不应回退）', async () => {
    const alert = await client.evaluate("Boolean(document.querySelector('.el-alert'))")
    assertEqual(alert, false, '出现了存储降级告警')
    return '无告警'
  })

  // ---- 10. 删除 ----
  section('10. 删除记录（DOM + SQLite 双向校验）')

  await check('删除刚创建的记录', async () => {
    await gotoNav(client, '数据管理')
    await waitFor(() => client.evaluate("document.querySelectorAll('.el-table__body tbody tr').length > 0"), {
      label: '表格就绪', timeoutMs: 8000,
    })
    // 先搜索定位，保证目标行一定在当前页
    await act(client, `setInput($('.toolbar__search input'), ${JSON.stringify(created.name)}); return true;`)
    await waitFor(() => client.evaluate("document.querySelectorAll('.el-table__body tbody tr').length === 1"), {
      label: '定位到目标记录', timeoutMs: 6000,
    })
    await act(client, `
      const target = $$('.el-table__body tbody tr')[0];
      click([...target.querySelectorAll('.act')].find((el) => norm(el) === '删除'));
      return true;
    `)
    await waitFor(() => client.evaluate("Boolean(document.querySelector('.el-message-box'))"), {
      label: '确认框出现', timeoutMs: 8000,
    })
    const confirmText = await act(client, `return norm($('.el-message-box__message'));`)
    assert(confirmText.includes(created.name), `确认文案未含目标名：${confirmText}`)
    await act(client, `
      const btn = $$('.el-message-box__btns .el-button').find((el) => norm(el) === '删除');
      if (!btn) throw new Error('未找到确认删除按钮');
      click(btn);
      return true;
    `)
    await waitFor(() => client.evaluate("!document.querySelector('.el-message-box')"), {
      label: '确认框关闭', timeoutMs: 8000,
    })
    return confirmText.slice(0, 30)
  })

  await check('删除后空状态生效，清除筛选总数回落基线', async () => {
    await waitFor(() => client.evaluate("Boolean(document.querySelector('.el-table__empty-block .empty'))"), {
      label: '空状态出现', timeoutMs: 8000,
    })
    await act(client, `
      const btn = $('.toolbar__clear') ?? $('.el-table__empty-block .empty__clear');
      if (btn) click(btn);
      return true;
    `)
    const meta = await waitFor(async () => {
      const value = await act(client, `return norm($('.pager__meta'));`)
      return value.endsWith(`/ ${baseline.count}`) ? value : null
    }, { label: '总数回落', timeoutMs: 8000 })
    return meta
  })

  await check('app.db 记录数回到基线且目标已移除', async () => {
    const rows = readRecords(sandboxRoot)
    assertEqual(rows.length, baseline.count, 'app.db 记录数')
    assert(!rows.some((row) => row.name === created.name), '目标记录仍存在于 app.db')
    return `${rows.length} 条（已移除）`
  })

  return { baselineCount: baseline.count, snapshotCount: snapshot.count }
}

/** 落盘产物与配置校验 */
async function verifyArtifacts(sandboxRoot, baselineCount, snapshotCount) {
  section('11. 落盘产物与配置校验')

  await check('目录结构为 config/ data/ logs/ exports/', async () => {
    const dirs = readdirSync(sandboxRoot).sort()
    for (const expected of ['config', 'data', 'logs', 'exports']) {
      assert(dirs.includes(expected), `缺少目录 ${expected}（实际：${dirs.join(', ')}）`)
    }
    return dirs.join(', ')
  })

  await check('config.json 为合法 JSON 且含完整配置项', async () => {
    const file = join(sandboxRoot, 'config', 'config.json')
    assert(existsSync(file), 'config.json 不存在')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    for (const key of ['theme', 'pageSize', 'autoSave', 'sidebarCollapsed', 'defaultRoute']) {
      assert(key in parsed, `缺少配置项 ${key}`)
    }
    return Object.keys(parsed).join(', ')
  })

  await check('app.db 表结构与迁移记录完整', async () => {
    const db = openDb(sandboxRoot)
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => row.name)
      assert(tables.includes('_migrations'), '缺少 _migrations 表')
      assert(tables.includes('records'), '缺少 records 表')
      const versions = db.prepare('SELECT version, description FROM _migrations ORDER BY version').all()
      assertEqual(versions.length, 1, '迁移条数')
      assertEqual(versions[0].version, 1, '迁移版本号')
      assertEqual(versions[0].description, 'create_records', '迁移描述')

      const columns = db.prepare('PRAGMA table_info(records)').all().map((row) => row.name)
      const expected = ['id', 'name', 'category', 'status', 'amount', 'owner', 'created_at']
      assertEqual(columns.join(','), expected.join(','), 'records 列定义')

      const journal = db.prepare('PRAGMA journal_mode').get()
      assertEqual(String(journal.journal_mode).toLowerCase(), 'wal', 'journal 模式')
      return `迁移 v${versions[0].version}，${columns.length} 列，WAL`
    } finally {
      db.close()
    }
  })

  await check('记录数与用例结束状态一致', async () => {
    const rows = readRecords(sandboxRoot)
    assertEqual(rows.length, baselineCount, 'app.db 记录数')
    return `${rows.length} 条`
  })

  await check('日志文件按本地日期命名且含时间戳', async () => {
    const logsDir = join(sandboxRoot, 'logs')
    const files = readdirSync(logsDir).filter((name) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    assert(files.length > 0, `未找到日志文件（实际：${readdirSync(logsDir).join(', ')}）`)
    const latest = files.sort().pop()
    const lines = readFileSync(join(logsDir, latest), 'utf8').trim().split('\n')
    assert(
      lines.every((line) => /^\d{2}:\d{2}:\d{2}\.\d{3} \[(INFO|WARN|ERROR)\]/.test(line)),
      `日志行格式不符：${lines[0]}`,
    )
    // 本地时区校验：东八区本地时间与 UTC 差 8 小时。
    // 若日志小时数恒等于 UTC 小时数，说明实现误用了 UTC（Windows GetLocalTime 才是对的）。
    const hour = Number(/^(\d{2}):/.exec(lines[lines.length - 1])[1])
    const now = new Date()
    if (now.getHours() !== now.getUTCHours()) {
      assert(hour !== now.getUTCHours(), `日志小时数疑似 UTC：${hour}（本地 ${now.getHours()}，UTC ${now.getUTCHours()}）`)
    }
    return `${latest}，${lines.length} 行`
  })

  await check('未写入旧版 table.json（已迁移到 SQLite）', async () => {
    const legacy = join(sandboxRoot, 'data', 'table.json')
    assert(!existsSync(legacy), '沙箱中不应出现 table.json')
    return '无遗留 JSON 快照'
  })

  await check('CSV 是导出时刻的快照（不受后续删除影响）', async () => {
    const dir = join(sandboxRoot, 'exports')
    const file = join(dir, readdirSync(dir).filter((n) => n.endsWith('.csv')).sort().pop())
    const lines = readFileSync(file, 'utf8').replace('\uFEFF', '').trim().split('\r\n').slice(1)
    assertEqual(lines.length, snapshotCount, 'CSV 行数应等于导出时刻的记录数')
    // 快照里应包含已删除的那条记录 —— 这正是「快照」的语义
    assert(lines.some((line) => line.includes('自动化验证-')), 'CSV 应包含导出时刻存在的记录')
    // 数值列可解析
    const amounts = lines.map((line) => Number(line.split(',')[4]))
    assert(amounts.every((n) => Number.isFinite(n)), 'CSV 金额列存在非数字')
    return `${lines.length} 行（导出快照，含已删除记录）`
  })
}

/**
 * 降级分支验证：把 bootstrap 指向一个「被文件占位的路径」，
 * probe_writable 的 create_dir_all 必然失败，据此验证回退到 %APPDATA% 且应用仍能启动。
 * 这条分支的价值在于「程序必须永远能启动」—— 存储不可用不是致命错误。
 */
async function runFallback(exe, blockerFile) {
  section('12. 存储降级分支（首选目录不可写）')

  await check('首选目录不可写时回退到 %APPDATA% 并给出告警', async () => {
    writeFileSync(blockerFile, 'occupied', 'utf8')
    installBootstrap(blockerFile)

    return session(exe, async (client) => {
      await gotoNav(client, '配置')
      await waitFor(() => client.evaluate("Boolean(document.querySelector('.el-alert'))"), {
        label: '降级告警出现', timeoutMs: 12000,
      })
      const alert = await query(client, `
        return { title: norm($('.el-alert__title')), desc: norm($('.el-alert__description')) };
      `)
      assert(alert.title.includes('回退'), `告警标题不符：${alert.title}`)
      assert(alert.desc.includes('不可用'), `告警描述未说明原因：${alert.desc}`)

      const rootText = await query(client, `
        const dts = $$('.side .kv dt');
        const dd = $$('.side .kv dd');
        const i = dts.findIndex((el) => norm(el) === '数据目录');
        return i >= 0 && dd[i] ? norm(dd[i]) : null;
      `)
      assert(rootText !== blockerFile, `未发生回退，仍是 ${rootText}`)
      assert(/appdata/i.test(rootText), `回退目标异常：${rootText}`)
      return `告警「${alert.title}」`
    })
  })
}

/** 重启持久化：上次会话写入的数据应在下次启动时仍然存在 */
async function runPersistence(exe, sandboxRoot, baselineCount) {
  section('13. 重启后数据持久化')

  await check('重启后记录数不变（SQLite 持久化生效）', async () => {
    return session(exe, async (client) => {
      await gotoNav(client, '数据管理')
      const meta = await waitFor(async () => {
        const value = await act(client, `return norm($('.pager__meta'));`)
        return value ? value : null
      }, { label: '分页文案就绪', timeoutMs: 10000 })
      assert(meta.endsWith(`/ ${baselineCount}`), `重启后总数异常：${meta}（期望 ${baselineCount}）`)
      return meta
    })
  })

  await check('重启后配置回填一致（config.json 生效）', async () => {
    return session(exe, async (client) => {
      const config = JSON.parse(readFileSync(join(sandboxRoot, 'config', 'config.json'), 'utf8'))
      await gotoNav(client, '配置')
      const state = await query(client, `
        const items = $$('.el-form .el-form-item');
        const byLabel = (text) => items.find((el) => norm(el.querySelector('.el-form-item__label')).includes(text));
        const title = byLabel('应用标题')?.querySelector('input');
        return { title: title ? title.value : null, dark: document.documentElement.classList.contains('dark') };
      `)
      assert(state.title, '应用标题未回填')
      assertEqual(state.dark, config.theme === 'dark', '主题类名与配置一致')
      return `标题「${state.title}」，主题 ${config.theme}`
    })
  })
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const started = Date.now()
  process.stdout.write('\n\x1b[1m═══ Hello-Tauri UI 自动化测试（驱动真实打包产物）═══\x1b[0m\n')

  const exe = findExe()
  const sizeMb = (statSync(exe).size / 1024 / 1024).toFixed(2)
  process.stdout.write(`\x1b[90m产物：${exe}（${sizeMb} MB）\x1b[0m\n`)

  const blockerFile = join(root, 'target', 'uitest-blocker.tmp')
  // 沙箱根每次运行唯一，无需删除旧目录即可拿到可预测基线（记录数从种子开始）。
  // 刻意不用「原地清空」：递归删几十个文件会触发运行环境的批量删除保护，
  // 在 finally 里抛出未捕获异常会连带吞掉整份测试报告。
  const sandboxRoot = join(root, 'target', `uitest-sandbox-${Date.now()}`)
  mkdirSync(sandboxRoot, { recursive: true })

  const backup = installBootstrap(sandboxRoot)
  let fatal = null
  let summary = { baselineCount: 0, snapshotCount: 0 }
  try {
    summary = await session(exe, (client) => runFunctional(client, sandboxRoot))
    await verifyArtifacts(sandboxRoot, summary.baselineCount, summary.snapshotCount)
    await runFallback(exe, blockerFile)
    // 降级用例改写了 bootstrap，恢复后再验持久化
    installBootstrap(sandboxRoot)
    await runPersistence(exe, sandboxRoot, summary.baselineCount)
  } catch (error) {
    fatal = error
    process.stdout.write(`\n\x1b[31m致命错误：${error instanceof Error ? error.message : error}\x1b[0m\n`)
    if (error instanceof Error && error.stack) {
      process.stdout.write(`\x1b[90m${error.stack.split('\n').slice(1, 4).join('\n')}\x1b[0m\n`)
    }
  } finally {
    // 清理一律 best-effort，且失败时保持静默：
    // 受限环境会拦截大批量递归删除，这不是测试失败，不该污染报告与退出码。
    // 备用的 bootstrap.json 必须还原 —— 否则会污染用户真实数据目录。
    try {
      restoreBootstrap(backup)
    } catch (error) {
      process.stdout.write(
        `\x1b[31m警告：bootstrap.json 还原失败（${bootstrapFile}），请手工检查：` +
          `${error instanceof Error ? error.message : error}\x1b[0m\n`,
      )
    }
    if (!keep) {
      try {
        rmSync(blockerFile, { force: true })
        rmSync(sandboxRoot, { recursive: true, force: true })
      } catch {
        // 沙箱遗留在 target/ 下（已 gitignore），不影响结论
      }
    }
  }

  // ---------------- 报告 ----------------
  const passed = results.filter((item) => item.ok).length
  const failed = results.filter((item) => !item.ok)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  process.stdout.write('\n\x1b[1m═══ 测试报告 ═══\x1b[0m\n')
  const nameWidth = Math.max(...results.map((item) => visualWidth(item.name)), 12)
  const detailWidth = 46
  process.stdout.write(`┌${'─'.repeat(nameWidth + 2)}┬────────┬${'─'.repeat(detailWidth + 2)}┐\n`)
  process.stdout.write(`│ ${pad('用例', nameWidth)} │ 结果   │ ${pad('说明', detailWidth)} │\n`)
  process.stdout.write(`├${'─'.repeat(nameWidth + 2)}┼────────┼${'─'.repeat(detailWidth + 2)}┤\n`)
  for (const item of results) {
    process.stdout.write(
      `│ ${pad(item.name, nameWidth)} │ ${item.ok ? '\x1b[32m通过\x1b[0m  ' : '\x1b[31m失败\x1b[0m  '} │ ` +
        `${pad(truncate(item.detail ?? '', detailWidth), detailWidth)} │\n`,
    )
  }
  process.stdout.write(`└${'─'.repeat(nameWidth + 2)}┴────────┴${'─'.repeat(detailWidth + 2)}┘\n`)

  process.stdout.write(
    `\n合计 ${results.length} 个用例：\x1b[32m通过 ${passed}\x1b[0m` +
      (failed.length ? `，\x1b[31m失败 ${failed.length}\x1b[0m` : '') +
      `　耗时 ${elapsed}s\n`,
  )
  if (failed.length) {
    process.stdout.write('\n\x1b[31m失败用例：\x1b[0m\n')
    for (const item of failed) process.stdout.write(`  · ${item.name}：${item.detail}\n`)
  }
  if (keep) process.stdout.write(`\n沙箱目录保留在：${sandboxRoot}\n`)

  if (fatal || failed.length) process.exit(1)
  process.stdout.write('\n\x1b[32m✔ UI 自动化测试全部通过\x1b[0m\n')
}

/** 中文占两列宽，不处理的话表格会歪 */
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

main().catch((error) => {
  process.stderr.write(`\n未捕获异常：${error?.stack ?? error}\n`)
  process.exit(1)
})