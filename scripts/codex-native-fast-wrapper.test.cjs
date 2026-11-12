const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const nativeDir = path.join(__dirname, '../src-tauri/src/third_party/codex-plus-plus')
const wrapper = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_native_fast_runtime.js'), 'utf8')
const nativeSource = ['native-fast-rspack.js', 'native-fast-unlock.js']
  .map(file => fs.readFileSync(path.join(nativeDir, file), 'utf8')).join('\n')

function browser({ started = false, owns = true } = {}) {
  const elements = [], events = new Map(), storage = new Map(), timers = new Map()
  let timer = 0, reloads = 0
  const document = {
    documentElement: started ? {} : null, readyState: 'loading', scripts: [],
    createElement(tag) {
      const node = { tagName: tag, children: [], parentNode: null,
        relList: { supports: () => true }, appendChild(child) {
          this.children.push(child); child.parentNode = this; elements.push(child); return child
        } }
      return node
    },
    appendChild(node) { this.documentElement = node; node.parentNode = this; return node },
    removeChild(node) { this.documentElement = null; node.parentNode = null },
    addEventListener(name, listener) { events.set(name, listener) },
    removeEventListener(name) { events.delete(name) },
  }
  const context = vm.createContext({ URL: class extends URL {
    static createObjectURL() { return 'blob:app://-/native-fast-fixture' }
  }, Blob, TextEncoder, console, setTimeout, clearTimeout, module: { exports: {} } })
  context.window = context
  context.document = document
  context.location = { href: 'app://-/index.html', protocol: 'app:', host: '-', reload() { reloads++ } }
  context.HTMLScriptElement = { supports: () => true }
  context.setTimeout = callback => { timers.set(++timer, callback); return timer }
  context.clearTimeout = id => timers.delete(id)
  context.sessionStorage = { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  context.__GAOGE_OWNS_NATIVE_FAST_HELPER__ = owns
  vm.runInContext(nativeSource + '\n' + wrapper, context)
  return { context, document, elements, events, timers, storage, get reloads() { return reloads },
    install: state => context.installCodexNativeFastRuntime(state) }
}

const prepared = () => ({ ok: true, version: 1,
  modules: [{ url: 'app://-/assets/app-initial-probe.js',
    patchedSource: 'window.__codexPlusNativeFastCompiled="v1";' }],
  diagnostics: { reason: 'modules-prepared', rewriters: { fast: 'patched' } } })

const enabled = { enabled: true, localApiConfigured: true }

test('new helper receives only backend flags and does not enable unknown or remote authentication', () => {
  const b = browser(), runtime = b.install(enabled), native = b.context.__codexPlusNativeFastUnlock
  assert.deepEqual(JSON.parse(JSON.stringify(b.context.__codexPlusSettings)), {
    enhancementsEnabled: true, codexAppNativeFastUnlock: true, nativeFastLocalApiConfigured: true,
  })
  assert.equal(native.runtime.allow('local', 'apikey'), true)
  assert.equal(native.runtime.allow('local', null), true)
  assert.equal(native.runtime.allow('remote', 'apikey'), false)
  assert.equal(native.runtime.allow('local', 'copilot'), false)
  assert.equal(runtime.status().ready, false)
  assert.equal(runtime.status().needsRestart, true)
  assert.equal(b.install({ enabled: true, localApiConfigured: false }), runtime)
  assert.equal(native.runtime.allow('local', null), false)
  runtime.dispose()
  assert.equal(native.runtime.allow('local', 'apikey'), false)
})

test('installPrepared arms the real upstream import map and only reports ready after module execution', () => {
  const b = browser(), runtime = b.install(enabled)
  assert.equal(runtime.installPrepared(prepared()).ok, true)
  const map = b.elements.find(node => node.type === 'importmap')
  assert.equal(JSON.parse(map.textContent).imports['app://-/assets/app-initial-probe.js'], 'blob:app://-/native-fast-fixture')
  assert.equal(b.document.documentElement, null, 'temporary HTML root must be removed before parsing')
  assert.equal(runtime.status().phase, 'armed')
  assert.equal(runtime.status().ready, false)
  b.context.__codexPlusNativeFastCompiled = 'v1'
  b.context.__codexPlusNativeFastPatchState = 'patched'
  assert.equal(runtime.status().phase, 'compiled')
  assert.equal(runtime.status().verified, true)
  const count = b.elements.length
  assert.equal(runtime.installPrepared(prepared()).alreadyCompiled, true)
  assert.equal(b.elements.length, count, 'compiled document is never mapped twice')
  b.install({ enabled: false })
  assert.equal(runtime.status().ready, false)
})

test('late document injection requires restart without modifying DOM or reloading', () => {
  const b = browser({ started: true }), runtime = b.install(enabled)
  const result = runtime.installPrepared(prepared())
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics.reason, 'document-already-started')
  assert.equal(runtime.status().ready, false)
  assert.equal(runtime.status().needsRestart, true)
  assert.equal(b.elements.length, 0)
  assert.equal(b.reloads, 0)
})

