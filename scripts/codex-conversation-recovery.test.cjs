const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

function fixture(handler, overrides = {}) {
  const box = { setTimeout, clearTimeout, URL }
  vm.createContext(box)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_fuel_runtime.js'), 'utf8'), box)
  const state = { enabled: true, mode: 'relay', provider: 'custom', baseUrl: 'https://relay.example.invalid/v1' }
  const calls = []
  const client = { hostId: 'local', sendRequest(method, params, ...rest) {
    calls.push({ method, params, rest, receiver: this })
    return handler(method, params, ...rest)
  } }
  const original = client.sendRequest
  const manager = { hostId: 'local', requestClient: client, getConversation: id => ({
    id, hostId: 'local', modelProvider: 'custom', cwd: 'D:/synthetic-project',
  }) }
  const recovery = box.createCodexConversationRecovery({ getState: () => state, canResume: () => true, ...overrides })
  recovery.attach(manager)
  return { client, original, manager, recovery, calls, state }
}
const missing = id => new Error(`thread not found: ${id}`)
const tick = () => new Promise(resolve => setImmediate(resolve))

test('missing thread resumes the same conversation once and preserves the outgoing message', async () => {
  let sends = 0
  const f = fixture((method, params) => {
    if (method === 'thread/resume') return { thread: { id: params.threadId } }
    if (++sends === 1) throw missing(params.threadId)
    return { turn: { id: 'accepted-turn' } }
  })
  const params = { threadId: 'thread-a', input: [{ type: 'text', text: 'original draft' }], model: 'original-model' }
  const options = { requestId: 'preserve-options' }
  assert.equal((await f.client.sendRequest('turn/start', params, options)).turn.id, 'accepted-turn')
  assert.deepEqual(f.calls.map(c => c.method), ['turn/start', 'thread/resume', 'turn/start'])
  assert.equal(f.calls[0].params, params)
  assert.equal(f.calls[2].params, params)
  assert.equal(f.calls[2].rest[0], options)
  assert.equal(f.calls[2].receiver, f.client)
  assert.equal(f.recovery.status.recovered, 1)
  f.recovery.dispose()
  assert.equal(f.client.sendRequest, f.original)
})

test('stop then paginated edit then send waits for each native acknowledgement', async () => {
  const release = {}
  const f = fixture(method => new Promise(resolve => { release[method] = resolve }))
  const stopped = f.client.sendRequest('turn/interrupt', { threadId: 'thread-a', turnId: 'old-turn' })
  const edited = f.client.sendRequest('thread/revert', { threadId: 'thread-a', beforeTurnId: 'old-turn' })
  const sent = f.client.sendRequest('turn/start', { threadId: 'thread-a', input: [] })
  await tick()
  assert.deepEqual(f.calls.map(c => c.method), ['turn/interrupt'])
  release['turn/interrupt']({})
  await stopped; await tick()
  assert.deepEqual(f.calls.map(c => c.method), ['turn/interrupt', 'thread/revert'])
  release['thread/revert']({})
  await edited; await tick()
  release['turn/start']({ accepted: true })
  assert.equal((await sent).accepted, true)
  f.recovery.dispose()
})

test('a failed edit rejects its queued send but does not poison later explicit attempts', async () => {
  let rejectEdit
  const f = fixture(method => method === 'thread/rollback'
    ? new Promise((_, reject) => { rejectEdit = reject }) : { accepted: true })
  const edit = f.client.sendRequest('thread/rollback', { threadId: 'thread-a', numTurns: 1 })
  const send = f.client.sendRequest('turn/start', { threadId: 'thread-a', input: [] })
  const anotherSend = f.client.sendRequest('turn/start', { threadId: 'thread-a', input: [] })
  const checked = Promise.all([assert.rejects(edit, /edit failed/), assert.rejects(send, /edit failed/),
    assert.rejects(anotherSend, /edit failed/)])
  await tick(); rejectEdit(new Error('edit failed')); await checked
  assert.deepEqual(f.calls.map(c => c.method), ['thread/rollback'])
  assert.equal((await f.client.sendRequest('turn/start', { threadId: 'thread-a' })).accepted, true)
  f.recovery.dispose()
})

test('uncertain network errors and unrelated thread errors never resend a message', async () => {
  for (const message of ['network timeout', 'stream disconnected', 'quota exceeded', 'thread not found: another-thread']) {
    const f = fixture(() => { throw new Error(message) })
    await assert.rejects(f.client.sendRequest('turn/start', { threadId: 'thread-a' }), error => error.message === message)
    assert.equal(f.calls.length, 1)
    f.recovery.dispose()
  }
})

