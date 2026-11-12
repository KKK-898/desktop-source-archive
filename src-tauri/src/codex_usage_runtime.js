// Local relay presentation adapter. Never alter account identity or usage.
function codexUsageMainQuery(key) {
  return Array.isArray(key) && key[0] === 'rate-limit-status'
    && (key.length === 1 || (key.length === 3 && key[1] !== 'image-generation'
      && key.slice(1).every(part => part == null || typeof part === 'string')));
}

function codexUsageUnlocked(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const usage = value.usage && typeof value.usage === 'object' ? value.usage : value;
  const limit = usage.rate_limit;
  if (!limit || typeof limit.allowed !== 'boolean'
      || ![usage.plan_type, usage.user_id, usage.account_id].some(item => typeof item === 'string')) return value;
  if (limit.allowed === true && limit.limit_reached !== true) return value;
  const next = { ...usage, rate_limit: { ...limit, allowed: true, limit_reached: false } };
  return usage === value ? next : { ...value, usage: next };
}

function createCodexUsageCacheAdapter({ getPolicy, now = Date.now }) {
  let disposed = false;
  let writes = 0;
  let homeRetries = 0;
  let homeGeneration = 0;
  let homeEnabled = false;
  let homeFailure = '';
  const failures = new Map();
  const candidates = new Set();
  const clients = new Map();
  const originals = new WeakMap();
  let homeReads = new WeakMap();
  const stats = { publications: 0, unlocks: 0, restores: 0, repairs: 0 };
  const policy = () => {
    if (disposed) return { enabled: false, reason: 'disposed' };
    try { return getPolicy() || { enabled: false, reason: 'route-unavailable' }; }
    catch (_) { return { enabled: false, reason: 'route-check-failed' }; }
  };
  const rawValue = value => value && typeof value === 'object' ? originals.get(value) || value : value;
  function remember(value, raw) {
    if (!value || typeof value !== 'object') return;
    if (value !== raw) originals.set(value, raw); else originals.delete(value);
  }
  function replaceMethod(object, name, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    Object.defineProperty(object, name, { configurable: true, writable: true, value: replacement });
    return () => {
      if (object[name] !== replacement) return;
      if (descriptor) Object.defineProperty(object, name, descriptor); else delete object[name];
    };
  }
  function track(entry, query) {
    if (!codexUsageMainQuery(query?.queryKey)) return null;
    if (typeof query.setData !== 'function') throw new Error('Usage query publisher unavailable');
    const priorRecord = entry.queries.get(query);
    if (priorRecord?.publish === query.setData) return priorRecord;
    if (priorRecord) { priorRecord.restore(); stats.repairs += 1; }
    const original = query.setData;
    const record = { raw: query.state?.data, frame: null, revision: 0, restore: null };
    function publish(data, ...args) {
      // A replacement may delegate to the old wrapper. Make superseded wrappers
      // transparent, so repair never nests active projections or subscriptions.
      if (disposed || entry.queries.get(query) !== record || this !== query
          || !codexUsageMainQuery(this.queryKey)) return original.call(this, data, ...args);
      const raw = rawValue(data);
      const next = policy().enabled === true ? codexUsageUnlocked(raw) : raw;
      const prior = record.raw;
      const frame = { raw, parent: record.frame };
      const revision = ++record.revision;
      record.frame = frame;
      record.raw = raw;
      remember(next, raw);
      writes += 1;
      try {
        const stored = original.call(this, next, ...args);
        // Structural sharing may return a new object; nested subscribers may
        // already have installed a newer account response before this returns.
        if (record.revision === revision) {
          record.raw = frame.raw;
          // A native cache may structurally clone an unmodified/restored value.
          // That clone is not an active quota projection.
          remember(stored, next !== raw ? frame.raw : stored);
          remember(query.state?.data, next !== raw ? frame.raw : query.state?.data);
        }
        for (let parent = frame.parent; parent; parent = parent.parent) parent.raw = record.raw;
        stats.publications += 1;
        if (next !== raw) stats.unlocks += 1;
        return stored;
      } catch (error) {
        if (record.revision === revision) record.raw = prior;
        throw error;
      } finally { record.frame = frame.parent; writes -= 1; }
    }
    record.publish = publish;
    record.restore = replaceMethod(query, 'setData', publish);
    entry.queries.set(query, record);
    return record;
  }
  function syncQuery(entry, query) {
    if (!track(entry, query)) return;
    const current = query.state?.data;
    const raw = rawValue(current);
    const next = policy().enabled === true ? codexUsageUnlocked(raw) : raw;
    const before = current?.usage || current;
    const after = next?.usage || next;
    if (next === current || (next !== raw && before?.rate_limit?.allowed === true
        && before?.rate_limit?.limit_reached === false && originals.has(current))) return;
    if (before?.rate_limit?.allowed === after?.rate_limit?.allowed
        && before?.rate_limit?.limit_reached === after?.rate_limit?.limit_reached) return;
    query.setData(raw, { manual: true, updatedAt: query.state?.dataUpdatedAt });
    if (next === raw) stats.restores += 1;
  }
  function recoverHome(client, cache) {
    if (!(policy().enabled === true || policy().recoverHome === true) || typeof client.cancelQueries !== 'function'
        || typeof client.refetchQueries !== 'function') return;
    const queries = cache.getAll();
    const blocked = queries.some(query => {
      const key = query.queryKey;
      return Array.isArray(key) && key[0] === 'git' && key[1] === 'local'
        && key[2] === 'managed-worktree-state' && key[3] === 'codex-home-loading'
        && query.getObserversCount?.() > 0;
    });
    if (!blocked) return;
    for (const query of queries) {
      const key = query.queryKey;
      if (!Array.isArray(key) || key[0] !== 'vscode' || key[1] !== 'codex-home'
          || ![2, 3].includes(key.length)) continue;
      if (key.length === 3) {
        let target;
        try { target = JSON.parse(key[2]); } catch (_) { continue; }
        if (!target || Array.isArray(target) || typeof target !== 'object'
            || (target.hostId != null && target.hostId !== 'local')) continue;
      }
      if (query.state?.data != null || query.state?.status !== 'pending') { homeReads.delete(query); continue; }
      if (query.state?.fetchStatus !== 'fetching' || query.isActive?.() !== true) continue;
      let pending = homeReads.get(query);
      if (!pending) { pending = { since: now(), attempts: 0, busy: false }; homeReads.set(query, pending); }
      if (pending.busy || pending.attempts >= 2 || now() - pending.since < 10000) continue;
      pending.busy = true; pending.attempts += 1; pending.since = now();
      const generation = homeGeneration;
      const filter = { queryKey: key, exact: true };
      Promise.resolve().then(async () => {
        if (disposed || generation !== homeGeneration || !(policy().enabled === true || policy().recoverHome === true)) return;
        homeRetries += 1;
        await client.cancelQueries(filter);
        // Complete any cancellation we started even if the route changes.
        Promise.resolve(client.refetchQueries(filter)).catch(() => {});
        homeFailure = '';
      }).catch(() => { homeFailure = 'home-query-retry-failed'; }).finally(() => { pending.busy = false; });
    }
  }
  function hookClient(client, entry) {
    if (client.setQueryData === entry.publishClient) return;
    if (entry.restoreClient) { entry.restoreClient(); stats.repairs += 1; }
    if (typeof client.setQueryData !== 'function') throw new Error('Usage client publisher unavailable');
    const original = client.setQueryData;
    const publish = function (key, updater, ...args) {
      if (disposed || entry.publishClient !== publish || !codexUsageMainQuery(key)
          || typeof updater !== 'function') return original.call(this, key, updater, ...args);
      return original.call(this, key, previous => {
        const query = entry.cache.find?.({ queryKey: key, exact: true });
        const record = entry.queries.get(query);
        return updater(record?.frame ? record.frame.raw : rawValue(previous));
      }, ...args);
    };
    entry.restoreClient = replaceMethod(client, 'setQueryData', publish);
    entry.publishClient = publish;
  }
  function detach(client, entry) {
    entry.unsubscribe?.(); entry.unsubscribe = null;
    entry.restoreClient?.(); entry.publishClient = null;
    const records = Array.from(entry.queries);
    entry.queries.clear(); clients.delete(client);
    for (const [query, record] of records) {
      const current = query.state?.data;
      const raw = rawValue(current);
      record.restore();
      if (raw !== current) {
        try { query.setData(raw, { manual: true, updatedAt: query.state?.dataUpdatedAt }); } catch (_) {}
      }
    }
  }
  function attach(client) {
    if (disposed || !client || typeof client.getQueryCache !== 'function'
        || !candidates.has(client) && typeof client.setQueryData !== 'function') return;
    candidates.add(client);
    let entry = clients.get(client);
    try {
      const cache = client.getQueryCache();
      if (typeof cache?.getAll !== 'function' || typeof cache.subscribe !== 'function') {
        throw new Error('Usage query cache unavailable');
      }
      if (entry?.cache === cache) { hookClient(client, entry); return; }
      if (entry) { detach(client, entry); stats.repairs += 1; }
      entry = { cache, queries: new Map(), unsubscribe: null, restoreClient: null, publishClient: null };
      hookClient(client, entry);
      entry.unsubscribe = cache.subscribe(event => {
        try {
          if (event?.type === 'removed') {
            entry.queries.get(event.query)?.restore(); entry.queries.delete(event.query);
          } else if (event?.query) {
            track(entry, event.query);
            if (!writes) syncQuery(entry, event.query);
          }
        } catch (_) { failures.set(client, 'usage-query-observer-failed'); }
      });
      clients.set(client, entry);
      for (const query of cache.getAll()) syncQuery(entry, query);
      failures.delete(client);
    } catch (_) {
      if (entry) detach(client, entry);
      failures.set(client, 'usage-query-hook-failed');
    }
  }
  function refresh() {
    const current = policy();
    const enabled = current.enabled === true || current.recoverHome === true;
    if (enabled !== homeEnabled) {
      homeEnabled = enabled; homeGeneration += 1; homeReads = new WeakMap();
    }
    for (const client of candidates) {
      attach(client);
      const entry = clients.get(client);
      if (!entry) continue;
      try {
        for (const query of entry.cache.getAll()) syncQuery(entry, query);
        recoverHome(client, entry.cache);
        failures.delete(client);
      } catch (_) { failures.set(client, 'usage-query-refresh-failed'); }
    }
  }
  return {
    attach, refresh,
    get status() {
      const current = policy();
      let queries = 0; let unlocked = 0; let supported = 0;
      let integrity = !disposed;
      for (const [client, entry] of clients) {
        try {
          if (client.getQueryCache() !== entry.cache || client.setQueryData !== entry.publishClient
              || Array.from(entry.queries).some(([query, record]) => query.setData !== record.publish)) integrity = false;
        } catch (_) { integrity = false; }
      }
      for (const entry of clients.values()) for (const query of entry.queries.keys()) {
        queries += 1;
        const value = query.state?.data;
        const sample = value?.usage || value;
        if (typeof sample?.rate_limit?.allowed === 'boolean'
            && [sample.plan_type, sample.user_id, sample.account_id].some(item => typeof item === 'string')) supported += 1;
        if (value && originals.has(value)) unlocked += 1;
      }
      const error = failures.values().next().value || '';
      return { installed: clients.size > 0, enabled: current.enabled === true,
        healthy: integrity && !error, needsRepair: !integrity || !!error,
        reason: current.reason || 'route-unavailable', queries, supported, unlocked, homeRetries,
        visibleComposers: current.visibleComposers ?? 0, visibleEditors: current.visibleEditors ?? 0,
        hiddenEditors: current.hiddenEditors ?? 0, unresolvedEditors: current.unresolvedEditors ?? 0,
        ...stats, error, homeError: homeFailure };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [client, entry] of Array.from(clients)) detach(client, entry);
      candidates.clear(); failures.clear();
    },
  };
}

