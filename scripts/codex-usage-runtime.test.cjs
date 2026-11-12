const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

function runtime() {
  const box = { Map, Set, WeakMap, WeakSet, console, URL, Promise }
  vm.createContext(box)
  for (const file of ['codex_usage_runtime.js', 'codex_fuel_runtime.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src-tauri/src', file), 'utf8'), box)
  }
  return box
}
const usage = (allowed = false) => ({
  account_id: 'synthetic-account', plan_type: 'plus',
  rate_limit: { allowed, limit_reached: !allowed, primary_window: { used_percent: 100, reset_at: 1000 } },
  credits: { balance: 'unchanged' }, rate_limit_warning: { title: 'original-warning' },
})

function fixture({ copying = false } = {}) {
  const box = runtime()
  const listeners = new Set()
  const queries = []
  let enabled = true
  let recoverHome = false
  let clock = 0
  const calls = []
  const cache = {
    getAll: () => queries,
    find: ({ queryKey }) => queries.find(q => JSON.stringify(q.queryKey) === JSON.stringify(queryKey)),
    subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback) },
  }
  function notify(event) { for (const listener of [...listeners]) listener(event) }
  function add(key, data, state = {}) {
    const query = {
      queryKey: key, state: { data, status: data == null ? 'pending' : 'success', fetchStatus: 'idle', dataUpdatedAt: 99, ...state },
      isActive: () => true, getObserversCount: () => 1,
      setData(value, options) {
        const stored = copying && value ? { ...value, rate_limit: value.rate_limit && { ...value.rate_limit } } : value
        this.state.data = stored
        this.state.status = 'success'
        if (options?.updatedAt != null) this.state.dataUpdatedAt = options.updatedAt
        notify({ type: 'updated', query: this })
        return stored
      },
    }
    queries.push(query)
    notify({ type: 'added', query })
    return query
  }
  const client = {
    getQueryCache: () => cache,
    setQueryData(key, updater, options) {
      let query = cache.find({ queryKey: key })
      const value = typeof updater === 'function' ? updater(query?.state.data) : updater
      if (value === undefined) return undefined
      if (!query) query = add(key)
      return query.setData(value, options)
    },
    cancelQueries: async filter => { calls.push(['cancel', filter.queryKey]) },
    refetchQueries: async filter => { calls.push(['refetch', filter.queryKey]) },
  }
  const raw = usage()
  const main = add(['rate-limit-status'], raw)
  const image = add(['rate-limit-status', 'image-generation', 'image'], usage())
  const adapter = box.createCodexUsageCacheAdapter({ getPolicy: () => ({ enabled, recoverHome, reason: enabled ? 'relay-confirmed' : 'relay-off' }), now: () => clock })
  return { box, client, cache, add, main, image, raw, adapter, calls, notify,
    enable(value) { enabled = value }, allowRecovery(value) { recoverHome = value },
    advance(ms) { clock += ms }, listenerCount: () => listeners.size,
  }
}

test('only known account usage query keys qualify; image and remote keys do not', () => {
  const r = runtime()
  for (const key of [['rate-limit-status'], ['rate-limit-status', 'user', 'account']]) assert.equal(r.codexUsageMainQuery(key), true)
  for (const key of [null, [], ['rate-limit-status', 'remote'], ['rate-limit-status', 'image-generation', 'x'], ['rate-limit-status', {hostId:'remote'}, 'x'], ['other']]) assert.equal(r.codexUsageMainQuery(key), false)
})