test('tool and lineage failures do not poison a later explicit send in the same thread', async () => {
  for (const message of [
    'stream disconnected before completion: No tool output found for custom tool call ctc_synthetic.',
    'invalid paginated history lineage for synthetic: cutoff byte offset is past the source rollout',
  ]) {
    let attempts = 0
    const f = fixture(() => {
      if (++attempts === 1) throw new Error(message)
      return { accepted: true }
    })
    await assert.rejects(f.client.sendRequest('turn/start', { threadId: 'thread-a' }), error => error.message === message)
    assert.equal(f.calls.length, 1, 'Uncertain native errors must not automatically replay a turn')
    assert.equal((await f.client.sendRequest('turn/start', { threadId: 'thread-a' })).accepted, true)
    assert.equal(f.calls.length, 2, 'A later explicit send must not inherit a rejected queue entry')
    f.recovery.dispose()
  }
})

test('resume failure and a repeated missing-thread error have no retry loop', async () => {
  const broken = fixture(method => { if (method === 'thread/resume') throw new Error('invalid paginated history lineage'); throw missing('thread-a') })
  await assert.rejects(broken.client.sendRequest('turn/start', { threadId: 'thread-a' }), /paginated history/)
  assert.equal(broken.calls.length, 2)
  broken.recovery.dispose()
  const repeat = fixture((method, params) => { if (method === 'thread/resume') return { thread: { id: params.threadId } }; throw missing(params.threadId) })
  await assert.rejects(repeat.client.sendRequest('turn/start', { threadId: 'thread-a' }), /thread not found/)
  assert.equal(repeat.calls.length, 3)
  repeat.recovery.dispose()
})

test('route changes and mismatched resume IDs prevent resending into another conversation', async () => {
  for (const changed of ['route', 'thread']) {
    let f
    f = fixture((method, params) => {
      if (method !== 'thread/resume') throw missing(params.threadId)
      if (changed === 'route') f.state.baseUrl = 'https://another.example.invalid/v1'
      return { thread: { id: changed === 'thread' ? 'wrong-thread' : params.threadId } }
    })
    await assert.rejects(f.client.sendRequest('turn/start', { threadId: 'thread-a' }), /thread not found/)
    assert.equal(f.calls.length, 2)
    f.recovery.dispose()
  }
})

test('resume timeout is bounded and cannot send after a late successful resume', async () => {
  let release
  const f = fixture((method, params) => {
    if (method === 'thread/resume') return new Promise(resolve => { release = resolve })
    throw missing(params.threadId)
  }, { resumeTimeoutMs: 15 })
  await assert.rejects(f.client.sendRequest('turn/start', { threadId: 'thread-a' }), /超时/)
  release({ thread: { id: 'thread-a' } }); await tick()
  assert.equal(f.calls.length, 2)
  f.recovery.dispose()
})

test('another thread stays usable while one thread is stopping', async () => {
  let release
  const f = fixture((method, params) => params.threadId === 'thread-a'
    ? new Promise(resolve => { release = resolve }) : { accepted: true })
  const stopping = f.client.sendRequest('turn/interrupt', { threadId: 'thread-a' })
  assert.equal((await f.client.sendRequest('turn/start', { threadId: 'thread-b' })).accepted, true)
  release({}); await stopping
  f.recovery.dispose()
})

test('official or remote threads retain their native request behavior', async () => {
  for (const mode of ['disabled', 'official', 'remote']) {
    const f = fixture(() => 'native-result')
    if (mode === 'disabled') f.state.enabled = false
    if (mode === 'official') f.manager.getConversation = () => ({ hostId: 'local', modelProvider: 'openai', cwd: 'D:/synthetic' })
    if (mode === 'remote') f.manager.hostId = 'remote'
    assert.equal(f.client.sendRequest('turn/start', { threadId: 'thread-a' }), 'native-result')
    assert.equal(f.calls.length, 1)
    f.recovery.dispose()
  }
})

test('an unknown project route never authorizes automatic resume or resend', async () => {
  for (const canResume of [() => false, () => { throw new Error('config loading') }]) {
    const f = fixture(() => { throw missing('thread-a') }, { canResume })
    await assert.rejects(f.client.sendRequest('turn/start', { threadId: 'thread-a' }), /thread not found/)
    assert.equal(f.calls.length, 1)
    f.recovery.dispose()
  }
})

test('changing project configuration while resuming prevents the retry', async () => {
  let confirmed = true
  const f = fixture((method, params) => {
    if (method !== 'thread/resume') throw missing(params.threadId)
    confirmed = false
    return { thread: { id: params.threadId } }
  }, { canResume: () => confirmed })
  await assert.rejects(f.client.sendRequest('turn/start', { threadId: 'thread-a' }), /thread not found/)
  assert.equal(f.calls.length, 2)
  f.recovery.dispose()
})