// Usage queries are shared by a window. Only mounted, visible composers may
// authorize their projection; a retained home composer must not veto a thread.
function codexUsageVisibleEditor(element) {
  if (!element?.isConnected || !element.getClientRects?.().length
      || element.closest?.('[hidden],[inert],[aria-hidden="true"]')) return false;
  if (typeof element.checkVisibility === 'function'
      && !element.checkVisibility({ checkVisibilityCSS: true })) return false;
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  return !style || (style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility));
}

function codexUsageCommittedPath(element) {
  const key = Object.keys(element).find(name => name.startsWith('__reactFiber$')
    || name.startsWith('__reactInternalInstance$'));
  const host = key && element[key];
  if (!host) return null;
  // A DOM fiber pointer can reference either alternate after a commit. Follow
  // actual child edges to root.current, including shared bailout children.
  // Never authorize from pendingProps or a stale alternate's context.
  const pending = [host, host.alternate].filter(Boolean).map(fiber => [fiber]);
  const seen = new Set();
  while (pending.length && seen.size < 240) {
    const path = pending.pop();
    const fiber = path[path.length - 1];
    if (seen.has(fiber) || path.length > 120) continue;
    seen.add(fiber);
    if (!fiber.return) {
      if (fiber.stateNode?.current === fiber) return path;
      continue;
    }
    for (const parent of [fiber.return, fiber.return.alternate]) {
      if (!parent || seen.has(parent)) continue;
      let child = parent.child;
      for (let count = 0; child && count < 4096; count += 1, child = child.sibling) {
        if (child === fiber) { pending.push([...path, parent]); break; }
      }
    }
  }
  return null;
}

