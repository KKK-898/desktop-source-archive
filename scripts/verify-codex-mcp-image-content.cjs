// Native Codex + synthetic stdio MCP + loopback Responses mock only.
// No account config, personal images, image API, or external provider is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const zlib = require('node:zlib')
const readline = require('node:readline')
const { catalog, serve, launch, model } = require('./verify-codex-conversation-recovery.cjs')
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4nGMIWHDnPyWYYdSAUQNGDRguBgAAjJXLH15wN5kAAAAASUVORK5CYII='
const toolName = 'synthetic_view_image'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function serveTool(res, index, selected) {
  const item = { type: 'function_call', id: 'fc_synthetic_image', call_id: 'call_synthetic_image', ...selected, arguments: '{}', status: 'completed' }
  const response = { id: 'resp_image_' + index, object: 'response', created_at: 1, status: 'completed', output: [item], model,
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
  events.forEach((event, sequence_number) => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify({ ...event, sequence_number }) + '\n\n'))
  res.end()
}
function runMcp(mode) {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line)
    if (request.id === undefined) return
    let result
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-image', version: '1' } }
    else if (request.method === 'tools/list') result = { tools: [{ name: toolName, description: 'Return the synthetic local test PNG.', annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
    else if (request.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'Synthetic image.' }, { type: 'image', mimeType: 'image/png', data: png }], isError: false }
      const metadata = { resourceUri: 'ui://synthetic/image', fileName: 'synthetic.png', mimeType: 'image/png', bytes: Buffer.from(png, 'base64').length }
      if (mode === 'structured') result.structuredContent = metadata
      else result._meta = { image: metadata }
    } else result = {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  })
}
function findImages(value, output = []) {
  if (Array.isArray(value)) value.forEach(entry => findImages(entry, output))
  else if (value && typeof value === 'object') {
    if (value.type === 'input_image') output.push(value)
    Object.values(value).forEach(entry => findImages(entry, output))
  }
  return output
}
async function main() {
  const executable = process.argv[2] || process.env.CODEX_TEST_BINARY
  assert.ok(executable, 'Usage: node scripts/verify-codex-mcp-image-content.cjs <codex.exe>')
  const parent = path.resolve(__dirname, '../src-tauri/target/mcp-image-verification')
  fs.mkdirSync(parent, { recursive: true })
  const root = fs.mkdtempSync(path.join(parent, 'run-'))
  let session, activeRequests = [], success = false, external = 0, mode, handlerError
  const observations = []
  const server = http.createServer(async (req, res) => {
    try {
      if (/^https?:/i.test(req.url)) { external++; res.writeHead(403); res.end(); return }
      if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
      assert.equal(req.headers.authorization, 'Bearer synthetic-only')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      let bytes = Buffer.concat(chunks)
      if (req.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes)
      else if (req.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes)
      const body = JSON.parse(bytes.toString())
      activeRequests.push(body)
      if (activeRequests.length === 1) {
        const searchTools = (tools, prefix = '') => {
          for (const tool of tools || []) {
            if (tool.tools) { const nested = searchTools(tool.tools, tool.name + '.'); if (nested) return nested }
            else if (tool.name && tool.name.includes(toolName)) return prefix ? {name:tool.name,namespace:prefix.slice(0,-1)} : {name:tool.name}
          }
        }
        const selected = searchTools(body.tools)
        assert.ok(selected, 'Synthetic MCP tool must be available in request: ' + JSON.stringify(body.tools))
        serveTool(res, activeRequests.length, selected)
      } else serve(res, activeRequests.length, false)
    } catch(error) { handlerError = error; res.writeHead(400); res.end(error.stack) }
  })
  server.on('connect', (_req, socket) => { external++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n') })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = 'http://127.0.0.1:' + server.address().port
    for (mode of ['structured', 'content-only']) {
      const home = path.join(root, mode)
      fs.mkdirSync(home)
      const modelPath = path.join(home, 'models.json')
      const models = catalog(); models.models[0].input_modalities = ['text', 'image']
      fs.writeFileSync(modelPath, JSON.stringify(models))
      const setting = (key,value) => key + ' = ' + JSON.stringify(value)
      fs.writeFileSync(path.join(home, 'config.toml'), [
        setting('model_provider','image-test'), setting('model',model), setting('model_catalog_json',modelPath.replaceAll('\\','/')),
        setting('cli_auth_credentials_store','file'), setting('approval_policy','never'), setting('sandbox_mode','danger-full-access'),
        '[analytics]', 'enabled = false', '[mcp_servers.synthetic_image]', setting('command',process.execPath),
        'args = ' + JSON.stringify([__filename,'--mcp',mode]),
        '[model_providers.image-test]', setting('name','Isolated MCP image test'), setting('base_url',origin+'/v1'), setting('wire_api','responses'), setting('env_key','GAOGE_SYNTHETIC_IMAGE_KEY'),
      ].join('\n'))
      const env = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, HOME: home, USERPROFILE: home,
        OTEL_SDK_DISABLED: 'true', GAOGE_SYNTHETIC_IMAGE_KEY: 'synthetic-only' }
      for (const key of ['OPENAI_API_KEY','CHATGPT_API_KEY','CODEX_API_KEY']) delete env[key]
      for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) env[key]=origin
      env.NO_PROXY=env.no_proxy='127.0.0.1,localhost,::1'
      activeRequests=[]
      session=await launch(executable,root,env)
      const created=await session.call('thread/start',{model,modelProvider:'image-test',cwd:root,ephemeral:true,approvalPolicy:'never',sandbox:'danger-full-access'})
      const started=await session.call('turn/start',{threadId:created.thread.id,model,effort:'medium',input:[{type:'text',text:'Call the synthetic image tool once, then finish.'}]})
      const end=Date.now()+30000
      while(Date.now()<end && !session.notifications.some(message=>message.method==='turn/completed' && message.params.turn.id===started.turn.id)) await delay(25)
      const completed=session.notifications.find(message=>message.method==='turn/completed' && message.params.turn.id===started.turn.id)
      assert.ok(completed,'Native MCP image turn timed out: '+session.stderr())
      if(handlerError) throw handlerError
      assert.equal(completed.params.turn.status,'completed',JSON.stringify(completed.params.turn.error))
      assert.equal(activeRequests.length,2,'One local call plus one post-tool request expected')
      const toolResult = session.notifications.find(message=>message.method==='item/completed' && message.params.item.type==='mcpToolCall')?.params.item
      assert.equal(toolResult?.status,'completed',JSON.stringify(toolResult))
      const input=activeRequests[1].input
      fs.writeFileSync(path.join(home,'request.json'),JSON.stringify(activeRequests[1],null,2))
      fs.writeFileSync(path.join(home,'notifications.json'),JSON.stringify(session.notifications,null,2))
      const images=findImages(input)
      observations.push({mode,inputImageCount:images.length,exactPngPresent:images.some(image=>image.image_url === 'data:image/png;base64,'+png),toolOutputTypes:input.filter(item=>item.type==='function_call_output').map(item=>typeof item.output)})
      fs.writeFileSync(path.join(home,'observation.json'),JSON.stringify(observations.at(-1),null,2))
      await session.close(); session=null
    }
    // Startup feature/telemetry attempts are rejected by this loopback proxy.
    // No request is forwarded to any external host.
    assert.equal(observations[1].inputImageCount,1,'Content-only MCP result must preserve the visual input')
    assert.equal(observations[1].exactPngPresent,true,'Original synthetic image must reach next model request')
    console.log(JSON.stringify({executable,observations,blockedExternalAttempts:external,forwardedExternalRequests:0},null,2))
    success=true
  } finally {
    if(session) await session.close()
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve))
    assert.equal(path.dirname(path.resolve(root)),parent)
    if(success && !process.env.GAOGE_KEEP_SYNTHETIC_FIXTURE) fs.rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:300})
    else console.error('Synthetic fixture retained: '+root)
  }
}
if(process.argv[2]==='--mcp') runMcp(process.argv[3])
else main().catch(error=>{console.error(error);process.exitCode=1})
