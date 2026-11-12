const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const helper = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_aggregate_selection.js'), 'utf8')
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/codex-aggregate-selection-26.924.js'), 'utf8')
const currentFixture = fs.readFileSync(path.join(__dirname, 'fixtures/codex-aggregate-selection-26.1007.js'), 'utf8')
const fixtures = [['26.924', fixture], ['26.1007', currentFixture]]

function runtime() {
  const sandbox = { Map }
  vm.createContext(sandbox)
  vm.runInContext(helper, sandbox)
  return sandbox
}

function nativeState() {
  const token = { id: Symbol('native-root') }
  const queued = { scope: token }
  const inFlight = { scope: token }
  const atom = value => ({ value })
  const descriptor = state => ({ value: { resolve: () => state } })
  const queuedState = atom(null)
  const inFlightState = atom(null)
  const root = { store: { get: value => value.value }, familyBindings: new Map([
    [queued, new Map([['["conversation","thread-a"]', descriptor(queuedState)]])],
    [inFlight, new Map([['["conversation","thread-a"]', descriptor(inFlightState)]])],
  ]) }
  return { token, queued, inFlight, queuedState, inFlightState, descriptor, root,
    chain: new Map([[token.id, root]]), module: { queueExport: queued, savingExport: inFlight } }
}

for (const [version, source] of fixtures) test(`${version} discovery follows queued/commit/cleanup relationships without fixed exports`, () => {
  const native = nativeState()
  const bindings = runtime().discoverAggregateNativeSelectionBindings(source, native.module)
  assert.equal(bindings.queued, native.queued)
  assert.equal(bindings.inFlight, native.inFlight)
  assert.throws(() => runtime().discoverAggregateNativeSelectionBindings(source.replace('inFlight=family(Root', 'inFlight=family(Other'), native.module), /scope/)
  assert.throws(() => runtime().discoverAggregateNativeSelectionBindings(source.replace('await e.write()', 'await e.other()'), native.module), /commit/)
})

test('both cleanup versions tolerate renamed native bindings and export aliases', () => {
  for (const [, source] of fixtures) {
    const native = nativeState()
    const names = { clearSelection: 'cleanup$1', queued: 'queued$2', inFlight: 'saving$3',
      family: 'family$4', Root: 'scope$5', store: 'owner$6', e: 'context$7', t: 'selection$8',
      global: 'default$9', queueExport: 'export$10', savingExport: 'export$11' }
    const renamed = source.replace(/\b(clearSelection|queued|inFlight|family|Root|store|e|t|global|queueExport|savingExport)\b/g,
      name => names[name])
    const bindings = runtime().discoverAggregateNativeSelectionBindings(renamed,
      { 'export$10': native.queued, 'export$11': native.inFlight })
    assert.equal(bindings.queued, native.queued)
    assert.equal(bindings.inFlight, native.inFlight)
  }
})

test('26.924 only accepts the guarded default-signal tail with equivalent equality and quoting', () => {
  const native = nativeState()
  for (const equality of ['==', '===']) for (const quote of ['"', "'", '`']) {
    const source = fixture.replace('==="default"', `${equality}${quote}default${quote}`)
    const bindings = runtime().discoverAggregateNativeSelectionBindings(source, native.module)
    assert.equal(bindings.queued, native.queued)
    assert.equal(bindings.inFlight, native.inFlight)
  }
  for (const [before, after] of [
    ['t.target[0]', 'other.target[0]'],
    ['t.target[0]', 't.target[1]'],
    ['==="default"', '!=="default"'],
    ['==="default"', '==="conversation"'],
    ['&&e.set(global,null)', '&&other.set(global,null)'],
    ['e.set(global,null)', 'e.set(queued,null)'],
    ['e.set(global,null)', 'e.set(inFlight,null)'],
    ['e.set(global,null)', 'e.set(global,undefined)'],
    ['e.set(global,null)', 'e.set(global,null),unsafeSideEffect()'],
  ]) {
    assert.ok(fixture.includes(before), before)
    assert.throws(() => runtime().discoverAggregateNativeSelectionBindings(fixture.replace(before, after), native.module), /lifecycle/, before)
  }
})

