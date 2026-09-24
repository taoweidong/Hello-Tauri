/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 只用 Node 内置的 fetch + WebSocket，不引入任何第三方依赖 —— 本项目要求内网离线可构建，
 * 多一个 devDependency 就多一处网络依赖风险。
 *
 * 能力边界：Runtime.evaluate 足以完成「读 DOM + 派发事件」两件事，本项目的 UI 自动化
 * 不需要 Input.dispatchMouseEvent 那种坐标级操作。
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 轮询等待调试端点就绪。
 * exe 冷启动要解压 WebView2、初始化运行时，端口不是立刻监听的，必须轮询而不是单次探测。
 */
export async function fetchTargets(port, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = '未收到响应'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        const list = await res.json()
        if (Array.isArray(list) && list.length) return list
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(intervalMs)
  }
  throw new Error(`调试端点未就绪（127.0.0.1:${port}）：${lastError}`)
}

/** 连接一个 page target，返回请求封装。 */
export async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let seq = 0

  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    const resolver = pending.get(message.id)
    if (!resolver) return
    pending.delete(message.id)
    if (message.error) resolver.reject(new Error(`${message.error.message} (${resolver.method})`))
    else resolver.resolve(message.result)
  })

  await new Promise((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener('error', onError)
      resolve()
    }
    const onError = () => reject(new Error(`无法连接调试会话：${wsUrl}`))
    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onError, { once: true })
  })

  function send(method, params = {}, { timeoutMs = 15000 } = {}) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP 调用超时：${method}`))
      }, timeoutMs)
      pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  await send('Runtime.enable')

  /**
   * 在页面上下文求值。
   * expression 必须是一个「表达式」；多语句请自己包成 IIFE，否则语法错误会以
   * exceptionDetails 形式返回而不是抛异常，静默失败最难查。
   */
  async function evaluate(expression, { awaitPromise = true } = {}) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const text =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        '页面脚本执行异常'
      throw new Error(text.split('\n')[0])
    }
    return result.result?.value
  }

  return {
    send,
    evaluate,
    /** 求值并解析 JSON（页面侧 JSON.stringify 后返回，规避 returnByValue 的序列化限制） */
    async evalJson(body) {
      const raw = await evaluate(`JSON.stringify((() => { ${body} })())`)
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    close() {
      try {
        socket.close()
      } catch {
        /* 关闭失败无所谓，进程退出会回收 */
      }
    },
  }
}

/**
 * 轮询直到页面侧条件成立。
 *
 * 契约：check 返回 `null` / `undefined` 表示「尚未满足」，其余任何值（**含 false / 0 / 空串**）
 * 都视为「已满足」并作为结果返回。
 * 用真假判断会踩坑 —— 等待「主题类名还原为 false」这类条件时，成功值本身就是 false，
 * 用 `if (value)` 判会把成功当失败，一直等到超时。
 */
export async function waitFor(check, { timeoutMs = 10000, intervalMs = 150, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== null && value !== undefined) return value
    await sleep(intervalMs)
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）`)
}

/** 定位一个可用的页面 target（优先 tauri 页面，其次任意 page） */
export async function attachPage(port, { timeoutMs = 30000 } = {}) {
  const targets = await fetchTargets(port, { timeoutMs })
  const page =
    targets.find((item) => item.type === 'page' && /tauri\.localhost|^http/.test(item.url ?? '')) ??
    targets.find((item) => item.type === 'page')
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`未找到可调试的页面 target，现有：${targets.map((t) => t.type).join(', ')}`)
  }
  return { target: page, client: await connect(page.webSocketDebuggerUrl) }
}