test('already cached exhausted usage unlocks without changing real usage, identity or timestamps', () => {
  const f = fixture(); f.adapter.attach(f.client)
  assert.equal(f.main.state.data.rate_limit.allowed, true)
  assert.equal(f.main.state.data.rate_limit.limit_reached, false)
  assert.equal(f.main.state.data.rate_limit.primary_window.used_percent, 100)
  assert.equal(f.main.state.data.credits, f.raw.credits)
  assert.equal(f.main.state.data.account_id, f.raw.account_id)
  assert.equal(f.raw.rate_limit.allowed, false)
  assert.equal(f.image.state.data.rate_limit.allowed, false)
  assert.equal(f.main.state.dataUpdatedAt, 99)
  assert.equal(f.adapter.status.unlocked, 1)
  f.enable(false); f.adapter.refresh()
  assert.equal(f.main.state.data, f.raw)
  assert.equal(f.adapter.status.unlocked, 0)
  f.adapter.dispose()
})

test('polling and SSE publications unlock before native subscribers are notified', () => {
  const f = fixture(); const seen = []
  f.cache.subscribe(({ query }) => { if (query === f.main) seen.push(query.state.data?.rate_limit.allowed) })
  f.adapter.attach(f.client); seen.length = 0
  f.main.setData(usage())
  f.client.setQueryData(f.main.queryKey, usage())
  assert.deepEqual(seen, [true, true])
  const sse = f.add(['rate-limit-status', 'new-user', 'new-account'])
  sse.setData(usage())
  assert.equal(sse.state.data.rate_limit.allowed, true)
  f.adapter.dispose()
})

test('nested wrapper payloads are reversible and unknown data is preserved', () => {
  const f = fixture(); const raw = { usage: usage(), revision: 'unchanged' }
  f.main.setData(raw); f.adapter.attach(f.client)
  assert.equal(f.main.state.data.usage.rate_limit.allowed, true)
  f.adapter.dispose(); assert.equal(f.main.state.data, raw)
  const unknown = { rate_limit: { allowed: false, limit_reached: true } }
  assert.equal(f.box.codexUsageUnlocked(unknown), unknown)
})

test('functional nested subscriber updates retain the real quota across structural sharing', () => {
  const f = fixture({ copying: true }); f.adapter.attach(f.client)
  let updated = false
  f.cache.subscribe(({ query }) => {
    if (query !== f.main || updated) return
    updated = true
    f.client.setQueryData(query.queryKey, old => { assert.equal(old.rate_limit.allowed, false); return { ...old, promo: 'first' } })
    f.client.setQueryData(query.queryKey, old => { assert.equal(old.promo, 'first'); return { ...old, extra: 'second' } })
  })
  f.main.setData(usage()); f.enable(false); f.adapter.refresh()
  assert.equal(f.main.state.data.rate_limit.allowed, false)
  assert.equal(f.main.state.data.promo, 'first')
  assert.equal(f.main.state.data.extra, 'second')
  f.adapter.dispose()
})

test('new account responses and genuine refill replace older exhausted snapshots', () => {
  const f = fixture(); f.adapter.attach(f.client)
  const latest = { ...usage(), account_id: 'latest-account' }
  f.main.setData(latest); f.enable(false); f.adapter.refresh()
  assert.equal(f.main.state.data, latest)
  f.enable(true); f.adapter.refresh()
  const refill = usage(true); f.main.setData(refill)
  f.enable(false); f.adapter.refresh(); assert.equal(f.main.state.data, refill)
  f.adapter.dispose()
})

test('stable heartbeats do not publish repeatedly and disposal restores methods and subscriptions', () => {
  const f = fixture(); const original = f.main.setData; const clientMethod = f.client.setQueryData
  f.adapter.attach(f.client); const count = f.adapter.status.publications
  for (let i = 0; i < 5; i++) { f.adapter.attach(f.client); f.adapter.refresh() }
  assert.equal(f.adapter.status.publications, count)
  assert.equal(f.listenerCount(), 1)
  f.adapter.dispose(); f.adapter.dispose()
  assert.equal(f.main.setData, original); assert.equal(f.client.setQueryData, clientMethod)
  assert.equal(f.listenerCount(), 0); assert.equal(f.main.state.data, f.raw)
  const next = f.box.createCodexUsageCacheAdapter({ getPolicy: () => ({ enabled: true }) })
  next.attach(f.client); assert.equal(f.listenerCount(), 1)
  next.dispose(); assert.equal(f.main.state.data, f.raw)
})