test('26.1007 cleanup rejects extra tails, changed guards and malformed termination', () => {
  const native = nativeState()
  for (const [before, after] of [
    ['e.set(queued,t.target,null))}', 'e.set(queued,t.target,null),unsafeSideEffect())}'],
    ['e.set(queued,t.target,null))}', 'e.set(queued,t.target,null),)}'],
    ['e.set(queued,t.target,null))}', 'e.set(queued,t.target,null));unsafeSideEffect()}'],
    ['e.set(queued,t.target,null))}', 'e.set(queued,t.target,null))'],
    ['e.get(inFlight,t.target)===t.selection', 'e.get(inFlight,t.target)!==t.selection'],
    ['e.get(queued,t.target)===t.selection', 'e.get(queued,t.target)===other.selection'],
    ['e.set(queued,t.target,null)', 'e.set(queued,other.target,null)'],
  ]) {
    assert.ok(currentFixture.includes(before), before)
    assert.throws(() => runtime().discoverAggregateNativeSelectionBindings(currentFixture.replace(before, after), native.module), /lifecycle/, before)
  }
})

test('discovery rejects duplicate, mixed and partially malformed cleanup candidates', () => {
  const native = nativeState()
  const malformed = currentFixture.replace('e.set(queued,t.target,null))}', 'e.set(queued,t.target,null),unsafeSideEffect())}')
  for (const source of [fixture + fixture, currentFixture + currentFixture, fixture + currentFixture,
    fixture + malformed, currentFixture + malformed]) {
    assert.throws(() => runtime().discoverAggregateNativeSelectionBindings(source, native.module), /lifecycle/)
  }
})

test('both versions retain family, scope, queue, commit and unique-export checks', () => {
  for (const [, source] of fixtures) {
    const native = nativeState()
    const discover = (value, module = native.module) => runtime().discoverAggregateNativeSelectionBindings(value, module)
    for (const [before, after, error] of [
      ['inFlight=family(Root', 'inFlight=otherFamily(Root', /scope/],
      ['inFlight=family(Root', 'inFlight=family(Other', /scope/],
      ['inFlight=family(Root,e=>null)', 'inFlight=family(Root,e=>undefined)', /declaration/],
      ['store.set(queued,e.target,e.selection)', 'store.set(queued,e.target,other.selection)', /queue/],
      ['store.set(inFlight,e.target,e.selection)', 'store.set(inFlight,e.target,other.selection)', /queue/],
      ['await e.write()', 'await e.other()', /commit/],
      ['clearSelection(store,e)', 'otherCleanup(store,e)', /commit/],
      ['queued as queueExport', 'queued as queueExport,queued as otherExport', /unavailable/],
    ]) {
      assert.ok(source.includes(before), before)
      assert.throws(() => discover(source.replace(before, after)), error, before)
    }
    assert.throws(() => discover(source.replace(/\binFlight\b/g, 'queued')), /families/)
    assert.throws(() => discover(`${source}\nqueued=family(Root,e=>null);`), /declaration/)
    assert.throws(() => discover(source, { queueExport: native.queued }), /unavailable/)
    assert.throws(() => discover(source, { ...native.module, savingExport: { scope: { id: Symbol('other') } } }), /scope/)
  }
})

test('queued optimistic state and in-flight native saves remain busy until both clear', () => {
  const r = runtime(), native = nativeState(), read = () => ({ ...r.readAggregateNativeSelectionPending(native, native.chain) })
  assert.deepEqual(read(), { known: true, busy: false })
  native.queuedState.value = { model: 'gaoge/p/g/new', reasoningEffort: 'high' }
  assert.deepEqual(read(), { known: true, busy: true })
  native.inFlightState.value = native.queuedState.value
  native.queuedState.value = null
  assert.deepEqual(read(), { known: true, busy: true })
  native.inFlightState.value = null
  assert.deepEqual(read(), { known: true, busy: false })
})

