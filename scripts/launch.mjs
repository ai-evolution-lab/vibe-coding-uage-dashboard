import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const appId = 'vibe-coding-usage-dashboard'
const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), '..')
const runtimeDir = path.join(projectRoot, '.cache', 'launcher')
const statePath = path.join(runtimeDir, 'server.json')
const logPath = path.join(runtimeDir, 'server.log')
const scanCache = new Map()
const scanCacheTtlMs = 10 * 60 * 1000
process.chdir(projectRoot)

function log(message) {
  console.log(`[${appId}] ${message}`)
}

function fail(message) {
  console.error(`[${appId}] ${message}`)
  process.exit(1)
}

function ensureNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  if (major < 20) {
    fail(`需要 Node.js 20+，当前版本 ${process.version}`)
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} ${args.join(' ')} 退出码 ${code ?? 'unknown'}`))
      }
    })
  })
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getProviderRoot(provider) {
  const home = os.homedir()
  if (provider === 'claude') {
    return path.join(home, '.claude')
  }
  return path.join(home, '.codex')
}

async function walkFiles(root, shouldInclude) {
  const files = []

  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      if (entry.isFile() && shouldInclude(relativePath)) {
        const info = await stat(absolutePath)
        files.push({
          absolutePath,
          path: relativePath.replaceAll(path.sep, '/'),
          size: info.size,
          lastModifiedMs: info.mtimeMs,
        })
      }
    }
  }

  await walk(root)
  return files
}

async function inspectProvider(provider) {
  const rootPath = getProviderRoot(provider)
  const cacheKey = `${provider}:${rootPath}`
  const cached = scanCache.get(cacheKey)
  if (cached && Date.now() - cached.scannedAtMs < scanCacheTtlMs) {
    return cached.result
  }

  if (!existsSync(rootPath)) {
    return {
      ok: false,
      provider,
      rootPath,
      fileCount: 0,
      sessionFileCount: 0,
      totalBytes: 0,
      files: [],
      message: `没有找到 ${rootPath}`,
    }
  }

  const files = await walkFiles(rootPath, (relativePath) => {
    if (provider === 'claude') {
      return relativePath.startsWith('projects/') && relativePath.endsWith('.jsonl')
    }
    return (
      relativePath === 'state_5.sqlite' ||
      (relativePath.startsWith('sessions/') &&
        (relativePath.endsWith('.jsonl') || relativePath.endsWith('.jsonl.zst')))
    )
  })

  const sessionFileCount = files.filter((file) => /\.jsonl(\.zst)?$/.test(file.path)).length
  const hasRequiredRoot = provider === 'claude' ? sessionFileCount > 0 : files.some((file) => file.path === 'state_5.sqlite')
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)

  const result = {
    ok: hasRequiredRoot,
    provider,
    rootPath,
    fileCount: files.length,
    sessionFileCount,
    totalBytes,
    files,
    message: hasRequiredRoot ? undefined : `没有找到 ${provider === 'claude' ? 'projects/**/*.jsonl' : 'state_5.sqlite'}`,
  }
  scanCache.set(cacheKey, { scannedAtMs: Date.now(), result })
  return result
}

function sendJson(response, statusCode, payload) {
  if (response.headersSent) {
    return
  }
  response.writeHead(statusCode, {
    'content-type': 'application/json;charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  response.end(JSON.stringify(payload))
}

function startLocalApiServer(port) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      const provider = url.searchParams.get('provider') === 'claude' ? 'claude' : 'codex'

      if (url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, app: appId, pid: process.pid })
        return
      }

      if (url.pathname === '/api/detect') {
        const result = await inspectProvider(provider)
        const { files, ...payload } = result
        sendJson(response, 200, payload)
        return
      }

      if (url.pathname === '/api/read-source') {
        const result = await inspectProvider(provider)
        if (!result.ok) {
          const { files, ...payload } = result
          sendJson(response, 200, payload)
          return
        }

        sendJson(response, 200, {
          ok: true,
          provider,
          rootPath: result.rootPath,
          fileCount: result.files.length,
          sessionFileCount: result.sessionFileCount,
          totalBytes: result.totalBytes,
          files: result.files.map((file) => ({
            path: file.path,
            size: file.size,
            lastModifiedMs: file.lastModifiedMs,
          })),
        })
        return
      }

      if (url.pathname === '/api/files') {
        const result = await inspectProvider(provider)
        if (!result.ok) {
          const { files, ...payload } = result
          sendJson(response, 200, {
            ...payload,
            files: [],
            nextCursor: null,
            total: 0,
          })
          return
        }
        const cursor = Math.max(0, Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0)
        const limit = Math.min(
          100,
          Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '25', 10) || 25),
        )
        const page = result.files.slice(cursor, cursor + limit)
        sendJson(response, 200, {
          ok: true,
          provider,
          rootPath: result.rootPath,
          fileCount: result.fileCount,
          sessionFileCount: result.sessionFileCount,
          totalBytes: result.totalBytes,
          total: result.files.length,
          nextCursor: cursor + limit < result.files.length ? cursor + limit : null,
          files: page.map((file) => ({
            path: file.path,
            size: file.size,
            lastModifiedMs: file.lastModifiedMs,
          })),
        })
        return
      }

      if (url.pathname === '/api/file') {
        const result = await inspectProvider(provider)
        if (!result.ok) {
          sendJson(response, 404, { ok: false, message: result.message })
          return
        }
        const requestedPath = url.searchParams.get('path') ?? ''
        if (requestedPath.includes('..') || path.isAbsolute(requestedPath)) {
          sendJson(response, 403, { ok: false, message: 'Forbidden path' })
          return
        }
        const file = result.files.find((item) => item.path === requestedPath)
        if (!file) {
          sendJson(response, 404, { ok: false, message: 'File not found' })
          return
        }
        const content = await readFile(file.absolutePath)
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        })
        response.end(content)
        return
      }

      sendJson(response, 404, { ok: false, message: 'Not found' })
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function findPort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolve(findPort(startPort + 1))
        return
      }
      reject(error)
    })
    server.listen(startPort, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address !== 'string') {
          resolve(address.port)
          return
        }
        reject(new Error('无法获取空闲端口'))
      })
    })
  })
}

async function openBrowser(url) {
  const platform = process.platform
  if (platform === 'darwin') {
    const chromeApps = [
      '/Applications/Google Chrome.app',
      '/Applications/Microsoft Edge.app',
      '/Applications/Chromium.app',
    ]
    const preferred = chromeApps.find((appPath) => existsSync(appPath))
    if (preferred) {
      try {
        await runCommand('open', ['-a', preferred, url])
        return
      } catch {
        // fall through
      }
    }
    await runCommand('open', [url])
    return
  }

  if (platform === 'win32') {
    const browserCommands = ['chrome', 'msedge']
    for (const command of browserCommands) {
      try {
        await runCommand(command, [url], { windowsHide: true })
        return
      } catch {
        // try next browser
      }
    }
    await runCommand('start', ['', url], { windowsHide: true })
    return
  }

  await runCommand('xdg-open', [url])
}


async function ensureDependencies() {
  if (!existsSync(path.join(projectRoot, 'node_modules'))) {
    log('首次启动，正在安装依赖...')
    await runCommand('npm', ['install'])
  }
}

function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, json: JSON.parse(body) })
        } catch {
          resolve({ status: response.statusCode, json: null })
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(null))
  })
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await httpGetJson(url)
    if (result && result.status && result.status < 500) {
      return true
    }
    await wait(300)
  }
  return false
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'))
  } catch {
    return null
  }
}

// 返回正在运行的后台服务状态；状态文件过期时顺手清理
async function getRunningState() {
  const state = await readState()
  if (!state?.pid) {
    return null
  }
  if (isPidAlive(state.pid)) {
    const health = await httpGetJson(`http://127.0.0.1:${state.apiPort}/api/health`)
    if (health?.json?.app === appId && health.json.pid === state.pid) {
      return state
    }
  }
  await rm(statePath, { force: true })
  return null
}