test('a replaced query publisher is detected and repaired before later quota publications', () => {
  const f = fixture(); const native = f.main.setData
  f.adapter.attach(f.client)
  f.main.setData = native
  assert.equal(f.adapter.status.healthy, false)
  f.main.setData(usage())
  assert.equal(f.main.state.data.rate_limit.allowed, true, 'the cache event repairs the overwritten publisher immediately')
  f.adapter.refresh()
  assert.equal(f.adapter.status.healthy, true)
  assert.equal(f.main.state.data.rate_limit.allowed, true)
  const repaired = f.main.setData; const seen = []
  f.cache.subscribe(({ query }) => { if (query === f.main) seen.push(query.state.data.rate_limit.allowed) })
  f.main.setData(usage())
  assert.deepEqual(seen, [true])
  f.adapter.refresh(); assert.equal(f.main.setData, repaired)
  assert.equal(f.adapter.status.repairs, 1)
  f.adapter.dispose()
  assert.equal(f.main.setData, native)
  assert.equal(f.main.state.data.rate_limit.allowed, false)
})

test('publisher replacements that delegate to old hooks do not stack active projections', () => {
  const f = fixture(); f.adapter.attach(f.client)
  const oldQuery = f.main.setData; const oldClient = f.client.setQueryData
  f.main.setData = function (...args) { return oldQuery.apply(this, args) }
  f.client.setQueryData = function (...args) { return oldClient.apply(this, args) }
  assert.equal(f.adapter.status.needsRepair, true)
  f.adapter.refresh()
  assert.equal(f.adapter.status.healthy, true)
  assert.equal(f.listenerCount(), 1)
  const publications = f.adapter.status.publications
  f.client.setQueryData(f.main.queryKey, raw => {
    assert.equal(raw.rate_limit.allowed, false)
    return { ...raw, revision: 2 }
  })
  assert.equal(f.adapter.status.publications, publications + 1)
  assert.equal(f.main.state.data.rate_limit.allowed, true)
  f.adapter.dispose()
  assert.equal(f.listenerCount(), 0)
  assert.equal(f.main.state.data.rate_limit.allowed, false)
  assert.equal(f.main.state.data.revision, 2)
})

test('a replaced QueryCache moves the subscription and restores the detached cache', () => {
  const f = fixture(); const next = fixture()
  f.adapter.attach(f.client)
  f.client.getQueryCache = () => next.cache
  f.client.setQueryData = next.client.setQueryData
  assert.equal(f.adapter.status.healthy, false)
  f.adapter.refresh()
  assert.equal(f.adapter.status.healthy, true)
  assert.equal(f.listenerCount(), 0); assert.equal(next.listenerCount(), 1)
  assert.equal(f.main.state.data, f.raw)
  assert.equal(next.main.state.data.rate_limit.allowed, true)
  const added = next.add(['rate-limit-status', 'new-user', 'new-account'])
  added.setData(usage())
  assert.equal(added.state.data.rate_limit.allowed, true)
  f.adapter.dispose()
  assert.equal(next.listenerCount(), 0)
  assert.equal(next.main.state.data, next.raw)
})

test('confirmed cache failures clear only after a successful repair and refresh', () => {
  const f = fixture(); const native = f.main.setData
  f.adapter.attach(f.client)
  f.main.setData = undefined
  f.adapter.refresh()
  assert.equal(f.adapter.status.healthy, false)
  assert.equal(f.adapter.status.error, 'usage-query-refresh-failed')
  f.adapter.refresh(); assert.equal(f.adapter.status.healthy, false)
  f.main.setData = native
  f.adapter.refresh()
  assert.equal(f.adapter.status.healthy, true)
  assert.equal(f.adapter.status.error, '')
  f.main.setData(usage())
  assert.equal(f.main.state.data.rate_limit.allowed, true)
  f.adapter.dispose()
})