test('26.924 bound writable handles read their atoms through the exact owning store', () => {
  const r = runtime(), native = nativeState(), read = () => ({ ...r.readAggregateNativeSelectionPending(native, native.chain) })
  const unexpected = () => { throw new Error('Bound handle methods must not be called') }
  const retained = state => ({
    debugFamilyMember: 'synthetic native family member', owner: native.root,
    value: { atom: state, store: native.root.store, get: unexpected, set: unexpected, subscribe: unexpected },
  })
  for (const [family, state] of [[native.queued, native.queuedState], [native.inFlight, native.inFlightState]]) {
    native.root.familyBindings.set(family, new Map([['["conversation","thread-a"]', retained(state)]]))
  }
  assert.deepEqual(read(), { known: true, busy: false })
  native.queuedState.value = { model: 'gaoge/p/g/new' }
  assert.deepEqual(read(), { known: true, busy: true })
  native.inFlightState.value = native.queuedState.value
  native.queuedState.value = null
  assert.deepEqual(read(), { known: true, busy: true })
  native.inFlightState.value = null
  assert.deepEqual(read(), { known: true, busy: false })
  const member = native.root.familyBindings.get(native.queued).values().next().value
  member.value.store = { get: () => null }
  member.value.resolve = () => native.queuedState
  assert.deepEqual(read(), { known: false, busy: true }, 'A descriptor fallback must not accept a foreign-store handle')
  member.value.store = native.root.store
  delete member.value.atom
  assert.deepEqual(read(), { known: false, busy: true })
})

test('pending default and other-thread members in the same root block optimistic confirmation', () => {
  const r = runtime(), native = nativeState()
  native.root.familyBindings.get(native.queued).set('["default","local","D:/draft"]', native.descriptor({ value: { model: 'gaoge/p/g/draft' } }))
  assert.deepEqual({ ...r.readAggregateNativeSelectionPending(native, native.chain) }, { known: true, busy: true })
  const otherRoot = nativeState()
  assert.deepEqual({ ...r.readAggregateNativeSelectionPending(otherRoot, otherRoot.chain) }, { known: true, busy: false })
})

test('missing, malformed, failed or excessive native reads are unknown and cannot confirm', () => {
  const r = runtime()
  for (const mutate of [
    native => native.chain.clear(),
    native => native.root.familyBindings.get(native.queued).clear(),
    native => { native.queuedState.value = undefined },
    native => { native.root.familyBindings.get(native.queued).values().next().value.value.resolve = () => null },
    native => { native.root.store.get = () => { throw new Error('Disposed native store') } },
    native => { for (let i = 0; i < 1001; i += 1) native.root.familyBindings.get(native.queued).set(String(i), native.descriptor({ value: null })) },
  ]) {
    const native = nativeState()
    mutate(native)
    assert.deepEqual({ ...r.readAggregateNativeSelectionPending(native, native.chain) }, { known: false, busy: true })
  }
})

