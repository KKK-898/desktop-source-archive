const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const runtimePath = path.resolve(__dirname, '../src-tauri/src/codex_fuel_runtime.js')
const usageSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_usage_runtime.js'), 'utf8')
const signature = fs.readFileSync(path.join(__dirname, 'fixtures/codex-fuel-gate-26.911.js'), 'utf8')
const currentSignaturePath = path.join(__dirname, 'fixtures/codex-fuel-gate-26.917.js')
const currentSignature = fs.readFileSync(currentSignaturePath, 'utf8')
const currentConsumerSignature = fs.readFileSync(
  path.join(__dirname, 'fixtures/codex-fuel-composer-26.917.js'), 'utf8')
const consumerSignature = 'import{UI as Gate}from"./app-initial-fixture.js";' +
  'function Composer(){let quota=useFamily(Gate,host),disabled=busy||loading||quota;' +
  'return jsx(Input,{submitDisabled:disabled})}'
const nativeFixturePath = process.env.CODEX_NATIVE_APP_INITIAL_FIXTURE
  ? path.resolve(process.env.CODEX_NATIVE_APP_INITIAL_FIXTURE)
  : null
const nativeAsarPath = process.env.CODEX_NATIVE_APP_ASAR
  ? path.resolve(process.env.CODEX_NATIVE_APP_ASAR)
  : null

// A deliberately small readable-family implementation for the portable tests.
// It models the public descriptors and per-scope family ownership, not Codex's
// quota algorithm. The optional browser test below checks the real framework's
// cached React hook/eviction behavior, which this implementation cannot prove.
function createFramework() {
  const member = Symbol('maitai.resolveFamilyMemberInternal')
  const evict = Symbol('maitai.evictFamilyMemberInternal')
  const listeners = new Set()
  const scope = { id: Symbol('fixture-root'), __scopeBrand: 'fuel-test' }
  const root = { token: scope, value: {}, familyBindings: new Map(), cachedBindings: new WeakMap(),
    retainedScopeEntries: new Map(), familyKeysByOwner: new Map() }
  const chain = new Map([[scope.id, root]])
  let writes = 0
  const store = {
    get: atom => atom.read ? atom.read() : atom.value,
    set(atom, value) {
      writes += 1
      atom.value = typeof value === 'function' ? value(store.get(atom)) : value
      for (const listener of [...listeners]) listener()
    },
    sub(_atom, callback) { listeners.add(callback); return () => listeners.delete(callback) },
  }
  root.store = store
  function reader(node, context) {
    return {
      get(value, key) {
        if (value.kind === 'readable-family') return value.read(node, context, key)
        return store.get(value.resolve(node, context))
      },
      scope: { value: node.value, node, chain: context, scope: node.token },
    }
  }
  function descriptor(token, makeAtom) {
    const cache = new WeakMap()
    return {
      scope: token,
      resolve(node, context) {
        if (!cache.has(node)) cache.set(node, makeAtom(node, context))
        return cache.get(node)
      },
    }
  }
  function signal(token, value) { return descriptor(token, () => ({ value })) }
  function derived(token, calculate) {
    return descriptor(token, (node, context) => ({ read: () => calculate(reader(node, context)) }))
  }
  function family(token, calculate) {
    const keyFor = key => key && typeof key === 'object'
      ? JSON.stringify(Object.fromEntries(Object.keys(key).sort().map(name => [name, key[name]])))
      : key
    const value = {
      kind: 'readable-family', scope: token,
      [member](node, context, key) {
        let cache = node.familyBindings.get(value)
        if (!cache) { cache = new Map(); node.familyBindings.set(value, cache) }
        const cacheKey = keyFor(key)
        if (!cache.has(cacheKey)) cache.set(cacheKey, {
          value: derived(token, read => calculate(key, read)),
          disposal: { atom: { value: false } },
        })
        return cache.get(cacheKey)
      },
      [evict](node, context, key) {
        const cached = node.familyBindings.get(value)
        const found = cached?.get(keyFor(key))
        cached?.delete(keyFor(key))
        if (found?.disposal) store.set(found.disposal.atom, true)
      },
      resolve(node, context, key) { return value[member](node, context, key).value },
      read(node, context, key) { return store.get(value.resolve(node, context, key).resolve(node, context)) },
    }
    return value
  }
  return { scope, root, chain, signal, derived, family, member, evict, store,
    get: (value, key) => reader(root, chain).get(value, key),
    get writes() { return writes } }
}

function loadRuntime(extra = {}) {
  const sandbox = { console, URL, Map, Set, WeakMap, WeakSet, AbortController, setTimeout, clearTimeout, setInterval,
    clearInterval, queueMicrotask, ...extra }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext((usageSource + String.fromCharCode(10) + fs.readFileSync(runtimePath, 'utf8')), sandbox, { filename: runtimePath })
  return sandbox
}

function activeState(overrides = {}) {
  return { ok: true, enabled: true, provider: 'custom', mode: 'relay',
    baseUrl: 'https://relay.example.invalid/v1', ...overrides }
}

function createFixture(runtime, options = {}) {
  const framework = createFramework()
  const state = { current: activeState(options.state) }
  const route = {
    host: 'local', provider: 'custom', cwd: 'D:/synthetic-project',
    config: { model_provider: 'custom', model_providers: {
      custom: { name: 'Gaoge', base_url: state.current.baseUrl, wire_api: 'responses', requires_openai_auth: true },
    } },
    ...options.route,
  }
  const identity = Object.freeze({ name: 'Synthetic personal account', email: 'fixture@example.invalid', plan: 'plus' })
  const quota = Object.freeze({ active: false, eligible: true, hardBlocked: true,
    primary: Object.freeze({ usedPercent: 100 }), secondary: Object.freeze({ usedPercent: 100 }) })
  const quotaSignal = framework.signal(framework.scope, quota)
  const accountSignal = framework.signal(framework.scope, identity)
  const bindings = {
    hardBlocked: framework.family(framework.scope, (_host, { get }) => get(quotaSignal).hardBlocked),
    reserveActive: framework.family(framework.scope, (_host, { get }) => get(quotaSignal).active),
    createDerived: framework.derived,
    createSignal: framework.signal,
    config: framework.family(framework.scope, () => ({ data: route.config })),
    threadProvider: framework.family(framework.scope, () => route.provider),
    threadCwd: framework.family(framework.scope, () => route.cwd),
    threadHost: framework.family(framework.scope, () => route.host),
    cloudSelection: framework.family(framework.scope, () => false),
    selectedProject: framework.family(framework.scope, () => route.cwd),
  }
  framework.root.value = { kind: 'local', conversationId: 'synthetic-thread' }
  const originalMember = bindings.hardBlocked[framework.member]
  const originalReserveMember = bindings.reserveActive[framework.member]
  const contexts = [framework.chain]
  const handle = runtime.createCodexFuelFamilyPatch({ bindings, getState: () => state.current,
    findContexts: () => contexts, forceRelayGlobal: options.forceRelayGlobal === true })
  return { framework, state, route, identity, quota, quotaSignal, accountSignal, bindings, handle,
    contexts, originalMember, originalReserveMember,
    read: (host = 'local') => framework.get(bindings.hardBlocked, host),
    reserve: (host = 'local') => framework.get(bindings.reserveActive, host),
  }
}

function createFallbackFixture(options = {}) {
  const fixture = createFixture(loadRuntime(), options)
  const manager = { hostId: 'local', requestClient: { hostId: 'local' }, disposed: false,
    getConversation(id) {
      if (id !== 'synthetic-thread') return null
      return { hostId: fixture.route.host, modelProvider: fixture.route.provider, cwd: fixture.route.cwd }
    } }
  fixture.bindings.contextFallback = true
  fixture.bindings.fallbackManagers = new Set([manager])
  // Seed exactly the effective-configuration query retained by the native
  // composer; the fallback must not create or borrow a query for another cwd.
  if (options.cachedConfig !== false) fixture.framework.get(fixture.bindings.config,
    { hostId: 'local', cwd: fixture.route.cwd })
  return { ...fixture, manager }
}

function moduleFor(bindings) {
  return { UI: bindings.hardBlocked, HI: bindings.reserveActive, Pln: bindings.createDerived,
    Bln: bindings.createSignal, configExport: bindings.config, providerExport: bindings.threadProvider,
    cwdExport: bindings.threadCwd, hostExport: bindings.threadHost,
    cloudExport: bindings.cloudSelection, projectExport: bindings.selectedProject }
}

function createInstallerFixture() {
  const intervals = new Map()
  let nextTimer = 0
  let now = 1000
  const runtime = loadRuntime({
    Date: class extends Date { static now() { return now } },
    setInterval: (callback, delay) => { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id },
    clearInterval: id => intervals.delete(id),
    document: { body: null, querySelectorAll: () => [] },
    addEventListener() {}, removeEventListener() {},
    fetch: async url => ({ ok: true, text: async () => url.includes('app-primary-') ? consumerSignature : signature }),
  })
  const fixture = createFixture(runtime)
  fixture.handle.dispose()
  runtime.codexFuelFindContexts = () => fixture.contexts
  runtime.codexUsageFindComposers = () => ({ contexts: fixture.contexts,
    visibleEditors: fixture.contexts.length, hiddenEditors: 0, unresolvedEditors: 0 })
  let bridgeResult = activeState()
  const options = {
    state: activeState(), assetUrl: prefix => `/fixture-${prefix}.js`,
    loadModule: async prefix => prefix === 'app-shared-'
      ? { sharedDerived: fixture.bindings.createDerived, sharedSignal: fixture.bindings.createSignal }
      : moduleFor(fixture.bindings),
    bridge: async (route, body) => {
      assert.equal(route, '/fuel/status')
      assert.deepEqual(Object.keys(body), [])
      if (bridgeResult instanceof Error) throw bridgeResult
      if (typeof bridgeResult === 'function') return bridgeResult()
      return bridgeResult
    },
  }
  return { ...fixture, runtime, options, intervals,
    setBridge: result => { bridgeResult = result },
    advance: milliseconds => { now += milliseconds },
  }
}

function createNewTaskFixture(options = {}) {
  const fixture = createFixture(loadRuntime(), options)
  const { framework, bindings } = fixture
  framework.root.value = { kind: 'new', routeKind: 'home', focusComposerNonce: null }
  bindings.cloudSelection = framework.signal(framework.scope, options.cloud ?? false)
  bindings.selectedProject = framework.signal(framework.scope, options.project ?? null)
  const targetParams = { selectedProject: options.project ?? null, homeRemoteProject: null,
    existingWorkspaceRoot: null, defaultCwd: 'D:/synthetic-project', ...options.targetParams }
  const target = { projectKey: 'fixture-project', target: { hostId: 'local', cwd: 'D:/synthetic-project' },
    projectLoading: false, resolvedCwd: 'D:/synthetic-project', executionRemoteHostId: null, ...options.target }
  const targetFamily = framework.family(framework.scope, () => target)
  const modeFamily = framework.family(framework.scope, () => ({ effectiveMode: 'local', preferredMode: 'local', ...options.mode }))
  const modeParams = { availability: {}, projectKey: 'fixture-project', ...options.modeParams }
  // Accessing a native family registers the retained selection in the scope;
  // undefined fields disappear from its serialized object key naturally.
  framework.get(targetFamily, targetParams)
  framework.get(modeFamily, modeParams)
  if (options.duplicateTarget) framework.get(targetFamily, { ...targetParams, defaultCwd: 'D:/another-project' })
  if (options.duplicateMode) framework.get(modeFamily, { ...modeParams, availability: { worktree: true } })
  return fixture
}

test('the decision log records why the gate was released or kept, without flooding', () => {
  const fixture = createFixture(loadRuntime())
  try {
    // The runtime is evaluated in its own VM realm, so its arrays do not share
    // this realm's prototype and cannot be compared with deepStrictEqual.
    assert.equal(fixture.handle.decisions.length, 0, 'nothing is recorded before a composer reads')
    // An exhausted official account in 已有账号 mode whose request routes to the
    // relay is the exact case this log exists for: released, and labelled.
    fixture.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
    fixture.handle.refresh()
    assert.equal(fixture.read(), false)
    const released = fixture.handle.decisions.at(-1)
    assert.equal(released.released, true)
    assert.equal(released.blocked, false)
    assert.equal(released.kind, 'chatgpt')
    assert.equal(released.reason, 'relay-confirmed')
    assert.equal(typeof released.at, 'number')
    // Repeated ticks of the same composer must not append duplicates; the gate
    // re-evaluates constantly and an unbounded writer would bury the history.
    const settled = fixture.handle.decisions.length
    for (let index = 0; index < 25; index += 1) fixture.read()
    assert.equal(fixture.handle.decisions.length, settled)
    // A genuine refusal is recorded with the branch that caused it.
    fixture.route.config.model_provider = 'openai'
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
    const refused = fixture.handle.decisions[fixture.handle.decisions.length - 1]
    assert.equal(refused.released, false)
    assert.equal(refused.blocked, true)
    assert.equal(refused.reason, 'config-not-relay')
    assert.equal(refused.kind, 'chatgpt')
    // Turning the relay off is its own reason, not a silent native block.
    fixture.state.current = activeState({ enabled: false })
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
    assert.equal(fixture.handle.decisions.at(-1).reason, 'relay-off')
    // A release with no readable workspace is a deferral, and it must not be
    // reported as a verified route: the two are different kinds of evidence.
    const deferring = createFixture(loadRuntime())
    try {
      deferring.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
      deferring.bindings.threadCwd = deferring.framework.family(deferring.framework.scope, () => null)
      deferring.handle.refresh()
      assert.equal(deferring.read(), false)
      const deferred = deferring.handle.decisions.at(-1)
      assert.equal(deferred.reason, 'account-workspace-unknown')
      assert.equal(deferred.released, true)
      assert.equal(deferred.blocked, false)
    } finally { deferring.handle.dispose() }
    // The window is bounded and keeps the newest entries.
    for (const kind of ['cloud', 'new', 'unrecognized', 'local']) {
      fixture.framework.root.value = { kind, conversationId: 'synthetic-thread' }
      fixture.handle.refresh()
      fixture.read()
    }
    assert.ok(fixture.handle.decisions.length <= 24)
  } finally { fixture.handle.dispose() }
})