function codexUsageFindComposers() {
  const contexts = new Map();
  let visibleEditors = 0; let hiddenEditors = 0; let unresolvedEditors = 0;
  const elements = Array.from(document.querySelectorAll('[contenteditable="true"],textarea'));
  for (const element of elements.slice(0, 80)) {
    if (!codexUsageVisibleEditor(element)) { hiddenEditors += 1; continue; }
    visibleEditors += 1;
    const path = codexUsageCommittedPath(element);
    let found = false;
    for (const fiber of path || []) {
      const candidates = new Map();
      const inspect = value => {
        const chain = value instanceof Map ? value : value?.chain;
        const node = codexFuelContextNode(chain);
        if (node) candidates.set(node, chain);
      };
      inspect(fiber.memoizedProps?.value);
      for (let dep = fiber.dependencies?.firstContext, i = 0; dep && i < 20; dep = dep.next, i += 1) inspect(dep.memoizedValue);
      for (let hook = fiber.memoizedState, i = 0; hook && i < 12; hook = hook.next, i += 1) inspect(hook.memoizedState);
      if (!candidates.size) continue;
      if (candidates.size === 1) {
        const [node, chain] = candidates.entries().next().value;
        contexts.set(node, chain); found = true;
      }
      // The closest provider owns the editor. Ambiguity must not fall back to
      // a less specific ancestor from a different conversation.
      break;
    }
    if (!found) unresolvedEditors += 1;
  }
  if (elements.length > 80) unresolvedEditors += 1;
  return { contexts: Array.from(contexts.values()), visibleEditors, hiddenEditors, unresolvedEditors };
}

