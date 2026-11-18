var CODEX_API_MODE_RUNTIME_VERSION = 9;

// Legacy renderer-owner hosts require verified snapshot restore/CAS. Reviewed
// content-owner hosts retain same-home local projects natively; never replay a
// legacy cache over their current shared catalog, edits or explicit removals.
function createCodexApiLocalProjectsGuard(bindings, { getState, bridge }) {
  const keys = ['electron-saved-workspace-roots', 'electron-workspace-root-labels', 'local-projects'];
  const atomsKey = 'electron-persisted-atom-state';
  const checkpointKey = 'gaoge:api-local-projects-hydrated-v1';
  let disposed = false, scope = null, revision = null, hydrated = false;
  let fingerprint = '', ready = false, reason = 'awaiting-local-projects', error = '';
  let verifiedAt = 0, lastCommit = 0, expectedMemberships = null;
  let checkpoint = null, pendingCheckpoint = null;
  const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const snapshotKey = value => stable([value?.scope ?? null, value?.runtimeRevision]);
  const invoke = (target, method, args = []) => {
    const fn = target?.[method];
    if (typeof fn !== 'function') throw new Error('Native local project service unavailable: ' + method);
    return Reflect.apply(fn, target, args);
  };
  const validate = value => value?.version === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0
    && Number.isSafeInteger(value.runtimeRevision) && value.runtimeRevision >= 0
    && typeof value.scope === 'string' && value.scope.length > 0 && value.scope.length <= 256 && value.globals
    && typeof value.globals === 'object' && !Array.isArray(value.globals)
    && Object.keys(value.globals).every(key => keys.includes(key))
    && value.globals['local-projects'] && typeof value.globals['local-projects'] === 'object'
    && !Array.isArray(value.globals['local-projects']) && value.memberships
    && value.memberships.assignments && typeof value.memberships.assignments === 'object'
    && !Array.isArray(value.memberships.assignments) && Array.isArray(value.memberships.projectlessThreadIds);
  const validCheckpoint = value => value?.checkpoint?.version === 1
    && value.checkpoint.revision === value.revision && typeof value.checkpoint.nonce === 'string'
    && value.checkpoint.nonce.length > 0 && value.checkpoint.nonce.length <= 256;
  const checkpointFor = value => validCheckpoint(value)
    ? { version: 1, scope: value.scope, revision: value.revision, nonce: value.checkpoint.nonce } : null;
  const rootIdentity = value => {
    if (typeof value !== 'string' || !value.length || value.length > 32768 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
    const slashed = value.replace(/\\/g, '/'), drive = /^[a-z]:\//i.test(slashed);
    if (slashed.startsWith('//') || (!drive && !slashed.startsWith('/'))) return null;
    const segments = [];
    for (const segment of slashed.slice(drive ? 3 : 1).split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') { if (!segments.length) return null; segments.pop(); }
      else segments.push(segment);
    }
    const normalized = (drive ? slashed.slice(0, 2) : '') + '/' + segments.join('/');
    return drive ? normalized.replace(/[A-Z]/g, value => value.toLowerCase()) : normalized;
  };
  const mergeInitialGlobals = (saved, live) => {
    const catalog = { ...saved['local-projects'], ...live['local-projects'] };
    const roots = new Map();
    for (const project of Object.values(catalog)) {
      for (const root of Array.isArray(project?.rootPaths) ? project.rootPaths : []) {
        const identity = rootIdentity(root);
        if (identity && !roots.has(identity)) roots.set(identity, root);
      }
    }
    const ordered = new Map(), labels = {};
    for (const root of [...(Array.isArray(live[keys[0]]) ? live[keys[0]] : []),
      ...(Array.isArray(saved[keys[0]]) ? saved[keys[0]] : []), ...roots.values()]) {
      const identity = rootIdentity(root);
      if (identity && roots.has(identity)) ordered.set(identity, roots.get(identity));
    }
    for (const source of [saved[keys[1]], live[keys[1]]]) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      for (const [root, label] of Object.entries(source)) {
        const identity = rootIdentity(root);
        if (identity && roots.has(identity) && typeof label === 'string' && label.length <= 4096) {
          labels[roots.get(identity)] = label;
        }
      }
    }
    return { [keys[0]]: [...ordered.values()], [keys[1]]: labels, 'local-projects': catalog };
  };
  function retire(message) { ready = false; reason = message; }
  return {
    async synchronize(snapshot, isCurrent) {
      error = '';
      if (!snapshot) { retire('awaiting-local-project-snapshot'); return; }
      if (disposed || getState()?.apiCodingModeEnabled !== true || !isCurrent()) { retire('local-project-identity-changed'); return; }
      if (snapshot?.unavailable === true) {
        retire(snapshot.reason === 'unverified-native-project-scope' ? snapshot.reason : 'awaiting-local-project-snapshot');
        return;
      }
      const nativeShared = snapshot?.storage === 'native-shared';
      if (nativeShared ? snapshot.version !== 1 || typeof snapshot.scope !== 'string' || !snapshot.scope.length
          || snapshot.scope.length > 256 || !Number.isSafeInteger(snapshot.runtimeRevision) || snapshot.runtimeRevision < 0
        : !validate(snapshot)) throw new Error('Invalid API local project snapshot');
      const onboarding = bindings.localOnboarding;
      if (!onboarding?.hostReady?.()) { retire('awaiting-host-hydration'); return; }
      const contract = onboarding.projectOwnerContract?.();
      if (contract !== 'renderer-owner' && contract !== 'content-owner') { retire('unknown-native-project-owner'); return; }
      const ownerKey = contract === 'content-owner' ? 'electron-renderer-content-owner' : 'electron-account-renderer-state-v1';
      const identity = snapshotKey(snapshot);
      if (scope !== null && scope !== snapshot.scope) { retire('local-project-scope-changed'); return; }
      const services = bindings.appServices, appState = services?.applicationState;
      const current = () => {
        const state = getState();
        return !disposed && state?.apiCodingModeEnabled === true && isCurrent() && snapshotKey(state.apiLocalProjects) === identity
          && (state.apiLocalProjects?.storage === 'native-shared') === nativeShared
          && bindings.appServices === services && bindings.localOnboarding === onboarding && onboarding.hostReady();
      };
      const check = async () => {
        if (!current()) throw new Error('API local project identity changed');
        const marker = await invoke(appState, 'read', [ownerKey]);
        const value = marker?.value;
        const apiOwner = contract === 'content-owner' ? value === 'signed-out' : value !== null && typeof value === 'object'
          && !Array.isArray(value) && Object.hasOwn(value, 'owner') && value.owner === null;
        if (!current() || !apiOwner) throw new Error('API local project owner changed or is unavailable');
      };
      const readCheckpoint = async () => {
        await check();
        const atoms = await invoke(appState, 'read', [atomsKey]);
        await check();
        return atoms?.value?.[checkpointKey];
      };
      const verifyCheckpoint = async marker => {
        if (stable(await readCheckpoint()) !== stable(marker)) {
          throw new Error('Native local project checkpoint readback pending');
        }
      };
      const publishCheckpoint = async () => {
        const marker = pendingCheckpoint;
        if (!marker) return;
        ready = false;
        reason = 'verifying-local-project-checkpoint';
        await check();
        const published = bindings.localOnboarding?.publishProjectCheckpoint?.(marker, current);
        if (published?.ready !== true) throw new Error('Native local project checkpoint publication unavailable');
        await verifyCheckpoint(marker);
        checkpoint = marker;
        pendingCheckpoint = null;
      };
      const read = async () => {
        await check();
        const catalog = await invoke(services.projectCatalog, 'readLocalProjects');
        await check();
        const roots = await invoke(appState, 'read', [keys[0]]);
        await check();
        const labels = await invoke(appState, 'read', [keys[1]]);
        await check();
        const memberships = await invoke(services.threadProjectAssignments, 'readMemberships');
        await check();
        return { globals: { [keys[0]]: roots?.value ?? [], [keys[1]]: labels?.value ?? {},
          'local-projects': catalog ?? {} }, memberships };
      };
      try {
        await check();
        if (contract === 'content-owner') {
          if (!nativeShared) { retire('awaiting-native-shared-project-grant'); return; }
          // Native storage is authoritative for shared same-home projects. Read
          // through native services only: no cache import, state write or CAS.
          const catalog = await invoke(services.projectCatalog, 'readLocalProjects');
          await check();
          const memberships = await invoke(services.threadProjectAssignments, 'readMemberships');
          await check();
          const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
          if (!object(catalog) || !object(memberships) || !object(memberships.assignments)
              || !Array.isArray(memberships.projectlessThreadIds)
              || !memberships.projectlessThreadIds.every(id => typeof id === 'string')) {
            throw new Error('Native shared local project readback is malformed');
          }
          scope = snapshot.scope;
          hydrated = true;
          revision = null;
          ready = true;
          verifiedAt = Date.now();
          reason = 'native-shared-local-projects-verified';
          return;
        }
        if (nativeShared) { retire('native-project-contract-changed'); return; }
        // A settings refresh renews the grant for the same home. Keep the
        // once-only hydration and CAS state; an in-flight call still checks
        // its captured runtimeRevision at every asynchronous boundary.
        scope = snapshot.scope;
        // A successful CAS receipt is retained while native atom IPC catches up.
        // Retry that publication before attempting another snapshot transaction.
        if (pendingCheckpoint) await publishCheckpoint();
        if (!hydrated) {
          ready = false;
          reason = 'restoring-local-projects';
          const nativeCheckpoint = await readCheckpoint(), expectedCheckpoint = checkpointFor(snapshot);
          if (nativeCheckpoint != null) {
            // Another guard may already have restored this native generation.
            // Only its exact current receipt makes native deletions authoritative.
            if (!expectedCheckpoint || stable(nativeCheckpoint) !== stable(expectedCheckpoint)) {
              retire('awaiting-current-local-project-snapshot');
              return;
            }
            revision = snapshot.revision;
            checkpoint = expectedCheckpoint;
            expectedMemberships = null;
          } else {
            revision = snapshot.revision;
            const before = await read();
            const merged = mergeInitialGlobals(snapshot.globals, before.globals);
            const unclaimed = async () => {
              if (await readCheckpoint() != null) throw new Error('Native local project hydration changed; waiting for current snapshot');
            };
            // A project created before bridge readiness does not prove that all
            // saved projects were restored. Fill missing IDs, keeping live edits.
            for (const key of keys) {
              await unclaimed();
              const result = await invoke(appState, 'write', [key, merged[key]]);
              if (result?.success !== true) throw new Error('Native local project write rejected: ' + key);
              await check();
            }
            const active = (await read()).globals['local-projects'];
            const assignments = snapshot.memberships.assignments ?? {};
            const records = Object.entries(assignments).filter(([, assignment]) => assignment?.projectKind === 'local'
              && Object.hasOwn(active, assignment.projectId)).map(([threadId, assignment]) =>
              ({ threadId, assignment, projectless: false, hostId: 'local' }));
            for (const threadId of snapshot.memberships.projectlessThreadIds ?? []) {
              if (!Object.hasOwn(assignments, threadId)) records.push({ threadId, assignment: null, projectless: true, hostId: 'local' });
            }
            expectedMemberships = records;
            if (records.length) {
              await unclaimed();
              await invoke(services.threadProjectAssignments, 'assignIfUnassigned', [records]);
              await check();
            }
            const after = await read();
            if (Object.keys(merged['local-projects']).some(id => !Object.hasOwn(after.globals['local-projects'], id))) {
              throw new Error('Native local project catalog readback failed');
            }
          }
          // Hydration is never replayed after this point, including after a CAS
          // conflict or a later GET returning an older receipt.
          hydrated = true;
          fingerprint = '';
        }
        const observed = await read();
        if (expectedMemberships) {
          const native = observed.memberships;
          if (!native?.assignments || !Array.isArray(native.projectlessThreadIds)) {
            throw new Error('Native local project memberships readback failed');
          }
          const conflicts = expectedMemberships.filter(record => record.projectless
            ? native.assignments[record.threadId] != null || !native.projectlessThreadIds.includes(record.threadId)
            : native.projectlessThreadIds.includes(record.threadId)
              || stable(native.assignments[record.threadId]) !== stable(record.assignment));
          if (conflicts.length) throw new Error('Native local project membership conflict (' + conflicts.length + ')');
          expectedMemberships = null;
        }
        const changed = stable(observed);
        if (changed !== fingerprint || snapshot.revision > revision) {
          ready = false;
          reason = 'saving-local-projects';
          if (typeof bridge !== 'function') throw new Error('API local project persistence bridge unavailable');
          if (lastCommit && Date.now() - lastCommit < 1000) return;
          lastCommit = Date.now();
          await check();
          const result = await bridge('/projects/local-state', { scope: snapshot.scope, runtimeRevision: snapshot.runtimeRevision,
            expectedRevision: revision, globals: observed.globals, memberships: observed.memberships });
          await check();
          if (result?.ok !== true || !validate(result.apiLocalProjects) || !validCheckpoint(result.apiLocalProjects)
              || snapshotKey(result.apiLocalProjects) !== identity
              || result.apiLocalProjects.revision < Math.max(revision, snapshot.revision)) throw new Error('API local project snapshot commit rejected');
          revision = result.apiLocalProjects.revision;
          fingerprint = changed;
          lastCommit = 0;
          pendingCheckpoint = { version: 1, scope, revision, nonce: result.apiLocalProjects.checkpoint.nonce };
          // This non-shared native atom is cleared by every new API owner reset.
          // Publish only after complete hydration, native readback and CAS success.
          await publishCheckpoint();
        }
        if (!checkpoint) throw new Error('API local project checkpoint unavailable');
        await verifyCheckpoint(checkpoint);
        ready = true;
        verifiedAt = Date.now();
        reason = 'local-projects-verified';
      } catch (failure) {
        ready = false;
        error = String(failure?.message || failure);
        reason = 'local-projects-unverified';
      }
    },
    status() { return { ready: !disposed && ready && Date.now() - verifiedAt <= 5000,
      reason, error, hydrated, revision }; },
    dispose() { disposed = true; ready = false; },
  };
}