test('the decision log never carries account identity or message content', () => {
  const fixture = createFixture(loadRuntime())
  try {
    fixture.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
    fixture.handle.refresh()
    fixture.read()
    const serialized = JSON.stringify(fixture.handle.decisions)
    for (const secret of ['fixture@example.invalid', 'Synthetic personal account',
      'relay.example.invalid', 'synthetic-thread']) {
      assert.equal(serialized.includes(secret), false, `${secret} must not be exported`)
    }
    assert.deepEqual(Object.keys(fixture.handle.decisions[0]).sort(),
      ['at', 'blocked', 'kind', 'reason', 'released'])
    // Callers receive a copy, so a report cannot corrupt the retained window.
    fixture.handle.decisions[0].reason = 'tampered'
    assert.notEqual(fixture.handle.decisions[0].reason, 'tampered')
  } finally { fixture.handle.dispose() }
})

test('diagnostics() bundles the routing state a support report needs', async () => {
  const fixture = createInstallerFixture()
  try {
    const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    const report = handle.diagnostics()
    assert.equal(report.version, handle.version)
    assert.equal(report.adapterMode, handle.adapterMode)
    assert.equal(report.submitScopeBound, handle.submitScopeBound)
    assert.equal(report.ready, handle.ready)
    assert.ok(Array.isArray(report.decisions))
    // A report must say which resolver path ran even when no routing decision
    // was ever recorded, so both surfaces ship together.
    assert.ok(Array.isArray(report.branches))
    assert.equal(typeof report.stats, 'object')
    assert.equal(report.stats.resolveCalls, handle.stats.resolveCalls)
    // The report describes the patch, never the signed-in person.
    const serialized = JSON.stringify(report)
    for (const secret of ['fixture@example.invalid', 'Synthetic personal account']) {
      assert.equal(serialized.includes(secret), false)
    }
    assert.equal(report.routeError, handle.routeError)
  } finally { fixture.runtime.__gaogeCodexFuelRuntime?.dispose() }
})

test('fuel runtime source parses as the injected classic script', () => {
  assert.doesNotThrow(() => new vm.Script((usageSource + String.fromCharCode(10) + fs.readFileSync(runtimePath, 'utf8'))))
  const runtime = loadRuntime()
  assert.equal(typeof runtime.installCodexFuelRuntime, 'function')
  assert.equal(typeof runtime.createCodexFuelFamilyPatch, 'function')
})

test('the branch record identifies the path even when the decision log is empty', () => {
  // Some paths make the gate stay shut without ever reaching the routing block
  // that writes a decision: a composer kind the relay cannot serve, no context
  // node at all, a native value that is not the boolean `true`, and the root
  // scope fallback. On the released build all four produced an empty log, which
  // is the same reading as a patch that never loaded. These must stay distinct.
  const runtime = loadRuntime()

  const unserved = createFixture(runtime)
  try {
    unserved.framework.root.value = { kind: 'cloud', conversationId: 'synthetic-thread' }
    unserved.handle.refresh()
    assert.equal(unserved.read(), true)
    assert.equal(unserved.handle.decisions.length, 0, 'a remote kind is not a routing decision')
    assert.equal(unserved.handle.branches.map(record => record.branch).join(','), 'remote-kind:cloud')
    assert.equal(unserved.handle.stats.remoteKind, 1)
    assert.equal(unserved.handle.stats.derivedEvals, 0, 'the routing derived was never built')
  } finally { unserved.handle.dispose() }

  const unrecognised = createFixture(runtime)
  try {
    unrecognised.framework.root.value = { kind: 'unrecognised-shell', conversationId: 'synthetic-thread' }
    unrecognised.handle.refresh()
    unrecognised.read()
    assert.equal(unrecognised.handle.branches.map(record => record.branch).join(','), 'no-context')
    assert.equal(unrecognised.handle.stats.noContext, 1)
    assert.equal(unrecognised.handle.stats.resolveCalls, 1, 'the wrapper did run')
  } finally { unrecognised.handle.dispose() }

  // A native value that is not a boolean cannot be routed at all, so the log
  // stays empty and the counters have to carry the whole diagnosis.
  const odd = createFixture(runtime)
  try {
    odd.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
    odd.framework.store.set(odd.quotaSignal.resolve(odd.framework.root, odd.framework.chain),
      { active: false, eligible: true, hardBlocked: undefined })
    odd.handle.refresh()
    assert.equal(odd.read(), undefined, 'an unknown native value passes through unchanged')
    assert.equal(odd.handle.branches.map(record => record.branch).join(','), 'native-undefined:chatgpt')
    assert.equal(odd.handle.stats.derivedNativeNotBlocked, 1)
    assert.equal(odd.handle.stats.released, 0, 'nothing was released')
  } finally { odd.handle.dispose() }

  // The root scope fallback needs a bound composer scope and a chain whose only
  // node carries no recognised kind, which is how both appear in the live app.
  const fallback = createFixture(runtime)
  try {
    fallback.bindings.composerVerified = true
    fallback.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
    fallback.handle.refresh()
    assert.equal(fallback.handle.scopeBound, true, 'the composer scope must be bound first')
    const node = { token: fallback.framework.scope, value: {}, store: fallback.framework.store,
      familyBindings: fallback.framework.root.familyBindings, parent: null }
    const resolveKey = Object.getOwnPropertySymbols(fallback.bindings.hardBlocked)
      .find(symbol => symbol.description === 'maitai.resolveFamilyMemberInternal')
    fallback.bindings.hardBlocked[resolveKey](node, new Map([[fallback.framework.scope.id, node]]), 'local')
    assert.equal(fallback.handle.branches.map(record => record.branch).join(','), 'root-scope-fallback')
    assert.equal(fallback.handle.stats.rootBranch, 1)
    // Repeat reads must not append: the resolver is read on every render.
    for (let index = 0; index < 20; index += 1) {
      fallback.bindings.hardBlocked[resolveKey](node, new Map([[fallback.framework.scope.id, node]]), 'local')
    }
    assert.equal(fallback.handle.branches.length, 1, 'the branch record is latched, not per read')
    assert.equal(fallback.handle.stats.rootBranch, 21, 'the counter tracks every read')
  } finally { fallback.handle.dispose() }

  // Callers receive copies, and the diagnostic surface carries no page text.
  const copied = createFixture(runtime)
  try {
    copied.framework.root.value = { kind: 'cloud', conversationId: 'synthetic-thread' }
    copied.read()
    copied.handle.branches[0].branch = 'tampered'
    assert.equal(copied.handle.branches[0].branch, 'remote-kind:cloud')
    copied.handle.stats.remoteKind = 999
    assert.equal(copied.handle.stats.remoteKind, 1)
    const serialized = JSON.stringify(copied.handle.branches) + JSON.stringify(copied.handle.stats)
    assert.equal(serialized.includes('synthetic-thread'), false)
  } finally { copied.handle.dispose() }
})

test('local paid fuel removes only the official quota gate and preserves account data', () => {
  const runtime = loadRuntime()
  const fixture = createFixture(runtime)
  try {
    fixture.handle.refresh()
    assert.equal(fixture.read(), false)
    assert.equal(fixture.framework.get(fixture.quotaSignal), fixture.quota)
    assert.equal(fixture.framework.get(fixture.accountSignal), fixture.identity)
    assert.equal(fixture.quota.primary.usedPercent, 100)
    assert.equal(fixture.quota.secondary.usedPercent, 100)
    const canSubmit = otherDisabled => !otherDisabled && !fixture.read()
    assert.equal(canSubmit(false), true)
    assert.equal(canSubmit(true), false, 'empty input/busy/upload/auth conditions retain their native decision')
  } finally { fixture.handle.dispose() }
})

test('closing fuel restores official quota state on the same family', () => {
  const fixture = createFixture(loadRuntime())
  try {
    fixture.handle.refresh()
    assert.equal(fixture.read(), false)
    fixture.state.current = activeState({ enabled: false })
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
    fixture.state.current = activeState()
    fixture.handle.refresh()
    assert.equal(fixture.read(), false)
  } finally { fixture.handle.dispose() }
  assert.equal(fixture.read(), true)
  assert.equal(fixture.bindings.hardBlocked[fixture.framework.member], fixture.originalMember)
  assert.equal(fixture.bindings.reserveActive[fixture.framework.member], fixture.originalReserveMember)
})

test('relay-global mode unlocks without composer context and relocks when relay is off', () => {
  const runtime = loadRuntime()
  const fixture = createFixture(runtime, { forceRelayGlobal: true })
  try {
    fixture.contexts.length = 0
    runtime.codexFuelContextNode = () => { throw new Error('composer context must not be read') }
    assert.equal(fixture.read(), false)
    assert.ok(fixture.handle.stats.globalForced > 0)
    assert.ok(fixture.handle.branches.some(record => record.branch === 'relay-global-force'))
    assert.equal(fixture.handle.decisions.at(-1).reason, 'relay-global-forced')

    fixture.state.current = activeState({ enabled: false })
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)

    fixture.state.current = activeState()
    fixture.handle.refresh()
    assert.equal(fixture.read(), false)
  } finally { fixture.handle.dispose() }
})

test('remote and cloud quota keys are never released', () => {
  const fixture = createFixture(loadRuntime())
  try {
    fixture.handle.refresh()
    for (const host of ['cloud', 'remote-server', '', undefined, null, { hostId: 'local' }]) {
      const blocked = fixture.framework.get(fixture.bindings.hardBlocked, host)
      assert.equal(blocked, true, `must retain quota for ${String(host)}`)
    }
  } finally { fixture.handle.dispose() }
})

test('a nonlocal, missing, or foreign-provider conversation fails closed', async t => {
  for (const [label, route] of [
    ['remote host', { host: 'remote-server' }],
    ['missing host', { host: null }],
    ['official provider', { provider: 'openai' }],
    ['another provider', { provider: 'other' }],
    ['missing provider', { provider: null }],
    ['missing cwd', { cwd: null }],
    ['missing config', { config: null }],
    ['different relay address', { config: { model_provider: 'custom', model_providers: { custom: {
      name: 'Gaoge', base_url: 'https://different.example.invalid/v1' } } } }],
  ]) {
    await t.test(label, () => {
      const fixture = createFixture(loadRuntime(), { route })
      try { fixture.handle.refresh(); assert.equal(fixture.read(), true) }
      finally { fixture.handle.dispose() }
    })
  }
})

test('invalid fuel state fails closed', async t => {
  for (const [label, state] of [
    ['off', { enabled: false }], ['wrong provider', { provider: 'openai' }],
    ['unrecognized mode', { mode: 'unknown' }], ['no relay address', { baseUrl: '' }],
  ]) {
    await t.test(label, () => {
      const fixture = createFixture(loadRuntime(), { state })
      try { fixture.handle.refresh(); assert.equal(fixture.read(), true) }
      finally { fixture.handle.dispose() }
    })
  }
})

test('reserve fallback is disabled only for the paid local route', () => {
  const fixture = createFixture(loadRuntime())
  try {
    fixture.framework.store.set(fixture.quotaSignal.resolve(fixture.framework.root, fixture.framework.chain),
      { ...fixture.quota, active: true, hardBlocked: false })
    assert.equal(fixture.reserve(), false)
    assert.equal(fixture.reserve('remote-server'), true)
    fixture.state.current = activeState({ enabled: false })
    fixture.handle.refresh()
    assert.equal(fixture.reserve(), true)
  } finally { fixture.handle.dispose() }
})

test('cloud, unknown and missing composer contexts retain the native gate', async t => {
  for (const kind of ['cloud', 'unrecognized', null]) {
    await t.test(String(kind), () => {
      const fixture = createFixture(loadRuntime())
      try {
        fixture.framework.root.value = kind === null ? {} : { kind, conversationId: 'synthetic-thread' }
        fixture.handle.refresh()
        assert.equal(fixture.read(), true)
      } finally { fixture.handle.dispose() }
    })
  }
})

