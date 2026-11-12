const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const discoverCodexPluginBindings = new Function(fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_plugin_bindings.js'), 'utf8') + '; return discoverCodexPluginBindings;')();

function fixture(native) {
  const token = native?.appScope || { __scopeBrand: 'AppScope', id: Symbol() };
  const connectionSignal = {}, navigationSignal = {}, accountSignal = native?.accountSignal || {};
  const calls = [], mutations = [], rpc = { sendRequest(method, params) { calls.push([method, params]); return Promise.resolve({ featuredPluginIds: [], marketplaceLoadErrors: [], marketplaces: [] }); } };
  let connection = { status: 'ready', client: { hostId: 'local', rpc } };
  let accountToken = Object.freeze({});
  const atom = {}, store = { get() { throw Error('store.get must never run'); }, sub() { throw Error('store.sub must never run'); } };
  const atomStates = new WeakMap([[atom, { v: accountToken }]]), mounted = new WeakMap([[atom, {}]]);
  const tuple = Object.freeze(Array.from({ length: 29 }, (_, index) => index === 0 ? atomStates : index === 1 ? mounted : undefined));
  const storeCache = new WeakMap([[store, tuple]]);
  const inspectStore = new Function('D', 'return function(e){let t=D.get(e),n=t[24];return n?n(t,e):t}')(storeCache);
  const makeStore = new Function('i', 'o', 'return function c(){return i?i():(0,o._b)()}')(undefined, { _b: () => store });
  let bridge = { pathname: '/local', navigate: (...args) => calls.push(['navigate', ...args]), prepareNavigation() {} };
  const scope = native?.scope || { scope: token, node: { token, store, familyBindings: new Map([[accountSignal, new Map([['local', { value: { atom, store } }]])]]) }, query: {}, get(signal, host) {
    if (signal === connectionSignal) { assert.equal(host, 'local'); return connection; }
    if (signal === navigationSignal) return bridge;
    throw Error('Unexpected signal');
  }, set: (...args) => mutations.push(args), watch: (...args) => mutations.push(args) };
  native?.setConnection(connection); native?.setNavigation(bridge); native?.setAccount(accountToken); native?.resetAccessCounters();
  const root = { tag: 3, child: null, stateNode: null };
  root.stateNode = { current: root };
  const container = { isConnected: true, __reactContainer$fixture: root, contains: element => elements.has(element) };
  const scopeFiber = { tag: 0, return: root, memoizedState: { memoizedState: { current: scope }, next: null } };
  root.child = scopeFiber;
  const sidebar = { isConnected: true }, entry = { isConnected: true, closest: selector => selector.includes('data-sidebar') ? sidebar : null };
  const sidebarFiber = { tag: 5, return: scopeFiber, memoizedProps: { 'data-sidebar-navigation-root': true } };
  const itemFiber = { tag: 0, return: sidebarFiber, memoizedProps: { item: { newTabPath: '/plugins' } } };
  const entryFiber = { tag: 5, return: itemFiber, memoizedProps: { 'data-sidebar-destination': 'builtin:skills' } };
  scopeFiber.child = sidebarFiber; sidebarFiber.child = itemFiber; itemFiber.child = entryFiber;
  sidebar.__reactFiber$fixture = sidebarFiber; entry.__reactFiber$fixture = entryFiber;
  const search = { isConnected: true, getClientRects: () => [{}], closest: () => null };
  const searchFiber = { tag: 5, type: 'input', return: scopeFiber, memoizedProps: { id: 'plugins-store-page-search', onChange() {} } };
  sidebarFiber.sibling = searchFiber; search.__reactFiber$fixture = searchFiber;
  const elements = new Set([sidebar, entry, search]);
  const doc = { getElementById: id => id === 'root' ? container : null,
    querySelectorAll: selector => selector.startsWith('[data-sidebar-navigation-root]') ? [sidebar] : selector.includes('builtin:skills') ? [entry] : selector === 'input#plugins-store-page-search' ? [search] : [] };
  const require = () => { throw Error('No module factories may be executed'); };
  require.c = { OWtl: { exports: { u: token } }, l00C: { exports: { M4: connectionSignal } }, E8Sp: { exports: { gM: navigationSignal } }, w0gB: { exports: { bV: accountSignal } }, HkKI: { exports: { h7: inspectStore } }, ouEa: { exports: { y$: makeStore } } };
  require.m = { OWtl() {}, l00C() {}, ouEa: new Function('return function ouEa(){function c(){return i?i():(0,o._b)()}}')(), HkKI: new Function('return function HkKI(){D.set(t,Object.freeze(n))}')() };
  return { module: native?.module || { __webpack_require__: require }, doc, root, scopeFiber, scope, rpc, calls, mutations,
    sidebar, sidebarFiber, entry, entryFiber, itemFiber, container, search, searchFiber, accountSignal, atom, atomStates, mounted,
    get accountToken() { return accountToken; },
    setAccount: value => { accountToken = value; atomStates.set(atom, { v: value }); native?.setAccount(value); },
    setConnection: value => { connection = value; native?.setConnection(value); },
    setNavigation: value => { bridge = value; native?.setNavigation(value); } };
}
const discover = f => discoverCodexPluginBindings({ module: f.module, document: f.doc });

test('binds only the committed AppScope local native connection without side effects', () => {
  const f = fixture(), result = discover(f);
  assert.deepEqual(result.clients, [f.rpc]); assert.equal(result.scopeToken, f.scope.node);
  assert.equal(result.connectionToken, f.rpc); assert.equal(result.accountToken, f.accountToken); assert.equal(result.isCurrent(), true); assert.equal(result.probeOnly, true);
  assert.equal(result.sidebar, f.sidebar); assert.equal(result.ui.nativeEntry, f.entry);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.mutations, []);
});
test('rejects unavailable, disconnected, replaced and connecting connections', () => {
  const f = fixture();
  for (const status of ['unavailable', 'disconnected', 'replaced', 'connecting']) {
    f.setConnection({ status, client: { rpc: f.rpc } });
    assert.deepEqual(discover(f).clients, []);
  }
});
test('accepts the native request-only existing client, never a deferred RPC', () => {
  const f = fixture(); f.setConnection({ status: 'request-only', client: null, requestClient: { rpc: f.rpc } });
  assert.deepEqual(discover(f).clients, [f.rpc]); assert.deepEqual(f.calls, []);
});
test('does not walk speculative alternate trees or stale root.current pointers', () => {
  const f = fixture(); f.root.stateNode.current = { tag: 3, child: null };
  assert.deepEqual(discover(f).clients, []);
});
test('rejects impostor hook refs that do not match the native AppScope token', () => {
  const f = fixture(); f.scope.scope = { __scopeBrand: 'AppScope' };
  assert.deepEqual(discover(f).clients, []);
});
test('rejects generic sidebar elements and skills-only entries', () => {
  const f = fixture(); f.sidebar.__reactFiber$fixture = {};
  assert.equal(discover(f).sidebar, null);
  f.sidebar.__reactFiber$fixture = f.sidebarFiber;
  f.itemFiber.memoizedProps.item.newTabPath = '/skills';
  assert.equal(discover(f).ui.nativeEntry, null);
});
test('ignores unreviewed ESM exports and never executes getter exports', () => {
  const f = fixture(); let read = false;
  Object.defineProperty(f.module.__webpack_require__.c.OWtl.exports, 'u', { get() { read = true; throw Error(); } });
  assert.deepEqual(discover(f).clients, []); assert.equal(read, false);
});
test('uses only the existing native navigation callback after an explicit invocation', () => {
  const f = fixture(), result = discover(f);
  assert.deepEqual(f.calls, []);
  assert.equal(result.navigation.openMarketplace(), true);
  assert.deepEqual(f.calls, [['navigate', '/plugins', { state: { initialHostId: 'local' } }]]);
});
test('revokes saved navigation on connection or native bridge replacement', () => {
  const f = fixture(), result = discover(f);
  f.setConnection({ status: 'disconnected', client: null });
  assert.equal(result.navigation.openMarketplace(), false);
  f.setConnection({ status: 'ready', client: { rpc: f.rpc } });
  f.setNavigation({ pathname: '/local', navigate() {}, prepareNavigation() {} });
  assert.equal(result.navigation.openMarketplace(), false);
  assert.deepEqual(f.calls, []);
});
test('missing mounted navigation remains unavailable instead of installing a router', () => {
  const f = fixture(); f.setNavigation({ navigate() { throw Error(); }, prepareNavigation() {} });
  assert.equal(discover(f).navigation, null); assert.deepEqual(f.calls, []);
});
test('bounded malformed hook lists cannot loop indefinitely', () => {
  const f = fixture(); f.scopeFiber.memoizedState.next = f.scopeFiber.memoizedState;
  assert.deepEqual(discover(f).clients, [f.rpc]);
});


