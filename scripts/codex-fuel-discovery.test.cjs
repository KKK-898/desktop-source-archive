const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const runtimePath = path.resolve(__dirname, '../src-tauri/src/codex_fuel_runtime.js')
const readFixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const source = readFixture('codex-fuel-gate-26.924.js')
const shared = readFixture('codex-fuel-shared-26.924.js')
const composer = readFixture('codex-fuel-composer-26.924.js')

function loadRuntime() {
  const sandbox = {}
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(runtimePath, 'utf8'), sandbox, { filename: runtimePath })
  return sandbox
}

// Discovery resolves identities only. Native code is never evaluated and
// these inert functions cannot submit a turn or mutate an installed client.
function moduleFor(text) {
  const exports = {}
  for (const match of text.slice(text.lastIndexOf('export{')).matchAll(/(?:[,{])([\w$]+) as ([\w$]+)(?=[,}])/g)) {
    exports[match[2]] = Object.assign(function fixtureBinding() {}, { localName: match[1] })
  }
  return exports
}

function dependenciesFor(text = shared) {
  return { 'app-shared-': moduleFor(text), __sources: { 'app-shared-': text } }
}

test('26.924 split assets resolve selectors from their owning module', () => {
  const runtime = loadRuntime()
  const module = moduleFor(source)
  const dependencies = dependenciesFor()
  const bindings = runtime.discoverCodexFuelBindings(source, module, dependencies)
  assert.equal(bindings.hardBlocked, module.hardExport)
  assert.equal(bindings.reserveActive, module.activeExport)
  assert.equal(bindings.config, module.configExport)
  assert.equal(bindings.cloudSelection, module.cloudExport)
  assert.equal(bindings.selectedProject, module.projectExport)
  assert.equal(bindings.threadProvider, dependencies['app-shared-'].providerExport)
  assert.equal(bindings.threadCwd, dependencies['app-shared-'].cwdExport)
  assert.equal(bindings.threadHost, dependencies['app-shared-'].hostExport)
  assert.equal(bindings.createDerived, dependencies['app-shared-'].sharedDerived)
  assert.equal(bindings.createSignal, dependencies['app-shared-'].sharedSignal)
  assert.equal(runtime.verifyCodexFuelComposer(composer, bindings.hardBlockedExport), true)
})

test('minimal quota discovery remains usable when every composer selector changes', () => {
  const runtime = loadRuntime()
  const reduced = source.split('\n').filter(line => !/^const (config|cloud|project)=/.test(line)).join('\n')
  const moved = shared.split('\n').filter(line => !/^const (provider|host)=/.test(line)).join('\n')
  const bindings = runtime.discoverCodexFuelQuotaBindings(reduced, moduleFor(reduced), dependenciesFor(moved))
  assert.equal(bindings.hardBlocked.localName, 'hard')
  assert.equal(bindings.reserveActive.localName, 'active')
  assert.equal(bindings.createDerived.localName, 'derived')
  assert.equal(bindings.createSignal.localName, 'signal')
  assert.throws(() => runtime.discoverCodexFuelBindings(reduced, moduleFor(reduced), dependenciesFor(moved)), /thread provider/)
})

test('26.928 cloud prototype branch retains scoped cloud selection discovery', () => {
  const runtime = loadRuntime()
  const modern = source.replace(
    'e(Feature)?e(Prototype)?e(Enabled)&&',
    'e(Feature)?t.value.kind===`local`&&t.value.cloudThreadPrototype?e(Enabled):e(Prototype)?e(Enabled)&&',
  )
  assert.notEqual(modern, source)
  const module = moduleFor(modern)
  const bindings = runtime.discoverCodexFuelBindings(modern, module, dependenciesFor())
  assert.equal(bindings.cloudSelection, module.cloudExport)
  assert.equal(runtime.verifyCodexFuelComposer(composer, bindings.hardBlockedExport), true)
  const wrongScope = modern.replace('t.value.cloudThreadPrototype', 'other.value.cloudThreadPrototype')
  const partial = runtime.discoverCodexFuelBindings(wrongScope, moduleFor(wrongScope), dependenciesFor())
  assert.equal(partial.cloudSelection, undefined)
  assert.equal(partial.newTargetSelectorsUnavailable, true)
  assert.match(partial.selectionDiscoveryError, /cloud execution selection/)
  assert.equal(typeof partial.config, 'function')
})

test('new-task selector changes cannot disable existing local conversation bindings', () => {
  const runtime = loadRuntime()
  const changed = source.split('\n').filter(line => !/^const (cloud|project)=/.test(line)).join('\n')
  const module = moduleFor(changed)
  const bindings = runtime.discoverCodexFuelBindings(changed, module, dependenciesFor())
  assert.equal(bindings.config, module.configExport)
  assert.equal(bindings.threadProvider.localName, 'provider')
  assert.equal(bindings.newTargetSelectorsUnavailable, true)
  assert.equal(bindings.cloudSelection, undefined)
})