// The account-backed kind exists only while 已有账号登录 is active, which is the
// mode whose own exhausted plan used to lock the composer even with the relay
// configured. It reads the same workspace evidence as a local thread, but the
// absence of that evidence defers to the confirmed route instead of re-locking.
test('an exhausted account-backed composer sends through the confirmed relay', async t => {
  await t.test('readable workspace and relay configuration release the gate', () => {
    const fixture = createFixture(loadRuntime())
    try {
      fixture.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
      fixture.handle.refresh()
      assert.equal(fixture.quota.hardBlocked, true)
      assert.equal(fixture.read(), false, 'the official quota value is released, not rewritten')
      assert.equal(fixture.framework.get(fixture.quotaSignal), fixture.quota)
      assert.equal(fixture.framework.get(fixture.accountSignal), fixture.identity)
    } finally { fixture.handle.dispose() }
  })
  await t.test('a missing thread record still defers to the confirmed route', () => {
    const fixture = createFixture(loadRuntime())
    try {
      fixture.framework.root.value = { kind: 'chatgpt', conversationId: 'unknown-thread' }
      fixture.handle.refresh()
      assert.equal(fixture.read(), false)
    } finally { fixture.handle.dispose() }
  })
  // Fail-open is scoped to unmistakable evidence. A workspace recorded against
  // a readable non-local host is not served by this relay, and a configuration
  // that does not match the active route proves the request is not relay work.
  await t.test('a readable non-local thread keeps the official gate', async t2 => {
    for (const [label, mutate] of [
      ['remote thread host', f => { f.route.host = 'remote-server' }],
      ['foreign endpoint', f => { f.route.config.model_providers.custom.base_url = 'https://foreign.example.invalid/v1' }],
      ['official provider', f => { f.route.config.model_provider = 'openai' }],
    ]) await t2.test(label, () => {
      const fixture = createFixture(loadRuntime())
      try {
        fixture.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
        mutate(fixture)
        fixture.handle.refresh()
        assert.equal(fixture.read(), true)
      } finally { fixture.handle.dispose() }
    })
  })
  await t.test('an unreadable workspace defers rather than locking', () => {
    const fixture = createFixture(loadRuntime())
    try {
      fixture.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
      fixture.route.cwd = '   '
      fixture.handle.refresh()
      assert.equal(fixture.read(), false)
    } finally { fixture.handle.dispose() }
  })
  await t.test('a disabled or switched route restores the official gate', () => {
    const fixture = createFixture(loadRuntime())
    try {
      fixture.framework.root.value = { kind: 'chatgpt', conversationId: 'synthetic-thread' }
      fixture.handle.refresh()
      assert.equal(fixture.read(), false)
      fixture.state.current = activeState({ enabled: false })
      fixture.handle.refresh()
      assert.equal(fixture.read(), true)
    } finally { fixture.handle.dispose() }
  })
})

test('scoped force mode releases the real quota family using native thread and cached route evidence', () => {
  const fixture = createFallbackFixture()
  try {
    for (const key of ['threadProvider', 'threadCwd', 'threadHost', 'config', 'cloudSelection', 'selectedProject']) {
      delete fixture.bindings[key]
    }
    fixture.handle.refresh()
    assert.equal(fixture.read(), false, 'selector names are not required for the fallback')
    assert.equal(fixture.framework.get(fixture.quotaSignal), fixture.quota)
    assert.equal(fixture.framework.get(fixture.accountSignal), fixture.identity)
    assert.equal(fixture.quota.hardBlocked, true)
    fixture.framework.store.set(fixture.quotaSignal.resolve(fixture.framework.root, fixture.framework.chain),
      { ...fixture.quota, active: true })
    assert.equal(fixture.reserve(), false)
    assert.equal(fixture.reserve('remote-server'), true)
    fixture.route.provider = 'openai'
    fixture.handle.refresh()
    assert.equal(fixture.read(), true, 'an official thread restores the original decision')
    fixture.route.provider = 'custom'
    fixture.handle.refresh()
    assert.equal(fixture.read(), false)
    fixture.state.current.enabled = false
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
  } finally { fixture.handle.dispose() }
})

test('scoped force mode never borrows ambiguous, stale, foreign or unavailable route evidence', async t => {
  for (const [label, options, mutate] of [
    ['no cached effective config', { cachedConfig: false }, () => {}],
    ['remote thread', { route: { host: 'remote-server' } }, () => {}],
    ['official thread', { route: { provider: 'openai' } }, () => {}],
    ['unknown thread', {}, f => { f.manager.getConversation = () => null }],
    ['different composer thread', {}, f => { f.framework.root.value.conversationId = 'another-thread' }],
    ['disposed manager', {}, f => { f.manager.disposed = true }],
    ['remote manager', {}, f => { f.manager.hostId = 'remote-server' }],
    ['remote request client', {}, f => { f.manager.requestClient.hostId = 'remote-server' }],
    ['cloud composer', {}, f => { f.framework.root.value.kind = 'cloud' }],
    ['unknown config', { route: { config: {} } }, () => {}],
    ['foreign endpoint', {}, f => { f.route.config.model_providers.custom.base_url = 'https://foreign.example.invalid/v1' }],
    ['different config cwd', { cachedConfig: false }, f => {
      f.framework.get(f.bindings.config, { hostId: 'local', cwd: 'D:/other-project' })
    }],
    ['different config host', { cachedConfig: false }, f => {
      f.framework.get(f.bindings.config, { hostId: 'remote-server', cwd: f.route.cwd })
    }],
    ['nonconfiguration query arguments', { cachedConfig: false }, f => {
      f.framework.get(f.bindings.config, { hostId: 'local', cwd: f.route.cwd, profile: 'other' })
    }],
    ['conflicting thread directories', {}, f => {
      f.bindings.fallbackManagers.add({ ...f.manager, getConversation: () => ({
        hostId: 'local', modelProvider: 'custom', cwd: 'D:/other-project',
      }) })
    }],
    ['conflicting config provider', {}, f => {
      const other = f.framework.family(f.framework.scope, () => ({ data: { model_provider: 'openai' } }))
      f.framework.get(other, { hostId: 'local', cwd: f.route.cwd })
    }],
    ['pending config with last known data', {}, f => {
      const pending = f.framework.family(f.framework.scope, () => ({ data: f.route.config, isPending: true }))
      f.framework.get(pending, { hostId: 'local', cwd: f.route.cwd })
    }],
    ['pending query without data beside a previously loaded config', {}, f => {
      const pending = f.framework.family(f.framework.scope, () => ({ isPending: true }))
      f.framework.get(pending, { hostId: 'local', cwd: f.route.cwd })
    }],
  ]) await t.test(label, () => {
    const fixture = createFallbackFixture(options)
    try {
      mutate(fixture)
      // Exercise the cache-only recovery used when the config family itself
      // cannot be identified. Recognized native queries have separate tests.
      delete fixture.bindings.config
      fixture.handle.refresh()
      assert.equal(fixture.read(), true)
    } finally { fixture.handle.dispose() }
  })
})

test('cache-only fallback finds the exact route after thousands of unrelated cache entries', () => {
  const fixture = createFallbackFixture()
  try {
    delete fixture.bindings.config
    const unrelated = new Map(Array.from({ length: 8000 }, (_, i) => [
      JSON.stringify({ cwd: `D:/unrelated-${i}`, hostId: 'local' }),
      { get value() { throw new Error('unrelated queries must never be read') } },
    ]))
    fixture.framework.root.familyBindings = new Map([
      [{}, unrelated], ...fixture.framework.root.familyBindings,
    ])
    fixture.handle.refresh()
    assert.equal(fixture.read(), false)
    fixture.state.current.enabled = false
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
  } finally { fixture.handle.dispose() }
})

test('fallback with a recognized config family loads the exact route without a preseeded cache', () => {
  const fixture = createFallbackFixture({ cachedConfig: false })
  try {
    const config = fixture.bindings.config
    assert.equal(fixture.framework.root.familyBindings.has(config), false)
    assert.equal(fixture.read(), false)
    assert.equal(fixture.framework.root.familyBindings.has(config), true)
    fixture.route.config.model_providers.custom.base_url = 'https://other.example.invalid/v1'
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
  } finally { fixture.handle.dispose() }
})

test('recognized fallback waits for config completion and refuses an errored or foreign route', () => {
  const fixture = createFallbackFixture({ cachedConfig: false })
  let result = { isPending: true }
  fixture.bindings.config = fixture.framework.family(fixture.framework.scope, () => result)
  try {
    assert.equal(fixture.read(), true)
    result = { data: fixture.route.config, isLoading: false, isPending: false }
    fixture.handle.refresh()
    assert.equal(fixture.read(), false)
    result = { data: fixture.route.config, isError: true }
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
    result = { data: { model_provider: 'openai' } }
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
  } finally { fixture.handle.dispose() }
})

test('unrecognized new-task selectors do not affect established local sessions', () => {
  const fixture = createFixture(loadRuntime())
  try {
    fixture.bindings.newTargetSelectorsUnavailable = true
    delete fixture.bindings.cloudSelection
    delete fixture.bindings.selectedProject
    assert.equal(fixture.read(), false)
    fixture.framework.root.value.cloudThreadPrototype = true
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
    fixture.framework.root.value = { kind: 'new' }
    fixture.handle.refresh()
    assert.equal(fixture.read(), true)
  } finally { fixture.handle.dispose() }
})

test('scoped force mode supports a uniquely resolved new local or worktree composer without selector names', async t => {
  for (const mode of ['local', 'worktree']) await t.test(mode, () => {
    const fixture = createNewTaskFixture({ mode: { effectiveMode: mode, preferredMode: mode } })
    try {
      fixture.bindings.contextFallback = true
      fixture.bindings.fallbackManagers = new Set()
      delete fixture.bindings.cloudSelection
      delete fixture.bindings.selectedProject
      fixture.framework.get(fixture.bindings.config, { hostId: 'local', cwd: fixture.route.cwd })
      fixture.handle.refresh()
      assert.equal(fixture.read(), false)
    } finally { fixture.handle.dispose() }
  })
})

test('recognized signatures resolve the expected families and reject unsupported changes', () => {
  const runtime = loadRuntime()
  const fixture = createFixture(runtime)
  try {
    const bindings = runtime.discoverCodexFuelBindings(signature, moduleFor(fixture.bindings))
    for (const name of Object.keys(bindings).filter(name => name !== 'hardBlockedExport')) {
      assert.equal(bindings[name], fixture.bindings[name], name)
    }
    assert.throws(() => runtime.discoverCodexFuelBindings(signature.replace('.hardBlocked)', '.quotaBlocked)'), moduleFor(fixture.bindings)), /signature/)
    assert.throws(() => runtime.discoverCodexFuelBindings(signature + '\nother=Hp(Q,(e,{get:t})=>t(Cro,e).hardBlocked)', moduleFor(fixture.bindings)), /signature/)
    assert.throws(() => runtime.discoverCodexFuelBindings(signature, {}), /not initialized/)
  } finally { fixture.handle.dispose() }
})

test('26.917 discovers the moved host selector and imported signal factories', () => {
  const runtime = loadRuntime()
  const fixture = createFixture(runtime)
  try {
    const module = {
      hardExport: fixture.bindings.hardBlocked,
      activeExport: fixture.bindings.reserveActive,
      configExport: fixture.bindings.config,
      providerExport: fixture.bindings.threadProvider,
      cwdExport: fixture.bindings.threadCwd,
      hostExport: fixture.bindings.threadHost,
      cloudExport: fixture.bindings.cloudSelection,
      projectExport: fixture.bindings.selectedProject,
    }
    const bindings = runtime.discoverCodexFuelBindings(currentSignature, module, {
      'app-shared-': { sharedDerived: fixture.bindings.createDerived, sharedSignal: fixture.bindings.createSignal },
    })
    assert.equal(bindings.hardBlocked, fixture.bindings.hardBlocked)
    assert.equal(bindings.reserveActive, fixture.bindings.reserveActive)
    assert.equal(bindings.createDerived, fixture.bindings.createDerived)
    assert.equal(bindings.createSignal, fixture.bindings.createSignal)
    assert.equal(bindings.threadHost, fixture.bindings.threadHost)
    assert.doesNotThrow(() => runtime.verifyCodexFuelComposer(
      currentConsumerSignature, bindings.hardBlockedExport))
  } finally { fixture.handle.dispose() }
})

test('composer verification requires the quota hook to feed the native submitDisabled OR', () => {
  const runtime = loadRuntime()
  assert.doesNotThrow(() => runtime.verifyCodexFuelComposer(consumerSignature, 'UI'))
  for (const source of [
    consumerSignature.replace('UI as Gate', 'Other as Gate'),
    consumerSignature.replace('loading||quota', 'loading'),
    consumerSignature.replace('loading||quota', 'loading&&quota'),
    consumerSignature.replace('submitDisabled:disabled', 'sendDisabled:disabled'),
    consumerSignature.replace('useFamily(Gate,host)', 'useFamily(Other,host)'),
  ]) assert.throws(() => runtime.verifyCodexFuelComposer(source, 'UI'), /Unsupported|signature/)
})

test('unsupported family lifecycle rolls back any partial patch', () => {
  const runtime = loadRuntime()
  const fixture = createFixture(runtime)
  fixture.handle.dispose()
  delete fixture.bindings.reserveActive[fixture.framework.evict]
  assert.throws(() => runtime.createCodexFuelFamilyPatch({ bindings: fixture.bindings,
    getState: () => activeState(), findContexts: () => fixture.contexts }), /lifecycle/)
  assert.equal(fixture.bindings.hardBlocked[fixture.framework.member], fixture.originalMember)
})

test('repeated installation and disposal do not stack wrappers or timers', async () => {
  const fixture = createInstallerFixture()
  const first = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(first.ready, true)
    assert.equal(fixture.read(), false)
    const member = fixture.bindings.hardBlocked[fixture.framework.member]
    const second = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    assert.equal(second, first)
    assert.equal(fixture.bindings.hardBlocked[fixture.framework.member], member)
    assert.equal(fixture.intervals.size, 2)
    first.dispose(); first.dispose()
    assert.equal(fixture.intervals.size, 0)
    assert.equal(fixture.read(), true)
    const third = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    assert.notEqual(third, first)
    assert.equal(fixture.read(), false)
    third.dispose()
  } finally { fixture.runtime.__gaogeCodexFuelRuntime?.dispose() }
})