test('temporarily unavailable cache is retried without retaining a stale successful installation', () => {
  const f = fixture(); f.adapter.attach(f.client)
  f.client.getQueryCache = () => { throw new Error('synthetic cache failure') }
  f.adapter.refresh()
  assert.equal(f.adapter.status.installed, false)
  assert.equal(f.adapter.status.healthy, false)
  assert.equal(f.listenerCount(), 0)
  assert.equal(f.main.state.data, f.raw)
  f.client.getQueryCache = () => f.cache
  f.adapter.refresh()
  assert.equal(f.adapter.status.healthy, true)
  assert.equal(f.adapter.status.error, '')
  assert.equal(f.listenerCount(), 1)
  assert.equal(f.main.state.data.rate_limit.allowed, true)
  f.adapter.dispose()
})

const settle = () => new Promise(resolve => setImmediate(resolve))
function stalledHome(f, host = 'local') {
  f.add(['git', 'local', 'managed-worktree-state', 'codex-home-loading', 'workspace'], null)
  return f.add(['vscode', 'codex-home', JSON.stringify({ hostId: host })], null, { status: 'pending', fetchStatus: 'fetching' })
}

test('a stalled local directory read retries only after ten seconds and at most twice', async () => {
  const f = fixture(); stalledHome(f); f.adapter.attach(f.client)
  f.adapter.refresh(); f.advance(9999); f.adapter.refresh(); await settle()
  assert.equal(f.calls.length, 0)
  f.advance(1); f.adapter.refresh(); await settle()
  assert.deepEqual(f.calls.map(x => x[0]), ['cancel', 'refetch'])
  f.advance(10000); f.adapter.refresh(); await settle()
  f.advance(10000); f.adapter.refresh(); await settle()
  assert.equal(f.calls.length, 4); assert.equal(f.adapter.status.homeRetries, 2)
  f.adapter.dispose()
})

test('directory recovery also works while local target selection is pending', async () => {
  const f = fixture(); stalledHome(f); f.enable(false); f.allowRecovery(true)
  f.adapter.attach(f.client); f.adapter.refresh(); f.advance(10000); f.adapter.refresh(); await settle()
  assert.equal(f.calls.length, 2)
  assert.equal(f.main.state.data.rate_limit.allowed, false)
  f.adapter.dispose()
})

test('remote reads, nonblocking requests and disabled relay do not retry', async () => {
  for (const scenario of ['remote', 'not-blocking', 'disabled', 'already-loaded']) {
    const f = fixture()
    let query
    if (scenario === 'not-blocking') query = f.add(['vscode', 'codex-home'], null, { status: 'pending', fetchStatus: 'fetching' })
    else query = stalledHome(f, scenario === 'remote' ? 'ssh-host' : 'local')
    if (scenario === 'disabled') f.enable(false)
    if (scenario === 'already-loaded') query.state.data = { codexHome: 'synthetic' }
    f.adapter.attach(f.client); f.adapter.refresh(); f.advance(20000); f.adapter.refresh(); await settle()
    assert.equal(f.calls.length, 0, scenario); f.adapter.dispose()
  }
})

test('switching mode before a queued retry cancels it, but an initiated cancellation is completed', async () => {
  const f = fixture(); stalledHome(f); f.adapter.attach(f.client); f.adapter.refresh()
  f.advance(10000); f.adapter.refresh(); f.enable(false); await settle()
  assert.equal(f.calls.length, 0)
  f.adapter.dispose()
  const g = fixture(); stalledHome(g); let finish
  g.client.cancelQueries = () => { g.calls.push(['cancel']); return new Promise(resolve => { finish = resolve }) }
  g.adapter.attach(g.client); g.adapter.refresh(); g.advance(10000); g.adapter.refresh(); await settle()
  g.enable(false); finish(); await settle()
  assert.deepEqual(g.calls.map(x => x[0]), ['cancel', 'refetch']); g.adapter.dispose()
})

