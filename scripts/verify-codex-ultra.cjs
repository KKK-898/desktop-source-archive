// Optional native integration check. Uses synthetic input, a temporary Codex
// home and a loopback Responses mock; never reads the user's Codex account.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { catalog, launch } = require('./verify-codex-conversation-recovery.cjs')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function respond(res, body, index) {
  const item = { id: `msg_ultra_${index}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Synthetic local answer.', annotations: [] }] }
  const response = { id: `resp_ultra_${index}`, object: 'response', created_at: 1, status: 'completed',
    model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  events.forEach((event, sequence_number) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`))
  res.end()
}

async function main() {
  const codex = process.argv[2] || process.env.CODEX_TEST_BINARY
  const catalogPath = process.argv[3]
  const selectedModel = process.argv[4]
  assert.ok(codex, 'Usage: node scripts/verify-codex-ultra.cjs <codex.exe> [catalog.json] [model-slug]')
  const models = catalogPath ? JSON.parse(fs.readFileSync(path.resolve(catalogPath), 'utf8')) : catalog()
  if (!catalogPath) {
    models.models[0].slug = 'gpt-6-astra'
    models.models[0].display_name = 'Synthetic Ultra verification'
    models.models[0].supported_reasoning_levels = ['medium', 'max', 'ultra'].map(effort => ({ effort, description: effort }))
    models.models[0].multi_agent_version = 'v2'
  }
  const modelEntry = models.models.find(entry => selectedModel ? entry.slug === selectedModel
    : entry.supported_reasoning_levels?.some(level => level.effort === 'ultra'))
  assert.ok(modelEntry, 'The catalog must contain the selected model, or a model supporting Ultra')
  assert.equal(modelEntry.multi_agent_version, 'v2', 'The actual catalog must preserve native v2 delegation for Ultra')
  for (const effort of ['medium', 'max', 'ultra']) {
    assert.ok(modelEntry.supported_reasoning_levels.some(level => level.effort === effort), `${modelEntry.slug} must support ${effort}`)
  }
  const model = modelEntry.slug
  const testParent = path.resolve(__dirname, '../src-tauri/target/ultra-verification')
  fs.mkdirSync(testParent, { recursive: true })
  const testRoot = fs.mkdtempSync(path.join(testParent, 'run-'))
  const testHome = path.join(testRoot, '.codex')
  fs.mkdirSync(testHome)
  const requests = []
  let blockedExternalRequests = 0
  let session
  const server = http.createServer(async (req, res) => {
    try {
      // This also serves as a rejecting proxy for anything except loopback.
      if (/^https?:/i.test(req.url)) { blockedExternalRequests++; res.writeHead(403); res.end(); return }
      if (req.url !== '/v1/responses' || req.method !== 'POST') { res.writeHead(404); res.end(); return }
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      respond(res, body, requests.length)
    } catch (error) { res.writeHead(500); res.end(error.message) }
  })
  server.on('connect', (_req, socket) => {
    blockedExternalRequests++
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) { const result = predicate(); if (result) return result; await delay(25) }
    throw new Error(`Timed out: ${label}; ${session?.stderr()}`)
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
    const env = { ...process.env, CODEX_HOME: testHome, CODEX_SQLITE_HOME: testHome,
      HOME: testRoot, USERPROFILE: testRoot, OTEL_SDK_DISABLED: 'true', GAOGE_ULTRA_TEST_KEY: 'synthetic-only' }
    delete env.OPENAI_API_KEY
    delete env.CHATGPT_API_KEY
    delete env.CODEX_API_KEY
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = origin
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1'
    const modelPath = path.join(testHome, 'models.json')
    const setting = (key, value) => `${key} = ${JSON.stringify(value)}`
    fs.writeFileSync(path.join(testHome, 'config.toml'), [
      setting('model_provider', 'ultra-test'), setting('model', model),
      setting('model_catalog_json', modelPath.replaceAll('\\', '/')),
      setting('cli_auth_credentials_store', 'file'), setting('approval_policy', 'never'), setting('sandbox_mode', 'read-only'),
      '[analytics]', 'enabled = false', '[model_providers.ultra-test]', setting('name', 'Isolated Ultra test'),
      setting('base_url', `${origin}/v1`), setting('wire_api', 'responses'), setting('env_key', 'GAOGE_ULTRA_TEST_KEY'),
    ].join('\n'))
    const observations = []
    for (const agentVersion of ['missing', 'v2']) {
      // Compare the previous metadata sanitizer with the native v2 field.
      // No Statsig, feature flag, or code-mode override is involved.
      if (agentVersion === 'v2') modelEntry.multi_agent_version = 'v2'
      else delete modelEntry.multi_agent_version
      fs.writeFileSync(modelPath, JSON.stringify(models))
      session = await launch(codex, testRoot, env)
      const available = await session.call('model/list', { includeHidden: true, limit: 100 })
      const entry = available.data.find(entry => entry.model === model)
      assert.ok(entry, 'Native app-server did not load the synthetic catalog')
      assert.ok(entry.supportedReasoningEfforts.some(entry => entry.reasoningEffort === 'ultra'), 'Native app-server removed Ultra')
      for (const effort of ['medium', 'max', 'ultra']) {
        const created = await session.call('thread/start', { model, modelProvider: 'ultra-test', cwd: testRoot,
          ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
        const requestCount = requests.length
        const started = await session.call('turn/start', { threadId: created.thread.id, model, effort,
          // This is the actual desktop submission mode, including for Ultra.
          multiAgentMode: 'explicitRequestOnly', input: [{ type: 'text', text: `Reply with the synthetic ${effort} check.` }] })
        const completed = await waitFor(() => session.notifications.find(message => message.method === 'turn/completed'
          && message.params.turn.id === started.turn.id), `${effort} turn completion`)
        assert.equal(completed.params.turn.status, 'completed', JSON.stringify(completed.params.turn.error))
        assert.equal(requests.length, requestCount + 1, 'Unexpected extra model requests')
        const body = requests.at(-1)
        assert.equal(body.model, model)
        assert.equal(body.reasoning?.effort, effort === 'ultra' ? 'max' : effort,
          'Native Ultra must normalize to maximum model reasoning')
        const serialized = JSON.stringify(body)
        const proactiveDelegation = serialized.includes('Proactive multi-agent delegation is active.')
        const toolNames = body.tools?.map(tool => tool.name || tool.type) || []
        assert.equal(proactiveDelegation, agentVersion === 'v2' && effort === 'ultra',
          'Only v2 Ultra should enable proactive delegation')
        assert.ok(toolNames.includes(agentVersion === 'v2' ? 'collaboration' : 'multi_agent_v1'),
          'Native agent tools must match model metadata')
        if (agentVersion === 'v2' && effort !== 'ultra') {
          assert.ok(serialized.includes('Any earlier instruction enabling proactive multi-agent delegation no longer applies.'),
            'Medium and Max must preserve explicit-request-only delegation')
        }
        observations.push({ modelMultiAgentVersion: agentVersion, selectedEffort: effort,
          requestEffort: body.reasoning.effort, proactiveDelegation,
          agentToolNamespace: agentVersion === 'v2' ? 'collaboration' : 'multi_agent_v1' })
      }
      await session.close()
    }
    console.log(JSON.stringify({ cli: session.initialized.userAgent, model, catalogSource: catalogPath ? 'provided' : 'synthetic',
      nativeUltraListed: true, gateOverrides: false, observations, mockResponses: requests.length, blockedExternalRequests }))
  } finally {
    // A process-stop race must not leave the mock listener or fixture behind.
    // Keep these steps sequential so the child is stopped before file removal.
    try {
      await session?.close()
    } finally {
      try {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      } finally {
        // Delete only the unique fixture directory owned by this invocation.
        assert.equal(path.dirname(path.resolve(testRoot)), testParent)
        fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
      }
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