test('revokes opaque account evidence on replacement or removal with identical scope and RPC', () => {
  const f = fixture(), result = discover(f), old = f.accountToken;
  f.setAccount(Object.freeze({}));
  assert.equal(result.isCurrent(), false); assert.equal(result.navigation.openMarketplace(), false);
  assert.notEqual(discover(f).accountToken, old);
  f.setAccount(null); assert.deepEqual(discover(f).clients, []);
  assert.deepEqual(f.calls, []);
});
test('never inspects opaque account fields and rejects missing, unmounted, error or unknown cache states', () => {
  const f = fixture();
  const opaque = new Proxy({}, { get() { throw Error('account fields are private'); }, ownKeys() { throw Error('account enumeration is forbidden'); } });
  f.setAccount(opaque); assert.equal(discover(f).accountToken, opaque);
  f.mounted.delete(f.atom); assert.deepEqual(discover(f).clients, []);
  f.mounted.set(f.atom, {}); f.atomStates.set(f.atom, { v: opaque, e: Error('state') }); assert.deepEqual(discover(f).clients, []);
  f.atomStates.delete(f.atom); assert.deepEqual(discover(f).clients, []);
  f.setAccount(opaque); f.scope.node.familyBindings.delete(f.accountSignal); assert.deepEqual(discover(f).clients, []);
});
test('does not invoke changed or unreviewed store inspectors', () => {
  const f = fixture(); let called = false;
  f.module.__webpack_require__.c.HkKI.exports.h7 = () => { called = true; throw Error('unreviewed'); };
  assert.deepEqual(discover(f).clients, []); assert.equal(called, false);
});
test('navigation rechecks native disabled gate and attached sidebar at click time', () => {
  const f = fixture(), result = discover(f);
  f.entry.disabled = true; assert.equal(result.navigation.openMarketplace(), false);
  f.entry.disabled = false; f.entry.getAttribute = name => name === 'aria-disabled' ? 'true' : null;
  assert.equal(result.navigation.openMarketplace(), false);
  f.entry.getAttribute = () => null; f.sidebar.isConnected = false;
  assert.equal(result.navigation.openMarketplace(), false); assert.deepEqual(f.calls, []);
});
test('accepts only visible committed native plugin store search input on plugins route', () => {
  const f = fixture(); assert.equal(discover(f).ui.search, null);
  f.setNavigation({ pathname: '/plugins', navigate() {}, prepareNavigation() {} });
  assert.equal(discover(f).ui.search, f.search);
  f.search.disabled = true; assert.equal(discover(f).ui.search, null); f.search.disabled = false;
  f.search.readOnly = true; assert.equal(discover(f).ui.search, null); f.search.readOnly = false;
  f.search.getClientRects = () => []; assert.equal(discover(f).ui.search, null); f.search.getClientRects = () => [{}];
  f.searchFiber.memoizedProps.id = 'plugins-page-search'; assert.equal(discover(f).ui.search, null);
  f.searchFiber.memoizedProps.id = 'plugins-store-page-search'; f.search.__reactFiber$fixture = {};
  assert.equal(discover(f).ui.search, null);
});