test('updated compatibility discovery replaces an older live adapter and releases its timers', async () => {
  const fixture = createInstallerFixture()
  const previous = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  previous.version -= 1
  const oldTimers = [...fixture.intervals.keys()]
  try {
    const current = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    assert.notEqual(current, previous)
    assert.equal(previous.disposed, true)
    assert.equal(current.ready, true)
    assert.equal(fixture.read(), false)
    assert.equal(fixture.intervals.size, 2)
    assert.ok(oldTimers.every(timer => !fixture.intervals.has(timer)))
    current.dispose()
    assert.equal(fixture.read(), true)
    assert.equal(fixture.intervals.size, 0)
  } finally { fixture.runtime.__gaogeCodexFuelRuntime?.dispose() }
})

test('lost native hooks invalidate health and reinjection replaces the damaged instance once', async () => {
  const fixture = createInstallerFixture()
  const first = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(first.health.healthy, true)
    assert.equal(first.health.nativeHealthy, true)
    assert.equal(first.usageCache.supported, 0, 'a native adapter does not need an observed usage query')
    fixture.bindings.hardBlocked[fixture.framework.member] = fixture.originalMember
    assert.equal(first.health.healthy, false)
    assert.equal(first.health.needsReinstall, true)
    assert.equal(first.health.reason, 'native-hook-lost')
    assert.equal(first.diagnostics().ready, false)
    const recovered = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    assert.notEqual(recovered, first)
    assert.equal(first.disposed, true)
    assert.equal(recovered.health.healthy, true)
    assert.equal(recovered.health.needsReinstall, false)
    assert.equal(fixture.read(), false)
    assert.equal(fixture.intervals.size, 2)
    assert.equal(await fixture.runtime.installCodexFuelRuntime(fixture.options), recovered)
    assert.equal(fixture.intervals.size, 2)
  } finally { fixture.runtime.__gaogeCodexFuelRuntime?.dispose() }
})

test('adapter refresh exceptions stop reporting ready and clear after the next successful refresh', async () => {
  const fixture = createInstallerFixture()
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  const discover = fixture.runtime.codexFuelFindContexts
  const render = [...fixture.intervals.values()].find(entry => entry.delay === 750).callback
  try {
    fixture.runtime.codexFuelFindContexts = () => { throw new Error('synthetic context failure') }
    render()
    assert.equal(handle.ready, false)
    assert.equal(handle.health.healthy, false)
    assert.equal(handle.health.reason, 'adapter-refresh-failed')
    fixture.runtime.codexFuelFindContexts = discover
    render()
    assert.equal(handle.ready, true)
    assert.equal(handle.health.healthy, true)
    assert.equal(handle.health.needsReinstall, false)
    assert.equal(fixture.intervals.size, 2)
  } finally { handle.dispose() }
})

test('bridge outages beyond six seconds retain the relay without extending the bounded grace period', async () => {
  const fixture = createInstallerFixture()
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(fixture.read(), false)
    fixture.setBridge(new Error('synthetic connection failure'))
    await handle.refresh()
    assert.equal(fixture.read(), false)
    assert.equal(handle.enabled, true)
    assert.equal(handle.reason, 'relay-status-retrying')
    fixture.advance(6001)
    for (const entry of fixture.intervals.values()) if (entry.delay === 750) entry.callback()
    assert.equal(fixture.read(), false, 'an outage beyond the old six-second TTL must not relock sending')
    await handle.refresh()
    assert.equal(fixture.read(), false)
    assert.equal(handle.reason, 'relay-status-retrying')
    fixture.advance(fixture.runtime.CODEX_FUEL_STATUS_GRACE_MS - 6002)
    await handle.refresh()
    assert.equal(fixture.read(), false)
    fixture.advance(2)
    for (const entry of fixture.intervals.values()) if (entry.delay === 750) entry.callback()
    assert.equal(fixture.read(), true, 'failed refreshes must not extend the last confirmed state TTL')
    assert.equal(handle.enabled, false)
    assert.equal(handle.reason, 'relay-status-expired')
    assert.equal(handle.health.healthy, true, 'helper expiry is not adapter damage')
    assert.equal(handle.health.needsReinstall, false)
    await handle.refresh()
    assert.equal(fixture.read(), true)
    assert.equal(handle.enabled, false)
    fixture.setBridge(activeState())
    await handle.refresh()
    assert.equal(fixture.read(), false)
    assert.equal(handle.reason, 'relay-provider-confirmed')
    assert.equal(handle.health.healthy, true)
  } finally { handle.dispose() }
})

test('an explicit relay disable restores the native gate immediately without the status grace period', async () => {
  const fixture = createInstallerFixture()
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(fixture.read(), false)
    fixture.advance(7000)
    fixture.setBridge(new Error('synthetic reconnect'))
    await handle.refresh()
    assert.equal(fixture.read(), false)
    fixture.setBridge(activeState({ enabled: false }))
    await handle.refresh()
    assert.equal(handle.enabled, false)
    assert.equal(fixture.read(), true)
    assert.equal(handle.reason, 'relay-disabled')
    fixture.setBridge({ ok: false, enabled: true })
    await handle.refresh()
    assert.equal(fixture.read(), true, 'an invalid response cannot revive the previously disabled route')
    assert.equal(handle.enabled, false)
  } finally { handle.dispose() }
})

test('a confirmed different relay endpoint immediately loses ownership of the current composer', async () => {
  const fixture = createInstallerFixture()
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(fixture.read(), false)
    fixture.setBridge(activeState({ baseUrl: 'https://new-relay.example.invalid/v1' }))
    await handle.refresh()
    assert.equal(fixture.read(), true, 'the prior endpoint must not survive a confirmed route change')
  } finally { handle.dispose() }
})

test('transient helper failures retry while native speed metadata stays outside quota ownership', async () => {
  const fixture = createInstallerFixture()
  fixture.options.state = activeState({ apiSpeedEnabled: true, speedMode: 'fast' })
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    let attempts = 0
    fixture.setBridge(() => {
      attempts += 1
      if (attempts === 1) throw new Error('synthetic auth file replacement')
      return activeState({ apiSpeedEnabled: true, speedMode: 'standard' })
    })
    await handle.refresh()
    assert.equal(attempts, 2)
    assert.equal(fixture.read(), false)
    assert.equal(handle.enabled, true)
    assert.equal(handle.speedInstalled, false)
  } finally { handle.dispose() }
})

test('legacy API speed changes retain quota hooks and install no speed controls or extra polling', async () => {
  const fixture = createInstallerFixture()
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    const member = fixture.bindings.hardBlocked[fixture.framework.member]
    for (const apiSpeedEnabled of [true, false, true, false]) {
      let attempts = 0
      fixture.setBridge(() => {
        attempts += 1
        return activeState({ apiSpeedEnabled, speedMode: apiSpeedEnabled ? 'fast' : 'standard' })
      })
      await handle.refresh()
      assert.equal(attempts, 1, 'speed metadata must not add quota status retries')
      assert.equal(handle.speedInstalled, false)
      assert.equal(handle.speedReady, false)
      assert.equal(handle.speedLastRequest, null)
      assert.equal(fixture.read(), false)
      assert.equal(fixture.bindings.hardBlocked[fixture.framework.member], member)
      assert.deepEqual([...fixture.intervals.values()].map(timer => timer.delay), [3000, 750])
    }
  } finally { handle.dispose() }
})

test('a hung bridge times out, and a late success cannot reactivate fuel', async () => {
  const fixture = createInstallerFixture()
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  let release
  try {
    fixture.setBridge(() => new Promise(resolve => { release = resolve }))
    const started = Date.now()
    await handle.refresh()
    assert.ok(Date.now() - started >= 1700)
    assert.equal(handle.enabled, true)
    assert.equal(fixture.read(), false)
    assert.equal(handle.reason, 'relay-status-retrying')
    fixture.advance(fixture.runtime.CODEX_FUEL_STATUS_GRACE_MS + 1)
    for (const entry of fixture.intervals.values()) if (entry.delay === 750) entry.callback()
    assert.equal(handle.enabled, false)
    assert.equal(fixture.read(), true)
    release(activeState())
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fixture.read(), true)
    assert.equal(handle.enabled, false)
    assert.equal(handle.reason, 'relay-status-expired')
    assert.equal(handle.health.needsReinstall, false)
    fixture.setBridge(activeState())
    await handle.refresh()
    assert.equal(fixture.read(), false, 'a fresh response recovers after the timed-out bridge without restart')
    assert.equal(handle.enabled, true)
  } finally { handle.dispose() }
})

test('an in-flight status response cannot override a newer explicit disabled state', async () => {
  const fixture = createInstallerFixture()
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  let release
  try {
    fixture.setBridge(() => new Promise(resolve => { release = resolve }))
    const pending = handle.refresh()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(typeof release, 'function')
    handle.update({ ...fixture.options, state: activeState({ enabled: false }) })
    assert.equal(fixture.read(), true)
    release(activeState())
    await pending
    assert.equal(handle.enabled, false)
    assert.equal(fixture.read(), true)
  } finally { handle.dispose() }
})

test('unsupported bundle signatures leave all official family behavior unchanged', async () => {
  const fixture = createInstallerFixture()
  fixture.runtime.fetch = async () => ({ ok: true, text: async () => 'export{}' })
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(handle.ready, false)
    assert.equal(handle.reason, 'awaiting-usage-query')
    assert.equal(fixture.read(), true)
    assert.equal(fixture.bindings.hardBlocked[fixture.framework.member], fixture.originalMember)
    assert.equal(fixture.intervals.size, 2)
    assert.equal(handle.health.healthy, true)
    assert.equal(handle.health.needsReinstall, false)
    assert.equal(handle.health.reason, 'awaiting-usage-query')
  } finally { handle.dispose() }
})

test('an observed cache waiting for its first quota query reuses monitoring and activates when data arrives', async () => {
  const fixture = createInstallerFixture()
  fixture.runtime.fetch = async () => ({ ok: true, text: async () => 'export{}' })
  const queries = []; const listeners = new Set()
  const cache = { getAll: () => queries, subscribe(callback) {
    listeners.add(callback); return () => listeners.delete(callback)
  } }
  fixture.runtime.__REACT_QUERY_CLIENT__ = { getQueryCache: () => cache, setQueryData() {} }
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(handle.ready, false)
    assert.equal(handle.hasAdapter, false)
    assert.equal(handle.health.healthy, true)
    assert.equal(handle.health.monitoring, true)
    assert.equal(handle.health.reason, 'awaiting-usage-query')
    assert.equal(handle.usageCache.installed, true)
    assert.equal(handle.usageCache.supported, 0)
    const timers = [...fixture.intervals.keys()]
    assert.equal(await fixture.runtime.installCodexFuelRuntime(fixture.options), handle)
    assert.deepEqual([...fixture.intervals.keys()], timers)
    assert.equal(listeners.size, 1)
    const raw = { plan_type: 'plus', rate_limit: { allowed: false, limit_reached: true } }
    const query = { queryKey: ['rate-limit-status'], state: { data: raw }, setData(data) {
      this.state.data = data
      for (const callback of listeners) callback({ type: 'updated', query: this })
      return data
    } }
    queries.push(query)
    for (const callback of listeners) callback({ type: 'added', query })
    for (const entry of fixture.intervals.values()) if (entry.delay === 750) entry.callback()
    assert.equal(handle.ready, true)
    assert.equal(handle.health.reason, 'usage-cache-ready')
    assert.equal(query.state.data.rate_limit.allowed, true)
    assert.equal(fixture.intervals.size, 2)
    handle.dispose()
    assert.equal(query.state.data, raw)
    assert.equal(listeners.size, 0)
    assert.equal(handle.health.monitoring, false)
  } finally { handle.dispose() }
})

test('a changed composer consumer installs scoped force mode without granting an unverified route', async () => {
  const fixture = createInstallerFixture()
  fixture.runtime.fetch = async url => ({ ok: true,
    text: async () => url.includes('app-primary-') ? consumerSignature.replace('loading||quota', 'loading') : signature })
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(handle.ready, true)
    assert.equal(handle.hasAdapter, true)
    assert.equal(handle.adapterMode, 'scoped-force')
    assert.equal(fixture.read(), true)
    assert.notEqual(fixture.bindings.hardBlocked[fixture.framework.member], fixture.originalMember)
  } finally { handle.dispose() }
})

test('a missing or unavailable composer bundle keeps scoped force recovery available', async t => {
  for (const failure of ['missing-asset', 'http-error', 'fetch-rejected']) await t.test(failure, async () => {
    const fixture = createInstallerFixture()
    const originalAssetUrl = fixture.options.assetUrl
    const originalFetch = fixture.runtime.fetch
    fixture.options.assetUrl = prefix => failure === 'missing-asset' && prefix === 'app-primary-'
      ? '' : originalAssetUrl(prefix)
    fixture.runtime.fetch = async url => {
      if (!url.includes('app-primary-')) return originalFetch(url)
      if (failure === 'fetch-rejected') throw new Error('synthetic missing composer module')
      return { ok: false, status: 404, text: async () => '' }
    }
    const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    try {
      assert.equal(handle.ready, true)
      assert.equal(handle.hasAdapter, true)
      assert.equal(handle.adapterMode, 'scoped-force')
      assert.equal(fixture.read(), true, 'missing consumer source does not grant unknown routing')
      assert.equal(fixture.intervals.size, 2)
      const manager = { hostId: 'local', requestClient: { hostId: 'local' },
        getConversation: id => id === 'synthetic-thread' ? {
          hostId: fixture.route.host, modelProvider: fixture.route.provider, cwd: fixture.route.cwd,
        } : null }
      fixture.framework.get(fixture.bindings.config, { hostId: 'local', cwd: fixture.route.cwd })
      fixture.runtime.codexFuelFindContexts = inspect => {
        inspect?.({ memoizedProps: { value: { manager } } })
        return fixture.contexts
      }
      await handle.refresh()
      assert.equal(fixture.read(), false, 'later native context discovery recovers without reinjection')
      assert.equal(fixture.framework.get(fixture.accountSignal), fixture.identity)
      assert.equal(fixture.framework.get(fixture.quotaSignal), fixture.quota)
    } finally { handle.dispose() }
  })
})