// ---------- 后台服务进程（由 start 以隐藏、脱离终端的方式拉起） ----------

async function serve() {
  const port = await findPort(5180)
  const apiPort = await findPort(6280)
  const url = `http://127.0.0.1:${port}`

  await startLocalApiServer(apiPort)
  log(`本地只读识别服务: http://127.0.0.1:${apiPort}`)

  const viteBin = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const vite = spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, VITE_LOCAL_API_PORT: String(apiPort) },
    },
  )

  let exiting = false
  const shutdown = async (code) => {
    if (exiting) return
    exiting = true
    if (vite.exitCode === null) {
      vite.kill()
    }
    const state = await readState()
    if (state?.pid === process.pid) {
      await rm(statePath, { force: true })
    }
    process.exit(code)
  }

  vite.on('error', (error) => {
    console.error(`vite 启动失败: ${error.message}`)
    shutdown(1)
  })
  vite.on('exit', (code) => shutdown(code ?? 0))
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => shutdown(0))
  }

  if (!(await waitForHttp(url, 60_000))) {
    console.error('前端页面 60 秒内未就绪')
    await shutdown(1)
    return
  }

  await writeFile(
    statePath,
    JSON.stringify({ pid: process.pid, url, port, apiPort, startedAt: new Date().toISOString() }, null, 2),
  )
  log(`页面已就绪: ${url}`)
}

