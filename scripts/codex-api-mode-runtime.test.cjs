const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const { readNativeApiModeFixture } = require('./codex-api-mode-native-fixture.cjs')
const { installedAsar } = require('./verify-codex-ultra-installed.cjs')

const runtimeSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_api_mode_runtime.js'), 'utf8')
let packagePath = process.env.CODEX_API_MODE_ASAR
let unavailable = ''
if (!packagePath) {
  try { packagePath = installedAsar() }
  catch (error) { unavailable = error.message }
}
// An absent installation is explicitly skipped for portable developer runs.
// A supplied/found installation with an unsupported contract must fail.
const isWebpack = packagePath && !require('@electron/asar').listPackage(packagePath).some(name => /app-initial-[^\\/]+\.js$/.test(name))
const legacyTest = isWebpack ? () => {} : test
const fixture = packagePath && !isWebpack ? readNativeApiModeFixture(packagePath) : null

const nativeOptions = { skip: !fixture && `Installed Codex is required: ${unavailable}` }
const createGuard = vm.runInNewContext(runtimeSource + '\ncreateCodexApiModeGuard;', {})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const apiIdentity = stableId => ({ accountId: null, userId: null, authMethod: 'apikey', stableId })
const chatgptIdentity = { accountId: 'synthetic-account', userId: 'synthetic-user', authMethod: 'chatgpt', stableId: 'synthetic-device' }

function harness({ identity = apiIdentity('synthetic-device'), policy = 'everyday', beforePublish, guardFactory = createGuard } = {}) {
  const native = new Function('dependencies', fixture.factorySource)({})
  const current = { identity, authMethod: identity?.authMethod || null, authLoading: false, detailLevel: 'STEPS_PROSE' }
  const settings = native.createSettings({ identity, configuredMode: 'STEPS_PROSE', access: identity ? [{ ...identity, policy }] : [] })
  settings.statsig.readExecutionAssignments = async () => current.identity ? { identity: current.identity } : null
  const nativePublish = settings.publish
  if (beforePublish) settings.publish = async function (payload) {
    await beforePublish(payload)
    return nativePublish.call(this, payload)
  }
  const originalWrite = settings.write, originalPublish = settings.publish
  const services = { settings, workModeAccess: settings }
  const scope = {}
  let state = { apiCodingModeEnabled: true }
  let setCodingCalls = 0
  let notices = 0
  const bindings = {
    appServices: services,
    scopes: () => [scope],
    read: () => ({ ...current, policy: settings.workModeAccessByAccount.find(value => current.identity && native.sameIdentity(current.identity, value))?.policy }),
    setCoding: async value => {
      assert.equal(value, scope)
      setCodingCalls++
      current.detailLevel = 'STEPS_COMMANDS'
      await services.settings.write(native.modeKey, 'STEPS_COMMANDS')
    },
  }
  const guard = guardFactory(bindings, { getState: () => state, notify: () => { notices++ } })
  const principalReads = []
  const connection = { hostConfig: { kind: 'local' }, getCachedAuthenticatedPrincipal: () => {
    const principal = current.authMethod === 'chatgpt' ? current.identity : null
    principalReads.push(principal)
    return principal
  } }
  const browserConfig = async () => native.browserConfig({
    appServerConnection: connection,
    requireWorkBrowserIdentity: await settings.getEffective(native.modeKey) === 'STEPS_PROSE',
  })
  return { native, current, settings, services, bindings, guard, connection, browserConfig, principalReads,
    originalWrite, originalPublish, nativePublish, setState: value => { state = value },
    get setCodingCalls() { return setCodingCalls }, get notices() { return notices } }
}

legacyTest('installed native API Work fails before normalization and real coding policy clears the guard without an identity', nativeOptions, async t => {
  const h = harness()
  t.after(() => h.guard.dispose())
  assert.equal(await h.settings.getEffective(h.native.modeKey), 'STEPS_PROSE')
  await assert.rejects(h.browserConfig(), /Work browser access requires an authenticated account/)
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, true)
  assert.equal(h.guard.status().reason, 'coding')
  const readback = await h.settings.read(h.native.modeKey)
  assert.equal(readback.configured, 'STEPS_COMMANDS')
  assert.equal(readback.effective, 'STEPS_COMMANDS')
  assert.equal(h.current.detailLevel, 'STEPS_COMMANDS')
  assert.equal(h.settings.workModeAccessByAccount[0].policy, 'coding')
  const result = await h.browserConfig()
  assert.equal(result['mcp_servers.node_repl'].env.BROWSER_USE_ACCESS_EXECUTOR_ID, undefined)
  assert.ok(h.principalReads.length >= 2 && h.principalReads.every(value => value === null))
})