test('scoped force installation discovers a native manager retained only by a React hook or ref', async t => {
  for (const storage of ['memo', 'ref']) await t.test(storage, async () => {
    const fixture = createInstallerFixture()
    const originalAssetUrl = fixture.options.assetUrl
    fixture.options.assetUrl = prefix => prefix === 'app-primary-' ? '' : originalAssetUrl(prefix)
    const manager = { hostId: 'local', requestClient: { hostId: 'local' },
      getConversation: id => id === 'synthetic-thread' ? {
        hostId: fixture.route.host, modelProvider: fixture.route.provider, cwd: fixture.route.cwd,
      } : null }
    fixture.framework.get(fixture.bindings.config, { hostId: 'local', cwd: fixture.route.cwd })
    fixture.runtime.codexFuelFindContexts = inspect => {
      inspect?.({ memoizedProps: {}, memoizedState: {
        memoizedState: storage === 'memo' ? [{ manager }] : { current: manager }, next: null,
      } })
      return fixture.contexts
    }
    const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    try {
      assert.equal(handle.ready, true)
      assert.equal(handle.adapterMode, 'scoped-force')
      assert.equal(fixture.read(), false, 'the first completed installation must find the mounted hook context')
      fixture.route.provider = 'openai'
      await handle.refresh()
      assert.equal(fixture.read(), true)
    } finally { handle.dispose() }
  })
})

test('installed runtime leaves native conversation requests and failures untouched', async t => {
  for (const adapterMode of ['native', 'scoped-force']) await t.test(adapterMode, async () => {
    const fixture = createInstallerFixture()
    if (adapterMode === 'scoped-force') {
      const assetUrl = fixture.options.assetUrl
      fixture.options.assetUrl = prefix => prefix === 'app-primary-' ? '' : assetUrl(prefix)
    }
    const calls = []
    let loaded = false
    const client = { hostId: 'local', sendRequest: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/resume') { loaded = true; return { thread: { id: params.threadId } } }
      if (!loaded) throw new Error(`thread not found: ${params.threadId}`)
      return { accepted: true }
    } }
    const original = client.sendRequest
    const manager = { hostId: 'local', requestClient: client, getConversation: () => ({
      hostId: 'local', modelProvider: 'custom', cwd: fixture.route.cwd,
    }) }
    fixture.runtime.codexFuelFindContexts = inspect => {
      inspect?.({ memoizedProps: { value: { manager } } })
      return fixture.contexts
    }
    const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    try {
      assert.equal(handle.conversationRecovery.installed, false)
      assert.equal(client.sendRequest, original)
      const params = { threadId: 'synthetic-thread', input: [{ type: 'text', text: 'unchanged draft' }] }
      await assert.rejects(client.sendRequest('turn/start', params), /thread not found/)
      assert.deepEqual(calls.map(c => c.method), ['turn/start'])
      assert.equal(calls[0].params, params)
      assert.equal(handle.diagnostics().conversationRecovery.recovered, 0)
      await client.sendRequest('thread/resume', { threadId: 'synthetic-thread' })
      assert.equal((await client.sendRequest('turn/start', params)).accepted, true)
      assert.deepEqual(calls.map(c => c.method), ['turn/start', 'thread/resume', 'turn/start'])
      assert.equal(calls[2].params, params)
      loaded = false
      fixture.route.config.model_providers.custom.base_url = 'https://different.example.invalid/v1'
      await assert.rejects(client.sendRequest('turn/start', params), /thread not found/)
      assert.equal(calls.length, 4, 'a different project endpoint must not trigger resume')
    } finally { handle.dispose() }
    assert.equal(client.sendRequest, original)
    assert.equal(fixture.intervals.size, 0)
  })
})

test('starting disabled then enabling installs the quota adapter', async () => {
  const fixture = createInstallerFixture()
  const handle = await fixture.runtime.installCodexFuelRuntime({ ...fixture.options, state: activeState({ enabled: false }) })
  try {
    assert.equal(fixture.read(), true)
    await fixture.runtime.installCodexFuelRuntime(fixture.options)
    assert.equal(fixture.read(), false)
  } finally { fixture.runtime.__gaogeCodexFuelRuntime?.dispose() }
})

test('failed bundle discovery can recover on reinjection once modules are ready', async () => {
  const fixture = createInstallerFixture()
  const failed = await fixture.runtime.installCodexFuelRuntime({ ...fixture.options, loadModule: async () => ({}) })
  try {
    assert.equal(failed.ready, false)
    assert.equal(fixture.read(), true)
    const recovered = await fixture.runtime.installCodexFuelRuntime(fixture.options)
    assert.equal(recovered.ready, true)
    assert.equal(fixture.read(), false)
    assert.equal(failed.disposed, true)
  } finally { fixture.runtime.__gaogeCodexFuelRuntime?.dispose() }
})

test('the production IIFE can evaluate the runtime repeatedly without lexical collisions', () => {
  const source = (usageSource + String.fromCharCode(10) + fs.readFileSync(runtimePath, 'utf8'))
  const context = vm.createContext({})
  const wrapped = `(() => { ${source}\n return typeof installCodexFuelRuntime; })()`
  assert.equal(vm.runInContext(wrapped, context), 'function')
  assert.equal(vm.runInContext(wrapped, context), 'function')
})

test('installed fuel preserves native speed controls and per-turn tiers despite legacy API preferences', async t => {
  const { chromium } = require('playwright')
  const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent('<form><button type="button" data-codex-intelligence-trigger="true" aria-expanded="true">Model</button></form>' +
    '<div id="native-menu" role="menu"><button data-native-service-tier="standard">Standard</button>' +
    '<button data-native-service-tier="fast">Fast</button></div>')
  await page.addScriptTag({ content: usageSource + String.fromCharCode(10) + fs.readFileSync(runtimePath, 'utf8') })
  await page.addScriptTag({ content: `window.createFramework = ${createFramework.toString()}` })
  await page.evaluate(async ({ signature, consumerSignature }) => {
    const f = createFramework()
    f.root.value = { kind: 'local', conversationId: 'thread' }
    window.nativeFixture = { state: { ok: true, enabled: true, mode: 'relay', provider: 'custom',
      baseUrl: 'https://relay.example.invalid/v1', apiSpeedEnabled: true, speedMode: 'fast' }, calls: [], bridgeCalls: [] }
    const fixture = window.nativeFixture
    const bindings = {
      hardBlocked: f.family(f.scope, () => true), reserveActive: f.family(f.scope, () => true),
      createDerived: f.derived, createSignal: f.signal,
      config: f.family(f.scope, () => ({ data: { model_provider: 'custom', model_providers: {
        custom: { name: 'Gaoge', base_url: fixture.state.baseUrl, wire_api: 'responses', requires_openai_auth: true },
      } } })),
      threadProvider: f.family(f.scope, () => 'custom'), threadHost: f.family(f.scope, () => 'local'),
      threadCwd: f.family(f.scope, () => 'D:/fixture'), cloudSelection: f.family(f.scope, () => false),
      selectedProject: f.family(f.scope, () => 'D:/fixture'),
    }
    fixture.client = { hostId: 'local', sendRequest(method, params, options) {
      fixture.calls.push({ method, params, options, self: this }); return 'native-result'
    } }
    fixture.nativeSend = fixture.client.sendRequest
    const manager = { hostId: 'local', requestClient: fixture.client, getConversation: () => ({
      hostId: 'local', modelProvider: 'custom', cwd: 'D:/fixture', latestModel: 'gpt-5.6-terra',
    }) }
    fixture.controller = { model: 'gpt-5.6-terra', open: true, selectedServiceTier: null,
      onSelectModel() {}, serviceTierOptions: [{ value: null, label: 'Standard' }],
      onSelectServiceTier(value) { this.selectedServiceTier = value },
      models: [{ model: 'gpt-5.6-terra', serviceTiers: [{ id: 'priority' }] }],
    }
    fixture.nativeSelect = fixture.controller.onSelectServiceTier
    const fiber = { memoizedProps: fixture.controller,
      dependencies: { firstContext: { memoizedValue: { chain: f.chain } } },
      return: { memoizedProps: { contentId: 'native-menu', children: [{ props: { manager } }] },
        dependencies: { firstContext: { memoizedValue: { authMethod: 'apikey' } } } },
    }
    document.querySelector('[data-codex-intelligence-trigger]').__reactFiber$fixture = fiber
    window.codexFuelFindContexts = inspect => { inspect?.(fiber); inspect?.(fiber.return); return [f.chain] }
    window.codexUsageFindComposers = () => ({ contexts: [f.chain], visibleEditors: 1, hiddenEditors: 0, unresolvedEditors: 0 })
    window.fetch = async url => ({ ok: true, text: async () => url.includes('app-primary-') ? consumerSignature : signature })
    for (const button of document.querySelectorAll('[data-native-service-tier]')) {
      button.onclick = () => fixture.controller.onSelectServiceTier(button.dataset.nativeServiceTier === 'fast' ? 'priority' : null)
    }
    fixture.nativeButtons = [...document.querySelectorAll('[data-native-service-tier]')]
    fixture.options = {
      state: fixture.state, assetUrl: prefix => `/fixture-${prefix}.js`,
      loadModule: async prefix => prefix === 'app-shared-' ? { sharedDerived: f.derived, sharedSignal: f.signal }
        : { UI: bindings.hardBlocked, HI: bindings.reserveActive, Pln: f.derived, Bln: f.signal,
          configExport: bindings.config, providerExport: bindings.threadProvider, cwdExport: bindings.threadCwd,
          hostExport: bindings.threadHost, cloudExport: bindings.cloudSelection, projectExport: bindings.selectedProject },
      bridge: async (path, body) => { fixture.bridgeCalls.push({ path, body }); return fixture.state },
    }
    fixture.handle = await installCodexFuelRuntime(fixture.options)
  }, { signature, consumerSignature })
  try {
    for (const mode of ['fast', 'standard']) {
      await page.evaluate(async mode => {
        const fixture = window.nativeFixture
        fixture.state = { ...fixture.state, speedMode: mode }
        fixture.options.state = fixture.state
        fixture.handle.update(fixture.options)
        await fixture.handle.refresh()
        fixture.controller.serviceTierOptionsLoading = true
        await fixture.handle.refresh()
        fixture.controller.serviceTierOptionsLoading = false
      }, mode)
      for (const selection of ['standard', 'fast']) {
        await page.locator(`[data-native-service-tier="${selection}"]`).click()
        const result = await page.evaluate(() => {
          const fixture = window.nativeFixture
          const params = { threadId: 'thread', input: [], serviceTier: fixture.controller.selectedServiceTier,
            serviceTierForTurn: fixture.controller.selectedServiceTier === 'priority' ? 'future-tier' : 'priority' }
          const options = { priority: 'interactive', requestId: 'native-options' }
          const result = fixture.client.sendRequest('turn/start', params, options)
          const last = fixture.calls.at(-1)
          return { result, sameParams: last.params === params, sameOptions: last.options === options,
            sameClient: last.self === fixture.client, sameSend: fixture.client.sendRequest === fixture.nativeSend,
            sameSelect: fixture.controller.onSelectServiceTier === fixture.nativeSelect,
            sameButtons: fixture.nativeButtons.every(button => button.isConnected),
            serviceTier: last.params.serviceTier, serviceTierForTurn: last.params.serviceTierForTurn,
            speedInstalled: fixture.handle.speedInstalled }
        })
        assert.deepEqual(result, { result: 'native-result', sameParams: true, sameOptions: true, sameClient: true,
          sameSend: true, sameSelect: true, sameButtons: true, speedInstalled: false,
          serviceTier: selection === 'fast' ? 'priority' : null,
          serviceTierForTurn: selection === 'fast' ? 'future-tier' : 'priority' })
        assert.equal(await page.locator('#gaoge-api-speed-row,[data-gaoge-api-speed]').count(), 0)
      }
    }
    assert.equal(await page.evaluate(() => window.nativeFixture.bridgeCalls.every(call => call.path === '/fuel/status')), true)
    assert.deepEqual(errors, [])
  } finally { await page.evaluate(() => window.nativeFixture.handle.dispose()) }
})

test('new local/worktree tasks use the matched native target and effective mode', async t => {
  for (const mode of ['local', 'worktree']) {
    await t.test(mode, () => {
      const fixture = createNewTaskFixture({ mode: { effectiveMode: mode } })
      try { fixture.handle.refresh(); assert.equal(fixture.read(), false) }
      finally { fixture.handle.dispose() }
    })
  }
  await t.test('undefined native selector arguments are omitted from the JSON family key', () => {
    const fixture = createNewTaskFixture({ targetParams: { selectedProject: undefined, homeRemoteProject: undefined, defaultCwd: undefined } })
    try { fixture.handle.refresh(); assert.equal(fixture.read(), false) }
    finally { fixture.handle.dispose() }
  })
})

