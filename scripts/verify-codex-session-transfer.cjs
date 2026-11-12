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

// All homes, projects, indexes and replies are synthetic and remain below this directory.
async function main() {
  const codex = process.argv[2] || process.env.CODEX_TEST_BINARY
  const rustTest = process.argv[3] || process.env.GAOGE_HISTORY_TEST_EXE
  assert.ok(codex && rustTest, 'Provide the Codex executable and the Rust library test executable')
  const parent = path.resolve(__dirname, '../src-tauri/target/session-transfer-verification')
  fs.mkdirSync(parent, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(parent, 'run-'))
  fs.writeFileSync(path.join(fixture, 'synthetic-only'), 'session-transfer-test')
  const sourceHome = path.join(fixture, 'source-home'), targetHome = path.join(fixture, 'target-home')
  const sourceProject = path.join(fixture, 'source-project'), targetProject = path.join(fixture, 'target-project')
  for (const directory of [sourceHome, targetHome, sourceProject, targetProject]) fs.mkdirSync(directory)
  const requests = []
  let external = 0, session
  const server = http.createServer(async (req, res) => {
    if (/^https?:/i.test(req.url)) { external++; res.writeHead(403); res.end(); return }
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks)))
      serve(res, requests.length, false)
    } catch (error) { res.writeHead(500); res.end(error.message) }
  })
  server.on('connection', socket => socket.on('error', () => {}))
  server.on('connect', (_req, socket) => { external++; socket.end('HTTP/1.1 403 Forbidden' + String.fromCharCode(13, 10, 13, 10)) })
  const waitFor = async (check, label) => {
    const end = Date.now() + 25000
    while (Date.now() < end) { const result = check(); if (result) return result; await delay(25) }
    throw new Error('Timeout: ' + label + '; ' + session?.stderr())
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    const environment = home => {
      const env = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, HOME: fixture, USERPROFILE: fixture,
        APPDATA: path.join(fixture,'appdata'), LOCALAPPDATA: path.join(fixture,'localappdata'), OTEL_SDK_DISABLED: 'true', GAOGE_CONVERSATION_TEST_KEY: 'synthetic-only' }
      delete env.OPENAI_API_KEY
      for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) env[key] = origin
      env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1'
      return env
    }
    for (const home of [sourceHome, targetHome]) {
      const models = path.join(home, 'models.json'); fs.writeFileSync(models, JSON.stringify(catalog()))
      const setting = (key, value) => key + ' = ' + JSON.stringify(value)
      fs.writeFileSync(path.join(home, 'config.toml'), [
        setting('model_provider','custom'),setting('model',model),setting('sqlite_home',home.replaceAll(String.fromCharCode(92),'/')),
        setting('model_catalog_json',models.replaceAll(String.fromCharCode(92),'/')),setting('cli_auth_credentials_store','file'),
        setting('approval_policy','never'),setting('sandbox_mode','read-only'), '[analytics]', 'enabled = false',
        '[model_providers.custom]', setting('name','Session transfer test'),setting('base_url',origin+'/v1'),
        setting('wire_api','responses'), setting('env_key','GAOGE_CONVERSATION_TEST_KEY'),
      ].join(nl))
    }
    session = await launch(codex, sourceProject, environment(sourceHome))
    const created = await session.call('thread/start', { model, modelProvider: 'custom', cwd: sourceProject, ephemeral: false, approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'paginated' })
    const threadId = created.thread.id
    const turn = async text => {
      const started = await session.call('turn/start', { threadId, model, input: [{ type: 'text', text }], effort: 'medium' })
      const done = await waitFor(() => session.notifications.find(event => event.method === 'turn/completed' && event.params.turn.id === started.turn.id), 'turn completion')
      assert.equal(done.params.turn.status, 'completed', JSON.stringify(done.params.turn.error))
      return started.turn
    }
    await turn('PORTABLE_PREFIX_KEEP')
    const discarded = await turn('DISCARDED_BRANCH')
    await session.call('thread/revert', { threadId, beforeTurnId: discarded.id })
    await turn('PORTABLE_EDIT_KEEP')
    const before = await session.call('thread/turns/list', { threadId, limit: 100 })
    assert.equal(before.data.length, 2)
    await session.close(); session = null
    // Initialize the destination with its own native database, just like a second computer.
    if (!process.env.GAOGE_TRANSFER_FRESH_HOME) {
      session = await launch(codex, targetProject, environment(targetHome))
      await session.call('thread/list', { limit: 20 })
      await session.close(); session = null
    }
    fs.writeFileSync(path.join(fixture,'input.json'),JSON.stringify({sessionIds:[threadId]}))
    const output = execFileSync(rustTest, ['--exact','codex_session_transfer::native_verification::session_transfer_native_fixture','--ignored','--test-threads=1'],
      { cwd: path.resolve(__dirname,'..'),env:{...process.env,CODEX_SQLITE_HOME:'',GAOGE_SESSION_TRANSFER_FIXTURE:fixture},windowsHide:true,encoding:'utf8',stdio:'pipe' })
    assert.ok(output.includes('1 passed'),output)
    session = await launch(codex, targetProject, environment(targetHome))
    const listed = await session.call('thread/list', { limit: 100, modelProviders:['custom'] })
    assert.ok(listed.data.some(thread => thread.id === threadId), 'Imported thread must appear in native thread/list')
    const resumed = await session.call('thread/resume', { threadId, model, modelProvider:'custom' })
    assert.equal(path.resolve(resumed.thread.cwd.replace(/^\\\\\?\\/, '')),path.resolve(targetProject),'Resume must use the remapped project without an explicit cwd override')
    const restored = await session.call('thread/turns/list', { threadId, limit:100 })
    assert.equal(restored.data.length,2,JSON.stringify(restored))
    await turn('CONTINUED_ON_OTHER_COMPUTER')
    const input = JSON.stringify(requests.at(-1).input)
    assert.ok(input.includes('PORTABLE_PREFIX_KEEP')); assert.ok(input.includes('PORTABLE_EDIT_KEEP'))
    assert.ok(!input.includes('DISCARDED_BRANCH'))
    const final = await session.call('thread/turns/list', { threadId, limit:100 })
    assert.equal(final.data.length,3,JSON.stringify({before:restored,after:final,stderr:session.stderr()}))
    console.log(JSON.stringify({nativeVersion:session.initialized.userAgent,portableBranchRestored:true,nativeListVisible:true,projectRemapped:true,continuedConversation:true,turns:final.data.length,externalRequestsBlocked:external,fixture}))
  } catch (error) {
    console.error('Isolated fixture retained at: '+fixture)
    throw error
  } finally {
    if(session) await session.close()
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve))
  }
}
main().catch(error=>{ console.error(error);process.exitCode=1 })