legacyTest('installed native repeated API Work selection writes COMMANDS and normalizes optimistic state', nativeOptions, async t => {
  const h = harness()
  t.after(() => h.guard.dispose())
  await h.guard.refresh()
  for (let attempt = 0; attempt < 2; attempt++) {
    h.current.detailLevel = 'STEPS_PROSE'
    await h.settings.write(h.native.modeKey, 'STEPS_PROSE')
    assert.equal(h.current.detailLevel, 'STEPS_COMMANDS')
    assert.equal(h.settings.store.get(h.native.modeKey), 'STEPS_COMMANDS', 'effective policy alone must not hide a saved PROSE value')
    await h.guard.refresh()
    assert.equal(h.guard.status().ready, true)
    await h.browserConfig()
  }
  assert.equal(h.notices, 2)
  assert.ok(h.principalReads.every(value => value === null))
})

legacyTest('installed native a pending read preserves recent verification until its bounded freshness expires', nativeOptions, async t => {
  let now = 10000
  const guardFactory = vm.runInNewContext(runtimeSource + '\ncreateCodexApiModeGuard;', { Date: { now: () => now } })
  const h = harness({ guardFactory })
  t.after(() => h.guard.dispose())
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, true)
  const release = deferred()
  const nativeRead = h.settings.read
  let reads = 0
  h.settings.read = async function (...args) {
    reads++
    await release.promise
    return nativeRead.apply(this, args)
  }
  const refreshing = h.guard.refresh()
  assert.equal(reads, 1)
  assert.equal(h.guard.status().ready, true, 'A routine asynchronous read must not produce a transient false failure')
  now += 5001
  assert.equal(h.guard.status().ready, false, 'An indefinitely pending read cannot keep verification fresh')
  release.resolve()
  await refreshing
  assert.equal(h.guard.status().ready, true)
})

legacyTest('installed native a frozen access publisher rolls back partial hooks and supports observation', nativeOptions, () => {
  const native = new Function('dependencies', fixture.factorySource)({})
  const settings = native.createSettings({ identity: apiIdentity('synthetic-device') })
  const originalWrite = settings.write
  const access = Object.freeze({ publish: settings.publish.bind(settings) })
  const originalPublish = access.publish
  const guard = createGuard({ appServices: { settings, workModeAccess: access } }, {
    getState: () => ({ apiCodingModeEnabled: true }), eventTarget: null,
  })
  assert.equal(guard.status().serviceMode, 'native-observer')
  assert.equal(settings.write, originalWrite, 'Partial write interception must be rolled back')
  assert.equal(access.publish, originalPublish)
  guard.dispose()
})

legacyTest('installed native ChatGPT retains Work, policy and authenticated principal', nativeOptions, async t => {
  const h = harness({ identity: chatgptIdentity })
  t.after(() => h.guard.dispose())
  await h.guard.refresh()
  await h.settings.write(h.native.modeKey, 'STEPS_PROSE')
  assert.equal(h.setCodingCalls, 0)
  assert.equal(h.current.detailLevel, 'STEPS_PROSE')
  assert.equal(await h.settings.getEffective(h.native.modeKey), 'STEPS_PROSE')
  assert.equal(h.settings.workModeAccessByAccount[0].policy, 'everyday')
  const result = await h.browserConfig()
  assert.equal(result['mcp_servers.node_repl'].env.BROWSER_USE_ACCESS_EXECUTOR_ID, h.native.serializePrincipal(chatgptIdentity))
})

legacyTest('installed native unknown identity and unavailable policy are not ready and never become fabricated Work access', nativeOptions, async t => {
  for (const options of [{ identity: null }, { policy: undefined }]) {
    const h = harness(options)
    t.after(() => h.guard.dispose())
    if (options.identity !== null) h.settings.workModeAccessByAccount = []
    await h.guard.refresh()
    assert.equal(h.guard.status().ready, false)
    assert.equal(await h.settings.getEffective(h.native.modeKey), undefined)
    assert.equal(h.current.detailLevel, 'STEPS_PROSE')
    assert.equal(h.setCodingCalls, 0)
    assert.equal(h.connection.getCachedAuthenticatedPrincipal(), null)
  }
})

