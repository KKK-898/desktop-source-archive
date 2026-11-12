const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8').replace(/\r\n/g, '\n')
const ultraSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_ultra_runtime.js'), 'utf8')
const fuelSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_fuel_runtime.js'), 'utf8')
const pasteSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_paste_runtime.js'), 'utf8')
const pluginSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_plugin_runtime.js'), 'utf8')
const pluginVersion = Number(pluginSource.match(/var CODEX_PLUGIN_RUNTIME_VERSION = (\d+);/)[1])
const fuelVersion = Number(fuelSource.match(/var CODEX_FUEL_RUNTIME_VERSION = (\d+);/)[1])
const start = source.indexOf('  const pluginEnhancementsEnabled = window.__GAOGE_PLUGIN_ENHANCEMENTS_ENABLED__ === true;')
const end = source.indexOf('\n})()\n"##', start)
assert.ok(start >= 0 && end > start, 'the production injection orchestrator must be present')
const orchestration = `(async () => {\n${source.slice(start, end)}\n})()`
const loaderStart = source.indexOf('  async function loadCodexAppModule(namePart) {')
const loaderEnd = source.indexOf('\n  function restorePluginMarketplaceName(', loaderStart)
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, 'the production module loader must be present')
const createLoader = new Function('window', 'codexAppAssetUrl', 'setTimeout', 'clearTimeout',
  `${source.slice(loaderStart, loaderEnd)}; return loadCodexAppModule;`)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture({ rejectAssets = false, ultraEnabled = true, realPlugin = false } = {}) {
  const calls = []
  const assets = []
  const timers = new Map()
  let timerId = 0
  const asset = name => {
    calls.push(name)
    if (rejectAssets) return Promise.reject(new Error('synthetic asset unavailable'))
    const pending = deferred()
    assets.push(pending)
    return pending.promise
  }
  const window = {
    __GAOGE_CODEX_FUEL_STATE__: { enabled: true },
    __GAOGE_CODEX_ULTRA_STATE__: {
      enabled: ultraEnabled, provider: 'relay', modelCatalogPath: 'C:/synthetic/catalog.json',
      scopeKey: 'route-one', platform: 'windows',
    },
    __GAOGE_DESIRED_RUNTIME_REVISION__: 'synthetic-revision',
    __GAOGE_PLUGIN_ENHANCEMENTS_ENABLED__: realPlugin,
  }
  const context = vm.createContext({
    window,
    navigator: { platform: 'windows' },
    document: { querySelectorAll: () => [] },
    CODEX_FUEL_RUNTIME_VERSION: fuelVersion,
    CODEX_MODEL_TRANSITION_GUARD_VERSION: 1,
    CODEX_PLUGIN_RUNTIME_VERSION: pluginVersion,
    pluginBridgeFromVersion: '26.616.0', pluginLegacyBeforeVersion: '26.601.2237',
    installCodexPluginRuntime: options => ({ status: () => ({ version: pluginVersion, enabled: options.enabled, runtimeReady: false }) }),
    codexAppVersion: realPlugin ? '26.1103.7773' : 'synthetic', pluginStrategy: 'modern', marketplaceStrategy: 'bridge',
    aggregateModelPickerRuntimeVersion: 1,
    codexAppAssetUrl: name => `https://fixture.invalid/assets/${name}fixture.js`,
    loadCodexAppModule: name => asset(`module:${name}`),
    fetch: url => asset(`fetch:${url}`),
    setInterval: callback => { const id = ++timerId; timers.set(id, callback); return id },
    clearInterval: id => timers.delete(id),
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer },
    clearTimeout,
    installCodexFuelRuntime: async options => {
      calls.push(`fuel:${options.state.enabled}`)
      const runtime = window.__gaogeCodexFuelRuntime || { version: fuelVersion }
      Object.assign(runtime, {
        enabled: options.state.enabled, ready: true, disposed: false, error: '',
        health: { healthy: true, needsReinstall: false },
      })
      window.__gaogeCodexFuelRuntime = runtime
      return runtime
    },
    installAccountBalanceRuntime: () => ({ ready: true, version: 1 }),
    installCodexApiModeRuntime: () => ({ status: () => ({ enabled: false, ready: true }) }),
    installCodexModelTransitionGuard: async () => ({ enabled: false, ready: true }),
    installThemeRuntime: async () => ({ enabled: false, applied: false }),
    installAggregateModelPickerRuntime: () => ({ enabled: false, ready: true }),
    installSessionDeleteRuntime: async () => ({ enabled: false, active: false }),
    localPluginMarketplaces: () => [],
  })
  window.document = {
    addEventListener(type) { calls.push(`listen:${type}`) },
    removeEventListener(type) { calls.push(`unlisten:${type}`) },
  }
  vm.runInContext(pasteSource, context)
  vm.runInContext(ultraSource, context)
  if (realPlugin) vm.runInContext(pluginSource, context)
  return { window, context, calls, assets, timers, inject: () => vm.runInContext(orchestration, context) }
}

