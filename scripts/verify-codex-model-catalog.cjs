// Verify a generated catalog against an installed Codex app-server. All
// responses come from a loopback mock; no account or provider is contacted.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const readline = require('node:readline')
const { spawn, execFileSync } = require('node:child_process')

async function main() {
  const [codex, catalogPath] = process.argv.slice(2)
  assert.ok(codex && catalogPath, 'Usage: node scripts/verify-codex-model-catalog.cjs <codex.exe> <catalog.json>')
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  const testParent = path.resolve(__dirname, '../src-tauri/target/model-catalog-verification')
  fs.mkdirSync(testParent, { recursive: true })
  const root = fs.mkdtempSync(path.join(testParent, 'run-'))
  const requests = []
  const notifications = []
  const pending = new Map()
  let child
  let exited
  let stderr = ''
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404); res.end(); return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Local catalog verification passed.', annotations: [] }] }
    const response = { id: 'resp_test', object: 'response', created_at: 1, status: 'completed',
      output: [item], model: body.model, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
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
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const env = { ...process.env, CODEX_HOME: root, GAOGE_CATALOG_TEST_KEY: 'not-a-real-key' }
    delete env.OPENAI_API_KEY
    fs.writeFileSync(path.join(root, 'config.toml'), [
      'model_provider = "catalog-test"',
      `model = ${JSON.stringify(catalog.models[0].slug)}`,
      `model_catalog_json = ${JSON.stringify(path.resolve(catalogPath).replaceAll('\\', '/'))}`,
      'approval_policy = "never"',
      'sandbox_mode = "read-only"',
      'service_tier = "fast"',
      '[features]',
      'fast_mode = true',
      '[model_providers.catalog-test]',
      'name = "Isolated catalog test"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "responses"',
      'env_key = "GAOGE_CATALOG_TEST_KEY"',
    ].join('\n'))
    child = spawn(codex, ['app-server'], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    exited = new Promise(resolve => child.once('exit', resolve))
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8000) })
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message.id !== undefined && pending.has(message.id)) {
        const handler = pending.get(message.id); pending.delete(message.id)
        message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result)
      } else if (message.method) notifications.push(message)
    })
    let nextId = 0
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out\n${stderr}`)) }, 25000)
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    const waitFor = async (predicate, description) => {
      const deadline = Date.now() + 25000
      while (Date.now() < deadline) {
        const value = predicate()
        if (value) return value
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      throw new Error(`Timed out waiting for ${description}\n${stderr}`)
    }
    await call('initialize', { clientInfo: { name: 'gaoge_catalog_check', version: '1.0' }, capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    const list = await call('model/list', { includeHidden: true, limit: 100 })
    for (const entry of catalog.models) {
      const model = list.data.find(model => model.model === entry.slug)
      assert.ok(model, `Codex did not load ${entry.slug}`)
      assert.deepEqual(model.inputModalities, entry.input_modalities, entry.slug)
    }
    const astra = catalog.models.find(m => m.slug.endsWith('/gpt-6-astra'))
    const glm = catalog.models.find(m => m.slug.endsWith('/glm-5.2'))
    assert.ok(astra && glm)
    const nativeAstra = list.data.find(m => m.model === astra.slug)
    assert.ok(nativeAstra.serviceTiers.some(tier => tier.id === 'priority' && tier.description.startsWith('2x')),
      'Codex did not load GPT-6 2x Fast metadata')
    const thread = await call('thread/start', { model: astra.slug, modelProvider: 'catalog-test', cwd: root,
      ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
    const png = path.join(root, 'pixel.png')
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'))
    async function turn(model, input, overrides = {}) {
      const startIndex = notifications.length
      const started = await call('turn/start', { threadId: thread.thread.id, model, input, effort: 'medium', ...overrides })
      const done = await waitFor(() => notifications.slice(startIndex).find(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id), 'turn completion')
      assert.equal(done.params.turn.status, 'completed', JSON.stringify(done.params.turn.error))
      const usage = notifications.slice(startIndex).filter(e => e.method === 'thread/tokenUsage/updated').at(-1)
      assert.ok(usage, 'Codex did not report the model context window')
      return usage.params.tokenUsage.modelContextWindow
    }
    const astraWindow = await turn(astra.slug, [
      { type: 'text', text: 'Describe this isolated test image.' }, { type: 'localImage', path: png },
    ])
    assert.ok(requests.at(-1).input.some(item => item.content?.some(part => part.type === 'input_image' && part.image_url.startsWith('data:image/'))),
      'Codex dropped the local image')
    assert.ok(['fast', 'priority'].includes(requests.at(-1).service_tier), 'Codex did not apply the saved Fast configuration')
    const fastTier = requests.at(-1).service_tier
    await turn(astra.slug, [{ type: 'text', text: 'Reply at explicit priority speed.' }], { serviceTier: 'priority' })
    assert.equal(requests.at(-1).service_tier, 'priority',
      'Codex did not forward the CDP adapter priority tier to the Responses request')
    await turn(astra.slug, [{ type: 'text', text: 'Reply at standard speed.' }], { serviceTier: 'default' })
    assert.ok(requests.at(-1).service_tier == null || requests.at(-1).service_tier === 'default',
      'Codex retained Fast after switching the task to Standard')
    // Switch the same task to a different context window. The next request must
    // derive its capacity from that model, not a global override from GPT-6.
    const glmWindow = await turn(glm.slug, [{ type: 'text', text: 'Reply with the local test confirmation.' }])
    assert.equal(astraWindow, Math.floor(astra.context_window * astra.effective_context_window_percent / 100))
    assert.equal(glmWindow, Math.floor(glm.context_window * glm.effective_context_window_percent / 100))
    console.log(JSON.stringify({ loadedModels: catalog.models.length, imageForwarded: true,
      gpt6FastTier: fastTier, explicitPriorityForwarded: true, standardRestored: true,
      contextAfterGpt6: astraWindow, contextAfterGlm: glmWindow, mockResponses: requests.length }))
  } finally {
    if (child && child.exitCode === null) {
      // Windows exec-server children can outlive EOF on the parent. Stop this
      // owned tree while its parent still exists, before its PID is released.
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else child.stdin.end()
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
      if (child.exitCode === null) {
        // Stop only the isolated process tree created by this verifier.
        if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else child.kill()
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
      }
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    // Only remove the exact directory created by this script.
    assert.equal(path.dirname(root), testParent)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
