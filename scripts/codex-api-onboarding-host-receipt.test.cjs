const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const asar = require('@electron/asar')
const {installedAsar} = require('./verify-codex-ultra-installed.cjs')
const {nativeOnboardingFixture} = require('./codex-api-onboarding-native-fixture.cjs')

let packagePath = process.env.CODEX_API_MODE_ASAR || process.env.CODEX_NATIVE_APP_ASAR, unavailable
if (!packagePath) { try { packagePath = installedAsar() } catch (error) { unavailable = error.message } }
const options = {skip: !packagePath && 'No installed Codex: ' + unavailable}
const contentOwner = '26.1111.21308'
let fixture, version
if (packagePath) {
  version = JSON.parse(asar.extractFile(packagePath, 'package.json')).version
  fixture = nativeOnboardingFixture(packagePath)
}
const binding = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_api_mode_bindings.js'), 'utf8')
const bind = vm.runInThisContext(binding + '\ncodexApiModeLocalOnboardingBindings;')

// Keep the genuine preload version method. A modern completion reconciliation
// must not touch the host (the sidebar bootstrap contains project records).
function receiptWindow(h) {
  const calls = []
  if (version !== contentOwner) return {window: h.window, calls}
  const bridge = h.window.electronBridge
  const window = {electronBridge: new Proxy(bridge, {get(target, name) {
    if (name !== 'getDesktopUserAgent') {calls.push(name); throw Error('Unexpected host bridge: ' + String(name))}
    return Reflect.get(target, name)
  }})}
  return {window, calls}
}

test('installed native onboarding restores a verified API completion receipt after an empty host hydration', options, async () => {
  const completed = fixture.create()
  await completed.hydrate(); await completed.login(); await completed.complete(1794134871)
  const stored = completed.globalState.get(fixture.atomsKey)
  const receipt = {projectlessCompleted: stored[fixture.completionKey], completedAt: stored[fixture.timeKey]}
  assert.deepEqual(receipt, {projectlessCompleted: true, completedAt: 1794134871}, 'Receipt must correspond to an actual native completion')
  const h = fixture.create()
  await h.hydrate()
  assert.ok(fixture.sharedKeys.includes(fixture.completionKey) && fixture.sharedKeys.includes(fixture.timeKey))
  const {window, calls} = receiptWindow(h), hostBefore = structuredClone([...h.globalState.state])
  const adapter = bind([h.record], {window})
  assert.equal(adapter.hostReady(), true)
  assert.equal(h.evaluate(), 'welcome')
  const result = adapter.synchronize(receipt, () => true)
  assert.equal(result.ready, true, JSON.stringify(result))
  assert.equal(h.evaluate(), 'app', 'A ready receipt must leave the real native welcome gate (' + result.reason + ')')
  assert.equal(h.persisted.TB(fixture.completionKey), true)
  assert.equal(h.persisted.TB(fixture.timeKey), receipt.completedAt)
  assert.equal(h.publishes.length, 0, 'a local completion receipt must not overwrite the host')
  assert.equal(adapter.synchronize(receipt, () => true).reason, 'native-completion-verified')
  assert.deepEqual(calls, [], 'both receipt projection and verification must not consult the main process')
  assert.deepEqual([...h.globalState.state], hostBefore, 'renderer projection must not persist any host field')
})

test('installed native onboarding keeps a fresh API identity on welcome without a receipt', options, async () => {
  const h = fixture.create()
  await h.hydrate()
  const {window, calls} = receiptWindow(h)
  const adapter = bind([h.record], {window})
  assert.equal(adapter.hostReady(), true)
  assert.equal(adapter.synchronize(undefined, () => true).reason, 'not-recorded')
  assert.equal(h.evaluate(), 'welcome')
  assert.equal(h.persisted.TB(fixture.completionKey), undefined)
  assert.equal(h.persisted.TB(fixture.timeKey), undefined)
  assert.equal(h.publishes.length, 0)
  assert.deepEqual(calls, [])
})

test('native API login lands on welcome and genuine first completion persists to the synthetic host', options, async () => {
  const h = fixture.create()
  await h.hydrate(); await h.login()
  assert.equal(h.navigation.at(-1), '/welcome')
  assert.equal(h.evaluate(), 'welcome')
  assert.equal(h.persisted.TB('electron:onboarding-welcome-pending'), true)
  await h.complete(1794134871)
  assert.equal(h.evaluate(), 'app')
  assert.equal(h.navigation.at(-1), '/')
  assert.equal(h.globalState.get(fixture.atomsKey)[fixture.timeKey], 1794134871)
  assert.equal(h.globalState.get(fixture.atomsKey)[fixture.completionKey], true)
  if (version === contentOwner) {
    assert.deepEqual(h.loginRequests, ['apiKey'])
    await h.hydrate()
    assert.equal(h.evaluate(), 'app', 'When native shared atoms exist they already survive API hydration')
  }
})

