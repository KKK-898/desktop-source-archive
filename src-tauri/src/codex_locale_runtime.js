/* Native Chinese locale adaptation derived from CodexPlusPlus (AGPL-3.0).
 * Upstream: ce1767a1a24ac9dc6b9c0f95bed1648d944c89e1, renderer-inject/00-prelude.js
 * and its native settings adapter in 20-menu.js. See third_party/codex-plus-plus/NOTICE.md.
 * Only the locale setting and the i18n experiment are changed. No page reload,
 * application restart, module factory execution or Navigator prototype mutation.
 */
var CODEX_LOCALE_RUNTIME_VERSION = 1;

function codexLocaleExports(module) {
  if (!module || typeof module !== 'object') return [];
  try {
    const namespace = module[Symbol.toStringTag] === 'Module';
    return Object.keys(module).slice(0, 2000).flatMap(key => {
      const descriptor = Object.getOwnPropertyDescriptor(module, key);
      return descriptor && 'value' in descriptor ? [descriptor.value] : namespace ? [module[key]] : [];
    });
  } catch (_) { return []; }
}

function codexLocaleSettingsFromModule(module) {
  const values = codexLocaleExports(module);
  const hosts = values.filter(value => {
    try { return value && typeof value === 'object'
      && Object.prototype.hasOwnProperty.call(value, 'settings')
      && Object.prototype.hasOwnProperty.call(value, 'applicationState')
      && typeof value.settings?.readAll === 'function' && typeof value.settings?.write === 'function';
    } catch (_) { return false; }
  });
  if (new Set(hosts).size > 1) throw new Error('ambiguous-locale-settings-host');
  if (hosts.length) {
    const settings = hosts[0].settings;
    return { kind: 'host-settings', async read() {
      const all = await settings.readAll();
      if (!all?.values || typeof all.values !== 'object') throw new Error('invalid-locale-settings-response');
      return all.values.localeOverride ?? null;
    }, async write(value) { await settings.write('localeOverride', value); } };
  }
  const stateCalls = values.filter(value => {
    if (typeof value !== 'function') return false;
    const text = Function.prototype.toString.call(value);
    return text.includes('get-global-state') && text.includes('set-global-state') && text.includes('params');
  });
  if (stateCalls.length !== 1) return null;
  const call = stateCalls[0];
  return { kind: 'legacy-state', async read() {
    const response = await call('get-setting', { params: { key: 'localeOverride' } });
    return response && Object.prototype.hasOwnProperty.call(response, 'value') ? response.value ?? null : response ?? null;
  }, async write(value) { await call('set-setting', { params: { key: 'localeOverride', value } }); } };
}

// The reviewed 26.1103 export getters reference already initialized modules.
// Calling webpack require or searching arbitrary RPC proxies is unnecessary.
function codexLocaleSettingsFromRegistry(module) {
  const require = module?.__webpack_require__;
  if (typeof require !== 'function' || !require.c || !require.m) return null;
  const readerModule = require.c.RxZZ?.exports, descriptorModule = require.c.DBCl?.exports;
  if (!readerModule || !descriptorModule) return null;
  const read = readerModule.LA, write = readerModule.cz;
  const setting = descriptorModule.Szl?.localeOverride;
  if (typeof read !== 'function' || typeof write !== 'function' || setting?.key !== 'localeOverride'
      || setting.default !== null) return null;
  const readSource = Function.prototype.toString.call(read), writeSource = Function.prototype.toString.call(write);
  if (!readSource.includes('.appServices') || !readSource.includes('.settings.read(') || !readSource.includes('.effective')
      || !writeSource.includes('.appServices') || !writeSource.includes('.settings.write(')) return null;
  return { kind: 'native-settings', registry: require,
    async read() { return (await read(setting)) ?? null; }, async write(value) { await write(setting, value); } };
}

