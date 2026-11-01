import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(process.argv[1] ? path.dirname(process.argv[1]) : '.', '..')
const scanCache = new Map()
const scanCacheTtlMs = 10 * 60 * 1000
process.chdir(projectRoot)

function fail(message) {
  console.error(`[vibe-coding-usage-dashboard] ${message}`)
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
    console.log('[vibe-coding-usage-dashboard] 首次启动，正在安装依赖...')
    await runCommand('npm', ['install'])
  }
}

async function main() {
  ensureNodeVersion()
  await ensureDependencies()
  const port = await findPort(5180)
  const apiPort = await findPort(6280)
  const url = `http://127.0.0.1:${port}`

  console.log(`[vibe-coding-usage-dashboard] 即将启动: ${url}`)
  await startLocalApiServer(apiPort)
  console.log(`[vibe-coding-usage-dashboard] 本地只读自动识别服务已启用: http://127.0.0.1:${apiPort}`)

  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        VITE_LOCAL_API_PORT: String(apiPort),
      },
    },
  )

  child.on('error', (error) => {
    fail(`启动失败: ${error.message}`)
  })

  await wait(2500)
  try {
    await openBrowser(url)
  } catch (error) {
    console.warn(`[vibe-coding-usage-dashboard] 自动打开浏览器失败，请手动访问 ${url}`)
    console.warn(String(error))
  }

  child.on('exit', (code) => {
    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