test('new-task cloud/remote/unknown/ambiguous execution targets remain blocked', async t => {
  const cases = [
    ['cloud selection', { cloud: true }],
    ['unknown cloud selection', { cloud: 'unknown' }],
    ['remote project', { project: { type: 'remote', projectId: 'remote-project' } }],
    ['remote host target', { target: { target: { hostId: 'remote-server', cwd: '/project' } } }],
    ['remote execution host', { target: { executionRemoteHostId: 'remote-server' } }],
    ['project still loading', { target: { projectLoading: true } }],
    ['cloud effective mode', { mode: { effectiveMode: 'cloud' } }],
    ['unknown effective mode', { mode: { effectiveMode: 'unknown' } }],
    ['mismatched project key', { modeParams: { projectKey: 'other-project' } }],
    ['mismatched prefill key', { modeParams: { prefillKey: 'another-composer' } }],
    ['mismatched selected project', { project: { type: 'local', projectId: 'one' },
      targetParams: { selectedProject: { type: 'local', projectId: 'two' } } }],
    ['ambiguous cached targets', { duplicateTarget: true }],
    ['ambiguous cached modes', { duplicateMode: true }],
    ['missing target cwd', { target: { resolvedCwd: null, target: { hostId: 'local' } } }],
  ]
  for (const [label, options] of cases) {
    await t.test(label, () => {
      const fixture = createNewTaskFixture(options)
      try { fixture.handle.refresh(); assert.equal(fixture.read(), true) }
      finally { fixture.handle.dispose() }
    })
  }
})

async function withNativeBrowser(t, callback) {
  const { chromium } = require('playwright')
  const packaged = nativeAsarPath ? require('./codex-fuel-native-fixture.cjs').nativeFuelFixture(nativeAsarPath) : null
  const appName = packaged?.appName || path.basename(nativeFixturePath)
  const extractedRoot = nativeFixturePath ? path.join(path.dirname(nativeFixturePath), 'site', 'assets') : ''
  const root = packaged ? null : fs.existsSync(path.join(extractedRoot, appName)) ? extractedRoot : path.dirname(nativeFixturePath)
  const errors = []
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    if (pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<!doctype html><meta charset="utf-8"><title>Isolated quota regression fixture</title>' +
        '<style>body{font:16px system-ui;padding:24px;background:#102033;color:#e2e8f0}' +
        'section{margin:14px 0;padding:18px;border:1px solid #475569;border-radius:12px}' +
        'button{padding:10px 18px;margin-right:20px}button:enabled{background:#34d399;color:#102033}' +
        'button:disabled{opacity:.5}output{font:13px monospace}</style>' +
        '<h1>Isolated native quota fixture</h1><p>Synthetic account · official quota exhausted</p><div id="fixture"></div>')
      return
    }
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
    if (packaged) {
      const asset = relative.includes('/') || relative.includes('..') ? null : packaged.read(relative)
      response.writeHead(asset ? 200 : 404, { 'content-type': relative.endsWith('.js') ? 'text/javascript' : 'text/css' })
      response.end(asset || '')
      return
    }
    const file = path.resolve(root, relative)
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end(); return
    }
    response.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'text/css')
    fs.createReadStream(file).pipe(response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)) })
  browser = await chromium.launch({ channel: process.env.CODEX_FUEL_BROWSER_CHANNEL || 'msedge', headless: true })
  const page = await browser.newPage()
  await page.setViewportSize({ width: 1000, height: 650 })
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  await page.addScriptTag({ content: (usageSource + String.fromCharCode(10) + fs.readFileSync(runtimePath, 'utf8')) })
  if (packaged) {
    await callback(page, { appName, reactName: packaged.reactName, clientName: packaged.clientName, aliases: packaged.aliases, nativeUsageGate: packaged.nativeUsageGate })
    assert.deepEqual(errors, [], 'installed native framework must have no browser errors')
    return
  }
  const source = fs.readFileSync(path.join(root, appName), 'utf8')
  const reactName = source.match(/from"\.\/(react-[\w-]+\.js)"/)?.[1]
  const clientName = fs.readdirSync(root).find(name => /^client-[\w-]+\.js$/.test(name)
    && fs.readFileSync(path.join(root, name), 'utf8').includes('.createRoot='))
  assert.ok(reactName && clientName, 'the native fixture must include its React and DOM client dependency files')
  await callback(page, { appName, reactName, clientName })
  assert.deepEqual(errors, [], 'isolated native framework must have no browser errors')
}

test('installed native bundles satisfy both family and composer consumer signatures', {
  skip: nativeFixturePath ? false : 'Set CODEX_NATIVE_APP_INITIAL_FIXTURE to an extracted app-initial bundle with dependencies',
}, () => {
  const runtime = loadRuntime()
  const source = fs.readFileSync(nativeFixturePath, 'utf8')
  const namespace = Object.fromEntries([...source.slice(source.lastIndexOf('export{'))
    .matchAll(/(?:[,{])([\w$]+) as ([\w$]+)(?=[,}])/g)].map(match => [match[2], () => {}]))
  const extractedRoot = path.join(path.dirname(nativeFixturePath), 'site', 'assets')
  const root = fs.existsSync(path.join(extractedRoot, path.basename(nativeFixturePath)))
    ? extractedRoot : path.dirname(nativeFixturePath)
  const sharedName = source.match(/from"\.\/(app-shared-[\w-]+\.js)"/)?.[1]
  const dependencies = {}
  if (sharedName != null) {
    const sharedSource = fs.readFileSync(path.join(root, sharedName), 'utf8')
    dependencies['app-shared-'] = Object.fromEntries([...sharedSource.slice(sharedSource.lastIndexOf('export{'))
      .matchAll(/(?:[,{])([\w$]+) as ([\w$]+)(?=[,}])/g)].map(match => [match[2], () => {}]))
  }
  const bindings = runtime.discoverCodexFuelBindings(source, namespace, dependencies)
  const candidate = fs.readdirSync(root).filter(name => /^app-primary-[\w-]+\.js$/.test(name))
    .map(name => fs.readFileSync(path.join(root, name), 'utf8'))
    .find(text => text.includes(`from"./${path.basename(nativeFixturePath)}"`))
  assert.ok(candidate, 'the matching native app-primary consumer bundle is required')
  assert.doesNotThrow(() => runtime.verifyCodexFuelComposer(candidate, bindings.hardBlockedExport))
})

