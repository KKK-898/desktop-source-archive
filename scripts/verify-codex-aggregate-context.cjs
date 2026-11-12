// Verify per-model context and compaction in an isolated native app-server.
// All inference is served by loopback synthetic responses; no user home is read.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const readline = require('node:readline')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const nl = String.fromCharCode(10)
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
    // Closing the isolated app-server's input can end it before taskkill reaches
    // it. A process-already-gone race must not skip loopback server cleanup.
    if (child.exitCode !== null || child.signalCode !== null) return
    child.stdin.end()
    await Promise.race([exited, delay(800)])
    if (child.exitCode !== null || child.signalCode !== null) return
    if (process.platform === 'win32') {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
      catch (error) {
        await Promise.race([exited, delay(400)])
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(child.pid, 0) } catch (probe) { if (probe.code === 'ESRCH') return; throw probe }
          throw error
        }
      }
    } else child.kill()
    await Promise.race([exited, delay(2000)])
  }
  try {
    const initialized = await call('initialize', { clientInfo: { name: 'gaoge_aggregate_context_check', version: '1.0' }, capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + nl)
    const reply = (request, result) => child.stdin.write(JSON.stringify({ id: request.id, result }) + nl)
    return { call, notifications, serverRequests, reply, initialized, close, stderr: () => stderr }
  } catch (error) { await close(); throw error }
}

