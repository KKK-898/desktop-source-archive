// Verify the actual Codex app-server with synthetic credentials and loopback
// services. No personal account files or real model services are used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const readline = require('node:readline')
const { spawn, execFileSync } = require('node:child_process')

const model = 'gaoge-fuel-verification'
const relayKey = 'synthetic-paid-relay-key'
const email = 'synthetic-fuel-user@example.invalid'
const accountId = 'synthetic-fuel-account'
const answer = 'The isolated paid relay completed this turn.'
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = `${encoded({ alg: 'none', typ: 'JWT' })}.${encoded({
  sub: 'synthetic-fuel-user', email, exp: 2147483647,
  'https://api.openai.com/auth': {
    chatgpt_account_id: accountId, chatgpt_user_id: 'synthetic-fuel-user', chatgpt_plan_type: 'plus',
  },
})}.synthetic`

function catalog() {
  return { models: [{
    slug: model, display_name: 'Fuel verification', description: 'Synthetic local test model',
    model_messages: { instructions_template: 'Reply with the provided local test answer.' },
    base_instructions: 'Reply with the provided local test answer.',
    default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium', description: 'Medium' }],
    shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1000,
    supports_reasoning_summaries: false, default_reasoning_summary: 'none', support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 }, supports_parallel_tool_calls: false,
    supports_image_detail_original: false, context_window: 32768, max_context_window: 32768,
    effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'],
    supports_search_tool: false, additional_speed_tiers: [], service_tiers: [],
    availability_nux: null, upgrade: null,
  }] }
}