test('API hydration never imports a private atom or changes the previous owner during a pending transition', options, async () => {
  const previous = {userId: 'synthetic-prior-user', accountId: 'synthetic-prior-account'}
  const pending = Promise.resolve(), privateValue = {value: 'inert-prior-value'}
  const h = fixture.create({atoms: {'private-account-atom': privateValue, [fixture.completionKey]: true, [fixture.timeKey]: 1794134871}, previousOwner: previous, pendingAccountChange: pending})
  if (version !== contentOwner) h.setPendingAccountChange(pending)
  const ownerBefore = JSON.stringify(h.globalState.state.get(fixture.ownerKey))
  assert.ok(ownerBefore)
  await h.hydrate()
  assert.deepEqual(h.globalState.state.get(fixture.atomsKey)['private-account-atom'], privateValue)
  assert.equal(h.persisted.TB('private-account-atom'), undefined)
  assert.equal(JSON.stringify(h.globalState.state.get(fixture.ownerKey)), ownerBefore)
  assert.equal(h.publishes.length, 0)
})

test('native authentication, gateway and explicit replay gates take precedence over a completed API receipt', options, async () => {
  const h = fixture.create()
  await h.hydrate()
  h.persisted.JQ(fixture.timeKey, 1794134871); h.persisted.JQ(fixture.completionKey, true)
  assert.equal(h.evaluate(), 'app')
  assert.equal(h.evaluate({auth: {authMethod: 'apikey', isLoading: true}}), null)
  assert.equal(h.evaluate({gatewayOAuthReadiness: 'required'}), 'login')
  assert.equal(h.evaluate({auth: {authMethod: 'chatgpt', hasChatGptToken: false}}), 'login')
  h.persisted.JQ('electron:onboarding-override', 'welcome')
  assert.equal(h.evaluate(), 'welcome')
  assert.equal(h.publishes.length, 0)
})

test('an invalid receipt or stale API identity cannot initialize native first-use state', options, async () => {
  const h = fixture.create()
  await h.hydrate()
  const adapter = bind([h.record], {window: h.window})
  for (const evidence of [{projectlessCompleted: false, completedAt: 1794134871}, {projectlessCompleted: true, completedAt: -1},
    Object.create({projectlessCompleted: true, completedAt: 1794134871})]) {
    assert.equal(adapter.synchronize(evidence, () => true).ready, false)
  }
  adapter.synchronize({projectlessCompleted: true, completedAt: 1794134871}, () => false)
  assert.equal(h.evaluate(), 'welcome')
  assert.equal(h.persisted.TB(fixture.completionKey), undefined)
  assert.equal(h.persisted.TB(fixture.timeKey), undefined)
  assert.equal(h.publishes.length, 0)
})

test('unknown or conflicting host contracts never authorize local completion or project owner access', options, async () => {
  const h = fixture.create(); await h.hydrate()
  const future = 'Codex Desktop/26.1201.1 (Windows NT 10.0; x64)'
  const receipt = {projectlessCompleted: true, completedAt: 1794134871}
  for (const getDesktopUserAgent of [() => future, () => undefined, () => null, () => '', undefined, () => {throw Error('unavailable')}]) {
    let reads = 0
    const adapter = bind([h.record], {window: {electronBridge: {getInitialSidebarBootstrap() {reads++; return {accountScopedPersistence: false}}, getDesktopUserAgent}}})
    assert.equal(adapter.projectOwnerContract(), null)
    const result = adapter.synchronize(receipt, () => true)
    assert.equal(result.ready, false); assert.equal(result.reason, 'unknown-native-persistence')
    assert.equal(reads, 0, 'an unrecognized version never requests sidebar state')
  }
  if (version === contentOwner) {
    const {window, calls} = receiptWindow(h)
    const records = [[], [h.record, h.record], [{...h.record, exports: {...h.persisted, JQ: h.persisted.jx}}],
      [{...h.record, source: h.record.source.replace('A2:function(', 'other:function(')}],
      [{...h.record, exports: {...h.persisted, Ki: () => {throw Error('unreviewed hydration')}}}]]
    for (const invalid of records) assert.equal(bind(invalid, {window}).synchronize(receipt, () => true).ready, false)
    const adapter = bind([h.record], {window})
    h.persisted.Ki('timeout')
    assert.equal(adapter.synchronize(receipt, () => true).reason, 'awaiting-host-hydration')
    assert.deepEqual(calls, [])
  } else {
    const unscoped = fixture.create({accountScoped: false}); await unscoped.hydrate()
    const noReceipt = bind([unscoped.record], {window: unscoped.window})
    assert.equal(noReceipt.projectOwnerContract(), null)
    assert.deepEqual(noReceipt.synchronize(receipt, () => true), {ready: false, reason: 'unverified-native-completion'})
    assert.equal(unscoped.publishes.length, 0)
  }
  assert.equal(h.evaluate(), 'welcome'); assert.equal(h.persisted.TB(fixture.timeKey), undefined)
  assert.equal(h.persisted.TB(fixture.completionKey), undefined); assert.equal(h.publishes.length, 0)
})