test('helper failure restores cached data and diagnostics never contain account values', () => {
  const f = fixture(); f.adapter.attach(f.client); f.enable(false); f.adapter.refresh()
  assert.equal(f.main.state.data.rate_limit.allowed, false)
  const report = JSON.stringify(f.adapter.status)
  for (const value of ['synthetic-account', 'original-warning', 'unchanged', '1000']) assert.equal(report.includes(value), false)
  f.adapter.dispose()
})

test('a frozen query method fails visibly without leaving a client hook installed', () => {
  const f = fixture(); const original = f.client.setQueryData
  Object.defineProperty(f.main, 'setData', { writable: false, configurable: false })
  f.adapter.attach(f.client)
  assert.equal(f.adapter.status.installed, false)
  assert.equal(f.adapter.status.error, 'usage-query-hook-failed')
  assert.equal(f.client.setQueryData, original); assert.equal(f.listenerCount(), 0)
  f.adapter.dispose()
})

test('cache policy uses effective routing even when the saved conversation provider is openai', () => {
  const r = runtime()
  const token = { id: 'scope' }; const node = { token, value: { kind: 'local', conversationId: 'old-thread' }, familyBindings: new Map() }
  const contexts = [new Map([[token.id, node]])]
  const state = { enabled: true, provider: 'custom', mode: 'relay', baseUrl: 'https://relay.example.invalid/v1' }
  const config = { data: { model_provider: 'custom', model_providers: { custom: { name: 'Gaoge', base_url: state.baseUrl } } } }
  const b = { threadHost: { kind: 'readable-family', value: 'local' }, threadCwd: { kind: 'readable-family', value: 'workspace' },
    threadProvider: { kind: 'readable-family', value: 'openai' }, config: { kind: 'readable-family', value: config } }
  r.codexSpeedReadFamily = binding => binding.value
  assert.equal(r.codexUsagePolicy(contexts, b, state).enabled, true)
  config.data.model_provider = 'openai'
  assert.equal(r.codexUsagePolicy(contexts, b, state).reason, 'workspace-not-relay')
  config.data.model_provider = 'custom'; config.isPending = true
  assert.equal(r.codexUsagePolicy(contexts, b, state).reason, 'workspace-config-pending')
  config.isPending = false; b.threadHost.value = 'remote'
  assert.equal(r.codexUsagePolicy(contexts, b, state).enabled, false)
  b.threadHost.value = 'local'; node.value.kind = 'cloud'
  assert.equal(r.codexUsagePolicy(contexts, b, state).enabled, false)
  node.value.kind = 'local'; state.enabled = false
  assert.equal(r.codexUsagePolicy(contexts, b, state).enabled, false)
})

test('missing optional new-task selector names do not disable retained local target discovery', () => {
  const r = runtime(); const token = { id: 'scope' }
  const node = { token, value: { kind: 'new' }, familyBindings: new Map() }
  const state = { enabled: true, provider: 'custom', mode: 'relay', baseUrl: 'https://relay.example.invalid/v1' }
  r.codexFuelNewTarget = (_get, _scope, bindings) => { assert.equal(bindings.newTargetSelectorsUnavailable, undefined); return { cwd: 'workspace' } }
  assert.equal(r.codexUsagePolicy([new Map([[token.id, node]])], { newTargetSelectorsUnavailable: true }, state).enabled, true)
})

test('a later hook failure restores already transformed queries during attach rollback', () => {
  const f = fixture()
  const second = f.add(['rate-limit-status', 'other-user', 'other-account'], usage())
  Object.defineProperty(second, 'setData', { writable: false, configurable: false })
  f.adapter.attach(f.client)
  assert.equal(f.adapter.status.installed, false)
  assert.equal(f.main.state.data, f.raw)
  assert.equal(f.listenerCount(), 0)
  f.adapter.dispose()
})