async function completed(promise) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('injection is still waiting on optional assets')), 200)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

test('an unresolved real Ultra asset load cannot delay quota installation or the CDP result', async () => {
  const f = fixture()
  const result = await completed(f.inject())
  assert.deepEqual(f.calls.slice(0, 2), ['listen:paste', 'fuel:true'])
  assert.equal(result.pasteFix.installed, true)
  assert.equal(f.assets.length, 3, 'real Ultra is waiting for two sources and a module')
  assert.equal(result.fuelRuntimeReady, true)
  assert.equal(result.runtimeRevision, 'synthetic-revision')
  assert.equal(result.ultra.ready, false)
  assert.equal(result.ultra.verified, false, 'pending Ultra is never reported as verified')
  assert.equal(result.ultra.reason, 'awaiting-page')
  assert.equal(f.timers.size, 1, 'the independent Ultra monitor remains installed')
})

test('reinjecting while Ultra is pending refreshes Fuel without duplicating Ultra loading', async () => {
  const f = fixture()
  await completed(f.inject())
  const ultra = f.window.__gaogeCodexUltraRuntime
  const fuel = f.window.__gaogeCodexFuelRuntime
  const result = await completed(f.inject())
  assert.deepEqual(f.calls.filter(call => call.startsWith('fuel:')), ['fuel:true', 'fuel:true'])
  assert.deepEqual(f.calls.filter(call => call.endsWith(':paste')), ['listen:paste'])
  assert.equal(result.pasteFix.installed, true)
  assert.equal(f.window.__gaogeCodexUltraRuntime, ultra)
  assert.equal(f.window.__gaogeCodexFuelRuntime, fuel)
  assert.equal(f.assets.length, 3)
  assert.equal(f.timers.size, 1)
  assert.equal(result.fuelRuntimeReady, true)
})

test('disabling the route takes effect during a pending Ultra load and late completion cannot revive it', async () => {
  const f = fixture()
  await completed(f.inject())
  const oldUltra = f.window.__gaogeCodexUltraRuntime
  f.window.__GAOGE_CODEX_FUEL_STATE__ = { enabled: false }
  f.window.__GAOGE_CODEX_ULTRA_STATE__ = { enabled: false }
  const result = await completed(f.inject())
  const disabledUltra = f.window.__gaogeCodexUltraRuntime
  assert.equal(result.fuelRuntimeEnabled, false)
  assert.equal(result.ultra.enabled, false)
  assert.equal(oldUltra.disposed, true)
  assert.equal(f.timers.size, 0)
  for (const pending of f.assets) pending.resolve({ ok: true, text: async () => '' })
  await oldUltra.refresh()
  assert.equal(f.window.__gaogeCodexUltraRuntime, disabledUltra)
  assert.equal(disabledUltra.status().enabled, false)
  assert.equal(f.window.__gaogeCodexFuelRuntime.enabled, false)
})

test('Ultra source failures are visible without failing a working quota installation', async () => {
  const f = fixture({ rejectAssets: true })
  const result = await completed(f.inject())
  assert.equal(result.fuelRuntimeReady, true)
  assert.equal(result.ultra.ready, false)
  assert.equal(result.ultra.verified, false)
  assert.equal(result.ultra.reason, 'unsupported-query')
  assert.match(result.ultra.error, /synthetic asset unavailable/)
})

test('disabled Ultra does not load optional assets', async () => {
  const f = fixture({ ultraEnabled: false })
  const result = await completed(f.inject())
  assert.deepEqual(f.calls, ['listen:paste', 'fuel:true'])
  assert.equal(result.pasteFix.installed, true)
  assert.equal(result.fuelRuntimeReady, true)
  assert.equal(result.ultra.enabled, false)
  assert.equal(f.timers.size, 0)
})