for (const nativeAdapterMode of ['native', 'fallback', 'startup']) test(`real Codex framework (${nativeAdapterMode}): mounted React hooks switch after eviction and restore on disable`, {
  skip: nativeFixturePath || nativeAsarPath ? false : 'Set CODEX_NATIVE_APP_ASAR or CODEX_NATIVE_APP_INITIAL_FIXTURE for native React validation',
}, async t => {
  await withNativeBrowser(t, async (page, files) => {
    await page.evaluate(async ({ appName, reactName, clientName, aliases, nativeAdapterMode }) => {
      const module = await import('/' + appName)
      if (aliases) { module.__fuel_uln(); module.__fuel_queryInit() }
      const native = aliases ? Object.fromEntries(Object.keys(aliases).map(alias => [alias, module['__fuel_' + alias]])) : module
      native.uln()
      const React = aliases ? native.react() : (await import('/' + reactName)).t()
      const client = aliases ? native.client() : (await import('/' + clientName)).t()
      const rootScope = native.lun('fuel-regression-root')
      const taskScope = native.lun('fuel-regression-task', { parent: rootScope })
      const identity = Object.freeze({ email: 'fixture@example.invalid', name: 'Personal account', plan: 'plus' })
      const quota = Object.freeze({ hardBlocked: true, active: false, primary: { usedPercent: 100 }, secondary: { usedPercent: 100 } })
      const quotaSignal = native.Bln(rootScope, quota)
      const identitySignal = native.Bln(rootScope, identity)
      const otherDisabled = native.Bln(rootScope, false)
      const uploading = native.Bln(rootScope, false)
      const composerText = native.Bln(rootScope, 'Synthetic draft')
      const hardBlocked = native.Aln(rootScope, (_host, { get }) => get(quotaSignal).hardBlocked)
      const reserveActive = native.Aln(rootScope, (_host, { get }) => get(quotaSignal).active)
      const routes = native.Bln(rootScope, {
        local: { host: 'local', provider: 'custom', cwd: 'D:/synthetic-project' },
        remote: { host: 'remote-server', provider: 'custom', cwd: '/synthetic-project' },
        official: { host: 'local', provider: 'openai', cwd: 'D:/synthetic-project' },
      })
      const state = { current: { ok: true, enabled: true, provider: 'custom', mode: 'relay', baseUrl: 'https://relay.example.invalid/v1' } }
      const configData = { model_provider: 'custom', model_providers: {
        custom: { name: 'Gaoge', base_url: 'https://relay.example.invalid/v1' },
      } }
      const configRequests = []
      const queryClient = aliases ? new native.queryClient({ defaultOptions: { queries: { retry: false } } }) : null
      const bindings = {
        hardBlocked, reserveActive, createDerived: native.Pln, createSignal: native.Bln, composerVerified: true,
        config: aliases ? native.queryFamily(rootScope, ({ hostId, cwd }) => ({
          queryKey: ['fuel-config', hostId, cwd], staleTime: Infinity,
          queryFn: async () => {
            configRequests.push({ hostId, cwd })
            await new Promise(resolve => setTimeout(resolve, 15))
            return configData
          },
        })) : native.Aln(rootScope, () => ({ data: configData })),
        threadHost: native.Aln(rootScope, (id, { get }) => get(routes)[id]?.host),
        threadProvider: native.Aln(rootScope, (id, { get }) => get(routes)[id]?.provider),
        threadCwd: native.Aln(rootScope, (id, { get }) => get(routes)[id]?.cwd),
        cloudSelection: native.Pln(taskScope, () => false),
        selectedProject: native.Pln(taskScope, () => null),
      }
      const contexts = new Map()
      if (nativeAdapterMode === 'fallback') {
        bindings.contextFallback = true
        bindings.fallbackManagers = new Set([{ hostId: 'local', requestClient: { hostId: 'local' },
          getConversation(id) {
            const route = contexts.get('local')?.get(routes)[id]
            return route ? { hostId: route.host, modelProvider: route.provider, cwd: route.cwd } : null
          } }])
      }
      let submitCount = 0
      function Composer({ id, kind = 'local' }) {
        const scope = native.fln(taskScope)
        contexts.set(id, scope)
        const blocked = native.hln(hardBlocked, 'local')
        const reserve = native.hln(reserveActive, 'local')
        const disabled = native._ln(otherDisabled)
        const isUploading = native._ln(uploading)
        const text = native._ln(composerText)
        const submitDisabled = blocked || disabled || isUploading || !text.trim()
        const submit = event => {
          event?.preventDefault()
          // The real composer captures this value in its send callback as
          // well as passing it to the button. A DOM-only unlock must fail.
          if (submitDisabled) return
          submitCount += 1
        }
        return React.createElement('form', { 'data-composer': id, onSubmit: submit },
          React.createElement('textarea', { 'data-editor': id, value: text, readOnly: true,
            onKeyDown: event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) submit(event)
            } }),
          React.createElement('button', { 'data-send': id, type: 'submit', disabled: submitDisabled }, 'Send ' + id),
          React.createElement('output', { 'data-quota': id }, JSON.stringify({ blocked, reserve, kind })))
      }
      const tree = React.createElement(native.vln, { scope: rootScope },
        ['local', 'remote', 'official', 'cloud'].map(id => React.createElement(native.vln, {
          key: id, scope: taskScope, value: { kind: id === 'cloud' ? 'cloud' : 'local', conversationId: id },
        }, React.createElement(Composer, { id, kind: id === 'cloud' ? 'cloud' : 'local' }))))
      const reactRoot = client.createRoot(document.getElementById('fixture'))
      const initialHandle = nativeAdapterMode === 'startup'
        ? createCodexFuelFamilyPatch({ bindings, getState: () => state.current }) : null
      reactRoot.render(aliases ? React.createElement(native.queryProvider, { queryClient }, tree) : tree)
      window.fuelFixture = { bindings, state, contexts, quota, identity, quotaSignal, identitySignal,
        otherDisabled, uploading, composerText, routes, reactRoot, rootScope, queryClient, configRequests,
        handle: initialHandle, get submitCount() { return submitCount }, native }
    }, { ...files, nativeAdapterMode })
    await page.waitForSelector('[data-send="local"]')
    if (nativeAdapterMode !== 'startup') assert.equal(await page.locator('[data-send="local"]').isDisabled(), true)
    assert.equal(await page.evaluate(() => window.fuelFixture.configRequests.length), 0,
      'no native configuration query may be preseeded before the adapter is installed')
    const screenshotDirectory = process.env.CODEX_FUEL_SCREENSHOT_DIR
    if (screenshotDirectory) {
      fs.mkdirSync(path.resolve(screenshotDirectory), { recursive: true })
      await page.screenshot({ path: path.resolve(screenshotDirectory, 'native-quota-before.png'), fullPage: true })
    }
    await page.evaluate(() => {
      const f = window.fuelFixture
      // Use the production React-fiber scope discovery. Supplying captured
      // contexts here would miss regressions in locating already-open editors.
      f.handle ||= createCodexFuelFamilyPatch({ bindings: f.bindings, getState: () => f.state.current })
      f.handle.refresh()
    })
    try {
      await page.waitForFunction(() => !document.querySelector('[data-send="local"]').disabled, null, { timeout: 5000 })
    } catch (error) {
      const detail = await page.evaluate(() => {
        const f = window.fuelFixture, scope = f.contexts.get('local')
        const config = scope.get(f.bindings.config, { hostId: 'local', cwd: 'D:/synthetic-project' })
        return { imperative: scope.get(f.bindings.hardBlocked, 'local'), value: scope.value,
          context: codexFuelContextUsesRelay(scope.get, scope, f.bindings, f.state.current),
          config: { keys: Object.keys(config || {}), data: config?.data, status: config?.status,
            isPending: config?.isPending, isLoading: config?.isLoading, isError: config?.isError },
          scopeBound: f.handle.scopeBound, configRequests: f.configRequests, routeError: f.handle.routeError,
          configRequestCount: f.handle.configRequestCount,
          queries: f.queryClient?.getQueryCache().getAll().map(q => ({ key: q.queryKey,
            status: q.state.status, fetchStatus: q.state.fetchStatus, observers: q.getObserversCount(), error: String(q.state.error || '') })),
          chains: [...scope.chain.values()].map(node => ({ value: node.value, kind: node.token.__scopeBrand })),
          dom: document.getElementById('fixture').innerHTML }
      })
      throw new Error(`${error.message}\nNative fixture diagnostics: ${JSON.stringify(detail)}`)
    }
    for (const id of ['remote', 'official', 'cloud']) {
      assert.equal(await page.locator(`[data-send="${id}"]`).isDisabled(), true, `${id} remains quota blocked`)
      await page.locator(`[data-editor="${id}"]`).press('Enter')
      await page.locator(`[data-composer="${id}"]`).dispatchEvent('submit')
    }
    assert.equal(await page.evaluate(() => window.fuelFixture.handle.scopeBound), true)
    if (files.aliases) assert.deepEqual(await page.evaluate(() => window.fuelFixture.configRequests), [
      { hostId: 'local', cwd: 'D:/synthetic-project' },
    ], 'the adapter must mount and complete the real native query for this exact local directory')
    assert.equal(await page.evaluate(() => window.fuelFixture.submitCount), 0)
    if (screenshotDirectory) {
      await page.screenshot({ path: path.resolve(screenshotDirectory, 'native-quota-after.png'), fullPage: true })
    }
    await page.locator('[data-send="local"]').click()
    assert.equal(await page.evaluate(() => window.fuelFixture.submitCount), 1)
    await page.evaluate(() => {
      window.fuelFixture.handle.refresh()
      window.fuelFixture.handle.refresh()
    })
    await page.locator('[data-editor="local"]').press('Enter')
    assert.equal(await page.evaluate(() => window.fuelFixture.submitCount), 2,
      'Enter follows the refreshed callback once, including after repeated refreshes')
    assert.deepEqual(await page.evaluate(() => {
      const f = window.fuelFixture, scope = f.contexts.get('local')
      return { sameQuota: scope.get(f.quotaSignal) === f.quota,
        sameIdentity: scope.get(f.identitySignal) === f.identity, quota: scope.get(f.quotaSignal) }
    }), { sameQuota: true, sameIdentity: true, quota: {
      hardBlocked: true, active: false, primary: { usedPercent: 100 }, secondary: { usedPercent: 100 },
    } })
    for (const [signal, blockedValue, restoredValue] of [
      ['otherDisabled', true, false], ['uploading', true, false], ['composerText', '', 'Synthetic draft'],
    ]) {
      await page.evaluate(({ signal, value }) => {
        const f = window.fuelFixture
        f.contexts.get('local').set(f[signal], value)
      }, { signal, value: blockedValue })
      await page.waitForFunction(() => document.querySelector('[data-send="local"]').disabled)
      await page.locator('[data-editor="local"]').press('Enter')
      await page.locator('[data-composer="local"]').dispatchEvent('submit')
      assert.equal(await page.evaluate(() => window.fuelFixture.submitCount), 2,
        `${signal} still blocks both keyboard and direct submit callbacks`)
      await page.evaluate(({ signal, value }) => {
        const f = window.fuelFixture
        f.contexts.get('local').set(f[signal], value)
      }, { signal, value: restoredValue })
      await page.waitForFunction(() => !document.querySelector('[data-send="local"]').disabled)
    }
    await page.evaluate(() => {
      const f = window.fuelFixture
      f.state.current.enabled = false
      f.handle.refresh()
    })
    await page.waitForFunction(() => document.querySelector('[data-send="local"]').disabled)
    await page.evaluate(() => {
      const f = window.fuelFixture
      f.state.current.enabled = true
      f.handle.refresh()
    })
    await page.waitForFunction(() => !document.querySelector('[data-send="local"]').disabled)
    await page.evaluate(() => {
      const f = window.fuelFixture
      f.contexts.get('local').set(f.routes, routes => ({ ...routes, local: { ...routes.local, provider: 'openai' } }))
      f.handle.refresh()
    })
    await page.waitForFunction(() => document.querySelector('[data-send="local"]').disabled)
    await page.evaluate(() => {
      const f = window.fuelFixture
      f.contexts.get('local').set(f.routes, routes => ({ ...routes, local: { ...routes.local, provider: 'custom' } }))
      f.handle.refresh()
    })
    await page.waitForFunction(() => !document.querySelector('[data-send="local"]').disabled)
    await page.evaluate(() => {
      const f = window.fuelFixture
      f.bindings.contextFallback = true
      f.bindings.fallbackManagers = new Set([{ hostId: 'local', requestClient: { hostId: 'local' },
        getConversation(id) {
          const route = f.contexts.get('local').get(f.routes)[id]
          return route ? { hostId: route.host, modelProvider: route.provider, cwd: route.cwd } : null
        } }])
      f.handle.refresh()
    })
    await page.waitForFunction(() => !document.querySelector('[data-send="local"]').disabled)
    await page.locator('[data-editor="local"]').press('Enter')
    assert.equal(await page.evaluate(() => window.fuelFixture.submitCount), 3,
      'scoped force fallback refreshes the native callback closure, not only the DOM button')
    for (const id of ['remote', 'official', 'cloud']) {
      assert.equal(await page.locator(`[data-send="${id}"]`).isDisabled(), true)
    }
    await page.evaluate(() => window.fuelFixture.handle.dispose())
    await page.waitForFunction(() => document.querySelector('[data-send="local"]').disabled)
    assert.equal(await page.evaluate(() => {
      const f = window.fuelFixture
      return f.bindings.hardBlocked.scope === f.rootScope && f.bindings.reserveActive.scope === f.rootScope
    }), true, 'disposal restores native family scopes')
    await page.evaluate(() => {
      const f = window.fuelFixture
      f.handle = createCodexFuelFamilyPatch({ bindings: f.bindings, getState: () => f.state.current })
    })
    await page.waitForFunction(() => !document.querySelector('[data-send="local"]').disabled)
    await page.locator('[data-send="local"]').click()
    assert.equal(await page.evaluate(() => window.fuelFixture.submitCount), 4,
      'reinstallation must restore the actual submit callback exactly once')
    await page.evaluate(() => window.fuelFixture.handle.dispose())
    await page.evaluate(() => window.fuelFixture.reactRoot.unmount())
  })
})

function rootQuotaFixture(fixture) {
  const listeners = new Set()
  const raw = { account_id: 'synthetic', rate_limit: { allowed: false, limit_reached: true, used_percent: 100 } }
  const query = { queryKey: ['rate-limit-status'], state: { data: raw },
    setData(data) { this.state.data = data; for (const callback of listeners) callback({ type: 'updated', query: this }); return data } }
  const cache = { getAll: () => [query], find: () => query, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
  const client = { getQueryCache: () => cache, setQueryData(_key, updater) { return query.setData(typeof updater === 'function' ? updater(query.state.data) : updater) } }
  const provider = { memoizedProps: { client } }
  const root = { '__reactContainer$fixture': { stateNode: { current: { child: provider } } } }
  fixture.runtime.document.getElementById = id => id === 'root' ? root : null
  fixture.options.forceRelayGlobal = true
  return { query, raw, listeners, client, provider }
}

test('a broken legacy context scan cannot prevent root-cache unlocking or restoration', async () => {
  const fixture = createInstallerFixture()
  const quota = rootQuotaFixture(fixture)
  fixture.runtime.codexFuelFindContexts = () => { throw new Error('changed legacy fiber shape') }
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(quota.query.state.data.rate_limit.allowed, true)
    assert.equal(handle.adapterMode, 'usage-cache')
    assert.equal(handle.ready, true)
    assert.equal(handle.health.healthy, true)
    handle.update({ ...fixture.options, state: activeState({ enabled: false }) })
    assert.equal(quota.query.state.data, quota.raw)
    assert.equal(handle.usageCache.enabled, false)
  } finally { handle.dispose() }
})

for (const stalled of ['module', 'fetch', 'body']) {
  test(`root quota cache unlocks while native ${stalled} stalls and native discovery later recovers`, async () => {
    const fixture = createInstallerFixture()
    const quota = rootQuotaFixture(fixture)
    const load = fixture.options.loadModule
    const fetch = fixture.runtime.fetch
    const hung = () => new Promise(() => {})
    if (stalled === 'module') fixture.options.loadModule = hung
    if (stalled === 'fetch') fixture.runtime.fetch = hung
    if (stalled === 'body') fixture.runtime.fetch = async () => ({ ok: true, text: hung })
    fixture.runtime.CODEX_FUEL_NATIVE_LOAD_TIMEOUT_MS = 20
    const installation = fixture.runtime.installCodexFuelRuntime(fixture.options)
    const handle = fixture.runtime.__gaogeCodexFuelRuntime
    try {
      assert.equal(quota.query.state.data.rate_limit.allowed, true, 'cache unlocking must precede native discovery')
      assert.equal(handle.health.monitoring, true, 'polling starts even while the native dependency is pending')
      assert.equal(handle.adapterMode, 'usage-cache')
      await installation
      assert.match(handle.discoveryError, /timed out/)
      assert.equal(handle.ready, true)
      assert.equal(handle.usageCache.unlocked, 1)
      assert.equal(handle.health.needsReinstall, false)
      fixture.options.loadModule = load
      fixture.runtime.fetch = fetch
      fixture.advance(fixture.runtime.CODEX_FUEL_NATIVE_RETRY_MS)
      const render = [...fixture.intervals.values()].find(timer => timer.delay === 750).callback
      render(); render()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(handle.health.nativeHealthy, true, 'optional native adaptation retries in the same runtime')
      assert.equal(fixture.read(), false)
      assert.equal(quota.listeners.size, 1)
      assert.equal(fixture.intervals.size, 2)
    } finally {
      handle.dispose()
      assert.equal(quota.query.state.data, quota.raw)
      assert.equal(quota.listeners.size, 0)
      assert.equal(fixture.intervals.size, 0)
    }
  })
}

test('a disposed pending discovery cannot overwrite the replacement runtime or reinstall hooks', async () => {
  const fixture = createInstallerFixture()
  const quota = rootQuotaFixture(fixture)
  let release
  const pending = fixture.runtime.installCodexFuelRuntime({ ...fixture.options,
    loadModule: () => new Promise(resolve => { release = resolve }) })
  const previous = fixture.runtime.__gaogeCodexFuelRuntime
  previous.dispose()
  const current = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    const member = fixture.bindings.hardBlocked[fixture.framework.member]
    release(moduleFor(fixture.bindings))
    await pending
    assert.equal(fixture.runtime.__gaogeCodexFuelRuntime, current)
    assert.equal(previous.disposed, true)
    assert.equal(previous.hasAdapter, false)
    assert.equal(current.health.nativeHealthy, true)
    assert.equal(fixture.bindings.hardBlocked[fixture.framework.member], member)
    assert.equal(fixture.intervals.size, 2)
    assert.equal(quota.listeners.size, 1)
  } finally { current.dispose() }
})

