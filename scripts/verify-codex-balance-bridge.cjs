// Exercise the actual Rust bridge against an isolated, headless browser page.
// No production Codex target, user profile, account endpoint or GUI is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const root = path.resolve(__dirname, '..')
const testName = 'session_delete_bridge_isolated_browser_recovers_same_target'
const fixturePath = '/gaoge-balance-bridge-isolated'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return server.address().port
}
async function closeServer(server) {
  if (!server?.listening) return
  server.closeAllConnections?.()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
async function allocateDebugPort() {
  const reservation = net.createServer()
  const port = await listen(reservation)
  await closeServer(reservation)
  // Never fall back to the production Codex CDP port.
  assert.notEqual(port, 9239)
  return port
}
async function launchBrowser(debugPort) {
  const options = {
    headless: true,
    args: ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${debugPort}`,
      '--no-first-run', '--disable-background-networking'],
  }
  try { return await chromium.launch(options) }
  catch (error) {
    if (!String(error).includes("Executable doesn't exist")) throw error
    if (process.platform !== 'win32') throw error
    try { return await chromium.launch({ ...options, channel: 'msedge' }) }
    catch (edgeError) {
      if (!String(edgeError).includes("Executable doesn't exist")) throw edgeError
      return chromium.launch({ ...options, channel: 'chrome' })
    }
  }
}
async function killOwnedProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' })
      killer.once('error', resolve)
      killer.once('exit', resolve)
    })
  } else child.kill('SIGTERM')
}
async function runRustFixture(websocketUrl) {
  const binary = process.env.GAOGE_TEST_BALANCE_RUST_TEST_BINARY
  if (binary) assert.ok(fs.statSync(binary).isFile(), 'Rust test binary must be an existing file')
  const command = binary ? path.resolve(binary) : 'cargo'
  const args = binary ? [testName, '--test-threads=1', '--nocapture'] : [
    'test', '--locked', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'),
    '--lib', testName, '--', '--test-threads=1', '--nocapture',
  ]
  const env = { ...process.env, GAOGE_TEST_BALANCE_CDP_WEBSOCKET: websocketUrl, RUST_TEST_THREADS: '1' }
  // The opt-in legacy fixture injects the full application runtime. It is not
  // part of this verification, even if the launching shell had configured it.
  delete env.CODEX_SESSION_DELETE_CDP_WEBSOCKET
  let output = ''
  const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const done = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    const text = data.toString()
    output = (output + text).slice(-40000)
    process.stdout.write(text)
  })
  let timer
  try {
    const result = await Promise.race([done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Isolated Rust bridge verification timed out')), binary ? 120000 : 600000)
    })])
    assert.equal(result.code, 0, `Rust bridge fixture failed (${result.signal || result.code})`)
    assert.match(output, /test result: ok\. 1 passed; 0 failed;/, 'The isolated Rust fixture must actually run and pass once')
  } finally {
    clearTimeout(timer)
    await killOwnedProcess(child)
  }
}

async function main() {
  let browser
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(request.url)
    if (request.url !== fixturePath) { response.writeHead(404); response.end(); return }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'",
      'Cache-Control': 'no-store',
    })
    response.end('<!doctype html><html><head><meta charset="UTF-8"><title>Isolated balance bridge verification</title></head><body><main id="fixture">Synthetic bridge status only</main></body></html>')
  })
  try {
    const httpPort = await listen(server)
    const debugPort = await allocateDebugPort()
    assert.notEqual(debugPort, httpPort)
    const fixtureUrl = `http://127.0.0.1:${httpPort}${fixturePath}`
    browser = await launchBrowser(debugPort)
    const context = await browser.newContext({ serviceWorkers: 'block' })
    await context.route('**/*', route => route.request().url() === fixtureUrl ? route.continue() : route.abort())
    const page = await context.newPage()
    await page.goto(fixtureUrl)
    assert.equal(await page.evaluate(async () => {
      try { await fetch('/blocked-loopback-request'); return false } catch { return true }
    }), true, 'The test page must block network fallbacks with CSP')
    assert.equal(requests.includes('/blocked-loopback-request'), false)
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(3000) }).then(response => {
      assert.equal(response.ok, true, 'The isolated browser must expose its own CDP endpoint')
      return response.json()
    })
    const target = targets.find(item => item.type === 'page' && item.url === fixtureUrl)
    assert.ok(target?.webSocketDebuggerUrl, 'The owned fixture page must have a CDP target')
    const socket = new URL(target.webSocketDebuggerUrl)
    assert.equal(socket.protocol, 'ws:')
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(socket.hostname))
    assert.equal(Number(socket.port), debugPort)
    assert.ok(socket.pathname.startsWith('/devtools/page/'))
    console.log('Running the isolated Rust bridge fixture against a temporary headless browser; page network access is blocked.')
    await runRustFixture(target.webSocketDebuggerUrl)
    assert.equal(page.url(), fixtureUrl, 'Bridge checks must stay on the owned synthetic page')
    assert.equal(requests.includes('/blocked-loopback-request'), false)
    console.log('PASS: isolated bridge recovery, reload, healthy reuse and pending-request checks completed.')
  } finally {
    try { await browser?.close() } finally { await closeServer(server) }
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