let moduleFixtureId = 0
function loaderFixture(moduleSources) {
  const window = {}
  const timers = new Map()
  const id = ++moduleFixtureId
  let timerId = 0
  let calls = 0
  const loader = createLoader(window, () => {
    const moduleSource = moduleSources[Math.min(calls++, moduleSources.length - 1)]
    return moduleSource == null ? ''
      : `data:text/javascript,${encodeURIComponent(`// fixture ${id}:${calls}\n${moduleSource}`)}`
  }, (callback, milliseconds) => {
    const timer = ++timerId
    timers.set(timer, { callback, milliseconds })
    return timer
  }, timer => timers.delete(timer))
  return {
    window, timers, loader, calls: () => calls,
    expire() {
      for (const [timer, value] of [...timers]) {
        timers.delete(timer)
        assert.equal(value.milliseconds, 2500)
        value.callback()
      }
    },
  }
}

test('a stalled real import expires and a late old module cannot replace a successful retry', async () => {
  const slot = `__gaogeModuleIsolationFixture${++moduleFixtureId}`
  const f = loaderFixture([
    `await new Promise(resolve => { globalThis[${JSON.stringify(slot)}] = resolve }); export const value = 'late-old';`,
    `export const value = 'recovered';`,
  ])
  try {
    const first = f.loader('app-initial-').catch(error => error)
    await completed((async () => {
      while (typeof globalThis[slot] !== 'function') await new Promise(setImmediate)
    })())
    f.expire()
    assert.match((await first).message, /module load timed out/)
    assert.equal(f.window.__gaogeCodexPluginModulePromises.has('app-initial-'), false)
    const second = await completed(f.loader('app-initial-'))
    assert.equal(second.value, 'recovered')
    const current = f.window.__gaogeCodexPluginModulePromises.get('app-initial-')
    globalThis[slot]()
    await new Promise(setImmediate)
    assert.equal(f.window.__gaogeCodexPluginModulePromises.get('app-initial-'), current)
    assert.equal((await f.loader('app-initial-')).value, 'recovered')
    assert.equal(f.calls(), 2)
    assert.equal(f.timers.size, 0)
  } finally {
    globalThis[slot]?.()
    delete globalThis[slot]
  }
})

test('concurrent module consumers share the import and clear its deadline after success', async () => {
  const f = loaderFixture([`export const value = 'shared';`])
  const [first, second] = await completed(Promise.all([
    f.loader('app-shared-'), f.loader('app-shared-'),
  ]))
  assert.equal(first, second)
  assert.equal(first.value, 'shared')
  assert.equal(f.calls(), 1)
  assert.equal(f.timers.size, 0)
})

test('a superseded module failure does not evict the replacement promise', async () => {
  const f = loaderFixture([null])
  const first = f.loader('app-initial-').catch(error => error)
  const replacement = Promise.resolve({ value: 'replacement' })
  f.window.__gaogeCodexPluginModulePromises.set('app-initial-', replacement)
  assert.match((await first).message, /asset not found/)
  assert.equal(f.window.__gaogeCodexPluginModulePromises.get('app-initial-'), replacement)
  assert.equal((await f.loader('app-initial-')).value, 'replacement')
  assert.equal(f.timers.size, 0)
})


test('pending native plugin discovery cannot block the production CDP orchestrator', async () => {
  const f = fixture({ realPlugin: true, ultraEnabled: false })
  const result = await completed(f.inject())
  assert.equal(result.pluginRuntime.runtimeReady, false)
  assert.equal(result.pluginRuntime.listVerified, false)
  assert.equal(result.pluginRuntime.installed, true)
  assert.equal(result.fuelRuntimeReady, true)
  assert.equal(result.pasteFix.installed, true)
  assert.ok(f.window.__gaogeCodexPluginRuntime)
  assert.equal(f.window.__gaogeCodexPluginCdpFallbackV2, undefined)
  f.window.__gaogeCodexPluginRuntime.dispose()
})

test('disabling plugins during unresolved discovery retains the monitor but never claims ready', async () => {
  const f = fixture({ realPlugin: true, ultraEnabled: false })
  await completed(f.inject())
  const monitor = f.window.__gaogeCodexPluginRuntime
  f.window.__GAOGE_PLUGIN_ENHANCEMENTS_ENABLED__ = false
  const result = await completed(f.inject())
  assert.equal(f.window.__gaogeCodexPluginRuntime, monitor)
  assert.equal(result.pluginRuntime.enabled, false)
  assert.equal(result.pluginRuntime.runtimeReady, false)
  assert.equal(result.pluginRuntime.listVerified, false)
  for (const asset of f.assets) asset.resolve({})
  await new Promise(setImmediate)
  assert.equal(monitor.status().enabled, false)
  assert.equal(monitor.status().runtimeReady, false)
  monitor.dispose()
})