test('module transport rejects remote, mixed, duplicate, malformed and oversized prepared bundles', () => {
  for (const url of ['https://example.com/assets/entry.js', 'app://other/assets/entry.js',
    'app://-/assets/entry.js?credential=x', 'app://-/assets/../index.js', 'file:///tmp/entry.js']) {
    const b = browser(), value = prepared()
    value.modules[0].url = url
    assert.equal(b.install(enabled).installPrepared(value).ok, false, url)
    assert.equal(b.elements.length, 0)
  }
  for (const mutate of [
    value => value.modules.push({ ...value.modules[0] }),
    value => { value.version = 0 },
    value => { value.diagnostics.rewriters.fast = 'incomplete-gates' },
    value => { value.modules[0].patchedSource = 'globalThis.someOtherModule = true;' },
    value => { value.modules[0].patchedSource = 'x'.repeat(27 * 1024 * 1024) },
    value => { value.modules.push({ url: 'app://-/assets/second.js', patchedSource: 'x'.repeat(25 * 1024 * 1024) });
      value.modules[0].patchedSource += 'x'.repeat(25 * 1024 * 1024) },
  ]) {
    const b = browser(), value = prepared()
    mutate(value)
    assert.equal(b.install(enabled).installPrepared(value).ok, false)
    assert.equal(b.elements.length, 0)
  }
})

test('preparation is single-flight, bounded, never certifies execution and rejects changed state', async () => {
  const b = browser({ started: true }), runtime = b.install(enabled)
  let resolve, reads = 0
  b.context.__codexPlusNativeFastUnlock.prepareDocumentModules = () => {
    reads++
    return new Promise(done => { resolve = done })
  }
  const first = runtime.prepare(), second = runtime.prepare()
  resolve({ ...prepared(), secret: 'not projected', modules: [{ ...prepared().modules[0], arbitrary: 'not projected' }] })
  const [a, c] = await Promise.all([first, second])
  assert.equal(a.ok, true)
  assert.equal(c.ok, true)
  assert.equal(reads, 1)
  assert.equal(a.secret, undefined)
  assert.equal(a.modules[0].arbitrary, undefined)
  assert.equal(runtime.status().phase, 'prepared')
  assert.equal(runtime.status().ready, false)
  const pending = runtime.prepare()
  runtime.update({ enabled: true, localApiConfigured: false })
  resolve(prepared())
  assert.equal((await pending).diagnostics.reason, 'state-changed')
  assert.equal(runtime.status().ready, false)
})

test('existing CodexPlusPlus helper keeps its settings and original allow policy through update and dispose', async () => {
  const b = browser({ owns: false }), helper = b.context.__codexPlusNativeFastUnlock
  const settings = { enhancementsEnabled: false, codexAppNativeFastUnlock: false,
    nativeFastLocalApiConfigured: true, otherExtension: true }
  helper.runtime.update(settings)
  const originalAllow = helper.runtime.allow, originalStatus = helper.runtime.status
  const runtime = b.install({ enabled: true, localApiConfigured: false })
  assert.equal(b.context.__codexPlusSettings, settings)
  assert.equal(helper.runtime.allow('local', 'apikey'), true)
  assert.equal(helper.runtime.allow('local', null), false, 'external disabled null-auth policy must not be expanded')
  assert.equal(helper.runtime.allow('remote', 'apikey'), false)
  assert.equal(helper.runtime.status().enabled, true, 'our opted-in policy may prepare native modules')
  b.install({ enabled: false })
  assert.equal(helper.runtime.allow('local', 'apikey'), false)
  assert.equal(helper.runtime.status().enabled, false)
  assert.equal(settings.enhancementsEnabled, false)
  assert.equal(settings.otherExtension, true)
  runtime.dispose()
  assert.equal(helper.runtime.allow, originalAllow)
  assert.equal(helper.runtime.status, originalStatus)
  assert.equal(b.context.__codexPlusSettings, settings)
})

test('externally compiled native helper is reused without a second patch or settings changes', async () => {
  const b = browser({ owns: false }), helper = b.context.__codexPlusNativeFastUnlock
  const settings = { enhancementsEnabled: true, codexAppNativeFastUnlock: true, otherExtension: true }
  helper.runtime.update(settings)
  b.context.__codexPlusNativeFastCompiled = 'v1'
  b.context.__codexPlusNativeFastPatchState = 'patched'
  let calls = 0
  helper.prepareDocumentModules = async () => { calls++; throw Error('must not recompile') }
  const runtime = b.install(enabled)
  assert.equal((await runtime.prepare()).alreadyCompiled, true)
  assert.equal(runtime.status().ready, true)
  runtime.update({ enabled: false })
  assert.equal(helper.runtime.allow('local', 'apikey'), true, 'independent external setting remains effective')
  assert.equal(b.context.__codexPlusSettings, settings)
  runtime.dispose()
  assert.equal(settings.enhancementsEnabled, true)
  assert.equal(calls, 0)
})