test('fallback discovers the config query independently of all task selectors', () => {
  const runtime = loadRuntime()
  const changed = source.split('\n').filter(line => !/^const (cloud|project)=/.test(line)).join('\n')
  const moved = shared.split('\n').filter(line => !/^const (provider|host)=/.test(line)).join('\n')
  const module = moduleFor(changed)
  assert.equal(runtime.discoverCodexFuelConfigBinding(changed, module, dependenciesFor(moved)), module.configExport)
  assert.throws(() => runtime.discoverCodexFuelConfigBinding(
    changed.replace('cwd:e=null,hostId:t', 'directory:e=null,hostId:t'), module, dependenciesFor(moved)),
  /effective configuration/)
})

test('split discovery rejects duplicate ownership instead of selecting another composer', () => {
  const runtime = loadRuntime()
  const duplicate = source.replace('const refresh=', 'const provider=select(({modelProvider:e})=>e??null);const refresh=')
  assert.throws(() => runtime.discoverCodexFuelBindings(duplicate, moduleFor(duplicate), dependenciesFor()), /thread provider/)
})

test('quota discovery rejects mismatched source families and missing shared factories', () => {
  const runtime = loadRuntime()
  assert.throws(() => runtime.discoverCodexFuelQuotaBindings(source.replace('t(quota,e).active', 't(other,e).active'), moduleFor(source), dependenciesFor()), /reserve quota gate/)
  const dependencies = dependenciesFor()
  delete dependencies['app-shared-'].sharedSignal
  assert.throws(() => runtime.discoverCodexFuelQuotaBindings(source, moduleFor(source), dependencies))
})

test('composer verification accepts compound blockers but requires a positive quota OR and consumer', () => {
  const runtime = loadRuntime()
  assert.equal(runtime.verifyCodexFuelComposer(composer, 'hardExport'), true)
  assert.equal(runtime.verifyCodexFuelComposer(composer.replace('||quota||', '||(quota)||'), 'hardExport'), true)
  assert.throws(() => runtime.verifyCodexFuelComposer(composer.replace('||quota||', '||!quota||'), 'hardExport'), /disabled condition/)
  assert.throws(() => runtime.verifyCodexFuelComposer(composer.replace('||quota||', '&&quota||'), 'hardExport'), /disabled condition/)
  assert.throws(() => runtime.verifyCodexFuelComposer(composer.replace('submitDisabled:disabled', 'submitDisabled:busy'), 'hardExport'), /submit consumer/)
  assert.throws(() => runtime.verifyCodexFuelComposer(composer.replace('submitDisabled:disabled', 'submitDisabled:disabledUnrelated'), 'hardExport'), /submit consumer/)
})

test('installed native asar supports native or scoped-force discovery and the actual submit consumer in memory', {
  skip: !process.env.CODEX_NATIVE_APP_ASAR && 'Set CODEX_NATIVE_APP_ASAR to check an installed package without extraction or execution',
}, t => {
  const asar = require('@electron/asar')
  const packagePath = path.resolve(process.env.CODEX_NATIVE_APP_ASAR)
  const files = asar.listPackage(packagePath)
  const readAsset = prefix => {
    const matches = files.filter(file => new RegExp(`[\\\\/]${prefix}[^\\\\/]+\\.js$`).test(file))
    assert.equal(matches.length, 1, `Expected one ${prefix} asset`)
    return asar.extractFile(packagePath, matches[0].replace(/^[\\/]/, '')).toString('utf8')
  }
  const initial = readAsset('app-initial-')
  const nativeShared = readAsset('app-shared-')
  const primary = readAsset('app-primary-')
  const runtime = loadRuntime()
  const module = moduleFor(initial)
  const dependencies = dependenciesFor(nativeShared)
  let bindings
  try {
    bindings = runtime.discoverCodexFuelBindings(initial, module, dependencies)
    t.diagnostic('Installed package supports native selector discovery')
  } catch (error) {
    // Production can recover from moved thread selectors. Quota, route and
    // submit-consumer recognition remain mandatory in this compatibility check.
    assert.match(error.message, /^Unsupported Codex thread (?:provider|directory|host) signature$/,
      'Only a recognized thread-selector failure may use scoped-force discovery')
    bindings = runtime.discoverCodexFuelQuotaBindings(initial, module, dependencies)
    bindings.config = runtime.discoverCodexFuelConfigBinding(initial, module, dependencies)
    t.diagnostic(`Installed package supports scoped-force discovery: ${error.message}`)
  }
  assert.equal(runtime.verifyCodexFuelComposer(primary, bindings.hardBlockedExport), true)
  assert.equal(typeof bindings.hardBlocked, 'function')
  assert.equal(typeof bindings.reserveActive, 'function')
  assert.equal(typeof bindings.config, 'function')
  assert.equal(typeof bindings.createDerived, 'function')
  assert.equal(typeof bindings.createSignal, 'function')
})