function sendResponse(res, requestedModel) {
  const item = { id: 'msg_fuel_fixture', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: answer, annotations: [] }] }
  const response = { id: 'resp_fuel_fixture', object: 'response', created_at: 1, status: 'completed',
    output: [item], model: requestedModel, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  events.forEach((event, sequence_number) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`))
  res.end()
}

async function main() {
  const [executable] = process.argv.slice(2)
  assert.ok(executable, 'Usage: node scripts/verify-codex-fuel-route.cjs <codex.exe>')
  const codex = path.resolve(executable)
  const testParent = path.resolve(__dirname, '../src-tauri/target/fuel-route-verification')
  fs.mkdirSync(testParent, { recursive: true })
  const root = fs.mkdtempSync(path.join(testParent, 'run-'))
  const requests = []
  const quotaRequests = []
  const notifications = []
  const pending = new Map()
  let blockedExternalRequests = 0
  let child
  let exited
  let stderr = ''
  const server = http.createServer(async (req, res) => {
    try {
      // Non-loopback traffic is routed into this rejecting proxy. It must
      // never be forwarded, even if a new Codex version adds a startup call.
      if (/^https?:\/\//i.test(req.url)) {
        blockedExternalRequests += 1
        res.writeHead(403); res.end('External network disabled by test'); return
      }
      if (req.method === 'GET' && req.url.split('?')[0].endsWith('/wham/usage')) {
        quotaRequests.push({ ownAccountToken: req.headers.authorization === `Bearer ${token}` })
        const window = seconds => ({ used_percent: 100, limit_window_seconds: seconds,
          reset_after_seconds: seconds, reset_at: Math.floor(Date.now() / 1000) + seconds })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ plan_type: 'plus', rate_limit: { allowed: false, limit_reached: true,
          primary_window: window(18000), secondary_window: window(604800) },
          credits: { has_credits: false, unlimited: false, balance: '0' } }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/relay/v1/responses') {
        res.writeHead(404); res.end(); return
      }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ body, paidRelayToken: req.headers.authorization === `Bearer ${relayKey}`,
        personalAccountToken: req.headers.authorization === `Bearer ${token}` })
      sendResponse(res, body.model)
    } catch (error) {
      res.writeHead(500); res.end(String(error.message))
    }
  })
  server.on('connect', (_req, socket) => {
    blockedExternalRequests += 1
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const env = { ...process.env, CODEX_HOME: root, OTEL_SDK_DISABLED: 'true' }
    delete env.OPENAI_API_KEY
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[name] = origin
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1'
    const catalogPath = path.join(root, 'models.json')
    fs.writeFileSync(catalogPath, JSON.stringify(catalog()))
    fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
      tokens: { id_token: token, access_token: token, refresh_token: 'synthetic-refresh-token', account_id: accountId },
    }))
    fs.writeFileSync(path.join(root, 'config.toml'), [
      'model_provider = "custom"', `model = "${model}"`,
      `model_catalog_json = ${JSON.stringify(catalogPath.replaceAll('\\', '/'))}`,
      'cli_auth_credentials_store = "file"', `chatgpt_base_url = "${origin}/backend-api"`,
      'approval_policy = "never"', 'sandbox_mode = "read-only"',
      '[analytics]', 'enabled = false',
      '[model_providers.custom]', 'name = "Gaoge"', `base_url = "${origin}/relay/v1"`,
      'wire_api = "responses"', 'requires_openai_auth = true',
      `experimental_bearer_token = "${relayKey}"`,
    ].join('\n'))

    child = spawn(codex, ['app-server'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    exited = new Promise(resolve => child.once('exit', resolve))
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-6000) })
    child.on('error', error => {
      for (const handler of pending.values()) handler.reject(error)
      pending.clear()
    })
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (pending.has(message.id)) {
        const handler = pending.get(message.id); pending.delete(message.id)
        message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result)
      } else if (message.method) notifications.push(message)
    })
    let nextId = 0
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out\n${stderr}`)) }, 25000)
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) } })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    const initialized = await call('initialize', { clientInfo: { name: 'gaoge_fuel_verification', version: '1.0' },
      capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    const account = await call('account/read', { refreshToken: false })
    assert.equal(account.account?.type, 'chatgpt')
    assert.equal(account.account.email, email)
    assert.equal(account.requiresOpenaiAuth, true)
    const quota = await call('account/rateLimits/read', {})
    assert.ok(quotaRequests.length > 0, 'Codex did not request the local official quota fixture')
    assert.ok(quotaRequests.every(request => request.ownAccountToken), 'Official quota did not use the account token')
    assert.equal(quota.rateLimits.primary.usedPercent, 100)
    assert.equal(quota.rateLimits.secondary.usedPercent, 100)
    assert.equal(quota.rateLimits.credits.hasCredits, false)
    const thread = await call('thread/start', { model, modelProvider: 'custom', cwd: root,
      ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
    const started = await call('turn/start', { threadId: thread.thread.id, model,
      input: [{ type: 'text', text: 'Reply with the local test confirmation.' }], effort: 'medium' })
    const deadline = Date.now() + 25000
    let completed
    while (Date.now() < deadline) {
      completed = notifications.find(event => event.method === 'turn/completed' && event.params.turn.id === started.turn.id)
      if (completed) break
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    assert.ok(completed, `No turn completion received\n${stderr}`)
    assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn.error))
    assert.ok(requests.length > 0, 'The paid relay received no Responses request')
    assert.ok(requests.every(request => request.paidRelayToken && !request.personalAccountToken),
      'The Responses request did not exclusively use the paid relay credential')
    assert.ok(requests.every(request => request.body.model === model))
    assert.ok(notifications.some(event => event.method === 'item/completed'
      && event.params.item?.type === 'agentMessage' && event.params.item.text === answer),
    'Codex did not deliver the paid relay answer to the client')
    const finalAccount = await call('account/read', { refreshToken: false })
    assert.equal(finalAccount.account.email, email)
    console.log(JSON.stringify({ cli: initialized.userAgent, chatgptIdentityPreserved: true,
      officialPrimaryUsedPercent: 100, officialSecondaryUsedPercent: 100, officialCreditsAvailable: false,
      officialQuotaRequests: quotaRequests.length, relayRequests: requests.length,
      relayCredentialVerified: true, turnCompleted: true, answerDelivered: true, blockedExternalRequests }))
  } finally {
    if (child?.pid && child.exitCode === null) {
      // Stop only the owned test process tree, never the user's desktop app.
      if (process.platform === 'win32') {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
      } else child.kill()
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
    }
    server.closeAllConnections()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    const resolvedRoot = fs.realpathSync(root)
    const resolvedParent = fs.realpathSync(testParent)
    assert.equal(path.dirname(resolvedRoot), resolvedParent)
    fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
