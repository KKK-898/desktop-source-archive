// Native app-server + production Rust forwarder + loopback mock, synthetic data only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const vm = require('node:vm')
const { spawn, execFileSync } = require('node:child_process')
const { catalog, serve, launch, model } = require('./verify-codex-conversation-recovery.cjs')
const nl = String.fromCharCode(10)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const pairError = 'A tool call is missing its matching output. Resend the complete tool-call and tool-output context.'
const screenshotError = 'stream disconnected before completion: No tool output found for custom tool call ctc_synthetic.'
function serveTool(res, index, callId, name) {
  const item = { type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: '{}', status: 'completed' }
  const response = { id: `resp_tool_${index}`, object: 'response', created_at: 1, status: 'completed', output: [item], model,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{}' },
    { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: '{}' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  events.forEach((event, sequence_number) => res.write(`event: ${event.type}${nl}data: ${JSON.stringify({ ...event, sequence_number })}${nl}${nl}`))
  res.end()
}
function rolloutSnapshots(home) {
  const snapshots = []
  const visit = directory => {
    if (!fs.existsSync(directory)) return
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.name.endsWith('.jsonl')) snapshots.push([file, fs.readFileSync(file)])
    }
  }
  visit(path.join(home, 'sessions'))
  assert.ok(snapshots.length > 0, 'Real native history must have been persisted')
  return snapshots
}
async function main() {
  const codex = process.argv[2] || process.env.CODEX_TEST_BINARY
  const testExe = process.env.GAOGE_HISTORY_TEST_EXE
  const loginMode = process.env.GAOGE_TEST_LOGIN_MODE || 'aggregate'
  assert.equal(loginMode, 'aggregate', 'Ordinary account/API login now uses the relay domain directly; run direct_route_migration_regressions for those modes.')
  const proxyTest = 'tests::response_compat_http_regressions::native_tool_recovery_proxy'
  assert.ok(codex && testExe, 'Provide CODEX_TEST_BINARY/argument and GAOGE_HISTORY_TEST_EXE')
  const parent = path.resolve(__dirname, '../src-tauri/target/conversation-verification')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'tool-run-'))
  const home = path.join(root, '.codex')
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(home, 'gaoge-synthetic-history-fixture'), 'synthetic-only')
  const requests = []
  let external = 0, rejected = 0, readExecutions = 0, toolRequests = 0
  const rejectionKinds = new Set()
  let session, adapter, proxy, proxyExited, proxyLog = '', success = false
  const waitFor = async (predicate, label) => {
    const end = Date.now() + 25000
    while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(25) }
    throw new Error(`Timed out: ${label}; ${session?.stderr()}; ${proxyLog}`)
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (/^https?:/i.test(req.url)) { external++; res.writeHead(403); res.end(); return }
      if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
      assert.equal(req.headers.authorization, 'Bearer synthetic-only')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.model, model)
      requests.push(body)
      const input = JSON.stringify(body.input)
      if (body.input.some(item => ['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type))) {
        rejected++
        const kind = ['http-generic', 'http-custom', 'sse-error', 'sse-response-failed'][(rejected - 1) % 4]
        rejectionKinds.add(kind)
        const error = { type: 'invalid_request_error', message: kind === 'http-generic' ? pairError : screenshotError }
        if (kind.startsWith('http-')) {
          res.writeHead(kind === 'http-custom' ? 422 : 400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error }))
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`: synthetic heartbeat${nl}${nl}`)
          const event = kind === 'sse-error' ? { type: 'error', error }
            : { type: 'response.failed', response: { id: 'resp_rejected', status: 'failed', output: [], error } }
          res.end(`event: ${event.type}${nl}data: ${JSON.stringify(event)}${nl}${nl}`)
        }
        return
      }
      const lastUser = JSON.stringify(body.input.filter(item => item.role === 'user').at(-1))
      if (lastUser.includes('RUN_READ') && !input.includes('call_saved')) serveTool(res, requests.length, 'call_saved', 'synthetic_read')
      else if (lastUser.includes('RUN_WAIT_EDIT') && !input.includes('call_wait_edit')) serveTool(res, requests.length, 'call_wait_edit', 'synthetic_wait')
      else if (lastUser.includes('RUN_WAIT') && !input.includes('call_wait')) serveTool(res, requests.length, 'call_wait', 'synthetic_wait')
      else serve(res, requests.length, false)
    } catch (error) { res.writeHead(500); res.end(error.message) }
  })
  server.on('connect', (_req, socket) => { external++; socket.end('HTTP/1.1 403 Forbidden' + String.fromCharCode(13, 10, 13, 10)) })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const upstream = `127.0.0.1:${server.address().port}`
    const env = { ...process.env, CODEX_HOME: home, HOME: root, USERPROFILE: root, OTEL_SDK_DISABLED: 'true',
      GAOGE_CONVERSATION_TEST_KEY: 'synthetic-only', GAOGE_SYNTHETIC_HISTORY_HOME: home, GAOGE_SYNTHETIC_UPSTREAM: upstream }
    delete env.OPENAI_API_KEY
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = `http://${upstream}`
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1'
    proxy = spawn(testExe, ['--exact', proxyTest, '--ignored', '--nocapture', '--test-threads=1'],
      { cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    proxyExited = new Promise(resolve => { proxy.once('exit', resolve); proxy.once('error', error => { proxyLog += error.message; resolve(-1) }) })
    proxy.stdout.on('data', data => { proxyLog = (proxyLog + data).slice(-8000) })
    proxy.stderr.on('data', data => { proxyLog = (proxyLog + data).slice(-8000) })
    const addressFile = path.join(home, 'gaoge-test-proxy.json')
    await waitFor(() => fs.existsSync(addressFile), 'production proxy startup')
    const ready = JSON.parse(fs.readFileSync(addressFile, 'utf8'))
    const origin = `http://127.0.0.1:${ready.port}`
    const control = async action => {
      fs.writeFileSync(path.join(home, 'gaoge-test-control-command'), action)
      return waitFor(() => {
        try { const result = JSON.parse(fs.readFileSync(path.join(home, 'gaoge-test-control-reply.json'), 'utf8'));
          return result.action === action && result.ok && result } catch { return false }
      }, `production recovery service ${action}`)
    }
    const models = path.join(home, 'models.json')
    fs.writeFileSync(models, JSON.stringify(catalog()))
    const setting = (key, value) => key + ' = ' + JSON.stringify(value)
    if (loginMode === 'aggregate') fs.writeFileSync(path.join(home, 'config.toml'), [
      setting('model_provider', 'custom'), setting('model', model),
      setting('model_catalog_json', models.replaceAll(String.fromCharCode(92), '/')),
      setting('cli_auth_credentials_store', 'file'), setting('approval_policy', 'never'), setting('sandbox_mode', 'read-only'),
      '[analytics]', 'enabled = false', '[model_providers.custom]', setting('name', 'Isolated tool recovery test'),
      setting('base_url', origin + '/v1'), setting('wire_api', 'responses'), setting('env_key', 'GAOGE_CONVERSATION_TEST_KEY'),
    ].join(nl))
    session = await launch(codex, root, env)
    const created = await session.call('thread/start', { model, modelProvider: 'custom', cwd: root, ephemeral: false,
      approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'paginated', dynamicTools: [
        { type: 'function', name: 'synthetic_read', description: 'Return a synthetic saved value', inputSchema: { type: 'object', properties: {} } },
        { type: 'function', name: 'synthetic_wait', description: 'Wait for synthetic interruption without effects', inputSchema: { type: 'object', properties: {} } },
      ] })
    const threadId = created.thread.id
    const box = { URL, setTimeout, clearTimeout }
    vm.createContext(box)
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_fuel_runtime.js'), 'utf8'), box)
    const client = { hostId: 'local', sendRequest: (method, params) => session.call(method, params) }
    const manager = { hostId: 'local', requestClient: client, getConversation: id => id === threadId ? { id, hostId: 'local', modelProvider: 'custom', cwd: root } : null }
    adapter = box.createCodexConversationRecovery({ getState: () => ({ enabled: true, mode: loginMode === 'aggregate' ? 'aggregate' : 'relay', provider: 'custom', baseUrl: origin + '/v1' }),
      canResume: (cwd, state) => cwd === root && state.baseUrl === origin + '/v1' })
    adapter.attach(manager)
    const send = text => client.sendRequest('turn/start', { threadId, model, input: [{ type: 'text', text }], effort: 'medium' })
    const finished = async (started, status = 'completed') => {
      const done = await waitFor(() => session.notifications.find(n => n.method === 'turn/completed' && n.params.turn.id === started.turn.id), 'turn completion')
      assert.equal(done.params.turn.status, status, JSON.stringify(done.params.turn.error))
      return started
    }
    const toolRequest = async (started, name) => {
      const request = await waitFor(() => session.serverRequests.find(r => r.method === 'item/tool/call' && r.params.turnId === started.turn.id), 'real tool request')
      assert.equal(request.params.tool, name)
      assert.equal(request.params.threadId, threadId)
      toolRequests++
      return request
    }
    await finished(await send('PREFIX_KEEP: the original project goal must survive'))
    const read = await send('RUN_READ')
    const readRequest = await toolRequest(read, 'synthetic_read')
    readExecutions++
    session.reply(readRequest, { success: true, contentItems: [{ type: 'inputText', text: 'SAVED_RESULT_42' }] })
    await finished(read)
    assert.ok(JSON.stringify(requests.at(-1).input).includes('SAVED_RESULT_42'))
    const stopped = await send('RUN_WAIT')
    await toolRequest(stopped, 'synthetic_wait')
    await client.sendRequest('turn/interrupt', { threadId, turnId: stopped.turn.id })
    await finished(stopped, 'interrupted')
    await finished(await send('CONTINUE_AFTER_INTERRUPTED_TOOL'))
    const continued = JSON.stringify(requests.at(-1).input)
    for (const text of ['PREFIX_KEEP', 'SAVED_RESULT_42', 'call_wait', 'aborted']) assert.ok(continued.includes(text), text)
    const edited = await send('RUN_WAIT_EDIT')
    await toolRequest(edited, 'synthetic_wait')
    const interrupt = client.sendRequest('turn/interrupt', { threadId, turnId: edited.turn.id })
    const revert = client.sendRequest('thread/revert', { threadId, beforeTurnId: edited.turn.id })
    const resend = send('EDITED_SEND_WITH_CONTEXT')
    await Promise.all([interrupt, revert, resend.then(started => finished(started))])
    assert.ok(!JSON.stringify(requests.at(-1).input).includes('RUN_WAIT_EDIT'))
    assert.equal(session.serverRequests.filter(r => r.method === 'item/tool/call').length, 3, 'No historical tool may be executed again by recovery')
    if (loginMode !== 'aggregate') {
      await control('restart')
      await finished(await send('AFTER_SERVICE_RESTART'))
      assert.equal(session.serverRequests.filter(r => r.method === 'item/tool/call').length, 3)
    }
    await session.close()
    const snapshots = rolloutSnapshots(home)
    session = await launch(codex, root, env)
    await finished(await send('AFTER_RESTART_KEEP_CONTEXT'))
    assert.equal(adapter.status.recovered, 1)
    assert.equal(session.serverRequests.length, 0)
    for (const text of ['PREFIX_KEEP', 'SAVED_RESULT_42', 'EDITED_SEND_WITH_CONTEXT', 'AFTER_RESTART_KEEP_CONTEXT']) {
      assert.ok(JSON.stringify(requests.at(-1).input).includes(text), text)
    }
    for (const [file, bytes] of snapshots) assert.ok(fs.readFileSync(file).subarray(0, bytes.length).equals(bytes), 'Recovery must not rewrite native history')
    assert.ok(rejected >= 5, 'The same validation error must recur across turns and restarts')
    assert.equal(rejectionKinds.size, 4, 'HTTP and both streamed screenshot-error variants must all recover')
    const recovered = requests.filter(body => JSON.stringify(body.input).includes('[Recovered historical tool context'))
    assert.equal(recovered.length, rejected, 'Each rejected request must have exactly one recovery attempt')
    await session.close()
    if (loginMode === 'aggregate') {
      const shutdown = await fetch(origin + '/__shutdown', { method: 'POST', headers: { authorization: 'Bearer synthetic-only' }, body: '{}' })
      assert.ok(shutdown.ok)
    } else {
      assert.equal((await control('shutdown')).officialRestored, true)
    }
    assert.equal(await Promise.race([proxyExited, delay(5000).then(() => -2)]), 0, proxyLog)
    assert.ok(proxyLog.includes(proxyTest.split('::').at(-1) + ' ... ok'))
    console.log(JSON.stringify({ cli: session.initialized.userAgent, loginMode, sameThreadRecovered: true, readExecutions, toolRequests,
      interruptedTools: 2, editAfterStop: true, restartRecovered: true, rejected, recovered: recovered.length,
      rejectionKinds: [...rejectionKinds],
      originalContextPreserved: true, nativeHistoryPrefixUnchanged: true, productionForwarderTested: true,
      recoveryServiceRestarted: loginMode !== 'aggregate', officialRestored: loginMode !== 'aggregate', blockedExternalRequests: external }))
    success = true
  } finally {
    adapter?.dispose()
    await session?.close()
    if (proxy?.pid && proxy.exitCode === null) {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(proxy.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else proxy.kill()
      await Promise.race([proxyExited, delay(2000)])
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(path.resolve(root)), parent)
    if (success && !process.env.GAOGE_KEEP_SYNTHETIC_FIXTURE) fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
    else console.error(`Synthetic fixture retained: ${root}`)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