legacyTest('installed native loading authentication and stale non-null account metadata cannot normalize Work', nativeOptions, async t => {
  for (const stale of [{ authLoading: true }, { authLoading: undefined }, { identity: { ...apiIdentity('synthetic-device'), accountId: 'stale-chatgpt-account' } }]) {
    const h = harness()
    t.after(() => h.guard.dispose())
    Object.assign(h.current, stale)
    await h.guard.refresh()
    assert.equal(h.guard.status().ready, false)
    assert.equal(h.current.detailLevel, 'STEPS_PROSE')
    assert.equal(h.setCodingCalls, 0)
    assert.equal(h.settings.workModeAccessByAccount[0].policy, 'everyday')
  }
})

legacyTest('installed native effective coding cannot certify an unchanged saved Work preference', nativeOptions, async t => {
  const h = harness()
  t.after(() => h.guard.dispose())
  h.bindings.setCoding = async () => { h.current.detailLevel = 'STEPS_COMMANDS' }
  await h.guard.refresh()
  assert.equal(await h.settings.getEffective(h.native.modeKey), 'STEPS_COMMANDS')
  assert.equal(h.settings.store.get(h.native.modeKey), 'STEPS_PROSE')
  assert.equal(h.guard.status().ready, false, 'native policy must not conceal a failed preference write')
})

legacyTest('installed native verification cannot ignore a second scope still in Work', nativeOptions, async t => {
  const h = harness()
  t.after(() => h.guard.dispose())
  await h.guard.refresh()
  const originalScopes = h.bindings.scopes, originalRead = h.bindings.read
  const secondary = {}
  h.bindings.scopes = () => [...originalScopes(), secondary]
  h.bindings.read = scope => ({ ...originalRead(scope), ...(scope === secondary ? { detailLevel: 'STEPS_PROSE' } : {}) })
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, false)
})

legacyTest('installed native account switch restores API metadata and preserves the new ChatGPT Work selection', nativeOptions, async t => {
  const h = harness()
  t.after(() => h.guard.dispose())
  const api = h.current.identity
  await h.guard.refresh()
  h.current.identity = chatgptIdentity
  h.current.authMethod = 'chatgpt'
  h.current.detailLevel = 'STEPS_PROSE'
  await h.settings.publish({ ...chatgptIdentity, policy: 'everyday' })
  h.setState({ apiCodingModeEnabled: false })
  await h.guard.refresh()
  assert.equal(h.settings.workModeAccessByAccount.find(value => h.native.sameIdentity(api, value)).policy, 'everyday')
  assert.equal(await h.settings.getEffective(h.native.modeKey), 'STEPS_PROSE')
  await h.browserConfig()
})

legacyTest('installed native dispose restores intercepted methods and original access policy', nativeOptions, async () => {
  const h = harness()
  await h.guard.refresh()
  assert.notEqual(h.settings.write, h.originalWrite)
  await h.guard.dispose()
  assert.equal(h.settings.write, h.originalWrite)
  assert.equal(h.settings.publish, h.originalPublish)
  assert.equal(h.settings.workModeAccessByAccount[0].policy, 'everyday')
  assert.equal(h.guard.status().ready, false)
  await h.settings.write(h.native.modeKey, 'STEPS_PROSE')
  assert.equal(h.settings.store.get(h.native.modeKey), 'STEPS_PROSE')
})

legacyTest('installed native publication before first refresh preserves the original policy for disposal', nativeOptions, async () => {
  const h = harness()
  try {
    await h.settings.publish({ ...h.current.identity, policy: 'everyday' })
    assert.equal(h.settings.workModeAccessByAccount[0].policy, 'coding')
    await h.guard.refresh()
  } finally { await h.guard.dispose() }
  assert.equal(h.settings.workModeAccessByAccount[0].policy, 'everyday')
})

