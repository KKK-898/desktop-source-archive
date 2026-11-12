// Synthetic messages and local mock only. No personal Codex home is read.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const readline = require('node:readline')
const { spawn, execFileSync } = require('node:child_process')
const model = 'gaoge-conversation-verification'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const nl = String.fromCharCode(10)
function catalog() {
  return { models: [{ slug: model, display_name: 'Conversation verification',
    description: 'Synthetic local test', base_instructions: 'Reply with the local test answer.',
    model_messages: { instructions_template: 'Reply with the local test answer.' },
    default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: 'Medium' }],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1000,
    supports_reasoning_summaries: false, default_reasoning_summary: 'none', support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 }, supports_parallel_tool_calls: false,
    supports_image_detail_original: false, context_window: 32768, max_context_window: 32768,
    effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'],
    supports_search_tool: false, additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null }] }
}
function serve(res, index, hold) {
  const item = { id: `msg_test_${index}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: `Synthetic answer ${index}.`, annotations: [] }] }
  const response = { id: `resp_test_${index}`, object: 'response', created_at: 1, status: 'completed',
    output: [item], model, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
  ]
  if (!hold) events.push(
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response })
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  events.forEach((event, sequence_number) => res.write(`event: ${event.type}${nl}data: ${JSON.stringify({ ...event, sequence_number })}${nl}${nl}`))
  if (!hold) res.end()
}
async function launch(codex, root, env) {
  const child = spawn(codex, ['app-server'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const pending = new Map()
  const notifications = []
  const serverRequests = []
  let stderr = ''
  let id = 0
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-6000) })
  const fail = error => { for (const h of pending.values()) h.reject(error); pending.clear() }
  child.on('error', fail)
  child.on('exit', () => fail(new Error('Isolated app-server exited')))
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method) {
      if (message.id !== undefined) serverRequests.push(message)
      else notifications.push(message)
    } else if (pending.has(message.id)) {
      const h = pending.get(message.id); pending.delete(message.id)
      message.error ? h.reject(new Error(message.error.message)) : h.resolve(message.result)
    }
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out: ${stderr}`)) }, 25000)
    pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + nl)
  })
  const close = async () => {
    if (child.exitCode === null) {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else child.kill()
      await Promise.race([exited, delay(2000)])
    }
  }
  try {
    const initialized = await call('initialize', { clientInfo: { name: 'gaoge_conversation_check', version: '1.0' }, capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + nl)
    const reply = (request, result) => child.stdin.write(JSON.stringify({ id: request.id, result }) + nl)
    return { call, notifications, serverRequests, reply, initialized, close, stderr: () => stderr }
  } catch (error) { await close(); throw error }
}
async function main() {
  const codex = process.argv[2] || process.env.CODEX_TEST_BINARY
  assert.ok(codex, 'Provide a Codex executable argument or CODEX_TEST_BINARY')
  const parent = path.resolve(__dirname, '../src-tauri/target/conversation-verification')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'run-'))
  const home = path.join(root, '.codex')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, 'gaoge-synthetic-history-fixture'), 'synthetic-only')
  const requests = []
  let external = 0
  let session, success = false
  const server = http.createServer(async (req, res) => {
    try {
      if (/^https?:/i.test(req.url)) { external++; res.writeHead(403); res.end(); return }
      if (req.url !== '/v1/responses' || req.method !== 'POST') { res.writeHead(404); res.end(); return }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      const lastUser = body.input.filter(item => item.role === 'user').at(-1)
      serve(res, requests.length, JSON.stringify(lastUser).includes('HOLD_FOR_STOP'))
    } catch (error) { res.writeHead(500); res.end(error.message) }
  })
  server.on('connect', (_req, socket) => { external++; socket.end('HTTP/1.1 403 Forbidden' + String.fromCharCode(13, 10, 13, 10)) })
  const waitFor = async (predicate, label) => {
    const end = Date.now() + 25000
    while (Date.now() < end) { const result = predicate(); if (result) return result; await delay(25) }
    throw new Error(`Timed out: ${label}; ${session?.stderr()}`)
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const env = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, HOME: root, USERPROFILE: root, OTEL_SDK_DISABLED: 'true', GAOGE_CONVERSATION_TEST_KEY: 'synthetic-only' }
    delete env.OPENAI_API_KEY
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = origin
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1'
    const models = path.join(home, 'models.json')
    fs.writeFileSync(models, JSON.stringify(catalog()))
    const setting = (key, value) => key + ' = ' + JSON.stringify(value)
    fs.writeFileSync(path.join(home, 'config.toml'), [
      setting('model_provider', 'custom'), setting('model', model),
      setting('model_catalog_json', models.replaceAll(String.fromCharCode(92), '/')),
      setting('cli_auth_credentials_store', 'file'), setting('approval_policy', 'never'), setting('sandbox_mode', 'read-only'),
      '[analytics]', 'enabled = false', '[model_providers.custom]', setting('name', 'Isolated conversation test'),
      setting('base_url', origin + '/v1'), setting('wire_api', 'responses'), setting('env_key', 'GAOGE_CONVERSATION_TEST_KEY'),
    ].join(nl))
    session = await launch(codex, root, env)
    const created = await session.call('thread/start', { model, modelProvider: 'custom', cwd: root, ephemeral: false, approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'paginated' })
    const threadId = created.thread.id
    // Exercise the native lifecycle directly, with no recovery interception.
    const client = { hostId: 'local', sendRequest: (method, params) => session.call(method, params) }
    const send = text => client.sendRequest('turn/start', { threadId, model, input: [{ type: 'text', text }], effort: 'medium' })
    const complete = async started => {
      const done = await waitFor(() => session.notifications.find(n => n.method === 'turn/completed' && n.params.turn.id === started.turn.id), 'turn completion')
      assert.equal(done.params.turn.status, 'completed', JSON.stringify(done.params.turn.error))
      return started
    }
    await complete(await send('PREFIX_KEEP'))
    for (let cycle = 0; cycle < 3; cycle++) {
      const count = requests.length
      const stopped = await send(`HOLD_FOR_STOP_${cycle}`)
      await waitFor(() => requests.length > count, 'mock request before stop')
      await client.sendRequest('turn/interrupt', { threadId, turnId: stopped.turn.id })
      await waitFor(() => session.notifications.find(n => n.method === 'turn/completed' && n.params.turn.id === stopped.turn.id), 'native stop completion')
      await client.sendRequest('thread/revert', { threadId, beforeTurnId: stopped.turn.id })
      await complete(await send(`EDITED_${cycle}`))
      assert.ok(JSON.stringify(requests.at(-1).input).includes('PREFIX_KEEP'))
      assert.ok(!JSON.stringify(requests.at(-1).input).includes(`HOLD_FOR_STOP_${cycle}`))
    }
    const turns = await session.call('thread/turns/list', { threadId, limit: 100 })
    assert.equal(turns.data.length, 4)
    await session.close()
    if (process.env.GAOGE_HISTORY_TEST_EXE) {
      const synced = execFileSync(process.env.GAOGE_HISTORY_TEST_EXE, ['--exact', 'tests::history_safety_regressions::native_synthetic_sync_fixture', '--ignored', '--test-threads=1'],
        { cwd: path.resolve(__dirname, '..'), env: { ...process.env, GAOGE_SYNTHETIC_HISTORY_HOME: home }, windowsHide: true, stdio: 'pipe', encoding: 'utf8' })
      assert.ok(synced.includes('native_synthetic_sync_fixture ... ok') && synced.includes('1 passed'),
        'The selected Rust test executable must contain and pass the native sync fixture')
    }
    session = await launch(codex, root, env)
    await session.call('thread/resume', { threadId, model, modelProvider: 'custom', cwd: root })
    await complete(await send('AFTER_RESTART'))
    assert.ok(JSON.stringify(requests.at(-1).input).includes('PREFIX_KEEP'))
    assert.ok(JSON.stringify(requests.at(-1).input).includes('EDITED_2'))
    const restored = await session.call('thread/turns/list', { threadId, limit: 100 })
    assert.equal(restored.data.length, 5)
    console.log(JSON.stringify({ cli: session.initialized.userAgent, editStopSendCycles: 3, nativeResumeAfterRestart: true, originalPrefixPreserved: true, paginatedTurns: restored.data.length, applicationSyncTested: !!process.env.GAOGE_HISTORY_TEST_EXE, blockedExternalRequests: external, fixture: home }))
    success = true
  } finally {
    await session?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(path.resolve(root)), parent)
    if (success && !process.env.GAOGE_KEEP_SYNTHETIC_FIXTURE) fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
    else console.error(`Synthetic fixture retained: ${root}`)
  }
}
module.exports = { catalog, serve, launch, model }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
