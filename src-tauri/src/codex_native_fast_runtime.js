// Native Fast integration for the pinned CodexPlusPlus four-gate adapters.
// Load third_party/codex-plus-plus/native-fast-rspack.js and native-fast-unlock.js
// before this file. Prepare modules on the existing page; call installPrepared
// synchronously in Page.addScriptToEvaluateOnNewDocument before HTML parsing.
var CODEX_NATIVE_FAST_RUNTIME_VERSION = 1;

function installCodexNativeFastRuntime(state) {
  const root = typeof window === 'object' ? window : globalThis;
  const previous = root.__gaogeCodexNativeFastRuntime;
  if (previous?.version === CODEX_NATIVE_FAST_RUNTIME_VERSION && !previous.disposed) {
    previous.update(state);
    return previous;
  }
  previous?.dispose?.();
  let current = { enabled: false, localApiConfigured: false };
  let generation = 0;
  let disposed = false;
  let pending = null;
  let reason = 'disabled';
  let prepared = false;
  let installed = false;
  const native = () => root.__codexPlusNativeFastUnlock;
  const ownedHelper = root.__GAOGE_OWNS_NATIVE_FAST_HELPER__ === true ? native() : null;
  let externalPolicy = null;
  const ownAllow = (host, auth) => !disposed && current.enabled && host === 'local'
    && (auth === 'apikey' || auth === 'apiKey' || auth == null && current.localApiConfigured);
  const restoreExternalPolicy = () => {
    if (!externalPolicy) return;
    const { target, allow, status, wrappedAllow, wrappedStatus } = externalPolicy;
    if (target.allow === wrappedAllow) target.allow = allow;
    if (target.status === wrappedStatus) target.status = status;
    externalPolicy = null;
  };
  const syncPolicy = () => {
    const helper = native();
    if (helper === ownedHelper) {
      restoreExternalPolicy();
      helper?.runtime?.update?.({ enhancementsEnabled: current.enabled,
        codexAppNativeFastUnlock: current.enabled, nativeFastLocalApiConfigured: current.localApiConfigured });
      return;
    }
    const target = helper?.runtime;
    if (externalPolicy?.target === target) return;
    restoreExternalPolicy();
    if (typeof target?.allow !== 'function' || typeof target?.status !== 'function') return;
    const allow = target.allow, status = target.status;
    let originalPolicyDepth = 0;
    const wrappedAllow = function (host, auth) {
      let original;
      originalPolicyDepth += 1;
      try { original = allow.call(this, host, auth); }
      finally { originalPolicyDepth -= 1; }
      return original === true || ownAllow(host, auth);
    };
    const wrappedStatus = function () {
      const original = status.call(this);
      return current.enabled && !disposed && originalPolicyDepth === 0 ? { ...original, enabled: true } : original;
    };
    target.allow = wrappedAllow;
    target.status = wrappedStatus;
    externalPolicy = { target, allow, status, wrappedAllow, wrappedStatus };
  };
  const safeReason = value => typeof value === 'string' && /^[a-z0-9:-]{1,120}$/.test(value)
    ? value : 'native-fast-unavailable';
  const compiled = () => root.__codexPlusNativeFastCompiled === 'v1'
    && root.__codexPlusNativeFastPatchState !== 'failed';
  const diagnostics = value => {
    const output = { reason: safeReason(value?.reason), rewriters: {} };
    if (value?.rewriters?.fast != null) output.rewriters.fast = safeReason(value.rewriters.fast);
    if (value?.matches && typeof value.matches === 'object') {
      output.matches = {};
      for (const key of ['ui-access', 'request-access', 'queue-default-access', 'queue-explicit-access']) {
        const count = value.matches[key];
        if (Number.isSafeInteger(count) && count >= 0) output.matches[key] = count;
      }
    }
    return output;
  };
  const failure = value => ({ ok: false, version: CODEX_NATIVE_FAST_RUNTIME_VERSION,
    modules: [], diagnostics: { reason: safeReason(value), rewriters: { fast: safeReason(value) } } });
  const validModule = item => {
    if (!item || typeof item.url !== 'string' || typeof item.patchedSource !== 'string'
      || !item.patchedSource || item.patchedSource.length > 26 * 1024 * 1024) return false;
    try {
      const url = new URL(item.url);
      return url.protocol === 'app:' && url.host === '-' && /^\/assets\/[\w.-]+\.js$/.test(url.pathname)
        && !url.search && !url.hash && !url.username && !url.password;
    } catch (_) { return false; }
  };
  const validModules = modules => Array.isArray(modules) && modules.length >= 1 && modules.length <= 8
    && modules.every(validModule) && new Set(modules.map(item => item.url)).size === modules.length
    && modules.every(item => new TextEncoder().encode(item.patchedSource).byteLength <= 26 * 1024 * 1024)
    && modules.reduce((bytes, item) => bytes + new TextEncoder().encode(item.patchedSource).byteLength, 0) <= 48 * 1024 * 1024
    && modules.some(item => item.patchedSource.includes('window.__codexPlusNativeFastCompiled="v1";'));
  const runtime = {
    version: CODEX_NATIVE_FAST_RUNTIME_VERSION,
    get disposed() { return disposed; },
    update(value) {
      const next = { enabled: value?.enabled === true,
        localApiConfigured: value?.localApiConfigured === true };
      if (next.enabled !== current.enabled || next.localApiConfigured !== current.localApiConfigured) {
        generation += 1;
        prepared = false;
      }
      current = next;
      syncPolicy();
      if (!next.enabled) reason = 'disabled';
      else if (compiled()) reason = 'compiled';
      else if (!native()?.prepareDocumentModules || !root.__codexPlusNativeFastRspack) reason = 'native-runtime-unavailable';
      else if (reason === 'disabled') reason = 'awaiting-restart';
      return runtime.status();
    },
    status() {
      const enabled = !disposed && current.enabled;
      const executed = compiled();
      const failed = root.__codexPlusNativeFastPatchState === 'failed';
      const nativeReason = failed ? safeReason(root.__codexPlusNativeFastModuleDiagnostics?.reason) : reason;
      const activeReason = !enabled ? 'disabled' : executed ? 'compiled' : nativeReason;
      const unsupported = enabled && !executed && (failed || ![
        'awaiting-restart', 'preparing', 'prepared', 'armed', 'disabled',
      ].includes(activeReason));
      const phase = !enabled ? 'disabled' : executed ? 'compiled' : unsupported ? 'unsupported'
        : installed ? 'armed' : prepared ? 'prepared' : activeReason === 'preparing' ? 'preparing' : 'pending';
      return { enabled, ready: enabled && executed, verified: enabled && executed,
        version: CODEX_NATIVE_FAST_RUNTIME_VERSION, compiled: executed, installed,
        phase, reason: activeReason, needsRestart: enabled && !executed && !installed,
        method: 'native-four-gates' };
    },
    async prepare(options) {
      if (disposed || !current.enabled) return failure('disabled');
      if (compiled()) return { ok: true, version: CODEX_NATIVE_FAST_RUNTIME_VERSION,
        alreadyCompiled: true, modules: [], diagnostics: { reason: 'compiled', rewriters: { fast: 'patched' } } };
      if (pending) return pending;
      if (!native()?.prepareDocumentModules || !root.__codexPlusNativeFastRspack) {
        reason = 'native-runtime-unavailable';
        return failure(reason);
      }
      const revision = generation;
      reason = 'preparing';
      pending = (async () => {
        try {
          const result = await native().prepareDocumentModules(options);
          if (disposed || !current.enabled) return failure('disabled');
          if (revision !== generation) { reason = 'awaiting-restart'; return failure('state-changed'); }
          if (result?.ok !== true || result.diagnostics?.rewriters?.fast !== 'patched'
            || !validModules(result.modules)) {
            reason = safeReason(result?.diagnostics?.reason || 'unsupported-modules');
            return { ...failure(reason), diagnostics: diagnostics(result?.diagnostics) };
          }
          reason = 'prepared';
          prepared = true;
          return { ok: true, version: CODEX_NATIVE_FAST_RUNTIME_VERSION,
            modules: result.modules.map(item => ({ url: item.url, patchedSource: item.patchedSource })),
            diagnostics: diagnostics(result.diagnostics) };
        } catch (_) {
          reason = 'module-preparation-failed';
          return failure(reason);
        }
      })().finally(() => { pending = null; });
      return pending;
    },
    installPrepared(value) {
      if (disposed || !current.enabled) return failure('disabled');
      if (compiled()) return { ok: true, alreadyCompiled: true, diagnostics: { reason: 'compiled' } };
      if (!native()?.installModules || value?.ok !== true
        || value.version !== CODEX_NATIVE_FAST_RUNTIME_VERSION
        || value.diagnostics?.rewriters?.fast !== 'patched'
        || !validModules(value.modules)) {
        reason = 'invalid-prepared-modules';
        return failure(reason);
      }
      let result;
      try { result = native().installModules(value.modules, diagnostics(value.diagnostics)); }
      catch (_) { result = { ok: false, diagnostics: { reason: 'module-install-failed' } }; }
      installed = result?.ok === true;
      reason = installed ? 'armed' : safeReason(result?.diagnostics?.reason || 'module-install-failed');
      return { ok: installed, diagnostics: diagnostics(result?.diagnostics) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      if (native() === ownedHelper) native()?.runtime?.update?.({ enhancementsEnabled: false,
        codexAppNativeFastUnlock: false, nativeFastLocalApiConfigured: false });
      restoreExternalPolicy();
      reason = 'disabled';
    },
  };
  root.__gaogeCodexNativeFastRuntime = runtime;
  runtime.update(state);
  return runtime;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { installCodexNativeFastRuntime, CODEX_NATIVE_FAST_RUNTIME_VERSION };
}
