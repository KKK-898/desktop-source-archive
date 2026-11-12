const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8')
const functionSource = source.slice(source.indexOf('fn codex_session_delete_bridge_instance_script('),
  source.indexOf('fn parse_codex_session_delete_bridge_call('))
const template = functionSource.match(/r#"([\s\S]*?)"#/)[1]
const healthSource = source.slice(source.indexOf('fn codex_session_delete_bridge_health_script('),
  source.indexOf('fn codex_session_delete_bridge_instance_script('))
const healthTemplate = healthSource.match(/r#"([\s\S]*?)"#/)[1]
const readySource = source.slice(source.indexOf('fn codex_session_delete_bridge_ready_script('),
  source.indexOf('fn codex_session_delete_bridge_health_script('))
const readyTemplate = readySource.match(/r#"([\s\S]*?)"#/)[1]


function fixture(options = {}) {
  const calls = [], events = []
  const timers = new Map()
  let timerId = 0, installId = 0, bindingFailure = false
  const window = {
    fixtureBinding: text => {
      if (bindingFailure) throw new Error('sensitive fixture source')
      calls.push(JSON.parse(text))
    },
    dispatchEvent: event => {
      assert.equal(typeof window.__gaogeSessionDeleteBridge, 'function')
      assert.equal(typeof window.__gaogeSessionDeleteResolve, 'function')
      assert.equal(window.__gaogeSessionDeleteBridgeRuntime.healthy(), true)
      events.push(event.type)
      return true
    },
  }
  window.top = options.subframe ? {} : window
  const context = vm.createContext({
    window,
    Event: class Event { constructor(type) { this.type = type } },
    setTimeout: (callback, milliseconds) => {
      const id = ++timerId
      timers.set(id, { callback, milliseconds })
      return id
    },
    clearTimeout: id => timers.delete(id),
  })
  const install = (token, instance = token, expectedOwner = window.__gaogeSessionDeleteBridgeRuntime?.instance ?? null) => vm.runInContext(template
    .replace('{binding_name}', '"fixtureBinding"')
    .replace('{binding_token}', JSON.stringify(token))
    .replace('{instance}', JSON.stringify(instance))
    .replace('{expected_owner}', JSON.stringify(expectedOwner))
    .replace('{request_prefix}', JSON.stringify(String(++installId)))
    .replaceAll('{{', '{').replaceAll('}}', '}'), context)
  const health = (instance = 'first-connection') => vm.runInContext(healthTemplate
    .replace('{instance}', JSON.stringify(instance))
    .replaceAll('{{', '{').replaceAll('}}', '}'), context)
  if (options.auto !== false) install('first-connection')
  const expire = milliseconds => {
    for (const [id, timer] of [...timers]) {
      if (timer.milliseconds <= milliseconds) {
        timers.delete(id)
        timer.callback()
      }
    }
  }
  return { calls, timers, events, context, install, health, expire, window,
    failBinding() { bindingFailure = true } }
}

test('fuel callback expiration releases pending entries and ignores a late reply', async () => {
  const f = fixture()
  const pending = f.window.__gaogeSessionDeleteBridge('/fuel/status')
  const id = f.calls.at(-1).id
  assert.match(id, /^\d{1,20}$/)
  assert.equal(f.window.__gaogeSessionDeleteCallbacks.size, 1)
  f.expire(1800)
  assert.equal((await pending).ok, false)
  assert.equal(f.window.__gaogeSessionDeleteCallbacks.size, 0)
  f.window.__gaogeSessionDeleteResolve(id, { ok: true }, 'first-connection')
  assert.equal(f.window.__gaogeSessionDeleteCallbacks.size, 0)
  assert.equal(f.timers.size, 0)
})

test('replacing the owner rejects old callbacks and ignores old-token replies', async () => {
  const f = fixture()
  const old = f.window.__gaogeSessionDeleteBridge('/account/balance')
  f.install('replacement-connection')
  assert.equal((await old).ok, false)
  assert.equal(f.timers.size, 0)
  const current = f.window.__gaogeSessionDeleteBridge('/account/balance')
  const id = f.calls.at(-1).id
  f.window.__gaogeSessionDeleteResolve(id, { ok: true, balance: 999 }, 'first-connection')
  assert.equal(f.window.__gaogeSessionDeleteCallbacks.size, 1)
  f.window.__gaogeSessionDeleteResolve(id, { ok: true, balance: 42 }, 'replacement-connection')
  assert.equal((await current).balance, 42)
  assert.equal(f.timers.size, 0)
})

test('same-owner repair gives new requests distinct ids and rejects calls from the old closure', async () => {
  const f = fixture()
  const oldBridge = f.window.__gaogeSessionDeleteBridge
  const old = oldBridge('/account/balance')
  const oldId = f.calls.at(-1).id
  delete f.window.__gaogeSessionDeleteBridge
  assert.equal(f.health().ready, false)
  assert.equal(f.install('first-connection').ready, true)
  assert.equal((await old).ok, false)
  assert.equal((await oldBridge('/account/balance')).ok, false)
  assert.equal(f.calls.length, 1)
  const current = f.window.__gaogeSessionDeleteBridge('/account/balance')
  const id = f.calls.at(-1).id
  assert.notEqual(id, oldId)
  f.window.__gaogeSessionDeleteResolve(oldId, { ok: true, balance: 999 }, 'first-connection')
  assert.equal(f.window.__gaogeSessionDeleteCallbacks.size, 1)
  f.window.__gaogeSessionDeleteResolve(id, { ok: true, balance: 42 }, 'first-connection')
  assert.equal((await current).balance, 42)
  assert.deepEqual(f.events, ['gaoge:runtime-bridge-ready', 'gaoge:runtime-bridge-ready'])
})

test('healthy probes and installs preserve callbacks, function identity and readiness event count', async () => {
  const f = fixture()
  const oldBridge = f.window.__gaogeSessionDeleteBridge
  const callbacks = f.window.__gaogeSessionDeleteCallbacks
  const pending = oldBridge('/status')
  assert.equal(f.health().ready, true)
  assert.equal(f.install('first-connection').ready, true)
  assert.equal(f.window.__gaogeSessionDeleteBridge, oldBridge)
  assert.equal(f.window.__gaogeSessionDeleteCallbacks, callbacks)
  assert.equal(callbacks.size, 1)
  assert.equal(f.events.length, 1)
  f.window.__gaogeSessionDeleteResolve(f.calls.at(-1).id, { ok: true }, 'first-connection')
  assert.equal((await pending).ok, true)
})

test('an old install cannot overwrite a newer bridge owner', () => {
  const f = fixture()
  f.install('new-connection')
  const bridge = f.window.__gaogeSessionDeleteBridge
  assert.equal(f.install('first-connection', 'first-connection', 'first-connection').ready, false)
  assert.equal(f.window.__gaogeSessionDeleteBridge, bridge)
  assert.equal(f.health('new-connection').ready, true)
  assert.equal(f.events.length, 2)
})

test('subframes do not receive bridge wrappers or readiness events', () => {
  const f = fixture({ subframe: true, auto: false })
  assert.equal(f.install('first-connection').ready, false)
  assert.equal(f.health().ready, false)
  assert.equal(typeof f.window.__gaogeSessionDeleteBridge, 'undefined')
  assert.equal(f.events.length, 0)
})

test('health requires the native binding and every wrapper reference', () => {
  for (const name of ['fixtureBinding', '__gaogeSessionDeleteBridge', '__gaogeSessionDeleteResolve',
    '__gaogeSessionDeleteCallbacks', '__gaogeSessionDeleteBridgeReady', '__gaogeSessionDeleteBridgeRuntime']) {
    const f = fixture()
    assert.equal(f.health().ready, true)
    delete f.window[name]
    assert.equal(f.health().ready, false, name)
  }
})

test('disconnected bridge callbacks remain bounded and expire', async () => {
  const f = fixture()
  const pending = Array.from({ length: 256 }, () => f.window.__gaogeSessionDeleteBridge('/status'))
  assert.equal((await f.window.__gaogeSessionDeleteBridge('/status')).ok, false)
  assert.equal(f.calls.length, 256)
  assert.equal(f.window.__gaogeSessionDeleteCallbacks.size, 256)
  f.expire(60000)
  assert.ok((await Promise.all(pending)).every(result => result.ok === false))
  assert.equal(f.window.__gaogeSessionDeleteCallbacks.size, 0)
  assert.equal(f.timers.size, 0)
})

test('binding failures remove callbacks and timers without leaking the exception', async () => {
  const f = fixture()
  f.failBinding()
  const result = await f.window.__gaogeSessionDeleteBridge('/fuel/status')
  assert.equal(result.ok, false)
  assert.ok(!result.message.includes('sensitive'))
  assert.equal(f.window.__gaogeSessionDeleteCallbacks.size, 0)
  assert.equal(f.timers.size, 0)
})

test('a broken stale callback cannot prevent a complete repair', () => {
  const f = fixture()
  f.window.__gaogeSessionDeleteCallbacks.set('broken', { resolve() { throw new Error('old callback') } })
  delete f.window.__gaogeSessionDeleteBridge
  assert.equal(f.install('first-connection').ready, true)
  assert.equal(f.health().ready, true)
  assert.equal(f.events.length, 2)
})

test('watcher health rejects missing wrappers even when the ready flag remains true', () => {
  const watcher = source.slice(source.indexOf('fn cdp_runtime_revision_matches('),
    source.indexOf('fn codex_runtime_healthcheck_verified('))
  assert.ok(watcher.includes('let bridge_ready = codex_session_delete_bridge_ready_script();'))
  assert.ok(watcher.includes('&& {bridge_ready} &&'))
  for (const name of ['fixtureBinding', '__gaogeSessionDeleteBridge', '__gaogeSessionDeleteResolve',
    '__gaogeSessionDeleteCallbacks']) {
    const f = fixture()
    assert.equal(vm.runInContext(readyTemplate, f.context), true)
    delete f.window[name]
    assert.equal(f.window.__gaogeSessionDeleteBridgeReady, true)
    assert.equal(vm.runInContext(readyTemplate, f.context), false, name)
  }
})