test('usage cache independently adapts an unknown bundle and restores on route disable or expiry', async () => {
  const fixture = createInstallerFixture()
  const listeners = new Set()
  const raw = { account_id: 'synthetic', rate_limit: { allowed: false, limit_reached: true, used_percent: 100 } }
  const query = { queryKey: ['rate-limit-status'], state: { data: raw },
    setData(data) { this.state.data = data; for (const callback of listeners) callback({ type: 'updated', query: this }); return data } }
  const cache = { getAll: () => [query], find: () => query, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
  const client = { getQueryCache: () => cache, setQueryData(_key, updater) { return query.setData(typeof updater === 'function' ? updater(query.state.data) : updater) } }
  fixture.runtime.__codexQueryClient = client
  fixture.runtime.fetch = async () => ({ ok: true, text: async () => 'export{}' })
  const original = query.setData
  const handle = await fixture.runtime.installCodexFuelRuntime(fixture.options)
  try {
    assert.equal(handle.ready, true)
    assert.equal(handle.adapterMode, 'usage-cache')
    assert.equal(handle.usageCache.unlocked, 1)
    assert.equal(query.state.data.rate_limit.allowed, true)
    assert.equal(query.state.data.rate_limit.used_percent, 100)
    handle.update({ ...fixture.options, state: activeState({ enabled: false }) })
    assert.equal(query.state.data, raw)
    handle.update(fixture.options)
    assert.equal(query.state.data.rate_limit.allowed, true)
    fixture.advance(6001)
    for (const timer of fixture.intervals.values()) if (timer.delay === 750) timer.callback()
    assert.equal(query.state.data.rate_limit.allowed, true, 'the ordinary gate survives a short helper outage')
    fixture.advance(fixture.runtime.CODEX_FUEL_STATUS_GRACE_MS - 6000)
    for (const timer of fixture.intervals.values()) if (timer.delay === 750) timer.callback()
    assert.equal(query.state.data, raw)
    assert.equal(handle.diagnostics().usageCache.enabled, false)
  } finally {
    handle.dispose()
    assert.equal(query.setData, original)
    assert.equal(query.state.data, raw)
    assert.equal(listeners.size, 0)
    assert.equal(fixture.intervals.size, 0)
  }
})

test('installed native QueryClient supports cache unlocking before subscribers and complete restoration', {
  skip: nativeAsarPath ? false : 'Set CODEX_NATIVE_APP_ASAR for real query cache validation',
}, async t => {
  await withNativeBrowser(t, async (page, { appName }) => {
    const result = await page.evaluate(async appName => {
      const native = await import('/' + appName)
      native.__fuel_uln(); native.__fuel_queryInit()
      const client = new native.__fuel_queryClient({ defaultOptions: { queries: { retry: false } } })
      const key = ['rate-limit-status', 'synthetic-user', 'synthetic-account']
      const imageKey = ['rate-limit-status', 'image-generation', 'synthetic-image']
      const makeRaw = () => ({ plan_type: 'plus', account_id: 'synthetic-account',
        rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } } })
      client.setQueryData(key, makeRaw()); client.setQueryData(imageKey, makeRaw())
      const button = document.createElement('button'); button.textContent = 'Synthetic send'; document.body.append(button)
      let enabled = true; let uploading = false; let text = 'Synthetic draft'
      const render = () => { button.disabled = !client.getQueryData(key)?.rate_limit.allowed || uploading || !text }
      render(); const before = button.disabled
      const seen = []
      const unsubscribe = client.getQueryCache().subscribe(({ query, type }) => {
        if (query.queryKey[0] === key[0] && query.queryKey[1] === key[1] && type === 'updated') {
          seen.push(query.state.data?.rate_limit.allowed); render()
        }
      })
      const adapter = createCodexUsageCacheAdapter({ getPolicy: () => ({ enabled }) })
      adapter.attach(client); const unlocked = !button.disabled
      seen.length = 0
      await client.fetchQuery({ queryKey: key, queryFn: async () => makeRaw(), staleTime: 0 })
      client.getQueryCache().find({ queryKey: key, exact: true }).setData(makeRaw())
      const publicationsAllowed = seen.length > 0 && seen.every(value => value === true)
      uploading = true; render(); const uploadBlocked = button.disabled
      uploading = false; text = ''; render(); const emptyBlocked = button.disabled
      text = 'Synthetic draft'; render()
      const usagePercent = client.getQueryData(key).rate_limit.primary_window.used_percent
      const imageBlocked = !client.getQueryData(imageKey).rate_limit.allowed
      enabled = false; adapter.refresh(); const restored = !client.getQueryData(key).rate_limit.allowed && button.disabled
      adapter.dispose(); unsubscribe(); client.clear()
      return { before, unlocked, publicationsAllowed, uploadBlocked, emptyBlocked, usagePercent, imageBlocked, restored }
    }, appName)
    assert.deepEqual(result, { before: true, unlocked: true, publicationsAllowed: true, uploadBlocked: true,
      emptyBlocked: true, usagePercent: 100, imageBlocked: true, restored: true })
  })
})


test('native React root discovery unlocks the ordinary quota gate and restores on navigation', {
  skip: nativeAsarPath ? false : 'Set CODEX_NATIVE_APP_ASAR for installed ordinary quota gate validation',
}, async t => {
  await withNativeBrowser(t, async (page, { appName, nativeUsageGate }) => {
    await page.evaluate(async ({ appName, gate }) => {
      const native = await import('/' + appName)
      native.__fuel_uln(); native.__fuel_queryInit()
      const React = native.__fuel_react(); const dom = native.__fuel_client()
      const rootScope = native.__fuel_lun('usage-visible-root')
      const composerScope = native.__fuel_lun('usage-visible-composer', { parent: rootScope })
      const client = new native.__fuel_queryClient({ defaultOptions: { queries: { retry: false } } })
      const key = ['rate-limit-status', 'fixture-user', 'fixture-account']
      const raw = () => ({ plan_type: 'plus', user_id: 'fixture-user', account_id: 'fixture-account',
        credits: { has_credits: false, unlimited: false, balance: '0' },
        rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } } })
      client.setQueryData(key, raw())
      const auth = { authMethod: 'chatgpt', authLoading: false, accountLoading: false,
        accountId: 'fixture-account', authenticatedAccountId: 'fixture-account', userId: 'fixture-user', plan: 'plus' }
      // Execute the installed ordinary gate verbatim. Its external signals and
      // helpers describe this synthetic plus account: no reserve, no credits,
      // no dismissed quota windows, no workspace override.
      const values = new Map(gate.external.map(name => [name, gate.helpers.includes(name) ? (() => false) : { name }]))
      const windowHelper = gate.source.match(/([\w$]+)\([^)]*\)\.filter\(/)[1]
      values.set(windowHelper, () => [])
      const evaluateOrdinary = new Function(...gate.external, 'return (' + gate.source + ')')(...values.values())
      const ordinaryBlocked = () => evaluateOrdinary({ get(signal) {
        if (signal === values.get(gate.keys.auth)) return auth
        if (signal === values.get(gate.keys.usage)) return { data: client.getQueryData(key) }
        return null
      } })
      const state = { enabled: true, provider: 'custom', mode: 'relay', baseUrl: 'https://relay.example.invalid/v1' }
      const configData = { model_provider: 'custom', model_providers: { custom: { name: 'Gaoge', base_url: state.baseUrl } } }
      const configSignal = native.__fuel_Bln(rootScope, { data: configData })
      const bindings = { config: native.__fuel_Aln(rootScope, () => ({ data: configData })) }
      // Use a signal behind the family so a changed route is observed in the
      // real native store on the next render as well as in the policy.
      bindings.config = native.__fuel_Aln(rootScope, (_key, { get }) => get(configSignal))
      let localStore; let active = 'local'; let upload = false; let draft = 'test'; let submits = 0
      function Composer({ id }) {
        const scope = native.__fuel_fln(composerScope)
        if (id === 'local') localStore = scope
        const quota = React.useSyncExternalStore(
          callback => client.getQueryCache().subscribe(event => { if (event.query?.queryKey[0] === key[0]) callback() }),
          ordinaryBlocked,
        )
        const disabled = quota || upload || !draft
        const submit = e => { e.preventDefault(); if (!disabled) submits += 1 }
        return React.createElement('form', { onSubmit: submit },
          React.createElement('textarea', { 'data-usage-editor': id, value: draft, readOnly: true }),
          React.createElement('button', { 'data-usage-send': id, type: 'submit', disabled }, id))
      }
      const container = document.getElementById('fixture')
      container.id = 'root'
      const root = dom.createRoot(container)
      function render() {
        const scopes = [['home', 'new'], ['local', 'local'], ['cloud', 'cloud']]
        const children = scopes.map(([id, kind]) => React.createElement('section', { key: id,
          style: { display: id === active ? 'block' : 'none' } }, React.createElement(native.__fuel_vln,
          { scope: composerScope, value: { kind, conversationId: id, hostId: 'local', cwd: 'D:/fixture' } },
          React.createElement(Composer, { id }))))
        root.render(React.createElement(native.__fuel_queryProvider, { queryClient: client },
          React.createElement(native.__fuel_vln, { scope: rootScope }, children)))
      }
      render()
      window.usageTest = {
        install() {
          this.before = ordinaryBlocked()
          this.adapter = createCodexUsageCacheAdapter({ getPolicy: () => codexUsageVisiblePolicy(bindings, state, []) })
          const clients = codexUsageFindClients(document)
          this.rootClientFound = clients.has(client)
          for (const candidate of clients) this.adapter.attach(candidate)
        },
        status() { return { ...this.adapter.status, ordinaryBlocked: ordinaryBlocked(), submits, rootClientFound: this.rootClientFound,
          usedPercent: client.getQueryData(key).rate_limit.primary_window.used_percent } },
        refresh() { this.adapter.refresh() },
        publish() { client.setQueryData(key, raw()) },
        rerender() { render() },
        navigate(value) { active = value; render() },
        upload(value) { upload = value; render() },
        draft(value) { draft = value; render() },
        official(value) {
          localStore.set(configSignal, { data: value ? { model_provider: 'openai' } : configData }); render()
        },
        disable() { state.enabled = false; this.adapter.refresh() },
        dispose() { this.adapter.dispose(); root.unmount(); client.clear() },
      }
    }, { appName, gate: nativeUsageGate })
    await page.waitForFunction(() => document.querySelector('[data-usage-editor="local"]'))
    assert.equal(await page.locator('[data-usage-send="local"]').isDisabled(), true)
    await page.evaluate(() => usageTest.install())
    await page.waitForFunction(() => !document.querySelector('[data-usage-send="local"]').disabled)
    let status = await page.evaluate(() => usageTest.status())
    assert.equal(status.rootClientFound, true, 'the real React container exposes the native QueryClient without composer discovery')
    assert.equal(status.reason, 'workspace-relay-confirmed')
    assert.equal(status.hiddenEditors, 2); assert.equal(status.visibleComposers, 1)
    assert.equal(status.ordinaryBlocked, false); assert.equal(status.unlocked, 1)
    assert.equal(status.usedPercent, 100)
    await page.locator('[data-usage-send="local"]').click()
    assert.equal((await page.evaluate(() => usageTest.status())).submits, 1)
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { usageTest.rerender(); usageTest.publish() })
      await page.waitForTimeout(40)
      await page.evaluate(() => usageTest.refresh())
      assert.equal((await page.evaluate(() => usageTest.status())).enabled, true)
    }
    await page.evaluate(() => usageTest.upload(true))
    await page.waitForFunction(() => document.querySelector('[data-usage-send="local"]').disabled)
    await page.evaluate(() => { usageTest.upload(false); usageTest.draft('') })
    await page.waitForTimeout(40)
    assert.equal(await page.locator('[data-usage-send="local"]').isDisabled(), true)
    await page.evaluate(() => { usageTest.draft('test'); usageTest.navigate('cloud') })
    await page.waitForFunction(() => document.querySelector('[data-usage-editor="cloud"]').getClientRects().length > 0)
    await page.evaluate(() => usageTest.refresh())
    status = await page.evaluate(() => usageTest.status())
    assert.equal(status.reason, 'nonlocal-composer'); assert.equal(status.ordinaryBlocked, true)
    await page.evaluate(() => usageTest.navigate('local'))
    await page.waitForFunction(() => document.querySelector('[data-usage-editor="local"]').getClientRects().length > 0)
    await page.evaluate(() => usageTest.refresh())
    await page.waitForFunction(() => !document.querySelector('[data-usage-send="local"]').disabled)
    await page.evaluate(() => { usageTest.official(true); usageTest.refresh() })
    assert.equal((await page.evaluate(() => usageTest.status())).reason, 'workspace-not-relay')
    await page.evaluate(() => { usageTest.official(false); usageTest.refresh(); usageTest.disable() })
    status = await page.evaluate(() => usageTest.status())
    assert.equal(status.ordinaryBlocked, true); assert.equal(status.unlocked, 0)
    await page.evaluate(() => usageTest.dispose())
  })
})


test('installed v14 observes visibility changes and disconnects its observer on disposal', async () => {
  const f = createInstallerFixture(); const observers = [];
  f.runtime.document.body = {};
  f.runtime.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
    observe(root, options) { this.root = root; this.options = options }
    disconnect() { this.disconnected = true }
  };
  let visible = true;
  f.runtime.codexUsageFindComposers = () => ({ contexts: visible ? f.contexts : [],
    visibleEditors: visible ? 1 : 0, hiddenEditors: visible ? 0 : 1, unresolvedEditors: 0 });
  const raw = { plan_type: 'plus', rate_limit: { allowed: false, limit_reached: true } };
  const query = { queryKey: ['rate-limit-status'], state: { data: raw }, setData(value) { this.state.data = value; return value } };
  const cache = { getAll: () => [query], subscribe: () => () => {} };
  f.runtime.__codexQueryClient = { getQueryCache: () => cache, setQueryData: (_key, value) => query.setData(value) };
  const handle = await f.runtime.installCodexFuelRuntime(f.options);
  try {
    assert.equal(query.state.data.rate_limit.allowed, true);
    assert.equal(observers.length, 1);
    assert.equal(observers[0].options.subtree, true);
    assert.ok(observers[0].options.attributeFilter.includes('aria-hidden'));
    visible = false; observers[0].callback();
    assert.equal(query.state.data, raw);
    visible = true; observers[0].callback();
    assert.equal(query.state.data.rate_limit.allowed, true);
    const reinstalled = await f.runtime.installCodexFuelRuntime(f.options);
    assert.equal(reinstalled, handle); assert.equal(observers.length, 1);
  } finally { handle.dispose() }
  assert.equal(observers[0].disconnected, true);
  assert.equal(query.state.data, raw);
  observers[0].callback(); assert.equal(query.state.data, raw);
});