function codexUsageVisiblePolicy(bindings, state, managers, forceRelayGlobal = false) {
  if (forceRelayGlobal === true && codexFuelStateEnabled(state)) {
    return { visibleComposers: 0, visibleEditors: 0, hiddenEditors: 0, unresolvedEditors: 0,
      enabled: true, reason: 'relay-global-forced', recoverHome: true };
  }
  const selection = codexUsageFindComposers();
  const detail = { visibleComposers: selection.contexts.length, visibleEditors: selection.visibleEditors,
    hiddenEditors: selection.hiddenEditors, unresolvedEditors: selection.unresolvedEditors };
  if (!codexFuelStateEnabled(state)) return { ...detail, enabled: false, reason: 'relay-off' };
  if (selection.unresolvedEditors) return { ...detail, enabled: false, reason: 'visible-composer-unresolved' };
  if (!selection.contexts.length) return { ...detail, enabled: false, reason: 'visible-composer-unavailable' };
  // All visible consumers of the shared cache must agree. A split view with
  // an official/cloud/remote composer cannot borrow the local relay's quota.
  return { ...detail, ...codexUsagePolicy(selection.contexts, bindings, state, managers) };
}

function codexUsagePolicy(contexts, bindings, state, managers = []) {
  const deny = (reason, recoverHome = false) => ({ enabled: false, reason, recoverHome });
  if (!codexFuelStateEnabled(state)) return deny('relay-off');
  let local = 0;
  let verified = 0;
  for (const chain of contexts) {
    const node = codexFuelContextNode(chain);
    if (!node) continue;
    const value = node.value;
    if (!['local', 'new', 'chatgpt'].includes(value.kind) || value.cloudThreadPrototype === true) return deny('nonlocal-composer');
    const get = (binding, key) => {
      if (!binding) return null;
      if (binding.kind === 'readable-family' || Object.getOwnPropertySymbols(binding).some(s => s.description === 'maitai.resolveFamilyMemberInternal')) {
        return codexSpeedReadFamily(binding, chain, key);
      }
      const owner = chain.get(binding.scope?.id) || node;
      return owner.store.get(binding.resolve(owner, chain));
    };
    let cwd = value.cwd;
    let host = value.hostId;
    if (value.kind === 'new') {
      let target;
      try {
        // The retained target descriptors work even when optional minified
        // selector discovery failed. Do not inherit its unavailable flag.
        target = codexFuelNewTarget(get, { node, value, chain }, {
          cloudSelection: bindings?.cloudSelection, selectedProject: bindings?.selectedProject,
        });
      } catch (_) { return deny('new-target-pending', true); }
      if (!target) return deny('new-target-pending', true);
      cwd = target.cwd; host = 'local';
    } else {
      if (bindings?.threadHost) { try { host = get(bindings.threadHost, value.conversationId); } catch (_) {} }
      if (bindings?.threadCwd) { try { cwd = get(bindings.threadCwd, value.conversationId); } catch (_) {} }
      if (!host || !cwd) for (const manager of managers) {
        try {
          const thread = manager.getConversation(value.conversationId);
          if (thread) { host = thread.hostId || manager.hostId; cwd = thread.cwd; break; }
        } catch (_) {}
      }
    }
    if (typeof host === 'string' && host && host !== 'local') return deny('nonlocal-host');
    if (bindings?.config && typeof cwd === 'string' && cwd.trim()) {
      let config;
      try { config = get(bindings.config, { hostId: 'local', cwd }); } catch (_) {}
      if (!config || config.isError || config.isPending || config.isLoading) return deny('workspace-config-pending', true);
      if (!codexFuelConfigResultUsesRelay(config, state) || config.data?.profile != null) return deny('workspace-not-relay');
      verified += 1;
    }
    local += 1;
  }
  return local ? { enabled: true, reason: verified === local ? 'workspace-relay-confirmed' : 'helper-relay-confirmed', recoverHome: true }
    : deny('composer-unavailable');
}