const packagePath = process.env.CODEX_NATIVE_APP_ASAR;
test('registered native AppScope, RPC selector and plugin/list query execute only in isolation',
  { skip: packagePath ? false : 'Set CODEX_NATIVE_APP_ASAR for read-only installed bundle verification', timeout: 120000 }, async t => {
    const crypto = require('node:crypto');
    const { nativePluginFixture } = require('./codex-plugin-native-fixture.cjs');
    const hash = async () => { const h = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(packagePath)) h.update(chunk); return h.digest('hex'); };
    const before = await hash(), native = nativePluginFixture(packagePath), f = fixture(native);
    assert.deepEqual(discover(f).clients, [f.rpc]);
    const accountBindings = discover(f);
    assert.equal(accountBindings.isCurrent(), true);
    assert.deepEqual(native.accessCounters, { get: 0, sub: 0, authSubscribe: 0 }, 'Binding inspects cached references without evaluating or subscribing');
    const alternateAccount = Object.freeze({}); native.setAccount(alternateAccount); native.resetAccessCounters();
    assert.equal(accountBindings.isCurrent(), false); assert.equal(accountBindings.navigation.openMarketplace(), false);
    assert.equal(discover(f).accountToken, alternateAccount);
    assert.deepEqual(native.accessCounters, { get: 0, sub: 0, authSubscribe: 0 });
    native.unmountAccount(); native.resetAccessCounters();
    assert.deepEqual(discover(f).clients, []); assert.equal(native.accessCounters.sub, 0);
    native.unsafeImperativeRead();
    assert.equal(native.accessCounters.sub, 1, 'Installed GNwQ scope.get path really subscribes');
    assert.equal(native.accessCounters.authSubscribe, 1, 'Unsafe imperative read mounts the external signal');
    native.restoreAccount(); native.setAccount(f.accountToken); native.resetAccessCounters();
    await native.queryLocal([]);
    assert.deepEqual(f.calls, [['plugin/list', { marketplaceKinds: ['local'] }]]);
    f.calls.length = 0;
    await native.queryLocal(['C:/isolated-fixture']);
    assert.deepEqual(f.calls, [['plugin/list', { cwds: ['C:/isolated-fixture'], marketplaceKinds: ['local'] }]]);
    const bindings = discover(f); assert.equal(bindings.navigation.openMarketplace(), true);
    assert.deepEqual(f.calls[1], ['navigate', '/plugins', { state: { initialHostId: 'local' } }]);
    f.setConnection({ status: 'request-only', client: null, requestClient: { rpc: f.rpc } });
    assert.deepEqual(discover(f).clients, [f.rpc]);
    f.setConnection({ status: 'disconnected', client: null });
    assert.deepEqual(discover(f).clients, []); assert.equal(bindings.navigation.openMarketplace(), false);
    assert.equal(await hash(), before, 'Installed package remains byte-for-byte unchanged');
    t.diagnostic(JSON.stringify({ nativeExecuted: true, sha256: before, anchors: native.anchors }));
  });