test('re-enabling relay gives a stalled read a fresh bounded retry budget', async () => {
  const f = fixture(); stalledHome(f); f.adapter.attach(f.client); f.adapter.refresh()
  for (let i = 0; i < 3; i++) { f.advance(10000); f.adapter.refresh(); await settle() }
  assert.equal(f.calls.length, 4)
  f.enable(false); f.adapter.refresh(); f.enable(true); f.adapter.refresh()
  f.advance(10000); f.adapter.refresh(); await settle()
  assert.equal(f.calls.length, 6)
  f.adapter.dispose()
})

test('new query additions do not alter unrelated caches or double wrap existing methods', () => {
  const f = fixture(); f.adapter.attach(f.client)
  const untouched = { allowed: false }
  const other = f.add(['unrelated'], untouched)
  const original = other.setData
  for (let i = 0; i < 3; i++) f.adapter.refresh()
  assert.equal(other.state.data, untouched); assert.equal(other.setData, original)
  f.adapter.dispose()
})

test('React root discovery unlocks a mounted usage cache before composer DOM fibers exist', () => {
  const f = fixture()
  const provider = { memoizedProps: { client: f.client } }
  const current = { child: provider }
  const root = { __reactContainer$fixture: { stateNode: { current } } }
  f.box.document = { getElementById: id => id === 'root' ? root : null,
    body: {}, documentElement: {}, querySelectorAll: () => [] }
  const oldClients = new Set()
  f.box.codexFuelFindContexts(fiber => f.box.codexUsageInspectClient(fiber, client => oldClients.add(client)))
  assert.equal(oldClients.size, 0, 'the composer ancestor scan cannot reach this mounted query provider')
  const clients = f.box.codexUsageFindClients()
  assert.equal(clients.size, 1); assert.equal(clients.has(f.client), true)
  assert.equal(f.main.state.data.rate_limit.allowed, false, 'discovery alone must not rewrite account data')
  try {
    for (const client of clients) f.adapter.attach(client)
    assert.equal(f.adapter.status.installed, true)
    assert.equal(f.main.state.data.rate_limit.allowed, true)
    assert.equal(f.raw.rate_limit.allowed, false)
    f.enable(false); f.adapter.refresh()
    assert.equal(f.main.state.data, f.raw)
  } finally { f.adapter.dispose() }
})

test('React root discovery includes body and document roots and deduplicates shared clients', () => {
  const r = runtime()
  const client = () => ({ getQueryCache() {}, setQueryData() {} })
  const first = client(), second = client(), third = client(), stale = client()
  const current = { memoizedProps: { value: first }, child: { memoizedState: { memoizedState: second } } }
  current.child.sibling = { memoizedProps: { queryClient: first } }
  const root = { __reactContainer$fixture: { stateNode: { current }, child: { memoizedProps: { client: stale } } } }
  const body = { __reactFiber$fixture: { memoizedProps: { client: second } } }
  const documentElement = { __reactContainer$fixture: { stateNode: third } }
  const clients = r.codexUsageFindClients({ getElementById: () => root, body, documentElement })
  assert.equal(clients.size, 3)
  for (const value of [first, second, third]) assert.equal(clients.has(value), true)
  assert.equal(clients.has(stale), false, 'a root pointer must follow stateNode.current rather than a stale child')
})

test('React root discovery tolerates cycles and malformed roots, nodes, and getters', () => {
  const r = runtime()
  const client = { getQueryCache() {}, setQueryData() {} }
  const good = { memoizedProps: { client } }
  const broken = { sibling: good, get memoizedProps() { throw new Error('unavailable props') },
    get child() { throw new Error('unavailable child') } }
  good.child = broken; good.sibling = good
  const body = { __reactFiber$fixture: broken,
    get __reactContainer$broken() { throw new Error('unavailable root') } }
  const documentElement = new Proxy({}, { ownKeys() { throw new Error('unavailable keys') } })
  const clients = r.codexUsageFindClients({ getElementById() { throw new Error('unavailable document lookup') },
    body, documentElement })
  assert.equal(clients.size, 1); assert.equal(clients.has(client), true)
  assert.equal(r.codexUsageFindClients(null).size, 0)
})