test('installed Codex ESM or Rspack ASAR lifecycle resolves in memory without native execution', {
  skip: !process.env.CODEX_NATIVE_APP_ASAR && 'Set CODEX_NATIVE_APP_ASAR for the read-only installed source check',
}, () => {
  const asar = require('@electron/asar')
  const packagePath = path.resolve(process.env.CODEX_NATIVE_APP_ASAR)
  const packageFiles = asar.listPackage(packagePath)
  const files = packageFiles.filter(file => /[\\/]app-initial-[^\\/]+\.js$/.test(file))
  if (files.length === 0) {
    const native = webpackState(), expected = Function.prototype.toString.call(native.registry.m.selection)
    const ts = require('typescript')
    let selections = 0
    const composers = new Map()
    for (const file of packageFiles.filter(file => /[\\/]webview[\\/].*\.js$/.test(file))) {
      const source = asar.extractFile(packagePath, file.replace(/^[\\/]/, '')).toString('utf8')
      if (source.includes(expected)) selections++
      if (!source.includes('"ComposerScope",{key:')) continue
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const visit = node => {
        if (ts.isMethodDeclaration(node)) {
          const text = node.getText(ast)
          if (/([\w$]+)=\(0,[\w$]+\.[\w$]+\)\("ComposerScope",\{key:/.test(text)) {
            composers.set(text, Object.values(vm.runInNewContext('({' + text + '})'))[0])
          }
          return
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
    }
    assert.equal(selections, 1, 'Installed selection lifecycle must match the captured native source')
    assert.equal(composers.size, 1, 'Installed ComposerScope factory must be unique')
    native.registry.m.composer = composers.values().next().value
    const source = Function.prototype.toString.call(native.registry.m.composer)
    const local = /([\w$]+)=\(0,[\w$]+\.[\w$]+\)\("ComposerScope",\{key:/.exec(source)[1]
    const aliases = [...source.matchAll(new RegExp('(?:[,{])([\\w$]+):' + local + '(?=[,}])', 'g'))]
    assert.equal(aliases.length, 1)
    native.registry.c.composer.exports = { [aliases[0][1]]: native.composerScope }
    const bindings = runtime().discoverAggregateNativeSelectionWebpackBindings(native.module)
    assert.equal(bindings.queued, native.queued)
    assert.equal(bindings.inFlight, native.inFlight)
    assert.equal(bindings.composerScope, native.composerScope)
    return
  }
  assert.equal(files.length, 1)
  const source = asar.extractFile(packagePath, files[0].replace(/^[\\/]/, '')).toString('utf8')
  const token = { id: Symbol('native-source-check') }
  const module = {}
  for (const match of source.slice(source.lastIndexOf('export{')).matchAll(/(?:[,{])([\w$]+) as ([\w$]+)(?=[,}])/g)) {
    module[match[2]] = { scope: token, nativeLocalName: match[1] }
  }
  const bindings = runtime().discoverAggregateNativeSelectionBindings(source, module)
  assert.notEqual(bindings.queued, bindings.inFlight)
  assert.equal(bindings.queued.scope, bindings.inFlight.scope)
})

const rspackFixture = fs.readFileSync(path.join(__dirname, 'fixtures/codex-aggregate-selection-26.1103.js'), 'utf8')
function webpackState(source = rspackFixture) {
  const native = nativeState()
  native.token.__scopeBrand = 'AppScope'
  const composerScope = { id: Symbol('composer'), __scopeBrand: 'ComposerScope',
    parent: { __scopeBrand: 'RouteScope' }, getKey: value => value.clientThreadId }
  const registry = () => { throw new Error('Discovery must never execute native require') }
  const factory = Object.values(vm.runInNewContext(source))[0]
  const composerFactory = vm.runInNewContext('({composer(e,t,n){var r=n("scopes");let l=(0,r.z8)("ComposerScope",{key:e=>e.clientThreadId,parent:r.route,retain:{max:100}});n.d(t,{},{PR:l})}})').composer
  registry.m = { selection: factory, composer: composerFactory,
    unloaded() { throw new Error('Discovery must never execute unloaded factories') } }
  registry.c = { selection: { exports: { EX: native.queued, si: native.inFlight } },
    composer: { exports: { PR: composerScope } }, OWtl: { exports: { u: native.token } } }
  return { ...native, registry, composerScope, module: { __webpack_require__: registry } }
}

test('26.1103 cached Rspack discovery identifies queued, in-flight and exact ComposerScope without execution', () => {
  const r = runtime(), native = webpackState()
  const bindings = r.discoverAggregateNativeSelectionWebpackBindings(native.module)
  assert.equal(bindings.queued, native.queued)
  assert.equal(bindings.inFlight, native.inFlight)
  assert.equal(bindings.composerScope, native.composerScope)
  assert.deepEqual({ ...r.readAggregateNativeSelectionPending(bindings, native.chain) }, { known: true, busy: false })
})

test('26.1103 discovery tolerates renamed locals, registry IDs and export aliases', () => {
  const names = { e: 'arg$1', t: 'exports$2', n: 'require$3', a: 'scopeLib$4', r: 'root$5',
    o: 'queue$6', l: 'flight$7', i: 'temp$8', s: 'runner$9', d: 'selection$10', u: 'result$11',
    Eklu: 'factory$12', EX: 'queue$Export', si: 'flight$Export', OWtl: 'root$Module' }
  const source = rspackFixture.replace(/\b(e|t|n|a|r|o|l|i|s|d|u|Eklu|EX|si|OWtl)\b/g,
    (name, _match, offset) => name === 'd' && rspackFixture[offset - 1] === '.' ? name : names[name])
  const native = webpackState(source)
  native.registry.c['root$Module'] = { exports: { 'result$11': native.token } }
  native.registry.c.selection.exports = { 'queue$Export': native.queued, 'flight$Export': native.inFlight }
  const bindings = runtime().discoverAggregateNativeSelectionWebpackBindings(native.module)
  assert.equal(bindings.queued, native.queued)
  assert.equal(bindings.inFlight, native.inFlight)
})

test('26.1103 discovery rejects changed commit, cleanup, queue, scope and export contracts', () => {
  const changes = [
    ['i.get(l,s.target)===s.selection', 'i.get(l,s.target)!==s.selection'],
    ['i.set(o,s.target,null)', 'i.set(o,s.target,undefined)'],
    ['i.set(o,s.target,null)),d.resolve(u)', 'i.set(o,s.target,null)),sideEffect(),d.resolve(u)'],
    ['await d.write()', 'await d.other()'],
    ['d.resolve(u)', 'd.resolve(!0)'],
    ['n=null,a=!0,t.set(l,d.target,d.selection)', 'n=null,a=!0,t.set(o,d.target,d.selection)'],
    ['t.set(o,e.target,e.selection)', 't.set(o,e.other,e.selection)'],
    ['l=(0,a.bD)(r.u,e=>null)', 'l=(0,a.bD)(r.other,e=>null)'],
    ['EX:o,HM:', 'EX:o,duplicate:o,HM:'],
  ]
  for (const [before, after] of changes) {
    assert.ok(rspackFixture.includes(before), before)
    const native = webpackState(rspackFixture.replace(before, after))
    assert.throws(() => runtime().discoverAggregateNativeSelectionWebpackBindings(native.module), /Unsupported|unavailable/, before)
  }
  for (const mutate of [
    n => { n.registry.c.selection.error = new Error('Module failed') },
    n => { delete n.registry.c.selection },
    n => { delete n.registry.c.OWtl },
    n => { n.registry.c.OWtl.exports.u = { id: Symbol(), __scopeBrand: 'AppScope' } },
    n => { n.composerScope.__scopeBrand = 'OtherScope' },
    n => { n.composerScope.parent = { __scopeBrand: 'OtherScope' } },
    n => { n.registry.m.other = n.registry.m.selection; n.registry.c.other = n.registry.c.selection },
  ]) {
    const native = webpackState(); mutate(native)
    assert.throws(() => runtime().discoverAggregateNativeSelectionWebpackBindings(native.module), /Unsupported|unavailable|loaded/)
  }
})

test('module loading supports ESM and cached same-origin Rspack entries, rejecting ambiguous resources', async () => {
  const r = runtime(), native = webpackState(), location = { href: 'https://native.invalid/index.html', origin: 'https://native.invalid' }
  r.URL = URL
  const entry = 'https://native.invalid/assets/index.loaded.js'
  const document = { scripts: [
    { type: 'module', src: entry }, { type: 'module', src: entry },
    { type: 'module', src: 'https://other.invalid/assets/index.foreign.js' },
    { type: 'module', src: 'https://native.invalid/assets/async/unloaded.hash.js' },
  ] }
  const calls = []
  const options = { document, location,
    assetUrl: name => name === 'index.loaded.js' ? entry : '',
    loadModule: async name => { calls.push(name); return native.module },
    fetch: () => { throw new Error('Rspack discovery must not fetch async sources') } }
  const bindings = await r.loadAggregateNativeSelectionBindings(options)
  assert.equal(bindings.queued, native.queued)
  assert.deepEqual(calls, ['index.loaded.js'])
  await assert.rejects(r.loadAggregateNativeSelectionBindings({ ...options, assetUrl: () => '' }), /来源/)
  await assert.rejects(r.loadAggregateNativeSelectionBindings({ ...options, document: { scripts: [] } }), /尚未加载/)
  const legacy = nativeState()
  const old = await r.loadAggregateNativeSelectionBindings({
    assetUrl: () => 'old', loadModule: async () => legacy.module,
    fetch: async () => ({ ok: true, text: async () => currentFixture }),
  })
  assert.equal(old.queued, legacy.queued)
})