// Keep the native account and mode machinery intact. Only a confirmed API-only
// login may normalize Work selections; absent/stale auth never grants access.
function createCodexApiModeGuard(bindings, { getState, bridge, notify = () => {}, eventTarget = globalThis.document }) {
  const services = bindings.appServices;
  if (typeof services?.settings?.write !== 'function'
      || typeof services?.settings?.read !== 'function'
      || typeof services?.workModeAccess?.publish !== 'function') {
    throw new Error('Codex mode services unavailable');
  }
  const settings = services.settings;
  const access = services.workModeAccess;
  const originalWrite = settings.write;
  const originalPublish = access.publish;
  const originals = new Map();
  let disposed = false;
  let repairing = false;
  let pending = null;
  let ready = false;
  let verifiedAt = 0;
  let reason = 'awaiting-native-auth';
  let error = '';
  let activeIdentity = '';
  let localOnboarding = null;
  const localProjects = createCodexApiLocalProjectsGuard(bindings, { getState, bridge });
  const key = value => JSON.stringify([value?.authMethod, value?.accountId,
    value?.userId, value?.stableId]);
  const enabled = () => !disposed && getState()?.apiCodingModeEnabled === true;
  const owner = () => {
    if (!enabled()) return null;
    try {
      const scopes = bindings.scopes();
      if (!scopes.length) return null;
      const candidates = scopes.map(scope => ({ scope, ...bindings.read(scope) }));
      // A window transitioning between accounts must not inherit the old policy.
      if (candidates.some(value => value.authMethod !== 'apikey' || value.authLoading !== false
          || value.identity?.accountId != null || value.authAccountId != null
          || value.authenticatedAccountId != null || value.hasChatGptToken === true)) return null;
      const identities = new Set(candidates.map(value => key(value.identity)));
      if (identities.size !== 1 || candidates[0].identity?.authMethod !== 'apikey') return null;
      return { ...candidates[0], owners: candidates };
    } catch (_) { return null; }
  };
  function remember(payload) {
    const identity = key(payload);
    originals.set(identity, { ...payload });
    if (originals.size > 8) originals.delete(originals.keys().next().value);
  }
  const wrappedPublish = function (payload, ...args) {
    const current = owner();
    if (current && payload?.authMethod === 'apikey'
        && key(payload) === key(current.identity)) {
      remember(payload);
      activeIdentity = key(payload);
      return Promise.resolve(Reflect.apply(originalPublish, this, [{ ...payload, policy: 'coding' }, ...args]))
        .then(async result => {
          if (disposed || !enabled() || key(owner()?.identity) !== key(payload)) {
            await Reflect.apply(originalPublish, access, [payload]);
          }
          return result;
        }).catch(failure => {
          if (activeIdentity === key(payload)) activeIdentity = '';
          throw failure;
        });
    }
    return Reflect.apply(originalPublish, this, [payload, ...args]);
  };
  const wrappedWrite = function (name, value, ...args) {
    const current = name === 'conversationDetailMode' && value === 'STEPS_PROSE' ? owner() : null;
    if (!current) return Reflect.apply(originalWrite, this, [name, value, ...args]);
    ready = false;
    reason = 'normalizing-selection';
    notify();
    // XKt has already put PROSE into its optimistic signal. The real native
    // setter clears it synchronously, before its async settings write begins.
    if (!repairing) {
      repairing = true;
      try { return Promise.all(current.owners.map(value => bindings.setCoding(value.scope))); }
      finally { repairing = false; }
    }
    return Reflect.apply(originalWrite, this, [name, 'STEPS_COMMANDS', ...args]);
  };
  let serviceHooksInstalled = false;
  // RPC stubs return a fresh callable proxy for every method lookup. Do not
  // probe their descriptors or assign properties; both are unsupported traps.
  const stableMethods = settings.write === originalWrite && access.publish === originalPublish;
  if (stableMethods) {
    try {
      settings.write = wrappedWrite;
      access.publish = wrappedPublish;
      serviceHooksInstalled = settings.write === wrappedWrite && access.publish === wrappedPublish;
    } catch (_) { /* Read-only native facades use direct observation below. */ }
    if (!serviceHooksInstalled) {
      if (settings.write === wrappedWrite) settings.write = originalWrite;
      if (access.publish === wrappedPublish) access.publish = originalPublish;
      if (settings.write !== originalWrite || access.publish !== originalPublish) {
        throw new Error('Codex mode service hook rollback failed');
      }
    }
  }
  async function restore() {
    const payload = originals.get(activeIdentity);
    activeIdentity = '';
    if (payload) await Reflect.apply(originalPublish, access, [payload]);
  }
  async function refreshNow() {
    error = '';
    if (disposed) return;
    if (!enabled()) {
      await restore();
      reason = 'not-api-login';
      localOnboarding = null;
      ready = true;
      return;
    }
    const current = owner();
    if (!current) {
      ready = false;
      await restore();
      reason = 'awaiting-native-auth';
      localOnboarding = null;
      return;
    }
    if (bindings.appServices !== services || services.settings !== settings || services.workModeAccess !== access
        || (serviceHooksInstalled && (settings.write !== wrappedWrite || access.publish !== wrappedPublish))
        || typeof settings.read !== 'function' || typeof settings.write !== 'function' || typeof access.publish !== 'function') {
      throw new Error('Codex mode services changed');
    }
    const identity = key(current.identity);
    if (current.owners.some(value => value.detailLevel !== 'STEPS_COMMANDS'
        || !['coding', 'preference'].includes(value.policy))) ready = false;
    if (bindings.localOnboarding && getState()?.apiLocalOnboarding) {
      localOnboarding = bindings.localOnboarding.synchronize(getState().apiLocalOnboarding,
        () => !disposed && enabled() && key(owner()?.identity) === identity);
      if (!localOnboarding.ready) {
        ready = false;
        reason = 'awaiting-native-onboarding-state';
        return;
      }
    } else localOnboarding = null;
    if (activeIdentity !== identity) {
      ready = false;
      await restore();
      const policy = current.policy;
      if (!['coding', 'preference', 'everyday'].includes(policy)) {
        reason = 'awaiting-native-policy';
        return;
      }
      if (!originals.has(identity)) remember({ ...current.identity, policy });
      // Preserve the real identity metadata. Main-process effective settings
      // match this identity; writing the preference alone is insufficient.
      activeIdentity = identity;
      const previousPolicy = originals.get(identity);
      try { await Reflect.apply(originalPublish, access, [{ ...current.identity, policy: 'coding' }]); }
      catch (failure) { activeIdentity = ''; throw failure; }
      if (disposed || !enabled() || key(owner()?.identity) !== identity) {
        // dispose/account changes can finish while the RPC is still in flight.
        // Compensate after its completion as well, using the same real identity.
        if (activeIdentity === identity) activeIdentity = '';
        await Reflect.apply(originalPublish, access, [previousPolicy]);
        return;
      }
    }
    const before = await settings.read('conversationDetailMode');
    if (disposed || !enabled() || key(owner()?.identity) !== identity) return;
    if (before?.effective !== 'STEPS_COMMANDS') {
      ready = false;
      // A delayed native publisher can replace the account-scoped policy.
      // Reconcile it as well as the persisted preference on the next scan.
      await Reflect.apply(originalPublish, access, [{ ...current.identity, policy: 'coding' }]);
      if (disposed || !enabled() || key(owner()?.identity) !== identity) {
        await Reflect.apply(originalPublish, access, [originals.get(identity)]);
        return;
      }
    }
    if (current.owners.some(value => value.detailLevel !== 'STEPS_COMMANDS'
          || !['coding', 'preference'].includes(value.policy))
        || before?.effective !== 'STEPS_COMMANDS' || before?.configured !== 'STEPS_COMMANDS') {
      ready = false;
      repairing = true;
      try { await Promise.all(current.owners.map(value => bindings.setCoding(value.scope))); }
      finally { repairing = false; }
    }
    const after = await settings.read('conversationDetailMode');
    const latest = owner();
    if (disposed || !enabled() || !latest || key(latest.identity) !== identity) return;
    ready = after?.effective === 'STEPS_COMMANDS' && after?.configured === 'STEPS_COMMANDS'
      && latest.owners.every(value => value.detailLevel === 'STEPS_COMMANDS'
        && ['coding', 'preference'].includes(value.policy));
    reason = ready ? 'coding' : 'awaiting-native-policy';
    if (ready && getState()?.apiLocalProjects) {
      await localProjects.synchronize(getState().apiLocalProjects,
        () => !disposed && enabled() && key(owner()?.identity) === identity);
      ready = localProjects.status().ready;
      if (!ready) reason = 'awaiting-native-local-projects';
    }
    if (ready) verifiedAt = Date.now();
  }
  const captureModeControl = event => {
    if (event.type === 'keydown' && !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    if (!owner() || !bindings.isModeControlEvent?.(event.target)) return;
    // The native selector also restores its previous Work navigation after
    // writing the preference. Keep this API-only selector closed so no stale
    // Work page is opened; direct mode writes are still normalized above.
    event.preventDefault();
    event.stopImmediatePropagation();
    notify();
    void guard.refresh();
  };
  const events = ['pointerdown', 'click', 'keydown'];
  const guard = {
    isConfirmedApiOwner: () => Boolean(owner()),
    refresh() {
      if (pending) return pending;
      pending = refreshNow().catch(failure => {
        ready = false;
        reason = 'verification-failed';
        error = String(failure?.message || failure);
      }).finally(() => { pending = null; });
      return pending;
    },
    status: () => {
      const current = reason === 'coding' ? owner() : null;
      const codingVerified = reason !== 'coding' || (Date.now() - verifiedAt <= 5000
        && current && key(current.identity) === activeIdentity
        && current.owners.every(value => value.detailLevel === 'STEPS_COMMANDS'
          && ['coding', 'preference'].includes(value.policy)));
      return { ready: Boolean(!disposed && ready && codingVerified), reason, error,
        ...(!serviceHooksInstalled ? { serviceMode: 'native-observer' } : {}),
        ...(localOnboarding ? { localOnboarding } : {}),
        ...(getState()?.apiLocalProjects ? { localProjects: localProjects.status() } : {}) };
    },
    dispose() {
      disposed = true;
      localProjects.dispose();
      for (const event of events) eventTarget?.removeEventListener(event, captureModeControl, true);
      if (settings.write === wrappedWrite) settings.write = originalWrite;
      if (access.publish === wrappedPublish) access.publish = originalPublish;
      return restore().catch(() => {});
    },
  };
  for (const event of events) eventTarget?.addEventListener(event, captureModeControl, true);
  return guard;
}

function installCodexApiModeRuntime(options) {
  const previous = window.__gaogeCodexApiModeRuntime;
  if (previous?.version === CODEX_API_MODE_RUNTIME_VERSION && !previous.disposed) {
    previous.update(options.state);
    return previous;
  }
  previous?.dispose?.();
  let state = options.state || {};
  let confirmedAt = Date.now();
  let disposed = false;
  let guard = null;
  let loading = null;
  let refreshing = null;
  let lastAttempt = 0;
  let lastPoll = 0;
  let error = '';
  let noticeAt = 0;
  let generation = 0;
  let gracefulExit = null;
  // Brief helper contention must not reopen Work for the same confirmed API
  // session. Native auth is checked on every action, so a real account switch
  // still releases the restriction immediately during this bounded grace.
  const getState = () => Date.now() - confirmedAt <= 60000 ? state : {};
  const deadline = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex mode initialization timed out')), 3000);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  const notify = () => {
    if (Date.now() - noticeAt < 5000) return;
    noticeAt = Date.now();
    const element = document.createElement('div');
    element.setAttribute('role', 'status');
    element.textContent = 'API 登录使用 Codex 编码模式，正在确认切换。';
    element.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:10px;background:#252525;color:white;font-size:13px;pointer-events:none;';
    document.body?.appendChild(element);
    setTimeout(() => element.remove(), 4000);
  };
  async function load() {
    lastAttempt = Date.now();
    let bindings;
    if (options.assetUrl('app-initial-')) {
      const names = ['app-initial-', 'app-shared-'];
      const records = await deadline(Promise.all(names.map(async name => {
        const url = options.assetUrl(name);
        if (!url) throw new Error('Unsupported Codex API mode contract: incomplete legacy assets');
        const [module, response] = await Promise.all([options.loadModule(name), fetch(url, { cache: 'force-cache' })]);
        if (!response.ok) throw new Error('Codex mode asset HTTP ' + response.status);
        return { module, source: await response.text() };
      })));
      if (disposed) return;
      bindings = codexApiModeBindings({ initialSource: records[0].source,
        initialModule: records[0].module, sharedSource: records[1].source,
        sharedModule: records[1].module, document });
    } else {
      const entries = codexApiModeWebpackEntryUrls();
      if (!entries.length) return;
      // These are already-loaded same-origin entry scripts. Import uses the
      // browser's ESM cache; never initialize arbitrary registry factories.
      const registries = new Map();
      for (const url of entries) {
        const name = url.split('/').at(-1).split('?')[0];
        if (options.assetUrl(name) !== url) throw new Error('Unsupported Codex API mode contract: ambiguous entry resource');
        const module = await deadline(options.loadModule(name));
        if (disposed) return;
        if (typeof module?.__webpack_require__ === 'function') registries.set(module.__webpack_require__, module);
      }
      if (!registries.size) return;
      const candidates = [...registries.values()].map(module => codexApiModeWebpackBindings({ module, document }));
      const ready = candidates.filter(candidate => !candidate.error);
      if (ready.length > 1) throw new Error('Unsupported Codex API mode contract: ambiguous loaded application');
      bindings = ready[0] || candidates.find(candidate => candidate.pending) || candidates[0];
      if (bindings?.pending) return;
    }
    if (!bindings) return;
    if (bindings.error) throw new Error(bindings.error);
    if (disposed) return;
    guard = createCodexApiModeGuard(bindings, { getState, bridge: options.bridge, notify });
    error = '';
  }
  async function refresh() {
    if (disposed) return;
    if (Date.now() - lastPoll >= 2000) {
      lastPoll = Date.now();
      const pollingGeneration = generation;
      try {
        const next = await deadline(options.bridge('/fuel/status', {}));
        if (disposed || pollingGeneration !== generation) return;
        if (next?.ok === true && typeof next.apiCodingModeEnabled === 'boolean') {
          state = next;
          window.__GAOGE_CODEX_FUEL_STATE__ = next;
          confirmedAt = Date.now();
        }
      } catch (_) { /* Stale confirmations expire without changing real auth. */ }
    }
    if (!guard && !loading && getState().apiCodingModeEnabled === true
        && (!lastAttempt || Date.now() - lastAttempt >= 15000)) {
      loading = load().catch(failure => { error = String(failure?.message || failure); })
        .finally(() => { loading = null; });
    }
    await guard?.refresh();
    if (guard?.status().error === 'Codex mode services changed') {
      await guard.dispose();
      guard = null;
      lastAttempt = 0;
    }
  }
  const tick = () => {
    if (!refreshing) refreshing = refresh().catch(failure => {
      error = String(failure?.message || failure);
    }).finally(() => { refreshing = null; });
    return refreshing;
  };
  const runtime = {
    version: CODEX_API_MODE_RUNTIME_VERSION,
    get disposed() { return disposed; },
    update(next) { generation += 1; state = next || {}; confirmedAt = Date.now(); void tick(); },
    refresh: tick,
    requestGracefulExit(expected) {
      const scope = expected?.scope, runtimeRevision = expected?.runtimeRevision;
      if (typeof scope !== 'string' || !scope.length || !Number.isSafeInteger(runtimeRevision) || runtimeRevision < 0) {
        return { requested: false };
      }
      const nativeBridge = window.electronBridge, send = nativeBridge?.sendMessageFromView;
      const authorized = () => !disposed && getState().apiCodingModeEnabled === true
        && getState().apiLocalProjects?.scope === scope && getState().apiLocalProjects?.runtimeRevision === runtimeRevision
        && guard?.isConfirmedApiOwner() === true && typeof send === 'function'
        && window.electronBridge === nativeBridge && nativeBridge.sendMessageFromView === send;
      if (!authorized()) return { requested: false };
      if (gracefulExit) return { requested: gracefulExit.scope === scope && gracefulExit.runtimeRevision === runtimeRevision };
      const request = { scope, runtimeRevision, timer: null };
      gracefulExit = request;
      // Give CDP time to acknowledge the request, then use Electron's own quit
      // path so native project/atom stores flush before the process exits.
      request.timer = setTimeout(() => {
        if (gracefulExit !== request) return;
        gracefulExit = null;
        if (!authorized()) return;
        try { Reflect.apply(send, nativeBridge, [{ type: 'quit-app' }]); }
        catch (_) { error = 'Native graceful exit request failed'; }
      }, 50);
      return { requested: true };
    },
    status() {
      const enabled = getState().apiCodingModeEnabled === true;
      return { version: CODEX_API_MODE_RUNTIME_VERSION, enabled, monitoring: !disposed,
        ready: !enabled, reason: enabled ? 'awaiting-bindings' : 'not-api-login',
        error, ...(guard?.status() || {}) };
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      if (gracefulExit) clearTimeout(gracefulExit.timer);
      gracefulExit = null;
      void guard?.dispose();
      if (window.__gaogeCodexApiModeRuntime === runtime) delete window.__gaogeCodexApiModeRuntime;
    },
  };
  const timer = setInterval(tick, 500);
  window.__gaogeCodexApiModeRuntime = runtime;
  void tick();
  return runtime;
}