test('React root discovery obeys its node budget without following return or alternate graphs', () => {
  const r = runtime()
  const client = { getQueryCache() {}, setQueryData() {} }
  const leaf = { memoizedProps: { client } }
  const first = { child: { child: leaf }, return: leaf, alternate: leaf }
  const doc = { getElementById: () => ({ __reactFiber$fixture: first }) }
  assert.equal(r.codexUsageFindClients(doc, { maxNodes: 0 }).size, 0)
  assert.equal(r.codexUsageFindClients(doc, { maxNodes: 2 }).size, 0)
  assert.equal(r.codexUsageFindClients(doc, { maxNodes: 3 }).has(client), true)
})

// A mounted host and root.current model the native committed fiber contract.
function visibleFixture() {
  const box = runtime(); const elements = [];
  box.document = { querySelectorAll: () => elements };
  const state = { enabled: true, provider: 'custom', mode: 'relay', baseUrl: 'https://relay.example.invalid/v1' };
  const config = { data: { model_provider: 'custom', model_providers: { custom: { name: 'Gaoge', base_url: state.baseUrl } } } };
  const bindings = { config: { kind: 'readable-family', value: config } };
  box.codexSpeedReadFamily = binding => binding.value;
  function add(kind, visible = true) {
    const token = { id: Symbol('composer') };
    const node = { token, value: { kind, hostId: 'local', cwd: 'synthetic-workspace' }, familyBindings: new Map() };
    const chain = new Map([[token.id, node]]);
    const element = { visible, isConnected: true, getClientRects() { return this.visible ? [{}] : [] }, closest: () => null };
    const root = { stateNode: {}, return: null }; root.stateNode.current = root;
    const provider = { return: root, memoizedProps: { value: { chain } } }; root.child = provider;
    const host = { return: provider, stateNode: element }; provider.child = host;
    element.__reactFiber$fixture = host; elements.push(element);
    return { element, node, chain, root, provider, host };
  }
  return { box, add, state, config, bindings, elements, policy: () => box.codexUsageVisiblePolicy(bindings, state, []) };
}

test('retained hidden new composer no longer vetoes a visible relay thread (customer v13 regression)', () => {
  const f = visibleFixture(); f.add('new', false); f.add('local');
  const selection = f.box.codexUsageFindComposers();
  assert.equal(selection.contexts.length, 1); assert.equal(selection.hiddenEditors, 1);
  assert.equal(f.policy().enabled, true); assert.equal(f.policy().reason, 'workspace-relay-confirmed');
  f.elements.reverse(); assert.equal(f.policy().enabled, true);
});

test('a stale alternate with new-target-pending cannot override the committed local composer', () => {
  const f = visibleFixture(); const local = f.add('local'); const stale = f.add('new');
  f.elements.pop();
  stale.root.stateNode = local.root.stateNode;
  local.host.alternate = stale.host; stale.host.alternate = local.host;
  local.element.__reactFiber$fixture = stale.host;
  local.provider.pendingProps = stale.provider.memoizedProps;
  assert.equal(f.policy().enabled, true); assert.equal(f.policy().visibleComposers, 1);
  assert.equal(f.box.codexUsageFindComposers().contexts[0], local.chain);
});

test('committed discovery handles shared bailout children even when return points to the old parent', () => {
  const f = visibleFixture(); const local = f.add('local');
  const oldRoot = { stateNode: local.root.stateNode, return: null };
  const oldProvider = { return: oldRoot, child: local.host, memoizedProps: { value: { chain: new Map() } } };
  oldRoot.child = oldProvider; oldProvider.alternate = local.provider; local.provider.alternate = oldProvider;
  local.host.return = oldProvider;
  assert.equal(f.policy().enabled, true);
});

