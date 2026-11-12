/* Read-only bindings for the reviewed Codex 26.1103 Rspack renderer.
 * Never executes a module factory, creates an RPC, reads authentication fields, or
 * mutates React state. Only already-committed AppScope refs are considered.
 */
var CODEX_PLUGIN_BINDINGS_VERSION = 2;

function discoverCodexPluginBindings({ module: entry, document: doc } = {}) {
  const result = { clients: [], probeOnly: true, pending: true, error: null, scopeToken: null,
    connectionToken: null, accountToken: null, isCurrent: () => false, navigation: null, sidebar: null,
    ui: { nativeEntry: null, search: null } };
  const own = (object, key) => {
    if (object == null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
  };
  const require = own(entry, '__webpack_require__');
  const cache = own(require, 'c');
  const factories = own(require, 'm');
  const cached = id => own(own(cache, id), 'exports');
  // These IDs and exports are intentionally narrow. Unknown builds stay pending
  // instead of invoking arbitrary exports or probing guessed bridge endpoints.
  const token = own(cached('OWtl'), 'u');
  const connectionSignal = own(cached('l00C'), 'M4');
  const navigationSignal = own(cached('E8Sp'), 'gM');
  const accountSignal = own(cached('w0gB'), 'bV');
  const inspectStore = own(cached('HkKI'), 'h7');
  const makeStore = own(cached('ouEa'), 'y$');
  // In this reviewed renderer, AppScope et() uses ouEa.y$(), which calls
  // HkKI._b() with no arguments. Its frozen tuple cannot acquire a custom [24]
  // inspection hook. Unknown store constructor/reader implementations fail shut.
  const functionSource = fn => { try { return Function.prototype.toString.call(fn); } catch { return ''; } };
  const nativeStoreContract = functionSource(inspectStore) === 'function(e){let t=D.get(e),n=t[24];return n?n(t,e):t}'
    && functionSource(makeStore) === 'function c(){return i?i():(0,o._b)()}'
    && functionSource(own(factories, 'ouEa')).includes('function c(){return i?i():(0,o._b)()}')
    && functionSource(own(factories, 'HkKI')).includes('D.set(t,Object.freeze(n))');
  function cachedAccountToken(candidate) {
    if (!accountSignal || !nativeStoreContract) return null;
    try {
      const node = own(candidate, 'node'), families = own(node, 'familyBindings');
      const members = Map.prototype.get.call(families, accountSignal);
      const member = Map.prototype.get.call(members, 'local');
      const signal = own(member, 'value'), atom = own(signal, 'atom'), store = own(signal, 'store');
      if (!atom || store !== own(node, 'store')) return null;
      const tuple = inspectStore(store);
      if (!Array.isArray(tuple) || !Object.isFrozen(tuple) || tuple[24] != null
          || !WeakMap.prototype.has.call(tuple[1], atom)) return null;
      const state = WeakMap.prototype.get.call(tuple[0], atom);
      if (!state || Object.prototype.hasOwnProperty.call(state, 'e')) return null;
      const value = own(state, 'v');
      // This opaque reference is never inspected, enumerated, cloned or logged.
      return value !== null && typeof value === 'object' ? value : null;
    } catch { return null; }
  }
  if (typeof require !== 'function' || !cache || !factories || !token
      || token.__scopeBrand !== 'AppScope' || !connectionSignal) {
    result.error = 'native-module-contract-unavailable';
    return result;
  }
  if (typeof own(factories, 'OWtl') !== 'function' || typeof own(factories, 'l00C') !== 'function') {
    result.error = 'native-module-contract-unavailable';
    return result;
  }
  const container = doc?.getElementById?.('root');
  if (!container || container.isConnected === false) return result;
  const roots = [];
  for (const key of Object.getOwnPropertyNames(container)) {
    if (!key.startsWith('__reactContainer$')) continue;
    const attached = own(container, key), current = own(own(attached, 'stateNode'), 'current');
    if (current && own(current, 'tag') === 3 && !roots.includes(current)) roots.push(current);
  }
  if (!roots.length) return result;
  const isScope = value => value && own(value, 'scope') === token
    && own(own(value, 'node'), 'token') === token
    && typeof own(value, 'get') === 'function' && typeof own(value, 'set') === 'function'
    && typeof own(value, 'watch') === 'function' && own(value, 'query') != null;
  const scopes = [], committed = new Set();
  const stack = [...roots];
  while (stack.length && committed.size < 14000) {
    const fiber = stack.pop();
    if (!fiber || committed.has(fiber)) continue;
    committed.add(fiber);
    const child = own(fiber, 'child'), sibling = own(fiber, 'sibling');
    if (child) stack.push(child);
    if (sibling) stack.push(sibling);
    let hook = own(fiber, 'memoizedState'), count = 0;
    const seenHooks = new Set();
    while (hook && count++ < 160 && !seenHooks.has(hook)) {
      seenHooks.add(hook);
      const candidate = own(own(hook, 'memoizedState'), 'current');
      if (isScope(candidate) && !scopes.includes(candidate)) scopes.push(candidate);
      hook = own(hook, 'next');
    }
  }
  if (!scopes.length) return result;
  function fiberFor(element) {
    for (const key of Object.getOwnPropertyNames(element || {})) {
      if (!key.startsWith('__reactFiber$')) continue;
      const value = own(element, key);
      if (committed.has(value)) return value;
      const alternate = own(value, 'alternate');
      if (committed.has(alternate)) return alternate;
    }
    return null;
  }
  function nativeElement(element) {
    return element && element.isConnected !== false && container.contains?.(element) && fiberFor(element);
  }
  // Both markers are emitted by the installed native ZIk0 sidebar. No generic
  // aside/main/container fallback is allowed for compatibility UI insertion.
  for (const element of doc.querySelectorAll?.('[data-sidebar-navigation-root], nav[data-app-navigation-rail]') || []) {
    if (nativeElement(element)) { result.sidebar = element; break; }
  }
  for (const element of doc.querySelectorAll?.('[data-sidebar-destination="builtin:skills"], a[href="/plugins"]') || []) {
    if (!nativeElement(element) || !element.closest?.('[data-sidebar-navigation-root], nav[data-app-navigation-rail]')) continue;
    let fiber = fiberFor(element), count = 0;
    while (fiber && committed.has(fiber) && count++ < 14) {
      const props = own(fiber, 'memoizedProps'), item = own(props, 'item');
      if (own(item, 'newTabPath') === '/plugins' || own(props, 'newTabPath') === '/plugins'
          || own(props, 'to') === '/plugins' || own(props, 'href') === '/plugins') {
        result.ui.nativeEntry = element; break;
      }
      fiber = own(fiber, 'return');
    }
    if (result.ui.nativeEntry) break;
  }
  let scope, rpc, accountToken;
  for (const candidate of scopes) {
    let state;
    try { state = candidate.get(connectionSignal, 'local'); } catch { continue; }
    const status = own(state, 'status');
    const client = status === 'ready' ? own(state, 'client')
      : status === 'request-only' ? own(state, 'requestClient') : null;
    const candidateRpc = own(client, 'rpc');
    if (!candidateRpc || typeof candidateRpc.sendRequest !== 'function') continue;
    const candidateAccountToken = cachedAccountToken(candidate);
    if (!candidateAccountToken) continue;
    if (rpc && (candidateRpc !== rpc || candidateAccountToken !== accountToken || candidate.node !== scope.node)) {
      result.error = 'ambiguous-native-local-connection';
      return result;
    }
    scope ||= candidate;
    rpc = candidateRpc;
    accountToken = candidateAccountToken;
  }
  if (!scope || !rpc) { result.error = 'native-local-connection-unavailable'; return result; }
  result.clients = [rpc];
  result.scopeToken = scope.node;
  result.connectionToken = rpc;
  result.accountToken = accountToken;
  result.isCurrent = () => {
    const current = discoverCodexPluginBindings({ module: entry, document: doc });
    return current.scopeToken === scope.node && current.connectionToken === rpc
      && current.accountToken === accountToken;
  };
  result.pending = false;
  if (navigationSignal) {
    let bridge;
    try { bridge = scope.get(navigationSignal); } catch { /* not mounted yet */ }
    if (bridge && typeof own(bridge, 'pathname') === 'string'
        && typeof own(bridge, 'navigate') === 'function'
        && typeof own(bridge, 'prepareNavigation') === 'function') {
      const openMarketplace = () => {
        // Never retain a navigable callback after scope/connection replacement.
        const current = discoverCodexPluginBindings({ module: entry, document: doc });
        if (current.scopeToken !== scope.node || current.connectionToken !== rpc
            || current.accountToken !== accountToken || current.navigation?.token !== bridge
            || !current.sidebar || current.sidebar.isConnected === false) return false;
        const nativeEntry = current.ui.nativeEntry;
        if (nativeEntry && (nativeEntry.disabled || nativeEntry.hidden || nativeEntry.inert
            || nativeEntry.getAttribute?.('aria-disabled') === 'true'
            || nativeEntry.getAttribute?.('aria-hidden') === 'true'
            || nativeEntry.closest?.('[disabled], [aria-disabled="true"], [hidden], [inert], [aria-hidden="true"]'))) return false;
        bridge.navigate('/plugins', { state: { initialHostId: 'local' } });
        return true;
      };
      result.navigation = { token: bridge, openMarketplace };
      if (own(bridge, 'pathname') === '/plugins') {
        for (const element of doc.querySelectorAll?.('input#plugins-store-page-search') || []) {
          const fiber = nativeElement(element), props = own(fiber, 'memoizedProps');
          if (!fiber || own(fiber, 'type') !== 'input'
              || own(props, 'id') !== 'plugins-store-page-search'
              || typeof own(props, 'onChange') !== 'function'
              || element.disabled || element.readOnly || element.hidden || element.inert
              || element.closest?.('[disabled], [aria-disabled="true"], [hidden], [inert], [aria-hidden="true"]')
              || !element.getClientRects?.().length) continue;
          result.ui.search = element; break;
        }
      }
    }
  }
  return result;
}

if (typeof module === 'object' && module?.exports) {
  module.exports = { CODEX_PLUGIN_BINDINGS_VERSION, discoverCodexPluginBindings };
}