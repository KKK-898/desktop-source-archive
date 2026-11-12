// Native bindings are identified by behavior, then resolved through live ESM exports.
// No minified names or account identities are persisted here.
function codexApiModeBindings(options) {
  const fail = message => { throw new Error(`Unsupported Codex API mode contract: ${message}`); };
  try {
    const { initialSource, initialModule, sharedSource, sharedModule } = options || {};
    if (typeof initialSource !== 'string' || typeof sharedSource !== 'string'
        || !initialModule || !sharedModule) fail('renderer source/modules unavailable');
    const identifier = '[A-Za-z_$][\\w$]*';
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const unique = (source, pattern, label) => {
      const matches = [...source.matchAll(pattern)];
      if (matches.length !== 1) fail(`${label} (${matches.length} matches)`);
      return matches[0];
    };
    const exportName = (source, local) => {
      const start = source.lastIndexOf('export{');
      if (start < 0) fail(`export table for ${local}`);
      const match = unique(source.slice(start),
        new RegExp(`(?:[,{])${escape(local)} as (${identifier})(?=[,}])`, 'g'), 'export binding');
      return match[1];
    };
    const native = local => initialModule[exportName(initialSource, local)];
    const importAliases = new Map();
    const imported = local => {
      if (importAliases.has(local)) return sharedModule[importAliases.get(local)];
      const imports = [...initialSource.matchAll(/import\{([^}]+)\}from["']([^"']+)["']/g)]
        .filter(match => /(?:^|\/)app-shared-[^/]+\.js$/.test(match[2]));
      if (imports.length !== 1) fail('shared import');
      const match = unique(`{${imports[0][1]}}`,
        new RegExp(`(?:[,{])(${identifier}) as ${escape(local)}(?=[,}])`, 'g'), 'shared alias');
      importAliases.set(local, match[1]);
      return sharedModule[match[1]];
    };

    const setter = unique(initialSource,
      /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=\2\.get\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\2\.get\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\{detailLevel:\3\};\2\.set\(\7,\8\);let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2,([A-Za-z_$][\w$]*)\.conversationDetailMode,\3,\{optimistic:!1\}\)/g,
      'detail mode setter');
    const setterEnd = initialSource.indexOf('}function ', setter.index);
    const setterSource = initialSource.slice(setter.index, setterEnd + 1);
    if (!setterSource.includes('previousThreadDetailLevel:')
        || !setterSource.includes('selectedThreadDetailLevel:')) fail('detail mode setter body');
    const modeAssignment = unique(initialSource,
      new RegExp(`${escape(setter[5])}=(${identifier})\\((${identifier}),\\(\\{get:(${identifier})\\}\\)=>\\3\\((${identifier})\\)\\)`, 'g'),
      'detail mode descriptor');
    const initializerStart = initialSource.lastIndexOf('function ', modeAssignment.index);
    const initializerMatch = /^function ([A-Za-z_$][\w$]*)\(\)\{return\(/.exec(initialSource.slice(initializerStart));
    if (!initializerMatch) fail('detail mode initializer');
    const initialize = native(initializerMatch[1]);
    const nativeSetter = native(setter[1]);
    if (typeof initialize !== 'function' || typeof nativeSetter !== 'function') fail('native mode functions');
    initialize();
    const appScope = imported(modeAssignment[2]);
    if (appScope?.__scopeBrand !== 'AppScope' || typeof appScope.id !== 'symbol') fail('AppScope token');

    // The native setter reads mode and optimistic state before its first write.
    // A private probe stops at that write, without exposing any real store or IPC.
    const stopProbe = {};
    const captured = [];
    let stopped = false;
    try {
      nativeSetter({
        get(descriptor) { captured.push(descriptor); return undefined; },
        set(descriptor, value) {
          if (captured.length !== 2 || descriptor !== captured[1]
              || value?.detailLevel !== 'STEPS_COMMANDS') fail('setter probe order');
          stopped = true;
          throw stopProbe;
        },
      }, 'STEPS_COMMANDS');
    } catch (error) { if (error !== stopProbe) throw error; }
    if (!stopped || captured.some(value => typeof value?.resolve !== 'function'
        || value.scope !== appScope)) fail('mode descriptors');
    const [modeDescriptor, optimisticDescriptor] = captured;

    const policyMatch = unique(initialSource,
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\(\{get:([A-Za-z_$][\w$]*)\}\)=>\{let ([A-Za-z_$][\w$]*)=\4\(([A-Za-z_$][\w$]*)\);if\(\5\.status===`denied`&&\5\.reason===`unsupported-auth`\)return`coding`;let ([A-Za-z_$][\w$]*)=\4\(([A-Za-z_$][\w$]*)\);return \7\.status===`allowed`\|\|\7\.status===`loading`\|\|\7\.status===`error`\?`preference`:`everyday`\}\)/g,
      'work mode policy');
    if (policyMatch[3] !== modeAssignment[2]) fail('policy scope');
    const accessDescriptor = native(policyMatch[6]);
    const localAccessDescriptor = native(policyMatch[8]);
    const authMatch = unique(initialSource,
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\(\{scope:([A-Za-z_$][\w$]*)\}\)=>\{let ([A-Za-z_$][\w$]*)=\4\.get\(([A-Za-z_$][\w$]*)\);return\{accountId:null,accountLoading:!0,accountStructure:null,accountUserId:\5\?\.accountUserId\?\?null,authLoading:!0,authMethod:\5==null\?null:`chatgpt`/g,
      'native authentication');
    const authInputMatch = unique(initialSource,
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\(\)=>\(\{accountId:null,accountInfoError:!1,accountInfoLoading:!0,authLoading:!0,authMethod:null,plan:null,supportedSurface:!0,workCloudSupportedSurface:!0\}\)/g,
      'native access authentication');
    const statsigMatch = unique(initialSource,
      /\([A-Za-z_$][\w$]*,\{get:([A-Za-z_$][\w$]*)\}\)=>\1\(([A-Za-z_$][\w$]*)\)\?\.getFeatureGate\(/g,
      'Statsig client descriptor');
    const authDescriptor = native(authMatch[1]);
    const authInputDescriptor = native(authInputMatch[1]);
    const statsigDescriptor = native(statsigMatch[2]);
    for (const descriptor of [accessDescriptor, localAccessDescriptor, authDescriptor,
      authInputDescriptor, statsigDescriptor]) {
      if (descriptor?.scope !== appScope || typeof descriptor.resolve !== 'function') fail('AppScope descriptor');
    }
    const bridgeMatch = unique(initialSource,
      /([A-Za-z_$][\w$]*)\?\.workModeAccess==null\?/g, 'app services reference');
    const services = () => imported(bridgeMatch[1]);
    const appServices = services();
    if (typeof appServices?.settings?.write !== 'function'
        || typeof appServices?.settings?.read !== 'function'
        || typeof appServices?.workModeAccess?.publish !== 'function') fail('settings/workModeAccess services');
    const controlMarker = unique(initialSource,
      /id:`sidebarElectron\.productMode\.trigger`/g, 'native mode control');
    const controlStart = initialSource.lastIndexOf('function ', controlMarker.index);
    let controlEnd = controlStart;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let started = false;
    for (; controlEnd < initialSource.length; controlEnd += 1) {
      const character = initialSource[controlEnd];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
      if (character === '{') { depth += 1; started = true; }
      else if (character === '}' && --depth === 0 && started) { controlEnd += 1; break; }
    }
    const controlSource = initialSource.slice(controlStart, controlEnd);
    if (!/^function [\w$]+\([\w$]+\)\{/.test(controlSource)
        || !/codexAvailable:[\w$]+,disabled:[\w$]+,mode:[\w$]+,navigationHeading:[\w$]+,onModeSelect:[\w$]+,onNewChat:[\w$]+,workModeAccess:[\w$]+/.test(controlSource)
        || !controlSource.includes('sidebarElectron.productMode.work.description.recommended')
        || !controlSource.includes('sidebarElectron.productMode.codex.description.developer')
        || !controlSource.includes('onCloseAutoFocus:')) fail('native mode control body');
    const controlTypes = new WeakMap();
    const isModeControlEvent = target => {
      const element = target?.nodeType === 1 ? target : target?.parentElement;
      if (!element || element.isConnected === false) return false;
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber$')
        || name.startsWith('__reactInternalInstance$'));
      let attached = key ? element[key] : null;
      const climbed = new Set();
      while (attached?.return && !climbed.has(attached) && climbed.size < 300) {
        climbed.add(attached);
        attached = attached.return;
      }
      const current = attached?.stateNode?.current;
      if (!current) return false;
      const stack = [[current, null]];
      const parents = new Map();
      while (stack.length && parents.size < 40000) {
        const [fiber, parent] = stack.pop();
        if (!fiber || parents.has(fiber)) continue;
        parents.set(fiber, parent);
        if (fiber.stateNode === element) {
          for (let owner = fiber; owner; owner = parents.get(owner)) {
            const props = owner.memoizedProps;
            if (!props || !['codex', 'work'].includes(props.mode)
                || typeof props.codexAvailable !== 'boolean'
                || typeof props.onModeSelect !== 'function' || props.onNewChat != null
                || props.disabled === true
                || !['chatgpt', 'chatgpt_work', 'work'].includes(props.workModeAccess)) continue;
            const type = owner.type;
            if (typeof type !== 'function') continue;
            if (!controlTypes.has(type)) controlTypes.set(type,
              Function.prototype.toString.call(type) === controlSource);
            if (controlTypes.get(type)) return true;
          }
          return false;
        }
        if (fiber.sibling && fiber !== current) stack.push([fiber.sibling, parent]);
        if (fiber.child) stack.push([fiber.child, fiber]);
      }
      return false;
    };

    const validScope = scope => scope?.scope === appScope && scope.chain instanceof Map
      && scope.node === scope.chain.get(appScope.id) && typeof scope.get === 'function'
      && typeof scope.set === 'function' && typeof scope.query?.snapshot === 'function';
    let cachedRoots = null;
    let cachedScopes = null;
    let cacheVersion = 0;
    const scopes = () => {
      const document = options.document || globalThis.document;
      if (!document?.querySelectorAll) return [];
      const roots = new Set();
      const inspectElement = element => {
        if (!element) return;
        for (const key of Object.keys(element)) {
          if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactContainer$')
              && !key.startsWith('__reactInternalInstance$')) continue;
          let fiber = element[key];
          const seen = new Set();
          while (fiber?.return && !seen.has(fiber) && seen.size < 300) {
            seen.add(fiber);
            fiber = fiber.return;
          }
          if (fiber?.stateNode?.current) roots.add(fiber.stateNode.current);
        }
      };
      for (const element of new Set([document.documentElement, document.body,
        document.getElementById?.('root'), document.getElementById?.('app')])) inspectElement(element);
      if (!roots.size) {
        for (const element of [...document.querySelectorAll('*')].slice(0, 30000)) inspectElement(element);
      }
      if (cachedRoots && cachedRoots.size === roots.size
          && [...roots].every(root => cachedRoots.has(root))
          && cachedScopes.every(validScope)) return cachedScopes.slice();
      const byNode = new Map();
      const visited = new Set();
      const stack = [...roots];
      while (stack.length && visited.size < 40000) {
        const fiber = stack.pop();
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        // Only root.current's committed child tree; never alternate or pendingProps.
        const hooks = new Set();
        for (let hook = fiber.memoizedState; hook && !hooks.has(hook) && hooks.size < 256; hook = hook.next) {
          hooks.add(hook);
          const scope = hook.memoizedState?.current;
          if (validScope(scope) && !byNode.has(scope.node)) byNode.set(scope.node, scope);
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
      cachedRoots = roots;
      cachedScopes = [...byNode.values()];
      const version = ++cacheVersion;
      // Repeated synchronous owner checks share one traversal. Do not retain
      // the cache across tasks: two React commits can return to the same
      // alternate root pointer while replacing the scopes beneath it.
      const clearCache = () => {
        if (version === cacheVersion) { cachedRoots = null; cachedScopes = null; }
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(clearCache);
      else Promise.resolve().then(clearCache);
      return cachedScopes.slice();
    };
    const read = scope => {
      if (!validScope(scope)) fail('live AppScope handle');
      const auth = scope.get(authDescriptor);
      const access = scope.get(accessDescriptor);
      const localAccess = scope.get(localAccessDescriptor);
      const policy = access?.status === 'denied' && access.reason === 'unsupported-auth'
        ? 'coding' : ['allowed', 'loading', 'error'].includes(localAccess?.status) ? 'preference' : 'everyday';
      const client = scope.get(statsigDescriptor);
      const user = typeof client?.getContext === 'function' ? client.getContext()?.user : null;
      const identity = user ? {
        userId: user.userID ?? null,
        accountId: user.customIDs?.account_id ?? null,
        authMethod: typeof user.custom?.auth_method === 'string' ? user.custom.auth_method : null,
        stableId: user.customIDs?.stableID ?? null,
      } : null;
      return { authMethod: auth?.authMethod ?? null, authLoading: auth?.authLoading !== false,
        identity, detailLevel: scope.get(modeDescriptor), policy,
        access, localAccess, authInput: scope.get(authInputDescriptor) };
    };
    const setCoding = async scope => {
      const before = read(scope);
      if (before.authLoading || before.authMethod !== 'apikey') throw new Error('Native API authentication is not ready');
      const input = before.authInput;
      if (!input || typeof input !== 'object') fail('access authentication value');
      if (input.authMethod !== 'apikey' || input.authLoading !== false) {
        scope.set(authInputDescriptor, { ...input, authMethod: 'apikey', authLoading: false });
      }
      if (read(scope).policy === 'everyday') throw new Error('Native access policy still requires everyday mode');
      await nativeSetter(scope, 'STEPS_COMMANDS');
      return read(scope);
    };
    return { error: null, get appServices() { return services(); }, appScope,
      modeDescriptor, optimisticDescriptor, authDescriptor, authInputDescriptor,
      accessDescriptor, localAccessDescriptor, statsigDescriptor, scopes, read, setCoding,
      isModeControlEvent };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), scopes: () => [] };
  }
}

// Webpack builds expose a cached module registry instead of app-initial ESM.
// Discovery below never calls webpack require or initializes an account module.

function codexApiModeWebpackEntryUrls() {
  if (typeof document === 'undefined' || typeof location === 'undefined') return [];
  const directory = new URL('./assets/', location.href);
  return [...new Set(Array.from(document.scripts || []).filter(script => script.type === 'module')
    .map(script => script.src).filter(Boolean).filter(address => {
      try { const url = new URL(address, location.href);
        return url.origin === location.origin && url.pathname.startsWith(directory.pathname)
          && !url.pathname.slice(directory.pathname.length).includes('/')
          && /\/assets\/[\w-]+\.[\w-]+\.js$/.test(url.pathname);
      } catch (_) { return false; }
    }))].slice(0, 12);
}

function codexApiModeCommittedScopes(appScope, document) {
  const valid = scope => scope?.scope === appScope && scope.chain instanceof Map
    && scope.node === scope.chain.get(appScope.id) && typeof scope.get === 'function'
    && typeof scope.set === 'function' && typeof scope.query?.snapshot === 'function';
  const roots = new Set(), scopes = new Map();
  if (!document?.querySelectorAll) return [];
  const inspect = element => {
    for (const key of Object.keys(element || {})) {
      if (!/^__react(?:Fiber|Container|InternalInstance)\$/.test(key)) continue;
      let fiber = element[key];
      const seen = new Set();
      while (fiber?.return && !seen.has(fiber) && seen.size < 300) { seen.add(fiber); fiber = fiber.return; }
      if (fiber?.stateNode?.current) roots.add(fiber.stateNode.current);
    }
  };
  for (const element of new Set([document.documentElement, document.body,
    document.getElementById?.('root'), document.getElementById?.('app')])) inspect(element);
  if (!roots.size) for (const element of Array.from(document.querySelectorAll('body > *, #root > *')).slice(0, 100)) inspect(element);
  const stack = [...roots], visited = new Set();
  while (stack.length && visited.size < 40000) {
    const fiber = stack.pop();
    if (!fiber || visited.has(fiber)) continue;
    visited.add(fiber);
    const hooks = new Set();
    for (let hook = fiber.memoizedState; hook && !hooks.has(hook) && hooks.size < 256; hook = hook.next) {
      hooks.add(hook);
      const scope = hook.memoizedState?.current;
      if (valid(scope)) scopes.set(scope.node, scope);
    }
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }
  return [...scopes.values()];
}

// Codex 26.1103 omits even its globally shared onboarding keys when an API
// session has no authenticated ChatGPT principal. Project only a host-verified
// completion receipt into the hydrated renderer; never replay onboarding or
// copy account-scoped preferences, permissions or identity.
function codexApiModeLocalOnboardingBindings(records, options = {}) {
  const stores = records.filter(record => record.source.includes('Persisted atom store accessed before initialization')
    && record.source.includes('preservePendingPublishes') && record.source.includes('savedCustomSectionOperationIds'));
  const store = stores.length === 1 ? stores[0].exports : null;
  const supported = store && ['TB', 'JQ', 'jx', 'cz', 'Nj'].every(name => typeof store[name] === 'function')
    && /recordUpdate/.test(Function.prototype.toString.call(store.JQ))
    && /\.has\(/.test(Function.prototype.toString.call(store.TB));
  let lastApplied = '';
  return {
    hostReady: () => Boolean(supported && store.cz() === 'host'),
    publishProjectCheckpoint(marker, isCurrent) {
      if (!supported) return { ready: false, reason: 'unsupported-native-persistence' };
      if (store.cz() !== 'host') return { ready: false, reason: 'awaiting-host-hydration' };
      if (marker?.version !== 1 || typeof marker.scope !== 'string' || !marker.scope.length || marker.scope.length > 256
          || !Number.isSafeInteger(marker.revision) || marker.revision < 0 || typeof marker.nonce !== 'string'
          || !marker.nonce.length || marker.nonce.length > 256) return { ready: false, reason: 'invalid-project-checkpoint' };
      if (!isCurrent()) return { ready: false, reason: 'identity-changed' };
      // jx publishes this one non-shared atom through native main-process IPC.
      // The caller must read it back from applicationState before trusting it.
      store.jx('gaoge:api-local-projects-hydrated-v1', {
        version: 1, scope: marker.scope, revision: marker.revision, nonce: marker.nonce,
      });
      return { ready: isCurrent(), reason: 'project-checkpoint-published' };
    },
    synchronize(snapshot, isCurrent) {
      if (!snapshot) return { ready: true, reason: 'not-recorded' };
      if (snapshot.projectlessCompleted !== true || !Number.isSafeInteger(snapshot.completedAt)
          || snapshot.completedAt <= 0 || snapshot.completedAt > 253402300799) {
        return { ready: false, reason: 'invalid-completion-record' };
      }
      if (!supported) return { ready: false, reason: 'unsupported-native-persistence' };
      const browser = options.window || globalThis.window;
      if (browser?.electronBridge?.getInitialSidebarBootstrap?.()?.accountScopedPersistence !== true) {
        return { ready: true, reason: 'native-unscoped-persistence' };
      }
      if (store.cz() !== 'host') return { ready: false, reason: 'awaiting-host-hydration' };
      if (!isCurrent()) return { ready: false, reason: 'identity-changed' };
      const override = store.TB('electron:onboarding-override', 'auto');
      if (override != null && override !== 'auto') return { ready: true, reason: 'explicit-native-override' };
      const completionKey = 'electron:onboarding-projectless-completed';
      const timeKey = 'last_completed_onboarding';
      const currentTime = store.TB(timeKey, null);
      if (currentTime != null && (!Number.isSafeInteger(currentTime) || currentTime <= 0 || currentTime > 253402300799)) {
        return { ready: false, reason: 'invalid-native-completion-time' };
      }
      if (store.TB(completionKey, false) === true && currentTime >= snapshot.completedAt) {
        return { ready: true, reason: 'native-completion-verified' };
      }
      const receipt = JSON.stringify([store.Nj(), snapshot.completedAt]);
      // A native reset after projection wins until a new host hydration or a
      // newer genuine completion receipt. Do not fight interactive resets.
      if (lastApplied === receipt) return { ready: true, reason: 'native-reset-preserved' };
      if (!isCurrent()) return { ready: false, reason: 'identity-changed' };
      // JQ is the native per-key external-update path. Unlike jx, it does not
      // publish a write to the host; all other live atoms stay untouched.
      store.JQ(timeKey, Math.max(currentTime || 0, snapshot.completedAt));
      if (!isCurrent()) return { ready: false, reason: 'identity-changed' };
      store.JQ(completionKey, true);
      lastApplied = receipt;
      return { ready: store.TB(completionKey, false) === true && store.TB(timeKey, 0) >= snapshot.completedAt,
        reason: 'shared-completion-restored' };
    },
  };
}

function codexApiModeWebpackBindings(options) {
  const unsupported = message => { throw new Error('Unsupported Codex API mode contract: ' + message); };
  const waiting = message => { const error = new Error(message); error.code = 'API_MODE_NATIVE_PENDING'; throw error; };
  try {
    const require = options?.module?.__webpack_require__;
    if (typeof require !== 'function' || !require.m || !require.c) unsupported('Webpack registry');
    const entries = Object.entries(require.m);
    if (entries.length > 20000) unsupported('Webpack module count');
    const records = [];
    for (const [id, factory] of entries) {
      const cached = require.c[id];
      if (!cached || cached.error || typeof factory !== 'function') continue;
      const source = Function.prototype.toString.call(factory);
      if (source.length <= 2000000) records.push({ id, source, exports: cached.exports });
    }
    const one = (values, label) => { if (!values.length) waiting('Awaiting loaded native ' + label);
      if (values.length !== 1) unsupported('ambiguous ' + label); return values[0]; };
    const match = (source, pattern, label) => { const found = [...source.matchAll(pattern)];
      if (found.length !== 1) unsupported(label); return found[0]; };
    const escape = text => text.replace(/[.*+?^\$()|[\]{}\\]/g, '\\$&');
    const exported = (record, local) => {
      const pattern = new RegExp('(?:[,{])([\\w$]+):(?:\\(\\)=>)?' + escape(local) + '(?=[,}])', 'g');
      const matches = [...record.source.matchAll(pattern)].filter(item => Object.hasOwn(record.exports || {}, item[1]));
      const values = [...new Set(matches.map(item => record.exports[item[1]]))];
      if (values.length !== 1 || values[0] == null) unsupported('native exported descriptor ' + local);
      return values[0];
    };
    const imported = (record, alias) => {
      const found = match(record.source, new RegExp('(?:var |let |const |,)' + escape(alias) + '=([\\w$]+)\\(["\x27]([^"\x27]+)["\x27]\\)', 'g'), 'native import');
      const cached = require.c[found[2]];
      if (!cached || cached.error) waiting('Awaiting native imported module');
      return cached.exports;
    };
    const setterRecord = one(records.filter(record => record.source.includes('previousThreadDetailLevel:')
      && record.source.includes('selectedThreadDetailLevel:') && record.source.includes('{optimistic:!1}')), 'mode setter');
    const setters = [...new Set(Object.values(setterRecord.exports || {}).filter(value => typeof value === 'function'
      && Function.prototype.toString.call(value).includes('previousThreadDetailLevel:')
      && Function.prototype.toString.call(value).includes('selectedThreadDetailLevel:')))];
    const nativeSetter = one(setters, 'exported mode setter');
    const setterSource = Function.prototype.toString.call(nativeSetter);
    if (!setterSource.includes('{optimistic:!1}') || !setterSource.includes('logProductEvent')) unsupported('mode setter body');
    const captured = [], stop = {};
    let stopped = false;
    try { nativeSetter({get(value) { captured.push(value); }, set(value, state) {
      if (captured.length !== 2 || value !== captured[1] || state?.detailLevel !== 'STEPS_COMMANDS') unsupported('mode setter probe');
      stopped = true; throw stop;
    }}, 'STEPS_COMMANDS'); } catch (error) { if (error !== stop) throw error; }
    if (!stopped) unsupported('mode setter write boundary');
    const [modeDescriptor, optimisticDescriptor] = captured;
    const appScope = modeDescriptor?.scope;
    if (appScope?.__scopeBrand !== 'AppScope' || typeof appScope.id !== 'symbol'
      || optimisticDescriptor?.scope !== appScope || captured.some(value => typeof value?.resolve !== 'function')) unsupported('mode AppScope');
    const authRecord = one(records.filter(record => record.source.includes('accountLoading:!0,accountStructure:null,accountUserId:')
      && record.source.includes('authenticatedAccountId:') && record.source.includes('hasChatGptToken:')), 'authentication');
    const authMatch = match(authRecord.source, /([\w$]+)=\(0,[\w$]+\.[\w$]+\)\([\w$]+\.[\w$]+,\(\{scope:([\w$]+)\}\)=>\{let [\w$]+=\2\.get\([\w$]+\);return\{accountId:null,accountLoading:!0,accountStructure:null,accountUserId:/g, 'authentication descriptor');
    const authDescriptor = exported(authRecord, authMatch[1]);
    const inputRecord = one(records.filter(record => record.source.includes('accountInfoError:!1,accountInfoLoading:!0,authLoading:!0,authMethod:null,plan:null,supportedSurface:!0,workCloudSupportedSurface:!0')), 'access input');
    const inputMatch = match(inputRecord.source, /([\w$]+)=\(0,[\w$]+\.[\w$]+\)\([\w$]+\.[\w$]+,\(\)=>\(\{accountId:null,accountInfoError:!1,accountInfoLoading:!0,authLoading:!0,authMethod:null,plan:null,supportedSurface:!0,workCloudSupportedSurface:!0\}/g, 'access input descriptor');
    const authInputDescriptor = exported(inputRecord, inputMatch[1]);
    const policyRecord = one(records.filter(record => record.source.includes('workModeAccess!=null')
      && record.source.includes('"preference":"everyday"') && record.source.includes('"unsupported-auth"')), 'mode policy');
    const policyMatch = match(policyRecord.source, /([\w$]+)=\(0,[\w$]+\.[\w$]+\)\([\w$]+\.[\w$]+,\(\{get:([\w$]+)\}\)=>\{let [\w$]+=\2\(([\w$]+)\.([\w$]+)\);if\("denied"===[\w$]+\.status&&"unsupported-auth"===[\w$]+\.reason\)return"coding";let [\w$]+=\2\(\3\.([\w$]+)\);return"allowed"===[\w$]+\.status\|\|"loading"===[\w$]+\.status\|\|"error"===[\w$]+\.status\?"preference":"everyday"\}/g, 'mode policy descriptor');
    const policyDescriptor = exported(policyRecord, policyMatch[1]);
    const accessExports = imported(policyRecord, policyMatch[3]);
    const accessDescriptor = accessExports[policyMatch[4]], localAccessDescriptor = accessExports[policyMatch[5]];
    const serviceMatch = match(policyRecord.source, /([\w$]+)\.appServices\?\.workModeAccess!=null/g, 'native app services');
    const serviceExports = imported(policyRecord, serviceMatch[1]);
    const services = () => serviceExports?.appServices;
    if (typeof services()?.settings?.write !== 'function' || typeof services()?.settings?.read !== 'function'
      || typeof services()?.workModeAccess?.publish !== 'function') waiting('Awaiting native settings services');
    const statsigRecord = one(records.filter(record => record.source.includes('getFeatureGate')
      && record.source.includes('checkGate') && record.source.includes('"values_updated"')
      && /let [\w$]+=\(0,[\w$]+\.[\w$]+\)\([\w$]+\.[\w$]+,null\)/.test(record.source)), 'identity context');
    const statsigMatch = match(statsigRecord.source, /let ([\w$]+)=\(0,[\w$]+\.[\w$]+\)\([\w$]+\.[\w$]+,null\)/g, 'identity context descriptor');
    const statsigDescriptor = exported(statsigRecord, statsigMatch[1]);
    for (const descriptor of [authDescriptor,authInputDescriptor,policyDescriptor,accessDescriptor,localAccessDescriptor,statsigDescriptor]) {
      if (descriptor?.scope !== appScope || typeof descriptor.resolve !== 'function') unsupported('cross-scope native descriptor');
    }
    const validScope = scope => scope?.scope === appScope && scope.node === scope.chain?.get(appScope.id)
      && typeof scope.get === 'function' && typeof scope.set === 'function';
    const scopes = () => codexApiModeCommittedScopes(appScope, options.document || globalThis.document);
    const read = scope => {
      if (!validScope(scope)) unsupported('live AppScope handle');
      const auth = scope.get(authDescriptor), client = scope.get(statsigDescriptor);
      const user = typeof client?.getContext === 'function' ? client.getContext()?.user : null;
      const identity = user ? {userId:user.userID??null,accountId:user.customIDs?.account_id??null,
        authMethod:typeof user.custom?.auth_method==='string'?user.custom.auth_method:null,stableId:user.customIDs?.stableID??null}:null;
      return {authMethod:auth?.authMethod??null,authLoading:auth?.authLoading!==false,
        authAccountId:auth?.accountId??null,authenticatedAccountId:auth?.authenticatedAccountId??null,
        hasChatGptToken:auth?.hasChatGptToken===true,identity,detailLevel:scope.get(modeDescriptor),policy:scope.get(policyDescriptor),
        access:scope.get(accessDescriptor),localAccess:scope.get(localAccessDescriptor),authInput:scope.get(authInputDescriptor)};
    };
    const setCoding = async scope => {
      const before=read(scope), input=before.authInput;
      if(before.authLoading||before.authMethod!=='apikey'||before.authAccountId!=null||before.authenticatedAccountId!=null||before.hasChatGptToken
        ||before.identity?.authMethod!=='apikey'||before.identity?.accountId!=null) throw new Error('Native API authentication is not ready');
      if(!input||typeof input!=='object'||input.accountId!=null) throw new Error('Native API access input is not ready');
      if(input.authMethod!=='apikey'||input.authLoading!==false) scope.set(authInputDescriptor,{...input,authMethod:'apikey',authLoading:false});
      if(read(scope).policy==='everyday') throw new Error('Native access policy still requires everyday mode');
      await nativeSetter(scope,'STEPS_COMMANDS'); return read(scope);
    };
    // Match the committed native component by reviewed semantics, not its name,
    // text label or a lookalike element. No project/account feature gate is set.
    const isModeControlEvent = target => {
      const element=target?.nodeType===1?target:target?.parentElement;
      if(!element||element.isConnected===false)return false;
      const key=Object.keys(element).find(name=>/^__react(?:Fiber|InternalInstance)\$/.test(name));
      let root=key?element[key]:null;const seen=new Set();
      while(root?.return&&!seen.has(root)&&seen.size<300){seen.add(root);root=root.return;}
      const current=root?.stateNode?.current;if(!current)return false;
      const stack=[[current,null]],parents=new Map();
      while(stack.length&&parents.size<40000){const [fiber,parent]=stack.pop();if(!fiber||parents.has(fiber))continue;parents.set(fiber,parent);
        if(fiber.stateNode===element){for(let owner=fiber;owner;owner=parents.get(owner)){const props=owner.memoizedProps;
          if(!props||!['codex','work'].includes(props.mode)||typeof props.codexAvailable!=='boolean'||typeof props.onModeSelect!=='function'
            ||props.onNewChat!=null||props.disabled===true||typeof owner.type!=='function')continue;
          const body=Function.prototype.toString.call(owner.type);
          if(body.includes('sidebarElectron.productMode.trigger')&&body.includes('sidebarElectron.productMode.work.description.recommended')
            &&body.includes('sidebarElectron.productMode.codex.description.developer')&&body.includes('onCloseAutoFocus:')
            &&/codexAvailable:[\w$]+,disabled:[\w$]+,mode:[\w$]+,navigationHeading:[\w$]+,onModeSelect:[\w$]+,onNewChat:[\w$]+,workModeAccess:[\w$]+/.test(body))return true;
        }return false;}if(fiber.sibling&&fiber!==current)stack.push([fiber.sibling,parent]);if(fiber.child)stack.push([fiber.child,fiber]);}
      return false;
    };
    return {error:null,get appServices(){return services()},appScope,scopes,read,setCoding,isModeControlEvent,
      localOnboarding:codexApiModeLocalOnboardingBindings(records, options),
      modeDescriptor,optimisticDescriptor,authDescriptor,authInputDescriptor,statsigDescriptor,policyDescriptor,accessDescriptor,localAccessDescriptor};
  } catch(error) {return {error:String(error?.message||error),pending:error?.code==='API_MODE_NATIVE_PENDING'};}
}