function codexUsageInspectClient(fiber, accept) {
  const inspect = value => {
    if (!value || typeof value !== 'object') return;
    for (const candidate of [value, value.client, value.queryClient]) {
      if (candidate && typeof candidate.getQueryCache === 'function' && typeof candidate.setQueryData === 'function') accept(candidate);
    }
  };
  inspect(fiber.memoizedProps); inspect(fiber.memoizedProps?.value);
  inspect(fiber.pendingProps); inspect(fiber.pendingProps?.value); inspect(fiber.stateNode);
  for (let hook = fiber.memoizedState, i = 0; hook && i < 12; hook = hook.next, i += 1) inspect(hook.memoizedState);
  for (let dependency = fiber.dependencies?.firstContext, i = 0; dependency && i < 20; dependency = dependency.next, i += 1) inspect(dependency.memoizedValue);
}

// The query provider can mount before a composer has a DOM fiber. Discover it
// from React's committed roots as well as the existing composer ancestor scan.
// Finding a client never authorizes its quota projection; policy still does.
function codexUsageFindClients(rootDocument = globalThis.document, { maxNodes = 8000 } = {}) {
  const clients = new Set();
  const limit = Number.isFinite(maxNodes) ? Math.min(8000, Math.max(0, Math.floor(maxNodes))) : 8000;
  if (!rootDocument || !limit) return clients;
  const read = (value, key) => {
    try { return value?.[key]; } catch (_) { return undefined; }
  };
  const roots = new Set();
  try { roots.add(rootDocument.getElementById?.('root')); } catch (_) {}
  roots.add(read(rootDocument, 'body'));
  roots.add(read(rootDocument, 'documentElement'));
  const pending = [];
  for (const root of roots) {
    if (!root || typeof root !== 'object') continue;
    let keys;
    try { keys = Object.keys(root); } catch (_) { continue; }
    for (const key of keys) {
      if (!key.startsWith('__reactContainer$') && !key.startsWith('__reactFiber$')) continue;
      const fiber = read(root, key);
      const current = read(read(fiber, 'stateNode'), 'current');
      pending.push(current && typeof current === 'object' ? current : fiber);
    }
  }
  const seen = new Set();
  while (pending.length && seen.size < limit) {
    const fiber = pending.pop();
    if (!fiber || typeof fiber !== 'object' || seen.has(fiber)) continue;
    seen.add(fiber);
    try { codexUsageInspectClient(fiber, client => clients.add(client)); } catch (_) {}
    // A malformed node or getter must not hide the rest of the mounted tree.
    const sibling = read(fiber, 'sibling');
    const child = read(fiber, 'child');
    if (sibling) pending.push(sibling);
    if (child) pending.push(child);
  }
  return clients;
}