test('no visible or unresolved mounted composer restores rather than globally authorizing the cache', () => {
  const f = visibleFixture(); const local = f.add('local');
  local.element.visible = false;
  assert.equal(f.policy().reason, 'visible-composer-unavailable');
  local.element.visible = true; local.root.stateNode.current = {};
  assert.equal(f.policy().enabled, false); assert.equal(f.policy().reason, 'visible-composer-unresolved');
  local.root.stateNode.current = local.root;
  f.elements.push({ isConnected: true, getClientRects: () => [{}] });
  assert.equal(f.policy().enabled, false); assert.equal(f.policy().unresolvedEditors, 1);
});

test('global relay mode enables the cache even when composer discovery is unresolved', () => {
  const f = visibleFixture(); const local = f.add('local');
  local.root.stateNode.current = {};
  const forced = () => f.box.codexUsageVisiblePolicy(f.bindings, f.state, [], true);
  assert.equal(f.policy().reason, 'visible-composer-unresolved');
  f.box.codexUsageFindComposers = () => { throw new Error('composer scan must not run') };
  assert.equal(forced().enabled, true);
  assert.equal(forced().reason, 'relay-global-forced');

  const q = fixture();
  const adapter = f.box.createCodexUsageCacheAdapter({ getPolicy: forced });
  adapter.attach(q.client);
  assert.equal(q.main.state.data.rate_limit.allowed, true);
  assert.equal(adapter.status.reason, 'relay-global-forced');
  adapter.dispose(); q.adapter.dispose();
});

test('hidden and inert editors are excluded even if they retain a layout rectangle', () => {
  const f = visibleFixture(); f.add('local'); const hidden = f.add('new');
  hidden.element.closest = () => ({});
  assert.equal(f.policy().enabled, true);
  hidden.element.closest = () => null; hidden.element.checkVisibility = () => false;
  assert.equal(f.policy().enabled, true);
});

test('all visible composers must use the relay; focus does not override split-view route conflicts', () => {
  const f = visibleFixture(); f.add('local'); const other = f.add('new');
  assert.equal(f.policy().reason, 'new-target-pending');
  other.node.value.kind = 'cloud'; assert.equal(f.policy().reason, 'nonlocal-composer');
  other.node.value.kind = 'local'; other.node.value.hostId = 'remote';
  assert.equal(f.policy().reason, 'nonlocal-host');
  other.node.value.hostId = 'local'; assert.equal(f.policy().enabled, true);
  f.config.data.model_provider = 'openai'; assert.equal(f.policy().reason, 'workspace-not-relay');
  f.config.data.model_provider = 'custom'; f.config.data.profile = 'foreign';
  assert.equal(f.policy().enabled, false);
});

test('cache restoration follows visible cloud/official navigation and relay disable without losing raw usage', () => {
  const f = visibleFixture(); const home = f.add('new', false); const local = f.add('local');
  const q = fixture(); const adapter = f.box.createCodexUsageCacheAdapter({ getPolicy: f.policy });
  adapter.attach(q.client); assert.equal(q.main.state.data.rate_limit.allowed, true);
  assert.equal(adapter.status.hiddenEditors, 1); assert.equal(adapter.status.visibleComposers, 1);
  local.element.visible = false; home.element.visible = true; home.node.value.kind = 'cloud'; adapter.refresh();
  assert.equal(q.main.state.data, q.raw); assert.equal(adapter.status.reason, 'nonlocal-composer');
  home.element.visible = false; local.element.visible = true; adapter.refresh();
  assert.equal(q.main.state.data.rate_limit.allowed, true);
  f.config.data.model_provider = 'openai'; adapter.refresh(); assert.equal(q.main.state.data, q.raw);
  f.config.data.model_provider = 'custom'; f.state.enabled = false; adapter.refresh();
  assert.equal(q.main.state.data, q.raw); adapter.dispose(); q.adapter.dispose();
});