legacyTest('installed native delayed intercepted publication cannot survive disposal', nativeOptions, async () => {
  const started = deferred(), release = deferred()
  let delay = false
  const h = harness({ beforePublish: async payload => {
    if (delay && payload.policy === 'coding') { started.resolve(); await release.promise }
  } })
  await h.guard.refresh()
  delay = true
  const publishing = h.settings.publish({ ...h.current.identity, policy: 'everyday' })
  await started.promise
  const disposal = h.guard.dispose()
  release.resolve()
  await Promise.all([publishing, disposal])
  assert.equal(h.settings.workModeAccessByAccount[0].policy, 'everyday')
  assert.equal(h.guard.status().ready, false)
})

legacyTest('installed native a failed intercepted publication can retry normalization', nativeOptions, async t => {
  let failOnce = true
  const h = harness({ beforePublish: async payload => {
    if (payload.policy === 'coding' && failOnce) { failOnce = false; throw new Error('synthetic transient publication failure') }
  } })
  t.after(() => h.guard.dispose())
  await assert.rejects(h.settings.publish({ ...h.current.identity, policy: 'everyday' }), /synthetic transient publication failure/)
  assert.equal(h.settings.workModeAccessByAccount[0].policy, 'everyday')
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, true)
  assert.equal(h.settings.workModeAccessByAccount[0].policy, 'coding')
})

legacyTest('installed native replaced write method invalidates verification', nativeOptions, async t => {
  const h = harness()
  t.after(() => h.guard.dispose())
  await h.guard.refresh()
  h.settings.write = async () => {}
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, false)
  assert.equal(h.guard.status().reason, 'verification-failed')
})

legacyTest('installed native replacement of a service object invalidates verification', nativeOptions, async t => {
  const h = harness()
  t.after(() => h.guard.dispose())
  await h.guard.refresh()
  h.services.settings = h.native.createSettings({ identity: h.current.identity, access: [{ ...h.current.identity, policy: 'everyday' }] })
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, false)
  assert.equal(h.guard.status().reason, 'verification-failed')
})

legacyTest('installed native replacement of all app services invalidates verification', nativeOptions, async t => {
  const h = harness()
  t.after(() => h.guard.dispose())
  await h.guard.refresh()
  h.bindings.appServices = { ...h.services }
  await h.guard.refresh()
  assert.equal(h.guard.status().ready, false)
  assert.equal(h.guard.status().reason, 'verification-failed')
})

legacyTest('installed native delayed coding publish cannot survive disposal', nativeOptions, async () => {
  const started = deferred(), release = deferred()
  const h = harness({ beforePublish: async payload => {
    if (payload.policy === 'coding') { started.resolve(); await release.promise }
  } })
  const refresh = h.guard.refresh()
  await started.promise
  const disposal = h.guard.dispose()
  release.resolve()
  await Promise.all([refresh, disposal])
  assert.equal(h.settings.workModeAccessByAccount[0].policy, 'everyday')
  assert.equal(h.guard.status().ready, false)
})

legacyTest('installed native delayed coding publish cannot leak across an account change', nativeOptions, async t => {
  const started = deferred(), release = deferred()
  const h = harness({ beforePublish: async payload => {
    if (payload.policy === 'coding') { started.resolve(); await release.promise }
  } })
  t.after(() => h.guard.dispose())
  const api = h.current.identity
  const refresh = h.guard.refresh()
  await started.promise
  h.current.identity = chatgptIdentity
  h.current.authMethod = 'chatgpt'
  h.current.detailLevel = 'STEPS_PROSE'
  await h.nativePublish.call(h.settings, { ...chatgptIdentity, policy: 'everyday' })
  release.resolve()
  await refresh
  assert.equal(h.settings.workModeAccessByAccount.find(value => h.native.sameIdentity(api, value)).policy, 'everyday')
  assert.equal(await h.settings.getEffective(h.native.modeKey), 'STEPS_PROSE')
  assert.equal(h.guard.status().ready, false)
})

test('a late helper response cannot replace newer explicit disabled state', async () => {
  const response = deferred()
  const context = vm.createContext({ setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, window: {} })
  vm.runInContext(runtimeSource, context)
  const runtime = context.installCodexApiModeRuntime({
    state: { apiCodingModeEnabled: false }, bridge: () => response.promise,
    assetUrl: () => '', loadModule: async () => ({}),
  })
  try {
    runtime.update({ apiCodingModeEnabled: false })
    response.resolve({ ok: true, apiCodingModeEnabled: true })
    await runtime.refresh()
    assert.equal(runtime.status().enabled, false)
  } finally { runtime.dispose() }
})