function codexLocaleEntryUrls() {
  const doc = window.document, here = window.location;
  if (!doc || !here?.href) return [];
  const urls = Array.from(doc.scripts || []).filter(script => script.type === 'module').map(script => script.src).filter(Boolean);
  return [...new Set(urls.filter(address => {
    try {
      const url = new URL(address, here.href), directory = new URL('./assets/', here.href);
      return url.origin === new URL(here.href).origin && url.pathname.startsWith(directory.pathname)
        && !url.pathname.slice(directory.pathname.length).includes('/') && /\/assets\/[\w.-]+\.js$/.test(url.pathname);
    } catch (_) { return false; }
  }))].slice(0, 12);
}

// Exact reviewed compiler and i18n provider contracts for Codex 26.1103.
// These hashes inspect already-loaded factory source; no factory is executed.
var CODEX_LOCALE_RENDERER_CONTRACTS = {
  F0CT: [136, '858fb58ad9bb9c30'], QosV: [32, '126954b56d2d2987'],
  HHvo: [2454, 'f4cc4887313c3e3a'], GrLh: [488, 'e4edddc358bbab4c'],
};
function codexLocaleFunctionMatches(fn, expected) {
  if (typeof fn !== 'function') return false;
  const source = Function.prototype.toString.call(fn);
  if (source.length !== expected[0]) return false;
  let hash = 14695981039346656037n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index)); hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16) === expected[1];
}

function codexLocaleHasNativeEmitter(client) {
  const emitter = client?.$emt, contract = [345, '3e2cf2fa4e2ae983'];
  if (codexLocaleFunctionMatches(emitter, contract)) return true;
  if (typeof emitter !== 'function' || Object.getOwnPropertyDescriptor(emitter, '$EB')?.value !== true
      || Function.prototype.toString.call(emitter) !== '(...i)=>this._capture(t?`${t}:${n}`:n,()=>r.apply(e,i))') return false;
  // Statsig's reviewed ErrorBoundary.wrap keeps the original emitter on the
  // prototype and installs its own tagged wrapper. Call that wrapper normally.
  let prototype = Object.getPrototypeOf(client);
  for (let depth = 0; prototype && depth < 12; depth += 1, prototype = Object.getPrototypeOf(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, '$emt');
    if (descriptor) return codexLocaleFunctionMatches(descriptor.value, contract);
  }
  return false;
}