function model(slug, context, compact) {
  return { slug, display_name: slug, description: 'Synthetic context verification',
    base_instructions: 'Reply with the local synthetic answer. Do not use tools.',
    model_messages: { instructions_template: 'Reply with the local synthetic answer. Do not use tools.' },
    default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: 'Medium' }],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1000,
    supports_reasoning_summaries: false, default_reasoning_summary: 'none', support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 }, supports_parallel_tool_calls: false,
    supports_image_detail_original: false, context_window: context, max_context_window: context,
    effective_context_window_percent: 100, auto_compact_token_limit: compact,
    experimental_supported_tools: [], input_modalities: ['text'], supports_search_tool: false,
    additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null }
}
function respond(res, body, index) {
  const item = { id: 'msg_context_' + index, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Synthetic context answer. Preserve CONTEXT_PREFIX_A.', annotations: [] }] }
  const inputTokens = body.model.endsWith('/compact') ? 500 : 8000
  const response = { id: 'resp_context_' + index, object: 'response', created_at: 1, status: 'completed',
    output: [item], model: body.model, usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  events.forEach((event, sequence_number) => res.write('event: ' + event.type + nl + 'data: ' + JSON.stringify({ ...event, sequence_number }) + nl + nl))
  res.end()
}
async function main() {
  const codex = process.argv[2] || process.env.CODEX_TEST_BINARY
  assert.ok(codex, 'Provide a Codex executable argument or CODEX_TEST_BINARY')
  const parent = path.resolve(__dirname, '../src-tauri/target/aggregate-context-verification')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'run-'))
  const home = path.join(root, '.codex'); fs.mkdirSync(home)
  const models = [model('gaoge/test/one/window-a', 32768, 20000),
    model('gaoge/test/two/window-b', 65536, 50000), model('gaoge/test/three/compact', 32768, 4000),
    model('gaoge/test/four/user-window', 49152, 30000)]
  fs.writeFileSync(path.join(home, 'catalog.json'), JSON.stringify({ models }))
  const requests = [], blocked = []
  let session, success = false
  const server = http.createServer(async (req, res) => {
    try {
      if (/^https?:/i.test(req.url)) { blocked.push('proxy'); res.writeHead(403); res.end(); return }
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      requests.push({ path: req.url, body })
      if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
      respond(res, body, requests.length)
    } catch (error) { res.writeHead(500); res.end(String(error.message)) }
  })
  server.on('connect', (_req, socket) => { blocked.push('connect'); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const proxy = 'http://127.0.0.1:' + server.address().port
    const env = { ...process.env, CODEX_HOME: home, GAOGE_CONTEXT_TEST_KEY: 'synthetic-not-a-key',
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost',
      http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: '127.0.0.1,localhost' }
    delete env.OPENAI_API_KEY; delete env.OPENAI_ORG_ID; delete env.OPENAI_PROJECT_ID; delete env.ANTHROPIC_API_KEY
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model_provider = "context-test"', 'model = "' + models[0].slug + '"',
      'model_catalog_json = "' + path.join(home, 'catalog.json').replaceAll('\\', '/') + '"',
      'approval_policy = "never"', 'sandbox_mode = "read-only"',
      '[model_providers.context-test]', 'name = "Isolated context test"',
      'base_url = "' + proxy + '/v1"', 'wire_api = "responses"',
      'requires_openai_auth = false', 'env_key = "GAOGE_CONTEXT_TEST_KEY"',
    ].join(nl))
    session = await launch(codex, root, env)
    const nativeList = await session.call('model/list', { limit: 100, includeHidden: false })
    const nativeIds = (nativeList.data || []).map(entry => entry.model || entry.id)
    for (const expected of models) assert.ok(nativeIds.includes(expected.slug), 'Native model/list must retain full aggregate ID: ' + expected.slug)
    const waitFor = async predicate => {
      const deadline = Date.now() + 25000
      while (Date.now() < deadline) { const value = predicate(); if (value) return value; await delay(30) }
      throw Error('Timed out: ' + session.stderr())
    }
    const create = async selected => {
      const result = await session.call('thread/start', { model: selected.slug, modelProvider: 'context-test',
        cwd: root, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
      assert.equal(result.model, selected.slug)
      return result.thread.id
    }
    const turn = async (threadId, text) => {
      const from = session.notifications.length
      // No model override: use exactly the model retained by thread/settings/update.
      const started = await session.call('turn/start', { threadId, input: [{ type: 'text', text }] })
      const done = await waitFor(() => session.notifications.slice(from).find(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id))
      assert.equal(done.params.turn.status, 'completed', JSON.stringify(done.params.turn.error))
      const events = session.notifications.slice(from)
      const usage = events.filter(e => e.method === 'thread/tokenUsage/updated' && e.params.threadId === threadId).at(-1)
      assert.ok(usage, 'Expected authoritative native context notification')
      return { context: usage.params.tokenUsage.modelContextWindow, events }
    }
    const threadId = await create(models[0])
    const first = await turn(threadId, 'CONTEXT_PREFIX_A: remember this synthetic marker.')
    assert.equal(first.context, models[0].context_window)
    assert.equal(requests.at(-1).body.model, models[0].slug)
    await session.call('thread/settings/update', { threadId, model: models[1].slug, effort: 'medium' })
    const second = await turn(threadId, 'CONTEXT_SECOND_B: keep the original synthetic conversation.')
    assert.equal(second.context, models[1].context_window)
    assert.equal(requests.at(-1).body.model, models[1].slug)
    assert.ok(JSON.stringify(requests.at(-1).body.input).includes('CONTEXT_PREFIX_A'))
    const beforeCompaction = requests.length
    await session.call('thread/settings/update', { threadId, model: models[2].slug, effort: 'medium' })
    const compacted = await turn(threadId, 'CONTEXT_COMPACT_C: respond after the native threshold check.')
    assert.equal(compacted.context, models[2].context_window)
    const compactEvents = compacted.events.filter(e => e.params?.item?.type === 'contextCompaction' || e.method === 'thread/compacted')
    assert.ok(compactEvents.length > 0, 'Lower model-specific threshold must trigger native context compaction')
    assert.ok(requests.length - beforeCompaction >= 2, 'Native local compaction must use its own Responses request')
    assert.ok(requests.every(request => request.path === '/v1/responses'), 'Custom non-OpenAI provider must not require /responses/compact')
    const freshId = await create(models[3])
    const fresh = await turn(freshId, 'CONTEXT_NEW_D: isolated new thread with an explicit user-sized catalog entry.')
    assert.equal(fresh.context, models[3].context_window)
    const contextRequests = requests.filter(request => request.body.model === models[3].slug)
    assert.equal(contextRequests.length, 1)
    assert.ok(!JSON.stringify(contextRequests[0].body.input).includes('CONTEXT_SECOND_B'), 'Fresh thread must not inherit another conversation')
    console.log(JSON.stringify({ cli: session.initialized.userAgent,
      nativeAggregateModelsListed: nativeIds.filter(id => models.some(model => model.slug === id)).length,
      contextAfterThreadStart: first.context, contextAfterNativeModelUpdate: second.context,
      contextAfterCompactModel: compacted.context, newThreadContext: fresh.context,
      modelUpdatesPreserveHistory: true, modelSpecificCompaction: true,
      nativeLocalCompactionRequests: requests.length - beforeCompaction - contextRequests.length,
      compactEndpointsRequested: requests.filter(request => request.path.includes('/compact')).length,
      blockedExternalRequests: blocked.length, syntheticResponses: requests.length }))
    success = true
  } finally {
    try { await session?.close() } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    }
    // Delete only the exact isolated workspace created above, never a user home.
    assert.equal(path.dirname(path.resolve(root)), parent)
    assert.ok(path.basename(root).startsWith('run-'))
    if (success && !process.env.GAOGE_KEEP_SYNTHETIC_FIXTURE) {
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }) }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)) throw error
        console.error('Synthetic context verification passed; Windows still holds temporary fixture: ' + root)
      }
    } else console.error('Synthetic context fixture retained: ' + root)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