// ---------- 菜单命令 ----------

async function start() {
  const running = await getRunningState()
  if (running) {
    log(`已在后台运行: ${running.url}`)
    await openBrowserSafe(running.url)
    return true
  }

  await ensureDependencies()
  await mkdir(runtimeDir, { recursive: true })
  await rm(statePath, { force: true })

  const logFd = openSync(logPath, 'w')
  const child = spawn(process.execPath, [scriptPath, 'serve'], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  child.unref()

  log('正在后台启动...')
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const state = await readState()
    if (state?.pid === child.pid) {
      log(`已在后台启动: ${state.url}`)
      await openBrowserSafe(state.url)
      return true
    }
    if (!isPidAlive(child.pid)) {
      break
    }
    await wait(400)
  }

  if (isPidAlive(child.pid)) {
    await killServer(child.pid)
  }
  console.error(`[${appId}] 启动失败，日志: ${logPath}`)
  return false
}

async function killServer(pid) {
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('exit', resolve)
      killer.on('error', resolve)
    })
    return
  }
  // detached 启动的服务是进程组组长，向整个进程组发信号，连同 vite 一起结束
  const killGroup = (signal) => {
    try {
      process.kill(-pid, signal)
    } catch {
      // 进程已退出
    }
  }
  killGroup('SIGTERM')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && isPidAlive(pid)) {
    await wait(200)
  }
  if (isPidAlive(pid)) {
    killGroup('SIGKILL')
  }
}

async function stop() {
  // 通过健康检查确认 PID 确实是本服务，避免误杀被复用的 PID
  const state = await getRunningState()
  if (!state) {
    log('后台服务未在运行')
    return true
  }

  await killServer(state.pid)
  await rm(statePath, { force: true })
  log('后台服务已停止')
  return true
}

async function restart() {
  await stop()
  await wait(500)
  return start()
}

async function status() {
  const running = await getRunningState()
  if (running) {
    log(`运行中: ${running.url}（PID ${running.pid}，启动于 ${new Date(running.startedAt).toLocaleString()}）`)
  } else {
    log('未运行')
  }
  log(`日志: ${logPath}`)
  return true
}

async function openBrowserSafe(url) {
  try {
    await openBrowser(url)
  } catch (error) {
    console.warn(`[${appId}] 自动打开浏览器失败，请手动访问 ${url}`)
    console.warn(String(error))
  }
}

const commands = { start, stop, restart, status }

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (prompt) => rl.question(prompt).catch(() => '')
  const running = await getRunningState()
  console.log('')
  console.log('  Vibe Coding Usage Dashboard')
  console.log(`  当前状态: ${running ? `运行中 ${running.url}` : '未运行'}`)
  console.log('')
  console.log('  1. 启动（后台运行并打开浏览器）')
  console.log('  2. 停止')
  console.log('  3. 重启')
  console.log('  4. 查看状态')
  console.log('  0. 退出')
  console.log('')
  const answer = (await ask('  请选择 [1]: ')).trim() || '1'
  const name = { 1: 'start', 2: 'stop', 3: 'restart', 4: 'status' }[answer]
  if (!name) {
    rl.close()
    return true
  }
  console.log('')
  const ok = await commands[name]()
  if (name === 'status' || !ok) {
    await ask('\n按回车键退出...')
  } else {
    await wait(1200)
  }
  rl.close()
  return ok
}

async function main() {
  ensureNodeVersion()
  const command = process.argv[2]

  if (command === 'serve') {
    await serve()
    return
  }

  let ok
  if (commands[command]) {
    ok = await commands[command]()
  } else if (!command) {
    ok = await menu()
  } else {
    fail(`未知命令: ${command}，可用: start | stop | restart | status`)
  }
  process.exit(ok ? 0 : 1)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
