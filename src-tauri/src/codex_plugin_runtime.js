/* Official-plugin compatibility never changes authentication or installs plugins. */
var CODEX_PLUGIN_RUNTIME_VERSION = 3;

function installCodexPluginRuntime(options = {}) {
  const previous = window.__gaogeCodexPluginRuntime;
  if (previous?.version === CODEX_PLUGIN_RUNTIME_VERSION && !previous.disposed) {
    previous.configure(options);
    return previous;
  }
  previous?.dispose?.();
  let settings = { ...options };
  let enabled = settings.enabled === true, disposed = false, generation = 0;
  let needsRestart = previous?.status?.().needsRestart === true;
  let reason = enabled ? 'awaiting-native-transport' : 'disabled';
  let nativeListVerified = false, verifiedAt = 0, pluginCount = 0, fallbackUsed = false;
  let lastProbeAt = 0, loading = null, verifying = null, timer = null;
  let moduleError = false;
  let scopeToken = null, connectionToken = null, accountToken = null, bindingCurrent = null, navigation = null, nativeUi = {};
  let entryFailure = '';
  let lastCatalog = null;
  const wrappers = [], clients = new Map();
  const doc = window.document;
  const ttl = 30000;
  const now = () => Date.now();
  function deadline(value) {
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => reject(new Error('native-plugin-timeout')), 3000);
      Promise.resolve(value).then(resolve, reject).finally(() => clearTimeout(id));
    });
  }
  const live = token => !disposed && enabled && !needsRestart && (token == null || token === generation);
  const object = value => value != null && typeof value === 'object' && !Array.isArray(value);
  const methodName = value => value === 'plugin/list' || value === 'list-plugins' ? 'plugin/list' : '';
  const localHost = value => value == null || value === 'local';
  function versionParts(value) {
    return /^\d+(?:\.\d+){2,}$/.test(String(value || '')) ? String(value).split('.').map(Number) : null;
  }
  function compareVersion(a, b) {
    const left = versionParts(a), right = versionParts(b);
    if (!left || !right) return null;
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) < (right[i] || 0) ? -1 : 1;
    }
    return 0;
  }
  function supportedVersion() {
    return compareVersion(settings.appVersion, settings.legacyBeforeVersion || '26.601.2237') >= 0
      && versionParts(settings.appVersion) != null;
  }
  function detectLegacy() {
    // A previous injection may have rewritten React identity and anonymous DOM
    // listeners. Replacing its function pointers cannot undo those mutations.
    return !!(window.__gaogeCodexPluginMarketplaceRuntimeV5
      || window.__gaogePluginMarketplaceFetchPatch
      || Array.prototype.__gaogePluginOriginalFilter
      || window.__gaogePluginMarketplaceRuntimeTimer
      || window.__gaogeCodexPluginFetchPatchInstalled
      || window.__gaogePluginMarketplaceResponseListenerInstalled
      || window.__gaogePluginMarketplaceWindowEventPatch
      || window.__gaogePluginMarketplaceBridgePatch
      || window.fetch?.__gaogePluginMarketplacePatch || window.fetch?.__gaogeCodexPluginFetchPatch
      || Array.prototype.filter.__gaogePluginMarketplacePatch
      || window.electronBridge?.__gaogePluginMarketplaceOriginalSendMessageFromView
      || window.__gaogeCodexAppServerClient?.__gaogePluginMarketplacePatch
      || doc?.querySelector?.('[data-gaoge-plugin-click-spoofed], [data-gaoge-force-plugin-unlocked]'));
  }
  needsRestart ||= detectLegacy();
  function clearEvidence() {
    nativeListVerified = false; verifiedAt = 0; pluginCount = 0; fallbackUsed = false; lastCatalog = null;
  }
  function ensureCurrentBindings() {
    if (!bindingCurrent) return true;
    let current = false;
    try { current = bindingCurrent() === true; } catch { /* unknown identity fails closed */ }
    if (current) return true;
    generation++; clearEvidence(); lastProbeAt = 0; verifying = null;
    bindingCurrent = null; accountToken = null; scopeToken = null; connectionToken = null;
    navigation = null; nativeUi = {};
    removeLegacyCompatEntries(); restoreHooks(record => record.key === 'sendRequest');
    reason = 'native-identity-changed';
    return false;
  }
  function hook(target, key, build) {
    if (!target || typeof target[key] !== 'function') return false;
    const existing = wrappers.find(record => record.target === target && record.key === key);
    if (existing) {
      if (target[key] === existing.wrapper) return true;
      needsRestart = true; clearEvidence(); removeLegacyCompatEntries(); return false;
    }
    const original = target[key], wrapper = build(original);
    try { target[key] = wrapper; } catch { return false; }
    if (target[key] !== wrapper) return false;
    wrappers.push({ target, key, original, wrapper });
    return true;
  }
  function restoreHooks(predicate = () => true) {
    for (let i = wrappers.length - 1; i >= 0; i--) {
      const record = wrappers[i];
      if (!predicate(record)) continue;
      wrappers.splice(i, 1);
      if (record.target[record.key] === record.wrapper) {
        try { record.target[record.key] = record.original; } catch { needsRestart = true; }
        if (record.target[record.key] !== record.original) needsRestart = true;
      } else {
        // A later extension may retain our wrapper. Its client record becomes
        // inactive immediately, but a clean renderer is needed to restore it.
        needsRestart = true;
      }
    }
    for (const [client, record] of clients) {
      if (!predicate({ target: client, key: 'sendRequest' })) continue;
      record.active = false; clients.delete(client);
    }
    if (needsRestart) { clearEvidence(); removeLegacyCompatEntries(); }
  }
  function requestRoute(method, params, hostId) {
    if (!localHost(hostId)) return null;
    if (method === 'send-cli-request-for-host') {
      if (!object(params) || !localHost(params.hostId)) return null;
      return requestRoute(params.method, params.params, params.hostId);
    }
    if (!methodName(method) || !object(params)) return null;
    if (!localHost(params.hostId) || (params.scope != null && params.scope !== 'global') || params.cursor != null
      || params.cwd != null || params.workspaceId != null || (params.cwds != null && (!Array.isArray(params.cwds) || params.cwds.length))) return null;
    const kinds = params.marketplaceKinds;
    if (!Array.isArray(kinds) || kinds.length !== 1 || kinds[0] !== 'local') return null;
    return { method: 'plugin/list', params };
  }
  function validCatalog(value) {
    return object(value) && Array.isArray(value.marketplaces)
      && value.marketplaces.every(market => object(market) && typeof market.name === 'string'
        && market.name.length > 0 && Array.isArray(market.plugins)
        && market.plugins.every(plugin => object(plugin) && (typeof plugin.name === 'string' || typeof plugin.id === 'string')))
      && (value.marketplaceLoadErrors == null || Array.isArray(value.marketplaceLoadErrors))
      && (value.featuredPluginIds == null || Array.isArray(value.featuredPluginIds));
  }
  function snapshotCatalog() {
    let source;
    try { source = typeof settings.localMarketplaces === 'function' ? settings.localMarketplaces() : settings.localMarketplaces; } catch { return null; }
    if (!Array.isArray(source)) return null;
    // Only already-registered local snapshots supplied by our backend are used.
    const marketplaces = source.filter(market => object(market) && typeof market.path === 'string' && market.path.length > 0);
    let result;
    try { result = JSON.parse(JSON.stringify({ marketplaces, featuredPluginIds: [], marketplaceLoadErrors: [] })); } catch { return null; }
    return validCatalog(result) && result.marketplaces.length > 0 ? result : null;
  }
  function pathIdentity(value) {
    if (typeof value !== 'string' || !value || value.includes('\0')) return '';
    let normalized = value.replace(/\\/g, '/');
    const windows = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
    if (normalized.startsWith('//?/UNC/')) normalized = '//' + normalized.slice(8);
    else if (normalized.startsWith('//?/')) normalized = normalized.slice(4);
    if (!(normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized))) return '';
    const pieces = normalized.split('/');
    if (pieces.includes('..') || pieces.includes('.')) return '';
    normalized = normalized.replace(/\/+$/, '');
    return windows ? normalized.toLowerCase() : normalized;
  }
  function registeredMarketsVisible(value) {
    const expected = snapshotCatalog();
    if (!expected) return true;
    // Native D4ZO.KP forwards marketplace.path as marketplacePath. SlNh handles
    // both root and manifest paths; match only explicit backend identities and
    // never infer a root by stripping a suffix or accept a name-only collision.
    return expected.marketplaces.every(market => {
      const paths = [market.path, market.marketplaceRoot].map(pathIdentity).filter(Boolean);
      return paths.length > 0 && value?.marketplaces?.some(native => native.name === market.name
        && !!pathIdentity(native.path) && paths.includes(pathIdentity(native.path)));
    });
  }
  function recordCatalog(value, token) {
    if (!ensureCurrentBindings() || !live(token)) return value;
    if (!validCatalog(value)) {
      clearEvidence(); reason = 'unsupported-native-list-response'; return value;
    }
    if (value.marketplaceLoadErrors?.length) {
      clearEvidence(); reason = 'native-marketplace-load-error'; return value;
    }
    if (!registeredMarketsVisible(value)) {
      clearEvidence(); reason = 'registered-marketplace-not-visible'; return value;
    }
    nativeListVerified = true; verifiedAt = now(); fallbackUsed = false;
    // Keep only identity evidence, not a mutable native response reference.
    lastCatalog = { marketplaces: value.marketplaces.map(market => ({ name: market.name, path: market.path })) };
    pluginCount = value.marketplaces.reduce((sum, market) => sum + market.plugins.length, 0);
    reason = 'native-list-verified';
    return value;
  }
  function bindClient(client, hostId = 'local', probeOnly = false) {
    if (!client || !localHost(hostId)) return false;
    const original = client.sendRequest;
    if (typeof original !== 'function') return false;
    if (!probeOnly && client.__gaogePluginMarketplacePatch) { needsRestart = true; return false; }
    if (clients.has(client)) return true;
    const record = { original, hostId, active: true, wrapped: false };
    clients.set(client, record);
    // Some native facades return a fresh proxy method on each property read.
    // Read-only verification works without assigning properties on such facades.
    if (probeOnly || client.sendRequest !== original) return true;
    record.wrapped = hook(client, 'sendRequest', base => function (method, params, requestOptions) {
      if (!ensureCurrentBindings() || !record.active || !live() || !requestRoute(method, params, hostId)) return base.call(this, method, params, requestOptions);
      const token = generation;
      // Keep native request/auth/scope parameters unchanged. In particular do
      // not convert plugin/install into an authorized request or run it here.
      let request;
      try { request = base.call(this, method, params, requestOptions); } catch (error) {
        if (live(token)) { clearEvidence(); reason = 'native-list-request-failed'; } throw error;
      }
      return Promise.resolve(request).then(
        value => recordCatalog(value, token),
        error => { ensureCurrentBindings();
          // Preserve all native rejections, including remote authentication.
          // A local snapshot must never turn a denied native call into success.
          if (live(token)) { clearEvidence(); reason = 'native-list-request-failed'; } throw error; },
      );
    });
    return true;
  }
  function visible(element) {
    return !!element && element.isConnected !== false && !element.closest?.('[disabled], [aria-disabled="true"], [hidden], [inert], [aria-hidden="true"]')
      && !element.disabled && element.getAttribute?.('aria-disabled') !== 'true'
      && (!element.getClientRects || element.getClientRects().length > 0);
  }
  function removeLegacyCompatEntries() {
    // v2 appended this node to the native navigation rail. Remove only our
    // exact marker; native navigation, layout styles and plugin state stay owned
    // by Codex. This also clears an orphan when its old controller is absent.
    for (const node of doc?.querySelectorAll?.('[data-gaoge-plugin-compat-entry="1"]') || []) node.remove?.();
  }
  removeLegacyCompatEntries();
  function nativeEntries() {
    // Only the bindings' committed sidebar /plugins node is authoritative. A
    // route-looking link inside a conversation must never count as native UI.
    return nativeUi.nativeEntry ? [nativeUi.nativeEntry] : [];
  }
  function uiStatus() {
    const nativeReady = nativeEntries().some(visible);
    return { entryReady: nativeReady,
      entryMode: nativeReady ? 'native-route' : 'unavailable',
      searchReady: visible(nativeUi.search) };
  }
  function reconcileEntry() {
    removeLegacyCompatEntries();
    entryFailure = '';
    if (!live() || accountToken == null || typeof bindingCurrent !== 'function') return;
    const entries = nativeEntries();
    // A disabled native entry remains a native gate. A missing or unmounted
    // entry simply awaits Codex's own UI; never append a substitute to its rail.
    if (!entries.some(visible) && entries.some(entry => entry.disabled || entry.getAttribute?.('aria-disabled') === 'true'
      || entry.closest?.('[disabled], [aria-disabled="true"], [hidden], [inert], [aria-hidden="true"]'))) {
      entryFailure = 'native-plugin-entry-disabled';
    }
  }
  async function openMarketplace() {
    if (!ensureCurrentBindings() || !live()) return false;
    // Re-discover current committed native controls immediately on the click.
    // A newly disabled or missing native entry cannot use a stale navigation callback.
    await refresh();
    if (!ensureCurrentBindings() || !live() || !navigation || typeof navigation.openMarketplace !== 'function' || !uiStatus().entryReady) return false;
    const token = generation, current = navigation;
    try { const opened = await current.openMarketplace(); return opened !== false && live(token) && navigation === current; }
    catch { if (live(token)) entryFailure = 'native-plugin-navigation-failed'; return false; }
  }
  function sameOriginAsset(value) {
    try {
      const base = doc?.baseURI || window.location?.href;
      if (!base) return false;
      const asset = new URL(value, base), page = new URL(base);
      return asset.protocol === page.protocol && asset.host === page.host && asset.pathname.includes('/assets/');
    } catch { return false; }
  }
  function commitBindings(next, token) {
    if (!live(token)) return;
    const found = [...new Set(next.clients || [])];
    const changed = next.scopeToken !== scopeToken || next.connectionToken !== connectionToken || next.accountToken !== accountToken
      || found.length !== clients.size || found.some(client => !clients.has(client));
    if (changed) {
      generation++; clearEvidence(); lastProbeAt = 0; verifying = null;
      restoreHooks(record => record.key === 'sendRequest'); removeLegacyCompatEntries();
    }
    scopeToken = next.scopeToken; connectionToken = next.connectionToken; accountToken = next.accountToken; bindingCurrent = next.isCurrent || null;
    navigation = next.navigation || null; nativeUi = next.ui || {};
    if (live() && ensureCurrentBindings()) for (const client of found) bindClient(client, 'local', next.probeOnly === true);
    if (live()) reconcileEntry();
  }
  async function discover(token) {
    if (!live(token) || typeof settings.loadModule !== 'function') return;
    const next = { clients: [], scopeToken: null, connectionToken: null, complete: false };
    moduleError = false;
    try {
      // Import only already-loaded same-origin modules; never execute arbitrary
      // webpack factories or manufacture an AppScope to get past native gates.
      if (typeof discoverCodexPluginBindings === 'function') {
        for (const script of Array.from(doc?.scripts || [])) {
          const url = String(script.src || '');
          if (!/\/assets\/(?:\d+\.[a-f0-9]+|(?:index|entry)[^/]*)\.js(?:\?.*)?$/.test(url)
            || script.type !== 'module' || !sameOriginAsset(url)) continue;
          const name = url.split('/').pop().split('?')[0];
          if (settings.assetUrl?.(name) !== url) continue;
          const module = await deadline(settings.loadModule(name));
          if (!live(token)) return;
          const bindings = discoverCodexPluginBindings({ module, document: doc });
          if (bindings?.error) { moduleError = true; continue; }
          if (bindings?.pending) continue;
          if (bindings?.scopeToken || bindings?.clients?.length) {
            Object.assign(next, bindings, { complete: true }); break;
          }
        }
      }
    } catch { if (live(token)) moduleError = true; }
    if (!next.scopeToken && next.clients.length) next.scopeToken = next.clients[0];
    if (!next.connectionToken && next.clients.length) next.connectionToken = next.clients[0];
    commitBindings(next, token);
  }
  async function verify() {
    if (!ensureCurrentBindings() || !live() || !supportedVersion()) return status();
    if (verifying) { await verifying; return status(); }
    const pair = clients.entries().next().value;
    if (!pair) return status();
    const [client, record] = pair, token = generation;
    lastProbeAt = now();
    const task = deadline(Promise.resolve().then(() => {
      if (!ensureCurrentBindings() || !record.active || !live(token)) return null;
      return record.original.call(client, 'plugin/list', { marketplaceKinds: ['local'] });
    })).then(
      value => recordCatalog(value, token),
      () => { if (live(token)) { clearEvidence(); reason = 'native-list-request-failed'; } },
    ).finally(() => { if (verifying === task) verifying = null; });
    verifying = task; await task;
    return status();
  }
  async function refresh() {
    if (!live()) return status();
    if (!supportedVersion()) { reason = 'unsupported-codex-version'; return status(); }
    if (!loading) {
      const token = generation;
      loading = discover(token).catch(() => {
        if (live()) { moduleError = true; clearEvidence(); removeLegacyCompatEntries(); reason = 'native-plugin-binding-unavailable'; }
      }).finally(() => { loading = null; });
    }
    await loading;
    if (!live()) return status();
    if (verifying) await verifying;
    else if (clients.size && (!nativeListVerified || now() - verifiedAt > ttl || !status().listVerified) && now() - lastProbeAt >= 5000) await verify();
    return status();
  }
  function status() {
    if (!needsRestart && detectLegacy()) { needsRestart = true; clearEvidence(); }
    ensureCurrentBindings();
    if (live()) for (const record of wrappers) {
      if (record.target[record.key] !== record.wrapper) { needsRestart = true; clearEvidence(); break; }
    }
    if (!live()) removeLegacyCompatEntries();
    const ui = uiStatus(), expectedVisible = registeredMarketsVisible(lastCatalog);
    const verified = nativeListVerified && now() - verifiedAt <= ttl && expectedVisible
      && accountToken != null && typeof bindingCurrent === 'function';
    const applied = !disposed && enabled && clients.size > 0 && !needsRestart;
    const ready = applied && verified && ui.entryReady && !entryFailure;
    let state = disposed ? 'disposed' : !enabled ? 'disabled' : ready ? 'ready' : 'pending';
    let detail = reason;
    if (needsRestart) { state = 'restart-required'; detail = 'legacy-or-replaced-hooks-require-restart'; }
    else if (enabled && !supportedVersion()) { state = 'unsupported'; detail = 'unsupported-codex-version'; }
    else if (enabled && clients.size && (accountToken == null || typeof bindingCurrent !== 'function')) { state = 'unsupported'; detail = 'native-account-epoch-unverified'; }
    else if (enabled && entryFailure) { state = 'unsupported'; detail = entryFailure; }
    else if (enabled && verified && !ui.entryReady) detail = 'awaiting-native-entry';
    else if (enabled && !verified && moduleError && !clients.size) { state = 'unsupported'; detail = 'native-plugin-binding-unavailable'; }
    else if (ready) detail = 'native-plugin-list-and-entry-verified';
    return { version: CODEX_PLUGIN_RUNTIME_VERSION, enabled, configEnabled: enabled, configured: !disposed,
      monitoring: !disposed && timer != null, installed: !disposed,
      disposed, ready, runtimeReady: ready, applied, runtimeInjected: !disposed, state, pending: state === 'pending',
      reason: detail, error: '', needsRestart, nativeListVerified: verified, listVerified: verified,
      entryReady: ui.entryReady, nativeEntryReady: ui.entryReady, entryMode: ui.entryMode, searchReady: ui.searchReady,
      pluginCount: verified ? pluginCount : 0, fallbackUsed, verifiedAt: verified ? verifiedAt : 0,
      transport: clients.size ? 'native-client' : 'none' };
  }
  function configure(next = {}) {
    const changed = Object.prototype.hasOwnProperty.call(next, 'enabled') && (next.enabled === true) !== enabled;
    settings = { ...settings, ...next }; enabled = settings.enabled === true;
    if (changed) { generation++; clearEvidence(); }
    if (!enabled) { removeLegacyCompatEntries(); restoreHooks(); bindingCurrent = null; accountToken = null; navigation = null; nativeUi = {}; reason = 'disabled'; }
    else if (!disposed) { reason = 'awaiting-native-transport'; void refresh(); }
    return status();
  }
  function dispose() {
    if (disposed) return status();
    enabled = false; disposed = true; generation++; clearEvidence();
    if (timer != null) clearInterval(timer);
    removeLegacyCompatEntries(); restoreHooks(); bindingCurrent = null; accountToken = null; scopeToken = null; connectionToken = null; navigation = null; nativeUi = {};
    return status();
  }
  const runtime = { version: CODEX_PLUGIN_RUNTIME_VERSION, get disposed() { return disposed; }, configure, refresh, verify, openMarketplace, status, dispose };
  window.__gaogeCodexPluginRuntime = runtime;
  if (typeof setInterval === 'function') { timer = setInterval(() => { if (live()) void refresh(); }, 2000); timer?.unref?.(); }
  if (enabled) void refresh();
  return runtime;
}