function createCodexLocaleMemoAdapter(registry, { active, isLayer }) {
  for (const [id, contract] of Object.entries(CODEX_LOCALE_RENDERER_CONTRACTS)) {
    if (!registry.c[id]?.exports || !codexLocaleFunctionMatches(registry.m[id], contract)) return null;
  }
  const exports = registry.c.F0CT.exports;
  if (registry.c.QosV.exports !== exports) return null;
  const original = exports.c, descriptor = Object.getOwnPropertyDescriptor(exports, 'c');
  const provider = registry.c.GrLh.exports.t;
  if (typeof original !== 'function' || !descriptor?.writable || typeof provider !== 'function'
      || Function.prototype.toString.call(original) !== 'function(e){return r.H.useMemoCache(e)}') return null;
  const caches = new Set(); let disposed = false;
  const valid = cache => Array.isArray(cache) && cache.length === 30 && isLayer(cache[0]) && typeof cache[1] === 'boolean';
  const wrapped = function(size) {
    const cache = Reflect.apply(original, this, [size]);
    if (!disposed && active() && size === 30 && valid(cache)) {
      if (caches.size < 32) caches.add(cache);
      // In the reviewed HHvo.E only slots 0/1 hold this Layer dependency.
      // Clear that dependency solely when its own value is stale.
      try { if (cache[1] !== cache[0].get('enable_i18n', false)) cache[0] = null; } catch (_) { /* Keep native memo intact. */ }
    }
    return cache;
  };
  exports.c = wrapped;
  if (exports.c !== wrapped) return null;
  return {
    registry,
    uiReady() {
      if (disposed || !active()) return false;
      return [...caches].some(cache => {
        if (!valid(cache) || cache[1] !== true || cache[28] !== 'zh-CN') return false;
        const messages = cache[27], element = cache[29];
        return messages && typeof messages === 'object' && !Array.isArray(messages) && Object.keys(messages).length > 0
          && element?.type === provider && element.props?.locale === 'zh-CN' && element.props?.messages === messages;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Release only the known i18n memo dependency after gate restoration.
      for (const cache of caches) {
        try { if (valid(cache) && cache[1] !== cache[0].get('enable_i18n', false)) cache[0] = null; } catch (_) {}
      }
      if (exports.c === wrapped) exports.c = original;
    },
  };
}

function installCodexLocaleRuntime(initialOptions = {}) {
  const previous = window.__gaogeCodexLocaleRuntime;
  if (previous?.version === CODEX_LOCALE_RUNTIME_VERSION && !previous.disposed) {
    previous.update(initialOptions);
    return previous;
  }
  previous?.dispose?.();
  let options = { ...initialOptions }, enabled = options.enabled === true, revision = String(options.revision || '');
  let disposed = false, generation = 0, attempts = 0, retryTimer = null, inflight = null, lastAttempt = 0;
  let localeApplied = false, gateReady = false, needsRestart = enabled, reason = 'awaiting-native-settings', error = '', adapterKind = '';
  const locale = 'zh-CN', storageKey = 'gaoge.forceChineseLocale.managed.v1';
  const retryDelays = [500, 1500, 3000, 6000, 12000, 20000];
  const repairs = [];
  let seenConfigs = new WeakSet(), seenClients = new WeakSet(), seenRoots = new WeakSet();
  let localeLayers = new WeakSet(), nativeMemo = null;
  const localeClients = new Set(), notified = new WeakMap();
  const shared = window.__gaogeCodexLocaleWorkQueue || (window.__gaogeCodexLocaleWorkQueue = { pending: Promise.resolve() });
  const active = () => enabled && !disposed;
  const current = token => !disposed && token === generation;
  const own = (object, key) => Object.getOwnPropertyDescriptor(object, key);

  function replace(object, key, replacement) {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return false;
    let before;
    try {
      before = own(object, key);
      if (before && !before.configurable && (!('value' in before) || !before.writable)) return false;
      Object.defineProperty(object, key, { configurable: before?.configurable ?? true, enumerable: before?.enumerable ?? true,
        writable: before?.writable ?? true, value: replacement });
      repairs.push(() => {
        if (own(object, key)?.value !== replacement) return;
        if (before) Object.defineProperty(object, key, before); else delete object[key];
      });
      return object[key] === replacement;
    } catch (_) { return false; }
  }

  function patchConfig(config, layer = false) {
    if (!config || typeof config !== 'object') return config;
    if (layer) localeLayers.add(config);
    if (seenConfigs.has(config)) {
      try { if (layer && config.get?.('enable_i18n', false) === true) gateReady = true; } catch (_) {}
      return config;
    }
    seenConfigs.add(config);
    const originalGet = config.get;
    if (typeof originalGet === 'function') {
      replace(config, 'get', function(key, fallback) {
        if (active() && key === 'enable_i18n') return true;
        if (active() && key === 'locale_source') return 'SYSTEM';
        return Reflect.apply(originalGet, this, [key, fallback]);
      });
    }
    for (const key of ['value', '__value']) {
      const value = config[key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const patched = { ...value, enable_i18n: true, locale_source: 'SYSTEM' };
      const before = own(config, key);
      try {
        if (before && !before.configurable && (!('value' in before) || !before.writable)) continue;
        Object.defineProperty(config, key, { configurable: before?.configurable ?? true, enumerable: before?.enumerable ?? true,
          writable: before?.writable ?? true, value: patched });
        repairs.push(() => {
          if (config[key] !== patched) return;
          const restored = { ...patched };
          for (const field of ['enable_i18n', 'locale_source']) {
            const forced = field === 'enable_i18n' ? true : 'SYSTEM';
            if (restored[field] !== forced) continue;
            if (Object.prototype.hasOwnProperty.call(value, field)) restored[field] = value[field]; else delete restored[field];
          }
          if (before) Object.defineProperty(config, key, 'value' in before ? { ...before, value: restored } : before); else delete config[key];
        });
      } catch (_) { /* Read-only raw values still use the wrapped getter. */ }
    }
    try { if (layer && config.get?.('enable_i18n', false) === true) gateReady = true; } catch (_) {}
    return config;
  }

  function patchClient(client) {
    if (!active() || !client || typeof client !== 'object') return;
    if (localeClients.size < 100) localeClients.add(client);
    if (!seenClients.has(client)) {
      seenClients.add(client);
      for (const key of ['getLayer', '_getLayerImpl', 'getDynamicConfig']) {
        const original = client[key];
        if (typeof original !== 'function') continue;
        replace(client, key, function(name, ...args) {
          const result = Reflect.apply(original, this, [name, ...args]);
          return active() && String(name) === '72216192' ? patchConfig(result, key !== 'getDynamicConfig') : result;
        });
      }
    }
    for (const key of ['getLayer', 'getDynamicConfig']) {
      try { if (typeof client[key] === 'function') patchConfig(client[key]('72216192', { disableExposureLog: true }), key === 'getLayer'); } catch (_) {}
    }
  }

  function watchValue(object, key, onValue) {
    let before, value, assigned = false;
    try {
      before = own(object, key);
      if (before && (!before.configurable || !('value' in before))) { onValue(object[key]); return; }
      value = object[key]; onValue(value);
      const get = () => value;
      const set = next => { assigned = true; value = next; onValue(next); };
      Object.defineProperty(object, key, { configurable: true, enumerable: before?.enumerable ?? true, get, set });
      repairs.push(() => {
        const descriptor = own(object, key);
        if (descriptor?.get !== get || descriptor?.set !== set) return;
        if (before) Object.defineProperty(object, key, { ...before, value });
        else if (assigned) Object.defineProperty(object, key, { configurable: true, writable: true, enumerable: true, value });
        else delete object[key];
      });
    } catch (_) {}
  }

  function patchRoot(root) {
    if (!active() || !root || typeof root !== 'object') return;
    if (!seenRoots.has(root)) {
      seenRoots.add(root);
      watchValue(root, 'firstInstance', patchClient);
      watchValue(root, 'instance', value => {
        try { patchClient(typeof value === 'function' ? value.call(root) : value); } catch (_) {}
      });
    }
    patchClient(root.firstInstance);
    try { patchClient(typeof root.instance === 'function' ? root.instance() : root.instance); } catch (_) {}
    for (const client of Object.values(root.instances || {}).slice(0, 100)) patchClient(client);
  }

  let gatesInstalled = false;
  function installGates() {
    if (!active()) return;
    if (!gatesInstalled) {
      gatesInstalled = true;
      watchValue(window, '__STATSIG__', patchRoot);
      // A page-local override is sufficient; never modify Navigator.prototype.
      const navigator = window.navigator;
      if (navigator) {
        replace(navigator, 'language', locale);
        replace(navigator, 'languages', [locale, 'zh', 'en-US', 'en']);
      }
    }
    patchRoot(window.__STATSIG__);
  }

  function notifyNativeLocale(phase) {
    for (const client of localeClients) {
      if (notified.get(client) === phase || !codexLocaleHasNativeEmitter(client)) continue;
      notified.set(client, phase);
      try { client.$emt({ name: 'values_updated', status: client.loadingStatus }); } catch (_) {}
    }
  }

  function installNativeMemo(registry) {
    if (!registry || nativeMemo?.registry === registry) return;
    nativeMemo?.dispose();
    nativeMemo = createCodexLocaleMemoAdapter(registry, { active, isLayer: value => localeLayers.has(value) });
  }

  function releaseGates() {
    while (repairs.length) { try { repairs.pop()(); } catch (_) {} }
    nativeMemo?.dispose(); nativeMemo = null;
    notifyNativeLocale('off:' + generation);
    gatesInstalled = false; gateReady = false;
    localeLayers = new WeakSet();
    seenConfigs = new WeakSet(); seenClients = new WeakSet(); seenRoots = new WeakSet();
  }

  function readManaged() {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    let value;
    try { value = JSON.parse(raw); } catch (_) { throw new Error('invalid-locale-restore-record'); }
    if (value?.version !== 1 || value.appliedLocale !== locale
        || !(value.previousValue === null || typeof value.previousValue === 'string')) throw new Error('invalid-locale-restore-record');
    return value;
  }
  function saveManaged(value) {
    if (!value) { window.localStorage.removeItem(storageKey); return; }
    const serialized = JSON.stringify(value);
    window.localStorage.setItem(storageKey, serialized);
    if (window.localStorage.getItem(storageKey) !== serialized) throw new Error('locale-restore-storage-unavailable');
  }
  const validLocale = value => value === null || (typeof value === 'string' && value.length <= 80);
  async function deadline(operation) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('locale-settings-timeout')), 3500);
    })]); } finally { window.clearTimeout(timer); }
  }

  async function discover() {
    if (typeof options.loadModule !== 'function' || typeof options.assetUrl !== 'function') throw new Error('locale-module-loader-unavailable');
    const candidates = [], registries = new Set();
    for (const url of codexLocaleEntryUrls()) {
      const name = new URL(url).pathname.split('/').pop();
      if (options.assetUrl(name) !== url) continue;
      const module = await deadline(() => options.loadModule(name));
      const adapter = codexLocaleSettingsFromRegistry(module);
      if (adapter && !registries.has(adapter.registry)) { registries.add(adapter.registry); candidates.push(adapter); }
    }
    if (candidates.length > 1) throw new Error('ambiguous-locale-application');
    if (candidates.length) return candidates[0];
    let legacy = null;
    for (const name of ['app-shared-', 'app-initial-', 'vscode-api-']) {
      if (!options.assetUrl(name)) continue;
      const module = await deadline(() => options.loadModule(name));
      const adapter = codexLocaleSettingsFromModule(module);
      if (adapter?.kind === 'host-settings') return adapter;
      legacy ||= adapter;
    }
    if (legacy) return legacy;
    throw new Error('native-locale-settings-unavailable');
  }

  async function synchronize(token) {
    if (!current(token)) return;
    installGates();
    const managed = readManaged();
    if (!enabled && !managed) { localeApplied = false; reason = 'disabled'; error = ''; return; }
    const adapter = await discover();
    if (!current(token)) return;
    adapterKind = adapter.kind;
    if (enabled) installNativeMemo(adapter.registry);
    const before = await deadline(() => adapter.read());
    if (!current(token)) return;
    if (!validLocale(before)) throw new Error('invalid-native-locale');
    if (enabled) {
      if (before !== locale) {
        saveManaged({ version: 1, appliedLocale: locale, previousValue: before });
        if (!current(token)) return;
        // Do not deadline an irreversible write: a late successful write must
        // finish before a queued disable restores the previous language.
        await adapter.write(locale);
        if (!current(token)) return;
        needsRestart = true;
      }
      const verified = await deadline(() => adapter.read()) === locale;
      if (!current(token)) return;
      localeApplied = verified;
      if (!localeApplied) throw new Error('native-locale-write-unverified');
      installGates();
      // A successful setting write and a patched Layer do not prove that
      // React's earlier memoized translation messages have been reloaded.
      if (nativeMemo) notifyNativeLocale('on:' + generation);
      needsRestart = !nativeMemo?.uiReady();
      reason = gateReady ? (needsRestart ? 'restart-required' : 'active') : 'awaiting-i18n-gate';
    } else {
      if (before === managed.appliedLocale) {
        await adapter.write(managed.previousValue);
        if (!current(token)) return;
        if (await deadline(() => adapter.read()) !== managed.previousValue) throw new Error('locale-restore-unverified');
        if (!current(token)) return;
        needsRestart = true;
      }
      saveManaged(null); localeApplied = false; reason = 'disabled';
    }
    error = '';
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    if (inflight) return inflight;
    const token = generation;
    lastAttempt = Date.now();
    attempts += 1;
    const work = Promise.resolve(shared.pending).catch(() => {}).then(() => synchronize(token));
    shared.pending = work.catch(() => {});
    inflight = work.catch(failure => {
      if (!current(token)) return;
      error = String(failure?.message || failure); reason = 'native-locale-pending';
      localeApplied = false;
    }).finally(() => {
      inflight = null;
      if (!current(token)) { if (!disposed) void refresh(); return; }
      if ((error || enabled && !gateReady) && attempts <= retryDelays.length) {
        retryTimer = window.setTimeout(() => { retryTimer = null; void refresh(); }, retryDelays[attempts - 1]);
      }
    });
    return inflight;
  }

  const runtime = {
    version: CODEX_LOCALE_RUNTIME_VERSION,
    get disposed() { return disposed; },
    status() {
      const configured = localeApplied && gateReady;
      const uiReady = enabled && configured && !!nativeMemo?.uiReady();
      if (enabled) needsRestart = !uiReady;
      if (uiReady) reason = 'active';
      else if (enabled && configured && nativeMemo) reason = 'awaiting-native-messages';
      return { version: CODEX_LOCALE_RUNTIME_VERSION, disposed, enabled, ready: enabled ? uiReady : !error && reason === 'disabled',
        configured, uiReady, localeApplied, gateReady, needsRestart, reason, error, adapter: adapterKind, attempts };
    },
    refresh,
    ensure() {
      if (!disposed && !inflight && !retryTimer && (error || enabled && (!localeApplied || !gateReady || !nativeMemo || !nativeMemo.uiReady()))
          && Date.now() - lastAttempt >= 15000) void refresh();
      return runtime;
    },
    update(next = {}) {
      const older = /^(.*):(\d+)$/.exec(revision), incoming = /^(.*):(\d+)$/.exec(String(next.revision || revision));
      if (older && incoming && older[1] === incoming[1] && BigInt(incoming[2]) < BigInt(older[2])) return runtime;
      options = { ...options, ...next };
      const nextEnabled = options.enabled === true, nextRevision = String(options.revision || '');
      if (nextEnabled === enabled && nextRevision === revision) return runtime;
      enabled = nextEnabled; revision = nextRevision; generation += 1; attempts = 0;
      window.clearTimeout(retryTimer); retryTimer = null;
      localeApplied = false; error = ''; reason = enabled ? 'awaiting-native-settings' : 'restoring-locale';
      if (!enabled) releaseGates();
      void refresh();
      return runtime;
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation += 1;
      window.clearTimeout(retryTimer); retryTimer = null; releaseGates();
    },
  };
  window.__gaogeCodexLocaleRuntime = runtime;
  void refresh();
  return runtime;
}

if (typeof module === 'object' && module?.exports) {
  module.exports = { CODEX_LOCALE_RUNTIME_VERSION, codexLocaleSettingsFromModule, codexLocaleSettingsFromRegistry,
    CODEX_LOCALE_RENDERER_CONTRACTS, codexLocaleFunctionMatches, codexLocaleHasNativeEmitter, createCodexLocaleMemoAdapter,
    codexLocaleEntryUrls, installCodexLocaleRuntime };
}
